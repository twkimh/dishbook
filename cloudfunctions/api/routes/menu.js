/**
 * menus 相关 action：current / start / close / list / detail（SPEC-v1.0.8 §2.1）。
 *
 * 三条硬规则：
 *  1. 同一时刻只允许一个 status='open' 的菜单 —— start 时先把所有 open 的关掉再建新的；
 *  2. 是否到期只由 endsAt 判断，**不改数据库里的 status**（保持数据真实），
 *     出参带 expired 布尔，order.create 也按同一规则拒绝点菜；
 *  3. 权限：start / close 仅主人家，current / list / detail 所有人。
 */

const { _, dishes, orders, menus, resolveContext, now } = require('../lib/db');
const { unauthorized, notFound, invalid } = require('../lib/response');
const { LIMITS, pickText, pickId, pickPaging, listResult } = require('../lib/validate');
const { attachTempUrls } = require('../lib/storage');
const { normalizePeople } = require('./dish');

const MENU_STATUS = {
  OPEN: 'open',
  CLOSED: 'closed',
};

/** mealType 只允许这四个值，非法值归一为晚餐（防御式，不报错）。 */
const MEAL_TYPES = ['早餐', '午餐', '晚餐', '夜宵'];
const DEFAULT_MEAL_TYPE = '晚餐';
const DEFAULT_TITLE = '点菜单';

/** 一次性读订单/菜品的批量上限（云开发单次 limit 上限 100）。 */
const FETCH_PAGE = 100;
const ORDER_FETCH_MAX_PAGES = 5;

/** 出参要转临时链接的图片字段：每道菜的封面 + 谁点的头像 + 想吃的人的头像（后两个是对象数组的元素字段）。 */
const DETAIL_IMAGE_FIELDS = ['dishCover', 'orders.avatar', 'wants.avatar'];

/**
 * 已取消的点菜记录不参与点菜单聚合（v1.0.8）。
 * 本地常量而非从 order.js 取：order.js 依赖本文件，反向 require 会成环。
 */
const ORDER_STATUS_CANCELLED = 'cancelled';

/** endsAt 已过即视为结束；endsAt 为空表示不预设结束时间（只能手动关）。 */
function isExpired(menu) {
  if (!menu || typeof menu !== 'object') return false;
  const endsAt = menu.endsAt;
  return typeof endsAt === 'number' && Number.isFinite(endsAt) && endsAt > 0 && Date.now() > endsAt;
}

/** 出参整形：只新增 expired / reviewedAt / review 三个键（后两个 v1.0.8 §4.2），其它字段原样带出（含 _id）。 */
function shapeMenu(menu) {
  if (!menu || typeof menu !== 'object') return menu;
  const out = Object.assign({}, menu);
  out.expired = isExpired(menu);
  // 存量菜单没有这两个字段：统一补成 null，前端不用判 undefined
  out.reviewedAt =
    typeof menu.reviewedAt === 'number' && Number.isFinite(menu.reviewedAt) ? menu.reviewedAt : null;
  out.review =
    menu.review && typeof menu.review === 'object' && !Array.isArray(menu.review) ? menu.review : null;
  return out;
}

/** 按 id 取菜单；不存在返回 null。 */
async function findMenu(id) {
  try {
    const res = await menus().doc(id).get();
    return res && res.data ? res.data : null;
  } catch (err) {
    console.warn('[menu] 读取失败或不存在', id, err && (err.errCode || err.message));
    return null;
  }
}

/**
 * 当前 open 的菜单（最多一条）。
 * startsAt 倒序取第一条；数据库里可能存在的多条 open 由 start 负责收敛。
 */
async function findOpenMenu() {
  try {
    const res = await menus()
      .where({ status: MENU_STATUS.OPEN })
      .orderBy('startedAt', 'desc')
      .limit(1)
      .get();
    const doc = res && Array.isArray(res.data) ? res.data[0] : null;
    return doc || null;
  } catch (err) {
    console.warn('[menu] 读取当前菜单失败', err && (err.errCode || err.message));
    return null;
  }
}

/** 把所有 open 的菜单改为 closed。批量更新不可用时逐条更新，绝不让 start 失败。 */
async function closeAllOpen(ts) {
  let list = [];
  try {
    const res = await menus().where({ status: MENU_STATUS.OPEN }).limit(20).get();
    list = res && Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    console.warn('[menu] 读取 open 菜单失败', err && (err.errCode || err.message));
    return 0;
  }

  const patch = { status: MENU_STATUS.CLOSED, closedAt: ts };
  let closed = 0;
  for (let i = 0; i < list.length; i += 1) {
    const doc = list[i];
    if (!doc || typeof doc._id !== 'string' || !doc._id) continue;
    try {
      await menus().doc(doc._id).update({ data: patch });
      closed += 1;
    } catch (err) {
      console.warn('[menu] 关闭菜单失败', doc._id, err && (err.errCode || err.message));
    }
  }
  return closed;
}

/** 用餐类型归一：只认白名单，其余（含缺失/非字符串）一律晚餐。 */
function normalizeMealType(value) {
  if (typeof value !== 'string') return DEFAULT_MEAL_TYPE;
  const text = value.trim();
  return MEAL_TYPES.indexOf(text) === -1 ? DEFAULT_MEAL_TYPE : text;
}

/** 人数：缺失/非数字 -> 0；小数取整；越界夹到 0~99。 */
function pickHeadcount(value) {
  if (value === undefined || value === null || value === '') return 0;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  const fixed = Math.floor(num);
  return fixed > LIMITS.MENU_HEADCOUNT_MAX ? LIMITS.MENU_HEADCOUNT_MAX : fixed;
}

/** endsAt：缺省 / 非数字 / 非正数 -> null（不预设结束时间）。 */
function pickEndsAt(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.floor(num);
}

/** 云函数运行在 UTC，dateText 按东八区（UTC+8）取年月日。 */
function formatDateText(ts) {
  const d = new Date(ts + 8 * 3600 * 1000);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return year + '-' + (month < 10 ? '0' + month : month) + '-' + (day < 10 ? '0' + day : day);
}

/** menu.current —— 当前 open 的菜单或 null（过期只在出参上标 expired，不改库）。 */
async function current(ctx) {
  const menu = await findOpenMenu();
  if (!menu) return null;
  return shapeMenu(menu);
}

/** menu.start —— 主人家开新菜单；先把所有 open 的关掉（同一时刻只允许一个 open）。 */
async function start(ctx) {
  const resolved = await resolveContext(ctx.openid);
  if (!resolved.isOwner) unauthorized('只有主人家可以开点菜单');

  const payload = ctx.payload || {};
  const title = pickText(payload.title, {
    field: 'title',
    label: '菜单标题',
    max: LIMITS.MENU_TITLE_MAX,
  });
  const dateText = pickText(payload.dateText, {
    field: 'dateText',
    label: '日期',
    max: LIMITS.MENU_DATE_MAX,
  });
  const mealType = normalizeMealType(payload.mealType);
  const headcount = pickHeadcount(payload.headcount);
  const endsAt = pickEndsAt(payload.endsAt);
  const ts = now();

  await closeAllOpen(ts);

  const doc = {
    ownerOpenid: ctx.openid,
    title: title || DEFAULT_TITLE,
    dateText: dateText || formatDateText(ts),
    mealType: mealType,
    headcount: headcount,
    status: MENU_STATUS.OPEN,
    startedAt: ts,
    endsAt: endsAt,
    closedAt: null,
    // v1.0.8 §4.2：结束确认相关，建菜单时都是空的
    reviewedAt: null,
    review: null,
  };

  const res = await menus().add({ data: doc });
  return shapeMenu(Object.assign({}, doc, { _id: res && res._id ? res._id : '' }));
}

/** menu.close —— 主人家手动收起当前菜单。 */
async function close(ctx) {
  const resolved = await resolveContext(ctx.openid);
  if (!resolved.isOwner) unauthorized('只有主人家可以关闭点菜单');

  await closeAllOpen(now());
  return {};
}

/** menu.list —— 历史菜单，按 startedAt 倒序分页。 */
async function list(ctx) {
  const paging = pickPaging(ctx.payload);

  const countRes = await menus().count();
  const total = countRes && typeof countRes.total === 'number' ? countRes.total : 0;
  const listRes = await menus()
    .orderBy('startedAt', 'desc')
    .skip(paging.skip)
    .limit(paging.pageSize)
    .get();

  const raw = listRes && Array.isArray(listRes.data) ? listRes.data : [];
  const shaped = [];
  for (let i = 0; i < raw.length; i += 1) shaped.push(shapeMenu(raw[i]));
  return listResult(shaped, total, paging);
}

/** 按 menuId 取订单（分页拉全，最多 5 页 500 条；读失败只降级为空）。 */
async function fetchOrders(menuId) {
  const out = [];
  for (let page = 0; page < ORDER_FETCH_MAX_PAGES; page += 1) {
    let batch = [];
    try {
      const res = await orders()
        .where({ menuId: menuId })
        .orderBy('createdAt', 'asc')
        .skip(page * FETCH_PAGE)
        .limit(FETCH_PAGE)
        .get();
      batch = res && Array.isArray(res.data) ? res.data : [];
    } catch (err) {
      console.warn('[menu] 读取订单失败', menuId, err && (err.errCode || err.message));
      break;
    }
    for (let i = 0; i < batch.length; i += 1) out.push(batch[i]);
    if (batch.length < FETCH_PAGE) break;
  }
  return out;
}

/** 按 dishId 批量取菜品（400 上限，分批 100）；拿不到的菜直接缺省，不影响详情。 */
async function fetchDishes(dishIds) {
  const map = {};
  for (let start = 0; start < dishIds.length; start += FETCH_PAGE) {
    const chunk = dishIds.slice(start, start + FETCH_PAGE);
    try {
      const res = await dishes().where({ _id: _.in(chunk) }).limit(chunk.length).get();
      const rows = res && Array.isArray(res.data) ? res.data : [];
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        if (row && typeof row._id === 'string') map[row._id] = row;
      }
    } catch (err) {
      console.warn('[menu] 读取菜品失败', err && (err.errCode || err.message));
    }
  }
  return map;
}

/**
 * menu.detail —— 按 dishId 聚合该菜单下的点菜记录。
 * 菜名/封面一律取订单快照（菜被删了也不丢）；wants 只能来自 dishes，菜没了就是空数组。
 */
async function detail(ctx) {
  const id = pickId(ctx.payload && ctx.payload.id, '菜单 id');
  const menu = await findMenu(id);
  if (!menu) notFound('点菜单不存在或已被删除');

  const rows = await fetchOrders(id);
  const buckets = {};
  const dishesOut = [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || typeof row !== 'object') continue;
    // 已取消的点菜记录不计入点菜单（否则取消了还显示在菜单里）
    if (row.status === ORDER_STATUS_CANCELLED) continue;
    const dishId = typeof row.dishId === 'string' ? row.dishId : '';
    if (!dishId) continue;

    let bucket = buckets[dishId];
    if (!bucket) {
      bucket = {
        dishId: dishId,
        dishName: typeof row.dishName === 'string' ? row.dishName : '',
        dishCover: typeof row.dishCover === 'string' ? row.dishCover : '',
        orders: [],
        orderCount: 0,
        wants: [],
      };
      buckets[dishId] = bucket;
      dishesOut.push(bucket);
    }
    if (!bucket.dishName && typeof row.dishName === 'string' && row.dishName) {
      bucket.dishName = row.dishName;
    }
    if (!bucket.dishCover && typeof row.dishCover === 'string' && row.dishCover) {
      bucket.dishCover = row.dishCover;
    }

    const orderer =
      row.orderer && typeof row.orderer === 'object' && !Array.isArray(row.orderer)
        ? row.orderer
        : {};
    bucket.orders.push({
      // 带上订单 id：点菜人本人要能取消自己那一份，主人家也要能取消任意一份。
      // 客户端原本只能通过「主人家专属」的 order.list 反查 id，导致访客无法取消自己的点菜。
      orderId: typeof row._id === 'string' ? row._id : '',
      openid: typeof orderer.openid === 'string' ? orderer.openid : '',
      nickname: typeof orderer.nickname === 'string' ? orderer.nickname : '',
      avatar: typeof orderer.avatar === 'string' ? orderer.avatar : '',
      note: typeof row.note === 'string' ? row.note : '',
      createdAt: typeof row.createdAt === 'number' ? row.createdAt : 0,
    });
  }

  const dishMap = await fetchDishes(Object.keys(buckets));
  for (let i = 0; i < dishesOut.length; i += 1) {
    const bucket = dishesOut[i];
    // 去掉 cancelled 之后的真实点菜条数，方便前端判断「这道菜还有没有人点」
    bucket.orderCount = bucket.orders.length;
    const dish = dishMap[bucket.dishId];
    if (!dish) continue;
    if (!bucket.dishName && typeof dish.name === 'string' && dish.name) bucket.dishName = dish.name;
    bucket.wants = normalizePeople(dish.wants, true);
  }

  // 封面 + 想吃的人头像换临时链接（对象数组元素字段）
  const attached = await attachTempUrls(dishesOut, { fields: DETAIL_IMAGE_FIELDS });
  const list = Array.isArray(attached) ? attached : dishesOut;
  for (let i = 0; i < list.length; i += 1) list[i].wants = normalizePeople(list[i].wants, true);

  return { menu: shapeMenu(menu), dishes: list };
}

/* ---------------------------------------------- v1.0.8 §4：结束确认 */

const DECISION = {
  DONE: 'done',
  MISSED: 'missed',
};

/** 单条读菜品（review 要逐菜累加，便于逐菜 try/catch）。读不到返回 null。 */
async function readDish(dishId) {
  try {
    const res = await dishes().doc(dishId).get();
    return res && res.data ? res.data : null;
  } catch (err) {
    console.warn('[menu] 读取菜品失败', dishId, err && (err.errCode || err.message));
    return null;
  }
}

/**
 * menu.review —— 主人家结束一轮点菜单后，逐菜确认「已做 / 没做」（SPEC-v1.0.8 §4.3）。
 * 这是 cookedCount 唯一的增加点：一道菜 +1 一次，与这一轮有几个人点它无关。
 */
async function review(ctx) {
  const resolved = await resolveContext(ctx.openid);
  if (!resolved.isOwner) unauthorized('只有主人家可以确认这一轮');

  const payload = ctx.payload || {};
  const id = pickId(payload.id, '菜单 id');
  const menu = await findMenu(id);
  if (!menu) notFound('点菜单不存在或已被删除');

  // 规则 1：只有已结束的菜单才能确认
  if (menu.status !== MENU_STATUS.CLOSED) invalid('先结束这一轮再确认');

  // 规则 2：确认过的结果锁定，防止重复累加
  if (menu.reviewedAt !== null && menu.reviewedAt !== undefined) invalid('这一轮已经确认过了');

  const rawDecisions =
    payload.decisions && typeof payload.decisions === 'object' && !Array.isArray(payload.decisions)
      ? payload.decisions
      : {};

  // 归一：只有显式 'done' 才算已做，其余（含非法值 / 缺失）一律按 missed
  const reviewMap = {};
  const doneIds = [];
  const decisionIds = Object.keys(rawDecisions);
  for (let i = 0; i < decisionIds.length; i += 1) {
    const dishId = decisionIds[i];
    if (!dishId) continue;
    if (rawDecisions[dishId] === DECISION.DONE) {
      reviewMap[dishId] = DECISION.DONE;
      doneIds.push(dishId);
    } else {
      reviewMap[dishId] = DECISION.MISSED;
    }
  }

  // 规则 4：本轮点过（且未取消）但 decisions 没提到的菜，按 missed 记下，不累加
  const rows = await fetchOrders(id);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || typeof row !== 'object') continue;
    if (row.status === ORDER_STATUS_CANCELLED) continue;
    const dishId = typeof row.dishId === 'string' ? row.dishId : '';
    if (!dishId || reviewMap[dishId]) continue;
    reviewMap[dishId] = DECISION.MISSED;
  }

  // 规则 3 / 6：逐菜累加，单条失败只告警，绝不中断整轮确认
  const ts = now();
  for (let i = 0; i < doneIds.length; i += 1) {
    const dishId = doneIds[i];
    try {
      const dish = await readDish(dishId);
      // 菜已被删除：跳过累加，但 reviewMap 里仍然记着这个 dishId
      if (!dish) continue;
      // 缺失 / 非数字一律按 0 起算
      const current =
        typeof dish.cookedCount === 'number' && Number.isFinite(dish.cookedCount)
          ? dish.cookedCount
          : 0;
      await dishes().doc(dishId).update({ data: { cookedCount: _.set(current + 1) } });
    } catch (err) {
      console.warn('[menu] cookedCount 累加失败', dishId, err && (err.errCode || err.message));
    }
  }

  // 规则 5：写 menus.review + reviewedAt
  // ⚠️ review 必须用 _.set() 整体替换：云开发的 update 会把嵌套对象摊平成点路径
  //    （{review:{id:'missed'}} → $set{'review.id':...}），而 review 初始值是 null，
  //    在 null 里创建子字段会报 "Cannot create field ... in element {review: null}"。
  await menus().doc(id).update({ data: { review: _.set(reviewMap), reviewedAt: ts } });
  return { reviewedAt: ts, review: reviewMap };
}

module.exports = {
  current: current,
  start: start,
  close: close,
  list: list,
  detail: detail,
  review: review,
  MENU_STATUS: MENU_STATUS,
  MEAL_TYPES: MEAL_TYPES,
  DECISION: DECISION,
  isExpired: isExpired,
  findOpenMenu: findOpenMenu,
  shapeMenu: shapeMenu,
};
