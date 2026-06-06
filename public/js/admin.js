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
  currentRoomId = null;
  $('#roomsView').hidden = false;
  $('#manageView').hidden = true;
  $('#manageTabs').hidden = true;
  $('#backToListBtn').hidden = true;
  loadRooms();
}

// 二级：进入某直播间管理
function openManage(room) {
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

$('#createRoomBtn').onclick = async () => {
  const name = prompt('给新直播间起个名字：', '新直播间');
  if (name === null) return;
  const room = await req('POST', '/api/admin/rooms', { name: name || '新直播间' });
  toast('已创建'); openManage(room);
};
$('#copyLinkBtn').onclick = () => { if (currentRoomId) copyLink(currentRoomId); };

/* ============================ Tab 切换 ============================ */
$$('.tab').forEach((tab) => {
  tab.onclick = () => {
    $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    const name = tab.dataset.tab;
    $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
    if (name === 'presets') loadPresets();
    if (name === 'comments') loadComments();
    if (name === 'room') loadRoom();
    if (name === 'codes') loadCodes();
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
  $('#r_videoEmbed').value = r.videoEmbed || '';
  $('#r_orientation').value = r.orientation || 'landscape';
  $('#r_requireAccessCode').checked = !!r.requireAccessCode;
  $('#r_liveStartAt').textContent = r.liveStartAt ? fmtTime(r.liveStartAt) + '（已开播）' : '未开播';
}

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
    videoEmbed: $('#r_videoEmbed').value,
    orientation: $('#r_orientation').value,
    requireAccessCode: $('#r_requireAccessCode').checked
  });
  toast('配置已保存');
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
  if (!list.length) { tbody.innerHTML = '<tr><td colspan="7" style="color:#8990a6">暂无预设，点「新增」或「导入」</td></tr>'; return; }
  for (const p of list) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
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

/* ============================ 启动 ============================ */
(async function boot() {
  try {
    const me = await req('GET', '/api/admin/me');
    if (me.loggedIn) showApp(); else showLogin();
  } catch (e) { showLogin(); }
})();
