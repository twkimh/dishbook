/**
 * 云环境/数据库句柄 + meta 单文档（角色）读写。
 * 角色判定与自举全部集中在这里，路由层不直接碰 meta。
 */

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const COLLECTIONS = {
  DISHES: 'dishes',
  ORDERS: 'orders',
  META: 'meta',
};

const META_ID = 'app';

/** meta 单文档不存在时的默认形状（SPEC §3）。 */
function defaultMeta() {
  return {
    _id: META_ID,
    ownerOpenids: [],
    subscribeTemplateId: '',
    subscribeDataMap: null,
    // 模板 B：点菜者收「你已成功下单」；存量文档没有这两个字段，读出来按空串/null 处理
    orderConfirmTemplateId: '',
    orderConfirmDataMap: null,
    ownerNickname: '',
  };
}

function normalizeMeta(doc) {
  const base = defaultMeta();
  if (!doc || typeof doc !== 'object') return base;
  const owners = Array.isArray(doc.ownerOpenids)
    ? doc.ownerOpenids.filter(function (item) {
        return typeof item === 'string' && item.length > 0;
      })
    : [];
  return {
    _id: META_ID,
    ownerOpenids: owners,
    subscribeTemplateId:
      typeof doc.subscribeTemplateId === 'string' ? doc.subscribeTemplateId : '',
    subscribeDataMap:
      doc.subscribeDataMap && typeof doc.subscribeDataMap === 'object'
        ? doc.subscribeDataMap
        : null,
    orderConfirmTemplateId:
      typeof doc.orderConfirmTemplateId === 'string' ? doc.orderConfirmTemplateId : '',
    orderConfirmDataMap:
      doc.orderConfirmDataMap && typeof doc.orderConfirmDataMap === 'object'
        ? doc.orderConfirmDataMap
        : null,
    ownerNickname: typeof doc.ownerNickname === 'string' ? doc.ownerNickname : '',
  };
}

/**
 * 用 where + limit(1) 读 meta，避免 doc().get() 在文档不存在时抛异常
 * （云数据库 doc.get 在缺失文档上的报错形态随 SDK 版本不同，这里规避掉）。
 */
async function readMeta() {
  const res = await db
    .collection(COLLECTIONS.META)
    .where({ _id: META_ID })
    .limit(1)
    .get();
  const doc = res && Array.isArray(res.data) ? res.data[0] : null;
  return doc ? normalizeMeta(doc) : null;
}

async function writeMeta(patch) {
  const payload = Object.assign({}, patch, { updatedAt: Date.now() });
  // doc(id).set 的 data 里不能带 _id（会报不可更新字段），id 由 doc() 决定
  delete payload._id;
  await db
    .collection(COLLECTIONS.META)
    .doc(META_ID)
    .set({ data: payload });
  return readMeta();
}

/**
 * 自举：meta 文档不存在或 ownerOpenids 为空数组时，当前调用者成为主人家并写库。
 * 只在确实没有主人家时触发，一旦有了主人家就永不再自举。
 *
 * 【安全】只能由 routes/login.js 的 login 调用（SPEC §3：第一个调用 login 的人成为主人家）。
 * 绝不能放进 resolveContext —— 否则任意 action 被陌生访客抢先调用一次就会造成权限提升。
 */
async function bootstrapOwner(openid) {
  const current = await readMeta();
  if (current && current.ownerOpenids.length > 0) return current;

  if (!current) {
    const created = defaultMeta();
    created.ownerOpenids = [openid];
    console.warn('[meta] meta/app 不存在，自举主人家：', openid);
    return writeMeta(created);
  }

  // writeMeta 走的是整文档 set，必须把已读到的 current 一并带上，
  // 否则会抹掉 subscribeTemplateId / subscribeDataMap / ownerNickname 等既有配置
  const merged = Object.assign({}, current, { ownerOpenids: [openid] });
  console.warn('[meta] ownerOpenids 为空，自举主人家：', openid);
  const patched = await writeMeta(merged);
  return patched || merged;
}

/**
 * 角色判定：纯读取，无副作用。
 * meta 缺失或 ownerOpenids 为空时一律按 guest 处理，不写库 —— 自举只走 login。
 * 返回 { meta, role, isOwner }。
 */
async function resolveContext(openid) {
  const meta = (await readMeta()) || defaultMeta();
  const isOwner = meta.ownerOpenids.indexOf(openid) !== -1;
  return {
    meta: meta,
    role: isOwner ? 'owner' : 'guest',
    isOwner: isOwner,
  };
}

function dishes() {
  return db.collection(COLLECTIONS.DISHES);
}

function orders() {
  return db.collection(COLLECTIONS.ORDERS);
}

const serverDate = function () {
  return Date.now();
};

module.exports = {
  cloud: cloud,
  db: db,
  _: _,
  COLLECTIONS: COLLECTIONS,
  META_ID: META_ID,
  defaultMeta: defaultMeta,
  readMeta: readMeta,
  writeMeta: writeMeta,
  bootstrapOwner: bootstrapOwner,
  resolveContext: resolveContext,
  dishes: dishes,
  orders: orders,
  now: serverDate,
};
