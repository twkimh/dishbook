/**
 * orders 相关 action：create / list / done
 * 契约见 SPEC §4 表格。要点：
 *  - order.create 落库 -> cookedCount 原子 +1 -> 双订阅消息（模板 A 主人家 / 模板 B 点菜者，各自独立降级）
 *  - order.list / order.done 仅主人家
 */

const { _, dishes, orders, resolveContext, now } = require('../lib/db');
const { unauthorized, notFound, invalid } = require('../lib/response');
const { LIMITS, pickText, pickId, pickPaging, listResult, pickProfile } = require('../lib/validate');
const { checkUserText, joinText } = require('../lib/security');
const { sendOrderNotice, sendOrderConfirmNotice, NOTIFY_STATE } = require('../lib/notify');
const { findDish, canSeeDish } = require('./dish');
const { attachTempUrls, isCloudFileId } = require('../lib/storage');

/**
 * 点菜记录里要转临时链接的图片字段（落库仍是 fileID 原文）：
 * 下单时的菜品封面快照 + 点菜者头像（一层嵌套字段）。
 */
const IMAGE_FIELDS = ['dishCover', 'orderer.avatar'];

const ORDER_STATUS = {
  NEW: 'new',
  DONE: 'done',
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

  // 被点次数原子自增（约束 9）：用 _.inc(1)，绝不读-改-写
  try {
    await dishes()
      .doc(dishId)
      .update({ data: { cookedCount: _.inc(1) } });
  } catch (err) {
    console.warn('[order] cookedCount 自增失败', dishId, err && (err.errCode || err.message));
  }

  // 订阅消息：两条互相独立降级，失败只记 notifyState / confirmNotifyState，绝不影响下单成功
  const notifyVars = {
    dishName: doc.dishName,
    dishId: dishId,
    note: doc.note,
    nickname: profile.nickname,
    time: ts,
    count: typeof dish.cookedCount === 'number' ? dish.cookedCount + 1 : 1,
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
    if (status !== ORDER_STATUS.NEW && status !== ORDER_STATUS.DONE) {
      invalid('status 只能是 new 或 done');
    }
    where = { status: status };
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

  await orders().doc(id).update({ data: { status: ORDER_STATUS.DONE } });
  return {};
}

module.exports = {
  create: create,
  list: list,
  done: done,
  findOrder: findOrder,
  ORDER_STATUS: ORDER_STATUS,
};
