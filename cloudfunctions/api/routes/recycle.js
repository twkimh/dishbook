/**
 * recycle 相关 action：list / restore / purge / clear（SPEC-v1.0.8 §5.3）。
 *
 * 四条硬规则：
 *  1. 全部仅主人家可调用；
 *  2. 每个 action 进来先做懒删除：deletedAt + 30 天 < now 的记录直接物理删除（§5.3 规则 5）。
 *     懒删除全程不抛错 —— 查不到就跳过，单条删失败只 console.warn，绝不阻断主流程；
 *  3. 恢复菜品要按 deletedFrom 还原上下架状态；恢复菜单要把它下面一起进回收站的订单捞回来；
 *  4. 永久删除 / 清空是物理 remove，菜单连带物理删它名下的订单。
 *
 * 「在回收站里」一律用 deletedAt > 0 判定：老数据没有该字段、活数据是 null，都进不来。
 */

const { _, dishes, orders, menus, resolveContext, now } = require('../lib/db');
const { unauthorized, invalid } = require('../lib/response');
const { LIMITS } = require('../lib/validate');
const { attachTempUrls } = require('../lib/storage');
const { isDeleted, listedFromDeletedFrom } = require('./dish');
const { patchOrdersOfMenu } = require('./menu');

const DAY_MS = 24 * 3600 * 1000;
/** 回收站保留天数（SPEC-v1.0.8 §5.3 规则 5）。 */
const RETAIN_DAYS = 30;
const RETAIN_MS = RETAIN_DAYS * DAY_MS;

/** 已取消的订单不计入「这道菜单有几道菜」（与 menu.detail 一致）。 */
const ORDER_STATUS_CANCELLED = 'cancelled';

const TYPE = {
  DISH: 'dish',
  MENU: 'menu',
};

/** 云开发单次 limit 上限 100；每轮最多处理 FETCH_LIMIT × FETCH_MAX_ROUNDS 条。 */
const FETCH_LIMIT = 100;
const FETCH_MAX_ROUNDS = 5;

/* ---------------------------------------------------------------- 工具函数 */

/** 「在回收站里」的查询条件：deletedAt 是正数时间戳。 */
function inTrash() {
  return { deletedAt: _.gt(0) };
}

/** 删除时间戳归一：非数字（含字段异常）一律返回 0，表示「时间不可知」。 */
function deletedAtNumber(doc) {
  if (!doc || typeof doc !== 'object') return 0;
  const value = doc.deletedAt;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return 0;
}

/** 剩余天数 = 30 - 已过天数，四舍五入到天，最小 0；时间不可知按「刚删除」算。 */
function daysLeftOf(doc) {
  const at = deletedAtNumber(doc);
  if (!at) return RETAIN_DAYS;
  const left = RETAIN_DAYS - Math.round((Date.now() - at) / DAY_MS);
  return left < 0 ? 0 : left;
}

/** type 归一：缺省 / 空串 -> ''（按「全部」处理）；非法值 INVALID。 */
function normalizeType(value, required) {
  if (value === undefined || value === null) {
    if (required) invalid('缺少 type 参数');
    return '';
  }
  if (typeof value !== 'string') invalid('type 只能是 dish 或 menu');
  const text = value.trim();
  if (!text) {
    if (required) invalid('缺少 type 参数');
    return '';
  }
  if (text !== TYPE.DISH && text !== TYPE.MENU) invalid('type 只能是 dish 或 menu');
  return text;
}

/**
 * ids 清洗：非数组 -> []，非字符串 / 空串 / 重复 / 超长的项直接丢弃，最多 100 个。
 * 混进非法值也绝不抛错（约束 3）。
 */
function pickIds(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = {};
  for (let i = 0; i < value.length; i += 1) {
    if (out.length >= LIMITS.RECYCLE_IDS_MAX) break;
    const item = value[i];
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || seen[id]) continue;
    if (Array.from(id).length > LIMITS.ID_MAX) continue;
    seen[id] = true;
    out.push(id);
  }
  return out;
}

/** 按 id 取一条「确实在回收站里」的记录；查不到 / 读失败返回 null。 */
async function findInTrash(collection, id) {
  try {
    const res = await collection.where(_.and([{ _id: id }, inTrash()])).limit(1).get();
    const doc = res && Array.isArray(res.data) ? res.data[0] : null;
    return doc && isDeleted(doc) ? doc : null;
  } catch (err) {
    console.warn('[recycle] 读取回收站记录失败', id, err && (err.errCode || err.message));
    return null;
  }
}

/** 分页读回收站里的记录（按 deletedAt 倒序，最多 5 页 500 条，读失败降级为空）。 */
async function fetchInTrash(collection, label) {
  const out = [];
  for (let round = 0; round < FETCH_MAX_ROUNDS; round += 1) {
    let batch = [];
    try {
      const res = await collection
        .where(inTrash())
        .orderBy('deletedAt', 'desc')
        .skip(round * FETCH_LIMIT)
        .limit(FETCH_LIMIT)
        .get();
      batch = res && Array.isArray(res.data) ? res.data : [];
    } catch (err) {
      console.warn('[recycle] 读取回收站失败', label, err && (err.errCode || err.message));
      break;
    }
    for (let i = 0; i < batch.length; i += 1) {
      if (isDeleted(batch[i])) out.push(batch[i]);
    }
    if (batch.length < FETCH_LIMIT) break;
  }
  return out;
}

/** 分页读订单（任意 where，最多 5 页 500 条，读失败降级为空）。 */
async function fetchOrdersOf(where, label) {
  const out = [];
  for (let round = 0; round < FETCH_MAX_ROUNDS; round += 1) {
    let batch = [];
    try {
      const res = await orders()
        .where(where)
        .skip(round * FETCH_LIMIT)
        .limit(FETCH_LIMIT)
        .get();
      batch = res && Array.isArray(res.data) ? res.data : [];
    } catch (err) {
      console.warn('[recycle] 读取订单失败', label, err && (err.errCode || err.message));
      break;
    }
    for (let i = 0; i < batch.length; i += 1) out.push(batch[i]);
    if (batch.length < FETCH_LIMIT) break;
  }
  return out;
}

/** 物理删一条记录；失败只告警（懒删除 / 清空都不许因单条失败中断）。 */
async function removeOne(collection, id, label) {
  try {
    await collection.doc(id).remove();
    return 1;
  } catch (err) {
    console.warn('[recycle] 物理删除失败', label, id, err && (err.errCode || err.message));
    return 0;
  }
}

/** 物理删某菜单名下的全部订单：先批量 remove，失败逐条重试，最终失败只 warn。 */
async function removeOrdersOfMenu(menuId) {
  try {
    const res = await orders().where({ menuId: menuId }).remove();
    return res && res.stats && typeof res.stats.removed === 'number' ? res.stats.removed : 0;
  } catch (err) {
    console.warn('[recycle] 订单批量删除失败，改为逐条重试', menuId, err && (err.errCode || err.message));
  }
  const rows = await fetchOrdersOf({ menuId: menuId }, '菜单订单清理');
  let removed = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || typeof row._id !== 'string' || !row._id) continue;
    removed += await removeOne(orders(), row._id, '订单');
  }
  return removed;
}

/* ---------------------------------------------------------------- 懒删除 */

/**
 * 懒删除：把 deletedAt + 30 天 < now 的记录物理删除（SPEC-v1.0.8 §5.3 规则 5）。
 * 四个 action 开头都会 await 一次。任何异常都在内部消化，绝不阻断主流程。
 */
async function purgeExpired() {
  const result = { dishes: 0, menus: 0, orders: 0 };
  try {
    const cutoff = now() - RETAIN_MS;
    result.dishes = await purgeExpiredIn(dishes(), cutoff, 'dish');
    result.menus = await purgeExpiredIn(menus(), cutoff, 'menu');
    result.orders = await purgeExpiredIn(orders(), cutoff, 'order');
  } catch (err) {
    console.warn('[recycle] 懒删除异常，已跳过', err && (err.stack || err.message || err));
  }
  return result;
}

/** 清掉某个集合里过期的软删除记录：查不到就结束，单条失败只 warn。 */
async function purgeExpiredIn(collection, cutoff, label) {
  let purged = 0;
  for (let round = 0; round < FETCH_MAX_ROUNDS; round += 1) {
    let rows = [];
    try {
      const res = await collection.where({ deletedAt: _.lt(cutoff) }).limit(FETCH_LIMIT).get();
      rows = res && Array.isArray(res.data) ? res.data : [];
    } catch (err) {
      console.warn('[recycle] 懒删除查询失败', label, err && (err.errCode || err.message));
      return purged;
    }
    if (!rows.length) return purged;

    let removed = 0;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row || typeof row._id !== 'string' || !row._id) continue;
      removed += await removeOne(collection, row._id, label);
    }
    purged += removed;
    // 一条都没删掉就别再循环了，否则同一批记录会被无限重试
    if (!removed || rows.length < FETCH_LIMIT) return purged;
  }
  return purged;
}

/* ---------------------------------------------------------------- 列表 */

/** 回收站菜品：只带回收站要用的字段，cover 换临时链接。 */
async function listDishes() {
  const rows = await fetchInTrash(dishes(), '菜品');
  const shaped = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    shaped.push({
      _id: typeof row._id === 'string' ? row._id : '',
      name: typeof row.name === 'string' ? row.name : '',
      cover: typeof row.cover === 'string' ? row.cover : '',
      deletedAt: deletedAtNumber(row),
      deletedBy: typeof row.deletedBy === 'string' ? row.deletedBy : '',
      deleteReason: typeof row.deleteReason === 'string' ? row.deleteReason : '',
      deletedFrom: typeof row.deletedFrom === 'string' ? row.deletedFrom : '',
      daysLeft: daysLeftOf(row),
    });
  }
  const attached = await attachTempUrls(shaped, { fields: ['cover'] });
  return Array.isArray(attached) ? attached : shaped;
}

/**
 * 各菜单涉及的菜品数（去重），一次批量查完，避免 N+1。
 *
 * ⚠️ SPEC-v1.0.8 §5.3 的字面写法是「该菜单下**未删除**订单涉及的菜品数」，
 * 但 menu.delete 会把该菜单名下所有未删除的订单一起写上 deletedAt ——
 * 也就是说回收站里的菜单，其订单按定义全是「已删除」的，字面实现会让 dishCount 恒为 0，
 * 这个字段在回收站里就失去意义。这里按「该菜单名下所有未取消的订单」统计
 * （已取消的订单在 menu.detail 里也不计入，保持一致），
 * 已在交付说明里列为需要确认的 SPEC 冲突点。
 */
async function dishCountsByMenu(menuIds) {
  const counts = {};
  const seen = {};
  const ids = Array.isArray(menuIds) ? menuIds : [];
  for (let i = 0; i < ids.length; i += FETCH_LIMIT) {
    const chunk = ids.slice(i, i + FETCH_LIMIT);
    const where = _.and([{ menuId: _.in(chunk) }, { status: _.neq(ORDER_STATUS_CANCELLED) }]);
    const rows = await fetchOrdersOf(where, '菜单菜品数');
    for (let j = 0; j < rows.length; j += 1) {
      const row = rows[j];
      const menuId = row && typeof row.menuId === 'string' ? row.menuId : '';
      const dishId = row && typeof row.dishId === 'string' ? row.dishId : '';
      if (!menuId || !dishId) continue;
      const key = menuId + '\u0000' + dishId;
      if (seen[key]) continue;
      seen[key] = true;
      counts[menuId] = (counts[menuId] || 0) + 1;
    }
  }
  return counts;
}

/** 回收站菜单：dishCount = 该菜单名下（未取消的）订单涉及的菜品数，见 dishCountsByMenu 的说明。 */
async function listMenus() {
  const rows = await fetchInTrash(menus(), '菜单');
  const ids = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i] && typeof rows[i]._id === 'string' && rows[i]._id) ids.push(rows[i]._id);
  }
  const counts = await dishCountsByMenu(ids);

  const shaped = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const id = typeof row._id === 'string' ? row._id : '';
    shaped.push({
      _id: id,
      title: typeof row.title === 'string' ? row.title : '',
      dateText: typeof row.dateText === 'string' ? row.dateText : '',
      mealType: typeof row.mealType === 'string' ? row.mealType : '',
      headcount: typeof row.headcount === 'number' && Number.isFinite(row.headcount) ? row.headcount : 0,
      deletedAt: deletedAtNumber(row),
      deletedBy: typeof row.deletedBy === 'string' ? row.deletedBy : '',
      daysLeft: daysLeftOf(row),
      dishCount: counts[id] || 0,
    });
  }
  return shaped;
}

/* ---------------------------------------------------------------- actions */

/** recycle.list —— { dishes: [], menus: [] }，type 传了就只查那一类。 */
async function list(ctx) {
  await purgeExpired();

  const resolved = await resolveContext(ctx.openid);
  if (!resolved.isOwner) unauthorized('只有主人家可以查看回收站');

  const type = normalizeType(ctx.payload && ctx.payload.type, false);
  const result = { dishes: [], menus: [] };
  if (type === '' || type === TYPE.DISH) result.dishes = await listDishes();
  if (type === '' || type === TYPE.MENU) result.menus = await listMenus();
  return result;
}

/** recycle.restore —— 恢复；菜单连带恢复它名下一起进回收站的订单。 */
async function restore(ctx) {
  await purgeExpired();

  const resolved = await resolveContext(ctx.openid);
  if (!resolved.isOwner) unauthorized('只有主人家可以恢复回收站里的内容');

  const payload = ctx.payload || {};
  const type = normalizeType(payload.type, true);
  const ids = pickIds(payload.ids);
  if (!ids.length) invalid('缺少 ids 参数');

  const ts = now();
  let restored = 0;
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    const collection = type === TYPE.DISH ? dishes() : menus();
    // 只恢复「确实在回收站里」的记录：活着的数据不动，避免恢复一个 id 时顺手改了上架状态
    const doc = await findInTrash(collection, id);
    if (!doc) continue;

    try {
      if (type === TYPE.DISH) {
        await dishes().doc(id).update({
          data: {
            deletedAt: null,
            listed: listedFromDeletedFrom(doc),
            deletedFrom: '',
            updatedAt: ts,
          },
        });
      } else {
        await menus().doc(id).update({ data: { deletedAt: null } });
        // 菜单恢复 -> 跟它一起进回收站的订单一起捞回来
        await patchOrdersOfMenu(id, inTrash(), { deletedAt: null }, '菜单恢复连带订单');
      }
      restored += 1;
    } catch (err) {
      console.warn('[recycle] 恢复失败', type, id, err && (err.errCode || err.message));
    }
  }
  return { restored: restored };
}

/** recycle.purge —— 物理删除指定记录（菜单连带物理删它的订单）。 */
async function purge(ctx) {
  await purgeExpired();

  const resolved = await resolveContext(ctx.openid);
  if (!resolved.isOwner) unauthorized('只有主人家可以永久删除回收站里的内容');

  const payload = ctx.payload || {};
  const type = normalizeType(payload.type, true);
  const ids = pickIds(payload.ids);
  if (!ids.length) invalid('缺少 ids 参数');

  let purged = 0;
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    const collection = type === TYPE.DISH ? dishes() : menus();
    // 只删回收站里的记录：活数据永远不会被这里误伤
    const doc = await findInTrash(collection, id);
    if (!doc) continue;

    if (type === TYPE.DISH) {
      purged += await removeOne(dishes(), id, 'dish');
      continue;
    }
    const removed = await removeOne(menus(), id, 'menu');
    if (removed) {
      await removeOrdersOfMenu(id);
      purged += removed;
    }
  }
  return { purged: purged };
}

/** 清空回收站里的全部菜品。 */
async function clearDishes() {
  const rows = await fetchInTrash(dishes(), '菜品');
  let purged = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || typeof row._id !== 'string' || !row._id) continue;
    purged += await removeOne(dishes(), row._id, 'dish');
  }
  return purged;
}

/** 清空回收站里的全部菜单（连带物理删它们的订单）。 */
async function clearMenus() {
  const rows = await fetchInTrash(menus(), '菜单');
  let purged = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || typeof row._id !== 'string' || !row._id) continue;
    const removed = await removeOne(menus(), row._id, 'menu');
    if (!removed) continue;
    await removeOrdersOfMenu(row._id);
    purged += removed;
  }
  return purged;
}

/** recycle.clear —— 物理删除全部已删除记录；type 为空 = 菜品 + 菜单（连带订单）全清。 */
async function clear(ctx) {
  await purgeExpired();

  const resolved = await resolveContext(ctx.openid);
  if (!resolved.isOwner) unauthorized('只有主人家可以清空回收站');

  const type = normalizeType(ctx.payload && ctx.payload.type, false);
  let purged = 0;
  if (type === '' || type === TYPE.DISH) purged += await clearDishes();
  if (type === '' || type === TYPE.MENU) purged += await clearMenus();
  return { purged: purged };
}

module.exports = {
  list: list,
  restore: restore,
  purge: purge,
  clear: clear,
  purgeExpired: purgeExpired,
  TYPE: TYPE,
  RETAIN_DAYS: RETAIN_DAYS,
  daysLeftOf: daysLeftOf,
};
