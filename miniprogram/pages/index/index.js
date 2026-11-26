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

// 卡片小按钮「已加」态的停留时间：只用于防连点，过了就回到可点
var ORDER_DONE_HOLD_MS = 1500;
var NO_MENU_LABEL = '还没可以点菜哦~';

function toast(title) {
  wx.showToast({ title: title, icon: 'none', duration: 2000 });
}

function myOpenid() {
  try {
    var app = getApp();
    return (app && app.globalData && app.globalData.openid) || '';
  } catch (err) {
    return '';
  }
}

// likes / wants 都是 [{ openid, nickname, avatar, at }]，判断我有没有点过（SPEC-v1.0.8 §1.1）
function hasPerson(list, openid) {
  if (!openid || !Array.isArray(list)) {
    return false;
  }
  for (var i = 0; i < list.length; i += 1) {
    var row = list[i];
    if (row && typeof row === 'object' && row.openid === openid) {
      return true;
    }
  }
  return false;
}

// 卡片的本地态挂在 _ 开头的字段上：不改写接口返回的对象，也不污染 dish-card 用的字段
function decorateDish(dish, openid) {
  var out = {};
  var key;
  for (key in dish) {
    if (Object.prototype.hasOwnProperty.call(dish, key)) {
      out[key] = dish[key];
    }
  }
  out._liked = hasPerson(dish.likes, openid);
  out._wanted = hasPerson(dish.wants, openid);
  out._likeBusy = false;
  out._wantBusy = false;
  // '' | 'busy'（请求中）| 'done'（已加入点菜单，短暂停留）
  out._order = '';
  return out;
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
    // 点菜前置：有 open 且未过期的菜单才能点（SPEC-v1.0.8 §3.4），onShow 时刷新
    menuReady: false,
    // 首次进入引导（可跳过）：guideAvatarUrl 存本地临时路径，点「保存」时才上传
    guideVisible: false,
    guideNickname: '',
    guideAvatarUrl: '',
    guideSaving: false,
    // 「谁点过这道菜」浮层（SPEC-v1.0.8 §4.3）：页面只传 id / 菜名，数据由组件自己拉
    orderersVisible: false,
    orderersDishId: '',
    orderersDishName: ''
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
    // 每次回到菜谱页都重新取一次菜单状态：可能刚在菜单球里开始 / 结束了点菜
    this.refreshMenu();
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
    this.clearOrderTimers();
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
    // 落库前先给每道菜挂上卡片操作条的本地态（是否已喜欢 / 已想吃 / 点菜状态）
    var openid = myOpenid();
    var decorated = [];
    for (var i = 0; i < incoming.length; i += 1) {
      var row = incoming[i];
      decorated.push(row && typeof row === 'object' ? decorateDish(row, openid) : row);
    }
    var list = replace ? decorated : this.data.list.concat(decorated);
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

  /* ---------- 菜单状态（点菜前置，SPEC-v1.0.8 §3.4） ---------- */

  refreshMenu: function () {
    var self = this;
    return api.menuCurrent().then(function (menu) {
      // menu.current 只返回 open 的菜单，出参再带一个 expired 布尔
      var ready = !!(menu && menu.expired !== true && menu.status !== 'closed');
      self.setData({ menuReady: ready });
    }, function (err) {
      // 读不到菜单就当没有：宁可让按钮置灰，也不要让用户点了再被服务端拒绝
      console.error('[index] 菜单状态读取失败', err);
      self.setData({ menuReady: false });
    });
  },

  /* ---------- 卡片操作条：点菜 / 喜欢 / 想吃（SPEC-v1.0.8 §3.8） ---------- */

  // 找到菜品在左右两列里的位置：只按精确路径 setData，避免整列重渲染
  locateDish: function (id) {
    var groups = ['leftColumn', 'rightColumn'];
    for (var g = 0; g < groups.length; g += 1) {
      var column = this.data[groups[g]] || [];
      for (var i = 0; i < column.length; i += 1) {
        if (column[i] && column[i]._id === id) {
          return { key: groups[g] + '[' + i + ']', dish: column[i] };
        }
      }
    }
    return null;
  },

  // 把一批字段收敛成一次 setData：{ 'leftColumn[0]._liked': true, ... }
  setDishFields: function (key, fields) {
    var patch = {};
    for (var field in fields) {
      if (Object.prototype.hasOwnProperty.call(fields, field)) {
        patch[key + '.' + field] = fields[field];
      }
    }
    this.setData(patch);
  },

  // 响应回来时按 id 重新定位再写：请求期间列表可能已刷新重排，旧索引会写到别的菜上
  writeDishFields: function (id, fields) {
    var spot = this.locateDish(id);
    if (!spot) {
      return;
    }
    this.setDishFields(spot.key, fields);
  },

  // 点菜：必须有进行中的菜单；成功后按钮短暂进「已加」态防连点
  onOrderTap: function (event) {
    var id = (event && event.currentTarget ? event.currentTarget.dataset.id : '') || '';
    if (!id) {
      return;
    }
    // 没有进行中的点菜单：按钮已置灰，这里只提示，绝不进入下单链路
    if (!this.data.menuReady) {
      toast(NO_MENU_LABEL);
      return;
    }
    var spot = this.locateDish(id);
    if (!spot || spot.dish._order) {
      return;
    }
    var self = this;
    var key = spot.key;
    var task;
    this.setDishFields(key, { _order: 'busy' });
    // 点菜人身份：缓存里的昵称 / 头像，没有就传空串（后端允许）
    var profile = { nickname: readStorage('nickname'), avatar: readStorage('avatar') };
    try {
      task = api.orderCreate(id, '', profile);
    } catch (err) {
      console.error('[index] 点菜调用异常', err);
      this.setDishFields(key, { _order: '' });
      return;
    }
    task.then(function () {
      self.writeDishFields(id, { _order: 'done' });
      toast('已加入点菜单');
      // 「已加」只停留一会儿；到点按最新位置复位（期间可能已刷新重排）
      self.orderTimers = self.orderTimers || {};
      if (self.orderTimers[id]) {
        clearTimeout(self.orderTimers[id]);
      }
      self.orderTimers[id] = setTimeout(function () {
        delete self.orderTimers[id];
        self.writeDishFields(id, { _order: '' });
      }, ORDER_DONE_HOLD_MS);
    }, function (err) {
      // api.js 已 toast；这里把按钮退回可点，不假装成功
      console.error('[index] 点菜失败', err);
      self.writeDishFields(id, { _order: '' });
    });
  },

  // 喜欢：乐观更新 + 失败回滚（§3.5 重复点幂等，不会记两次）
  onLikeTap: function (event) {
    var id = (event && event.currentTarget ? event.currentTarget.dataset.id : '') || '';
    var spot = id ? this.locateDish(id) : null;
    if (!spot || spot.dish._likeBusy) {
      return;
    }
    var self = this;
    var key = spot.key;
    var wasLiked = !!spot.dish._liked;
    var task;
    this.setDishFields(key, { _liked: !wasLiked, _likeBusy: true });
    try {
      task = wasLiked ? api.dishUnlike(id) : api.dishLike(id);
    } catch (err) {
      console.error('[index] 喜欢调用异常', err);
      this.setDishFields(key, { _liked: wasLiked, _likeBusy: false });
      return;
    }
    task.then(function (result) {
      var data = result || {};
      // 服务端回了完整 likes 就按它校准，没回就保留乐观值
      var liked = data.liked === true
        ? true
        : (Array.isArray(data.likes) ? hasPerson(data.likes, myOpenid()) : !wasLiked);
      self.writeDishFields(id, { _liked: liked, _likeBusy: false });
    }, function (err) {
      // api.js 已统一 toast；这里回滚到点击前的状态
      console.error('[index] 喜欢切换失败', err);
      self.writeDishFields(id, { _liked: wasLiked, _likeBusy: false });
    });
  },

  // 想吃：同上，走 dishWant / dishUnwant
  onWantTap: function (event) {
    var id = (event && event.currentTarget ? event.currentTarget.dataset.id : '') || '';
    var spot = id ? this.locateDish(id) : null;
    if (!spot || spot.dish._wantBusy) {
      return;
    }
    var self = this;
    var key = spot.key;
    var wasWanted = !!spot.dish._wanted;
    var task;
    this.setDishFields(key, { _wanted: !wasWanted, _wantBusy: true });
    try {
      task = wasWanted ? api.dishUnwant(id) : api.dishWant(id);
    } catch (err) {
      console.error('[index] 想吃调用异常', err);
      this.setDishFields(key, { _wanted: wasWanted, _wantBusy: false });
      return;
    }
    task.then(function (result) {
      var data = result || {};
      var wanted = Array.isArray(data.wants) ? hasPerson(data.wants, myOpenid()) : !wasWanted;
      self.writeDishFields(id, { _wanted: wanted, _wantBusy: false });
    }, function (err) {
      console.error('[index] 想吃切换失败', err);
      self.writeDishFields(id, { _wanted: wasWanted, _wantBusy: false });
    });
  },

  /* ---------- dish-card 事件转发 ----------
   * 卡片里的三个按钮用 triggerEvent 把 id 抛出来（detail.id），
   * 这里只做一层薄包装，把 detail 还原成原来的 currentTarget.dataset.id，
   * 三个原有处理函数一行不动地复用。
   */

  onCardOrder: function (event) {
    return this.onOrderTap({ currentTarget: { dataset: { id: (event && event.detail && event.detail.id) || '' } } });
  },

  onCardLike: function (event) {
    return this.onLikeTap({ currentTarget: { dataset: { id: (event && event.detail && event.detail.id) || '' } } });
  },

  onCardWant: function (event) {
    return this.onWantTap({ currentTarget: { dataset: { id: (event && event.detail && event.detail.id) || '' } } });
  },

  /* ---------- 「谁点过这道菜」浮层（SPEC-v1.0.8 §4.3） ---------- */

  // 卡片「被点 N 次」整块被点：只负责打开浮层，数据由组件自己拉
  onCardOrderers: function (event) {
    var d = (event && event.detail) || {};
    var id = d.id || '';
    if (!id) {
      return;
    }
    this.setData({
      orderersVisible: true,
      orderersDishId: id,
      orderersDishName: d.name || ''
    });
  },

  onOrderersClose: function () {
    this.setData({ orderersVisible: false });
  },

  clearOrderTimers: function () {
    var timers = this.orderTimers || {};
    for (var id in timers) {
      if (Object.prototype.hasOwnProperty.call(timers, id)) {
        clearTimeout(timers[id]);
      }
    }
    this.orderTimers = {};
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
