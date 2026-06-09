'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { db, save, genId } = require('./lib/db');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// 部署在反向代理 / 一键平台后面：信任代理，才能正确拿到 HTTPS 和真实 IP
app.set('trust proxy', 1);

app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

/* ----------------------------- 工具函数 ----------------------------- */

// 敏感词过滤：命中即整体替换为等长 ***
function filterSensitive(text) {
  const words = db().sensitiveWords || [];
  let out = String(text);
  let hit = false;
  for (const w of words) {
    if (!w) continue;
    if (out.includes(w)) {
      hit = true;
      out = out.split(w).join('*'.repeat([...w].length));
    }
  }
  return { text: out, hit };
}

// 限频：按 clientId + IP 记录最近提交时间与每分钟计数（内存）
const rateMap = new Map(); // key -> { last: ts, windowStart: ts, count: n }
function checkRate(key) {
  const { rateSeconds, ratePerMin } = db().config;
  const now = Date.now();
  let rec = rateMap.get(key);
  if (!rec) {
    rec = { last: 0, windowStart: now, count: 0 };
    rateMap.set(key, rec);
  }
  // 重置每分钟窗口
  if (now - rec.windowStart >= 60000) {
    rec.windowStart = now;
    rec.count = 0;
  }
  if (now - rec.last < rateSeconds * 1000) {
    return { ok: false, reason: `发言太快了，请 ${rateSeconds} 秒后再试` };
  }
  if (rec.count >= ratePerMin) {
    return { ok: false, reason: '本分钟发言已达上限，请稍后再试' };
  }
  rec.last = now;
  rec.count += 1;
  return { ok: true };
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
}

function sanitizeText(s, max) {
  return String(s == null ? '' : s).replace(/[<>]/g, '').trim().slice(0, max);
}

// 按短码 id 取直播间
function getRoom(id) {
  return db().rooms.find((r) => r.id === id);
}

// 生成唯一短码（直播间链接 /r/<code> 用）
function roomCode() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let c;
  do {
    c = '';
    for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  } while (db().rooms.some((r) => r.id === c));
  return c;
}

/* ----------------------------- 前台 API（均按 roomId 隔离） ----------------------------- */

// 房间配置（不下发密码等敏感字段）+ 服务器当前时间
app.get('/api/room', (req, res) => {
  const r = getRoom(String(req.query.id || ''));
  if (!r) return res.status(404).json({ error: '直播间不存在' });
  res.json({
    id: r.id,
    name: r.name,
    courseTitle: r.courseTitle,
    bannerTitle: r.bannerTitle || '',
    bannerSubtitle: r.bannerSubtitle || '',
    status: r.status,
    viewerBase: r.viewerBase,
    videoType: r.videoType || 'voomly',
    videoEmbed: r.videoEmbed,
    hlsUrl: r.hlsUrl || '',
    orientation: r.orientation || 'landscape',
    cover: r.cover,
    liveStartAt: r.liveStartAt,
    requireAccessCode: !!r.requireAccessCode,
    serverNow: Date.now()
  });
});

// 启用的预设互动
app.get('/api/presets', (req, res) => {
  const roomId = String(req.query.room || '');
  const list = db().presets
    .filter((p) => p.roomId === roomId && p.enabled)
    .map((p) => ({
      id: p.id, time: p.time, nickname: p.nickname, avatar: p.avatar,
      region: p.region, content: p.content, type: p.type
    }))
    .sort((a, b) => a.time - b.time);
  res.json(list);
});

// 可见用户评论（增量：since 为毫秒时间戳）
app.get('/api/comments', (req, res) => {
  const roomId = String(req.query.room || '');
  const since = Number(req.query.since) || 0;
  const list = db().comments
    .filter((c) => c.roomId === roomId && c.status === 'visible' && c.createdAt > since)
    .map((c) => ({
      id: c.id, nickname: c.nickname, region: c.region,
      content: c.content, createdAt: c.createdAt, mine: false
    }))
    .sort((a, b) => a.createdAt - b.createdAt);
  res.json({ comments: list, serverNow: Date.now() });
});

// 提交评论
app.post('/api/comments', (req, res) => {
  const roomId = sanitizeText(req.body.roomId, 20);
  if (!getRoom(roomId)) return res.status(404).json({ error: '直播间不存在' });
  const nickname = sanitizeText(req.body.nickname, 20);
  const region = sanitizeText(req.body.region, 20);
  let content = sanitizeText(req.body.content, 200);
  const clientId = sanitizeText(req.body.clientId, 40) || 'anon';

  if (!nickname) return res.status(400).json({ error: '请先填写昵称' });
  if (!content) return res.status(400).json({ error: '评论内容不能为空' });

  const ip = clientIp(req);
  const rate = checkRate(`${roomId}|${clientId}|${ip}`);
  if (!rate.ok) return res.status(429).json({ error: rate.reason });

  const filtered = filterSensitive(content);
  content = filtered.text;

  const comment = {
    id: genId('c'),
    roomId, nickname, region, content,
    status: 'visible',
    createdAt: Date.now(),
    ip, clientId,
    sensitiveHit: filtered.hit
  };
  db().comments.push(comment);
  save();

  res.json({
    id: comment.id, nickname, region, content,
    createdAt: comment.createdAt, mine: true
  });
});

/* ----------------------------- 观看码（前台准入） ----------------------------- */

// 校验观看码：在该直播间内匹配 + 有效期；通过则返回绑定的昵称/地区（替代登录）
app.post('/api/access', (req, res) => {
  const roomId = sanitizeText(req.body.roomId, 20);
  const code = sanitizeText(req.body.code, 40);
  if (!code) return res.status(400).json({ error: '请输入观看码' });
  const c = db().accessCodes.find((x) => x.roomId === roomId && x.code.toLowerCase() === code.toLowerCase());
  if (!c || !c.enabled) return res.status(403).json({ error: '观看码无效' });
  if (c.expireAt && Date.now() > c.expireAt) return res.status(403).json({ error: '观看码已过期' });
  c.lastUsedAt = Date.now();
  c.useCount = (c.useCount || 0) + 1;
  save();
  res.json({ ok: true, code: c.code, nickname: c.nickname, region: c.region });
});

/* ----------------------------- 后台鉴权 ----------------------------- */

function requireAdmin(req, res, next) {
  const token = req.cookies && req.cookies.admin;
  if (token && token === db().config.adminSecret) return next();
  return res.status(401).json({ error: '未登录或登录已过期' });
}

app.post('/api/admin/login', (req, res) => {
  const password = String(req.body.password || '');
  // 优先用环境变量 ADMIN_PASSWORD（部署平台里设置），没有则用库里的默认密码
  const expected = process.env.ADMIN_PASSWORD || db().config.adminPassword;
  if (password !== expected) {
    return res.status(401).json({ error: '密码错误' });
  }
  res.cookie('admin', db().config.adminSecret, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD, // 生产(HTTPS)下只通过 https 传 cookie
    maxAge: 7 * 24 * 3600 * 1000
  });
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('admin');
  res.json({ ok: true });
});

// 探测登录态
app.get('/api/admin/me', (req, res) => {
  const token = req.cookies && req.cookies.admin;
  res.json({ loggedIn: !!(token && token === db().config.adminSecret) });
});

/* ----------------------------- 后台：直播间 CRUD ----------------------------- */

function defaultRoom() {
  return {
    name: '新直播间', courseTitle: '', bannerTitle: '', bannerSubtitle: '',
    status: 'pre', viewerBase: 100,
    videoType: 'voomly', videoEmbed: '', hlsUrl: '', // voomly=老版嵌入；hls=新版 Cloudflare 自建播放器
    orientation: 'portrait',
    cover: '', liveStartAt: null, requireAccessCode: false
  };
}

function applyRoomFields(r, b) {
  if (b.name !== undefined) r.name = sanitizeText(b.name, 50);
  if (b.courseTitle !== undefined) r.courseTitle = sanitizeText(b.courseTitle, 100);
  if (b.bannerTitle !== undefined) r.bannerTitle = sanitizeText(b.bannerTitle, 30);
  if (b.bannerSubtitle !== undefined) r.bannerSubtitle = String(b.bannerSubtitle).replace(/[<>]/g, '').slice(0, 120);
  if (b.status !== undefined && ['pre', 'live', 'ended'].includes(b.status)) r.status = b.status;
  if (b.viewerBase !== undefined) r.viewerBase = Math.max(0, parseInt(b.viewerBase, 10) || 0);
  if (b.videoType !== undefined && ['voomly', 'hls'].includes(b.videoType)) r.videoType = b.videoType;
  if (b.videoEmbed !== undefined) r.videoEmbed = String(b.videoEmbed).slice(0, 20000);
  if (b.hlsUrl !== undefined) r.hlsUrl = sanitizeText(b.hlsUrl, 1000);
  if (b.orientation !== undefined && ['portrait', 'landscape'].includes(b.orientation)) r.orientation = b.orientation;
  if (b.cover !== undefined) r.cover = sanitizeText(b.cover, 500);
  if (b.liveStartAt !== undefined) r.liveStartAt = b.liveStartAt ? Number(b.liveStartAt) : null;
  if (b.requireAccessCode !== undefined) r.requireAccessCode = !!b.requireAccessCode;
}

// 直播间列表（带统计）
app.get('/api/admin/rooms', requireAdmin, (req, res) => {
  const d = db();
  const list = [...d.rooms].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).map((r) => ({
    ...r,
    presetCount: d.presets.filter((p) => p.roomId === r.id).length,
    codeCount: d.accessCodes.filter((c) => c.roomId === r.id).length,
    commentCount: d.comments.filter((c) => c.roomId === r.id).length
  }));
  res.json(list);
});

// 创建直播间（默认空房间，返回短码）
app.post('/api/admin/rooms', requireAdmin, (req, res) => {
  const room = { id: roomCode(), ...defaultRoom(), createdAt: Date.now() };
  if (req.body && req.body.name) room.name = sanitizeText(req.body.name, 50);
  if (req.body && ['voomly', 'hls'].includes(req.body.videoType)) room.videoType = req.body.videoType;
  db().rooms.push(room);
  save();
  res.json(room);
});

// 取某直播间配置
app.get('/api/admin/rooms/:id', requireAdmin, (req, res) => {
  const r = getRoom(req.params.id);
  if (!r) return res.status(404).json({ error: '直播间不存在' });
  res.json(r);
});

// 更新某直播间配置
app.put('/api/admin/rooms/:id', requireAdmin, (req, res) => {
  const r = getRoom(req.params.id);
  if (!r) return res.status(404).json({ error: '直播间不存在' });
  applyRoomFields(r, req.body || {});
  save();
  res.json(r);
});

// 删除直播间（连带删该房间的预设/评论/观看码）
app.delete('/api/admin/rooms/:id', requireAdmin, (req, res) => {
  const d = db();
  const i = d.rooms.findIndex((r) => r.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: '直播间不存在' });
  const id = req.params.id;
  d.rooms.splice(i, 1);
  d.presets = d.presets.filter((p) => p.roomId !== id);
  d.comments = d.comments.filter((c) => c.roomId !== id);
  d.accessCodes = d.accessCodes.filter((c) => c.roomId !== id);
  save();
  res.json({ ok: true });
});

// 立即开播
app.post('/api/admin/rooms/:id/go-live', requireAdmin, (req, res) => {
  const r = getRoom(req.params.id);
  if (!r) return res.status(404).json({ error: '直播间不存在' });
  r.liveStartAt = Date.now();
  r.status = 'live';
  save();
  res.json(r);
});

/* ----------------------------- 后台：预设互动 ----------------------------- */

const PRESET_TYPES = ['comment', 'join', 'like'];

function normalizePreset(b) {
  return {
    time: Math.max(0, parseInt(b.time, 10) || 0),
    nickname: sanitizeText(b.nickname, 20),
    avatar: sanitizeText(b.avatar, 500),
    region: sanitizeText(b.region, 20),
    content: sanitizeText(b.content, 200),
    type: PRESET_TYPES.includes(b.type) ? b.type : 'comment',
    enabled: b.enabled === undefined ? true : !!b.enabled
  };
}

app.get('/api/admin/presets', requireAdmin, (req, res) => {
  const roomId = String(req.query.room || '');
  res.json(db().presets.filter((p) => p.roomId === roomId).sort((a, b) => a.time - b.time));
});

app.post('/api/admin/presets', requireAdmin, (req, res) => {
  const roomId = sanitizeText(req.body.roomId, 20);
  if (!getRoom(roomId)) return res.status(404).json({ error: '直播间不存在' });
  const p = { id: genId('p'), roomId, ...normalizePreset(req.body || {}) };
  db().presets.push(p);
  save();
  res.json(p);
});

app.put('/api/admin/presets/:id', requireAdmin, (req, res) => {
  const p = db().presets.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: '预设不存在' });
  Object.assign(p, normalizePreset({ ...p, ...req.body }));
  save();
  res.json(p);
});

app.delete('/api/admin/presets/:id', requireAdmin, (req, res) => {
  const d = db();
  const i = d.presets.findIndex((x) => x.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: '预设不存在' });
  d.presets.splice(i, 1);
  save();
  res.json({ ok: true });
});

// 导出预设（JSON，按房间）
app.get('/api/admin/presets/export', requireAdmin, (req, res) => {
  const roomId = String(req.query.room || '');
  const list = db().presets.filter((p) => p.roomId === roomId)
    .map(({ time, nickname, avatar, region, content, type, enabled }) =>
      ({ time, nickname, avatar, region, content, type, enabled }));
  res.setHeader('Content-Disposition', 'attachment; filename="presets.json"');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(list, null, 2));
});

// 批量导入预设（JSON 数组）到指定房间。mode=replace 覆盖该房间，默认 append 追加
app.post('/api/admin/presets/import', requireAdmin, (req, res) => {
  const roomId = sanitizeText(req.body.roomId, 20);
  if (!getRoom(roomId)) return res.status(404).json({ error: '直播间不存在' });
  const items = Array.isArray(req.body.items) ? req.body.items : null;
  if (!items) return res.status(400).json({ error: '导入格式应为 { items: [...] }' });
  const d = db();
  if (req.body.mode === 'replace') d.presets = d.presets.filter((p) => p.roomId !== roomId);
  let added = 0;
  for (const it of items) {
    if (!it || (!it.content && it.type === 'comment')) continue;
    d.presets.push({ id: genId('p'), roomId, ...normalizePreset(it) });
    added += 1;
  }
  save();
  res.json({ ok: true, added, total: d.presets.filter((p) => p.roomId === roomId).length });
});

/* ----------------------------- 后台：用户评论 ----------------------------- */

app.get('/api/admin/comments', requireAdmin, (req, res) => {
  const roomId = String(req.query.room || '');
  res.json(db().comments.filter((c) => c.roomId === roomId).sort((a, b) => b.createdAt - a.createdAt));
});

app.put('/api/admin/comments/:id', requireAdmin, (req, res) => {
  const c = db().comments.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '评论不存在' });
  if (['visible', 'hidden'].includes(req.body.status)) c.status = req.body.status;
  save();
  res.json(c);
});

app.delete('/api/admin/comments/:id', requireAdmin, (req, res) => {
  const d = db();
  const i = d.comments.findIndex((x) => x.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: '评论不存在' });
  d.comments.splice(i, 1);
  save();
  res.json({ ok: true });
});

// 一键把用户评论加入预设互动库
app.post('/api/admin/comments/:id/to-preset', requireAdmin, (req, res) => {
  const c = db().comments.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '评论不存在' });
  // 默认出现时间取请求里的 time，没有就放到该房间现有最大时间 +5s
  const maxTime = db().presets.filter((p) => p.roomId === c.roomId).reduce((m, p) => Math.max(m, p.time), 0);
  const preset = {
    id: genId('p'),
    roomId: c.roomId,
    ...normalizePreset({
      time: req.body.time !== undefined ? req.body.time : maxTime + 5,
      nickname: c.nickname,
      avatar: '',
      region: c.region,
      content: c.content,
      type: 'comment',
      enabled: true
    })
  };
  db().presets.push(preset);
  save();
  res.json(preset);
});

/* ----------------------------- 后台：观看码 ----------------------------- */

function genCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉易混淆字符
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function uniqueCode(want) {
  const codes = db().accessCodes;
  let c = want || genCode();
  while (codes.some((x) => x.code.toLowerCase() === c.toLowerCase())) c = genCode();
  return c;
}

function normalizeCode(b, existing) {
  return {
    code: sanitizeText(b.code, 40) || (existing ? existing.code : uniqueCode()),
    nickname: sanitizeText(b.nickname, 20),
    region: sanitizeText(b.region, 20),
    expireAt: b.expireAt ? Number(b.expireAt) : null,
    enabled: b.enabled === undefined ? true : !!b.enabled,
    note: sanitizeText(b.note, 60)
  };
}

function codeStatus(c) {
  if (!c.enabled) return 'disabled';
  if (c.expireAt && Date.now() > c.expireAt) return 'expired';
  return 'active';
}

app.get('/api/admin/codes', requireAdmin, (req, res) => {
  const roomId = String(req.query.room || '');
  const list = db().accessCodes.filter((c) => c.roomId === roomId)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map((c) => ({ ...c, _status: codeStatus(c) }));
  res.json(list);
});

app.post('/api/admin/codes', requireAdmin, (req, res) => {
  const roomId = sanitizeText(req.body.roomId, 20);
  if (!getRoom(roomId)) return res.status(404).json({ error: '直播间不存在' });
  const norm = normalizeCode(req.body || {});
  norm.code = uniqueCode(norm.code); // 确保唯一
  const c = { id: genId('ac'), roomId, ...norm, useCount: 0, lastUsedAt: null, createdAt: Date.now() };
  db().accessCodes.push(c);
  save();
  res.json(c);
});

app.put('/api/admin/codes/:id', requireAdmin, (req, res) => {
  const c = db().accessCodes.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '观看码不存在' });
  Object.assign(c, normalizeCode({ ...c, ...req.body }, c));
  save();
  res.json(c);
});

app.delete('/api/admin/codes/:id', requireAdmin, (req, res) => {
  const d = db();
  const i = d.accessCodes.findIndex((x) => x.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: '观看码不存在' });
  d.accessCodes.splice(i, 1);
  save();
  res.json({ ok: true });
});

// 导出 / 批量导入（JSON，按房间）
app.get('/api/admin/codes/export', requireAdmin, (req, res) => {
  const roomId = String(req.query.room || '');
  const list = db().accessCodes.filter((c) => c.roomId === roomId)
    .map(({ code, nickname, region, expireAt, enabled, note }) =>
      ({ code, nickname, region, expireAt, enabled, note }));
  res.setHeader('Content-Disposition', 'attachment; filename="access-codes.json"');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(list, null, 2));
});

app.post('/api/admin/codes/import', requireAdmin, (req, res) => {
  const roomId = sanitizeText(req.body.roomId, 20);
  if (!getRoom(roomId)) return res.status(404).json({ error: '直播间不存在' });
  const items = Array.isArray(req.body.items) ? req.body.items : null;
  if (!items) return res.status(400).json({ error: '导入格式应为 { items: [...] }' });
  const d = db();
  if (req.body.mode === 'replace') d.accessCodes = d.accessCodes.filter((c) => c.roomId !== roomId);
  let added = 0;
  for (const it of items) {
    if (!it) continue;
    const norm = normalizeCode(it);
    norm.code = uniqueCode(norm.code);
    d.accessCodes.push({ id: genId('ac'), roomId, ...norm, useCount: 0, lastUsedAt: null, createdAt: Date.now() });
    added += 1;
  }
  save();
  res.json({ ok: true, added, total: d.accessCodes.filter((c) => c.roomId === roomId).length });
});

/* ----------------------------- 直播间页面路由 ----------------------------- */

// /r/<短码> → 返回前台直播间页面（具体房间由前端按短码加载）
app.get('/r/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ----------------------------- 启动 ----------------------------- */

db(); // 触发首次 seed
app.listen(PORT, () => {
  console.log(`私域直播间 MVP 运行中: http://localhost:${PORT}`);
  console.log(`后台管理: http://localhost:${PORT}/admin.html  (默认密码 admin123)`);
});
