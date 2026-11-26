/**
 * 我收到的点菜（SPEC §3 orders / §6）
 * 仅主人家可用；守卫不过直接退回。列表：下拉刷新 / 触底加载 / 空状态 / 骨架。
 * 「已做」只就地更新那一条，不整页重刷。
 */

var api = require('../../utils/api.js');
var format = require('../../utils/format.js');

var PAGE_SIZE = 10;
var FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'new', label: '待处理' },
  { key: 'done', label: '已完成' }
];

function toast(title) {
  wx.showToast({ title: title, icon: 'none', duration: 2000 });
}

/**
 * 直接通过 url 打开本页时页面栈可能只有一层，navigateBack 会失败，
 * 这时退回首页，别把非主人家留在空白页上。
 */
function leaveAsGuest() {
  toast('只有主人家能看');
  setTimeout(function () {
    wx.navigateBack({
      delta: 1,
      fail: function () {
        wx.switchTab({
          url: '/pages/index/index',
          fail: function () {
            wx.reLaunch({ url: '/pages/index/index' });
          }
        });
      }
    });
  }, 900);
}

/**
 * app.onLaunch 的 login 是异步的：冷启动直达本页时 role 可能还没回来。
 * openid 已有 -> 身份已确定是访客；openid 为空 -> 等 login 结果再判。
 * @returns {Promise<boolean>}
 */
function resolveRole() {
  var app = getApp();
  if (!app) {
    return Promise.resolve(false);
  }
  if (typeof app.isOwner === 'function' && app.isOwner()) {
    return Promise.resolve(true);
  }
  var global = app.globalData || {};
  if (global.openid) {
    return Promise.resolve(false);
  }
  if (typeof app.signIn !== 'function') {
    return Promise.resolve(false);
  }
  return app.signIn().then(
    function onSuccess() {
      return typeof app.isOwner === 'function' ? app.isOwner() : false;
    },
    function onFailure() {
      return false;
    }
  );
}

function decorate(raw) {
  var item = raw || {};
  var orderer = item.orderer || {};
  var done = item.status === 'done';
  var nickname = orderer.nickname || '一位朋友';
  // 用户编号：openid 由微信服务端签发，客户端伪造不了，取后 6 位即可区分同名的人。
  // 纯前端派生，不进库；取不到 openid 时留空串，wxml 用 wx:if 不渲染。
  var openid = typeof orderer.openid === 'string' ? orderer.openid : '';
  return {
    id: item._id || item.id || '',
    dishId: item.dishId || '',
    dishName: item.dishName || '这道菜',
    dishCover: item.dishCover || '',
    note: item.note || '',
    nickname: nickname,
    userTag: openid ? '#' + openid.slice(-6) : '',
    // 点菜人头像：后端返回的已是可直接显示的 https 临时链接
    avatar: orderer.avatar || '',
    avatarText: nickname.charAt(0),
    timeText: format.formatTime(item.createdAt),
    status: done ? 'done' : 'new',
    statusText: done ? '已完成' : '待处理',
    doneLoading: false
  };
}

Page({
  data: {
    isOwner: false,
    filters: FILTERS,
    filter: 'all',
    list: [],
    total: 0,
    pendingCount: 0,
    page: 0,
    hasMore: true,
    loading: false,
    loadingMore: false,
    skeleton: true
  },

  onLoad: function () {
    var self = this;
    resolveRole().then(function (owner) {
      self.setData({ isOwner: owner });
      if (!owner) {
        leaveAsGuest();
        return;
      }
      self.ready = true;
      self.refreshAll();
    });
  },

  onShow: function () {
    if (!this.ready) {
      return;
    }
    this.refreshAll();
  },

  onPullDownRefresh: function () {
    this.refreshAll().then(function () {
      wx.stopPullDownRefresh();
    }, function () {
      wx.stopPullDownRefresh();
    });
  },

  onReachBottom: function () {
    if (!this.ready) {
      return;
    }
    this.fetchList(false);
  },

  refreshAll: function () {
    var self = this;
    return Promise.all([this.fetchPendingCount(), this.fetchList(true)]).then(
      function onDone() {
        return null;
      },
      function onFail(err) {
        console.error('[orders] 刷新失败', err);
        return null;
      }
    );
  },

  // 顶部「待处理条数」用 pageSize 1 只取 total，避免多拉一页数据
  fetchPendingCount: function () {
    var self = this;
    return api.orderList({ page: 1, pageSize: 1, status: 'new' }).then(
      function onSuccess(res) {
        self.setData({ pendingCount: Number(res && res.total) || 0 });
      },
      function onFail(err) {
        console.error('[orders] 待处理数量加载失败', err);
      }
    );
  },

  /**
   * @param {boolean} reset true 拉第一页并替换列表，false 追加下一页
   */
  fetchList: function (reset) {
    var self = this;
    if (this.data.loading || this.data.loadingMore) {
      return Promise.resolve();
    }
    if (!reset && !this.data.hasMore) {
      return Promise.resolve();
    }
    var nextPage = reset ? 1 : this.data.page + 1;
    if (reset) {
      this.setData({ loading: true, skeleton: this.data.list.length === 0 });
    } else {
      this.setData({ loadingMore: true });
    }

    var params = { page: nextPage, pageSize: PAGE_SIZE };
    if (this.data.filter !== 'all') {
      params.status = this.data.filter;
    }

    return api.orderList(params).then(
      function onSuccess(res) {
        var raw = (res && res.list) || [];
        var rows = [];
        for (var i = 0; i < raw.length; i++) {
          rows.push(decorate(raw[i]));
        }
        self.setData({
          list: reset ? rows : self.data.list.concat(rows),
          total: Number(res && res.total) || 0,
          page: nextPage,
          hasMore: !!(res && res.hasMore),
          loading: false,
          loadingMore: false,
          skeleton: false
        });
      },
      function onFail(err) {
        // api.js 已 toast，这里只收起加载态
        console.error('[orders] 列表加载失败', err);
        self.setData({ loading: false, loadingMore: false, skeleton: false });
      }
    );
  },

  onSwitchFilter: function (event) {
    var key = event.currentTarget.dataset.key;
    if (!key || key === this.data.filter) {
      return;
    }
    this.setData({ filter: key, list: [], page: 0, hasMore: true, skeleton: true });
    this.fetchList(true);
  },

  onDone: function (event) {
    var self = this;
    var id = event.currentTarget.dataset.id;
    var index = Number(event.currentTarget.dataset.index);
    var row = this.data.list[index];
    if (!id || !row || row.doneLoading || row.status === 'done') {
      return;
    }

    var patch = {};
    patch['list[' + index + '].doneLoading'] = true;
    this.setData(patch);

    api.orderDone(id).then(
      function onSuccess() {
        var nextPending = Math.max(0, self.data.pendingCount - 1);
        if (self.data.filter === 'new') {
          // 当前只看待处理，处理完就该从这一屏消失
          var list = self.data.list.slice();
          list.splice(index, 1);
          self.setData({
            list: list,
            total: Math.max(0, self.data.total - 1),
            pendingCount: nextPending
          });
        } else {
          var updated = {};
          updated['list[' + index + '].status'] = 'done';
          updated['list[' + index + '].statusText'] = '已完成';
          updated['list[' + index + '].doneLoading'] = false;
          updated['pendingCount'] = nextPending;
          self.setData(updated);
        }
        toast('这一道做完啦');
      },
      function onFail(err) {
        console.error('[orders] 标记已做失败', err);
        var revert = {};
        revert['list[' + index + '].doneLoading'] = false;
        self.setData(revert);
      }
    );
  },

  // 头像加载失败：清掉这一条的 src，落回纯 CSS 圆形占位
  onAvatarError: function (event) {
    var index = Number(event.currentTarget.dataset.index);
    if (!(index >= 0) || index >= this.data.list.length) {
      return;
    }
    var patch = {};
    patch['list[' + index + '].avatar'] = '';
    this.setData(patch);
  },

  onTapDish: function (event) {
    var id = event.currentTarget.dataset.dishid;
    if (!id) {
      return;
    }
    wx.navigateTo({
      url: '/pages/detail/detail?id=' + id,
      fail: function (err) {
        console.error('[orders] 打开菜品详情失败', err);
      }
    });
  }
});
