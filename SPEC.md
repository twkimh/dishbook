# 菜品手帐 · 开发规格（SPEC）

个人菜品记录小程序。主人家上传自己做过的菜；朋友浏览并「点菜」（表示想吃这道），主人家收到点菜记录和微信订阅消息提醒。

## 1. 技术栈

- 原生微信小程序（**不用** Taro / uni-app / Vant 等任何框架或组件库）
- 后端：微信云开发（cloudbase）= 云数据库 + 云存储 + 云函数
- **无自建服务器、无自建域名、无备案需求**
- 客户端零 npm 依赖；云函数仅依赖 `wx-server-sdk`
- 所有数据读写都走云函数 `api`，客户端**不直接**调用 `wx.cloud.database()` / `wx.cloud.callFunction` 以外的方式
- 基础库最低 2.20.0

## 2. 目录结构

```
dishbook/
├─ project.config.json        # miniprogramRoot: "miniprogram/", cloudfunctionRoot: "cloudfunctions/"
├─ README.md                  # 部署说明（谁负责：A）
├─ SPEC.md                    # 本文件
├─ miniprogram/
│  ├─ app.js  app.json  app.wxss  sitemap.json
│  ├─ styles/tokens.wxss       # 设计变量（颜色/圆角/阴影/字号）
│  ├─ styles/common.wxss       # 通用类：纸卡、胶带、虚线、手帐装饰
│  ├─ utils/api.js             # 云函数调用封装（唯一出口）
│  ├─ utils/format.js          # 时间/文本格式化
│  ├─ components/dish-card/    # 菜品卡片（手帐风）
│  ├─ components/tag-chip/     # 标签小胶囊
│  ├─ components/empty-state/  # 空状态（含手绘感插画，纯 CSS）
│  ├─ components/paper-card/   # 通用纸卡容器
│  ├─ custom-tab-bar/          # 自定义 tabBar（纯 CSS 画图标，不用图片素材）
│  └─ pages/
│     ├─ index/    # 菜品流（首页，tab）
│     ├─ detail/   # 菜品详情 + 点菜
│     ├─ add/      # 添加菜品（tab，本人/访客两种模式）
│     ├─ orders/   # 我收到的点菜（仅主人家）
│     ├─ review/   # 访客提交审核（仅主人家）
│     └─ mine/     # 我的（tab）
└─ cloudfunctions/
   └─ api/        # 唯一云函数，内部按 action 路由
```

## 3. 数据模型

### 集合 `dishes`
| 字段 | 类型 | 说明 |
|---|---|---|
| `_id` | string | 自动 |
| `name` | string | 菜名，必填，≤30 字 |
| `cover` | string | 封面云存储 fileID，可为空串 |
| `images` | string[] | 其他图片 fileID，≤8 张 |
| `story` | string | 一句话说明/这道菜的来历，≤200 字，可为空 |
| `tags` | string[] | 标签，≤5 个，每个 ≤8 字 |
| `status` | string | `approved` \| `pending` \| `rejected` |
| `source` | string | `owner` \| `guest` |
| `ownerOpenid` | string | 创建者 openid |
| `submitter` | object | `{ openid, nickname, avatar }` |
| `cookedCount` | number | 被点次数，默认 0 |
| `createdAt` / `updatedAt` | number | 毫秒时间戳 |
| `reviewedAt` | number \| null | 审核时间 |

### 集合 `orders`
| 字段 | 类型 | 说明 |
|---|---|---|
| `_id` | string | 自动 |
| `dishId` / `dishName` / `dishCover` | string | 下单时的菜品快照 |
| `note` | string | 想吃的话，≤100 字，可为空 |
| `orderer` | object | `{ openid, nickname, avatar }` |
| `status` | string | `new` \| `done` |
| `notifyState` | string | `sent` \| `failed` \| `skipped` |
| `createdAt` | number | 毫秒时间戳 |

### 集合 `meta`（单文档，`_id: "app"`）
```js
{ _id: "app", ownerOpenids: [], subscribeTemplateId: "", subscribeDataMap: null, ownerNickname: "" }
```
- `ownerOpenids` 为空时，**第一个调用 `login` 的人自动成为主人家**（自举，避免手工改库）。
  自举**只能由 `login` 触发**，`resolveContext` 必须是无副作用的纯读取——否则任意 action 被陌生访客抢先调用一次就会造成权限提升。
- `subscribeTemplateId` 为空串时，前端不弹订阅授权、不发送通知，功能静默降级。
- `subscribeDataMap` 是订阅消息字段映射表（值取 `dishName|name|nickname|note|dishId|time|count` token）。为 `null` 时按 `{thing1,thing2,thing3}` 兜底尝试，发不出去只记 `failed`，不影响下单。
- `ownerNickname` 目前**没有读写通道**，保持空串；「我的」页展示的称呼取本地缓存 `nickname`。

## 4. 云函数 `api` 契约

调用方式：`wx.cloud.callFunction({ name: 'api', data: { action, payload } })`
返回统一信封：

```js
{ ok: true, data: <任意> }
{ ok: false, code: 'UNAUTHORIZED' | 'NOT_FOUND' | 'INVALID' | 'INTERNAL', message: '中文提示' }
```

客户端 `utils/api.js` 必须：成功返回 `data`，失败 `throw` 一个带 `message` 的 Error 并 `wx.showToast`。

| action | payload | 权限 | 返回 |
|---|---|---|---|
| `login` | `{}` | 所有人 | `{ openid, role: 'owner'\|'guest', hasTemplate: boolean, templateId: string }` |
| `dish.list` | `{ keyword?, tag?, page=1, pageSize=20 }` | 所有人 | `{ list: Dish[], total, hasMore }` 仅 `approved` |
| `dish.get` | `{ id }` | 所有人 | `Dish`（`pending` 仅主人家或提交者本人可取） |
| `dish.create` | `{ name, cover, images, story, tags, nickname?, avatar? }` | 所有人 | `{ id, status }`；主人家直接 `approved`，访客为 `pending`。`nickname`/`avatar` 可选，写入 `submitter` |
| `dish.update` | `{ id, ...同上 }` | 菜品创建者 | `{ id, status }`；**访客编辑已 `approved` 的菜会自动退回 `pending`**（否则可绕过审核），调用方应据此提示「修改已提交，等主人家审核」 |
| `dish.remove` | `{ id }` | 菜品创建者 | `{}` |
| `dish.mine` | `{ page, pageSize }` | 所有人 | 我提交的菜品（含 `pending`/`rejected`） |
| `dish.reviewList` | `{ page, pageSize }` | 主人家 | `pending` 列表 |
| `dish.review` | `{ id, accept: boolean }` | 主人家 | `{ status }` |
| `order.create` | `{ dishId, note }` | 所有人 | `{ id, notifyState }`；同时 `cookedCount + 1` |
| `order.list` | `{ page, pageSize, status? }` | 主人家 | `{ list, total, hasMore }` |
| `order.done` | `{ id }` | 主人家 | `{}` |

**内容安全**：`dish.create` 与 `order.create` 必须对用户可填文本（`name` / `story` / `note` / `tags`）调用 `cloud.openapi.security.msgSecCheck`（v2，`scene` 用 2）。命中违规返回 `code: 'INVALID'` 且**不落库**。接口报错时放行（不能因安全接口抖动阻断正常用户），但要打日志。

**订阅消息**：`order.create` 落库后，若 `meta.subscribeTemplateId` 非空，向主人家 `openid` 发送一次性订阅消息：
- `templateId`：取 `meta.subscribeTemplateId`
- `page`：`pages/orders/orders`
- `data`：**必须可降级** —— 模板字段名由用户后台申请决定，预先无法确定。因此 `data` 从 `meta.subscribeDataMap` 读取字段映射；该字段缺失时，按 `{ thing1: 菜名, thing2: 昵称, thing3: 备注 }` 兜底尝试，发送失败只记 `notifyState: 'failed'`，**不影响下单成功**。

## 5. 设计规范（手绘手帐风）

写在 `styles/tokens.wxss` 的 CSS 变量里，所有页面只允许用变量，不允许写死颜色值。

> **唯一例外**：`app.json` 的 `window` / `tabBar` 是框架配置字段，只接受颜色字面量、不支持 `var()`。
> 这些字段里允许写十六进制（当前用 `#FAF3E7` 米黄底 + 黑字）。**`.wxss` 里仍然一律禁止**。

```css
--paper: #FAF3E7;        /* 页面底色，米黄纸 */
--card: #FFFDF8;         /* 纸卡 */
--ink: #3B302A;          /* 主文字，暖黑 */
--ink-soft: #8A7B6D;     /* 次要文字 */
--accent: #E4643C;       /* 暖橙，主行动色 */
--accent-soft: #F8D3BC;  /* 暖橙浅 */
--sage: #7C9A6D;         /* 抹茶绿，点缀 */
--mustard: #E8B44A;      /* 芥末黄，点缀 */
--line: #EADFCB;         /* 分割线 */
--radius: 28rpx;
--shadow: 0 8rpx 24rpx rgba(90, 62, 40, 0.10);
```

**手帐感的实现手段（全部纯 CSS，不许用图片素材）**：
- 卡片轻微旋转：`transform: rotate(-0.8deg)` / `rotate(0.6deg)`，相邻卡片交替
- 胶带：伪元素、半透明暖色块、`transform: rotate(-3deg)`、两端斜切
- 纸纹：`radial-gradient` 细密圆点叠加，透明度 ≤ 0.04
- 手绘下划线/波浪线：内联 base64 SVG 作 `background-image`
- 标题：加粗 + 字距放宽，配一条短的手绘下划线
- 所有点击反馈用 `transform: scale(0.97)` 过渡，不用系统默认的灰色点击态

**字体**：v1 只用系统字体，**不加载自定义字体**（体积和 CDN 成本不值得）。手帐感靠字重、字距、装饰营造。

## 6. 角色与交互约定

- 未登录不拦人：小程序启动即 `api('login')`，失败也允许浏览（读取类接口不校验角色，只校验 openid 存在）
- 访客看到的「添加菜品」页 = 推荐一道菜（提交后提示「已提交，等主人家审核」）
- 主人家看到的「添加菜品」页 = 直接上架
- 主人家额外可见：`orders`（点菜记录）、`review`（审核），入口在「我的」页
- 所有列表必须实现：下拉刷新、触底加载更多、空状态、加载骨架

## 7. 禁止事项

1. 不引入任何 npm 包 / 第三方组件库 / UI 框架
2. 不使用需要下载的图片素材（tabBar 图标用 `custom-tab-bar` 纯 CSS 画）
3. 不在客户端直连数据库
4. 不写死颜色值、不写死 `openid`
5. 不实现未在本文档出现的功能（收藏、评论、分享海报、菜谱步骤等一律不做）
