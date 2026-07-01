'use strict';

/* ============================ 工具 ============================ */
const $ = (sel) => document.querySelector(sel);
const api = {
  async get(url) { const r = await fetch(url); return r.json(); },
  async post(url, body) {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '请求失败');
    return data;
  }
};

// 当前直播间短码：从 /r/<短码> 路径取，兼容 ?room= 兜底
const ROOM_ID = (() => {
  const m = location.pathname.match(/^\/r\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  return new URLSearchParams(location.search).get('room') || '';
})();

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2200);
}

// 由昵称生成稳定头像底色
function colorOf(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h}, 60%, 50%)`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function normalizeHttpUrl(s) {
  const v = String(s == null ? '' : s).trim();
  if (!v || !/^https?:\/\//i.test(v)) return '';
  try { return new URL(v).href; } catch (e) { return ''; }
}

/* ============================ 本地身份 ============================ */
const ME = (() => {
  let id = localStorage.getItem('zhibo_clientId');
  if (!id) { id = 'u_' + Math.random().toString(36).slice(2, 11); localStorage.setItem('zhibo_clientId', id); }
  return {
    clientId: id,
    nickname: localStorage.getItem('zhibo_nick') || '',
    region: localStorage.getItem('zhibo_region') || ''
  };
})();

/* ============================ 状态 ============================ */
const state = {
  room: null,
  player: null,        // 统一播放器接口 { seek(tSec), unmute(), play() }，由具体注入器赋值
  voomlyApi: null,     // Voomly 官方 playerAPI（onAttached 拿到后存这里）
  hlsVideo: null,      // 新版 HLS 的 <video> 元素
  hls: null,           // hls.js 实例
  hlsStarted: false,   // HLS 是否已结束预缓冲、正式起播
  clockOffset: 0,      // serverNow - localNow
  presets: [],         // 已按 time 排序
  shownPresetIds: new Set(),
  shownCommentIds: new Set(),
  commentTimeline: [],      // 真实评论按 createdAt−liveStartAt 排到时间线（与预设同一套揭示）
  timelineIds: new Set(),   // 已收进时间线的评论 id（去重）
  commentsBackfilled: false, // 首批历史是否已回填
  lastCommentTs: 0,
  entered: false,
  countdownTimer: null, // 预约开播倒计时
  tickTimer: null,
  pollTimer: null,
  presenceTimer: null,
  viewerTimer: null,
  displayViewers: 0
};

function now() { return Date.now() + state.clockOffset; }
function elapsedSec() {
  if (!state.room || !state.room.liveStartAt) return 0;
  return Math.floor((now() - state.room.liveStartAt) / 1000);
}

/* ============================ 渲染评论流 ============================ */
const feed = $('#feed');

function nearBottom() {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
}
function scrollToBottom(force) {
  if (force || nearBottom()) feed.scrollTop = feed.scrollHeight;
}

function appendComment({ nickname, region, content, avatar, mine }) {
  const stick = nearBottom();
  const el = document.createElement('div');
  el.className = 'msg' + (mine ? ' mine' : '');
  const av = avatar
    ? `<span class="avatar"><img src="${escapeHtml(avatar)}" alt=""></span>`
    : `<span class="avatar" style="background:${colorOf(nickname)}">${escapeHtml((nickname || '?').slice(0, 1))}</span>`;
  const region_ = region ? `<span class="region">${escapeHtml(region)}</span>` : '';
  el.innerHTML = `${av}
    <div class="bubble">
      <div class="meta"><span class="nick">${escapeHtml(nickname)}</span>${region_}</div>
      <div class="text">${escapeHtml(content)}</div>
    </div>`;
  feed.appendChild(el);
  scrollToBottom(stick || mine);
}

function appendSystem({ nickname, type, region }) {
  const stick = nearBottom();
  const el = document.createElement('div');
  el.className = 'msg system';
  const action = type === 'like' ? '为直播点赞 👍' : '进入了直播间';
  const region_ = region ? `（${escapeHtml(region)}）` : '';
  el.innerHTML = `<span class="sys-pill"><span class="nick">${escapeHtml(nickname)}</span>${region_} ${action}</span>`;
  feed.appendChild(el);
  scrollToBottom(stick);
}

function renderPreset(p) {
  if (p.type === 'join' || p.type === 'like') appendSystem(p);
  else appendComment({ nickname: p.nickname, region: p.region, content: p.content, avatar: p.avatar });
}

/* ============================ 直播时钟驱动 ============================ */
function revealDuePresets() {
  const e = state.room.status === 'ended' ? Infinity : elapsedSec();
  for (const p of state.presets) {
    if (state.shownPresetIds.has(p.id)) continue;
    if (p.time <= e) {
      state.shownPresetIds.add(p.id);
      renderPreset(p);
    }
  }
}

// 进场回填：把已经「发生过」的预设，只补最近 N 条作为历史，其余标记为已显示
function backfillHistory(maxShow = 15) {
  const e = state.room.status === 'ended' ? Infinity : elapsedSec();
  const past = state.presets.filter((p) => p.time <= e);
  const toShow = past.slice(-maxShow);
  const showIds = new Set(toShow.map((p) => p.id));
  for (const p of past) {
    state.shownPresetIds.add(p.id); // 全部标记已显示，避免重复
    if (showIds.has(p.id)) renderPreset(p);
  }
  scrollToBottom(true);
}

/* ============================ 拉取真实评论（对齐到时间线） ============================ */
// 真实评论按「开播后第几秒」定位：offset = createdAt − liveStartAt（未开播则 0）。
// 这样迟到/重进者看到的评论流与视频进度一致，而不是把历史一次性倒出来。
function commentTime(createdAt) {
  if (!state.room.liveStartAt) return 0;
  return Math.max(0, Math.floor((createdAt - state.room.liveStartAt) / 1000));
}

// 揭示「到点」的真实评论（与 revealDuePresets 同构）
function revealDueComments() {
  const e = state.room.status === 'ended' ? Infinity : elapsedSec();
  for (const c of state.commentTimeline) {
    if (state.shownCommentIds.has(c.id)) continue;
    if (c.time <= e) {
      state.shownCommentIds.add(c.id);
      appendComment({ nickname: c.nickname, region: c.region, content: c.content });
    }
  }
}

// 进场回填：已发生过的真实评论只补最近 N 条，其余标记已显示（与 backfillHistory 同构）
function backfillComments(maxShow = 15) {
  const e = state.room.status === 'ended' ? Infinity : elapsedSec();
  const past = state.commentTimeline.filter((c) => c.time <= e && !state.shownCommentIds.has(c.id));
  const showIds = new Set(past.slice(-maxShow).map((c) => c.id));
  for (const c of past) {
    state.shownCommentIds.add(c.id); // 全部标记已显示，避免重复
    if (showIds.has(c.id)) appendComment({ nickname: c.nickname, region: c.region, content: c.content });
  }
}

async function pollComments() {
  try {
    const data = await api.get('/api/comments?room=' + ROOM_ID + '&since=' + state.lastCommentTs);
    let added = false;
    for (const c of data.comments) {
      if (c.createdAt > state.lastCommentTs) state.lastCommentTs = c.createdAt;
      // 自己的(已乐观显示)或已收进时间线的，跳过（用 id 去重）
      if (state.shownCommentIds.has(c.id) || state.timelineIds.has(c.id)) continue;
      state.timelineIds.add(c.id);
      state.commentTimeline.push({ id: c.id, time: commentTime(c.createdAt), nickname: c.nickname, region: c.region, content: c.content });
      added = true;
    }
    if (added) state.commentTimeline.sort((a, b) => a.time - b.time);
    if (!state.commentsBackfilled) {
      backfillComments();            // 首批：只补最近历史
      state.commentsBackfilled = true;
    } else if (added) {
      revealDueComments();           // 之后：新评论到点即揭示（直播边缘=实时）
    }
    if ('livePromo' in data) handleLivePromo(data.livePromo); // 搭车：处理后台手动推送
    if ('roomStatus' in data) handleRoomStatus(data.roomStatus); // 搭车：直播中→已结束 当场盖结束页
  } catch (e) { /* 忽略轮询错误 */ }
}

// 轮询发现房间状态转为 ended：当场盖上「领取回放」结束页，停掉播放与轮询，无需观众刷新
function handleRoomStatus(status) {
  if (status !== 'ended' || !state.room || state.room.status === 'ended') return;
  state.room.status = 'ended';
  teardownLive();        // 停播放器、心跳、评论/揭示轮询
  showEndedScreen();     // 盖结束页（含「领取回放」按钮，若已配 WhatsApp）
}

// 直播转结束时收尾：停掉播放器与所有直播态定时器，避免视频继续循环重播
function teardownLive() {
  try { if (state.hls) { state.hls.destroy(); state.hls = null; } } catch (e) { /* 无妨 */ }
  const v = state.hlsVideo;
  if (v) { try { v.pause(); } catch (e) { /* 无妨 */ } }
  // Voomly / iframe 嵌入：没有可控播放器句柄，直接清空容器停掉嵌入，避免继续循环播
  const wrap = $('#videoWrap');
  if (wrap && state.room.videoType !== 'hls') wrap.innerHTML = '';
  for (const k of ['pollTimer', 'tickTimer', 'presenceTimer', 'viewerTimer', 'countdownTimer']) {
    if (state[k]) { clearInterval(state[k]); state[k] = null; }
  }
}

// 后台手动推送：按 at 时间戳判断是否「新一次推送」，是则弹；变 null 则收起
function handleLivePromo(lp) {
  const prevAt = shop.livePromoAt || 0;
  if (lp && lp.productId) {
    if (lp.at && lp.at !== prevAt) {        // 新推送（或换了商品）→ 弹出，手动模式不自动收
      shop.livePromoAt = lp.at;
      const product = shop.products.find((x) => x.id === lp.productId);
      if (product) showPromoPop({ productId: lp.productId, durationSec: 0 });
    }
  } else if (prevAt) {                       // 后台已收起 → 撤下
    shop.livePromoAt = 0;
    hidePromoPop();
  }
}

/* ============================ 观看人数浮动 ============================ */
function startViewers() {
  const base = state.room.viewerBase || 0;
  state.displayViewers = base;
  const render = () => { $('#viewerCount').textContent = state.displayViewers.toLocaleString(); };
  render();
  state.viewerTimer = setInterval(() => {
    if (state.room.status === 'ended') return;
    const drift = Math.round((Math.random() - 0.45) * 4); // 轻微上浮
    state.displayViewers = Math.max(0, state.displayViewers + drift);
    render();
  }, 3000);
}

/* ============================ 顶栏 / 视频 ============================ */
function renderTopbar() {
  const r = state.room;
  $('#roomName').textContent = r.name || '直播间';
  $('#courseTitle').textContent = r.courseTitle || '';
  document.title = r.name || '直播间';
  const badge = $('#statusBadge');
  badge.className = 'status-badge ' + r.status;
  badge.textContent = { pre: '即将开始', live: '直播中', ended: '已结束' }[r.status] || '';

  // 课程标题大字 banner
  const banner = $('#titleBanner');
  if (r.bannerTitle && r.bannerTitle.trim()) {
    $('#tbTitle').textContent = r.bannerTitle;
    $('#tbSub').textContent = r.bannerSubtitle || '';
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

// 注入嵌入代码并让其中的 <script> 真正执行（innerHTML 插入的 script 默认不执行）
function setEmbedHTML(container, html) {
  container.innerHTML = html;
  container.querySelectorAll('script').forEach((old) => {
    const s = document.createElement('script');
    for (const a of old.attributes) s.setAttribute(a.name, a.value);
    if (old.textContent) s.textContent = old.textContent;
    old.replaceWith(s); // 重新创建后浏览器才会执行
  });
}

// 从任意形式的 Voomly 输入（script 嵌入 / iframe / 分享链接 / 纯视频ID）提取视频ID。
// 提取不到则返回 null（走通用注入，兼容其它平台）。
function extractVoomlyId(input) {
  if (!input) return null;
  const s = String(input).trim();
  const first = (...res) => { for (const re of res) { const m = s.match(re); if (m) return m[1]; } return ''; };
  let id = first(/data-id="([^"]+)"/i, /[?&]videoId=([^"&\s]+)/i, /\/v\/([A-Za-z0-9]+)/);
  if (!id && /^[A-Za-z0-9]{20,}$/.test(s)) id = s; // 纯视频ID
  return id || null;
}

// 从原始嵌入串里取一些可选属性（比例 / 皮肤色），取不到给默认值。
function voomlyAttr(input, ...res) {
  const s = String(input || '');
  for (const re of res) { const m = s.match(re); if (m) return m[1]; }
  return '';
}

// 只加载一次官方 embed-build.js（重复注入 .voomly-embed div 不需要重复 load）
let voomlyLoaderInjected = false;

// 用官方脚本嵌入注入 Voomly，并拿到 playerAPI 来 seek（对齐直播进度）/ unmute（自己接管开声）。
// 关键：保留官方嵌入而非重建裸 iframe —— 裸 iframe 收不到入站指令，拿不到 API（已实测）。
function injectVoomlyEmbed(videoId) {
  const wrap = $('#videoWrap');
  const guard = $('#videoGuard');   // 先存住：setEmbedHTML 会清空 wrap
  const soundBtn = $('#soundBtn');
  const raw = state.room.videoEmbed;
  const ratio = voomlyAttr(raw, /data-ratio="([^"]+)"/i, /[?&]videoRatio=([^"&\s]+)/i)
    || (state.videoAspect ? state.videoAspect.toFixed(6) : '0.562500');
  let skin = voomlyAttr(raw, /data-skin-color="([^"]+)"/i, /[?&]skinColor=([^"&\s]+)/i) || '#008EFF';
  try { skin = decodeURIComponent(skin); } catch (e) { /* 保持原样 */ }

  const div = `<div class="voomly-embed" data-id="${escapeHtml(videoId)}" data-ratio="${escapeHtml(ratio)}"`
    + ` data-type="v" data-skin-color="${escapeHtml(skin)}" style="width:100%;aspect-ratio:${escapeHtml(ratio)}/1;"></div>`;
  const loader = voomlyLoaderInjected ? '' : '<script src="https://embed.voomly.com/embed/embed-build.js"></script>';
  voomlyLoaderInjected = true;
  setEmbedHTML(wrap, div + loader); // setEmbedHTML 会让其中的 <script> 真正执行

  if (guard) wrap.appendChild(guard);       // 重新挂回拦截层（末位，盖在视频上）
  if (soundBtn) wrap.appendChild(soundBtn);  // 开声按钮在 guard 之后 → z-index 更高 → 可点
  fitVideoCover();
  // 脚本型嵌入异步插入 iframe，定时 + 监听 DOM 变化随时重新铺满
  setTimeout(fitVideoCover, 400);
  setTimeout(fitVideoCover, 1500);
  const mo = new MutationObserver(fitVideoCover);
  mo.observe(wrap, { childList: true, subtree: true });
  setTimeout(() => mo.disconnect(), 8000);

  bindVoomlyApi(videoId);
}

// 等官方 preloader 出现 → 拿 playerAPI：onReady 时对齐直播进度，volume 变化时管理开声按钮。
function bindVoomlyApi(videoId) {
  let tries = 0;
  const attach = () => {
    try {
      window.voomlyEmbedPlayerPreloader.onAttached(videoId, ({ api }) => {
        state.voomlyApi = api;
        // 统一播放器接口（Voomly 实现）
        state.player = {
          seek: (t) => { try { api.seek({ time: t }); } catch (e) { /* 无妨 */ } },
          unmute: () => { try { api.unmute(); } catch (e) {} try { api.play(); } catch (e) {} },
          play: () => { try { api.play(); } catch (e) {} }
        };
        api.onReady(() => {
          try { api.enableAutoplay && api.enableAutoplay(); } catch (e) { /* 兜底，失败无妨 */ }
          seekToLivePosition();
        });
        // 浏览器默认静音自动播放：起播即显示开声按钮，用户解除静音后隐藏
        api.onVolumeChange((p) => {
          if (p && p.muted === false) hideSoundBtn(); else showSoundBtn();
        });
      });
    } catch (e) { /* preloader 接口异常：静默退化，最坏只是不 seek/不自动接管开声 */ }
  };
  if (window.voomlyEmbedPlayerPreloader) { attach(); return; }
  const iv = setInterval(() => {
    if (window.voomlyEmbedPlayerPreloader) { clearInterval(iv); attach(); }
    else if (++tries > 100) clearInterval(iv); // 封顶 ~10s
  }, 100);
}

// 迟到/重进者对齐到「已开播多久」；ended(回放) 从头看，不 seek。播放器无关：走统一 player.seek。
function seekToLivePosition() {
  if (!state.player || state.room.status !== 'live') return;
  const t = elapsedSec();
  if (t > 2) state.player.seek(t);
}

/* ============================ 新版：Cloudflare HLS 自建播放器 ============================ */
// 懒加载 hls.js（仅新版房间用），加载一次
let hlsLoading = null;
function loadHlsJs(cb) {
  if (window.Hls) { cb(); return; }
  if (hlsLoading) { hlsLoading.push(cb); return; }
  hlsLoading = [cb];
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1';
  s.onload = () => { const q = hlsLoading; hlsLoading = []; q.forEach((f) => f()); };
  s.onerror = () => { hlsLoading = null; };
  document.head.appendChild(s);
}

// 当前播放点前方已缓冲的秒数（缓冲垫厚度）
function bufferedAhead(v, from) {
  const b = v.buffered;
  for (let i = 0; i < b.length; i++) {
    if (b.start(i) - 0.25 <= from && from <= b.end(i)) return b.end(i) - from;
  }
  return 0;
}

const SYNC_CUSHION = 6;     // 起播前要攒够的缓冲垫（秒）
const SYNC_MAX_WAIT = 8000; // 弱网兜底：最多等这么久就尽力起播（毫秒）

// 起播流程：先在覆盖层后预缓冲，攒够缓冲垫再「对齐到当前直播进度」并露出画面。
// 解决「开头 5 秒卡顿」——把那段必卡的窗口藏在「正在同步直播进度…」覆盖层后面。
function startBufferedPlayback(video) {
  if (state.hlsStarted) return;
  const live = state.room.status !== 'ended';
  // 先把播放点放到直播进度，让 hls 在此位置预缓冲（回放从头，不动）
  if (live) { try { video.currentTime = elapsedSec(); } catch (e) { /* 无妨 */ } }
  const startedAt = performance.now();

  const reveal = () => {
    if (state.hlsStarted) return;
    state.hlsStarted = true;
    // 起播对齐：露出画面的这一刻 seek 到「当前」直播进度（消化预缓冲耗时），与评论时间线对齐
    if (live) { try { video.currentTime = elapsedSec(); } catch (e) { /* 无妨 */ } }
    video.play().catch(() => {});
    hideSyncOverlay();
  };

  const tick = () => {
    if (state.hlsStarted) return;
    const probe = live ? elapsedSec() : video.currentTime;
    const enough = bufferedAhead(video, probe) >= SYNC_CUSHION;
    if (enough || performance.now() - startedAt > SYNC_MAX_WAIT) { reveal(); return; }
    setTimeout(tick, 250);
  };
  tick();
}

// 用原生 <video> + hls.js 播放 Cloudflare 的 HLS 地址。直接拿到 video，seek/unmute/防暂停都一行。
function injectHlsPlayer(url) {
  const wrap = $('#videoWrap');
  const guard = $('#videoGuard');
  const soundBtn = $('#soundBtn');
  const video = document.createElement('video');
  video.className = 'hls-fill'; // 用 object-fit:cover 按真实比例铺满（不依赖 orientation 猜测）
  video.muted = true; video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', ''); video.playsInline = true; video.preload = 'auto';
  // 不设 autoplay：先在覆盖层后预缓冲，由 startBufferedPlayback 攒够缓冲再起播
  wrap.innerHTML = '';
  wrap.appendChild(video);
  if (guard) wrap.appendChild(guard);       // 拦截层盖在视频上（末位）
  if (soundBtn) wrap.appendChild(soundBtn);  // 开声按钮在 guard 之后 → 可点
  state.hlsVideo = video;
  state.hlsStarted = false;

  const live = state.room.status !== 'ended';
  if (live) showSyncOverlay(); // 「正在同步直播进度…」盖住开头预缓冲窗口
  // 兜底：manifest 迟迟不就绪也不能一直转圈，最多 12s 后尽力起播 + 撤层
  setTimeout(() => { if (!state.hlsStarted) startBufferedPlayback(video); }, 12000);

  const onReady = () => startBufferedPlayback(video);
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url; // Safari/iOS 原生支持 HLS
    video.addEventListener('loadedmetadata', onReady, { once: true });
  } else {
    loadHlsJs(() => {
      if (!window.Hls || !window.Hls.isSupported()) { video.src = url; video.addEventListener('loadedmetadata', onReady, { once: true }); return; }
      const hls = new window.Hls({
        capLevelToPlayerSize: true, // 不拉超过屏幕分辨率的高码率档
        startLevel: 0,              // 起播先低码率，填缓冲快、起播稳，之后 ABR 上调
        maxBufferLength: 30,        // 持续攒前向缓冲垫
        maxMaxBufferLength: 60
      });
      state.hls = hls;
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.MANIFEST_PARSED, onReady);
    });
  }
  // 防暂停兜底：仅「已正式起播后」被暂停才续播，避免和预缓冲/缓冲互掐
  video.addEventListener('pause', () => {
    if (state.room.status !== 'ended' && state.hlsStarted) video.play().catch(() => {});
  });
  // 静音状态变化 → 已解除静音则收起开声按钮
  video.addEventListener('volumechange', () => { if (!video.muted) hideSoundBtn(); });

  // 统一播放器接口（HLS 实现）
  state.player = {
    seek: (t) => { try { video.currentTime = t; } catch (e) { /* 无妨 */ } },
    unmute: () => { video.muted = false; video.play().catch(() => {}); },
    play: () => video.play().catch(() => {})
  };

  fitVideoCover();
  setTimeout(fitVideoCover, 300);
  setTimeout(fitVideoCover, 1200);
}

// 「正在同步直播进度…」覆盖层
function showSyncOverlay() { const o = $('#syncMask'); if (o) o.hidden = false; }
function hideSyncOverlay() { const o = $('#syncMask'); if (o) o.hidden = true; }

function injectVideo() {
  const wrap = $('#videoWrap');

  // 新版：Cloudflare HLS 地址 + 自建播放器
  if (state.room.videoType === 'hls') {
    const url = (state.room.hlsUrl || '').trim();
    if (url) { injectHlsPlayer(url); return; }
    wrap.innerHTML = '<div class="video-placeholder">未配置视频地址</div>';
    return;
  }

  // 老版：Voomly / 通用嵌入
  const embed = state.room.videoEmbed && state.room.videoEmbed.trim();
  if (!embed) { wrap.innerHTML = '<div class="video-placeholder">主播正在准备中…</div>'; return; }

  const vid = extractVoomlyId(embed);
  if (vid) { injectVoomlyEmbed(vid); return; } // Voomly：官方脚本嵌入 + playerAPI

  // 其它平台：原样注入兜底（同样重新挂回 guard + 开声按钮，并铺满）
  const guard = $('#videoGuard');
  const soundBtn = $('#soundBtn');
  setEmbedHTML(wrap, state.room.videoEmbed);
  if (guard) wrap.appendChild(guard);
  if (soundBtn) wrap.appendChild(soundBtn);
  fitVideoCover();
  setTimeout(fitVideoCover, 400);
  setTimeout(fitVideoCover, 1500);
  const mo = new MutationObserver(fitVideoCover);
  mo.observe(wrap, { childList: true, subtree: true });
  setTimeout(() => mo.disconnect(), 8000);
}

/* ============================ 开启声音按钮 ============================ */
// 浏览器只允许静音自动播放，原生开声按钮被拦截层盖住，故我们自己接管：点按钮(真实手势)→ unmute + play。
function showSoundBtn() {
  if (state.room.status === 'ended') return; // 回放不需要
  const btn = $('#soundBtn');
  if (btn) { btn.hidden = false; fitVideoCover(); }
}
function hideSoundBtn() {
  const btn = $('#soundBtn');
  if (btn) btn.hidden = true;
}
(function bindSoundBtn() {
  const btn = $('#soundBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (state.player) state.player.unmute(); // 真实手势 → 解除静音（Voomly/HLS 统一）
    hideSoundBtn();
  });
})();

// 让视频按真实比例「覆盖式」铺满舞台：居中，超出裁掉，左右/上下都不留黑边
function fitVideoCover() {
  const stage = $('#stage');
  const el = document.querySelector('#videoWrap iframe, #videoWrap video');
  if (!stage || !el) return;
  // 新版原生 video：由 CSS object-fit:cover 按真实比例铺满，这里只把拦截层铺满整个舞台即可
  if (el.classList && el.classList.contains('hls-fill')) {
    const guard = $('#videoGuard');
    if (guard) { guard.style.width = stage.clientWidth + 'px'; guard.style.height = stage.clientHeight + 'px'; }
    return;
  }
  // 脚本型嵌入常给 iframe 套一层按比例撑高的 wrapper，先把这些 wrapper 撑满舞台、去掉内边距，
  // 这样里面的 iframe 才是相对舞台定位，覆盖式铺满才准确。
  let p = el.parentElement;
  while (p && p.id !== 'videoWrap') {
    p.style.position = 'absolute'; p.style.inset = '0';
    p.style.width = '100%'; p.style.height = '100%';
    p.style.padding = '0'; p.style.margin = '0';
    p = p.parentElement;
  }
  const W = stage.clientWidth, H = stage.clientHeight;
  const r = state.videoAspect || (16 / 9); // 视频宽/高
  let w, h;
  if (W / H > r) { w = W; h = W / r; }   // 舞台更宽 → 按宽铺满，上下裁
  else { h = H; w = H * r; }             // 舞台更高 → 按高铺满，左右裁
  el.style.position = 'absolute'; el.style.top = '50%'; el.style.left = '50%';
  el.style.transform = 'translate(-50%, -50%)';
  el.style.width = Math.ceil(w) + 'px'; el.style.height = Math.ceil(h) + 'px';
  el.style.maxWidth = 'none'; el.style.maxHeight = 'none';
  // 防暂停拦截层：尺寸/位置与视频本体完全一致，连溢出舞台的部分也盖住
  const guard = $('#videoGuard');
  if (guard) {
    guard.style.width = Math.ceil(w) + 'px';
    guard.style.height = Math.ceil(h) + 'px';
  }
}
window.addEventListener('resize', fitVideoCover);

/* ============================ 在线心跳（后台「观看记录」用） ============================ */
// sessionId 存 sessionStorage：刷新页面不算新会话，关掉标签页才算下一次访问。
const SESSION_ID = (() => {
  let id = sessionStorage.getItem('zhibo_sid');
  if (!id) { id = 's_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); sessionStorage.setItem('zhibo_sid', id); }
  return id;
})();

function heartbeat() {
  const body = JSON.stringify({
    roomId: ROOM_ID, sessionId: SESSION_ID, clientId: ME.clientId,
    nickname: ME.nickname, region: ME.region
  });
  fetch('/api/heartbeat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body, keepalive: true
  }).catch(() => { /* 心跳失败忽略，下一拍再来 */ });
}

// 离开：关闭/切走页面时补一条，拿到精确退出时间（sendBeacon 在 unload 阶段最可靠）
function sendLeave() {
  const payload = JSON.stringify({ roomId: ROOM_ID, sessionId: SESSION_ID });
  if (navigator.sendBeacon) {
    navigator.sendBeacon('/api/leave', new Blob([payload], { type: 'application/json' }));
  } else {
    fetch('/api/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true }).catch(() => {});
  }
}

// 进入直播间后开始心跳（幂等）：立即发一拍，之后每 15s 一拍
function startPresence() {
  if (state.presenceTimer) return;
  heartbeat();
  state.presenceTimer = setInterval(heartbeat, 15000);
  window.addEventListener('pagehide', sendLeave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') heartbeat(); // 切回前台立即刷新在线状态
  });
}

/* ============================ 启动互动 ============================ */
// 评论轮询（幂等：已在轮询就不重复开）
function ensurePolling() {
  if (state.pollTimer) return;
  pollComments();
  state.pollTimer = setInterval(pollComments, 3000);
}

function startLiveFeed() {
  state.entered = true;
  startPresence();
  backfillHistory();
  ensurePolling();
  if (!state.tickTimer) state.tickTimer = setInterval(() => { revealDuePresets(); revealDueComments(); revealDuePromos(); }, 1000);
  showCartFab(); // 进入直播间后，若开启商城则显示购物车入口
  $('#feedHint').textContent = state.room.status === 'ended' ? '直播已结束' : '直播进行中';
  // 直播中：进场即盖上透明拦截层，任何平台都点不动、无法暂停（像真直播）。回放(ended)不锁，方便拖进度。
  // 开声音不再依赖拦截层让路 —— 由我们自己的 #soundBtn(在 guard 之上) 调 api.unmute() 接管。
  if (state.room.status !== 'ended') {
    const guard = $('#videoGuard');
    if (guard) { guard.hidden = false; fitVideoCover(); }
    showSoundBtn(); // 起播默认静音，给出开声按钮
  }
}

// 绑定「进入直播间」按钮
function bindEnter() {
  const mask = $('#enterMask');
  $('#enterBtn').onclick = () => {
    injectVideo();      // 在用户点击手势内注入 iframe → 配合 Voomly 后台自动播放设置可自动开播
    mask.hidden = true;
    startLiveFeed();
  };
}

function showEnterMask() {
  $('#enterMask').hidden = false;
  $('#enterTitle').textContent = '直播进行中';
  $('#enterSub').textContent = '点击进入，和大家一起看';
  $('#enterBtn').hidden = false;
  bindEnter();
}

/* ============================ 观看码准入门 ============================ */
const ACCESS_KEY = 'zhibo_access_' + ROOM_ID; // 观看码缓存按直播间隔离

// 用观看码换取锁定身份（替代登录）。成功则写入 ME 并缓存。
function applyAccess(data) {
  ME.nickname = data.nickname || '';
  ME.region = data.region || '';
  ME.locked = true; // 身份由观看码锁定，用户不可改
  localStorage.setItem(ACCESS_KEY, JSON.stringify({ code: data.code, nickname: ME.nickname, region: ME.region }));
}

// 尝试用缓存里的观看码免输入进入（同时校验是否仍有效）
async function tryStoredAccess() {
  let stored;
  try { stored = JSON.parse(localStorage.getItem(ACCESS_KEY) || 'null'); } catch (e) { stored = null; }
  if (!stored || !stored.code) return false;
  try {
    const data = await api.post('/api/access', { roomId: ROOM_ID, code: stored.code });
    applyAccess(data);
    return true;
  } catch (e) {
    localStorage.removeItem(ACCESS_KEY); // 过期/失效 → 清掉重新输
    return false;
  }
}

function showGate() {
  const gate = $('#gateMask');
  gate.hidden = false;
  const input = $('#gateInput');
  const btn = $('#gateBtn');
  const err = $('#gateErr');
  setTimeout(() => input.focus(), 100);

  const submit = async () => {
    const code = input.value.trim();
    err.textContent = '';
    if (!code) { err.textContent = '请输入观看码'; return; }
    btn.disabled = true;
    try {
      const data = await api.post('/api/access', { roomId: ROOM_ID, code });
      applyAccess(data);
      gate.hidden = true;
      proceed(); // 验证通过 → 进入直播间流程
    } catch (e) {
      err.textContent = e.message || '观看码无效';
    } finally {
      btn.disabled = false;
    }
  };
  btn.onclick = submit;
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
}

/* ============================ 进入直播间流程 ============================ */
function proceed() {
  const room = state.room;
  if (room.status === 'ended') {
    showEndedScreen(); // 直播结束：展示「领取回放」页，不再重播录像
  } else if (room.status === 'live' && room.liveStartAt) {
    if (now() < room.liveStartAt) {
      showCountdown(); // 预约：到点前倒计时，到点自动开播
    } else {
      showEnterMask(); // 已开播：点「进入直播间」(用户手势) 再注入，浏览器才允许自动播放
    }
  } else { // pre / 未设开播时间：未开播聊天室，先聊几句
    injectVideo();
    $('#feedHint').textContent = '直播即将开始，先聊几句吧';
    ensurePolling(); // 未开播也允许评论；预设不展示
    startPresence();
    state.entered = true;
    showCartFab();
  }
}

/* ============================ 预约开播倒计时 ============================ */
// ms → "HH:MM:SS"
function fmtCountdown(ms) {
  let s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}`;
}

// 到点前显示封面+倒计时，到点(用统一时间基点 liveStartAt 判断)自动开播
function showCountdown() {
  const room = state.room;
  const mask = $('#countdownMask');
  if (room.cover && room.cover.trim()) {
    mask.style.backgroundImage = `url("${room.cover.replace(/"/g, '')}")`;
  }
  $('#countdownTitle').textContent = (room.bannerTitle && room.bannerTitle.trim()) || room.name || '直播即将开始';
  $('#countdownSub').textContent = room.courseTitle || '';
  $('#statusBadge').textContent = '即将开始';
  mask.hidden = false;

  const tick = () => {
    const ms = room.liveStartAt - now();
    if (ms <= 0) {
      clearInterval(state.countdownTimer);
      state.countdownTimer = null;
      mask.hidden = true;
      startScheduledLive(); // 到点自动开播
      return;
    }
    $('#countdownTimer').textContent = fmtCountdown(ms);
  };
  tick();
  state.countdownTimer = setInterval(tick, 1000);
}

// 到点自动开播：静音自动播放（移动端无需手势即可静音起播），随后由 #soundBtn 接管开声。
// 此刻 elapsedSec()≈0，seekToLivePosition 不 seek，所有人从 0 同步开始。
function startScheduledLive() {
  $('#statusBadge').textContent = '直播中';
  injectVideo();
  startLiveFeed();
}

// 直播结束：盖上「领取回放」结束页（不注入视频、不重播）。配了 WhatsApp 链接才显示按钮。
function showEndedScreen() {
  $('#statusBadge').textContent = '已结束';
  renderTopbar();
  const url = normalizeHttpUrl(state.room.replayWhatsappUrl);
  const btn = $('#endedReplayBtn');
  const note = $('#endedReplayNote');
  if (url) {
    btn.hidden = false;
    note.hidden = false;
    btn.onclick = () => window.open(url, '_blank', 'noopener');
  } else {
    btn.hidden = true;
    note.hidden = true;
  }
  // 结束态不再聊天/送花：隐藏底部输入栏，避免遮罩盖不住它
  const composer = document.querySelector('.composer');
  if (composer) composer.hidden = true;
  $('#endedMask').hidden = false;
}

// 链接无效 / 直播间不存在 → 用进入遮罩显示提示，不放行
function showInvalidLink(msg) {
  $('#enterMask').hidden = false;
  $('#enterTitle').textContent = '链接无效';
  $('#enterSub').textContent = msg || '请通过专属直播间链接进入';
  $('#enterBtn').hidden = true;
  $('#statusBadge').textContent = '—';
}

/* ============================ 初始化 ============================ */
async function init() {
  if (!ROOM_ID) { showInvalidLink('请通过专属直播间链接进入（/r/直播间码）'); return; }
  let room;
  try { room = await api.get('/api/room?id=' + encodeURIComponent(ROOM_ID)); }
  catch (e) { showInvalidLink('直播间不存在或链接已失效'); return; }
  if (!room || !room.id) { showInvalidLink('直播间不存在或链接已失效'); return; }

  state.clockOffset = room.serverNow - Date.now();
  state.room = room;
  // 视频宽高比：竖屏 9:16，横屏 16:9
  state.videoAspect = (room.orientation === 'portrait') ? (9 / 16) : (16 / 9);

  renderTopbar();
  startViewers();
  state.presets = await api.get('/api/presets?room=' + ROOM_ID); // 已排序
  await loadShop(); // 商城数据（商品/优惠券/促销弹窗）

  if (room.requireAccessCode) {
    // 需要观看码：先尝试缓存的码，不行就拦门要码
    if (await tryStoredAccess()) proceed();
    else showGate();
  } else {
    proceed();
  }
  handlePaidReturn(); // 支付返回（?paid=1）→ 展示成功态
}

/* ============================ 评论提交 ============================ */
function needNickname() { return !ME.nickname; }

function openNameModal(onDone) {
  const modal = $('#nameModal');
  $('#nickInput').value = ME.nickname || '';
  $('#regionInput').value = ME.region || '';
  modal.hidden = false;
  $('#nickInput').focus();
  $('#nickCancel').onclick = () => { modal.hidden = true; };
  $('#nickOk').onclick = () => {
    const nick = $('#nickInput').value.trim();
    if (!nick) { toast('请填写昵称'); return; }
    ME.nickname = nick;
    ME.region = $('#regionInput').value.trim();
    localStorage.setItem('zhibo_nick', ME.nickname);
    localStorage.setItem('zhibo_region', ME.region);
    modal.hidden = true;
    onDone && onDone();
  };
}

async function submitComment() {
  const input = $('#commentInput');
  const content = input.value.trim();
  if (!content) return;
  if (needNickname()) { openNameModal(submitComment); return; }

  const btn = $('#sendBtn');
  btn.disabled = true;
  try {
    const c = await api.post('/api/comments', {
      roomId: ROOM_ID, nickname: ME.nickname, region: ME.region, content, clientId: ME.clientId
    });
    state.shownCommentIds.add(c.id);
    if (c.createdAt > state.lastCommentTs) state.lastCommentTs = c.createdAt;
    appendComment({ nickname: c.nickname, region: c.region, content: c.content, mine: true });
    input.value = '';
  } catch (e) {
    toast(e.message || '发送失败');
  } finally {
    btn.disabled = false;
  }
}

$('#sendBtn').addEventListener('click', submitComment);
$('#commentInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitComment(); }
});

/* ============================ 点赞 / 送小花 ============================ */
function spawnFloat(emoji) {
  const layer = $('#floatLayer');
  const el = document.createElement('span');
  el.className = 'float-item';
  el.textContent = emoji;
  const dur = 1500 + Math.random() * 900;
  el.style.setProperty('--drift', (Math.random() * 90 - 60).toFixed(0) + 'px');
  el.style.right = (Math.random() * 30) + 'px';
  el.style.fontSize = (22 + Math.random() * 10).toFixed(0) + 'px';
  el.style.animationDuration = dur + 'ms';
  layer.appendChild(el);
  setTimeout(() => el.remove(), dur + 80);
}
// 点赞：一次冒 2~3 颗心
$('#likeBtn').addEventListener('click', () => {
  const n = 2 + Math.floor(Math.random() * 2);
  for (let i = 0; i < n; i++) setTimeout(() => spawnFloat('❤️'), i * 110);
});
// 送小花
$('#flowerBtn').addEventListener('click', () => {
  spawnFloat('🌸');
  setTimeout(() => spawnFloat('🌷'), 120);
});

/* ============================ 商城（购物车 / 课程弹窗 / 优惠券 / Stripe 结账） ============================ */
const shop = {
  enabled: false, shopName: '', currency: 'usd',
  stripeReady: false, pubKey: '',
  products: [], coupons: [],
  promos: [], shownPromoIds: new Set(),
  shownProductIds: new Set(), // 已被弹窗弹出过的商品 id：只有弹过窗的商品才进橱窗
  livePromoAt: 0,         // 后台手动推送：最近一次推送的时间戳（去重用）
  pickedCouponId: null,   // 结账时选中的券
  currentProduct: null,   // 结账中的商品
  stripeObj: null, embedded: null // Stripe.js 实例与内嵌收银台
};

// 本机订单号缓存（订单 tab 用）：按房间隔离
const ORDERS_KEY = 'zhibo_orders_' + ROOM_ID;
function myOrderIds() {
  try { return JSON.parse(localStorage.getItem(ORDERS_KEY) || '[]'); } catch (e) { return []; }
}
function rememberOrder(id) {
  const ids = myOrderIds();
  if (!ids.includes(id)) { ids.unshift(id); localStorage.setItem(ORDERS_KEY, JSON.stringify(ids.slice(0, 30))); }
}

const CURRENCY_SYMBOL = { usd: 'US$', sgd: 'S$', myr: 'RM', hkd: 'HK$', aud: 'A$', eur: '€', gbp: '£', cny: '¥', twd: 'NT$' };
// 币种现在挂在单个商品上：传入商品 currency 即可；不传则回退默认（shop.currency，默认 usd）
function curSym(cur) { const c = (cur || shop.currency || 'usd').toLowerCase(); return CURRENCY_SYMBOL[c] || (c.toUpperCase() + ' '); }
function fmtMoney(n, cur) {
  const v = Number(n) || 0;
  return curSym(cur) + (Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2));
}

async function loadShop() {
  try {
    const data = await api.get('/api/shop?room=' + ROOM_ID);
    shop.enabled = !!data.enabled;
    shop.shopName = data.shopName || '';
    shop.currency = (data.currency || 'usd').toLowerCase();
    shop.stripeReady = !!data.stripeReady;
    shop.pubKey = data.stripePublishableKey || '';
    shop.products = data.products || [];
    shop.coupons = data.coupons || [];
    if (shop.enabled) shop.promos = await api.get('/api/promos?room=' + ROOM_ID);
  } catch (e) { /* 商城拉取失败：静默，不影响直播 */ }
}

/* -------- 购物车入口（评论栏🛒 → 打开半屏商品面板） -------- */
function showCartFab() {
  if (!shop.enabled) return;
  const btn = $('#cartBtn');
  if (btn) btn.hidden = false;
}
$('#cartBtn').addEventListener('click', () => openShop('products'));

/* -------- 定时促销小卡 -------- */
function revealDuePromos() {
  if (!shop.enabled || !shop.promos.length) return;
  const e = state.room.status === 'ended' ? Infinity : elapsedSec();
  for (const p of shop.promos) {
    if (shop.shownPromoIds.has(p.id)) continue;
    if (e >= p.time) {
      shop.shownPromoIds.add(p.id);
      // 已开播很久才进来的，跳过早就过窗口的促销；仍在持续期内的才弹
      const dur = p.durationSec || 0;
      if (e === Infinity || (dur > 0 && e - p.time > dur)) continue;
      showPromoPop(p);
    }
  }
}

let promoHideTimer = null;
function setProductImage(img, url) {
  const clean = normalizeHttpUrl(url);
  img.classList.remove('img-missing');
  img.onerror = () => {
    img.removeAttribute('src');
    img.classList.add('img-missing');
  };
  if (clean) img.src = clean;
  else img.onerror();
}

function bindShopImageFallback(root) {
  root.querySelectorAll('[data-shop-img]').forEach((img) => {
    img.onerror = () => {
      const fb = document.createElement('div');
      fb.className = 'pc-img img-missing';
      img.replaceWith(fb);
    };
    if (img.complete && img.naturalWidth === 0) img.onerror();
  });
}

function showPromoPop(promo) {
  const product = shop.products.find((x) => x.id === promo.productId);
  if (!product) return;
  shop.shownProductIds.add(product.id); // 弹过窗即“上架”到橱窗
  if (!$('#shopMask').hidden) renderProducts(); // 橱窗正开着则实时刷新，把新商品补进去
  setProductImage($('#promoThumb'), product.image);
  $('#promoTitle').textContent = product.title;
  $('#promoPrice').textContent = fmtMoney(product.price, product.currency);
  const pop = $('#promoPop');
  pop.hidden = false;
  pop.dataset.productId = product.id;
  clearTimeout(promoHideTimer);
  if (promo.durationSec > 0) promoHideTimer = setTimeout(hidePromoPop, promo.durationSec * 1000);
}
function hidePromoPop() { const pop = $('#promoPop'); if (pop) pop.hidden = true; }
$('#promoClose').addEventListener('click', hidePromoPop);
$('#promoCta').addEventListener('click', () => {
  const pid = $('#promoPop').dataset.productId;
  hidePromoPop();
  const product = shop.products.find((x) => x.id === pid);
  if (product) goPay(product); else openShop('products');
});

/* -------- 商品弹窗（半屏） -------- */
function openShop(tab) {
  $('#shopName').textContent = shop.shopName || '课程';
  renderProducts();
  renderCoupons();
  $('#shopMask').hidden = false;
  switchShopTab(tab || 'products');
}
function closeShop() {
  $('#shopMask').hidden = true;
  destroyEmbedded();
}
$('#shopClose').addEventListener('click', closeShop);
$('#shopMask').addEventListener('click', (e) => { if (e.target === $('#shopMask')) closeShop(); });

function switchShopTab(tab) {
  document.querySelectorAll('.shop-tab').forEach((b) => b.classList.toggle('active', b.dataset.stab === tab));
  document.querySelectorAll('.shop-panel').forEach((p) => { p.hidden = p.dataset.spanel !== tab; });
  if (tab === 'orders') renderOrders();
}
document.querySelectorAll('.shop-tab').forEach((b) => {
  b.addEventListener('click', () => switchShopTab(b.dataset.stab));
});

/* -------- 点击购买：跳商品配置的收款链接（新标签页） -------- */
function goPay(product) {
  if (!product || !product.payUrl) { toast('该商品暂未配置支付链接'); return; }
  window.open(product.payUrl, '_blank', 'noopener');
}

function renderProducts() {
  const box = $('#productList');
  // 只展示已被弹窗弹出过的商品：没触发弹窗的上架商品不进橱窗
  const list = shop.products.filter((p) => shop.shownProductIds.has(p.id));
  if (!list.length) { box.innerHTML = '<div class="shop-empty">暂无课程</div>'; return; }
  box.innerHTML = list.map((p) => `
    <div class="product-card">
      ${normalizeHttpUrl(p.image) ? `<img class="pc-img" data-shop-img src="${escapeHtml(normalizeHttpUrl(p.image))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<div class="pc-img img-missing"></div>'}
      <div class="pc-main">
        <div class="pc-title">${escapeHtml(p.title)}</div>
        ${p.desc ? `<div class="pc-desc">${escapeHtml(p.desc)}</div>` : ''}
        <div class="pc-bottom">
          <div>
            <span class="pc-price">${escapeHtml(fmtMoney(p.price, p.currency))}</span>
            ${p.originalPrice > p.price ? `<span class="pc-orig">${escapeHtml(fmtMoney(p.originalPrice, p.currency))}</span>` : ''}
          </div>
          <button class="pc-buy" data-id="${escapeHtml(p.id)}">马上抢</button>
        </div>
      </div>
    </div>`).join('');
  box.querySelectorAll('.pc-buy').forEach((btn) => {
    btn.addEventListener('click', () => {
      const product = shop.products.find((x) => x.id === btn.dataset.id);
      if (product) goPay(product);
    });
  });
  bindShopImageFallback(box);
}

function renderCoupons() {
  const box = $('#couponList');
  if (!shop.coupons.length) { box.innerHTML = '<div class="shop-empty">暂无优惠券</div>'; return; }
  box.innerHTML = shop.coupons.map((c) => `
    <div class="coupon-card">
      <div class="cc-amt">
        <div><span class="cc-cur">${escapeHtml(curSym())}</span><span class="cc-num">${escapeHtml(String(c.amount))}</span></div>
        <div class="cc-cond">满${escapeHtml(fmtMoney(c.threshold))}可用</div>
      </div>
      <div class="cc-main">
        <div class="cc-title">${escapeHtml(c.title)}</div>
        <div class="cc-exp">${c.expireAt ? '有效期至 ' + new Date(c.expireAt).toLocaleDateString() : '长期有效'}</div>
      </div>
    </div>`).join('');
}

async function renderOrders() {
  const box = $('#orderList');
  const ids = myOrderIds();
  if (!ids.length) { box.innerHTML = '<div class="shop-empty">还没有订单</div>'; return; }
  box.innerHTML = '<div class="shop-empty">加载中…</div>';
  const STATUS_TXT = { paid: '已支付', pending: '待支付', failed: '支付失败' };
  const cards = [];
  for (const id of ids) {
    try {
      const o = await api.get('/api/order-status?id=' + encodeURIComponent(id));
      cards.push(`<div class="order-card">
        <div class="oc-row"><span class="oc-title">${escapeHtml(o.productTitle || '课程')}</span>
          <span class="oc-status ${o.status}">${STATUS_TXT[o.status] || o.status}</span></div>
        <div class="oc-row"><span>${escapeHtml(curSym(o.currency) + (o.amount || 0))}</span></div>
      </div>`);
    } catch (e) { /* 单个订单查不到就跳过 */ }
  }
  box.innerHTML = cards.length ? cards.join('') : '<div class="shop-empty">还没有订单</div>';
}

/* -------- 结账（内嵌 Stripe Embedded Checkout） -------- */
function applicableCoupons(product) {
  return shop.coupons.filter((c) => Number(product.price) >= Number(c.threshold));
}

function startCheckout(product) {
  shop.currentProduct = product;
  shop.pickedCouponId = null;
  $('#shopMask').hidden = false;
  switchShopTab('checkout');
  renderCheckout();
}

function renderCheckout() {
  const p = shop.currentProduct;
  const coupons = applicableCoupons(p);
  const picked = coupons.find((c) => c.id === shop.pickedCouponId);
  const discount = picked ? Number(picked.amount) : 0;
  const final = Math.max(0, Number(p.price) - discount);

  $('#checkoutSummary').innerHTML = `
    <div class="cs-line"><span>${escapeHtml(p.title)}</span><span>${escapeHtml(fmtMoney(p.price, p.currency))}</span></div>
    ${discount ? `<div class="cs-line"><span>优惠券</span><span>-${escapeHtml(fmtMoney(discount, p.currency))}</span></div>` : ''}
    <div class="cs-line cs-total"><span>应付</span><span>${escapeHtml(fmtMoney(final, p.currency))}</span></div>`;

  const ck = $('#checkoutCoupons');
  if (coupons.length) {
    ck.innerHTML = coupons.map((c) => `
      <div class="ck-opt ${c.id === shop.pickedCouponId ? 'active' : ''}" data-id="${escapeHtml(c.id)}">
        <span>${escapeHtml(c.title)} <span class="ck-tag">满${escapeHtml(fmtMoney(c.threshold))}减${escapeHtml(fmtMoney(c.amount))}</span></span>
        <span>${c.id === shop.pickedCouponId ? '✓ 已选' : '使用'}</span>
      </div>`).join('');
    ck.querySelectorAll('.ck-opt').forEach((el) => {
      el.addEventListener('click', () => {
        shop.pickedCouponId = (shop.pickedCouponId === el.dataset.id) ? null : el.dataset.id;
        destroyEmbedded();      // 改价了，重建收银台
        renderCheckout();
      });
    });
  } else { ck.innerHTML = ''; }

  mountEmbeddedCheckout();
}

function destroyEmbedded() {
  if (shop.embedded) { try { shop.embedded.destroy(); } catch (e) {} shop.embedded = null; }
  const box = $('#stripeBox'); if (box) box.innerHTML = '';
}

// 懒加载 Stripe.js（仅商城用，加载一次）
let stripeJsLoading = null;
function loadStripeJs(cb) {
  if (window.Stripe) { cb(); return; }
  if (stripeJsLoading) { stripeJsLoading.push(cb); return; }
  stripeJsLoading = [cb];
  const s = document.createElement('script');
  s.src = 'https://js.stripe.com/v3/';
  s.onload = () => { const q = stripeJsLoading; stripeJsLoading = []; q.forEach((f) => f()); };
  s.onerror = () => { stripeJsLoading = null; toast('支付组件加载失败'); };
  document.head.appendChild(s);
}

async function mountEmbeddedCheckout() {
  if (!shop.stripeReady) { $('#stripeBox').innerHTML = '<div class="checkout-loading">支付未配置，暂不可购买</div>'; return; }
  if (shop.embedded) return; // 已挂载
  const loading = $('#checkoutLoading');
  if (loading) loading.hidden = false;
  let order;
  try {
    order = await api.post('/api/checkout', {
      roomId: ROOM_ID,
      productId: shop.currentProduct.id,
      couponId: shop.pickedCouponId || undefined,
      nickname: ME.nickname, region: ME.region, clientId: ME.clientId
    });
  } catch (e) {
    if (loading) loading.hidden = true;
    $('#stripeBox').innerHTML = '<div class="checkout-loading">' + escapeHtml(e.message || '下单失败') + '</div>';
    return;
  }
  rememberOrder(order.orderId);
  loadStripeJs(async () => {
    try {
      if (!shop.stripeObj) shop.stripeObj = window.Stripe(shop.pubKey);
      shop.embedded = await shop.stripeObj.initEmbeddedCheckout({ clientSecret: order.clientSecret });
      if (loading) loading.hidden = true;
      shop.embedded.mount('#stripeBox');
    } catch (e) {
      if (loading) loading.hidden = true;
      $('#stripeBox').innerHTML = '<div class="checkout-loading">收银台加载失败</div>';
    }
  });
}

$('#checkoutBack').addEventListener('click', () => { destroyEmbedded(); switchShopTab('products'); });

/* -------- 支付成功返回（Stripe return_url ?paid=1&order=...） -------- */
function handlePaidReturn() {
  const q = new URLSearchParams(location.search);
  if (q.get('paid') !== '1') return;
  const orderId = q.get('order') || '';
  if (orderId) rememberOrder(orderId);
  // 清掉 URL 上的支付参数，避免刷新重复触发
  const clean = location.pathname;
  history.replaceState(null, '', clean);
  // 展示成功态并轮询确认
  $('#shopName').textContent = shop.shopName || '课程';
  $('#shopMask').hidden = false;
  switchShopTab('done');
  $('#payDoneSub').textContent = '订单确认中…';
  pollPaid(orderId);
}
function pollPaid(orderId, tries) {
  tries = tries || 0;
  if (!orderId || tries > 10) { $('#payDoneSub').textContent = '感谢购买，我们会尽快为你开通课程。'; return; }
  api.get('/api/order-status?id=' + encodeURIComponent(orderId)).then((o) => {
    if (o.status === 'paid') { $('#payDoneSub').textContent = '已支付 ' + fmtMoney(o.amount, o.currency) + '，感谢购买！'; }
    else setTimeout(() => pollPaid(orderId, tries + 1), 1500);
  }).catch(() => setTimeout(() => pollPaid(orderId, tries + 1), 1500));
}
$('#payDoneBtn').addEventListener('click', closeShop);

init();
