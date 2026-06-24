'use strict';

const crypto = require('crypto');

// 首次启动写入的示例数据。改完后台配置会持久化到 data/db.json，
// 想恢复出厂只需删掉 data/db.json 重启。

function buildSeed() {
  const ROOM_ID = 'demo01'; // 默认直播间短码（链接 /r/demo01）

  // 预设互动：time 为「开播后第几秒」出现
  const presets = [
    { time: 2,   nickname: '主办方助教', avatar: '', region: '官方',   content: '欢迎大家来到直播间，记得点亮关注～', type: 'comment', enabled: true },
    { time: 5,   nickname: '阿May',     avatar: '', region: '马来西亚', content: '终于等到开课啦', type: 'join',    enabled: true },
    { time: 9,   nickname: 'Kelvin',   avatar: '', region: '新加坡',   content: '老师讲得好清楚', type: 'comment', enabled: true },
    { time: 14,  nickname: '小敏',      avatar: '', region: '广东',     content: '这个点我一直没搞懂，今天终于明白了', type: 'comment', enabled: true },
    { time: 20,  nickname: 'Jenny',    avatar: '', region: '台湾',     content: '已经在做笔记了 📝', type: 'comment', enabled: true },
    { time: 26,  nickname: '阿强',      avatar: '', region: '香港',     content: '请问后面会有回放吗？', type: 'comment', enabled: true },
    { time: 33,  nickname: 'Wendy',    avatar: '', region: '深圳',     content: '太实用了', type: 'like',    enabled: true },
    { time: 40,  nickname: 'David',    avatar: '', region: '吉隆坡',   content: '比我之前花钱买的课讲得还好', type: 'comment', enabled: true },
    { time: 48,  nickname: '小柔',      avatar: '', region: '上海',     content: '老师声音好好听', type: 'comment', enabled: true },
    { time: 58,  nickname: 'Ben',      avatar: '', region: '槟城',     content: '刚进来，错过了什么吗？', type: 'join',    enabled: true },
    { time: 70,  nickname: '芳姐',      avatar: '', region: '北京',     content: '这段我要再看一遍', type: 'comment', enabled: true },
    { time: 85,  nickname: 'Alex',     avatar: '', region: '柔佛',     content: '受教了，感谢老师 🙏', type: 'comment', enabled: true }
  ].map((p, i) => ({ id: `p_seed_${i + 1}`, roomId: ROOM_ID, ...p }));

  // 商品（课程）：price/originalPrice 为「主单位」金额（如 USD 5980），下单时 ×100 转 Stripe 最小单位
  const products = [
    {
      id: 'prod_seed_1', roomId: ROOM_ID,
      title: '【引爆女性商业影响力30天训练营】-JY',
      image: 'https://picsum.photos/seed/coursecard/240/160',
      price: 5980, originalPrice: 8800,
      desc: '30 天系统训练，从个人品牌到商业变现，手把手带你跑通私域增长。',
      enabled: true, sort: 1, createdAt: 0
    }
  ];

  // 优惠券（满减）：满 threshold 减 amount，金额单位同商品
  const coupons = [
    { id: 'coup_seed_1', roomId: ROOM_ID, title: '新人专享券', threshold: 3000, amount: 2000, enabled: true, sort: 1, expireAt: null, createdAt: 0 },
    { id: 'coup_seed_2', roomId: ROOM_ID, title: '直播间限时券', threshold: 5000, amount: 2000, enabled: true, sort: 2, expireAt: null, createdAt: 0 }
  ];

  // 定时促销弹窗：开播后第 time 秒弹出 productId 的小卡，durationSec 秒后自动收起
  const promos = [
    { id: 'promo_seed_1', roomId: ROOM_ID, time: 8, productId: 'prod_seed_1', durationSec: 20, enabled: true }
  ];

  return {
    rooms: [
      {
        id: ROOM_ID,
        name: '正心向上教育科技',
        courseTitle: '第 1 课：从 0 到 1 搭建你的私域增长系统',
        // 视频中上方的课程标题大字 banner（留空则不显示）
        bannerTitle: '资源影响力',
        bannerSubtitle: '如何链接生命中的贵人和牛人\n让贵人为你助力',
        status: 'pre', // pre | live | ended
        viewerBase: 326,
        // 竖屏视频（Voomly 嵌入）；后台「视频嵌入代码」可替换
        videoEmbed: '<iframe src="https://embed.voomly.com/embed/assets/embed.html?videoId=W0CASakDHRiGxkD5m1ATuCMjFzgDMLQWoRZHQnckuLAmV3BS1&videoRatio=0.5625&type=v&skinColor=%23008EFF" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen frameborder="0" title="live"></iframe>',
        // 视频方向：portrait(竖屏) | landscape(横屏)，前端据此切换布局
        orientation: 'portrait',
        cover: '',
        liveStartAt: null, // 后台「立即开播」时置为时间戳
        requireAccessCode: false, // 开启后，必须输入有效观看码才能进入
        // 直播间商城（购物车 + 课程弹窗 + Stripe 支付）
        shopEnabled: true,            // 显示购物车入口、启用商城
        shopName: '正心向上教育科技',  // 商品弹窗头部店铺名
        currency: 'usd',              // 收款货币（Stripe，小写）：usd/sgd/myr/twd…
        createdAt: 0
      }
    ],
    presets,
    // 商城数据（均按 roomId 隔离）
    products,
    coupons,
    promos,
    orders: [],
    comments: [],
    // 观看会话：真实用户进出直播间的记录（心跳式追踪，后台「观看记录」展示）
    viewerSessions: [],
    // 观看码：后台预先绑定昵称+地区，可设有效期（expireAt 毫秒，null=永久）
    accessCodes: [
      { id: 'ac_demo1', roomId: ROOM_ID, code: 'VIP888', nickname: '王老师', region: '吉隆坡', expireAt: null, enabled: true, note: '演示码', useCount: 0, lastUsedAt: null, createdAt: 0 },
      { id: 'ac_demo2', roomId: ROOM_ID, code: 'GOLD66', nickname: '李同学', region: '新加坡', expireAt: null, enabled: true, note: '演示码', useCount: 0, lastUsedAt: null, createdAt: 0 }
    ],
    sensitiveWords: ['加微信', '微信号', '私聊', '色情', '赌博', '诈骗', '违法', 'fuck'],
    config: {
      adminPassword: 'admin123',
      adminSecret: crypto.randomBytes(24).toString('hex'),
      rateSeconds: 5, // 同一用户两条评论最小间隔（秒）
      ratePerMin: 8   // 每分钟最多条数
    }
  };
}

module.exports = { buildSeed };
