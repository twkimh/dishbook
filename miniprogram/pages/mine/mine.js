/**
 * 我的（SPEC §6）
 * 身份卡片 + 主人家专属入口（点菜记录 / 待审核，带待审核角标）+ 我的提交列表。
 * onShow 刷新角标与列表；下拉刷新 / 触底加载 / 空状态 / 骨架。
 */

var api = require('../../utils/api.js');
var format = require('../../utils/format.js');

var PAGE_SIZE = 10;
var STATUS_TEXT = {
  approved: '已上架',
  pending: '待审核',
  rejected: '未通过'
};

function toast(title) {
  wx.showToast({ title: title, icon: 'none', duration: 2000 });
}

function readNickname() {
  try {
    var stored = wx.getStorageSync('nickname');
    return typeof stored === 'string' ? stored : '';
  } catch (err) {
    console.error('[mine] 读取昵称失败', err);
    return '';
  }
}

function writeNickname(value) {
  try {
    if (value) {
      wx.setStorageSync('nickname', value);
    } else {
      wx.removeStorageSync('nickname');
    }
  } catch (err) {
    console.error('[mine] 保存昵称失败', err);
  }
}

/**
 * app.onLaunch 的 login 是异步的：首次进入时 role 可能还没回来。
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
  var status = STATUS_TEXT[item.status] ? item.status : 'pending';
  return {
    id: item._id || item.id || '',
    name: item.name || '未命名',
    cover: item.cover || '',
    status: status,
    statusText: STATUS_TEXT[status],
    timeText: format.formatRelativeTime(item.createdAt)
  };
}

Page({
  data: {
    isOwner: false,
    nickname: '',
    pendingCount: 0,
    pendingText: '0',
    list: [],
    total: 0,
    page: 0,
    hasMore: true,
    loading: false,
    loadingMore: false,
    skeleton: true
  },

  onLoad: function () {
    this.setData({ nickname: readNickname() });
  },

  onShow: function () {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }
    this.setData({ nickname: readNickname() });
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
    this.fetchMine(false);
  },

  refreshAll: function () {
    var self = this;
    return resolveRole().then(
      function (owner) {
        self.setData({ isOwner: owner });
        var tasks = [self.fetchMine(true)];
        if (owner) {
          tasks.push(self.fetchPendingCount());
        }
        return Promise.all(tasks);
      },
      function (err) {
        console.error('[mine] 身份解析失败', err);
        self.setData({ isOwner: false });
        return self.fetchMine(true);
      }
    );
  },

  // 角标只要数量：pageSize 1 拿 total
  fetchPendingCount: function () {
    var self = this;
    return api.dishReviewList({ page: 1, pageSize: 1 }).then(
      function onSuccess(res) {
        var total = Number(res && res.total) || 0;
        self.setData({ pendingCount: total, pendingText: format.formatCount(total) });
      },
      function onFail(err) {
        console.error('[mine] 待审核数量加载失败', err);
      }
    );
  },

  /**
   * @param {boolean} reset true 拉第一页并替换列表，false 追加下一页
   */
  fetchMine: function (reset) {
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

    return api.dishMine({ page: nextPage, pageSize: PAGE_SIZE }).then(
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
        console.error('[mine] 我的提交加载失败', err);
        self.setData({ loading: false, loadingMore: false, skeleton: false });
      }
    );
  },

  onEditNickname: function () {
    var self = this;
    wx.showModal({
      title: '怎么称呼你',
      editable: true,
      placeholderText: '比如 小林',
      content: self.data.nickname,
      success: function (res) {
        if (!res || !res.confirm) {
          return;
        }
        var value = (res.content || '').trim();
        if (value.length > 20) {
          toast('称呼最多 20 个字');
          return;
        }
        writeNickname(value);
        self.setData({ nickname: value });
        toast(value ? '称呼已更新' : '称呼已清空');
      },
      fail: function (err) {
        console.error('[mine] 修改称呼弹窗失败', err);
      }
    });
  },

  goOrders: function () {
    wx.navigateTo({
      url: '/pages/orders/orders',
      fail: function (err) {
        console.error('[mine] 打开点菜记录失败', err);
      }
    });
  },

  goReview: function () {
    wx.navigateTo({
      url: '/pages/review/review',
      fail: function (err) {
        console.error('[mine] 打开待审核失败', err);
      }
    });
  },

  goDish: function (event) {
    var id = event.currentTarget.dataset.id;
    if (!id) {
      return;
    }
    wx.navigateTo({
      url: '/pages/detail/detail?id=' + id,
      fail: function (err) {
        console.error('[mine] 打开菜品详情失败', err);
      }
    });
  }
});
