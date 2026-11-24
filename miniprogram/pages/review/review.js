/**
 * 访客提交审核（SPEC §3 / §4 dish.reviewList / dish.review）
 * 仅主人家可用；通过/驳回后只把该条从列表移除并更新计数，不整页重载。
 */

var api = require('../../utils/api.js');
var format = require('../../utils/format.js');

var PAGE_SIZE = 10;

function toast(title) {
  wx.showToast({ title: title, icon: 'none', duration: 2000 });
}

// 直接通过 url 进入时页面栈可能只有一层，navigateBack 会失败
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
  var submitter = item.submitter || {};
  return {
    id: item._id || item.id || '',
    name: item.name || '未命名',
    cover: item.cover || '',
    story: item.story || '',
    tags: item.tags || [],
    nickname: submitter.nickname || '一位朋友',
    timeText: format.formatRelativeTime(item.createdAt),
    acting: false
  };
}

Page({
  data: {
    isOwner: false,
    list: [],
    total: 0,
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
      self.fetchList(true);
    });
  },

  onShow: function () {
    if (!this.ready) {
      return;
    }
    this.fetchList(true);
  },

  onPullDownRefresh: function () {
    this.fetchList(true).then(function () {
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

    return api.dishReviewList({ page: nextPage, pageSize: PAGE_SIZE }).then(
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
        console.error('[review] 待审核列表加载失败', err);
        self.setData({ loading: false, loadingMore: false, skeleton: false });
      }
    );
  },

  onPass: function (event) {
    this.judge(Number(event.currentTarget.dataset.index), true);
  },

  onReject: function (event) {
    var self = this;
    var index = Number(event.currentTarget.dataset.index);
    var row = this.data.list[index];
    if (!row) {
      return;
    }
    wx.showModal({
      title: '驳回「' + row.name + '」？',
      content: '驳回后它不会上架，也不会再回到待审核列表。',
      confirmText: '驳回',
      cancelText: '再想想',
      success: function (res) {
        if (res && res.confirm) {
          self.judge(index, false);
        }
      },
      fail: function (err) {
        console.error('[review] 二次确认弹窗失败', err);
      }
    });
  },

  judge: function (index, accept) {
    var self = this;
    var row = this.data.list[index];
    if (!row || row.acting) {
      return;
    }

    var patch = {};
    patch['list[' + index + '].acting'] = true;
    this.setData(patch);

    api.dishReview(row.id, accept).then(
      function onSuccess() {
        var list = self.data.list.slice();
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === row.id) {
            list.splice(i, 1);
            break;
          }
        }
        self.setData({
          list: list,
          total: Math.max(0, self.data.total - 1),
          skeleton: false
        });
        toast(accept ? '已通过，上架了' : '已驳回');
        // 一屏清空时顺手补一页，别让主人家对着空列表以为没数据
        if (!list.length && self.data.hasMore) {
          self.fetchList(false);
        }
      },
      function onFail(err) {
        console.error('[review] 审核失败', err);
        var revert = {};
        revert['list[' + index + '].acting'] = false;
        self.setData(revert);
      }
    );
  }
});
