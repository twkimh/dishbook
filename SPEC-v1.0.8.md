# v1.0.8 新增契约（点菜单 / 修改提案 / 反应）

> 本文件是 v1.0.8 的补充契约，与 `SPEC.md` 配合使用；冲突时以本文件为准。

## 1. 数据模型变更

### 1.1 `dishes` 新增字段
| 字段 | 类型 | 说明 |
|---|---|---|
| `ingredients` | `string[]` | 材料，≤20 项，每项 ≤20 字 |
| `seasonings` | `string[]` | 调料，≤20 项，每项 ≤20 字 |
| `methods` | `string[]` | 烹饪方式，取白名单值，**可多选且不限数量** |
| `likes` | `object[]` | `{ openid, nickname, avatar, at }`，≤200 条，按 openid 去重；点过「喜欢」的人 |
| `wants` | `object[]` | `{ openid, nickname, avatar, at }`，≤200 条（去重按 openid） |
| `contributors` | `object[]` | `{ openid, nickname, avatar }`，参与修改且**已通过审核**的人，按 openid 去重，不含提交者本人 |
| `provider` | — | 复用现有 `submitter` 作为"提供者"，不新增字段 |

`story`（一句话说明）复用为需求里的「想说的话」，可选。

**烹饪方式白名单**（后端校验，传白名单外的值直接丢弃不报错）：
```
炒 爆 熘 煸 炝 干煸 炸 煎 烙 烤 炭烤 熏 焗 蒸 清蒸 粉蒸
煮 炖 焖 煨 烧 红烧 烩 汆 涮 熬 焯 拌 凉拌 腌 卤 酱 醉 糟
白灼 糖醋 拔丝 干锅 砂锅 铁板 水煮
```

### 1.2 新集合 `dishEdits`（修改提案）
```js
{
  _id, dishId, dishName,
  snapshot: { name, cover, images, story, ingredients, seasonings, methods, tags },
  submitter: { openid, nickname, avatar },
  status: 'pending' | 'approved' | 'rejected',
  createdAt, reviewedAt
}
```

### 1.3 新集合 `menus`（点菜单会话）
```js
{
  _id, ownerOpenid,
  title: string,          // 如「周六晚饭」
  dateText: string,       // 如「2026-11-29」年月日
  mealType: string,       // 早餐 | 午餐 | 晚餐 | 夜宵
  headcount: number,      // 人数，可为 0（未填）
  status: 'open' | 'closed',
  startedAt: number, endsAt: number|null, closedAt: number|null
}
```
- **同一时刻只允许一个 `open` 的菜单**；`menu.start` 时若已有 open 的，先自动关闭它
- `endsAt` 为空表示不预设结束时间，只能手动关
- 是否到期由**客户端**用 `endsAt` 判断，服务端在 `order.create` 时也校验一次 `endsAt`（过期视为已结束）

### 1.4 `orders` 新增字段
| 字段 | 类型 | 说明 |
|---|---|---|
| `menuId` | string | 归属的点菜单 id；无菜单时期的旧数据为空串 |

## 2. 云函数 action 变更

### 2.1 新增
| action | payload | 权限 | 返回 |
|---|---|---|---|
| `dish.edit` | `{ id, ...字段同 dish.create }` | 所有人 | `{ id, status }`；**主人家直接生效返回 `approved`，其他人写提案返回 `pending`** |
| `dish.editList` | `{ page, pageSize }` | 主人家 | 待审提案列表 `{ list, total, hasMore }` |
| `dish.editReview` | `{ id, accept }` | 主人家 | `{ status }`；通过时把 snapshot 写入 dishes 并合并 contributors |
| `dish.editHistory` | `{ dishId }` | 所有人 | 该菜全部修改记录（含状态、时间、提交人、snapshot） |
| `dish.like` / `dish.unlike` | `{ id }` | 所有人 | `{ liked, likeCount, likes }`（`likes` 是完整数组） |
| `dish.want` / `dish.unwant` | `{ id }` | 所有人 | `{ wants }`（数组） |
| `menu.current` | `{}` | 所有人 | 当前 `open` 的菜单或 `null`（含 `expired` 布尔） |
| `menu.start` | `{ title, dateText, mealType, headcount, endsAt }` | 主人家 | 新建的菜单对象 |
| `menu.close` | `{}` | 主人家 | `{}` |
| `menu.list` | `{ page, pageSize }` | 所有人 | 历史菜单 `{ list, total, hasMore }` |
| `menu.detail` | `{ id }` | 所有人 | `{ menu, dishes: [...] }` |

`menu.detail` 里每道菜的形状：
```js
{
  dishId, dishName, dishCover,
  orders: [{ openid, nickname, avatar, note, createdAt }],  // 谁点的、什么时候
  wants: [{ openid, nickname, avatar, at }]                 // 想吃的人
}
```

### 2.2 修改现有
- `order.create`：**新增强校验** —— 没有 `open` 且未过期的菜单时返回 `code: 'INVALID'`，message 为 `还没可以点菜哦~`；成功时写入 `menuId`
- `dish.create`：payload 新增 `ingredients` / `seasonings` / `methods`，落库时校验并清洗
- `dish.list` / `dish.get` / `dish.mine` / `dish.reviewList`：返回里带上 `likeCount`、**`likes`（完整数组）**、`wants`、`contributors`，并把 `likes[].avatar` / `wants[].avatar` / `contributors[].avatar` 纳入 `attachTempUrls`

## 3. 业务规则

1. **谁能改**：所有人。主人家改 → 直接写 `dishes`；其他人（**包括原提交者**）改 → 写 `dishEdits(status='pending')`，不改 `dishes`
2. **审核通过**：把 `snapshot` 覆盖到 `dishes` 的可编辑字段；把提案人合并进 `contributors`（按 openid 去重，**不含提供者 `submitter` 本人**）；`status='approved'`、写 `reviewedAt`。若 `dishes` 文档已被删除，该提案直接置 `rejected`（`reviewedAt=now`），避免永久挂在待审列表
3. **审核驳回**：只改提案 `status='rejected'`，不动 `dishes`；提案仍保留在历史里（参与者能看到"提交过但未通过"）
4. **点菜前置**：必须有 `status='open'` 且（`endsAt` 为空或 `now < endsAt`）的菜单
5. **喜欢 / 想吃**：不受菜单状态影响，任何时候可用；重复点幂等（已存在则忽略）
6. **想说的话**：`story` 字段，可选，≤200 字
7. **头像即身份**：`likes` 与 `wants` 在界面上只显示头像（不显示昵称），因此**点击任一头像必须能查看该人的昵称**——这是前端约定，后端必须保证 `likes[].nickname` / `wants[].nickname` 有值（提交时快照）
8. **图标规范**（用户已定）：统一「符号 + 文字」，符号一律用 **Unicode 文本字符**，**不用 emoji**（emoji 会渲染成彩色方块，与手帐风配色冲突，且无法用 CSS 着色）
   | 动作 | 符号 | 详情页按钮 | 卡片小按钮 | 颜色 |
   |---|---|---|---|---|
   | 点菜 | `+` | `+ 点这道菜` | `+` | `--accent` |
   | 喜欢 | `♥` | `♥ 喜欢` | `♥` | `--accent`，已点则实心高亮 |
   | 想吃 | `馋` | `馋 想吃` | `馋` | `--sage`，已点则高亮 |

## 4. 「被点次数」语义变更 + 结束确认（v1.0.8 追加）

### 4.1 语义变更（重要）
**点菜不再增加 `cookedCount`。** 只有主人家在结束点菜单后确认某道菜「已做」，该菜 `cookedCount` 才 **+1**（一道菜 +1 一次，与订单条数无关）。

- `order.create` 里原本的 `cookedCount: _.inc(1)` **必须移除**
- `order.cancel` 里对应的「回退 -1」**也必须移除**（不再有 +1 就不该 -1）

### 4.2 `menus` 新增字段
| 字段 | 类型 | 说明 |
|---|---|---|
| `reviewedAt` | `number \| null` | 确认时间；为空表示这一轮已结束但还没确认 |
| `review` | `object \| null` | `{ [dishId]: 'done' \| 'missed' }`，主人家逐菜确认的结果 |

### 4.3 新增 action
| action | payload | 权限 | 返回 |
|---|---|---|---|
| `menu.review` | `{ id, decisions: { dishId: 'done'\|'missed' } }` | 主人家 | `{ reviewedAt, review }` |
| `dish.orderers` | `{ id }` | 所有人 | `{ people: [{ openid, nickname, avatar, times, lastAt }] }` |

`menu.review` 规则：
1. 只能对 `status === 'closed'` 的菜单确认；`open` 的返回 `INVALID('先结束这一轮再确认')`
2. **已 `reviewedAt` 的菜单再次确认 → `INVALID('这一轮已经确认过了')`**（结果锁定，防止重复累加）
3. 对每个 `decisions[dishId] === 'done'` 的菜品，把对应 `dishes.cookedCount` **+1**（缺失或非数字按 0 起算）
4. `decisions` 里未出现的菜品按 `'missed'` 处理（不累加）
5. 写 `menus.review`、`menus.reviewedAt`
6. 某个 dishId 对应的菜已被删除 → 跳过累加，但仍在 `review` 里记下

`dish.orderers` 规则：
- 查 `orders` 里 `dishId === id` 且 `status !== 'cancelled'` 的记录
- 按 `openid` 聚合：`times` = 点过几次，`lastAt` = 最近一次时间
- 按 `lastAt` 倒序；`avatar` 走临时链接转换
- 最多返回 50 人

### 4.4 `menu.detail` 返回追加
`{ menu, dishes }` 里 `menu` 对象除原有字段外，追加 `reviewedAt` 与 `review`（原样带出）。

## 5. 软删除 / 上下架 / 回收站（v1.0.8 追加）

### 5.1 数据模型
`dishes` 新增：
| 字段 | 类型 | 说明 |
|---|---|---|
| `listed` | boolean | 是否上架，默认 `true`。`false` = 已下架（所有人可在「下架」列表看到） |
| `deletedAt` | number\|null | 进回收站的时间；非 null 即已删除 |
| `deletedBy` | string | 谁删的 openid |
| `deleteReason` | string | 删除理由（创建者删除时必填；主人家删除可空） |
| `deletedFrom` | string | 删除前所处状态：`'listed'` \| `'delisted'` \| `'pending'`，用于恢复 |

`menus` 新增：`deletedAt` / `deletedBy`
`orders` 新增：`deletedAt`（跟随菜单一起进回收站）

`dishEdits` 新增：
| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | string | `'edit'`（默认）\| `'delete'` |
| `reason` | string | 删除理由，`type='delete'` 时必填 |

### 5.2 权限矩阵
| 操作 | 主人家 | 创建者本人 | 其他人 |
|---|---|---|---|
| 下架 / 重新上架 | ✅ 直接生效 | ✅ 直接生效 | ❌ |
| 删除菜品 | ✅ **直接进回收站，理由可空** | ⚠️ **必须填理由 → 进审核队列** | ❌ |
| 删除点菜单 | ✅ 直接进回收站 | — | ❌ |
| 回收站查看 / 恢复 / 永久删除 / 清空 | ✅ | ❌ | ❌ |

### 5.3 新增与变更 action
| action | payload | 权限 | 返回 |
|---|---|---|---|
| `dish.setListed` | `{ id, listed }` | 创建者或主人家 | `{ id, listed }` |
| `dish.remove` | `{ id, reason }` | 见权限矩阵 | 主人：`{ id, deleted: true }`；创建者：`{ id, status: 'pending' }` |
| `menu.update` | `{ id, title, dateText, mealType, headcount, endsAt }` | 主人家 | 更新后的菜单对象 |
| `menu.delete` | `{ id }` | 主人家 | `{ id, deleted: true }` |
| `recycle.list` | `{ type? }` | 主人家 | `{ dishes: [], menus: [] }`（按 `deletedAt` 倒序） |
| `recycle.restore` | `{ type, ids: [] }` | 主人家 | `{ restored: number }` |
| `recycle.purge` | `{ type, ids: [] }` | 主人家 | `{ purged: number }` |
| `recycle.clear` | `{ type? }` | 主人家 | `{ purged: number }`；`type` 为空 = 清空整个回收站 |

补充规则：
1. `dish.remove` 改动语义：**不再物理删除**，改为软删除或写删除提案
2. `dish.editReview` 审到 `type='delete'` 的提案且通过 → 把该菜品软删除（`deletedFrom` 取当前 listed 状态）
3. `menu.update` 只允许改 `status !== 'closed'` 的菜单（已结束的不给改）；`endsAt` 传 `null` 表示取消预设结束时间
4. `menu.delete` 软删除该菜单**及其下所有未删除的订单**（订单的 `deletedAt` 一起写）
5. **懒删除**：上面四个 `recycle.*` action 在执行前，先把 `deletedAt + 30 天 < now` 的记录**物理删除**（菜品连图片 fileID 不管，订单直接删，菜单直接删）
6. `deletedAt` 非 null 的记录**不得**出现在：`dish.list`、`dish.mine`、`dish.reviewList`、`dish.get`、`menu.current`、`menu.list`、`menu.detail`、`order.list`、`dish.orderers`
7. `dish.list` 增加可选 `listed` 参数（默认 `true`）：传 `false` 返回**已下架**列表（所有人可见）；下架菜**不出现**在默认列表中
8. 恢复菜品时：`deletedAt=null`、`listed` 按 `deletedFrom` 还原（`delisted` → 保持下架，其它 → 上架）
