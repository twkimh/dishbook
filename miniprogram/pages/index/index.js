/**
 * 菜品流首页（SPEC §2 / §5 / §6）
 * 两列瀑布 + 关键字搜索（300ms 防抖）+ 标签筛选 + 下拉刷新 + 触底加载 + 首屏骨架 + 空状态
 * 数据只经 utils/api.js（SPEC §1），本页不碰 wx.cloud.*
 */

var api = require('../../utils/api.js');

var PAGE_SIZE = 10;
var DEBOUNCE_MS = 300;
var MAX_TAGS = 20;

Page({
  data: {
    keyword: '',
    activeTag: '',
    tags: [],
    list: [],
    // 两列瀑布：按列表奇偶拆成左右两列，追加分页时已有卡片不重排
    leftColumn: [],
    rightColumn: [],
    page: 1,
    hasMore: true,
    firstLoading: true,
    loadingMore: false,
    endReached: false,
    emptyText: '还没有菜品上架',
    emptyHint: '等主人家端上第一道菜'
  },

  /* ---------- 生命周期 ---------- */

  onLoad: function () {
    // seq：请求序号，用来丢弃被新请求（搜索 / 刷新）超越的过期响应
    this.seq = 0;
    this.loadedOnce = false;
    this.needRefresh = false;
    this.skipNextRefresh = false;
    this.navigating = false;
    this.searchTimer = null;
    this.reload({ skeleton: true });
  },

  onShow: function () {
    // 自定义 tabBar 的选中态不可靠（pageLifetimes.show 在 tabBar 组件里不保证触发），
    // 每个 tab 页在 onShow 里显式回填，避免点 tab 的点击被 selected 判断吞掉
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
    }
    this.navigating = false;
    // 首次进入不重复请求；只有「离开过本页再回来」（如从添加页返回）才静默刷新
    if (this.loadedOnce && this.needRefresh) {
      this.needRefresh = false;
      this.reload({ skeleton: false });
    }
  },

  onHide: function () {
    // 去详情页再回来时列表没有变化，不该整页重拉（否则分页会掉回第一页）；
    // 切 tab（如去添加页）回来才需要刷新，主人家才能看到刚上的新菜。
    this.needRefresh = !this.skipNextRefresh;
    this.skipNextRefresh = false;
  },

  onUnload: function () {
    this.clearSearchTimer();
  },

  /* ---------- 数据加载 ---------- */

  // 拉第一页。skeleton 为 true 时展示首屏骨架。
  reload: function (options) {
    var self = this;
    var opts = options || {};
    var seq = ++this.seq;
    // 请求发出时的查询条件，空状态文案要按它判断（响应回来时 keyword 可能已被改写）
    var query = { keyword: this.data.keyword, tag: this.data.activeTag };
    this.setData({
      firstLoading: !!opts.skeleton,
      loadingMore: false
    });
    return api.dishList({
      keyword: query.keyword,
      tag: query.tag,
      page: 1,
      pageSize: PAGE_SIZE
    }).then(function (result) {
      if (seq !== self.seq) {
        return;
      }
      self.loadedOnce = true;
      self.applyPage(result, 1, true, query);
    }, function (err) {
      if (seq !== self.seq) {
        return;
      }
      // api.js 已经弹过 toast，这里只记日志，避免重复提示
      self.loadedOnce = true;
      console.error('[index] 首屏加载失败', err);
      self.setData({ firstLoading: false });
    });
  },

  // 触底加载下一页。hasMore 为 false 时不再请求。
  loadMore: function () {
    var self = this;
    if (this.data.firstLoading || this.data.loadingMore || !this.data.hasMore) {
      return Promise.resolve();
    }
    var seq = this.seq;
    var nextPage = this.data.page + 1;
    var query = { keyword: this.data.keyword, tag: this.data.activeTag };
    this.setData({ loadingMore: true });
    return api.dishList({
      keyword: query.keyword,
      tag: query.tag,
      page: nextPage,
      pageSize: PAGE_SIZE
    }).then(function (result) {
      if (seq !== self.seq) {
        return;
      }
      self.applyPage(result, nextPage, false, query);
    }, function (err) {
      if (seq !== self.seq) {
        return;
      }
      console.error('[index] 加载更多失败', err);
      // 保留 hasMore，让用户再滑一次即可重试
      self.setData({ loadingMore: false });
    });
  },

  // 把一页结果落到 data 上：replace 为 true 时整体替换，否则追加
  applyPage: function (result, page, replace, query) {
    var payload = result || {};
    var incoming = Array.isArray(payload.list) ? payload.list : [];
    var list = replace ? incoming : this.data.list.concat(incoming);
    var columns = this.splitColumns(list);
    var hasMore = payload.hasMore !== false;
    var empty = this.buildEmpty(list.length === 0, query);
    this.setData({
      list: list,
      leftColumn: columns.left,
      rightColumn: columns.right,
      tags: this.mergeTags(list),
      page: page,
      hasMore: hasMore,
      endReached: !hasMore && list.length > 0,
      firstLoading: false,
      loadingMore: false,
      emptyText: empty.text,
      emptyHint: empty.hint
    });
  },

  // 奇偶拆列：index%2 决定左右，卡片倾斜由 dish-card 按 index 交替
  splitColumns: function (list) {
    var left = [];
    var right = [];
    for (var i = 0; i < list.length; i++) {
      if (i % 2 === 0) {
        left.push(list[i]);
      } else {
        right.push(list[i]);
      }
    }
    return { left: left, right: right };
  },

  // 标签筛选条的候选项：从已加载菜品里累积（接口不提供标签字典），只增不减
  mergeTags: function (list) {
    var tags = this.data.tags.slice();
    for (var i = 0; i < list.length; i++) {
      var dishTags = list[i] ? list[i].tags : null;
      if (!Array.isArray(dishTags)) {
        continue;
      }
      for (var j = 0; j < dishTags.length; j++) {
        var tag = dishTags[j];
        if (tag && tags.length < MAX_TAGS && tags.indexOf(tag) === -1) {
          tags.push(tag);
        }
      }
    }
    var activeTag = this.data.activeTag;
    if (activeTag && tags.indexOf(activeTag) === -1) {
      tags.unshift(activeTag);
    }
    return tags;
  },

  // 空状态文案：区分「一道菜都没有」和「搜不到结果」
  buildEmpty: function (isEmpty, query) {
    var q = query || {};
    if (isEmpty && (q.keyword || q.tag)) {
      return { text: '没找到这道菜', hint: '换个菜名，或者去掉标签再试试' };
    }
    return { text: '还没有菜品上架', hint: '等主人家端上第一道菜' };
  },

  /* ---------- 搜索（300ms 防抖） ---------- */

  onKeywordInput: function (event) {
    var value = (event && event.detail ? event.detail.value : '') || '';
    this.setData({ keyword: value });
    this.clearSearchTimer();
    this.searchTimer = setTimeout(function () {
      this.searchTimer = null;
      this.reload({ skeleton: false });
    }.bind(this), DEBOUNCE_MS);
  },

  onKeywordConfirm: function () {
    this.clearSearchTimer();
    this.reload({ skeleton: false });
  },

  onClearKeyword: function () {
    if (!this.data.keyword) {
      return;
    }
    this.clearSearchTimer();
    this.setData({ keyword: '' });
    this.reload({ skeleton: false });
  },

  clearSearchTimer: function () {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
  },

  /* ---------- 标签筛选 ---------- */

  onTagTap: function (event) {
    var tag = (event && event.currentTarget ? event.currentTarget.dataset.tag : '') || '';
    if (!tag) {
      return;
    }
    // 再点一次同一个标签即取消筛选
    this.setData({ activeTag: this.data.activeTag === tag ? '' : tag });
    this.clearSearchTimer();
    this.reload({ skeleton: false });
  },

  /* ---------- 跳转 ---------- */

  onCardTap: function (event) {
    var detail = (event && event.detail) || {};
    var id = detail.id || '';
    if (!id || this.navigating) {
      return;
    }
    var self = this;
    this.navigating = true;
    this.skipNextRefresh = true;
    wx.navigateTo({
      url: '/pages/detail/detail?id=' + id,
      fail: function (err) {
        self.navigating = false;
        self.skipNextRefresh = false;
        console.error('[index] 打开详情失败', err);
      }
    });
  },

  /* ---------- 下拉刷新 / 触底 ---------- */

  onPullDownRefresh: function () {
    this.clearSearchTimer();
    this.needRefresh = false;
    this.reload({ skeleton: false }).then(function () {
      wx.stopPullDownRefresh();
    }, function () {
      wx.stopPullDownRefresh();
    });
  },

  onReachBottom: function () {
    this.loadMore();
  }
});
