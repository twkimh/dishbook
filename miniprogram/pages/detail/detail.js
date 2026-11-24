/**
 * 菜品详情 + 点菜（SPEC §4 / §6）
 * 数据只经 utils/api.js（SPEC §1），本页不碰 wx.cloud.*
 *
 * 点菜流程（顺序固定）：
 *   读 templateId / orderConfirmTemplateId（防御式，取不到当空串）
 *   -> 两者非空的收进 tmplIds，一次 requestSubscribeMessage（accept / reject / 报错 都继续下单）
 *   -> 昵称（本地缓存 nickname，没有就问一次，取消用「匿名朋友」）
 *   -> 备注（可空，取消传空串）
 *   -> api.orderCreate(dishId, note, { nickname })
 *   -> 成功：按钮短暂「已点」+ 按 notifyState 提示；notifyState 任何值都不算失败
 */

var api = require('../../utils/api.js');
var format = require('../../utils/format.js');

var ANONYMOUS_NICKNAME = '匿名朋友';
var ORDERED_HOLD_MS = 2000;
var TAG_TONES = ['accent', 'sage', 'mustard'];

Page({
  data: {
    id: '',
    dish: null,
    tagList: [],
    createdText: '',
    cookedText: '0',
    loading: true,
    notFound: false,
    ordering: false,
    ordered: false
  },

  /* ---------- 生命周期 ---------- */

  onLoad: function (options) {
    this.orderedTimer = null;
    var id = (options && options.id) || '';
    this.setData({ id: id });
    if (!id) {
      this.setData({ loading: false, notFound: true });
      return;
    }
    this.fetchDish(id);
  },

  onUnload: function () {
    if (this.orderedTimer) {
      clearTimeout(this.orderedTimer);
      this.orderedTimer = null;
    }
  },

  /* ---------- 菜品详情 ---------- */

  fetchDish: function (id) {
    var self = this;
    this.setData({ loading: true });
    return api.dishGet(id).then(function (dish) {
      self.renderDish(dish || {});
    }, function (err) {
      // api.js 已经弹过 toast，这里只记日志
      console.error('[detail] 菜品加载失败', err);
      self.setData({ loading: false, notFound: true });
    });
  },

  renderDish: function (dish) {
    var tags = Array.isArray(dish.tags) ? dish.tags : [];
    var tagList = [];
    for (var i = 0; i < tags.length; i++) {
      tagList.push({ text: tags[i], tone: TAG_TONES[i % TAG_TONES.length] });
    }
    this.setData({
      dish: dish,
      tagList: tagList,
      createdText: dish.createdAt ? format.formatDate(dish.createdAt) : '',
      cookedText: format.formatCount(dish.cookedCount || 0),
      loading: false,
      notFound: false
    });
    wx.setNavigationBarTitle({ title: dish.name || '菜品详情' });
  },

  /* ---------- 点菜流程 ---------- */

  onOrderTap: function () {
    var self = this;
    var dish = this.data.dish;
    if (this.data.ordering || this.data.ordered || !dish || !dish._id) {
      return;
    }
    this.setData({ ordering: true });
    this.requestSubscribe()
      .then(function () {
        return self.askNickname();
      })
      .then(function (nickname) {
        return self.askNote().then(function (note) {
          return { nickname: nickname, note: note };
        });
      })
      .then(function (ctx) {
        return self.submitOrder(dish._id, ctx.note, ctx.nickname);
      })
      .then(function (result) {
        self.handleOrderSuccess(result);
      })
      .then(null, function (err) {
        // api.js 已 toast 过，这里只恢复按钮状态，不重复提示
        console.error('[detail] 点菜失败', err);
        self.setData({ ordering: false });
      });
  },

  // 订阅消息只是附加提醒：无论 accept / reject / 报错 / 取不到模板，都 resolve 继续下单
  // 双模板（主人家收「有人点菜了」+ 点菜者收「下单成功」）合并成一次 requestSubscribeMessage 调用
  requestSubscribe: function () {
    var tmplIds = [];
    try {
      var app = getApp();
      var globalData = (app && app.globalData) || {};
      var isOwner = globalData.role === 'owner';
      var templateId = typeof globalData.templateId === 'string' ? globalData.templateId : '';
      var orderConfirmTemplateId =
        typeof globalData.orderConfirmTemplateId === 'string' ? globalData.orderConfirmTemplateId : '';
      // 「有人点菜了」只在别人点菜时才会发（自己点自己的菜时云函数会跳过），
      // 所以主人给自己点菜时不必为它申请授权，少一项就少一次打扰
      if (templateId && !isOwner) {
        tmplIds.push(templateId);
      }
      if (orderConfirmTemplateId) {
        tmplIds.push(orderConfirmTemplateId);
      }
    } catch (err) {
      tmplIds = [];
    }
    if (tmplIds.length === 0) {
      return Promise.resolve('skipped');
    }
    return new Promise(function (resolve) {
      function callSubscribe() {
        try {
          // 唯一一次订阅授权调用：多个模板 ID 一起申请；低版本基础库没有该 API 会抛错，落到 catch 里放行
          wx.requestSubscribeMessage({
            tmplIds: tmplIds,
            success: function () {
              resolve('resolved');
            },
            fail: function (err) {
              // 用户拒绝 / 模板失效 / 未开通，一律放行
              console.warn('[detail] 订阅消息未授权，继续下单', err);
              resolve('failed');
            }
          });
        } catch (err) {
          console.warn('[detail] 订阅消息调用异常，继续下单', err);
          resolve('failed');
        }
      }
      // 用户在微信里关掉了订阅消息总开关时，requestSubscribeMessage 必然失败，
      // 先查一下，避免每次点菜都弹一次注定失败的报错
      if (typeof wx.getSetting !== 'function') {
        callSubscribe();
        return;
      }
      try {
        wx.getSetting({
          withSubscriptions: true,
          success: function (res) {
            var setting = (res && res.subscriptionsSetting) || {};
            if (setting.mainSwitch === false) {
              resolve('skipped');
              return;
            }
            callSubscribe();
          },
          fail: function () {
            callSubscribe();
          }
        });
      } catch (err) {
        callSubscribe();
      }
    });
  },

  askNickname: function () {
    var cached = '';
    try {
      cached = wx.getStorageSync('nickname') || '';
    } catch (err) {
      cached = '';
    }
    if (cached) {
      return Promise.resolve(cached);
    }
    return new Promise(function (resolve) {
      wx.showModal({
        title: '留个名字',
        editable: true,
        placeholderText: '怎么称呼你？(可不填)',
        success: function (res) {
          var nickname = '';
          if (res && res.confirm) {
            nickname = String(res.content || '').trim();
          }
          if (nickname) {
            try {
              wx.setStorageSync('nickname', nickname);
            } catch (err) {
              console.warn('[detail] 昵称缓存失败', err);
            }
            resolve(nickname);
            return;
          }
          resolve(ANONYMOUS_NICKNAME);
        },
        fail: function (err) {
          console.warn('[detail] 昵称弹窗异常', err);
          resolve(ANONYMOUS_NICKNAME);
        }
      });
    });
  },

  askNote: function () {
    return new Promise(function (resolve) {
      wx.showModal({
        title: '想吃的话',
        editable: true,
        placeholderText: '想对主人家说点什么？(可不填)',
        success: function (res) {
          var note = '';
          if (res && res.confirm) {
            note = String(res.content || '').trim();
          }
          resolve(note);
        },
        fail: function (err) {
          console.warn('[detail] 备注弹窗异常', err);
          resolve('');
        }
      });
    });
  },

  submitOrder: function (dishId, note, nickname) {
    return api.orderCreate(dishId, note || '', { nickname: nickname });
  },

  handleOrderSuccess: function (result) {
    var payload = result || {};
    var notifyState = payload.notifyState || '';
    this.setData({
      ordering: false,
      cookedText: format.formatCount(Number(this.data.dish ? this.data.dish.cookedCount || 0 : 0) + 1)
    });
    // notifyState 的任何取值（sent / failed / skipped / 未知）都不视为失败
    if (notifyState !== 'sent') {
      // failed / skipped：按点菜成功处理
      wx.showToast({ title: '已点菜', icon: 'none', duration: 1500 });
    }
    this.holdOrdered();
  },

  // 短暂进入「已点」态防连点，过后恢复可点
  holdOrdered: function () {
    var self = this;
    this.setData({ ordered: true });
    if (this.orderedTimer) {
      clearTimeout(this.orderedTimer);
    }
    this.orderedTimer = setTimeout(function () {
      self.orderedTimer = null;
      self.setData({ ordered: false });
    }, ORDERED_HOLD_MS);
  }
});
