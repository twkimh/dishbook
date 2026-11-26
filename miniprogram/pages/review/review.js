/**
 * 待审核（SPEC §3 / §4 dish.reviewList / dish.review）
 * v1.0.8 起两类并列：新菜提交（dish.reviewList）与修改提案（dish.editList）。
 * 两套列表各自独立分页/刷新，互不污染。
 * 仅主人家可用；通过/驳回后只把该条从列表移除并更新计数，不整页重载。
 */

var api = require('../../utils/api.js');
var format = require('../../utils/format.js');

var PAGE_SIZE = 10;
var STORY_LIMIT = 40;

function toast(title) {
  wx.showToast({ title: title, icon: 'none', duration: 2000 });
}

// 把同步抛出的异常也收成 rejected promise：api 未就绪时不至于把页面打崩
function safe(factory) {
  try {
    return Promise.resolve(factory());
  } catch (err) {
    return Promise.reject(err);
  }
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
  var nickname = submitter.nickname || '一位朋友';
  // 用户编号：openid 由微信服务端签发，客户端伪造不了，取后 6 位即可区分同名的人。
  // 纯前端派生，不进库；取不到 openid 时留空串，wxml 用 wx:if 不渲染。
  var openid = typeof submitter.openid === 'string' ? submitter.openid : '';
  return {
    id: item._id || item.id || '',
    name: item.name || '未命名',
    cover: item.cover || '',
    story: item.story || '',
    tags: item.tags || [],
    nickname: nickname,
    userTag: openid ? '#' + openid.slice(-6) : '',
    // 提交人头像：后端返回的已是可直接显示的 https 临时链接
    avatar: submitter.avatar || '',
    avatarText: nickname.charAt(0),
    timeText: format.formatRelativeTime(item.createdAt),
    acting: false
  };
}

/* ---------- 修改提案（v1.0.8）：只做摘要，不做真 diff ---------- */

function toText(value) {
  return typeof value === 'string' ? value : '';
}

// snapshot 来自别的客户端，字段类型不可信：非数组一律当空，非字符串项直接丢掉
function stringList(value) {
  var out = [];
  if (!Array.isArray(value)) {
    return out;
  }
  for (var i = 0; i < value.length; i++) {
    var item = value[i];
    if (typeof item === 'string' && item) {
      out.push(item);
    }
  }
  return out;
}

function decorateEdit(raw) {
  var item = raw || {};
  var submitter = item.submitter || {};
  var snapshot = item.snapshot || {};
  var nickname = toText(submitter.nickname) || '一位朋友';
  var openid = toText(submitter.openid);
  var snapshotName = toText(snapshot.name);
  var methods = stringList(snapshot.methods);
  var ingredients = stringList(snapshot.ingredients);
  var seasonings = stringList(snapshot.seasonings);

  return {
    id: toText(item._id) || toText(item.id),
    // 标题用菜当前的名字；改后的名字在摘要第一行（snapshot.name）单独显示
    dishName: toText(item.dishName) || snapshotName || '未命名',
    snapshotName: snapshotName || '未填',
    methodText: methods.length ? methods.join(' + ') : '未填',
    countText: '材料 ' + ingredients.length + ' 项 · 调料 ' + seasonings.length + ' 项',
    storyText: format.truncate(toText(snapshot.story), STORY_LIMIT),
    nickname: nickname,
    userTag: openid ? '#' + openid.slice(-6) : '',
    avatar: toText(submitter.avatar),
    avatarText: nickname.charAt(0),
    // 提案时间用绝对时间：主人家要一眼看出这条压了多久
    timeText: format.formatTime(item.createdAt),
    acting: false
  };
}

Page({
  data: {
    isOwner: false,
    // 'new' = 新菜待审，'edit' = 修改待审
    mode: 'new',

    // —— 新菜待审（原有字段，语义不变）——
    list: [],
    total: 0,
    page: 0,
    hasMore: true,
    loading: false,
    loadingMore: false,
    skeleton: true,

    // —— 修改待审（独立的一套分页状态）——
    editList: [],
    editTotal: 0,
    editPage: 0,
    editHasMore: true,
    editLoading: false,
    editLoadingMore: false,
    editSkeleton: true,

    // 两个 chip 上的数量（pageSize=1 的 total）
    newCount: 0,
    newCountText: '0',
    editCount: 0,
    editCountText: '0'
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
      self.loadCurrent(true);
    });
  },

  onShow: function () {
    if (!this.ready) {
      return;
    }
    this.loadCurrent(true);
  },

  onPullDownRefresh: function () {
    this.loadCurrent(true).then(function () {
      wx.stopPullDownRefresh();
    }, function () {
      wx.stopPullDownRefresh();
    });
  },

  onReachBottom: function () {
    if (!this.ready) {
      return;
    }
    this.loadCurrent(false);
  },

  // 只按当前分类取数，两套状态各写各的
  loadCurrent: function (reset) {
    if (this.data.mode === 'edit') {
      return this.fetchEditList(reset);
    }
    return this.fetchList(reset);
  },

  switchMode: function (event) {
    var dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    var mode = dataset.mode === 'edit' ? 'edit' : 'new';
    if (mode === this.data.mode) {
      return;
    }
    this.setData({ mode: mode });
    // 切过去就重新拉第一页：两个分类各自独立刷新，不共用页码
    this.loadCurrent(true);
    this.fetchCounts();
  },

  // 把 pageSize=1 的 total 写到对应 chip 上
  applyCount: function (which, value) {
    var num = Number(value);
    if (!(num >= 0)) {
      num = 0;
    }
    num = Math.floor(num);
    var patch = {};
    if (which === 'edit') {
      patch.editCount = num;
      patch.editCountText = format.formatCount(num);
    } else {
      patch.newCount = num;
      patch.newCountText = format.formatCount(num);
    }
    this.setData(patch);
  },

  fetchCounts: function () {
    var self = this;
    safe(function () {
      return api.dishReviewList({ page: 1, pageSize: 1 });
    }).then(
      function onSuccess(res) {
        self.applyCount('new', res && res.total);
      },
      function onFail(err) {
        console.error('[review] 新菜待审计数失败', err);
      }
    );
    safe(function () {
      return api.dishEditList({ page: 1, pageSize: 1 });
    }).then(
      function onSuccess(res) {
        self.applyCount('edit', res && res.total);
      },
      function onFail(err) {
        console.error('[review] 修改待审计数失败', err);
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
        self.fetchCounts();
      },
      function onFail(err) {
        console.error('[review] 待审核列表加载失败', err);
        self.setData({ loading: false, loadingMore: false, skeleton: false });
      }
    );
  },

  /**
   * 修改提案列表，字段与 fetchList 一一对应但完全独立
   * @param {boolean} reset true 拉第一页并替换列表，false 追加下一页
   */
  fetchEditList: function (reset) {
    var self = this;
    if (this.data.editLoading || this.data.editLoadingMore) {
      return Promise.resolve();
    }
    if (!reset && !this.data.editHasMore) {
      return Promise.resolve();
    }
    var nextPage = reset ? 1 : this.data.editPage + 1;
    if (reset) {
      this.setData({ editLoading: true, editSkeleton: this.data.editList.length === 0 });
    } else {
      this.setData({ editLoadingMore: true });
    }

    return safe(function () {
      return api.dishEditList({ page: nextPage, pageSize: PAGE_SIZE });
    }).then(
      function onSuccess(res) {
        var raw = (res && res.list) || [];
        var rows = [];
        for (var i = 0; i < raw.length; i++) {
          rows.push(decorateEdit(raw[i]));
        }
        self.setData({
          editList: reset ? rows : self.data.editList.concat(rows),
          editTotal: Number(res && res.total) || 0,
          editPage: nextPage,
          editHasMore: !!(res && res.hasMore),
          editLoading: false,
          editLoadingMore: false,
          editSkeleton: false
        });
        self.fetchCounts();
      },
      function onFail(err) {
        console.error('[review] 修改提案列表加载失败', err);
        self.setData({ editLoading: false, editLoadingMore: false, editSkeleton: false });
      }
    );
  },

  onPass: function (event) {
    this.judge(Number(event.currentTarget.dataset.index), true);
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

  onEditAvatarError: function (event) {
    var index = Number(event.currentTarget.dataset.index);
    if (!(index >= 0) || index >= this.data.editList.length) {
      return;
    }
    var patch = {};
    patch['editList[' + index + '].avatar'] = '';
    this.setData(patch);
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

  onEditPass: function (event) {
    var self = this;
    var index = Number(event.currentTarget.dataset.index);
    var row = this.data.editList[index];
    if (!row) {
      return;
    }
    wx.showModal({
      title: '通过「' + row.dishName + '」的修改？',
      content: '通过后提案内容会直接覆盖这道菜，原内容不可恢复。',
      confirmText: '通过',
      cancelText: '再想想',
      success: function (res) {
        if (res && res.confirm) {
          self.judgeEdit(index, true);
        }
      },
      fail: function (err) {
        console.error('[review] 修改提案通过确认失败', err);
      }
    });
  },

  onEditReject: function (event) {
    var self = this;
    var index = Number(event.currentTarget.dataset.index);
    var row = this.data.editList[index];
    if (!row) {
      return;
    }
    wx.showModal({
      title: '驳回「' + row.dishName + '」的修改？',
      content: '驳回后这道菜保持原样，提案会留在修改历史里。',
      confirmText: '驳回',
      cancelText: '再想想',
      success: function (res) {
        if (res && res.confirm) {
          self.judgeEdit(index, false);
        }
      },
      fail: function (err) {
        console.error('[review] 修改提案驳回确认失败', err);
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
  },

  judgeEdit: function (index, accept) {
    var self = this;
    var row = this.data.editList[index];
    if (!row || row.acting || !row.id) {
      return;
    }

    var patch = {};
    patch['editList[' + index + '].acting'] = true;
    this.setData(patch);

    safe(function () {
      return api.dishEditReview(row.id, accept);
    }).then(
      function onSuccess() {
        var list = self.data.editList.slice();
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === row.id) {
            list.splice(i, 1);
            break;
          }
        }
        var nextTotal = Math.max(0, self.data.editTotal - 1);
        // 就地移除 + 更新计数，不整页重载
        self.setData({
          editList: list,
          editTotal: nextTotal,
          editSkeleton: false
        });
        self.applyCount('edit', nextTotal);
        toast(accept ? '已通过，改动生效了' : '已驳回');
        if (!list.length && self.data.editHasMore) {
          self.fetchEditList(false);
        }
      },
      function onFail(err) {
        console.error('[review] 修改提案审核失败', err);
        var revert = {};
        revert['editList[' + index + '].acting'] = false;
        self.setData(revert);
      }
    );
  }
});
