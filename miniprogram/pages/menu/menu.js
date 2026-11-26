/**
 * 点菜单（SPEC-v1.0.8 §1.3 / §2.1 / §3）
 *
 * 三块内容：
 *  1. 顶部当前状态（标题 / 日期 / 餐次 / 人数 / 剩余时间）
 *  2. 主人家专属控制区（开始点菜浮层 / 结束点菜；非主人家什么都不显示）
 *  3. 本轮点了什么（封面 + 菜名 + 点菜人 + 想吃的人），底部进历史点菜单
 *  4. 结束确认（SPEC-v1.0.8 §4）：结束之后主人家逐菜勾「已做 / 未做」，
 *     只有勾了「已做」的菜在 menu.review 里让后端 cookedCount +1；
 *     确认过（reviewedAt 有值）就只读展示徽标，不能再改。
 *
 * 关键事实：
 *  - menu.detail 的 orders[] 每个元素带 orderId（后端 v1.0.8 补充），取消点菜直接用这个 id；
 *    不需要任何旁路请求（订单列表那个 action 仅主人家可调，且不支持按菜单过滤）。
 *  - 取消权限：**任何人都能取消任何一条**（用户 v1.0.8 明确要求，后端已放开权限）；
 *    前端仍保留二次确认弹窗。熟人小圈子的取舍：点错了谁都能撤回。
 */

var api = require('../../utils/api.js');
var format = require('../../utils/format.js');

var MEAL_TYPES = ['早餐', '午餐', '晚餐', '夜宵'];

// picker 的 range 用字符串数组（数字数组在部分基础库上渲染为空白），下标即人数，0 = 不限
var HEADCOUNTS = [];
for (var h = 0; h <= 20; h++) {
  HEADCOUNTS.push(h === 0 ? '不限' : h + ' 人');
}

var HISTORY_PAGE_SIZE = 10;
// 没有进行中的一轮时，往最近几轮里找「已结束但还没确认」的那一轮（§4）
var PENDING_SCAN_SIZE = 5;
var WANT_TIP_MS = 2000;
var TICK_MS = 30000;

function toast(title) {
  wx.showToast({ title: title, icon: 'none', duration: 2000 });
}

// 两位补零：不用 padStart，老基础库上没有
function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

// 结束确认的状态位集中在这里清，免得上一轮的结果漏到下一轮
function withClearReview(patch) {
  var out = patch || {};
  out.reviewMenu = null;
  out.reviewEditable = false;
  out.reviewDone = false;
  out.reviewAtText = '';
  out.decisions = {};
  out.reviewSubmitting = false;
  out.reviewDeleting = false;
  out.reviewEmpty = false;
  return out;
}

/**
 * 身份：app.onLaunch 的 login 是异步的，冷启动直达本页时 role 可能还是 guest。
 * openid 已有 -> 身份已确定；openid 为空 -> 等 login 结果再判。
 * @returns {Promise<{isOwner:boolean, openid:string}>}
 */
function resolveIdentity() {
  var app = null;
  try {
    app = getApp();
  } catch (err) {
    app = null;
  }
  if (!app) {
    return Promise.resolve({ isOwner: false, openid: '' });
  }
  var global = app.globalData || {};
  var owner = typeof app.isOwner === 'function' ? app.isOwner() : false;
  if (global.openid) {
    return Promise.resolve({ isOwner: owner, openid: global.openid });
  }
  if (typeof app.signIn !== 'function') {
    return Promise.resolve({ isOwner: owner, openid: '' });
  }
  return app.signIn().then(
    function onSuccess() {
      var next = null;
      try {
        next = getApp();
      } catch (err) {
        next = null;
      }
      var g = (next && next.globalData) || {};
      return {
        isOwner: next && typeof next.isOwner === 'function' ? next.isOwner() : owner,
        openid: g.openid || ''
      };
    },
    function onFail() {
      return { isOwner: owner, openid: '' };
    }
  );
}

/* ---------- 纯函数 ---------- */

function todayText() {
  return format.formatDate(Date.now());
}

// 按当前时间猜一个餐次，作为浮层默认值
function guessMealType() {
  var hour = new Date().getHours();
  if (hour < 10) {
    return '早餐';
  }
  if (hour < 15) {
    return '午餐';
  }
  if (hour < 21) {
    return '晚餐';
  }
  return '夜宵';
}

// 剩余时间：endsAt 为空表示手动结束
function remainingText(endsAt, base) {
  if (!endsAt) {
    return '手动结束';
  }
  var now = base === undefined ? Date.now() : base;
  var diff = endsAt - now;
  if (!(diff > 0)) {
    return '已到点';
  }
  var minutes = Math.floor(diff / 60000);
  if (minutes < 1) {
    return '不到 1 分钟';
  }
  if (minutes < 60) {
    return minutes + ' 分钟';
  }
  var hours = Math.floor(minutes / 60);
  var rest = minutes % 60;
  if (hours < 24) {
    return hours + ' 小时' + (rest ? ' ' + rest + ' 分钟' : '');
  }
  return Math.floor(hours / 24) + ' 天' + (hours % 24 ? ' ' + (hours % 24) + ' 小时' : '');
}

// 'YYYY-MM-DD' + 'HH:mm' -> 本地时间戳；格式不对返回 0
function composeEndsAt(dateText, timeText) {
  var dm = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(dateText || ''));
  var tm = /^(\d{1,2}):(\d{2})$/.exec(String(timeText || ''));
  if (!dm || !tm) {
    return 0;
  }
  var year = Number(dm[1]);
  var month = Number(dm[2]);
  var day = Number(dm[3]);
  var hour = Number(tm[1]);
  var minute = Number(tm[2]);
  if (!(hour >= 0 && hour <= 23) || !(minute >= 0 && minute <= 59)) {
    return 0;
  }
  var ts = new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
  return isFinite(ts) ? ts : 0;
}

function decorateMenu(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  var id = typeof raw._id === 'string' && raw._id ? raw._id : typeof raw.id === 'string' ? raw.id : '';
  if (!id) {
    return null;
  }
  var headcount = Number(raw.headcount);
  if (!isFinite(headcount) || headcount < 0) {
    headcount = 0;
  }
  headcount = Math.floor(headcount);
  var endsAt =
    typeof raw.endsAt === 'number' && isFinite(raw.endsAt) && raw.endsAt > 0 ? raw.endsAt : 0;
  var expired = raw.expired === true;
  var reviewedAt =
    typeof raw.reviewedAt === 'number' && isFinite(raw.reviewedAt) && raw.reviewedAt > 0
      ? raw.reviewedAt
      : 0;
  var review =
    raw.review && typeof raw.review === 'object' && !Array.isArray(raw.review) ? raw.review : null;
  return {
    id: id,
    title: raw.title ? String(raw.title) : '点菜单',
    dateText: raw.dateText ? String(raw.dateText) : '',
    mealType: raw.mealType ? String(raw.mealType) : '',
    headcount: headcount,
    headcountText: headcount > 0 ? headcount + ' 人' : '人数不限',
    endsAt: endsAt,
    remainingText: remainingText(endsAt),
    expired: expired,
    status: raw.status === 'open' ? 'open' : 'closed',
    statusText: expired || raw.status !== 'open' ? '已结束' : '进行中',
    reviewedAt: reviewedAt,
    review: review
  };
}

/**
 * 从 menu.list 的返回里挑出「已结束但还没确认」的轮次（§4）。
 * menu.current 只返回 open 的菜单，待确认的活只能这样翻出来。
 */
function pickPendingReviews(res) {
  var rows = res && Array.isArray(res.list) ? res.list : [];
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var menu = decorateMenu(rows[i]);
    if (menu && menu.status === 'closed' && !menu.reviewedAt) {
      out.push(menu);
    }
  }
  return out;
}

/**
 * 结束确认的显示状态（§4），两个视图共用：
 *  - reviewedAt 有值（不论哪一轮、谁在看）-> 只读徽标 + 确认时间
 *  - 只有「待确认」视图（forReview）里才允许改：已结束、没确认、且是主人家
 *    普通视图永远拿不到 reviewEditable，因此不会出现 chip / 确认按钮。
 */
function reviewFlags(menu, isOwner, forReview) {
  var closed = !!menu && menu.status === 'closed';
  var reviewed = !!menu && !!menu.reviewedAt;
  return {
    reviewMenu: menu || null,
    reviewDone: reviewed,
    reviewAtText: reviewed ? format.formatTime(menu.reviewedAt) : '',
    reviewEditable: !!(forReview === true && closed && !reviewed && isOwner)
  };
}

// 想吃的人：只显示头像，点一下才知道是谁
function decorateWants(rawList, myOpenid) {
  var out = [];
  var wanted = false;
  var list = Array.isArray(rawList) ? rawList : [];
  for (var i = 0; i < list.length; i++) {
    var w = list[i] || {};
    var nickname = w.nickname ? String(w.nickname) : '一位朋友';
    var openid = typeof w.openid === 'string' ? w.openid : '';
    out.push({
      openid: openid,
      nickname: nickname,
      avatar: typeof w.avatar === 'string' ? w.avatar : '',
      avatarText: nickname.charAt(0)
    });
    if (myOpenid && openid === myOpenid) {
      wanted = true;
    }
  }
  return { wants: out, wanted: wanted };
}

/**
 * @param {object} raw  menu.detail 里的一道菜
 * @param {string} myOpenid
 * @param {boolean} readonly true = 历史菜单，不给取消按钮
 * @param {{review:(object|null), reviewed:boolean, editable:boolean}} reviewInfo 结束确认相关
 */
function decorateDish(raw, myOpenid, readonly, reviewInfo) {
  var d = raw && typeof raw === 'object' ? raw : {};
  var info = reviewInfo && typeof reviewInfo === 'object' ? reviewInfo : {};
  var dishId = typeof d.dishId === 'string' ? d.dishId : '';
  var reviewMap = info.review && typeof info.review === 'object' ? info.review : null;
  // 只读徽标：review 里没有这个 dishId（比如确认后才被点的）一律按「未做」，不留空
  var mark = '';
  if (info.reviewed === true) {
    mark = dishId && reviewMap && reviewMap[dishId] === 'done' ? 'done' : 'missed';
  }
  // 待确认时默认「已做」：主人家既然点了这一段，多半是做了，宁可让他取消
  var decision = info.editable === true ? 'done' : '';
  var orders = [];
  var rawOrders = Array.isArray(d.orders) ? d.orders : [];
  for (var i = 0; i < rawOrders.length; i++) {
    var item = rawOrders[i] || {};
    var nickname = item.nickname ? String(item.nickname) : '一位朋友';
    var openid = typeof item.openid === 'string' ? item.openid : '';
    var createdAt = typeof item.createdAt === 'number' ? item.createdAt : 0;
    // orderId 由 menu.detail 直接给出，取消点菜不用再旁路查订单；
    // 历史菜单只读，顺手把 orderId 抹掉，多一道防线
    var orderId = readonly ? '' : typeof item.orderId === 'string' ? item.orderId : '';
    orders.push({
      key: orderId || dishId + '|' + openid + '|' + createdAt,
      orderId: orderId,
      openid: openid,
      nickname: nickname,
      avatar: typeof item.avatar === 'string' ? item.avatar : '',
      avatarText: nickname.charAt(0),
      note: item.note ? String(item.note) : '',
      timeText: format.formatTime(createdAt)
    });
  }
  var wantsInfo = decorateWants(d.wants, myOpenid);
  return {
    dishId: dishId,
    dishName: d.dishName ? String(d.dishName) : '这道菜',
    dishCover: typeof d.dishCover === 'string' ? d.dishCover : '',
    orderCount: orders.length,
    orders: orders,
    wants: wantsInfo.wants,
    wanted: wantsInfo.wanted,
    wantTip: '',
    busy: false,
    // 结束确认：decision 是待确认时的切换值，mark 是确认后的只读徽标
    decision: decision,
    mark: mark
  };
}

Page({
  data: {
    isOwner: false,
    myOpenid: '',
    loading: true,
    hasMenu: false,
    menu: null,
    expiredHint: '',
    dishes: [],
    readonly: false,
    viewMenu: null,

    // 两个视图：normal = 开新一轮 / 看这一轮；review = 收尾上一轮（§4）
    viewMode: 'normal',
    pendingReviewCount: 0,
    reviewEmpty: false,

    // 结束确认（§4）
    reviewMenu: null,
    reviewEditable: false,
    reviewDone: false,
    reviewAtText: '',
    decisions: {},
    reviewSubmitting: false,
    reviewDeleting: false,

    // 开始点菜浮层（start = 开新一轮，edit = 改这一轮的前置信息，同一个浮层两种模式）
    sheetShow: false,
    sheetMode: 'start',
    submitting: false,
    mealTypes: MEAL_TYPES,
    headcounts: HEADCOUNTS,
    headcountIndex: 0,
    form: {
      title: '今天吃什么',
      dateText: '',
      mealType: '晚餐',
      headcount: 0,
      autoEnd: false,
      endTime: ''
    },

    // 历史点菜单浮层
    historyShow: false,
    historyList: [],
    historyPage: 0,
    historyHasMore: true,
    historyLoading: false,
    historyTotal: 0,
    historyDeleting: false
  },

  onLoad: function () {
    var self = this;
    this.unloaded = false;
    this.wantTipTimers = {};
    this.resetForm();
    resolveIdentity().then(function (identity) {
      if (self.unloaded) {
        return;
      }
      self.setData({ myOpenid: identity.openid, isOwner: !!identity.isOwner });
      self.ready = true;
      self.refresh();
    });
  },

  onShow: function () {
    if (!this.ready) {
      return;
    }
    this.refresh();
  },

  onHide: function () {
    this.clearTicker();
  },

  onUnload: function () {
    this.unloaded = true;
    this.clearTicker();
    this.clearWantTipTimers();
  },

  onPullDownRefresh: function () {
    var self = this;
    var stop = function () {
      if (!self.unloaded) {
        wx.stopPullDownRefresh();
      }
    };
    if (this.data.readonly && this.data.viewMenu) {
      Promise.all([this.refresh(), this.loadDetail(this.data.viewMenu.id, true)]).then(stop, stop);
      return;
    }
    this.refresh().then(stop, stop);
  },

  /* ---------- 状态刷新 ---------- */

  refresh: function () {
    var self = this;
    return api.menuCurrent().then(
      function onSuccess(menu) {
        if (self.unloaded) {
          return null;
        }
        var decorated = decorateMenu(menu);
        var hasMenu = !!decorated && !decorated.expired;
        var patch = {
          hasMenu: hasMenu,
          menu: hasMenu ? decorated : null,
          expiredHint:
            !hasMenu && decorated ? '上一轮（' + decorated.title + '）已经结束' : ''
        };
        self.setData(patch);
        self.startTicker(hasMenu ? decorated.endsAt : 0);
        // 停在「待确认」视图：只同步状态与待确认条数，别打断正在逐菜确认的人
        if (self.data.viewMode === 'review') {
          return self.revalidateReviewView();
        }
        // 正在看历史时不打断阅读，只更新顶部状态
        if (self.data.readonly) {
          return null;
        }
        if (hasMenu) {
          return self.loadDetail(decorated.id, false);
        }
        // 没有进行中的一轮：列表清空，只剩下「待确认」入口要点亮
        self.setData(withClearReview({ dishes: [], viewMenu: null, loading: false }));
        return self.loadPendingReviews();
      },
      function onFail(err) {
        console.error('[menu] 读取当前菜单失败', err);
        if (!self.unloaded) {
          self.setData({ loading: false });
        }
        return null;
      }
    );
  },

  /**
   * 统计「已结束但还没确认」的轮次（§4），只主人家查 —— 游客没有确认权限，
   * 也就不用多发这一条请求。
   * @returns {Promise<Array>} 最近几轮里的待确认菜单（新的在前）
   */
  loadPendingReviews: function () {
    var self = this;
    if (!this.data.isOwner) {
      if (this.data.pendingReviewCount) {
        this.setData({ pendingReviewCount: 0 });
      }
      return Promise.resolve([]);
    }
    return api.menuList({ page: 1, pageSize: PENDING_SCAN_SIZE }).then(
      function onSuccess(res) {
        if (self.unloaded) {
          return [];
        }
        var list = pickPendingReviews(res);
        self.setData({ pendingReviewCount: list.length });
        return list;
      },
      function onFail(err) {
        console.error('[menu] 统计待确认的点菜单失败', err);
        return [];
      }
    );
  },

  /* ---------- 「待确认」视图（§4） ---------- */

  onOpenReview: function () {
    var self = this;
    if (this.data.viewMode === 'review' || !this.data.isOwner) {
      return Promise.resolve(null);
    }
    this.setData(
      withClearReview({
        viewMode: 'review',
        readonly: false,
        historyShow: false,
        dishes: [],
        viewMenu: null,
        loading: true
      })
    );
    return this.loadPendingReviews().then(function (list) {
      if (self.unloaded || self.data.viewMode !== 'review') {
        return null;
      }
      if (!list.length) {
        // 没有待确认的轮次也照样进 review 视图：用空状态说明，等用户自己按返回
        self.showReviewEmpty();
        return null;
      }
      return self.loadDetail(list[0].id, false, true);
    });
  },

  /** review 视图的空状态：不动 viewMode，也不 toast，空状态本身就是反馈 */
  showReviewEmpty: function () {
    this.setData({
      reviewEmpty: true,
      reviewEditable: false,
      reviewDone: false,
      reviewAtText: '',
      reviewMenu: null,
      decisions: {},
      reviewSubmitting: false,
      reviewDeleting: false,
      dishes: [],
      viewMenu: null,
      loading: false
    });
  },

  onCloseReview: function () {
    if (this.data.viewMode !== 'review') {
      return;
    }
    this.backToNormalView();
  },

  // 回到普通视图：清掉确认态，再把当前这一轮（或空态）拉回来
  backToNormalView: function () {
    var self = this;
    this.setData(
      withClearReview({
        viewMode: 'normal',
        dishes: [],
        viewMenu: null,
        loading: this.data.hasMenu && !!this.data.menu
      })
    );
    this.loadPendingReviews();
    if (this.data.hasMenu && this.data.menu) {
      return this.loadDetail(this.data.menu.id, false);
    }
    this.setData({ dishes: [], viewMenu: null, loading: false });
    return Promise.resolve(null);
  },

  /**
   * onShow / 下拉刷新时回到「待确认」视图的兜底：
   * 那一轮要是已经被（别的设备）确认掉了，就地显示空状态 —— 和进入时的行为一致，
   * review 视图只在用户主动点「返回点菜单」时才离开。
   */
  revalidateReviewView: function () {
    var self = this;
    return this.loadPendingReviews().then(function (list) {
      if (self.unloaded || self.data.viewMode !== 'review') {
        return null;
      }
      if (!list.length) {
        self.showReviewEmpty();
        return null;
      }
      // 同一轮重拉会保留已勾的「未做」（loadDetail 里的 sameMenu 逻辑）
      return self.loadDetail(list[0].id, false, true);
    });
  },

  /**
   * 拉某个菜单的详情并整形。
   * @param {string} menuId
   * @param {boolean} readonly true = 看历史，不提供取消/想吃
   * @param {boolean} forReview true = 「待确认」视图，才允许出现 chip 与确认按钮
   */
  loadDetail: function (menuId, readonly, forReview) {
    var self = this;
    if (!menuId) {
      this.setData(withClearReview({ dishes: [], loading: false }));
      return Promise.resolve();
    }
    this.setData({ loading: this.data.dishes.length === 0 });
    return api.menuDetail(menuId).then(
      function onSuccess(res) {
        if (self.unloaded) {
          return null;
        }
        var menu = decorateMenu(res && res.menu);
        var flags = reviewFlags(menu, self.data.isOwner, forReview);
        var reviewInfo = {
          review: menu ? menu.review : null,
          reviewed: flags.reviewDone,
          editable: flags.reviewEditable
        };
        var raw = res && Array.isArray(res.dishes) ? res.dishes : [];
        var dishes = [];
        var decisions = {};
        // 同一条菜单重拉（取消点菜 / 下拉刷新）时保留已勾的「未做」，别让主人家白点一遍
        var previous = self.data.decisions || {};
        var sameMenu = !!(
          menu &&
          self.data.viewMenu &&
          self.data.viewMenu.id === menu.id &&
          self.data.reviewEditable
        );
        for (var i = 0; i < raw.length; i++) {
          var dish = decorateDish(raw[i], self.data.myOpenid, readonly, reviewInfo);
          if (reviewInfo.editable && dish.dishId && sameMenu && previous[dish.dishId] === 'missed') {
            dish.decision = 'missed';
          }
          dishes.push(dish);
          // 待确认时把每一道菜都塞进 decisions，默认「已做」
          if (reviewInfo.editable && dish.dishId) {
            decisions[dish.dishId] = dish.decision;
          }
        }
        self.setData({
          dishes: dishes,
          viewMenu: menu,
          reviewMenu: flags.reviewMenu,
          reviewEditable: flags.reviewEditable,
          reviewDone: flags.reviewDone,
          reviewAtText: flags.reviewAtText,
          reviewEmpty: false,
          decisions: decisions,
          reviewSubmitting: false,
          loading: false
        });
        return null;
      },
      function onFail(err) {
        console.error('[menu] 加载点菜单详情失败', err);
        if (!self.unloaded) {
          self.setData({ loading: false });
        }
        return null;
      }
    );
  },

  reloadList: function () {
    if (this.data.viewMode === 'review' && this.data.viewMenu) {
      return this.loadDetail(this.data.viewMenu.id, false, true);
    }
    if (this.data.readonly && this.data.viewMenu) {
      return this.loadDetail(this.data.viewMenu.id, true);
    }
    if (this.data.menu) {
      return this.loadDetail(this.data.menu.id, false);
    }
    return Promise.resolve();
  },

  /* ---------- 剩余时间的定时刷新 ---------- */

  startTicker: function (endsAt) {
    this.clearTicker();
    if (!endsAt) {
      return;
    }
    var self = this;
    this.ticker = setInterval(function () {
      if (self.unloaded) {
        self.clearTicker();
        return;
      }
      var menu = self.data.menu;
      if (!menu || menu.endsAt !== endsAt) {
        self.clearTicker();
        return;
      }
      var text = remainingText(endsAt);
      if (text === '已到点') {
        // 到点即失效：先收掉定时器，再整页刷新一次状态
        self.clearTicker();
        self.refresh();
        return;
      }
      self.setData({ 'menu.remainingText': text });
    }, TICK_MS);
  },

  clearTicker: function () {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  },

  clearWantTipTimers: function () {
    var timers = this.wantTipTimers || {};
    var keys = Object.keys(timers);
    for (var i = 0; i < keys.length; i++) {
      if (timers[keys[i]]) {
        clearTimeout(timers[keys[i]]);
      }
    }
    this.wantTipTimers = {};
  },

  /* ---------- 开始点菜浮层 ---------- */

  resetForm: function () {
    this.setData({
      form: {
        title: '今天吃什么',
        dateText: todayText(),
        mealType: guessMealType(),
        headcount: 0,
        autoEnd: false,
        endTime: ''
      },
      headcountIndex: 0
    });
  },

  onOpenStart: function () {
    this.resetForm();
    this.setData({ sheetMode: 'start', sheetShow: true });
  },

  /** 改这一轮的前置信息：复用同一个浮层，预填当前值（§5.3 menu.update） */
  onOpenEdit: function () {
    var menu = this.data.menu;
    if (!menu || !menu.id) {
      toast('这一轮已经不在了');
      return;
    }
    var headcount = Number(menu.headcount);
    if (!isFinite(headcount) || headcount < 0) {
      headcount = 0;
    }
    headcount = Math.min(20, Math.floor(headcount));
    var endTime = '';
    if (menu.endsAt) {
      var end = new Date(menu.endsAt);
      endTime = pad2(end.getHours()) + ':' + pad2(end.getMinutes());
    }
    this.setData({
      sheetMode: 'edit',
      sheetShow: true,
      headcountIndex: headcount,
      form: {
        title: menu.title || '',
        dateText: menu.dateText || todayText(),
        mealType: MEAL_TYPES.indexOf(menu.mealType) === -1 ? guessMealType() : menu.mealType,
        headcount: headcount,
        autoEnd: !!menu.endsAt,
        endTime: endTime
      }
    });
  },

  onCloseSheet: function () {
    if (this.data.submitting) {
      return;
    }
    this.setData({ sheetShow: false, sheetMode: 'start' });
  },

  onSheetMaskTap: function () {
    this.onCloseSheet();
  },

  onFormTitleInput: function (event) {
    this.setData({ 'form.title': (event && event.detail && event.detail.value) || '' });
  },

  onFormDateChange: function (event) {
    var value = event && event.detail ? event.detail.value : '';
    if (!value) {
      return;
    }
    this.setData({ 'form.dateText': value });
  },

  onFormMealTap: function (event) {
    var meal = event.currentTarget.dataset.meal;
    if (MEAL_TYPES.indexOf(meal) === -1) {
      return;
    }
    this.setData({ 'form.mealType': meal });
  },

  onFormHeadcountChange: function (event) {
    var index = Number(event && event.detail ? event.detail.value : 0);
    if (!(index >= 0) || index >= HEADCOUNTS.length) {
      return;
    }
    // 下标就是人数：0 = 不限
    this.setData({ headcountIndex: index, 'form.headcount': index });
  },

  onFormAutoEndChange: function (event) {
    var on = !!(event && event.detail && event.detail.value);
    this.setData({ 'form.autoEnd': on });
  },

  onFormTimeChange: function (event) {
    var value = event && event.detail ? event.detail.value : '';
    if (!value) {
      return;
    }
    this.setData({ 'form.endTime': value });
  },

  /**
   * 浮层表单 -> 可提交的值。开始与修改共用同一套校验。
   * endsAt：开关关着就是 null（开始 = 不预设；修改 = 取消预设结束时间）。
   * @returns {object|null} null = 已经 toast 过，调用方直接返回
   */
  collectForm: function () {
    var form = this.data.form || {};

    var title = String(form.title || '').trim();
    if (title.length > 30) {
      title = title.slice(0, 30);
    }
    if (!title) {
      title = '今天吃什么';
    }
    var dateText = form.dateText || todayText();
    var mealType = MEAL_TYPES.indexOf(form.mealType) === -1 ? guessMealType() : form.mealType;
    var headcount = Number(form.headcount);
    if (!isFinite(headcount) || headcount < 0) {
      headcount = 0;
    }
    headcount = Math.min(20, Math.floor(headcount));

    var endsAt = null;
    if (form.autoEnd) {
      if (!form.endTime) {
        toast('先选一个结束时刻');
        return null;
      }
      endsAt = composeEndsAt(dateText, form.endTime);
      if (!endsAt) {
        toast('结束时间没读懂，重选一次');
        return null;
      }
      if (endsAt <= Date.now()) {
        toast('结束时间要晚于现在');
        return null;
      }
    }

    return {
      title: title,
      dateText: dateText,
      mealType: mealType,
      headcount: headcount,
      endsAt: endsAt
    };
  },

  onSubmitStart: function () {
    var self = this;
    if (this.data.submitting) {
      return;
    }
    var payload = this.collectForm();
    if (!payload) {
      return;
    }

    this.setData({ submitting: true });

    // 同一个浮层两种模式：edit 走 menu.update，start 走 menu.start
    if (this.data.sheetMode === 'edit') {
      this.submitEdit(payload);
      return;
    }

    api.menuStart(payload).then(
      function onSuccess() {
        if (self.unloaded) {
          return;
        }
        self.setData(
          withClearReview({
            submitting: false,
            sheetShow: false,
            sheetMode: 'start',
            readonly: false,
            viewMenu: null,
            dishes: []
          })
        );
        toast('开始点菜啦');
        self.refresh();
      },
      function onFail(err) {
        // api.js 已 toast，这里只收起 loading
        console.error('[menu] 开始点菜失败', err);
        if (!self.unloaded) {
          self.setData({ submitting: false });
        }
      }
    );
  },

  /** 保存修改（§5.3 menu.update）：成功 toast + 关浮层 + 刷新详情；失败只恢复按钮 */
  submitEdit: function (payload) {
    var self = this;
    var menu = this.data.menu;
    if (!menu || !menu.id) {
      this.setData({ submitting: false });
      toast('这一轮已经不在了');
      return;
    }

    api.menuUpdate(menu.id, payload).then(
      function onSuccess() {
        if (self.unloaded) {
          return;
        }
        self.setData({ submitting: false, sheetShow: false, sheetMode: 'start' });
        toast('改好了');
        self.refresh();
      },
      function onFail(err) {
        // api.js 已经 toast 过，这里只恢复按钮可用态
        console.error('[menu] 修改点菜信息失败', err);
        if (!self.unloaded) {
          self.setData({ submitting: false });
        }
      }
    );
  },

  /* ---------- 结束点菜 ---------- */

  onCloseMenu: function () {
    var self = this;
    wx.showModal({
      title: '结束这一轮点菜？',
      content: '结束后大家就不能再点了，已经点的记录会留在历史里。',
      confirmText: '结束',
      cancelText: '再等等',
      success: function (res) {
        if (!res || !res.confirm) {
          return;
        }
        api.menuClose().then(
          function onSuccess() {
            if (self.unloaded) {
              return;
            }
            toast('这一轮结束啦');
            self.setData(withClearReview({ readonly: false, viewMenu: null }));
            self.refresh();
          },
          function onFail(err) {
            console.error('[menu] 结束点菜失败', err);
          }
        );
      }
    });
  },

  /* ---------- 结束确认：逐菜「已做 / 未做」（§4） ---------- */

  // 两个 chip 互斥：点一下就切成另一个，同时同步 data.decisions
  onDecide: function (event) {
    if (!this.data.reviewEditable) {
      return;
    }
    var dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    var index = Number(dataset.index);
    var dish = this.data.dishes[index];
    if (!dish) {
      return;
    }
    var decision = dataset.decision === 'missed' ? 'missed' : 'done';
    var patch = {};
    patch['dishes[' + index + '].decision'] = decision;
    if (dish.dishId) {
      var current = this.data.decisions || {};
      var keys = Object.keys(current);
      var decisions = {};
      for (var i = 0; i < keys.length; i++) {
        decisions[keys[i]] = current[keys[i]];
      }
      decisions[dish.dishId] = decision;
      patch.decisions = decisions;
    }
    this.setData(patch);
  },

  // 以 data.decisions 为准，再按 dishes 的当前值兜一层，保证提交的每一道菜都有结论
  collectDecisions: function () {
    var out = {};
    var current = this.data.decisions || {};
    var keys = Object.keys(current);
    var i;
    for (i = 0; i < keys.length; i++) {
      out[keys[i]] = current[keys[i]] === 'missed' ? 'missed' : 'done';
    }
    var dishes = this.data.dishes || [];
    for (i = 0; i < dishes.length; i++) {
      var dish = dishes[i];
      if (!dish || !dish.dishId) {
        continue;
      }
      out[dish.dishId] = dish.decision === 'missed' ? 'missed' : 'done';
    }
    return out;
  },

  onSubmitReview: function () {
    var self = this;
    if (this.data.viewMode !== 'review' || this.data.reviewSubmitting || !this.data.reviewEditable) {
      return;
    }
    var menu = this.data.reviewMenu || this.data.viewMenu;
    if (!menu || !menu.id) {
      toast('没找到要确认的那一轮');
      return;
    }
    var decisions = this.collectDecisions();

    wx.showModal({
      title: '确认这一轮？',
      content: '确认后这一轮就锁定了，被点次数会立刻累加。',
      confirmText: '确认',
      cancelText: '再想想',
      success: function (res) {
        if (!res || !res.confirm) {
          return;
        }
        self.setData({ reviewSubmitting: true });
        api.menuReview(menu.id, decisions).then(
          function onSuccess() {
            if (self.unloaded) {
              return;
            }
            self.setData({ reviewSubmitting: false });
            toast('确认好了');
            // 确认成功：自动退回普通视图，顺便把「待确认」条数刷新掉
            self.backToNormalView();
          },
          function onFail(err) {
            // api.js 已经 toast 过，这里只恢复按钮可用态
            console.error('[menu] 确认这一轮失败', err);
            if (self.unloaded) {
              return;
            }
            self.setData({ reviewSubmitting: false });
          }
        );
      }
    });
  },

  /* ---------- 删除这一轮（§5.3 menu.delete，软删除进回收站） ---------- */

  onDeleteReviewMenu: function () {
    var self = this;
    if (this.data.viewMode !== 'review' || this.data.reviewDeleting) {
      return;
    }
    var menu = this.data.reviewMenu || this.data.viewMenu;
    if (!menu || !menu.id) {
      toast('没找到要删的那一轮');
      return;
    }
    wx.showModal({
      title: '删除这一轮？',
      content: '这一轮和它的点菜记录会一起进回收站，30 天内可以恢复',
      confirmText: '删除',
      cancelText: '再想想',
      success: function (res) {
        if (!res || !res.confirm) {
          return;
        }
        self.setData({ reviewDeleting: true });
        api.menuDelete(menu.id).then(
          function onSuccess() {
            if (self.unloaded) {
              return;
            }
            self.setData({ reviewDeleting: false });
            toast('已移入回收站');
            // 退回普通视图，顺便重算「待确认」条数
            self.backToNormalView();
          },
          function onFail(err) {
            // api.js 已经 toast 过，这里只恢复按钮可用态
            console.error('[menu] 删除这一轮失败', err);
            if (!self.unloaded) {
              self.setData({ reviewDeleting: false });
            }
          }
        );
      }
    });
  },

  /* ---------- 取消点菜 ---------- */

  onCancelOrder: function (event) {
    var self = this;
    var dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    var orderId = dataset.orderid;
    var dishIndex = Number(dataset.dish);
    var orderIndex = Number(dataset.index);
    var dish = this.data.dishes[dishIndex];

    if (!dish || !dish.orders || !dish.orders[orderIndex]) {
      return;
    }
    var row = dish.orders[orderIndex];
    if (!orderId) {
      // v1.0.8 之前的点菜记录没有 orderId，兜底提示一下
      toast('这条记录太旧了，取消不了');
      return;
    }

    wx.showModal({
      title: '取消这条点菜？',
      content: row.nickname + ' 点的这一份会被撤掉',
      confirmText: '取消点菜',
      cancelText: '再想想',
      success: function (res) {
        if (!res || !res.confirm) {
          return;
        }
        var busy = {};
        busy['dishes[' + dishIndex + '].busy'] = true;
        self.setData(busy);

        api.orderCancel(orderId).then(
          function onSuccess() {
            if (self.unloaded) {
              return;
            }
            busy['dishes[' + dishIndex + '].busy'] = false;
            self.setData(busy);
            toast('已经撤掉啦');
            // 取消后这条不再出现在 menu.detail 里，重拉一次列表
            self.reloadList();
          },
          function onFail(err) {
            console.error('[menu] 取消点菜失败', err);
            if (self.unloaded) {
              return;
            }
            busy['dishes[' + dishIndex + '].busy'] = false;
            self.setData(busy);
          }
        );
      }
    });
  },

  /* ---------- 想吃 / 取消想吃 ---------- */

  onToggleWant: function (event) {
    var self = this;
    var index = Number((event && event.currentTarget && event.currentTarget.dataset || {}).index);
    var dish = this.data.dishes[index];
    if (!dish || dish.busy || !dish.dishId) {
      return;
    }

    var call = dish.wanted ? api.dishUnwant : api.dishWant;
    var busy = {};
    busy['dishes[' + index + '].busy'] = true;
    this.setData(busy);

    call(dish.dishId).then(
      function onSuccess(res) {
        if (self.unloaded) {
          return;
        }
        var info = decorateWants(res && res.wants, self.data.myOpenid);
        var patch = {};
        patch['dishes[' + index + '].wants'] = info.wants;
        patch['dishes[' + index + '].wanted'] = info.wanted;
        patch['dishes[' + index + '].busy'] = false;
        self.setData(patch);
      },
      function onFail(err) {
        console.error('[menu] 想吃操作失败', err);
        if (self.unloaded) {
          return;
        }
        var patch = {};
        patch['dishes[' + index + '].busy'] = false;
        self.setData(patch);
      }
    );
  },

  // 头像即身份：点一下才显示昵称，2 秒后淡出
  onTapWantAvatar: function (event) {
    var self = this;
    var dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    var index = Number(dataset.index);
    var avatarIndex = Number(dataset.avatar);
    var dish = this.data.dishes[index];
    var person = dish && dish.wants ? dish.wants[avatarIndex] : null;
    if (!person) {
      return;
    }

    var patch = {};
    patch['dishes[' + index + '].wantTip'] = person.nickname + ' 想吃这道菜';
    this.setData(patch);

    var key = 'dish-' + index;
    if (!this.wantTipTimers) {
      this.wantTipTimers = {};
    }
    if (this.wantTipTimers[key]) {
      clearTimeout(this.wantTipTimers[key]);
    }
    this.wantTipTimers[key] = setTimeout(function () {
      self.wantTipTimers[key] = null;
      if (self.unloaded) {
        return;
      }
      var clear = {};
      clear['dishes[' + index + '].wantTip'] = '';
      self.setData(clear);
    }, WANT_TIP_MS);
  },

  // 头像加载失败：清掉这一条的 src，落回纯 CSS 圆形占位，不裂图
  onAvatarError: function (event) {
    var dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    var index = Number(dataset.index);
    var sub = Number(dataset.sub);
    var kind = dataset.kind === 'want' ? 'want' : 'order';
    var dish = this.data.dishes[index];
    if (!dish) {
      return;
    }
    var patch = {};
    if (kind === 'want') {
      if (!dish.wants || !dish.wants[sub]) {
        return;
      }
      patch['dishes[' + index + '].wants[' + sub + '].avatar'] = '';
    } else {
      if (!dish.orders || !dish.orders[sub]) {
        return;
      }
      patch['dishes[' + index + '].orders[' + sub + '].avatar'] = '';
    }
    this.setData(patch);
  },

  /* ---------- 历史点菜单 ---------- */

  onOpenHistory: function () {
    this.setData({ historyShow: true });
    if (!this.data.historyList.length) {
      this.fetchHistory(true);
    }
  },

  onCloseHistory: function () {
    this.setData({ historyShow: false });
  },

  onMoreHistory: function () {
    this.fetchHistory(false);
  },

  /**
   * 历史浮层里删掉一轮（§5.3 menu.delete）。
   * 成功后只把这一条从 historyList 里摘掉、total -1，不整页重载；
   * 删的正好是当前正在看的那一轮 -> 退回 normal 视图。
   */
  onDeleteHistory: function (event) {
    var self = this;
    var dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    var id = typeof dataset.id === 'string' ? dataset.id : '';
    if (!id || this.data.historyDeleting) {
      return;
    }
    wx.showModal({
      title: '删除这一轮？',
      content: '这一轮和它的点菜记录会一起进回收站，30 天内可以恢复',
      confirmText: '删除',
      cancelText: '再想想',
      success: function (res) {
        if (!res || !res.confirm) {
          return;
        }
        self.setData({ historyDeleting: true });
        api.menuDelete(id).then(
          function onSuccess() {
            if (self.unloaded) {
              return;
            }
            var list = self.data.historyList || [];
            var rows = [];
            var i;
            for (i = 0; i < list.length; i++) {
              if (list[i] && list[i].id !== id) {
                rows.push(list[i]);
              }
            }
            var total = Number(self.data.historyTotal) || 0;
            var viewing = !!(self.data.viewMenu && self.data.viewMenu.id === id);
            var isCurrent = !!(self.data.menu && self.data.menu.id === id);
            self.setData({
              historyList: rows,
              historyTotal: Math.max(0, total - 1),
              historyDeleting: false,
              historyShow: viewing || isCurrent ? false : self.data.historyShow
            });
            toast('已移入回收站');
            if (viewing || isCurrent) {
              // 正在看的那一轮（或就是当前这一轮）没了：退回 normal 视图，
              // readonly 一起清掉，再让 refresh 决定要不要重新拉当前这一轮
              self.setData(withClearReview({ readonly: false, viewMenu: null, dishes: [] }));
              self.refresh();
            } else {
              self.loadPendingReviews();
            }
          },
          function onFail(err) {
            // api.js 已经 toast 过，这里只恢复按钮可用态
            console.error('[menu] 删除历史菜单失败', err);
            if (!self.unloaded) {
              self.setData({ historyDeleting: false });
            }
          }
        );
      }
    });
  },

  fetchHistory: function (reset) {
    var self = this;
    if (this.data.historyLoading) {
      return Promise.resolve();
    }
    if (!reset && !this.data.historyHasMore) {
      return Promise.resolve();
    }
    var nextPage = reset ? 1 : this.data.historyPage + 1;
    this.setData({ historyLoading: true });

    // 历史条目只列标题/日期/餐次/人数；菜数要额外拉详情，不值得为它多发请求
    return api.menuList({ page: nextPage, pageSize: HISTORY_PAGE_SIZE }).then(
      function onSuccess(res) {
        if (self.unloaded) {
          return null;
        }
        var raw = (res && res.list) || [];
        var rows = [];
        for (var i = 0; i < raw.length; i++) {
          var menu = decorateMenu(raw[i]);
          if (menu) {
            rows.push(menu);
          }
        }
        self.setData({
          historyList: reset ? rows : self.data.historyList.concat(rows),
          historyPage: nextPage,
          historyHasMore: !!(res && res.hasMore),
          historyTotal: Number(res && res.total) || 0,
          historyLoading: false
        });
        return null;
      },
      function onFail(err) {
        console.error('[menu] 历史菜单加载失败', err);
        if (!self.unloaded) {
          self.setData({ historyLoading: false });
        }
        return null;
      }
    );
  },

  onTapHistory: function (event) {
    var id = (event && event.currentTarget && event.currentTarget.dataset || {}).id;
    if (!id) {
      return;
    }
    this.setData(
      withClearReview({ readonly: true, historyShow: false, dishes: [], loading: true, viewMenu: null })
    );
    this.loadDetail(id, true);
  },

  onBackToCurrent: function () {
    this.setData(
      withClearReview({ readonly: false, viewMenu: null, dishes: [], loading: true })
    );
    if (this.data.hasMenu && this.data.menu) {
      this.loadDetail(this.data.menu.id, false);
      return;
    }
    this.refresh();
  },

  // 浮层内 catchtap 用，阻止冒泡到遮罩
  noop: function () {}
});
