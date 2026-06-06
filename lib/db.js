'use strict';

// 极简 JSON 文件存储：整库读进内存，写时整体落盘（同步）。
// MVP 量级足够；如需高并发再换 SQLite。

const fs = require('fs');
const path = require('path');

// 数据目录：生产环境用 DATA_DIR 环境变量指向「持久磁盘」，避免重启/重新部署后数据被清空
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

let cache = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 老库升级：补齐新版本新增的字段，保留用户已有配置（视频、预设、评论等）
function migrate(data) {
  const seed = require('./seed').buildSeed();
  let changed = false;

  // 单直播间 → 多直播间：把旧的 data.room 包成 rooms[]，并给已有数据打上 roomId
  if (data.room && !data.rooms) {
    const roomId = 'room' + Math.random().toString(36).slice(2, 8);
    data.rooms = [{ id: roomId, requireAccessCode: false, createdAt: 0, ...data.room }];
    for (const arr of ['presets', 'comments', 'accessCodes']) {
      if (Array.isArray(data[arr])) data[arr].forEach((x) => { if (!x.roomId) x.roomId = roomId; });
    }
    delete data.room;
    changed = true;
  }

  for (const k of Object.keys(seed)) {
    if (!(k in data)) { data[k] = seed[k]; changed = true; }
  }
  return changed;
}

function load() {
  if (cache) return cache;
  ensureDir();
  if (fs.existsSync(DB_FILE)) {
    cache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (migrate(cache)) save(); // 补齐缺失字段并落盘
  } else {
    cache = require('./seed').buildSeed();
    save();
  }
  return cache;
}

function save() {
  ensureDir();
  // 先写临时文件再 rename，避免写一半崩溃损坏数据
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

// 取整库（引用，改完记得 save()）
function db() {
  return load();
}

// 生成短 id（无需第三方依赖）
let counter = 0;
function genId(prefix) {
  counter = (counter + 1) % 1e6;
  return `${prefix || 'id'}_${Date.now().toString(36)}${counter.toString(36)}`;
}

module.exports = { db, save, genId, DB_FILE };
