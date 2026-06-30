'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { db, save, genId } = require('./lib/db');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// Stripe：配了密钥才初始化；没配时支付相关接口返回 503，其余功能照常
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

// 部署在反向代理 / 一键平台后面：信任代理，才能正确拿到 HTTPS 和真实 IP
app.set('trust proxy', 1);

// ⚠️ Stripe webhook 必须拿「原始 body」做签名校验，所以这条路由要在全局 express.json() 之前、
// 用 express.raw 单独注册，否则 body 会被 JSON 解析掉、验签失败。
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(503).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object;
    const orderId = session.metadata && session.metadata.orderId;
    const order = orderId ? (db().orders || []).find((o) => o.id === orderId) : null;
    if (order && order.status !== 'paid') {
      order.status = 'paid';
      order.stripePaymentIntent = session.payment_intent || '';
      order.buyer.email = (session.customer_details && session.customer_details.email) || order.buyer.email || '';
      order.paidAt = Date.now();
      save();
    }
  }
  res.json({ received: true });
});

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

// 手动推送弹窗：内存存「每个房间当前正在推的商品」。不落盘——直播中临时上链接，重启清空即可。
const livePromos = new Map(); // roomId -> { productId, at }

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

/* ----------------------------- 观看会话（在线/进退场追踪） ----------------------------- */
// 心跳式：前台每 ~15s 上报一次心跳，关闭页面用 sendBeacon 补发「离开」。
// 退出时间 = 显式离开信号；若没有，则心跳停止超过 ONLINE_GRACE_MS 后取「最后在线时间」。
const ONLINE_GRACE_MS = 45000; // 超过这么久没收到心跳 → 视为已离开

// 心跳量大，不每次写盘：只更新内存并打脏标记，定时批量落盘（新会话/离开仍立即落盘）
let sessionsDirty = false;
setInterval(() => { if (sessionsDirty) { sessionsDirty = false; save(); } }, 20000);

function findSession(id) {
  return (db().viewerSessions || (db().viewerSessions = [])).find((s) => s.id === id);
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
    shopEnabled: !!r.shopEnabled,
    shopName: r.shopName || r.name || '',
    replayWhatsappUrl: r.replayWhatsappUrl || '',
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

/* ----------------------------- 前台：商城（商品 / 优惠券 / 定时弹窗 / 结账） ----------------------------- */

// 商城数据：只下发该房间「启用」的商品和（未过期的）优惠券 + 公开的 publishable key
app.get('/api/shop', (req, res) => {
  const r = getRoom(String(req.query.room || ''));
  if (!r) return res.status(404).json({ error: '直播间不存在' });
  const roomId = r.id;
  const now = Date.now();
  const products = (db().products || [])
    .filter((p) => p.roomId === roomId && p.enabled)
    .sort((a, b) => (a.sort || 0) - (b.sort || 0))
    .map((p) => ({ id: p.id, title: p.title, image: p.image, currency: p.currency || 'usd', price: p.price, originalPrice: p.originalPrice, desc: p.desc, payUrl: p.payUrl || '' }));
  const coupons = (db().coupons || [])
    .filter((c) => c.roomId === roomId && c.enabled && (!c.expireAt || c.expireAt > now))
    .sort((a, b) => (a.sort || 0) - (b.sort || 0))
    .map((c) => ({ id: c.id, title: c.title, threshold: c.threshold, amount: c.amount, expireAt: c.expireAt || null }));
  res.json({
    enabled: !!r.shopEnabled,
    shopName: r.shopName || r.name || '',
    stripeReady: !!stripe && !!STRIPE_PUBLISHABLE_KEY,
    stripePublishableKey: STRIPE_PUBLISHABLE_KEY,
    products, coupons
  });
});

// 定时促销弹窗（启用项，结构对齐 /api/presets）
app.get('/api/promos', (req, res) => {
  const roomId = String(req.query.room || '');
  const list = (db().promos || [])
    .filter((p) => p.roomId === roomId && p.enabled)
    .map((p) => ({ id: p.id, time: p.time, productId: p.productId, durationSec: p.durationSec }))
    .sort((a, b) => a.time - b.time);
  res.json(list);
});

// 结账：服务端算最终价（原价 − 校验通过的券额），建订单并创建 Stripe Embedded Checkout Session。
app.post('/api/checkout', async (req, res) => {
  const roomId = sanitizeText(req.body.roomId, 20);
  const room = getRoom(roomId);
  if (!room) return res.status(404).json({ error: '直播间不存在' });
  if (!room.shopEnabled) return res.status(403).json({ error: '本直播间未开启商城' });
  if (!stripe || !STRIPE_PUBLISHABLE_KEY) return res.status(503).json({ error: '支付未配置，请联系管理员' });

  const product = (db().products || []).find((p) => p.id === req.body.productId && p.roomId === roomId && p.enabled);
  if (!product) return res.status(404).json({ error: '商品不存在或已下架' });

  // 优惠券：可选；只有满足门槛才抵扣，否则忽略（绝不信任前端金额）
  let discount = 0;
  let coupon = null;
  if (req.body.couponId) {
    const now = Date.now();
    const c = (db().coupons || []).find((x) => x.id === req.body.couponId && x.roomId === roomId && x.enabled && (!x.expireAt || x.expireAt > now));
    if (c && Number(product.price) >= Number(c.threshold)) { coupon = c; discount = Number(c.amount) || 0; }
  }
  const currency = CURRENCIES.includes(String(product.currency).toLowerCase()) ? String(product.currency).toLowerCase() : 'usd';
  const final = Math.max(0, Number(product.price) - discount);
  const unitAmount = Math.round(final * 100); // 转最小货币单位
  if (unitAmount < 1) return res.status(400).json({ error: '订单金额无效' });

  const order = {
    id: genId('o'),
    roomId, productId: product.id, productTitle: product.title,
    currency, amount: final, discount, couponId: coupon ? coupon.id : null,
    status: 'pending', stripeSessionId: '', stripePaymentIntent: '',
    buyer: {
      nickname: sanitizeText(req.body.nickname, 20),
      region: sanitizeText(req.body.region, 20),
      clientId: sanitizeText(req.body.clientId, 40),
      email: ''
    },
    createdAt: Date.now(), paidAt: null
  };

  const origin = `${req.protocol}://${req.get('host')}`;
  try {
    const session = await stripe.checkout.sessions.create({
      ui_mode: 'embedded',
      mode: 'payment',
      line_items: [{
        price_data: {
          currency,
          product_data: { name: product.title, images: product.image ? [product.image] : [] },
          unit_amount: unitAmount
        },
        quantity: 1
      }],
      return_url: `${origin}/r/${roomId}?paid=1&order=${order.id}&session_id={CHECKOUT_SESSION_ID}`,
      metadata: { orderId: order.id, roomId }
    });
    order.stripeSessionId = session.id;
    (db().orders || (db().orders = [])).push(order);
    save();
    res.json({ clientSecret: session.client_secret, orderId: order.id });
  } catch (e) {
    res.status(502).json({ error: '创建支付会话失败：' + (e.message || '未知错误') });
  }
});

// 订单状态（前端付款返回后轮询确认）
app.get('/api/order-status', (req, res) => {
  const o = (db().orders || []).find((x) => x.id === String(req.query.id || ''));
  if (!o) return res.status(404).json({ error: '订单不存在' });
  res.json({ status: o.status, amount: o.amount, currency: o.currency, productTitle: o.productTitle });
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
  // 搭车下发「当前手动推送的弹窗」：前端比对变化决定弹/收
  const lp = livePromos.get(roomId);
  // 搭车下发当前房间状态：前端在直播中轮询发现转 ended，当场盖结束页（无需观众刷新）
  const r = getRoom(roomId);
  res.json({
    comments: list,
    serverNow: Date.now(),
    livePromo: lp ? { productId: lp.productId, at: lp.at } : null,
    roomStatus: r ? r.status : null
  });
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

/* ----------------------------- 在线心跳 / 离开（前台上报，后台「观看记录」用） ----------------------------- */

// 心跳：首次上报 = 进入直播间（记进入时间）；之后每次刷新「最后在线时间」。
app.post('/api/heartbeat', (req, res) => {
  const roomId = sanitizeText(req.body.roomId, 20);
  const sessionId = sanitizeText(req.body.sessionId, 40);
  if (!sessionId || !getRoom(roomId)) return res.status(204).end();
  const now = Date.now();
  let s = findSession(sessionId);
  if (!s || s.roomId !== roomId) {
    s = {
      id: sessionId, roomId,
      clientId: sanitizeText(req.body.clientId, 40),
      nickname: sanitizeText(req.body.nickname, 20),
      region: sanitizeText(req.body.region, 20),
      enteredAt: now, lastSeenAt: now, leftAt: null,
      ip: clientIp(req)
    };
    db().viewerSessions.push(s);
    save(); // 新会话立即落盘，避免重启丢「进入时间」
  } else {
    s.lastSeenAt = now;
    s.leftAt = null; // 又收到心跳 = 还在 → 撤销之前的离开标记
    if (req.body.nickname) s.nickname = sanitizeText(req.body.nickname, 20);
    if (req.body.region) s.region = sanitizeText(req.body.region, 20);
    sessionsDirty = true;
  }
  res.json({ ok: true });
});

// 离开：sendBeacon 在关闭/切走页面时补发，拿到精确退出时间
app.post('/api/leave', (req, res) => {
  const sessionId = sanitizeText(req.body && req.body.sessionId, 40);
  const s = sessionId ? findSession(sessionId) : null;
  if (s) { s.leftAt = Date.now(); s.lastSeenAt = s.leftAt; save(); }
  res.status(204).end();
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
    cover: '', liveStartAt: null, requireAccessCode: false,
    shopEnabled: false, shopName: '', replayWhatsappUrl: ''
  };
}

// 允许的收款货币（Stripe，小写）。都按「×100 转最小单位」处理，故只放 2 位小数货币。
const CURRENCIES = ['usd', 'sgd', 'myr', 'hkd', 'aud', 'eur', 'gbp', 'cny', 'twd'];

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
  if (b.shopEnabled !== undefined) r.shopEnabled = !!b.shopEnabled;
  if (b.shopName !== undefined) r.shopName = sanitizeText(b.shopName, 50);
  if (b.replayWhatsappUrl !== undefined) r.replayWhatsappUrl = safeUrl(b.replayWhatsappUrl);
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
  d.viewerSessions = (d.viewerSessions || []).filter((s) => s.roomId !== id);
  d.products = (d.products || []).filter((p) => p.roomId !== id);
  d.coupons = (d.coupons || []).filter((c) => c.roomId !== id);
  d.promos = (d.promos || []).filter((p) => p.roomId !== id);
  d.orders = (d.orders || []).filter((o) => o.roomId !== id);
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

// 批量删除：按 id 数组删除（双重校验 roomId，防误删其它房间）
app.post('/api/admin/presets/batch-delete', requireAdmin, (req, res) => {
  const roomId = sanitizeText(req.body.roomId, 20);
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ error: '未选择要删除的预设' });
  const idSet = new Set(ids.map(String));
  const d = db();
  const before = d.presets.length;
  d.presets = d.presets.filter((p) => !(p.roomId === roomId && idSet.has(p.id)));
  save();
  res.json({ ok: true, removed: before - d.presets.length });
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

/* ----------------------------- 后台：观看记录（在线 / 进退场） ----------------------------- */

app.get('/api/admin/sessions', requireAdmin, (req, res) => {
  const roomId = String(req.query.room || '');
  const now = Date.now();
  const list = (db().viewerSessions || [])
    .filter((s) => s.roomId === roomId)
    .sort((a, b) => b.enteredAt - a.enteredAt)
    .map((s) => {
      const online = !s.leftAt && (now - s.lastSeenAt) < ONLINE_GRACE_MS;
      const exitAt = online ? null : (s.leftAt || s.lastSeenAt);
      return {
        id: s.id, clientId: s.clientId, nickname: s.nickname, region: s.region,
        enteredAt: s.enteredAt, exitAt, online,
        durationSec: Math.max(0, Math.floor(((exitAt || now) - s.enteredAt) / 1000))
      };
    });
  res.json({ sessions: list, onlineCount: list.filter((s) => s.online).length, serverNow: now });
});

// 清空本房间观看记录
app.post('/api/admin/sessions/clear', requireAdmin, (req, res) => {
  const roomId = sanitizeText(req.body.roomId, 20);
  const d = db();
  const before = (d.viewerSessions || []).length;
  d.viewerSessions = (d.viewerSessions || []).filter((s) => s.roomId !== roomId);
  save();
  res.json({ ok: true, removed: before - d.viewerSessions.length });
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

/* ----------------------------- 后台：商品 ----------------------------- */

// 只接受 http/https 链接，挡掉 javascript: 等危险协议（防前台点击时 XSS）
function safeUrl(s, max = 1000) {
  const u = sanitizeText(s, max);
  if (!/^https?:\/\//i.test(u)) return '';
  try { return new URL(u).href; } catch (e) { return ''; }
}

function normalizeProduct(b) {
  return {
    title: sanitizeText(b.title, 100),
    image: safeUrl(b.image, 500),
    currency: CURRENCIES.includes(String(b.currency).toLowerCase()) ? String(b.currency).toLowerCase() : 'usd',
    price: Math.max(0, Number(b.price) || 0),
    originalPrice: Math.max(0, Number(b.originalPrice) || 0),
    desc: sanitizeText(b.desc, 500),
    payUrl: safeUrl(b.payUrl),
    enabled: b.enabled === undefined ? true : !!b.enabled,
    sort: parseInt(b.sort, 10) || 0
  };
}

app.get('/api/admin/products', requireAdmin, (req, res) => {
  const roomId = String(req.query.room || '');
  res.json((db().products || []).filter((p) => p.roomId === roomId).sort((a, b) => (a.sort || 0) - (b.sort || 0)));
});

app.post('/api/admin/products', requireAdmin, (req, res) => {
  const roomId = sanitizeText(req.body.roomId, 20);
  if (!getRoom(roomId)) return res.status(404).json({ error: '直播间不存在' });
  const p = { id: genId('prod'), roomId, ...normalizeProduct(req.body || {}), createdAt: Date.now() };
  (db().products || (db().products = [])).push(p);
  save();
  res.json(p);
});

app.put('/api/admin/products/:id', requireAdmin, (req, res) => {
  const p = (db().products || []).find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: '商品不存在' });
  Object.assign(p, normalizeProduct({ ...p, ...req.body }));
  save();
  res.json(p);
});

app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
  const d = db();
  const i = (d.products || []).findIndex((x) => x.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: '商品不存在' });
  d.products.splice(i, 1);
  save();
  res.json({ ok: true });
});

/* ----------------------------- 后台：优惠券（满减） ----------------------------- */

function normalizeCoupon(b) {
  return {
    title: sanitizeText(b.title, 50),
    threshold: Math.max(0, Number(b.threshold) || 0),
    amount: Math.max(0, Number(b.amount) || 0),
    enabled: b.enabled === undefined ? true : !!b.enabled,
    sort: parseInt(b.sort, 10) || 0,
    expireAt: b.expireAt ? Number(b.expireAt) : null
  };
}

app.get('/api/admin/coupons', requireAdmin, (req, res) => {
  const roomId = String(req.query.room || '');
  res.json((db().coupons || []).filter((c) => c.roomId === roomId).sort((a, b) => (a.sort || 0) - (b.sort || 0)));
});

app.post('/api/admin/coupons', requireAdmin, (req, res) => {
  const roomId = sanitizeText(req.body.roomId, 20);
  if (!getRoom(roomId)) return res.status(404).json({ error: '直播间不存在' });
  const c = { id: genId('coup'), roomId, ...normalizeCoupon(req.body || {}), createdAt: Date.now() };
  (db().coupons || (db().coupons = [])).push(c);
  save();
  res.json(c);
});

app.put('/api/admin/coupons/:id', requireAdmin, (req, res) => {
  const c = (db().coupons || []).find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '优惠券不存在' });
  Object.assign(c, normalizeCoupon({ ...c, ...req.body }));
  save();
  res.json(c);
});

app.delete('/api/admin/coupons/:id', requireAdmin, (req, res) => {
  const d = db();
  const i = (d.coupons || []).findIndex((x) => x.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: '优惠券不存在' });
  d.coupons.splice(i, 1);
  save();
  res.json({ ok: true });
});

/* ----------------------------- 后台：定时促销弹窗 ----------------------------- */

function normalizePromo(b) {
  return {
    time: Math.max(0, parseInt(b.time, 10) || 0),
    productId: sanitizeText(b.productId, 40),
    durationSec: Math.max(0, parseInt(b.durationSec, 10) || 0),
    enabled: b.enabled === undefined ? true : !!b.enabled
  };
}

app.get('/api/admin/promos', requireAdmin, (req, res) => {
  const roomId = String(req.query.room || '');
  res.json((db().promos || []).filter((p) => p.roomId === roomId).sort((a, b) => a.time - b.time));
});

app.post('/api/admin/promos', requireAdmin, (req, res) => {
  const roomId = sanitizeText(req.body.roomId, 20);
  if (!getRoom(roomId)) return res.status(404).json({ error: '直播间不存在' });
  const p = { id: genId('promo'), roomId, ...normalizePromo(req.body || {}) };
  (db().promos || (db().promos = [])).push(p);
  save();
  res.json(p);
});

app.put('/api/admin/promos/:id', requireAdmin, (req, res) => {
  const p = (db().promos || []).find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: '促销弹窗不存在' });
  Object.assign(p, normalizePromo({ ...p, ...req.body }));
  save();
  res.json(p);
});

app.delete('/api/admin/promos/:id', requireAdmin, (req, res) => {
  const d = db();
  const i = (d.promos || []).findIndex((x) => x.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: '促销弹窗不存在' });
  d.promos.splice(i, 1);
  save();
  res.json({ ok: true });
});

/* ----------------------------- 后台：手动推送弹窗（直播中临时上链接） ----------------------------- */

// 推送：把某商品弹到前台（覆盖该房间之前的推送）。状态存内存，不落盘。
app.post('/api/admin/promos/live', requireAdmin, (req, res) => {
  const roomId = sanitizeText(req.body.roomId, 20);
  if (!getRoom(roomId)) return res.status(404).json({ error: '直播间不存在' });
  const product = (db().products || []).find((p) => p.id === req.body.productId && p.roomId === roomId && p.enabled);
  if (!product) return res.status(404).json({ error: '商品不存在或未启用' });
  livePromos.set(roomId, { productId: product.id, at: Date.now() });
  res.json({ ok: true, productId: product.id });
});

// 收起：撤下该房间当前推送
app.post('/api/admin/promos/live/clear', requireAdmin, (req, res) => {
  const roomId = sanitizeText(req.body.roomId, 20);
  livePromos.delete(roomId);
  res.json({ ok: true });
});

// 查当前推送（后台进入页面时回显状态）
app.get('/api/admin/promos/live', requireAdmin, (req, res) => {
  const roomId = String(req.query.room || '');
  const lp = livePromos.get(roomId);
  res.json({ productId: lp ? lp.productId : null });
});

/* ----------------------------- 后台：订单（只读） ----------------------------- */

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const roomId = String(req.query.room || '');
  res.json((db().orders || []).filter((o) => o.roomId === roomId).sort((a, b) => b.createdAt - a.createdAt));
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
