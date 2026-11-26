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

// dishRemove(id, reason) -> 主人家 { id, deleted:true } / 创建者 { id, status:'pending' }
// v1.0.8 起改为软删除：主人家直接进回收站；创建者必须填理由并进审核队列
function dishRemove(id, reason) {
  return call('dish.remove', { id: id, reason: reason || '' });
}

// dishSetListed(id, listed) -> { id, listed }
// 下架 / 重新上架，创建者或主人家直接生效，不走审核
function dishSetListed(id, listed) {
  return call('dish.setListed', { id: id, listed: !!listed });
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

// orderCancel(id) -> {}
// 取消点菜：点菜人本人或主人家可以取消；取消后这条记录不再出现在点菜单里
function orderCancel(id) {
  return call('order.cancel', { id: id });
}

/* ---------- 修改提案（v1.0.8） ---------- */

// dishEdit(dish) -> { id, status }  status='approved' 表示主人家直接生效，'pending' 表示进了审核队列
function dishEdit(dish) {
  return call('dish.edit', dish || {});
}

// dishEditList({ page, pageSize }) -> { list, total, hasMore }  仅主人家
function dishEditList(params) {
  return call('dish.editList', params || {});
}

// dishEditReview(id, accept) -> { status }
function dishEditReview(id, accept) {
  return call('dish.editReview', { id: id, accept: !!accept });
}

// dishEditHistory(dishId, { page, pageSize }) -> { list, total, hasMore }
function dishEditHistory(dishId, params) {
  var p = params || {};
  return call('dish.editHistory', {
    dishId: dishId,
    page: p.page === undefined ? 1 : p.page,
    pageSize: p.pageSize === undefined ? 20 : p.pageSize
  });
}

// dishMyEdits({ page, pageSize, type }) -> { list, total, hasMore }
// 我提交过的修改 / 删除申请；type 传 'delete' 只看删除申请
function dishMyEdits(params) {
  var p = params || {};
  var payload = {
    page: p.page === undefined ? 1 : p.page,
    pageSize: p.pageSize === undefined ? 20 : p.pageSize
  };
  if (p.type) {
    payload.type = p.type;
  }
  return call('dish.myEdits', payload);
}

/* ---------- 喜欢 / 想吃（v1.0.8） ---------- */

// dishLike(id)   -> { liked:true,  likeCount, likes }
// dishUnlike(id) -> { liked:false, likeCount, likes }
function dishLike(id) {
  return call('dish.like', { id: id });
}

function dishUnlike(id) {
  return call('dish.unlike', { id: id });
}

// dishWant(id) -> { wants }   dishUnwant(id) -> { wants }
function dishWant(id) {
  return call('dish.want', { id: id });
}

function dishUnwant(id) {
  return call('dish.unwant', { id: id });
}

/* ---------- 点菜单（v1.0.8） ---------- */

// menuCurrent() -> 菜单对象或 null；菜单对象里带 expired 布尔
function menuCurrent() {
  return call('menu.current', {});
}

// menuStart({ title, dateText, mealType, headcount, endsAt }) -> 菜单对象  仅主人家
function menuStart(params) {
  var p = params || {};
  return call('menu.start', {
    title: p.title || '',
    dateText: p.dateText || '',
    mealType: p.mealType || '',
    headcount: p.headcount === undefined ? 0 : p.headcount,
    endsAt: p.endsAt === undefined ? null : p.endsAt
  });
}

// menuClose() -> {}  仅主人家
function menuClose() {
  return call('menu.close', {});
}

// menuList({ page, pageSize }) -> { list, total, hasMore }
function menuList(params) {
  return call('menu.list', params || {});
}

// menuDetail(id) -> { menu, dishes: [{ dishId, dishName, dishCover, orders:[...], wants:[...] }] }
function menuDetail(id) {
  return call('menu.detail', { id: id });
}

// menuReview(id, decisions) -> { reviewedAt, review }  仅主人家
// decisions: { [dishId]: 'done' | 'missed' }；一道菜 confirm 'done' 才让它的被点次数 +1
function menuReview(id, decisions) {
  return call('menu.review', { id: id, decisions: decisions || {} });
}

// dishOrderers(id) -> { people: [{ openid, nickname, avatar, times, lastAt }] }
// 历史上点过这道菜的人，按最近一次时间倒序
function dishOrderers(id) {
  return call('dish.orderers', { id: id });
}

/* ---------- 软删除 / 回收站（v1.0.8） ---------- */

// menuUpdate(id, fields) -> 更新后的菜单对象  仅主人家，已结束的不能改
function menuUpdate(id, fields) {
  var f = fields || {};
  return call('menu.update', {
    id: id,
    title: f.title,
    dateText: f.dateText,
    mealType: f.mealType,
    headcount: f.headcount,
    endsAt: f.endsAt === undefined ? null : f.endsAt
  });
}

// menuDelete(id) -> { id, deleted:true }  仅主人家；菜单与其点菜记录一起进回收站
function menuDelete(id) {
  return call('menu.delete', { id: id });
}

// recycleList(type?) -> { dishes: [], menus: [] }  仅主人家；type: 'dish' | 'menu'
function recycleList(type) {
  var p = {};
  if (type) { p.type = type; }
  return call('recycle.list', p);
}

// recycleRestore(type, ids) -> { restored }  仅主人家
function recycleRestore(type, ids) {
  return call('recycle.restore', { type: type, ids: ids || [] });
}

// recyclePurge(type, ids) -> { purged }  仅主人家
function recyclePurge(type, ids) {
  return call('recycle.purge', { type: type, ids: ids || [] });
}

// recycleClear(type?) -> { purged }  仅主人家；不传 type 表示清空整个回收站
function recycleClear(type) {
  var p = {};
  if (type) { p.type = type; }
  return call('recycle.clear', p);
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
  dishEdit: dishEdit,
  dishEditList: dishEditList,
  dishEditReview: dishEditReview,
  dishEditHistory: dishEditHistory,
  dishMyEdits: dishMyEdits,
  dishLike: dishLike,
  dishUnlike: dishUnlike,
  dishWant: dishWant,
  dishUnwant: dishUnwant,
  orderCreate: orderCreate,
  orderList: orderList,
  orderDone: orderDone,
  orderCancel: orderCancel,
  menuCurrent: menuCurrent,
  menuStart: menuStart,
  menuClose: menuClose,
  menuList: menuList,
  menuDetail: menuDetail,
  menuReview: menuReview,
  dishOrderers: dishOrderers,
  dishSetListed: dishSetListed,
  menuUpdate: menuUpdate,
  menuDelete: menuDelete,
  recycleList: recycleList,
  recycleRestore: recycleRestore,
  recyclePurge: recyclePurge,
  recycleClear: recycleClear
};
