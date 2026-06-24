# 部署指南（一键平台 + 自有域名 + HTTPS）

本应用是单进程 Node 服务，数据存文件（`db.json`）。部署到一键平台时**最关键的一点**：
平台磁盘大多是临时的，重启/重新部署会清空 —— 所以**必须挂一块持久磁盘**，并让程序写到上面，否则你配置的直播间、观看码、评论会丢。

代码已做好生产适配：
- `DATA_DIR` 环境变量 → 把数据写到持久磁盘
- `ADMIN_PASSWORD` 环境变量 → 后台密码（不写死在代码里）
- `PORT` 环境变量 → 平台自动注入
- HTTPS 下自动启用安全 cookie + 信任反向代理

---

## 第 0 步：把代码推到 GitHub（两个平台都需要）

```bash
cd E:\cursor\zhibo
git init
git add .
git commit -m "私域直播间 MVP"
# 在 GitHub 新建一个空仓库后：
git remote add origin https://github.com/你的用户名/zhibo.git
git branch -M main
git push -u origin main
```

> `data/db.json` 和 `node_modules` 已在 `.gitignore` 里，不会被上传（数据和密码不进仓库，安全）。

---

## 方案 A：Render（推荐，有现成蓝图 render.yaml）

### 1. 创建服务
- 登录 https://render.com → New → **Blueprint** → 连接你的 GitHub 仓库
- Render 会读取仓库里的 `render.yaml` 自动建好服务、持久磁盘、环境变量
- 唯一需要你手填的：**ADMIN_PASSWORD**（后台登录密码，设一个强密码）

> 不想用蓝图也可以手动：New → Web Service，Build `npm install`，Start `npm start`，
> 然后在 Settings 里加一块 **Disk**（mount path `/var/data`，1GB），
> 环境变量加 `NODE_ENV=production`、`DATA_DIR=/var/data`、`ADMIN_PASSWORD=你的密码`。

### 2. 绑定域名 + HTTPS
- 服务页 → **Settings → Custom Domains** → 添加你的域名（如 `live.yoursite.com`）
- 按提示去你的**域名 DNS** 加一条 **CNAME** 记录指向 Render 给的地址
- DNS 生效后，Render **自动签发 HTTPS 证书**（免费），无需手动配

完成后访问 `https://live.yoursite.com` 即可。

> ⚠️ Render 的持久磁盘需要 **Starter 付费实例**（约 $7/月）。Free 实例不支持磁盘、且会休眠（直播间不适合休眠）。

---

## 方案 B：Railway（备选，按量计费，挂卷简单）

1. https://railway.app → New Project → Deploy from GitHub repo
2. 服务 → **Variables** 加：`NODE_ENV=production`、`DATA_DIR=/data`、`ADMIN_PASSWORD=你的密码`
3. 服务 → **Volumes** → 新建 Volume，Mount path 填 `/data`（与 DATA_DIR 一致）
4. **Settings → Networking → Custom Domain** 添加你的域名，按提示加 CNAME，Railway 自动配 HTTPS

---

## 部署后必做检查清单

1. ✅ 打开 `https://你的域名/admin.html`，用你设的 **ADMIN_PASSWORD** 登录
2. ✅ 「直播间配置」填好：直播间名称、课程标题、**视频嵌入代码**（贴 Voomly 的即可）
3. ✅ 「观看码」标签页：**删掉演示码 VIP888 / GOLD66**，创建你自己的真实观看码发给学员
4. ✅ 确认数据持久：在后台改点东西 → 在平台手动 Redeploy 一次 → 改动还在 = 持久磁盘 OK
5. ✅ 手机打开域名，走一遍：输观看码 → 进直播间 → 视频播放 → 发评论

## 商城 / Stripe 支付接入（可选，配了才有支付）

直播间可开启「商城」：购物车入口 + 定时弹出课程小卡 + 半屏商品弹窗（推荐商品 / 优惠券 / 订单），下单走 **Stripe Embedded Checkout**（官方收银台以 iframe 内嵌进弹窗，不碰卡号，最安全）。

### 1. 配 3 个环境变量（在平台面板手填，不进仓库）
- `STRIPE_SECRET_KEY`：Stripe 后台 → Developers → API keys 的 **Secret key**（`sk_test_...` 先用测试，`sk_live_...` 正式）
- `STRIPE_PUBLISHABLE_KEY`：同页的 **Publishable key**（`pk_test_...` / `pk_live_...`，公开，会下发前端）
- `STRIPE_WEBHOOK_SECRET`：见下一步

> 不配这些也能跑：商城可浏览，但点购买会提示「支付未配置」。

### 2. 配 Webhook（支付成功的权威来源）
- Stripe 后台 → Developers → **Webhooks** → Add endpoint
- Endpoint URL 填：`https://你的域名/api/stripe/webhook`
- 监听事件勾：`checkout.session.completed`（建议再勾 `checkout.session.async_payment_succeeded`）
- 创建后把该 endpoint 的 **Signing secret**（`whsec_...`）填到环境变量 `STRIPE_WEBHOOK_SECRET`
- 本地联调：`stripe listen --forward-to localhost:3000/api/stripe/webhook`，把它打印的 `whsec_...` 设进环境变量

### 3. 测试支付
- 测试卡号 `4242 4242 4242 4242`，有效期填任意未来日期，CVC 任意 3 位，邮编任意
- 付款后会跳回直播间显示「支付成功」，后台「订单」标签该单状态变 `paid`

### 4. ⚠️ 商户国家与货币（重要）
- **Stripe 商户主体必须注册在受支持国家**：**新加坡、马来西亚、香港等可以；中国大陆和台湾不能作为收款主体**。公司实体在 SG/MY 就在当地注册 Stripe 账户。
- **顾客**在 SG / MY / TW 等地都能正常付款，不受商户国家限制。
- 收款**货币每个直播间可配**（直播间配置 → 收款货币）。跨境受众建议用 **USD**；SG 实体也可用 **SGD**。金额按「主单位 ×100」转最小货币单位，故请用 2 位小数货币（已内置 usd/sgd/myr/hkd/aud/eur/gbp/cny）。

---

## 重要约束

- **只能单实例运行**：用了内存缓存 + 文件存储，不要把实例数 / 副本数调成多个，否则数据不一致
- **数据 = 那一个 db.json**：定期在后台「导出」预设和观看码做备份，或给持久磁盘做快照
- 之后要扛大流量（几千人同时在线）再考虑换数据库 + 多实例，当前 MVP 单机足够验证
