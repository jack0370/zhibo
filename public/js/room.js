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
  clockOffset: 0,      // serverNow - localNow
  presets: [],         // 已按 time 排序
  shownPresetIds: new Set(),
  shownCommentIds: new Set(),
  lastCommentTs: 0,
  entered: false,
  tickTimer: null,
  pollTimer: null,
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

/* ============================ 拉取真实评论 ============================ */
async function pollComments() {
  try {
    const data = await api.get('/api/comments?room=' + ROOM_ID + '&since=' + state.lastCommentTs);
    for (const c of data.comments) {
      if (state.shownCommentIds.has(c.id)) continue;
      state.shownCommentIds.add(c.id);
      if (c.createdAt > state.lastCommentTs) state.lastCommentTs = c.createdAt;
      // 自己的评论已乐观渲染，跳过（按 clientId 无法判断，这里用 id 去重已足够）
      appendComment({ nickname: c.nickname, region: c.region, content: c.content });
    }
  } catch (e) { /* 忽略轮询错误 */ }
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

// 把任意形式的 Voomly 输入（script 嵌入 / iframe / 分享链接 / 纯视频ID）统一转成稳定 iframe。
// 提取不到 Voomly 视频ID 时返回 null，走通用注入（兼容其它平台）。
function buildVoomlyIframe(input) {
  if (!input) return null;
  const s = String(input).trim();
  const first = (...res) => { for (const re of res) { const m = s.match(re); if (m) return m[1]; } return ''; };
  let id = first(/data-id="([^"]+)"/i, /[?&]videoId=([^"&\s]+)/i, /\/v\/([A-Za-z0-9]+)/);
  if (!id && /^[A-Za-z0-9]{20,}$/.test(s)) id = s; // 纯视频ID
  if (!id) return null;
  const ratio = first(/data-ratio="([^"]+)"/i, /[?&]videoRatio=([^"&\s]+)/i)
    || (state.videoAspect ? state.videoAspect.toFixed(4) : '0.5625');
  const type = first(/data-type="([^"]+)"/i, /[?&]type=([^"&\s]+)/i) || 'v';
  let skin = first(/data-skin-color="([^"]+)"/i, /[?&]skinColor=([^"&\s]+)/i) || '#008EFF';
  try { skin = decodeURIComponent(skin); } catch (e) { /* 保持原样 */ }
  let src = 'https://embed.voomly.com/embed/assets/embed.html'
    + `?videoId=${encodeURIComponent(id)}&videoRatio=${encodeURIComponent(ratio)}`
    + `&type=${encodeURIComponent(type)}&skinColor=${encodeURIComponent(skin)}&autoplay=1`;
  // 直播中：用全局直播时钟定位起播点（t=已播秒数），让晚进/重进的人都落在当前进度，像真直播。
  // 已结束(回放)从头看，未开播不加 t。Voomly 仅支持 t 参数（已验证）。
  if (state.room && state.room.status === 'live') {
    const t = elapsedSec();
    if (t > 0) src += '&t=' + t;
  }
  return `<iframe src="${src}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen frameborder="0" title="live"></iframe>`;
}

function injectVideo() {
  const wrap = $('#videoWrap');
  const guard = $('#videoGuard'); // 先存住拦截层：setEmbedHTML 会清空 wrap 把它一起删掉
  if (state.room.videoEmbed && state.room.videoEmbed.trim()) {
    const code = buildVoomlyIframe(state.room.videoEmbed) || state.room.videoEmbed;
    setEmbedHTML(wrap, code); // Voomly 统一转 iframe；其它平台原样注入
    if (guard) wrap.appendChild(guard); // 重新挂回拦截层，作为 wrap 末位子节点盖在视频上
    fitVideoCover();
    // 脚本型嵌入会异步插入 iframe，定时 + 监听 DOM 变化随时重新铺满
    setTimeout(fitVideoCover, 400);
    setTimeout(fitVideoCover, 1500);
    const mo = new MutationObserver(fitVideoCover);
    mo.observe(wrap, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 8000);
  } else {
    wrap.innerHTML = '<div class="video-placeholder">主播正在准备中…</div>';
  }
}

// 让视频按真实比例「覆盖式」铺满舞台：居中，超出裁掉，左右/上下都不留黑边
function fitVideoCover() {
  const stage = $('#stage');
  const el = document.querySelector('#videoWrap iframe, #videoWrap video');
  if (!stage || !el) return;
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

/* ============================ 启动互动 ============================ */
// 评论轮询（幂等：已在轮询就不重复开）
function ensurePolling() {
  if (state.pollTimer) return;
  pollComments();
  state.pollTimer = setInterval(pollComments, 3000);
}

function startLiveFeed() {
  state.entered = true;
  backfillHistory();
  ensurePolling();
  if (!state.tickTimer) state.tickTimer = setInterval(revealDuePresets, 1000);
  $('#feedHint').textContent = state.room.status === 'ended' ? '直播已结束 · 回放中' : '直播进行中';
  // 直播中：盖上透明拦截层，点画面不会暂停（像真直播）。回放(ended)不锁，方便拖进度。
  if (state.room.status !== 'ended') {
    armAntiPauseGuard();
  }
}

// 只有「用户开启了声音」之后，才盖上防暂停拦截层。
// 为什么以「开声音」为信号：手机浏览器只允许静音自动播放（铁规矩），Voomly 静音起播并显示自带的
// 「开启声音」按钮，必须用户手点才有声。拦截层会盖死整个视频（含那个开声音按钮、以及 autoplay 被
// 拦时的封面播放键），所以必须等用户完成「点开声音」这一步、确实有声了，再盖——既不挡开声音/起播，
// 又保留防暂停。信号用 Voomly 的 voomly:video:volumeChanged 事件里 muted:false（手机端只有用户
// 手动解除静音才会出现）。检测不到就永不盖，最坏只退化为「能暂停 / 静音可控」，绝不卡死、绝不哑播。
function armAntiPauseGuard() {
  let armed = false;
  function onMsg(e) {
    // 只认 voomly.com 及其子域，按域名边界匹配（防 evilvoomly.com 之类擦边）
    let host = '';
    try { host = new URL(e.origin).host; } catch (_) { return; }
    if (host !== 'voomly.com' && !host.endsWith('.voomly.com')) return;
    const d = e.data;
    if (!d || d.eventName !== 'voomly:video:volumeChanged') return;
    // muted 明确为 false = 用户开了声音，这时才上锁
    if (!armed && d.payload && d.payload.muted === false) {
      armed = true;
      window.removeEventListener('message', onMsg); // 盖一次就够，撤掉监听
      const guard = $('#videoGuard');
      if (guard) { guard.hidden = false; fitVideoCover(); }
    }
  }
  window.addEventListener('message', onMsg);
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
  if (room.status === 'pre' || !room.liveStartAt) {
    injectVideo();
    $('#feedHint').textContent = '直播即将开始，先聊几句吧';
    ensurePolling(); // 未开播也允许评论；预设不展示
    state.entered = true;
  } else if (room.status === 'ended') {
    injectVideo();
    startLiveFeed(); // 直接回放历史
  } else { // live：视频留到点「进入直播间」(用户手势) 时再注入，浏览器才允许自动播放
    showEnterMask();
  }
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

  if (room.requireAccessCode) {
    // 需要观看码：先尝试缓存的码，不行就拦门要码
    if (await tryStoredAccess()) proceed();
    else showGate();
  } else {
    proceed();
  }
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

init();
