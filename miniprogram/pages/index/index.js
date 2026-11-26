/**
 * 菜品流首页（SPEC §2 / §5 / §6）
 * 两列瀑布 + 关键字搜索（300ms 防抖）+ 标签筛选 + 下拉刷新 + 触底加载 + 首屏骨架 + 空状态
 * 数据只经 utils/api.js（SPEC §1），本页不碰 wx.cloud.*
 */

var api = require('../../utils/api.js');

var PAGE_SIZE = 10;
var DEBOUNCE_MS = 300;
var MAX_TAGS = 20;

// 引导浮层的两个本地标记：档案（nickname/avatar）为空且没点过「稍后再说」才弹
var GUIDE_SKIP_KEY = 'profileGuideSkipped';
var MAX_NICKNAME = 20;

function toast(title) {
  wx.showToast({ title: title, icon: 'none', duration: 2000 });
}

function readStorage(key) {
  try {
    var value = wx.getStorageSync(key);
    return typeof value === 'string' ? value : '';
  } catch (err) {
    console.error('[index] 读取缓存失败 ' + key, err);
    return '';
  }
}

function writeStorage(key, value) {
  try {
    wx.setStorageSync(key, value);
  } catch (err) {
    console.error('[index] 写入缓存失败 ' + key, err);
  }
}

// 「稍后再说」存的是布尔值，不能套 readStorage 的字符串归一（会把 true 变成 '' ）
function hasSkippedGuide() {
  try {
    return !!wx.getStorageSync(GUIDE_SKIP_KEY);
  } catch (err) {
    console.error('[index] 读取引导标记失败', err);
    return false;
  }
}

/**
 * 头像上传到云存储换 fileID（与「我的」页同一套做法）。
 * @param {string} filePath chooseAvatar 给的本地临时路径
 * @param {string} cloudPath 云存储路径
 * @returns {Promise<string>} fileID
 */
function uploadAvatar(filePath, cloudPath) {
  return new Promise(function (resolve, reject) {
    try {
      wx.cloud.uploadFile({
        cloudPath: cloudPath,
        filePath: filePath,
        success: function (res) {
          if (res && res.fileID) {
            resolve(res.fileID);
            return;
          }
          reject(new Error('上传没有返回 fileID'));
        },
        fail: function (err) {
          reject(err || new Error('头像上传失败'));
        }
      });
    } catch (err) {
      reject(err || new Error('头像上传异常'));
    }
  });
}

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
    emptyHint: '等主人家端上第一道菜',
    // 首次进入引导（可跳过）：guideAvatarUrl 存本地临时路径，点「保存」时才上传
    guideVisible: false,
    guideNickname: '',
    guideAvatarUrl: '',
    guideSaving: false
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
    // 引导只在首页判断（别的页面不弹），且每次进入 App 最多判断一次
    this.maybeShowProfileGuide();
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

  /* ---------- 首次进入引导：补昵称 / 头像（可跳过） ---------- */

  // 微信不允许「不给头像昵称就不给用」，所以这里永远可跳过；
  // 只在首页 onShow 判断，且每次进入 App 只判断一次。
  maybeShowProfileGuide: function () {
    if (this.guideChecked) {
      return;
    }
    this.guideChecked = true;
    var nickname = readStorage('nickname');
    var avatar = readStorage('avatar');
    var skipped = hasSkippedGuide();
    if (!nickname && !avatar && !skipped) {
      this.setData({ guideVisible: true });
    }
  },

  // 遮罩只吞掉点击（避免误触到底下的卡片），本身不关闭浮层
  onGuideMaskTap: function () {
    return;
  },

  onGuideChooseAvatar: function (event) {
    var tempPath = (event && event.detail && event.detail.avatarUrl) || '';
    if (!tempPath) {
      return;
    }
    // 先本地回显；点「保存」时才上传，选完又跳走不会留下垃圾文件
    this.setData({ guideAvatarUrl: tempPath });
  },

  // 临时路径失效就落回纯 CSS 的「点头像」占位，不留裂图
  onGuideAvatarError: function () {
    this.setData({ guideAvatarUrl: '' });
  },

  onGuideNicknameInput: function (event) {
    var value = (event && event.detail && event.detail.value) || '';
    this.setData({ guideNickname: value });
  },

  onGuideSave: function () {
    var self = this;
    if (this.data.guideSaving) {
      return;
    }
    var nickname = (this.data.guideNickname || '').trim();
    if (nickname.length > MAX_NICKNAME) {
      nickname = nickname.slice(0, MAX_NICKNAME);
    }
    var tempPath = this.data.guideAvatarUrl || '';
    // 昵称头像都空：不上传、不落库，原地提示
    if (!nickname && !tempPath) {
      toast('至少填个称呼');
      return;
    }

    var app = getApp();
    var openid = (app && app.globalData && app.globalData.openid) || '';
    var cloudPath = 'avatars/' + (openid || 'anon') + '-' + Date.now() + '.jpg';
    // 没选头像就不上传，avatar 传空串（后端允许只存昵称）
    var uploading = tempPath ? uploadAvatar(tempPath, cloudPath) : Promise.resolve('');

    this.setData({ guideSaving: true });
    uploading.then(
      function onUploaded(fileID) {
        var avatar = fileID || '';
        var saving;
        try {
          saving = api.profileSave({ nickname: nickname, avatar: avatar });
        } catch (err) {
          console.error('[index] 引导资料保存异常', err);
          self.setData({ guideSaving: false });
          toast('保存失败，请重试');
          return;
        }
        return saving.then(
          function onSaved() {
            // 云端与本地缓存一起写，下次启动就不会再弹
            writeStorage('nickname', nickname);
            writeStorage('avatar', avatar);
            self.setData({
              guideVisible: false,
              guideSaving: false,
              guideNickname: '',
              guideAvatarUrl: ''
            });
            toast(nickname ? '记住你啦' : '头像存好啦');
          },
          function onSaveFail(err) {
            // api.js 已经 toast 过；浮层留在原地，不假装成功
            console.error('[index] 引导资料保存失败', err);
            self.setData({ guideSaving: false });
          }
        );
      },
      function onUploadFail(err) {
        console.error('[index] 引导头像上传失败', err);
        self.setData({ guideSaving: false });
        toast('头像没存上，请重试');
      }
    );
  },

  onGuideSkip: function () {
    if (this.data.guideSaving) {
      return;
    }
    // 记一笔，以后不再弹
    writeStorage(GUIDE_SKIP_KEY, true);
    this.setData({
      guideVisible: false,
      guideSaving: false,
      guideNickname: '',
      guideAvatarUrl: ''
    });
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
