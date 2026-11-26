/**
 * orders 相关 action：create / list / done / cancel
 * 契约见 SPEC §4 表格 + SPEC-v1.0.8（含 §4 的 cookedCount 语义变更）。要点：
 *  - order.create 落库 -> 双订阅消息（模板 A 主人家 / 模板 B 点菜者，各自独立降级）
 *    **不再增加 cookedCount**（v1.0.8 §4.1）：cookedCount 只由 menu.review 确认「已做」时 +1
 *  - order.cancel 只置 status='cancelled'（不物理删除），也不回退 cookedCount（没有 +1 就没有 -1）
 *  - order.list / order.done / order.cancel 权限见各函数头部
 */

const { _, orders, resolveContext, now } = require('../lib/db');
const { unauthorized, notFound, invalid } = require('../lib/response');
const { LIMITS, pickText, pickId, pickPaging, listResult, pickProfile } = require('../lib/validate');
const { checkUserText, joinText } = require('../lib/security');
const { sendOrderNotice, sendOrderConfirmNotice, NOTIFY_STATE } = require('../lib/notify');
const { findDish, canSeeDish } = require('./dish');
const { findOpenMenu, isExpired } = require('./menu');
const { attachTempUrls, isCloudFileId } = require('../lib/storage');

/**
 * 点菜记录里要转临时链接的图片字段（落库仍是 fileID 原文）：
 * 下单时的菜品封面快照 + 点菜者头像（一层嵌套字段）。
 */
const IMAGE_FIELDS = ['dishCover', 'orderer.avatar'];

const ORDER_STATUS = {
  NEW: 'new',
  DONE: 'done',
  // v1.0.8：取消不物理删除，只改状态，数据留着可追溯
  CANCELLED: 'cancelled',
};

async function findOrder(id) {
  try {
    const res = await orders().doc(id).get();
    return res && res.data ? res.data : null;
  } catch (err) {
    console.warn('[order] 读取失败或不存在', id, err && (err.errCode || err.message));
    return null;
  }
}

async function create(ctx) {
  const payload = ctx.payload || {};

  // v1.0.8 硬前置（SPEC-v1.0.8 §2.2 / §3.4）：必须有一个 status='open' 且未过期的菜单才能点菜。
  // 放在一切写库动作之前；过期由 endsAt 判断，服务端不改菜单状态。
  const menu = await findOpenMenu();
  if (!menu || isExpired(menu)) {
    invalid('还没可以点菜哦~');
  }

  const dishId = pickId(payload.dishId, '菜品 id');
  const note = pickText(payload.note, { field: 'note', label: '想吃的话', max: LIMITS.NOTE_MAX });

  const dish = await findDish(dishId);
  if (!dish) notFound('菜品不存在或已被删除');

  const resolved = await resolveContext(ctx.openid);
  if (!canSeeDish(dish, ctx.openid, resolved.isOwner)) notFound('菜品不存在或暂不可见');

  // 内容安全：命中违规直接 INVALID，不落库
  await checkUserText(ctx.openid, joinText(note));

  const profile = pickProfile(payload);
  // avatar 只接受云存储 fileID，其它值（外链等）一律落空串，防止塞外链
  const avatar = isCloudFileId(profile.avatar) ? profile.avatar : '';
  const ts = now();
  const doc = {
    dishId: dishId,
    // 归属的点菜单（v1.0.8 §1.4）
    menuId: typeof menu._id === 'string' ? menu._id : '',
    dishName: typeof dish.name === 'string' ? dish.name : '',
    dishCover: typeof dish.cover === 'string' ? dish.cover : '',
    note: note || '',
    orderer: {
      openid: ctx.openid,
      nickname: profile.nickname,
      avatar: avatar,
    },
    status: ORDER_STATUS.NEW,
    notifyState: NOTIFY_STATE.SKIPPED,
    // 模板 B（点菜者收）的发送结果，枚举同 notifyState
    confirmNotifyState: NOTIFY_STATE.SKIPPED,
    createdAt: ts,
  };

  const addRes = await orders().add({ data: doc });
  const orderId = addRes && addRes._id ? addRes._id : '';

  // 【v1.0.8 §4.1 语义变更】点菜不再增加 cookedCount —— 原来的原子自增（db.command.inc）已整段移除。
  // cookedCount 现在只由 menu.review 在「主人家确认某道菜已做」时加一（一道菜一次，与点它的条数无关）。

  // 订阅消息：两条互相独立降级，失败只记 notifyState / confirmNotifyState，绝不影响下单成功
  const notifyVars = {
    dishName: doc.dishName,
    dishId: dishId,
    note: doc.note,
    nickname: profile.nickname,
    time: ts,
    // v1.0.8 §4.1 后 cookedCount 的含义是「已做次数」，点菜不再 +1，
    // 所以这里直接取库里已有的值，不再伪造一个 +1（纯读取，不写库）。
    count: typeof dish.cookedCount === 'number' ? dish.cookedCount : 0,
  };

  // 自己点自己的菜：只发「已下单」确认，不再给自己发「有人点菜了」，
  // 否则两条消息会同时落到同一台手机上，显得很蠢。
  const notifyOwners =
    resolved.meta && Array.isArray(resolved.meta.ownerOpenids) ? resolved.meta.ownerOpenids : [];
  const ordererIsOwner = notifyOwners.indexOf(ctx.openid) !== -1;

  // 模板 A：主人家收「有人点菜了」—— sent / failed / skipped 三条路径
  let notifyState = NOTIFY_STATE.SKIPPED;
  try {
    notifyState = ordererIsOwner
      ? NOTIFY_STATE.SKIPPED
      : await sendOrderNotice(resolved.meta, notifyVars);
  } catch (err) {
    // 兜底：sendOrderNotice 内部已吞错，这里防御意外异常，绝不许冒泡到外层
    notifyState = NOTIFY_STATE.FAILED;
    console.warn('[order] 主人家订阅消息异常', orderId, err && (err.errCode || err.message));
  }

  // 模板 B：点菜者本人（ctx.openid）收「你已成功下单」—— 与模板 A 完全独立
  // 自己点自己的菜时只走这一条（模板 A 已被 ordererIsOwner 跳过）
  let confirmNotifyState = NOTIFY_STATE.SKIPPED;
  try {
    confirmNotifyState = await sendOrderConfirmNotice(resolved.meta, ctx.openid, notifyVars);
  } catch (err) {
    confirmNotifyState = NOTIFY_STATE.FAILED;
    console.warn('[order] 点菜者订阅消息异常', orderId, err && (err.errCode || err.message));
  }

  if (notifyState !== NOTIFY_STATE.SKIPPED) {
    try {
      await orders().doc(orderId).update({ data: { notifyState: notifyState } });
    } catch (err) {
      console.warn('[order] notifyState 回写失败', orderId, err && (err.errCode || err.message));
    }
  }

  if (confirmNotifyState !== NOTIFY_STATE.SKIPPED) {
    try {
      await orders().doc(orderId).update({ data: { confirmNotifyState: confirmNotifyState } });
    } catch (err) {
      console.warn('[order] confirmNotifyState 回写失败', orderId, err && (err.errCode || err.message));
    }
  }

  return { id: orderId, notifyState: notifyState };
}

async function list(ctx) {
  const resolved = await resolveContext(ctx.openid);
  if (!resolved.isOwner) unauthorized('只有主人家可以查看点菜记录');

  const payload = ctx.payload || {};
  const paging = pickPaging(payload);

  let where = {};
  if (payload.status !== undefined && payload.status !== null && payload.status !== '') {
    const status = String(payload.status).trim();
    if (
      status !== ORDER_STATUS.NEW &&
      status !== ORDER_STATUS.DONE &&
      status !== ORDER_STATUS.CANCELLED
    ) {
      invalid('status 只能是 new / done / cancelled');
    }
    // 显式查某个状态：含 status='cancelled' 的历史查询入口
    where = { status: status };
  } else {
    // 默认过滤掉已取消的：否则取消掉的菜还挂在「待处理」里
    where = { status: _.neq(ORDER_STATUS.CANCELLED) };
  }

  const countRes = await orders().where(where).count();
  const total = countRes && typeof countRes.total === 'number' ? countRes.total : 0;
  const listRes = await orders()
    .where(where)
    .orderBy('createdAt', 'desc')
    .skip(paging.skip)
    .limit(paging.pageSize)
    .get();

  // 先拿原始 data、转成临时链接，再交给分页组装
  const list = await attachTempUrls(listRes && listRes.data, { fields: IMAGE_FIELDS });
  return listResult(list, total, paging);
}

async function done(ctx) {
  const resolved = await resolveContext(ctx.openid);
  if (!resolved.isOwner) unauthorized('只有主人家可以处理点菜记录');

  const id = pickId(ctx.payload && ctx.payload.id, '点菜记录 id');
  const order = await findOrder(id);
  if (!order) notFound('点菜记录不存在或已被删除');
  if (order.status === ORDER_STATUS.DONE) return {};
  // 已取消的记录不能被「处理」回 done，否则取消等于白取消
  if (order.status === ORDER_STATUS.CANCELLED) invalid('这条点菜记录已取消');

  await orders().doc(id).update({ data: { status: ORDER_STATUS.DONE } });
  return {};
}

/**
 * order.cancel —— 取消点菜记录。**任何人都可以取消任何一条**（v1.0.8 用户明确要求，
 * 熟人小圈子里"点错了谁都能撤回"比"只有本人能撤"更实用）；前端仍保留二次确认弹窗。
 *  - 不物理删除：只置 status='cancelled' + cancelledAt + cancelledBy，数据留着可追溯
 *  - 幂等：已 cancelled 的再次取消直接返回 {}
 *  - 【v1.0.8 §4.1】不再回退 cookedCount：点菜本来就没有 +1，回退会把历史「已做次数」扣坏
 */
async function cancel(ctx) {
  const id = pickId(ctx.payload && ctx.payload.id, '点菜记录 id');
  const order = await findOrder(id);
  if (!order) notFound('点菜记录不存在或已被取消');

  const resolved = await resolveContext(ctx.openid);
  const orderer =
    order.orderer && typeof order.orderer === 'object' && !Array.isArray(order.orderer)
      ? order.orderer
      : {};
  const ordererOpenid = typeof orderer.openid === 'string' ? orderer.openid : '';
  const isOrderer = !!ordererOpenid && ordererOpenid === ctx.openid;

  // 取消权限（v1.0.8 用户明确要求）：**点菜单里任何人都可以取消任何一条**。
  // 这是熟人小圈子的取舍——点错了谁都能撤回，比"只有本人能撤"更实用。
  // 代价是理论上可被恶意取消，用户已知悉并接受。前端仍会弹二次确认。
  // 保留 isOrderer / isOwner 的计算仅为将来收紧权限留个抓手。
  const _canCancelAny = true;
  if (!_canCancelAny && !isOrderer && !resolved.isOwner) {
    unauthorized('只有点菜人本人或主人家可以取消');
  }

  // 幂等：已经取消过的不再重复处理
  if (order.status === ORDER_STATUS.CANCELLED) return {};

  const ts = now();
  await orders().doc(id).update({
    data: {
      status: ORDER_STATUS.CANCELLED,
      cancelledAt: ts,
      cancelledBy: ctx.openid,
    },
  });

  // 【v1.0.8 §4.1】不再回退 cookedCount —— 点菜没有 +1，就不该 -1，否则会扣坏历史「已做次数」

  return {};
}

module.exports = {
  create: create,
  list: list,
  done: done,
  cancel: cancel,
  findOrder: findOrder,
  ORDER_STATUS: ORDER_STATUS,
};
