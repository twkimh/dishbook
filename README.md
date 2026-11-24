# 菜品手帐

个人菜品记录小程序。主人家把自己做过的菜传上去，朋友打开就能看、能「点菜」表示想吃哪道；主人家会收到点菜记录，并（可选）收到微信订阅消息提醒。

前端原生小程序 + 微信云开发（cloudbase），**没有自建服务器、没有自建域名、不需要域名备案**。

---

## 当前部署状态（已由 CLI 完成，2026-11-23）

| 项 | 值 |
|---|---|
| AppID | `wx43d8fff701719636` |
| 云环境 Id | `cloud1-d8gchncpfc2745b8a`（微信体验版，到期 2027-05-23） |
| 地域 | `ap-shanghai` |
| 集合 | `dishes` / `orders` / `meta` —— 均已创建 |
| 集合权限 | 三个都是 `ADMINONLY`（仅管理端可读写，客户端直连一律读不到） |
| 云函数 | `api`（Id `lam-fuixpbft`，Nodejs20.19，入口 `index.main`，部署完成） |
| 编译 | 通过，包体 70.7 KB |

也就是说：**下面「二、导入与部署」里的建集合、设权限、部署云函数这几步已经做完了，不用再手动操作。**

重装/换机或改了云函数之后，用这两条命令重做即可（`tcb` 已全局安装）：

```bash
# 重新部署云函数（改了 cloudfunctions/api 下任何文件都要跑这个）
tcb fn deploy api --dir "D:\DeepSeek\DeepSeek Workspace\日常工作\dishbook\cloudfunctions\api" --force --install-dependency true

# 部署后验证
tcb fn list
tcb fn invoke api --params '{"action":"login","payload":{}}'
# 预期返回 {"ok":false,"code":"UNAUTHORIZED"}——CLI 调用没有 OPENID，正说明鉴权生效
```

> 只点开发者工具里的「编译」**不会**更新线上云函数，必须重新 deploy。

---

## 一、上手前你必须先办的四件事

按顺序做，卡住的多半是第 2 步。

### 1. 装微信开发者工具
从 https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html 下 **Stable（稳定版）Windows 64**。

装完做三件事：
- 用微信扫码登录（不登录无法预览、无法上传）
- 「设置 → 安全设置 → 服务端口」打开
- 新建任意空项目，确认模拟器能正常显示

### 2. 拿到小程序 AppID（必须，没有替代方案）
登录 https://mp.weixin.qq.com 看看有没有小程序账号：
- **有** → 「开发管理 → 开发设置」里 `wx` 开头那串就是 AppID
- **没有** → 注册一个，选**个人主体**，免费，只要身份证 + 手机号。不需要买 300 元认证

> 为什么不能用测试号：测试号只能在开发者工具里自己看，**不能把体验版发给朋友**。你要发给朋友用，就必须有正式 AppID。

拿到后填进 `project.config.json` 的 `appid` 字段（现在是占位值）。

### 3. 开通云开发
开发者工具顶部点「云开发」→ 开通 → 创建一个环境。

**免费**：新用户可开通免费云环境，配额等同基础套餐，小程序**未发布上线**阶段无需续费。

> ⚠️ 一个必须记住的坑：小程序**一旦正式发布上线**，免费环境的到期时间会变成「上线后第 15 天」，之后必须转付费（**19.9 元/月**）。只发体验版则一直是 0 元。

### 4. 申请订阅消息模板（可选，但决定你能不能收到提醒）
后台「功能 → 订阅消息 → 公共模板库 → 一次性订阅」，找一条含「名称 / 备注 / 时间」这类字段的模板并申请，拿到 **templateId**。

**可能有坑**：模板库是按服务类目开放的，不一定有「点菜」这种模板。选最接近的即可（比如预约提醒、待办提醒）。如果确实没有可用的，**跳过这一步也能正常用**——点菜记录照样落库，只是不会推送通知。

---

## 二、导入与部署

### 导入项目
开发者工具 → 导入项目 → 目录选 `dishbook` → AppID 填你自己的 → 确定。

`project.config.json` 里已经配好：
- `miniprogramRoot: "miniprogram/"`
- `cloudfunctionRoot: "cloudfunctions/"`
- `libVersion: "2.20.0"`

### 创建数据库集合（**必须在第一次运行前做**）
云开发控制台 → 数据库 → 创建这三个集合，名字必须**一字不差**：

| 集合 | 用途 |
|---|---|
| `dishes` | 菜品 |
| `orders` | 点菜记录 |
| `meta` | 配置（主人家 openid、订阅模板 ID） |

**三个集合的权限都设为「所有用户不可读写」。**

> 为什么不设「所有人可读」：这个小程序所有数据读写都走云函数，云函数用管理员身份访问，不受集合权限限制。集合对客户端完全关闭，是这里最安全的配置——客户端根本没有绕过后端直接读写数据库的路径。

### 部署云函数
右键 `cloudfunctions/api` → **「上传并部署：云端安装依赖」**（必须选带「云端安装依赖」的那个，因为 `wx-server-sdk` 要在云端装）。

### 编译
点「编译」。第一次打开时小程序会调一次 `login`，此时 `meta` 集合还是空的，**你自己就是第一个调用者，会自动成为主人家**。

> ⚠️ 所以：**第一次务必你自己先打开小程序，再发给朋友**。如果朋友先打开并提交了一道菜，主人家会变成他。万一搞错了，去云开发控制台把 `meta` 集合的 `app` 文档删掉，自己重新打开一次即可。

### 配订阅消息模板 ID（第 4 步办了的才需要）
云开发控制台 → 数据库 → `meta` 集合 → 编辑 `app` 文档：

```json
{
  "_id": "app",
  "ownerOpenids": ["你的openid"],
  "subscribeTemplateId": "你申请到的模板ID",
  "subscribeDataMap": null,
  "ownerNickname": ""
}
```

`subscribeTemplateId` 留空 = 关闭通知功能，其余功能完全不受影响。

**关于 `subscribeDataMap`**：订阅消息的数据字段名由你申请的模板决定，代码无法预知。如果默认的 `{thing1: 菜名, thing2: 昵称, thing3: 备注}` 跟你的模板对不上，就填一个映射表，值用这几个 token：

| token | 含义 |
|---|---|
| `dishName` / `name` | 菜名 |
| `nickname` | 点菜人昵称 |
| `note` | 备注 |
| `dishId` | 菜品 ID |
| `time` | 时间 |
| `count` | 被点次数 |

例如你的模板字段叫 `thing1`(菜品) / `name1`(点菜人) / `thing3`(备注)：

```json
"subscribeDataMap": { "thing1": "dishName", "name1": "nickname", "thing3": "note" }
```

发不出去也不影响点菜成功，只是 `orders.notifyState` 记为 `failed`。

### 发给朋友（体验版）
1. 后台「管理 → 成员管理 → 体验成员」把朋友的微信号加进去（人数有上限）
2. 开发者工具点「上传」→ 后台「版本管理」把该版本设为**体验版**
3. 把体验版二维码发给朋友

---

## 三、项目结构

```
dishbook/
├─ project.config.json
├─ SPEC.md                     # 开发规格（数据模型 / 云函数契约 / 设计规范）
├─ README.md                   # 本文件
├─ miniprogram/
│  ├─ app.js                   # 云开发初始化 + 登录态缓存
│  ├─ app.json                 # 页面/窗口/tabBar 声明
│  ├─ app.wxss                 # 只做 @import
│  ├─ styles/tokens.wxss       # 设计变量（颜色/圆角/阴影）
│  ├─ styles/common.wxss       # 通用类：纸卡、胶带、倾斜、按钮、骨架
│  ├─ utils/api.js             # 云函数调用的唯一出口
│  ├─ utils/format.js          # 时间/文本格式化
│  ├─ components/              # dish-card / tag-chip / empty-state / paper-card
│  ├─ custom-tab-bar/          # 自定义 tabBar（纯 CSS 画图标，零图片素材）
│  └─ pages/
│     ├─ index/                # 菜品流（tab）
│     ├─ detail/               # 菜品详情 + 点菜
│     ├─ add/                  # 添加菜品（tab，主人家/访客双模式）
│     ├─ orders/               # 点菜记录（仅主人家）
│     ├─ review/               # 访客提交审核（仅主人家）
│     └─ mine/                 # 我的（tab）
└─ cloudfunctions/
   └─ api/                     # 唯一云函数，按 action 路由
```

---

## 四、几个必须知道的设计约束

**1. 客户端不直连数据库**
所有读写都走云函数 `api`，客户端唯一出口是 `utils/api.js`。要加功能就在 `api` 里加 action，不要在页面里直接 `wx.cloud.database()`。

**2. 只有 `login` 能自举主人家**
自举写在 `routes/login.js` 里，`resolveContext` 是纯读取、无副作用。这是刻意的：如果把自举放进 `resolveContext`，任何陌生的 action 被抢先调用一次就能提升权限。

**3. 访客提交要审核，改过的菜会重新进审核**
- 访客提交 → `pending`，主人家在「待审核」里通过后才进菜品流
- 访客**修改自己已上架的菜** → 自动退回 `pending`，重新审
- 主人家自己提交/修改，直接 `approved`

**4. 一次性订阅：「授权一次 ≈ 能发一条」**
每点一次菜，朋友那边都会弹一次授权窗。这是微信的机制，不是实现偷懒。官方文档在「同一用户多次授权是否累积」上说法不一致（服务号文档明确写不累积），所以按最保守的语义处理：每次点菜都要一次授权，允许了才发一条。

**5. 通知功能是可降级的**
`subscribeTemplateId` 为空 → 不弹授权窗、不发送，`notifyState` 记 `skipped`。发送失败记 `failed`。**任何情况下点菜本身都成功**，通知只是附加。

**6. 内容安全校验**
访客提交的菜名/说明/标签和点菜的备注都会过 `security.msgSecCheck`。命中违规直接拒绝且不落库；接口本身报错（额度、网络、未开通）时**放行并打日志**，不因为安全接口抖动挡住正常用户。

---

## 五、已知限制

- **已在开发环境验证**：云函数已部署、编译通过、模拟器渲染正常、接口在运行时实测返回正确数据。
- **云存储权限是 `PRIVATE`，且免费套餐不允许修改**（`ModifyStorageSafeRule` 返回 `OperationDenied.FreePackageDenied`）。因此客户端**不能**直接用 `<image src="cloud://...">` 渲染别人上传的图片——访客会看到空白。解决办法是云函数 `lib/storage.js` 用 `cloud.getTempFileURL()` 把 fileID 换成临时 https 链接后返回（管理员身份不受存储 ACL 限制）。**落库永远是 fileID 原文，只有读取接口出参做转换**，改代码时别把临时链接写进库。临时链接有效期 2 小时，过期后下拉刷新即可重新签发。
- `submitter.avatar` / `orderer.avatar` 目前恒为空串，未走图片转换；将来若真的接入用户头像（也是 cloud fileID），需要把它们一并纳入 `attachTempUrls` 的字段列表。
- 免费云环境有「功能使用限制」（比如部分扩展能力不可用），当前功能不依赖这些。
- 体验成员有数量上限，人多了就得考虑正式发布（那时才产生 19.9 元/月）。
- 没有做：收藏、评论、分享海报、菜谱步骤、多主人家协作——`SPEC.md` §7 明确不做，要加需要先改规格。

---

## 六、出问题先看这里

| 现象 | 大概率原因 |
|---|---|
| 编译报 `appid` 相关错误 | `project.config.json` 里 `appid` 还是占位值 |
| 列表一直是空的 | 云函数没部署，或 `dishes` 集合没建 |
| 提示「服务器开小差了」 | 打开云开发控制台 → 云函数 → 日志，看 `[api] 未捕获异常` |
| 提交菜以后看不到 | 你是访客身份，提交进了 `pending`，去「待审核」通过 |
| 收不到点菜通知 | `meta` 里 `subscribeTemplateId` 没填，或模板字段对不上（看 `orders.notifyState`） |
| 朋友点开就成主人家了 | 你自己没有第一次先打开。删掉 `meta` 的 `app` 文档重来 |
| 改完代码上传后线上没变 | 改了云函数要重新「上传并部署」，只点「编译」不会生效 |
