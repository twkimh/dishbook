/**
 * 云函数 api 的客户端唯一出口（SPEC §1 / §4）
 *
 * 调用方式：wx.cloud.callFunction({ name: 'api', data: { action, payload } })
 * 信封：{ ok: true, data } | { ok: false, code, message }
 *
 * 成功 -> resolve 信封里的 data
 * 失败 -> wx.showToast(message || '网络有点问题') 并 reject 一个带 message 的 Error
 *          (Error 额外带 code / action 字段，便于调用方按 code 做分支)
 *
 * 客户端不直接调用 wx.cloud.database()，所有读写都必须经过本文件。
 */

var FUNCTION_NAME = 'api';
var FALLBACK_MESSAGE = '网络有点问题';

function toast(message) {
  wx.showToast({
    title: message,
    icon: 'none',
    duration: 2000
  });
}

function buildError(message, code, action, cause) {
  var error = new Error(message);
  error.code = code;
  error.action = action;
  if (cause) {
    error.cause = cause;
  }
  return error;
}

function call(action, payload) {
  return wx.cloud.callFunction({
    name: FUNCTION_NAME,
    data: { action: action, payload: payload || {} }
  }).then(
    function onSuccess(res) {
      var envelope = res ? res.result : null;
      if (envelope && envelope.ok === true) {
        return envelope.data;
      }
      var message = (envelope && envelope.message) || FALLBACK_MESSAGE;
      var code = (envelope && envelope.code) || 'INTERNAL';
      console.error('[api] ' + action + ' 失败', code, message);
      toast(message);
      throw buildError(message, code, action);
    },
    function onFailure(err) {
      console.error('[api] ' + action + ' 调用异常', err);
      toast(FALLBACK_MESSAGE);
      throw buildError(FALLBACK_MESSAGE, 'INTERNAL', action, err);
    }
  );
}

/* ---------- 账号 ---------- */

// login(payload = {}) -> { openid, role: 'owner'|'guest', hasTemplate }
function login() {
  return call('login', {});
}

// profileGet() -> { nickname, avatar }
// avatar 是云存储 fileID 或后端转好的 https 临时链接，两者都能直接用于 <image src>
function profileGet() {
  return call('profile.get', {});
}

// profileSave({ nickname, avatar }) -> { nickname, avatar }
// avatar 传云存储 fileID（可为空串）
function profileSave(profile) {
  var p = profile || {};
  return call('profile.save', {
    nickname: p.nickname || '',
    avatar: p.avatar || ''
  });
}

/* ---------- 菜品 ---------- */

// dishList({ keyword?, tag?, page=1, pageSize=20 }) -> { list, total, hasMore }
function dishList(params) {
  return call('dish.list', params || {});
}

// dishGet(id) -> Dish
function dishGet(id) {
  return call('dish.get', { id: id });
}

// dishCreate({ name, cover, images, story, tags }) -> { id, status }
function dishCreate(dish) {
  return call('dish.create', dish || {});
}

// dishUpdate({ id, name, cover, images, story, tags }) -> { id, status }
// status 可能是 'pending'：访客编辑已上架的菜会自动退回待审核，
// 调用方应据此提示「修改已提交，等主人家审核」。
function dishUpdate(dish) {
  return call('dish.update', dish || {});
}

// dishRemove(id) -> {}
function dishRemove(id) {
  return call('dish.remove', { id: id });
}

// dishMine({ page, pageSize }) -> { list, total, hasMore }
function dishMine(params) {
  return call('dish.mine', params || {});
}

// dishReviewList({ page, pageSize }) -> { list, total, hasMore }
function dishReviewList(params) {
  return call('dish.reviewList', params || {});
}

// dishReview(id, accept) -> { status }
function dishReview(id, accept) {
  return call('dish.review', { id: id, accept: !!accept });
}

/* ---------- 点菜 ---------- */

// orderCreate(dishId, note, profile) -> { id, notifyState }
// profile: { nickname, avatar }。后端 order.create 从 payload.nickname / payload.avatar 取点菜人，
// 不传则点菜记录与订阅消息里的「谁点的菜」会是空串。
function orderCreate(dishId, note, profile) {
  var p = profile || {};
  return call('order.create', {
    dishId: dishId,
    note: note || '',
    nickname: p.nickname || '',
    avatar: p.avatar || ''
  });
}

// orderList({ page, pageSize, status? }) -> { list, total, hasMore }
function orderList(params) {
  return call('order.list', params || {});
}

// orderDone(id) -> {}
function orderDone(id) {
  return call('order.done', { id: id });
}

module.exports = {
  login: login,
  profileGet: profileGet,
  profileSave: profileSave,
  dishList: dishList,
  dishGet: dishGet,
  dishCreate: dishCreate,
  dishUpdate: dishUpdate,
  dishRemove: dishRemove,
  dishMine: dishMine,
  dishReviewList: dishReviewList,
  dishReview: dishReview,
  orderCreate: orderCreate,
  orderList: orderList,
  orderDone: orderDone
};
