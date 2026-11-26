/**
 * 菜品详情 + 点菜（SPEC §4 / §6 + SPEC-v1.0.8）
 * 数据只经 utils/api.js（SPEC §1），本页不碰 wx.cloud.*
 *
 * 点菜流程（顺序固定）：
 *   读 templateId / orderConfirmTemplateId（防御式，取不到当空串）
 *   -> 两者非空的收进 tmplIds，一次 requestSubscribeMessage（accept / reject / 报错 都继续下单）
 *   -> 昵称（本地缓存 nickname，没有就问一次，取消用「匿名朋友」）
 *   -> 备注（可空，取消传空串）
 *   -> api.orderCreate(dishId, note, { nickname, avatar })
 *   -> 成功：按钮短暂「已点」+ 按 notifyState 提示；notifyState 任何值都不算失败
 *
 * v1.0.8 新增（只新增，不动上面的下单链路）：
 *   材料 / 调料 / 做法 / 想说的话四块展示；提供者 + 参与者（历史浮层）；
 *   喜欢 / 想吃（头像列表 + 点头像看昵称）；点菜前置菜单校验；改菜浮层。
 */

var api = require('../../utils/api.js');
var format = require('../../utils/format.js');

var ANONYMOUS_NICKNAME = '匿名朋友';
var ORDERED_HOLD_MS = 2000;
var TAG_TONES = ['accent', 'sage', 'mustard'];

var PROVIDER_FALLBACK = '一位朋友';
var PERSON_FALLBACK = '朋友';
var AVATAR_PREVIEW_MAX = 8;
var CONTRIBUTOR_AVATAR_MAX = 3;
var TIP_HOLD_MS = 2000;

// SPEC-v1.0.8 §1.1 烹饪方式白名单（后端校验，白名单外的值会被丢弃）
var METHOD_WHITELIST = [
  '炒', '爆', '熘', '煸', '炝', '干煸', '炸', '煎', '烙', '烤', '炭烤', '熏', '焗', '蒸', '清蒸', '粉蒸',
  '煮', '炖', '焖', '煨', '烧', '红烧', '烩', '汆', '涮', '熬', '焯', '拌', '凉拌', '腌', '卤', '酱', '醉', '糟',
  '白灼', '糖醋', '拔丝', '干锅', '砂锅', '铁板', '水煮'
];

var EDIT_ITEM_MAX = 20;
var EDIT_ITEM_LEN_MAX = 20;
var NAME_MAX = 30;
var STORY_MAX = 200;
var HISTORY_PAGE_SIZE = 20;

var EDIT_STATUS_TEXT = { pending: '待审核', approved: '已通过', rejected: '未通过' };

var NO_MENU_LABEL = '还没可以点菜哦~';

// 创建者删除必填理由（SPEC-v1.0.8 §5.1 deleteReason）≤100 字
var DELETE_REASON_MAX = 100;
// 删除成功到返回上一页之间的停留：让 toast 看得见
var LEAVE_DELAY_MS = 700;

/* ---------- 纯函数小工具（不依赖 wx） ---------- */

function toast(title) {
  wx.showToast({ title: title, icon: 'none', duration: 2000 });
}

function readStorage(key) {
  try {
    var value = wx.getStorageSync(key);
    return typeof value === 'string' ? value : '';
  } catch (err) {
    return '';
  }
}

function myOpenid() {
  try {
    var app = getApp();
    return (app && app.globalData && app.globalData.openid) || '';
  } catch (err) {
    return '';
  }
}

// 主人家判定：优先用 app.isOwner()，取不到再退回 globalData.role
function isAppOwner() {
  try {
    var app = getApp();
    if (!app) {
      return false;
    }
    if (typeof app.isOwner === 'function') {
      return !!app.isOwner();
    }
    return !!(app.globalData && app.globalData.role === 'owner');
  } catch (err) {
    return false;
  }
}

// 人像数组防读：字段类型兜底 + 生成渲染用的 key / initial（昵称必须有值，SPEC-v1.0.8 §3.7）
function buildPeople(value) {
  var out = [];
  if (!Array.isArray(value)) {
    return out;
  }
  for (var i = 0; i < value.length; i += 1) {
    var row = value[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      continue;
    }
    var openid = typeof row.openid === 'string' ? row.openid : '';
    var nickname = typeof row.nickname === 'string' && row.nickname ? row.nickname : PERSON_FALLBACK;
    out.push({
      key: openid || 'p-' + i,
      openid: openid,
      nickname: nickname,
      avatar: typeof row.avatar === 'string' ? row.avatar : '',
      initial: nickname.slice(0, 1),
      broken: false
    });
  }
  return out;
}

function hasMine(list) {
  var openid = myOpenid();
  if (!openid) {
    return false;
  }
  for (var i = 0; i < list.length; i += 1) {
    if (list[i].openid === openid) {
      return true;
    }
  }
  return false;
}

// 文本数组防读：丢掉非字符串项、超长截断，不做去重以外的改写
function cleanTextArray(value) {
  var out = [];
  if (!Array.isArray(value)) {
    return out;
  }
  for (var i = 0; i < value.length; i += 1) {
    var item = value[i];
    if (typeof item !== 'string') {
      continue;
    }
    var text = item.trim();
    if (!text) {
      continue;
    }
    out.push(text.length > EDIT_ITEM_LEN_MAX ? text.slice(0, EDIT_ITEM_LEN_MAX) : text);
    if (out.length >= EDIT_ITEM_MAX) {
      break;
    }
  }
  return out;
}

function joinMethods(value) {
  if (!Array.isArray(value)) {
    return '';
  }
  var parts = [];
  for (var i = 0; i < value.length; i += 1) {
    if (typeof value[i] === 'string' && value[i]) {
      parts.push(value[i]);
    }
  }
  return parts.join(' + ');
}

function buildMethodOptions(selected) {
  var chosen = Array.isArray(selected) ? selected : [];
  var options = [];
  for (var i = 0; i < METHOD_WHITELIST.length; i += 1) {
    var name = METHOD_WHITELIST[i];
    options.push({ name: name, active: chosen.indexOf(name) >= 0 });
  }
  return options;
}

function collectMethods(options) {
  var picked = [];
  if (!Array.isArray(options)) {
    return picked;
  }
  for (var i = 0; i < options.length; i += 1) {
    if (options[i] && options[i].active) {
      picked.push(options[i].name);
    }
  }
  return picked;
}

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
    ordered: false,

    /* ---------- v1.0.8 展示字段 ---------- */
    ingredients: [],
    seasonings: [],
    methodsText: '',
    storyText: '',
    submitterName: '',
    submitterAvatar: '',
    submitterInitial: '',
    submitterBroken: false,
    contributorStack: [],
    contributorMore: 0,
    contributorCount: 0,

    /* ---------- 喜欢 / 想吃 ---------- */
    likes: [],
    likePreview: [],
    likeExtra: 0,
    likeCount: 0,
    likeCountText: '0',
    liked: false,
    likeBusy: false,
    likeTip: '',
    wants: [],
    wantPreview: [],
    wantExtra: 0,
    wantCount: 0,
    wantCountText: '0',
    wanted: false,
    wantBusy: false,
    wantTip: '',

    /* ---------- 点菜前置 ---------- */
    menuReady: false,
    menuTitle: '',
    noMenuLabel: NO_MENU_LABEL,

    /* ---------- 参与者历史浮层 ---------- */
    historyOpen: false,
    historyLoading: false,
    historyList: [],

    /* ---------- 谁点过这道菜（SPEC-v1.0.8 §4.3） ---------- */
    orderersVisible: false,
    orderersDishId: '',
    orderersDishName: '',

    /* ---------- 改菜浮层 ---------- */
    editOpen: false,
    editLoading: false,
    editSubmitting: false,
    editName: '',
    editNameLen: 0,
    editStory: '',
    editStoryLen: 0,
    editIngredients: [],
    editSeasonings: [],
    editIngredientInput: '',
    editSeasoningInput: '',
    editMethods: [],
    methodsMax: METHOD_WHITELIST.length,
    itemMax: EDIT_ITEM_MAX,
    itemLenMax: EDIT_ITEM_LEN_MAX,
    nameMax: NAME_MAX,
    storyMax: STORY_MAX,

    /* ---------- 上下架 / 删除（SPEC-v1.0.8 §5） ---------- */
    // listed 为 false 表示已下架；按钮文案与可见性都按它算
    listed: true,
    listedText: '下架',
    listedBusy: false,
    // 下架 / 重新上架：创建者或主人家可见（§5.2）
    canManageListed: false,
    // 删除：创建者或主人家可见；主人家直接删，创建者必须填理由进审核队列
    canDelete: false,
    ownerDelete: false,
    deleteOpen: false,
    deleteReason: '',
    deleteReasonLen: 0,
    deleteReasonMax: DELETE_REASON_MAX,
    deleting: false
  },

  /* ---------- 生命周期 ---------- */

  onLoad: function (options) {
    this.orderedTimer = null;
    this.likeTipTimer = null;
    this.wantTipTimer = null;
    this.backTimer = null;
    this.shownOnce = false;
    var id = (options && options.id) || '';
    this.setData({ id: id });
    if (!id) {
      this.setData({ loading: false, notFound: true });
      return;
    }
    this.fetchDish(id);
  },

  // 菜单状态与点赞 / 想吃状态都在回到本页时刷新（SPEC 要求）
  onShow: function () {
    this.refreshMenu();
    // 首次 onShow 紧接着 onLoad，菜品自己正在加载，不必再取一遍
    if (this.shownOnce && this.data.id && this.data.dish) {
      this.fetchDish(this.data.id, true);
    }
    this.shownOnce = true;
  },

  onUnload: function () {
    if (this.orderedTimer) {
      clearTimeout(this.orderedTimer);
      this.orderedTimer = null;
    }
    if (this.likeTipTimer) {
      clearTimeout(this.likeTipTimer);
      this.likeTipTimer = null;
    }
    if (this.wantTipTimer) {
      clearTimeout(this.wantTipTimer);
      this.wantTipTimer = null;
    }
    if (this.backTimer) {
      clearTimeout(this.backTimer);
      this.backTimer = null;
    }
  },

  /* ---------- 菜品详情 ---------- */

  fetchDish: function (id, silent) {
    var self = this;
    if (!silent) {
      this.setData({ loading: true });
    }
    return api.dishGet(id).then(function (dish) {
      self.renderDish(dish || {});
    }, function (err) {
      // api.js 已经弹过 toast，这里只记日志
      console.error('[detail] 菜品加载失败', err);
      if (!silent) {
        self.setData({ loading: false, notFound: true });
      }
    });
  },

  renderDish: function (dish) {
    var tags = Array.isArray(dish.tags) ? dish.tags : [];
    var tagList = [];
    for (var i = 0; i < tags.length; i++) {
      tagList.push({ text: tags[i], tone: TAG_TONES[i % TAG_TONES.length] });
    }

    var likes = buildPeople(dish.likes);
    var wants = buildPeople(dish.wants);
    var contributors = buildPeople(dish.contributors);
    var stack = contributors.slice(0, CONTRIBUTOR_AVATAR_MAX);

    var submitter = dish.submitter && typeof dish.submitter === 'object' ? dish.submitter : {};
    var submitterName =
      typeof submitter.nickname === 'string' && submitter.nickname ? submitter.nickname : PROVIDER_FALLBACK;
    var submitterAvatar = typeof submitter.avatar === 'string' ? submitter.avatar : '';

    var likeCount = typeof dish.likeCount === 'number' ? dish.likeCount : likes.length;
    var likePreview = likes.slice(0, AVATAR_PREVIEW_MAX);
    var wantPreview = wants.slice(0, AVATAR_PREVIEW_MAX);

    // 操作权限（SPEC-v1.0.8 §5.2）：创建者 = dish.ownerOpenid，主人家 = app.isOwner()
    var openid = myOpenid();
    var creatorOpenid =
      typeof dish.ownerOpenid === 'string' && dish.ownerOpenid
        ? dish.ownerOpenid
        : (typeof submitter.openid === 'string' ? submitter.openid : '');
    var isOwner = isAppOwner();
    var isCreator = !!creatorOpenid && !!openid && creatorOpenid === openid;
    var listed = dish.listed !== false;

    this.setData({
      dish: dish,
      tagList: tagList,
      createdText: dish.createdAt ? format.formatDate(dish.createdAt) : '',
      cookedText: format.formatCount(dish.cookedCount || 0),

      ingredients: cleanTextArray(dish.ingredients),
      seasonings: cleanTextArray(dish.seasonings),
      methodsText: joinMethods(dish.methods),
      storyText: typeof dish.story === 'string' ? dish.story : '',

      submitterName: submitterName,
      submitterAvatar: submitterAvatar,
      submitterInitial: submitterName.slice(0, 1),
      submitterBroken: false,
      contributorStack: stack,
      contributorMore: Math.max(0, contributors.length - stack.length),
      contributorCount: contributors.length,

      likes: likes,
      likePreview: likePreview,
      likeExtra: Math.max(0, likes.length - likePreview.length),
      likeCount: likeCount,
      likeCountText: format.formatCount(likeCount),
      liked: hasMine(likes),
      likeBusy: false,
      likeTip: '',

      wants: wants,
      wantPreview: wantPreview,
      wantExtra: Math.max(0, wants.length - wantPreview.length),
      wantCount: wants.length,
      wantCountText: format.formatCount(wants.length),
      wanted: hasMine(wants),
      wantBusy: false,
      wantTip: '',

      loading: false,
      notFound: false,

      listed: listed,
      listedText: listed ? '下架' : '重新上架',
      listedBusy: false,
      canManageListed: isOwner || isCreator,
      canDelete: isOwner || isCreator,
      // 主人家删除走直接删除；只有「创建者但非主人家」才需要填理由
      ownerDelete: isOwner
    });
    wx.setNavigationBarTitle({ title: dish.name || '菜品详情' });
  },

  /* ---------- 菜单状态（点菜前置，SPEC-v1.0.8 §3.4） ---------- */

  refreshMenu: function () {
    var self = this;
    return api.menuCurrent().then(function (menu) {
      // menu.current 只返回 open 的菜单；出参再带 expired 布尔
      var ready = !!(menu && menu.expired !== true && menu.status !== 'closed');
      self.setData({
        menuReady: ready,
        menuTitle: ready && typeof menu.title === 'string' ? menu.title : ''
      });
    }, function (err) {
      // 读不到菜单就当没有：宁可让按钮置灰，也不要让用户点了再被服务端拒绝
      console.error('[detail] 菜单状态读取失败', err);
      self.setData({ menuReady: false, menuTitle: '' });
    });
  },

  /* ---------- 喜欢 / 想吃 ---------- */

  onLikeTap: function () {
    var self = this;
    if (this.data.likeBusy || !this.data.dish || !this.data.dish._id) {
      return;
    }
    var id = this.data.dish._id;
    this.setData({ likeBusy: true, likeTip: '' });
    var task = this.data.liked ? api.dishUnlike(id) : api.dishLike(id);
    task.then(function (result) {
      self.applyLikes(result || {});
      self.setData({ likeBusy: false });
    }, function (err) {
      // api.js 已 toast
      console.error('[detail] 喜欢切换失败', err);
      self.setData({ likeBusy: false });
    });
  },

  applyLikes: function (result) {
    var likes = buildPeople(result.likes);
    var count = typeof result.likeCount === 'number' ? result.likeCount : likes.length;
    var preview = likes.slice(0, AVATAR_PREVIEW_MAX);
    this.setData({
      likes: likes,
      likePreview: preview,
      likeExtra: Math.max(0, likes.length - preview.length),
      likeCount: count,
      likeCountText: format.formatCount(count),
      liked: result.liked === true || hasMine(likes)
    });
  },

  onWantTap: function () {
    var self = this;
    if (this.data.wantBusy || !this.data.dish || !this.data.dish._id) {
      return;
    }
    var id = this.data.dish._id;
    this.setData({ wantBusy: true, wantTip: '' });
    var task = this.data.wanted ? api.dishUnwant(id) : api.dishWant(id);
    task.then(function (result) {
      self.applyWants(result || {});
      self.setData({ wantBusy: false });
    }, function (err) {
      console.error('[detail] 想吃切换失败', err);
      self.setData({ wantBusy: false });
    });
  },

  applyWants: function (result) {
    var wants = buildPeople(result.wants);
    var preview = wants.slice(0, AVATAR_PREVIEW_MAX);
    this.setData({
      wants: wants,
      wantPreview: preview,
      wantExtra: Math.max(0, wants.length - preview.length),
      wantCount: wants.length,
      wantCountText: format.formatCount(wants.length),
      wanted: hasMine(wants)
    });
  },

  // 点头像看昵称：头像即身份（SPEC-v1.0.8 §3.7），昵称只在点击后淡入 2 秒
  onAvatarTap: function (event) {
    var dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    var listName = dataset.list === 'wants' ? 'wants' : 'likes';
    var index = Number(dataset.index);
    var list = this.data[listName] || [];
    var person = list[index];
    if (!person) {
      return;
    }
    var isWant = listName === 'wants';
    var tipKey = isWant ? 'wantTip' : 'likeTip';
    var timerKey = isWant ? 'wantTipTimer' : 'likeTipTimer';
    var patch = {};
    patch[tipKey] = person.nickname + (isWant ? ' 想吃这道菜' : ' 喜欢了这道菜');
    this.setData(patch);
    var self = this;
    if (this[timerKey]) {
      clearTimeout(this[timerKey]);
    }
    this[timerKey] = setTimeout(function () {
      self[timerKey] = null;
      var clear = {};
      clear[tipKey] = '';
      self.setData(clear);
    }, TIP_HOLD_MS);
  },

  // 头像加载失败 -> 换成纯 CSS 圆形占位（不裂图）
  onAvatarError: function (event) {
    var dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    var listName = dataset.list === 'wants' ? 'wants' : 'likes';
    var index = Number(dataset.index);
    var list = (this.data[listName] || []).slice();
    if (!list[index]) {
      return;
    }
    list[index].broken = true;
    var patch = {};
    patch[listName] = list;
    this.setData(patch);
  },

  onSubmitterAvatarError: function () {
    this.setData({ submitterBroken: true });
  },

  onContributorAvatarError: function (event) {
    var dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    var index = Number(dataset.index);
    var list = (this.data.contributorStack || []).slice();
    if (!list[index]) {
      return;
    }
    list[index].broken = true;
    this.setData({ contributorStack: list });
  },

  /* ---------- 参与者历史浮层 ---------- */

  onOpenHistory: function () {
    this.setData({ historyOpen: true, historyLoading: true, historyList: [] });
    this.fetchHistory();
  },

  onCloseHistory: function () {
    this.setData({ historyOpen: false });
  },

  fetchHistory: function () {
    var self = this;
    var dishId = this.data.id;
    if (!dishId) {
      this.setData({ historyLoading: false });
      return;
    }
    api.dishEditHistory(dishId, { page: 1, pageSize: HISTORY_PAGE_SIZE }).then(function (result) {
      var rows = (result && Array.isArray(result.list)) ? result.list : [];
      var list = [];
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i] || {};
        var snapshot = row.snapshot && typeof row.snapshot === 'object' ? row.snapshot : {};
        var proposer = row.submitter && typeof row.submitter === 'object' ? row.submitter : {};
        var nickname =
          typeof proposer.nickname === 'string' && proposer.nickname ? proposer.nickname : PERSON_FALLBACK;
        var avatar = typeof proposer.avatar === 'string' ? proposer.avatar : '';
        var status = typeof row.status === 'string' ? row.status : '';
        list.push({
          key: (typeof row._id === 'string' && row._id) || 'e-' + i,
          nickname: nickname,
          initial: nickname.slice(0, 1),
          avatar: avatar,
          broken: false,
          timeText: row.createdAt ? format.formatTime(row.createdAt) : '',
          status: EDIT_STATUS_TEXT[status] ? status : 'pending',
          statusText: EDIT_STATUS_TEXT[status] || '已提交',
          name: typeof snapshot.name === 'string' && snapshot.name ? snapshot.name : '未填写',
          methodText: joinMethods(snapshot.methods) || '未填写'
        });
      }
      self.setData({ historyList: list, historyLoading: false });
    }, function (err) {
      // api.js 已 toast
      console.error('[detail] 修改历史读取失败', err);
      self.setData({ historyLoading: false });
    });
  },

  onHistoryAvatarError: function (event) {
    var dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    var index = Number(dataset.index);
    var list = (this.data.historyList || []).slice();
    if (!list[index]) {
      return;
    }
    list[index].broken = true;
    this.setData({ historyList: list });
  },

  /* ---------- 谁点过这道菜（SPEC-v1.0.8 §4.3） ---------- */

  // 点「被点次数」指标：页面只传 id / 菜名，数据由 orderers-sheet 自己拉
  onOrderersTap: function () {
    var dish = this.data.dish || {};
    var id = dish._id || this.data.id || '';
    if (!id) {
      return;
    }
    this.setData({
      orderersVisible: true,
      orderersDishId: id,
      orderersDishName: typeof dish.name === 'string' ? dish.name : ''
    });
  },

  onOrderersClose: function () {
    this.setData({ orderersVisible: false });
  },

  /* ---------- 改菜浮层 ---------- */

  onOpenEdit: function () {
    var self = this;
    var dish = this.data.dish;
    if (!dish || !dish._id) {
      return;
    }
    // 打开时先取一次最新菜品，避免拿过期数据去覆盖（dish.edit 按整份字段覆盖）
    this.setData({ editOpen: true, editLoading: true });
    api.dishGet(dish._id).then(function (current) {
      self.fillEditForm(current || {});
    }, function (err) {
      console.error('[detail] 打开改菜浮层失败', err);
      self.setData({ editOpen: false, editLoading: false });
    });
  },

  fillEditForm: function (current) {
    var methods = buildMethodOptions(current.methods);
    var name = typeof current.name === 'string' ? current.name : '';
    var story = typeof current.story === 'string' ? current.story : '';
    this.setData({
      editOpen: true,
      editLoading: false,
      editSubmitting: false,
      editName: name,
      editNameLen: name.length,
      editStory: story,
      editStoryLen: story.length,
      editIngredients: cleanTextArray(current.ingredients),
      editSeasonings: cleanTextArray(current.seasonings),
      editIngredientInput: '',
      editSeasoningInput: '',
      editMethods: methods
    });
  },

  onCloseEdit: function () {
    if (this.data.editSubmitting) {
      return;
    }
    this.setData({ editOpen: false });
  },

  noop: function () {},

  onEditNameInput: function (event) {
    var value = (event.detail && event.detail.value) || '';
    this.setData({ editName: value, editNameLen: value.length });
  },

  onEditStoryInput: function (event) {
    var value = (event.detail && event.detail.value) || '';
    this.setData({ editStory: value, editStoryLen: value.length });
  },

  onEditIngredientInput: function (event) {
    this.setData({ editIngredientInput: (event.detail && event.detail.value) || '' });
  },

  onEditSeasoningInput: function (event) {
    this.setData({ editSeasoningInput: (event.detail && event.detail.value) || '' });
  },

  onAddEditIngredient: function () {
    this.addEditItem('editIngredients', 'editIngredientInput');
  },

  onAddEditSeasoning: function () {
    this.addEditItem('editSeasonings', 'editSeasoningInput');
  },

  addEditItem: function (listKey, inputKey) {
    var patch = {};
    var value = String(this.data[inputKey] || '').trim();
    if (!value) {
      return;
    }
    if (value.length > EDIT_ITEM_LEN_MAX) {
      toast('每项最多 20 个字');
      return;
    }
    var list = (this.data[listKey] || []).slice();
    if (list.length >= EDIT_ITEM_MAX) {
      toast('最多 20 项');
      return;
    }
    if (list.indexOf(value) >= 0) {
      patch[inputKey] = '';
      this.setData(patch);
      return;
    }
    list.push(value);
    patch[listKey] = list;
    patch[inputKey] = '';
    this.setData(patch);
  },

  onRemoveEditIngredient: function (event) {
    this.removeEditItem('editIngredients', event);
  },

  onRemoveEditSeasoning: function (event) {
    this.removeEditItem('editSeasonings', event);
  },

  removeEditItem: function (listKey, event) {
    var dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    var index = Number(dataset.index);
    var list = (this.data[listKey] || []).slice();
    if (!(index >= 0) || index >= list.length) {
      return;
    }
    list.splice(index, 1);
    var patch = {};
    patch[listKey] = list;
    this.setData(patch);
  },

  onToggleEditMethod: function (event) {
    var dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
    var index = Number(dataset.index);
    var list = (this.data.editMethods || []).slice();
    if (!(index >= 0) || index >= list.length) {
      return;
    }
    list[index] = { name: list[index].name, active: !list[index].active };
    this.setData({ editMethods: list });
  },

  onSubmitEdit: function () {
    var self = this;
    if (this.data.editSubmitting || this.data.editLoading) {
      return;
    }
    var name = String(this.data.editName || '').trim();
    if (!name) {
      toast('先给这道菜起个名字');
      return;
    }
    if (name.length > NAME_MAX) {
      toast('菜名最多 30 个字');
      return;
    }
    var story = String(this.data.editStory || '').trim();
    if (story.length > STORY_MAX) {
      toast('想说的话最多 200 个字');
      return;
    }

    this.setData({ editSubmitting: true });

    // dish.edit 按整份可编辑字段覆盖（payload 里没出现的字段会被当成空值），
    // 所以提交前先 dishGet 拿到当前值，把封面 / 图集 / 标签这些本页不改的字段原样带上。
    api.dishGet(this.data.id).then(function (current) {
      var source = current || {};
      var payload = {
        id: self.data.id,
        name: name,
        story: story,
        ingredients: self.data.editIngredients.slice(),
        seasonings: self.data.editSeasonings.slice(),
        methods: collectMethods(self.data.editMethods),
        tags: Array.isArray(source.tags) ? source.tags : [],
        cover: typeof source.cover === 'string' ? source.cover : '',
        images: Array.isArray(source.images) ? source.images : []
      };
      // 访客提案走 submitter 快照：带上本地昵称与头像，主人家审核时才认得出是谁
      var nickname = readStorage('nickname');
      var avatar = readStorage('avatar');
      if (nickname) {
        payload.nickname = nickname;
      }
      payload.avatar = avatar;
      return api.dishEdit(payload);
    }).then(function (result) {
      var status = (result && result.status) || '';
      self.setData({ editSubmitting: false, editOpen: false });
      if (status === 'approved') {
        wx.showToast({ title: '已更新', icon: 'success', duration: 1600 });
        // 主人家的修改直接生效：菜名/材料/做法都变了，菜谱卡片还是旧的，必须让上一页重拉
        self.markListStale();
        self.fetchDish(self.data.id);
        if (self.data.historyOpen) {
          self.fetchHistory();
        }
      } else {
        toast('修改已提交，等主人家审核');
      }
    }, function (err) {
      // api.js 已 toast
      console.error('[detail] 修改提交失败', err);
      self.setData({ editSubmitting: false });
    });
  },

  /* ---------- 上下架 / 删除（SPEC-v1.0.8 §5） ---------- */

  // 下架 / 删除会改到菜谱页的列表内容，但菜谱页「从详情页返回不刷新」是刻意设计
  // （onHide 时 skipNextRefresh 已把 needRefresh 压成 false），所以这里显式把上一页标记为需要刷新
  markListStale: function () {
    try {
      var pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
      if (!Array.isArray(pages) || pages.length < 2) {
        return;
      }
      var prev = pages[pages.length - 2];
      if (prev && typeof prev.route === 'string' && prev.route.indexOf('pages/index/index') >= 0) {
        prev.needRefresh = true;
      }
    } catch (err) {
      console.warn('[detail] 标记菜谱列表需要刷新失败', err);
    }
  },

  // 下架 / 重新上架：创建者或主人家直接生效，不走审核（§5.2）
  onToggleListed: function () {
    var self = this;
    var dish = this.data.dish;
    if (!dish || !dish._id || this.data.listedBusy) {
      return;
    }
    // 已下架 -> 重新上架（listed:true）；已上架 -> 下架（listed:false）
    var next = this.data.listed === false;
    var task;
    this.setData({ listedBusy: true });
    try {
      task = api.dishSetListed(dish._id, next);
    } catch (err) {
      console.error('[detail] 上下架调用异常', err);
      this.setData({ listedBusy: false });
      return;
    }
    task.then(function () {
      self.setData({
        listedBusy: false,
        listed: next,
        listedText: next ? '下架' : '重新上架'
      });
      toast(next ? '已重新上架' : '已下架');
      // 上架状态变了，回到菜谱页时那两列要重拉
      self.markListStale();
      // 再取一次，让页面状态与服务端一致（下架的菜详情仍然可看）
      self.fetchDish(self.data.id, true);
    }, function (err) {
      // api.js 已 toast；这里只恢复按钮，不假装成功
      console.error('[detail] 上下架失败', err);
      self.setData({ listedBusy: false });
    });
  },

  // 删除入口：主人家 -> 二次确认后直接删；创建者 -> 页内浮层填理由；其他人看不到这个按钮
  onDeleteTap: function () {
    var dish = this.data.dish;
    if (!dish || !dish._id || this.data.deleting) {
      return;
    }
    if (this.data.ownerDelete) {
      this.confirmOwnerDelete();
      return;
    }
    this.setData({
      deleteOpen: true,
      deleting: false,
      deleteReason: '',
      deleteReasonLen: 0
    });
  },

  // 主人家删除：二次确认，理由可空
  confirmOwnerDelete: function () {
    var self = this;
    if (this.data.deleting) {
      return;
    }
    wx.showModal({
      title: '删除这道菜',
      content: '删除后会在回收站保留 30 天，可以恢复',
      confirmText: '删除',
      cancelText: '再想想',
      success: function (res) {
        if (res && res.confirm) {
          self.doDelete('');
        }
      },
      fail: function (err) {
        console.warn('[detail] 删除确认弹窗异常', err);
      }
    });
  },

  // 主人家（reason 空）与创建者（reason 必填）共用；按 dish.remove 的出参决定提示
  doDelete: function (reason) {
    var self = this;
    var dish = this.data.dish;
    if (!dish || !dish._id || this.data.deleting) {
      return;
    }
    var task;
    this.setData({ deleting: true });
    try {
      task = api.dishRemove(dish._id, reason || '');
    } catch (err) {
      console.error('[detail] 删除调用异常', err);
      this.setData({ deleting: false });
      return;
    }
    task.then(function (result) {
      var data = result || {};
      self.setData({ deleting: false, deleteOpen: false });
      // 菜品已不可见，菜谱页那两列必须重拉，否则返回后还能看到这道菜
      self.markListStale();
      // 创建者删除只是写了一条 type='delete' 的提案，还没进回收站
      if (data.status === 'pending') {
        self.leaveAfterDelete('删除申请已提交，等主人家审核');
        return;
      }
      self.leaveAfterDelete('已移入回收站');
    }, function (err) {
      // api.js 已 toast
      console.error('[detail] 删除失败', err);
      self.setData({ deleting: false });
    });
  },

  // 提示后回上一页：toast 要留一点时间，不能被立刻跳转吞掉
  leaveAfterDelete: function (message) {
    var self = this;
    toast(message);
    if (this.backTimer) {
      clearTimeout(this.backTimer);
    }
    this.backTimer = setTimeout(function () {
      self.backTimer = null;
      wx.navigateBack({
        delta: 1,
        fail: function (err) {
          console.error('[detail] 返回上一页失败', err);
          wx.switchTab({
            url: '/pages/index/index',
            fail: function (err2) {
              console.error('[detail] 回到菜谱页失败', err2);
            }
          });
        }
      });
    }, LEAVE_DELAY_MS);
  },

  onDeleteReasonInput: function (event) {
    var value = (event && event.detail ? event.detail.value : '') || '';
    this.setData({ deleteReason: value, deleteReasonLen: value.length });
  },

  onCloseDelete: function () {
    if (this.data.deleting) {
      return;
    }
    this.setData({ deleteOpen: false });
  },

  onSubmitDelete: function () {
    if (this.data.deleting) {
      return;
    }
    var reason = String(this.data.deleteReason || '').trim();
    if (!reason) {
      toast('写一句删除理由');
      return;
    }
    if (reason.length > DELETE_REASON_MAX) {
      toast('理由最多 100 个字');
      return;
    }
    this.doDelete(reason);
  },

  /* ---------- 点菜流程 ---------- */

  onOrderTap: function () {
    var self = this;
    var dish = this.data.dish;
    // 已下架的菜不能点（v1.0.8 §5.1）：后端 order.create 也会拒，这里先给出人话提示
    if (this.data.listed === false) {
      toast('这道菜已经下架了');
      return;
    }
    // 没有进行中的点菜单：按钮已置灰，这里只提示，绝不进入下单链路
    if (!this.data.menuReady) {
      toast(this.data.noMenuLabel);
      return;
    }
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
    var avatar = '';
    try {
      var stored = wx.getStorageSync('avatar');
      avatar = typeof stored === 'string' ? stored : '';
    } catch (err) {
      console.warn('[detail] 读取头像失败', err);
    }
    return api.orderCreate(dishId, note || '', { nickname: nickname, avatar: avatar });
  },

  handleOrderSuccess: function (result) {
    var payload = result || {};
    var notifyState = payload.notifyState || '';
    // 【v1.0.8 §4.1】点菜不再让「被点次数」+1：那个数字现在是「主人家确认已做」的次数。
    // 这里只恢复按钮状态，绝不乐观加一，否则页面会永远比云端多 1。
    this.setData({ ordering: false });
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
