'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

async function req(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  if (r.status === 401) { showLogin(); throw new Error('未登录'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || '请求失败');
  return data;
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2000);
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function normalizeHttpUrl(s) {
  const v = String(s == null ? '' : s).trim();
  if (!v || !/^https?:\/\//i.test(v)) return '';
  try { return new URL(v).href; } catch (e) { return ''; }
}
function checkImageLoad(url, timeoutMs) {
  return new Promise((resolve) => {
    if (!url) { resolve(true); return; }
    const img = new Image();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs || 8000);
    img.referrerPolicy = 'no-referrer';
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.src = url;
  });
}
function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ============================ 登录 + 视图切换 ============================ */
let currentRoomId = null; // 当前正在管理的直播间

function showLogin() { $('#loginMask').hidden = false; $('#app').hidden = true; }
function showApp() { $('#loginMask').hidden = true; $('#app').hidden = false; showRoomsList(); }

// 一级：直播间列表
function showRoomsList() {
  stopViewersAutoRefresh();
  currentRoomId = null;
  $('#roomsView').hidden = false;
  $('#manageView').hidden = true;
  $('#manageTabs').hidden = true;
  $('#backToListBtn').hidden = true;
  loadRooms();
}

// 二级：进入某直播间管理
function openManage(room) {
  stopViewersAutoRefresh();
  currentRoomId = room.id;
  $('#roomsView').hidden = true;
  $('#manageView').hidden = false;
  $('#manageTabs').hidden = false;
  $('#backToListBtn').hidden = false;
  $('#manageRoomName').textContent = room.name || '(未命名)';
  $('#manageRoomLink').textContent = '/r/' + room.id;
  $('#openRoomLink').href = location.origin + '/r/' + room.id;
  // 回到「直播间配置」标签
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'room'));
  $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== 'room'; });
  loadRoom();
}

$('#loginBtn').onclick = async () => {
  const password = $('#pwd').value;
  $('#loginErr').textContent = '';
  try {
    await req('POST', '/api/admin/login', { password });
    showApp();
  } catch (e) { $('#loginErr').textContent = e.message || '登录失败'; }
};
$('#pwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#loginBtn').click(); });
$('#logoutBtn').onclick = async () => { await req('POST', '/api/admin/logout'); showLogin(); };
$('#backToListBtn').onclick = () => showRoomsList();

/* ============================ 直播间列表 ============================ */
async function loadRooms() {
  const list = await req('GET', '/api/admin/rooms');
  const tbody = $('#roomRows');
  tbody.innerHTML = '';
  if (!list.length) { tbody.innerHTML = '<tr><td colspan="6" style="color:#8990a6">还没有直播间，点「+ 创建直播间」</td></tr>'; return; }
  const stTag = { pre: '<span class="tag hidden">未开播</span>', live: '<span class="tag visible">直播中</span>', ended: '<span class="tag like">已结束</span>' };
  for (const r of list) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="roomname">${esc(r.name)}</td>
      <td>${stTag[r.status] || r.status}</td>
      <td><code>/r/${r.id}</code></td>
      <td>${r.presetCount}</td>
      <td>${r.codeCount}</td>
      <td><div class="op">
        <button class="mini ok" data-manage="${r.id}">管理</button>
        <button class="mini" data-copy="${r.id}">复制链接</button>
        <button class="mini danger" data-del="${r.id}">删除</button>
      </div></td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('[data-manage]').forEach((b) => b.onclick = () => openManage(list.find((x) => x.id === b.dataset.manage)));
  tbody.querySelectorAll('[data-copy]').forEach((b) => b.onclick = () => copyLink(b.dataset.copy));
  tbody.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    const r = list.find((x) => x.id === b.dataset.del);
    if (!confirm(`删除直播间「${r.name}」？\n它的预设、评论、观看码都会一起删除，不可恢复。`)) return;
    await req('DELETE', '/api/admin/rooms/' + b.dataset.del); toast('已删除'); loadRooms();
  });
}

async function copyLink(id) {
  const link = location.origin + '/r/' + id;
  try { await navigator.clipboard.writeText(link); toast('链接已复制'); }
  catch (e) { prompt('复制下面的链接：', link); }
}

$('#createRoomBtn').onclick = () => {
  $('#cr_name').value = '';
  $('#cr_videoType').value = 'voomly';
  $('#createModal').hidden = false;
  setTimeout(() => $('#cr_name').focus(), 50);
};
$('#createCancel').onclick = () => { $('#createModal').hidden = true; };
$('#createDo').onclick = async () => {
  const name = $('#cr_name').value.trim() || '新直播间';
  const videoType = $('#cr_videoType').value;
  const room = await req('POST', '/api/admin/rooms', { name, videoType });
  $('#createModal').hidden = true;
  toast('已创建'); openManage(room);
};
$('#copyLinkBtn').onclick = () => { if (currentRoomId) copyLink(currentRoomId); };

/* ============================ Tab 切换 ============================ */
$$('.tab').forEach((tab) => {
  tab.onclick = () => {
    $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    const name = tab.dataset.tab;
    $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
    stopViewersAutoRefresh(); // 切到别的 tab 先停掉观看记录的自动刷新
    if (name === 'presets') loadPresets();
    if (name === 'comments') loadComments();
    if (name === 'room') loadRoom();
    if (name === 'codes') loadCodes();
    if (name === 'viewers') { loadViewers(); startViewersAutoRefresh(); }
    if (name === 'products') loadProducts();
    if (name === 'coupons') loadCoupons();
    if (name === 'promos') loadPromos();
    if (name === 'orders') loadOrders();
  };
});

/* ============================ 直播间配置 ============================ */
async function loadRoom() {
  const r = await req('GET', '/api/admin/rooms/' + currentRoomId);
  $('#manageRoomName').textContent = r.name || '(未命名)'; // 名字可能刚改过
  $('#r_name').value = r.name || '';
  $('#r_courseTitle').value = r.courseTitle || '';
  $('#r_bannerTitle').value = r.bannerTitle || '';
  $('#r_bannerSubtitle').value = r.bannerSubtitle || '';
  $('#r_status').value = r.status || 'pre';
  $('#r_viewerBase').value = r.viewerBase || 0;
  $('#r_cover').value = r.cover || '';
  $('#r_videoType').value = r.videoType || 'voomly';
  $('#r_videoEmbed').value = r.videoEmbed || '';
  $('#r_hlsUrl').value = r.hlsUrl || '';
  toggleVideoFields();
  $('#r_orientation').value = r.orientation || 'landscape';
  $('#r_requireAccessCode').checked = !!r.requireAccessCode;
  $('#r_shopEnabled').checked = !!r.shopEnabled;
  $('#r_shopName').value = r.shopName || '';
  $('#r_currency').value = r.currency || 'usd';
  $('#r_liveStartAt_input').value = r.liveStartAt ? toLocalInput(r.liveStartAt) : '';
  // 只读提示：区分「已开播 / 已预约（未来时间）/ 未设」
  let lbl = '未开播';
  if (r.liveStartAt) lbl = fmtTime(r.liveStartAt) + (r.liveStartAt > Date.now() ? '（已预约）' : '（已开播）');
  $('#r_liveStartAt').textContent = lbl;
}

// 按视频类型显隐对应字段（老版 Voomly 嵌入 / 新版 Cloudflare HLS 地址）
function toggleVideoFields() {
  const t = $('#r_videoType').value;
  $('#voomlyField').hidden = t !== 'voomly';
  $('#hlsField').hidden = t !== 'hls';
}
$('#r_videoType').addEventListener('change', toggleVideoFields);

// 毫秒时间戳 → datetime-local 输入框需要的本地 "YYYY-MM-DDTHH:MM"
function toLocalInput(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

$('#saveRoomBtn').onclick = async () => {
  await req('PUT', '/api/admin/rooms/' + currentRoomId, {
    name: $('#r_name').value,
    courseTitle: $('#r_courseTitle').value,
    bannerTitle: $('#r_bannerTitle').value,
    bannerSubtitle: $('#r_bannerSubtitle').value,
    status: $('#r_status').value,
    viewerBase: $('#r_viewerBase').value,
    cover: $('#r_cover').value,
    videoType: $('#r_videoType').value,
    videoEmbed: $('#r_videoEmbed').value,
    hlsUrl: $('#r_hlsUrl').value,
    orientation: $('#r_orientation').value,
    requireAccessCode: $('#r_requireAccessCode').checked,
    shopEnabled: $('#r_shopEnabled').checked,
    shopName: $('#r_shopName').value,
    currency: $('#r_currency').value,
    liveStartAt: $('#r_liveStartAt_input').value ? new Date($('#r_liveStartAt_input').value).getTime() : null
  });
  toast('配置已保存');
};

// 预约开播：把状态设为「直播中」并写入开播时间；到点前观众看倒计时，到点自动开播
$('#scheduleBtn').onclick = async () => {
  const val = $('#r_liveStartAt_input').value;
  if (!val) { toast('请先填写开播时间'); return; }
  const ts = new Date(val).getTime();
  if (ts <= Date.now() && !confirm('这个时间已经过了，确定要按它当开播基点吗？（观众会从对应进度开始）')) return;
  await req('PUT', '/api/admin/rooms/' + currentRoomId, { status: 'live', liveStartAt: ts });
  toast('已预约 ⏰');
  loadRoom();
};

$('#goLiveBtn').onclick = async () => {
  if (!confirm('立即开播？开播时间会设为现在，状态切到「直播中」。')) return;
  await req('POST', '/api/admin/rooms/' + currentRoomId + '/go-live');
  toast('已开播 🔴');
  loadRoom();
};

/* ============================ 预设互动 ============================ */
let editingPresetId = null;

async function loadPresets() {
  const list = await req('GET', '/api/admin/presets?room=' + currentRoomId);
  const tbody = $('#presetRows');
  tbody.innerHTML = '';
  if ($('#presetCheckAll')) $('#presetCheckAll').checked = false; // 重新加载后清空全选
  if (!list.length) { tbody.innerHTML = '<tr><td colspan="8" style="color:#8990a6">暂无预设，点「新增」或「导入」</td></tr>'; return; }
  for (const p of list) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" class="pchk" data-id="${p.id}"></td>
      <td>${p.time}</td>
      <td>${esc(p.nickname)}</td>
      <td>${esc(p.region)}</td>
      <td><div class="cell-content">${esc(p.content)}</div></td>
      <td><span class="tag ${p.type}">${({ comment: '评论', join: '进入', like: '点赞' })[p.type] || p.type}</span></td>
      <td><span class="switch tag ${p.enabled ? 'visible' : 'hidden'}" data-id="${p.id}">${p.enabled ? '启用' : '停用'}</span></td>
      <td><div class="op">
        <button class="mini" data-edit="${p.id}">编辑</button>
        <button class="mini danger" data-del="${p.id}">删除</button>
      </div></td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openPresetModal(list.find((x) => x.id === b.dataset.edit)));
  tbody.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('删除这条预设？')) return;
    await req('DELETE', '/api/admin/presets/' + b.dataset.del); toast('已删除'); loadPresets();
  });
  tbody.querySelectorAll('.switch').forEach((s) => s.onclick = async () => {
    const p = list.find((x) => x.id === s.dataset.id);
    await req('PUT', '/api/admin/presets/' + p.id, { enabled: !p.enabled }); loadPresets();
  });
}

// 全选 / 批量删除 / 清空全部（按钮与表头复选框在静态 DOM 里，启动时绑定一次即可）
$('#presetCheckAll').onclick = (e) => {
  document.querySelectorAll('#presetRows .pchk').forEach((c) => { c.checked = e.target.checked; });
};
$('#batchDelBtn').onclick = async () => {
  const ids = Array.from(document.querySelectorAll('#presetRows .pchk:checked')).map((c) => c.dataset.id);
  if (!ids.length) { toast('请先勾选要删除的预设'); return; }
  if (!confirm(`确定删除选中的 ${ids.length} 条预设？不可恢复。`)) return;
  const res = await req('POST', '/api/admin/presets/batch-delete', { roomId: currentRoomId, ids });
  toast(`已删除 ${res.removed} 条`); loadPresets();
};
$('#clearPresetsBtn').onclick = async () => {
  if (!confirm('确定清空本房间的全部预设？不可恢复。')) return;
  const res = await req('POST', '/api/admin/presets/import', { roomId: currentRoomId, items: [], mode: 'replace' });
  toast('已清空'); loadPresets();
};

function openPresetModal(p) {
  editingPresetId = p ? p.id : null;
  $('#presetModalTitle').textContent = p ? '编辑预设互动' : '新增预设互动';
  $('#p_time').value = p ? p.time : 0;
  $('#p_type').value = p ? p.type : 'comment';
  $('#p_nickname').value = p ? p.nickname : '';
  $('#p_region').value = p ? p.region : '';
  $('#p_avatar').value = p ? p.avatar : '';
  $('#p_content').value = p ? p.content : '';
  $('#p_enabled').checked = p ? p.enabled : true;
  $('#presetModal').hidden = false;
}
$('#addPresetBtn').onclick = () => openPresetModal(null);
$('#presetCancel').onclick = () => { $('#presetModal').hidden = true; };
$('#presetSave').onclick = async () => {
  const body = {
    time: $('#p_time').value, type: $('#p_type').value,
    nickname: $('#p_nickname').value, region: $('#p_region').value,
    avatar: $('#p_avatar').value, content: $('#p_content').value,
    enabled: $('#p_enabled').checked
  };
  if (!body.nickname.trim()) { toast('请填写昵称'); return; }
  if (editingPresetId) await req('PUT', '/api/admin/presets/' + editingPresetId, body);
  else await req('POST', '/api/admin/presets', { ...body, roomId: currentRoomId });
  $('#presetModal').hidden = true; toast('已保存'); loadPresets();
};

/* 导出 / 导入 */
$('#exportBtn').onclick = () => { window.location.href = '/api/admin/presets/export?room=' + currentRoomId; };
$('#importBtn').onclick = () => { $('#importText').value = ''; $('#importReplace').checked = false; $('#importModal').hidden = false; };
$('#importCancel').onclick = () => { $('#importModal').hidden = true; };
$('#importDo').onclick = async () => {
  let items;
  try { items = JSON.parse($('#importText').value); }
  catch (e) { toast('JSON 格式错误'); return; }
  if (!Array.isArray(items)) { toast('应为 JSON 数组'); return; }
  const res = await req('POST', '/api/admin/presets/import', { items, mode: $('#importReplace').checked ? 'replace' : 'append', roomId: currentRoomId });
  $('#importModal').hidden = true; toast(`导入成功，新增 ${res.added} 条`); loadPresets();
};

/* ============================ 用户评论 ============================ */
async function loadComments() {
  const list = await req('GET', '/api/admin/comments?room=' + currentRoomId);
  const tbody = $('#commentRows');
  tbody.innerHTML = '';
  if (!list.length) { tbody.innerHTML = '<tr><td colspan="6" style="color:#8990a6">暂无用户评论</td></tr>'; return; }
  for (const c of list) {
    const tr = document.createElement('tr');
    const hitMark = c.sensitiveHit ? ' <span class="tag like">含敏感词</span>' : '';
    tr.innerHTML = `
      <td style="white-space:nowrap">${fmtTime(c.createdAt)}</td>
      <td>${esc(c.nickname)}</td>
      <td>${esc(c.region)}</td>
      <td><div class="cell-content">${esc(c.content)}${hitMark}</div></td>
      <td><span class="tag ${c.status}">${c.status === 'visible' ? '显示中' : '已隐藏'}</span></td>
      <td><div class="op">
        ${c.status === 'visible'
          ? `<button class="mini" data-hide="${c.id}">隐藏</button>`
          : `<button class="mini ok" data-show="${c.id}">通过</button>`}
        <button class="mini ok" data-topreset="${c.id}">加入预设</button>
        <button class="mini danger" data-del="${c.id}">删除</button>
      </div></td>`;
    tbody.appendChild(tr);
  }
  const reload = () => loadComments();
  tbody.querySelectorAll('[data-hide]').forEach((b) => b.onclick = async () => { await req('PUT', '/api/admin/comments/' + b.dataset.hide, { status: 'hidden' }); reload(); });
  tbody.querySelectorAll('[data-show]').forEach((b) => b.onclick = async () => { await req('PUT', '/api/admin/comments/' + b.dataset.show, { status: 'visible' }); reload(); });
  tbody.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { if (confirm('删除这条评论？')) { await req('DELETE', '/api/admin/comments/' + b.dataset.del); reload(); } });
  tbody.querySelectorAll('[data-topreset]').forEach((b) => b.onclick = async () => {
    const t = prompt('设为开播后第几秒出现？', '0');
    if (t === null) return;
    await req('POST', '/api/admin/comments/' + b.dataset.topreset + '/to-preset', { time: parseInt(t, 10) || 0 });
    toast('已加入预设互动库');
  });
}

/* ============================ 观看记录 ============================ */
let viewersTimer = null;

// 秒 → "Xs / Xm Ys / Xh Ym" 紧凑时长
function fmtDuration(sec) {
  sec = Math.max(0, sec | 0);
  const h = Math.floor(sec / 3600); sec -= h * 3600;
  const m = Math.floor(sec / 60); const s = sec - m * 60;
  const p = (n) => String(n).padStart(2, '0');
  if (h) return `${h}:${p(m)}:${p(s)}`;
  if (m) return `${m}分${p(s)}秒`;
  return `${s}秒`;
}

async function loadViewers() {
  const data = await req('GET', '/api/admin/sessions?room=' + currentRoomId);
  $('#onlineBadge').textContent = '在线 ' + data.onlineCount;
  const tbody = $('#viewerRows');
  tbody.innerHTML = '';
  if (!data.sessions.length) { tbody.innerHTML = '<tr><td colspan="6" style="color:#8990a6">暂无观看记录</td></tr>'; return; }
  for (const s of data.sessions) {
    const tr = document.createElement('tr');
    const st = s.online
      ? '<span class="tag visible">● 在线中</span>'
      : '<span class="tag hidden">已离开</span>';
    const nick = s.nickname ? esc(s.nickname) : '<span style="color:#8990a6">(未填昵称)</span>';
    tr.innerHTML = `
      <td>${st}</td>
      <td>${nick}</td>
      <td>${esc(s.region)}</td>
      <td style="white-space:nowrap">${fmtTime(s.enteredAt)}</td>
      <td style="white-space:nowrap">${s.online ? '—' : fmtTime(s.exitAt)}</td>
      <td style="white-space:nowrap">${fmtDuration(s.durationSec)}</td>`;
    tbody.appendChild(tr);
  }
}

// 自动刷新：仅当「观看记录」面板可见时跑，离开即自动停
function startViewersAutoRefresh() {
  stopViewersAutoRefresh();
  viewersTimer = setInterval(() => {
    const panel = document.querySelector('[data-panel="viewers"]');
    if (panel && !panel.hidden && currentRoomId) loadViewers().catch(() => {});
    else stopViewersAutoRefresh();
  }, 10000);
}
function stopViewersAutoRefresh() { if (viewersTimer) { clearInterval(viewersTimer); viewersTimer = null; } }

$('#refreshViewersBtn').onclick = () => loadViewers();
$('#clearViewersBtn').onclick = async () => {
  if (!confirm('确定清空本房间的全部观看记录？不可恢复。')) return;
  const res = await req('POST', '/api/admin/sessions/clear', { roomId: currentRoomId });
  toast(`已清空 ${res.removed} 条`); loadViewers();
};

/* ============================ 观看码 ============================ */
let editingCodeId = null;

async function loadCodes() {
  const list = await req('GET', '/api/admin/codes?room=' + currentRoomId);
  const tbody = $('#codeRows');
  tbody.innerHTML = '';
  if (!list.length) { tbody.innerHTML = '<tr><td colspan="7" style="color:#8990a6">暂无观看码，点「新增」或「导入」</td></tr>'; return; }
  const statusTag = { active: '<span class="tag visible">有效</span>', disabled: '<span class="tag hidden">已停用</span>', expired: '<span class="tag like">已过期</span>' };
  for (const c of list) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><b>${esc(c.code)}</b></td>
      <td>${esc(c.nickname)}</td>
      <td>${esc(c.region)}</td>
      <td style="white-space:nowrap">${c.expireAt ? fmtTime(c.expireAt) : '永久'}</td>
      <td>${statusTag[c._status] || c._status}</td>
      <td>${c.useCount || 0}</td>
      <td><div class="op">
        <button class="mini" data-edit="${c.id}">编辑</button>
        <button class="mini danger" data-del="${c.id}">删除</button>
      </div></td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openCodeModal(list.find((x) => x.id === b.dataset.edit)));
  tbody.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('删除这个观看码？删除后用它进不来。')) return;
    await req('DELETE', '/api/admin/codes/' + b.dataset.del); toast('已删除'); loadCodes();
  });
}

function openCodeModal(c) {
  editingCodeId = c ? c.id : null;
  $('#codeModalTitle').textContent = c ? '编辑观看码' : '新增观看码';
  $('#c_code').value = c ? c.code : '';
  $('#c_nickname').value = c ? c.nickname : '';
  $('#c_region').value = c ? c.region : '';
  $('#c_expireAt').value = c && c.expireAt ? toLocalInput(c.expireAt) : '';
  $('#c_note').value = c ? (c.note || '') : '';
  $('#c_enabled').checked = c ? c.enabled : true;
  $('#codeModal').hidden = false;
}
$('#addCodeBtn').onclick = () => openCodeModal(null);
$('#codeCancel').onclick = () => { $('#codeModal').hidden = true; };
$('#codeSave').onclick = async () => {
  const body = {
    code: $('#c_code').value.trim(),
    nickname: $('#c_nickname').value.trim(),
    region: $('#c_region').value.trim(),
    expireAt: $('#c_expireAt').value ? new Date($('#c_expireAt').value).getTime() : null,
    note: $('#c_note').value.trim(),
    enabled: $('#c_enabled').checked
  };
  if (!body.nickname) { toast('请填写绑定的昵称'); return; }
  if (editingCodeId) await req('PUT', '/api/admin/codes/' + editingCodeId, body);
  else await req('POST', '/api/admin/codes', { ...body, roomId: currentRoomId });
  $('#codeModal').hidden = true; toast('已保存'); loadCodes();
};

$('#exportCodesBtn').onclick = () => { window.location.href = '/api/admin/codes/export?room=' + currentRoomId; };
$('#importCodesBtn').onclick = () => { $('#codeImportText').value = ''; $('#codeImportReplace').checked = false; $('#codeImportModal').hidden = false; };
$('#codeImportCancel').onclick = () => { $('#codeImportModal').hidden = true; };
$('#codeImportDo').onclick = async () => {
  let items;
  try { items = JSON.parse($('#codeImportText').value); } catch (e) { toast('JSON 格式错误'); return; }
  if (!Array.isArray(items)) { toast('应为 JSON 数组'); return; }
  const res = await req('POST', '/api/admin/codes/import', { items, mode: $('#codeImportReplace').checked ? 'replace' : 'append', roomId: currentRoomId });
  $('#codeImportModal').hidden = true; toast(`导入成功，新增 ${res.added} 条`); loadCodes();
};

/* ============================ 商品 ============================ */
let editingProductId = null;
let roomCurrency = 'usd'; // 当前房间货币（loadRoom 时更新，用于展示）
const CUR_SYM = { usd: 'US$', sgd: 'S$', myr: 'RM', hkd: 'HK$', aud: 'A$', eur: '€', gbp: '£', cny: '¥' };
function money(n) { return (CUR_SYM[roomCurrency] || (roomCurrency.toUpperCase() + ' ')) + (Number(n) || 0); }

function productImageCell(url) {
  const clean = normalizeHttpUrl(url);
  if (!clean) return '<span class="product-img-empty">无图</span>';
  return `<img class="product-img-thumb" data-product-img src="${esc(clean)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
}

function bindProductImageFallback(root) {
  root.querySelectorAll('[data-product-img]').forEach((img) => {
    img.onerror = () => {
      const fb = document.createElement('span');
      fb.className = 'product-img-broken';
      fb.textContent = '加载失败';
      img.replaceWith(fb);
    };
    if (img.complete && img.naturalWidth === 0) img.onerror();
  });
}

function ensureProductImagePreview() {
  if ($('#pr_imagePreview')) return;
  const box = document.createElement('div');
  box.id = 'pr_imagePreview';
  box.className = 'image-preview';
  box.hidden = true;
  $('#pr_image').insertAdjacentElement('afterend', box);
  $('#pr_image').addEventListener('input', updateProductImagePreview);
}

function updateProductImagePreview() {
  const box = $('#pr_imagePreview');
  if (!box) return;
  const raw = $('#pr_image').value.trim();
  const clean = normalizeHttpUrl(raw);
  box.innerHTML = '';
  if (!raw) { box.hidden = true; return; }
  box.hidden = false;
  if (!clean) {
    box.className = 'image-preview invalid';
    box.textContent = '图片链接需要以 http:// 或 https:// 开头';
    return;
  }
  box.className = 'image-preview checking';
  box.textContent = '正在检查图片...';
  const img = new Image();
  img.referrerPolicy = 'no-referrer';
  img.onload = () => {
    if ($('#pr_image').value.trim() !== raw) return;
    box.className = 'image-preview ok';
    box.innerHTML = '';
    img.alt = '';
    box.appendChild(img);
    const txt = document.createElement('span');
    txt.textContent = '图片可以加载';
    box.appendChild(txt);
  };
  img.onerror = () => {
    if ($('#pr_image').value.trim() !== raw) return;
    box.className = 'image-preview invalid';
    box.textContent = '图片无法加载，请换一个能直接打开的图片链接';
  };
  img.src = clean;
}

async function loadProducts() {
  roomCurrency = $('#r_currency').value || 'usd';
  const list = await req('GET', '/api/admin/products?room=' + currentRoomId);
  const tbody = $('#productRows');
  tbody.innerHTML = '';
  if (!list.length) { tbody.innerHTML = '<tr><td colspan="7" style="color:#8990a6">暂无商品，点「新增商品」</td></tr>'; return; }
  for (const p of list) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${productImageCell(p.image)}</td>
      <td><div class="cell-content">${esc(p.title)}</div></td>
      <td>${esc(money(p.price))}</td>
      <td>${p.originalPrice ? esc(money(p.originalPrice)) : '—'}</td>
      <td>${p.sort || 0}</td>
      <td><span class="switch tag ${p.enabled ? 'visible' : 'hidden'}" data-id="${p.id}">${p.enabled ? '启用' : '停用'}</span></td>
      <td><div class="op">
        <button class="mini" data-edit="${p.id}">编辑</button>
        <button class="mini danger" data-del="${p.id}">删除</button>
      </div></td>`;
    tbody.appendChild(tr);
  }
  bindProductImageFallback(tbody);
  tbody.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openProductModal(list.find((x) => x.id === b.dataset.edit)));
  tbody.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('删除这个商品？')) return;
    await req('DELETE', '/api/admin/products/' + b.dataset.del); toast('已删除'); loadProducts();
  });
  tbody.querySelectorAll('.switch').forEach((s) => s.onclick = async () => {
    const p = list.find((x) => x.id === s.dataset.id);
    await req('PUT', '/api/admin/products/' + p.id, { enabled: !p.enabled }); loadProducts();
  });
}

function openProductModal(p) {
  ensureProductImagePreview();
  editingProductId = p ? p.id : null;
  $('#productModalTitle').textContent = p ? '编辑商品' : '新增商品';
  $('#pr_title').value = p ? p.title : '';
  $('#pr_image').value = p ? p.image : '';
  $('#pr_payUrl').value = p ? (p.payUrl || '') : '';
  $('#pr_price').value = p ? p.price : '';
  $('#pr_originalPrice').value = p ? (p.originalPrice || '') : '';
  $('#pr_desc').value = p ? (p.desc || '') : '';
  $('#pr_sort').value = p ? (p.sort || 0) : 0;
  $('#pr_enabled').checked = p ? p.enabled : true;
  $('#productModal').hidden = false;
  updateProductImagePreview();
}
$('#addProductBtn').onclick = () => openProductModal(null);
$('#productCancel').onclick = () => { $('#productModal').hidden = true; };
$('#productSave').onclick = async () => {
  const rawImage = $('#pr_image').value.trim();
  const image = normalizeHttpUrl(rawImage);
  if (rawImage && !image) { toast('图片链接需要以 http:// 或 https:// 开头'); return; }
  if (image && !(await checkImageLoad(image))) {
    toast('图片无法加载，请换一个能直接打开的图片链接');
    updateProductImagePreview();
    return;
  }
  const body = {
    title: $('#pr_title').value.trim(), image,
    payUrl: $('#pr_payUrl').value.trim(),
    price: $('#pr_price').value, originalPrice: $('#pr_originalPrice').value,
    desc: $('#pr_desc').value, sort: $('#pr_sort').value, enabled: $('#pr_enabled').checked
  };
  if (!body.title) { toast('请填写标题'); return; }
  if (editingProductId) await req('PUT', '/api/admin/products/' + editingProductId, body);
  else await req('POST', '/api/admin/products', { ...body, roomId: currentRoomId });
  $('#productModal').hidden = true; toast('已保存'); loadProducts();
};

/* ============================ 优惠券 ============================ */
let editingCouponId = null;

async function loadCoupons() {
  roomCurrency = $('#r_currency').value || 'usd';
  const list = await req('GET', '/api/admin/coupons?room=' + currentRoomId);
  const tbody = $('#couponRows');
  tbody.innerHTML = '';
  if (!list.length) { tbody.innerHTML = '<tr><td colspan="7" style="color:#8990a6">暂无优惠券，点「新增优惠券」</td></tr>'; return; }
  for (const c of list) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(c.title)}</td>
      <td>${esc(money(c.threshold))}</td>
      <td>${esc(money(c.amount))}</td>
      <td style="white-space:nowrap">${c.expireAt ? fmtTime(c.expireAt) : '长期'}</td>
      <td>${c.sort || 0}</td>
      <td><span class="switch tag ${c.enabled ? 'visible' : 'hidden'}" data-id="${c.id}">${c.enabled ? '启用' : '停用'}</span></td>
      <td><div class="op">
        <button class="mini" data-edit="${c.id}">编辑</button>
        <button class="mini danger" data-del="${c.id}">删除</button>
      </div></td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openCouponModal(list.find((x) => x.id === b.dataset.edit)));
  tbody.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('删除这个优惠券？')) return;
    await req('DELETE', '/api/admin/coupons/' + b.dataset.del); toast('已删除'); loadCoupons();
  });
  tbody.querySelectorAll('.switch').forEach((s) => s.onclick = async () => {
    const c = list.find((x) => x.id === s.dataset.id);
    await req('PUT', '/api/admin/coupons/' + c.id, { enabled: !c.enabled }); loadCoupons();
  });
}

function openCouponModal(c) {
  editingCouponId = c ? c.id : null;
  $('#couponModalTitle').textContent = c ? '编辑优惠券' : '新增优惠券';
  $('#cp_title').value = c ? c.title : '';
  $('#cp_threshold').value = c ? c.threshold : '';
  $('#cp_amount').value = c ? c.amount : '';
  $('#cp_expireAt').value = c && c.expireAt ? toLocalInput(c.expireAt) : '';
  $('#cp_sort').value = c ? (c.sort || 0) : 0;
  $('#cp_enabled').checked = c ? c.enabled : true;
  $('#couponModal').hidden = false;
}
$('#addCouponBtn').onclick = () => openCouponModal(null);
$('#couponCancel').onclick = () => { $('#couponModal').hidden = true; };
$('#couponSave').onclick = async () => {
  const body = {
    title: $('#cp_title').value.trim(),
    threshold: $('#cp_threshold').value, amount: $('#cp_amount').value,
    expireAt: $('#cp_expireAt').value ? new Date($('#cp_expireAt').value).getTime() : null,
    sort: $('#cp_sort').value, enabled: $('#cp_enabled').checked
  };
  if (!body.title) { toast('请填写名称'); return; }
  if (editingCouponId) await req('PUT', '/api/admin/coupons/' + editingCouponId, body);
  else await req('POST', '/api/admin/coupons', { ...body, roomId: currentRoomId });
  $('#couponModal').hidden = true; toast('已保存'); loadCoupons();
};

/* ============================ 促销弹窗 ============================ */
let editingPromoId = null;
let promoProductsCache = [];

async function loadPromos() {
  const [list, products] = await Promise.all([
    req('GET', '/api/admin/promos?room=' + currentRoomId),
    req('GET', '/api/admin/products?room=' + currentRoomId)
  ]);
  promoProductsCache = products;
  const pmap = {}; products.forEach((p) => { pmap[p.id] = p.title; });
  const tbody = $('#promoRows');
  tbody.innerHTML = '';
  if (!list.length) { tbody.innerHTML = '<tr><td colspan="5" style="color:#8990a6">暂无促销弹窗，点「新增弹窗」</td></tr>'; return; }
  for (const p of list) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.time}</td>
      <td><div class="cell-content">${esc(pmap[p.productId] || '(商品已删除)')}</div></td>
      <td>${p.durationSec}</td>
      <td><span class="switch tag ${p.enabled ? 'visible' : 'hidden'}" data-id="${p.id}">${p.enabled ? '启用' : '停用'}</span></td>
      <td><div class="op">
        <button class="mini" data-edit="${p.id}">编辑</button>
        <button class="mini danger" data-del="${p.id}">删除</button>
      </div></td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openPromoModal(list.find((x) => x.id === b.dataset.edit)));
  tbody.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('删除这条促销弹窗？')) return;
    await req('DELETE', '/api/admin/promos/' + b.dataset.del); toast('已删除'); loadPromos();
  });
  tbody.querySelectorAll('.switch').forEach((s) => s.onclick = async () => {
    const p = list.find((x) => x.id === s.dataset.id);
    await req('PUT', '/api/admin/promos/' + p.id, { enabled: !p.enabled }); loadPromos();
  });
  // 手动推送：填商品下拉 + 回显当前推送状态
  const lpSel = $('#lp_productId');
  const enabledProducts = promoProductsCache.filter((pr) => pr.enabled);
  lpSel.innerHTML = enabledProducts.map((pr) => `<option value="${esc(pr.id)}">${esc(pr.title)}</option>`).join('')
    || '<option value="">（请先在「商品」里新增并启用商品）</option>';
  refreshLiveStatus();
}

async function refreshLiveStatus() {
  try {
    const { productId } = await req('GET', '/api/admin/promos/live?room=' + currentRoomId);
    const cur = productId ? promoProductsCache.find((p) => p.id === productId) : null;
    const el = $('#lpStatus');
    if (cur) { el.textContent = '正在推送：' + cur.title; el.classList.add('on'); }
    else { el.textContent = '未推送'; el.classList.remove('on'); }
  } catch (e) { /* 忽略 */ }
}
$('#lpPushBtn').onclick = async () => {
  const productId = $('#lp_productId').value;
  if (!productId) { toast('请先选择商品'); return; }
  await req('POST', '/api/admin/promos/live', { roomId: currentRoomId, productId });
  toast('已推送到直播间'); refreshLiveStatus();
};
$('#lpClearBtn').onclick = async () => {
  await req('POST', '/api/admin/promos/live/clear', { roomId: currentRoomId });
  toast('已收起'); refreshLiveStatus();
};

function openPromoModal(p) {
  editingPromoId = p ? p.id : null;
  $('#promoModalTitle').textContent = p ? '编辑促销弹窗' : '新增促销弹窗';
  const sel = $('#pm_productId');
  if (!promoProductsCache.length) { toast('请先在「商品」里新增商品'); }
  sel.innerHTML = promoProductsCache.map((pr) => `<option value="${esc(pr.id)}">${esc(pr.title)}</option>`).join('');
  $('#pm_productId').value = p ? p.productId : (promoProductsCache[0] && promoProductsCache[0].id) || '';
  $('#pm_time').value = p ? p.time : 0;
  $('#pm_durationSec').value = p ? p.durationSec : 20;
  $('#pm_enabled').checked = p ? p.enabled : true;
  $('#promoModal').hidden = false;
}
$('#addPromoBtn').onclick = () => openPromoModal(null);
$('#promoCancel').onclick = () => { $('#promoModal').hidden = true; };
$('#promoSave').onclick = async () => {
  const body = {
    productId: $('#pm_productId').value,
    time: $('#pm_time').value, durationSec: $('#pm_durationSec').value,
    enabled: $('#pm_enabled').checked
  };
  if (!body.productId) { toast('请选择关联商品'); return; }
  if (editingPromoId) await req('PUT', '/api/admin/promos/' + editingPromoId, body);
  else await req('POST', '/api/admin/promos', { ...body, roomId: currentRoomId });
  $('#promoModal').hidden = true; toast('已保存'); loadPromos();
};

/* ============================ 订单 ============================ */
async function loadOrders() {
  roomCurrency = $('#r_currency').value || 'usd';
  const list = await req('GET', '/api/admin/orders?room=' + currentRoomId);
  const tbody = $('#orderRows');
  tbody.innerHTML = '';
  if (!list.length) { tbody.innerHTML = '<tr><td colspan="7" style="color:#8990a6">暂无订单</td></tr>'; return; }
  const STATUS = { paid: '<span class="tag visible">已支付</span>', pending: '<span class="tag like">待支付</span>', failed: '<span class="tag hidden">失败</span>' };
  for (const o of list) {
    const tr = document.createElement('tr');
    const cur = (CUR_SYM[o.currency] || (String(o.currency).toUpperCase() + ' '));
    tr.innerHTML = `
      <td style="white-space:nowrap">${fmtTime(o.createdAt)}</td>
      <td><div class="cell-content">${esc(o.productTitle)}</div></td>
      <td>${esc(cur + o.amount)}</td>
      <td>${o.discount ? esc('-' + cur + o.discount) : '—'}</td>
      <td>${esc((o.buyer && o.buyer.nickname) || '—')}${o.buyer && o.buyer.region ? ' <span class="tag">' + esc(o.buyer.region) + '</span>' : ''}</td>
      <td>${esc((o.buyer && o.buyer.email) || '—')}</td>
      <td>${STATUS[o.status] || o.status}</td>`;
    tbody.appendChild(tr);
  }
}
$('#refreshOrdersBtn').onclick = () => loadOrders();

/* ============================ 启动 ============================ */
(async function boot() {
  try {
    const me = await req('GET', '/api/admin/me');
    if (me.loggedIn) showApp(); else showLogin();
  } catch (e) { showLogin(); }
})();
