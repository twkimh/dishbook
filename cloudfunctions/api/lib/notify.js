/**
 * 订阅消息（SPEC §4「订阅消息」/ 约束 6）。
 * 任何失败都只体现在 notifyState / confirmNotifyState 上，绝不影响下单成功。
 *
 * 双模板，完全独立降级：
 *  - 模板 A（主人家收「有人点菜了」）：meta.subscribeTemplateId + meta.subscribeDataMap
 *  - 模板 B（点菜者收「你已成功下单」）：meta.orderConfirmTemplateId + meta.orderConfirmDataMap
 * 任一模板没配 / 发送失败，都不影响下单成功，也不影响另一条消息的发送。
 */

const { cloud } = require('./db');

const NOTIFY_PAGE = 'pages/orders/orders';
const NOTIFY_STATE = {
  SENT: 'sent',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

/** 字段映射缺失时的兜底映射（模板字段名不可预知）。两套映射共用。 */
const DEFAULT_DATA_MAP = {
  thing1: 'dishName',
  thing2: 'nickname',
  thing3: 'note',
};

/** token 别名：历史写法映射到 vars 的规范键。 */
const TOKEN_ALIAS = {
  name: 'dishName',
  ordererNickname: 'nickname',
};

/** 派生 token 的固定值（confirmStatus）。 */
const CONFIRM_STATUS_TEXT = '已下单，等主人家开做';

const MEAL_TYPE = {
  BREAKFAST: '早餐',
  LUNCH: '午餐',
  TEATIME: '下午茶',
  DINNER: '晚餐',
  LATENIGHT: '夜宵',
};

/** thing 类型字段最多 20 字，超长微信会拒绝整条消息。 */
const THING_MAX = 20;
const TEXT_MAX = 32;
/** thing / time 类型不接受空值，取不到就给兜底文案，绝不省略整个键。 */
const EMPTY_FALLBACK = '（无）';

function pad2(num) {
  return num < 10 ? '0' + num : String(num);
}

/** time 类型字段必须是人可读格式，用本地时区（不转 UTC）：YYYY年MM月DD日 HH:mm。 */
function formatTime(value) {
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts);
  return (
    d.getFullYear() +
    '年' +
    pad2(d.getMonth() + 1) +
    '月' +
    pad2(d.getDate()) +
    '日 ' +
    pad2(d.getHours()) +
    ':' +
    pad2(d.getMinutes())
  );
}

/** 按点菜时间推断餐段：5-10 早餐 / 11-14 午餐 / 15-17 下午茶 / 18-22 晚餐 / 其余 夜宵；时间戳非法给空串。 */
function getMealType(value) {
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const hour = new Date(ts).getHours(); // 本地时区
  if (hour >= 5 && hour < 11) return MEAL_TYPE.BREAKFAST;
  if (hour >= 11 && hour < 15) return MEAL_TYPE.LUNCH;
  if (hour >= 15 && hour < 18) return MEAL_TYPE.TEATIME;
  if (hour >= 18 && hour < 23) return MEAL_TYPE.DINNER;
  return MEAL_TYPE.LATENIGHT;
}

/**
 * 按目标键名前缀做类型化处理（微信按模板里该字段的类型校验，类型不符会整条拒发）：
 *  - time*  -> 毫秒时间戳格式化为 `YYYY年MM月DD日 HH:mm`；非法值降级为空串（仍保留该键）
 *  - thing* -> 截断到 20 个 Unicode 字符（不加省略号，省略号也占字符）
 *  - 其它   -> 截断到 32 个 Unicode 字符
 */
function formatValue(key, value) {
  const name = String(key === undefined || key === null ? '' : key).toLowerCase();
  if (name.indexOf('time') === 0) {
    // 格式化结果不再走 thing 的 20 字截断，只保留 TEXT_MAX 语义
    return formatTime(value);
  }
  const text = String(value === undefined || value === null ? '' : value).trim();
  const isThing = name.indexOf('thing') === 0;
  const limit = isThing ? THING_MAX : TEXT_MAX;
  const chars = Array.from(text); // 按 Unicode 字符数截断，不是字节
  const clipped = chars.length <= limit ? text : chars.slice(0, limit).join('');
  if (!clipped) return isThing ? EMPTY_FALLBACK : '';
  return clipped;
}

/** 非空对象才算一份可用映射，其余（null / 非对象 / 空对象）一律返回 null。 */
function normalizeMap(map) {
  return map && typeof map === 'object' && Object.keys(map).length > 0 ? map : null;
}

/**
 * 字段映射里 value 允许的来源 token；未知 token 取空串，不报错。
 * vars 是 token -> 实际值的字典：
 *   { dishName|name, nickname, note, dishId, time, count, mealType, confirmStatus }
 */
function resolveToken(token, vars) {
  const key = String(token === undefined || token === null ? '' : token).trim();
  if (!key) return '';
  const canonical = TOKEN_ALIAS[key] || key;
  const value = vars && typeof vars === 'object' ? vars[canonical] : undefined;
  return value === undefined || value === null ? '' : value;
}

/** 补齐派生 token（mealType 由 time 推断，confirmStatus 为固定文案），调用方传什么都不会覆盖非空值。 */
function withDerivedTokens(vars) {
  const out = Object.assign({}, vars && typeof vars === 'object' ? vars : {});
  if (out.mealType === undefined || out.mealType === null || out.mealType === '') {
    out.mealType = getMealType(out.time);
  }
  if (
    out.confirmStatus === undefined ||
    out.confirmStatus === null ||
    out.confirmStatus === ''
  ) {
    out.confirmStatus = CONFIRM_STATUS_TEXT;
  }
  return out;
}

/** 映射表里是否至少有一个 token 能取到值（用于「全部不可识别时退回兜底映射」）。 */
function hasUsableToken(map, vars) {
  const source = normalizeMap(map);
  if (!source) return false;
  return Object.keys(source).some(function (field) {
    const raw = resolveToken(source[field], vars);
    return raw !== undefined && raw !== null && String(raw).trim() !== '';
  });
}

/**
 * 把映射表翻译成 subscribeMessage.send 需要的 data。
 * 映射表里出现的每一个键都会出现在 data 里（取不到值给兜底值，绝不漏键）。
 * @param {object|null} map         首选映射（可空）
 * @param {object} vars             token -> 值
 * @param {object} [fallbackMap]    map 为空时的兜底映射，默认 DEFAULT_DATA_MAP
 */
function buildData(map, vars, fallbackMap) {
  const source = normalizeMap(map) || normalizeMap(fallbackMap) || DEFAULT_DATA_MAP;
  const data = {};
  const fields = Object.keys(source);
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    data[field] = { value: formatValue(field, resolveToken(source[field], vars)) };
  }
  return data;
}

/**
 * 通用的订阅消息发送（模板 A / B 共用同一套 token 解析与降级逻辑）。
 * 绝不抛错：未配置模板或缺 touser 记 skipped，发送失败/异常记 failed。
 *
 * @param {object} options
 * @param {string} options.templateId  模板 ID，空则 skipped 且不调用发送接口
 * @param {string} options.touser      接收者 openid
 * @param {object|null} options.dataMap      字段映射，null 时用 fallbackMap
 * @param {object} [options.fallbackMap]     兜底字段映射
 * @param {object} options.vars        token -> 实际值（dishName/nickname/note/dishId/time/count）
 * @returns {Promise<'sent'|'failed'|'skipped'>}
 */
async function sendSubscribeMessage(options) {
  const opts = options || {};
  const templateId = typeof opts.templateId === 'string' ? opts.templateId.trim() : '';
  if (!templateId) {
    // 未配置模板：功能静默降级（SPEC §3），不调用发送接口
    return NOTIFY_STATE.SKIPPED;
  }

  const touser = typeof opts.touser === 'string' ? opts.touser.trim() : '';
  if (!touser) {
    console.warn('[notify] 接收者 openid 为空，跳过订阅消息');
    return NOTIFY_STATE.SKIPPED;
  }

  const fallbackMap = normalizeMap(opts.fallbackMap) || DEFAULT_DATA_MAP;
  // 派生 token（mealType / confirmStatus）只在这里补齐，调用方不用传
  const vars = withDerivedTokens(opts.vars);
  const dataMap = normalizeMap(opts.dataMap);

  let data = buildData(dataMap, vars, fallbackMap);
  // 映射表里的 token 全部无法识别（值全为空）时，退回兜底映射再试一次
  if (dataMap && !hasUsableToken(dataMap, vars)) {
    console.warn('[notify] 字段映射无可识别 token，改用兜底映射', JSON.stringify(dataMap));
    data = buildData(fallbackMap, vars, fallbackMap);
  }

  try {
    const res = await cloud.openapi.subscribeMessage.send({
      touser: touser,
      templateId: templateId,
      page: NOTIFY_PAGE,
      data: data,
    });
    if (res && typeof res.errCode === 'number' && res.errCode !== 0) {
      console.warn('[notify] subscribeMessage.send 返回错误码', res.errCode, res.errMsg);
      return NOTIFY_STATE.FAILED;
    }
    return NOTIFY_STATE.SENT;
  } catch (err) {
    // 发送失败只记 failed，绝不影响下单成功
    console.warn(
      '[notify] subscribeMessage.send 失败',
      err && (err.errCode !== undefined ? err.errCode : err.code),
      err && (err.errMsg || err.errMessage || err.message)
    );
    return NOTIFY_STATE.FAILED;
  }
}

/**
 * 模板 A：通知主人家「有人点菜了」。
 * @param {object} meta  meta 单文档
 * @param {object} vars  { dishName, dishId, note, nickname, time, count }
 * @returns {Promise<'sent'|'failed'|'skipped'>}
 */
async function sendOrderNotice(meta, vars) {
  const owners = meta && Array.isArray(meta.ownerOpenids) ? meta.ownerOpenids : [];
  if (owners.length === 0) {
    console.warn('[notify] 没有主人家 openid，跳过订阅消息');
  }
  return sendSubscribeMessage({
    templateId: meta && meta.subscribeTemplateId,
    touser: owners.length > 0 ? owners[0] : '',
    dataMap: meta ? meta.subscribeDataMap : null,
    fallbackMap: DEFAULT_DATA_MAP,
    vars: vars,
  });
}

/**
 * 模板 B：通知点菜者本人「你已成功下单」。
 * 点菜者可能就是主人家本人（自己点自己的菜），此时两条消息发给同一 openid，属正常情况，不去重。
 * @param {object} meta    meta 单文档
 * @param {string} touser  点菜者 openid（ctx.openid）
 * @param {object} vars    { dishName, dishId, note, nickname, time, count }
 * @returns {Promise<'sent'|'failed'|'skipped'>}
 */
async function sendOrderConfirmNotice(meta, touser, vars) {
  return sendSubscribeMessage({
    templateId: meta && meta.orderConfirmTemplateId,
    touser: touser,
    dataMap: meta ? meta.orderConfirmDataMap : null,
    fallbackMap: DEFAULT_DATA_MAP,
    vars: vars,
  });
}

module.exports = {
  NOTIFY_PAGE: NOTIFY_PAGE,
  NOTIFY_STATE: NOTIFY_STATE,
  DEFAULT_DATA_MAP: DEFAULT_DATA_MAP,
  buildData: buildData,
  sendSubscribeMessage: sendSubscribeMessage,
  sendOrderNotice: sendOrderNotice,
  sendOrderConfirmNotice: sendOrderConfirmNotice,
};
