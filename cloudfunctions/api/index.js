/**
 * 云函数 api —— 唯一入口，按 action 路由（SPEC §4）。
 *
 * 调用方式：wx.cloud.callFunction({ name: 'api', data: { action, payload } })
 * 返回信封：{ ok: true, data } / { ok: false, code, message }
 *
 * 两条硬规则：
 *  1. openid 只从 cloud.getWXContext().OPENID 取，任何 payload 里的 openid 一律忽略；
 *  2. 所有异常都被下面的统一 try/catch 兜住，堆栈只进日志，不出网。
 */

const { cloud } = require('./lib/db');
const { ok, fail, invalid, unauthorized } = require('./lib/response');

const login = require('./routes/login');
const dish = require('./routes/dish');
const order = require('./routes/order');

/** action -> 处理函数（SPEC §4 表格全量） */
const ROUTES = {
  login: login,
  'dish.list': dish.list,
  'dish.get': dish.get,
  'dish.create': dish.create,
  'dish.update': dish.update,
  'dish.remove': dish.remove,
  'dish.mine': dish.mine,
  'dish.reviewList': dish.reviewList,
  'dish.review': dish.review,
  'order.create': order.create,
  'order.list': order.list,
  'order.done': order.done,
};

function readPayload(event) {
  if (!event || typeof event !== 'object') return {};
  const payload = event.payload;
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
}

exports.main = async function main(event) {
  try {
    const action = event && typeof event.action === 'string' ? event.action.trim() : '';
    if (!action) invalid('缺少 action 参数');

    // hasOwnProperty 校验：避免 action='constructor'/'toString' 命中原型链上的函数
    const hasRoute = Object.prototype.hasOwnProperty.call(ROUTES, action);
    const handler = hasRoute ? ROUTES[action] : null;
    if (typeof handler !== 'function') invalid('不支持的 action：' + action);

    // 身份唯一来源：云调用上下文。payload 里的 openid 一律不认。
    const wxContext = cloud.getWXContext();
    const openid = wxContext && wxContext.OPENID ? wxContext.OPENID : '';
    if (!openid) unauthorized('未能识别当前用户身份，请在小程序内调用');

    const data = await handler({ openid: openid, payload: readPayload(event), context: wxContext });
    return ok(data);
  } catch (err) {
    if (err && err.__apiError) {
      return fail(err.code, err.message);
    }
    // 意外异常：日志留全量堆栈，客户端只拿到通用中文提示
    console.error('[api] 未捕获异常', err && (err.stack || err.message || err));
    return fail('INTERNAL', '服务器开小差了，请稍后再试');
  }
};

exports.ROUTES = ROUTES;
