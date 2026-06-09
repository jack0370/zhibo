// 把本地 data/db.json 里的直播间(含预设、观看码)上传到线上。
// 用法： node scripts/push-to-prod.mjs <后台密码> [只同步的房间id]
//   - 不带房间id：同步本地全部房间
//   - 带房间id（如 3ms7ae）：只同步该房间，避免重复上传已在线上的老房间
// 说明：迁移 房间配置(含视频类型/Voomly嵌入/HLS地址) + 预设 + 观看码，不迁移测试评论；
//      状态统一设为「未开播」，上线后在后台点「立即开播」即可。脚本是「新建」房间，不覆盖线上已有。
import fs from 'fs';

const BASE = process.env.PROD_URL || 'https://zhibo-live.onrender.com';
const PASS = process.argv[2] || process.env.ADMIN_PASSWORD;
const ONLY = process.argv[3] || process.env.ONLY_ROOM; // 可选：只同步这个房间id
if (!PASS) { console.error('用法: node scripts/push-to-prod.mjs <后台密码> [只同步的房间id]'); process.exit(1); }

const db = JSON.parse(fs.readFileSync(new URL('../data/db.json', import.meta.url), 'utf8'));
const rooms = ONLY ? db.rooms.filter((r) => r.id === ONLY) : db.rooms;
if (ONLY && !rooms.length) { console.error('本地找不到房间:', ONLY); process.exit(1); }

let cookie = '';
async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch (e) { data = text; }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${(data && data.error) || text}`);
  return data;
}

await api('POST', '/api/admin/login', { password: PASS });
console.log('✓ 登录线上后台成功');

for (const room of rooms) {
  const created = await api('POST', '/api/admin/rooms', { name: room.name, videoType: room.videoType });
  const id = created.id;
  await api('PUT', '/api/admin/rooms/' + id, {
    name: room.name, courseTitle: room.courseTitle,
    bannerTitle: room.bannerTitle, bannerSubtitle: room.bannerSubtitle,
    status: 'pre', viewerBase: room.viewerBase,
    videoType: room.videoType || 'voomly',
    videoEmbed: room.videoEmbed, hlsUrl: room.hlsUrl || '',
    orientation: room.orientation,
    cover: room.cover, requireAccessCode: room.requireAccessCode
  });

  const presets = db.presets.filter((p) => p.roomId === room.id)
    .map(({ time, nickname, avatar, region, content, type, enabled }) =>
      ({ time, nickname, avatar, region, content, type, enabled }));
  if (presets.length) await api('POST', '/api/admin/presets/import', { roomId: id, items: presets, mode: 'replace' });

  const codes = db.accessCodes.filter((c) => c.roomId === room.id)
    .map(({ code, nickname, region, expireAt, enabled, note }) =>
      ({ code, nickname, region, expireAt, enabled, note }));
  if (codes.length) await api('POST', '/api/admin/codes/import', { roomId: id, items: codes, mode: 'replace' });

  console.log(`✓ 已上传「${room.name}」`);
  console.log(`   链接: ${BASE}/r/${id}   (预设 ${presets.length} 条, 观看码 ${codes.length} 个)`);
}
console.log('全部完成。线上后台刷新即可看到，记得到对应直播间点「立即开播」。');
