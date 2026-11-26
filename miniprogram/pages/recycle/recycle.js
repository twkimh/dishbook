/**
 * 回收站（SPEC-v1.0.8 §5：软删除 / 上下架 / 回收站）
 * 仅主人家可用：查看 / 恢复 / 永久删除 / 清空。守卫不过直接退回。
 *
 * recycle.list 一次就把菜品和点菜单两套完整列表都返回了（不分页），
 * 所以「触底加载」只做前端分批渲染：全量留在实例字段里，
 * data.list 只放已渲染的那一段，避免整份列表反复走 setData。
 */

var api = require('../../utils/api.js');
var format = require('../../utils/format.js');

var CHUNK = 10;
var TYPE_DISH = 'dish';
var TYPE_MENU = 'menu';

function toast(title) {
  wx.showToast({ title: title, icon: 'none', duration: 2000 });
}

/**
 * 直接通过 url 打开本页时页面栈可能只有一层，navigateBack 会失败，
 * 这时退回首页，别把非主人家留在空白页上。
 */
function leaveAsGuest() {
  toast('只有主人家能看回收站');
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

// 「还剩 N 天」：daysLeft 由后端算好（30 天倒计时）
function daysText(value) {
  var days = Number(value);
  if (!isFinite(days) || days < 0) {
    return '即将清理';
  }
  return '还剩 ' + Math.floor(days) + ' 天';
}

function countText(count) {
  return format.formatCount(count);
}

function decorateDish(raw) {
  var item = raw || {};
  var reason = typeof item.deleteReason === 'string' ? item.deleteReason : '';
  return {
    id: item._id || item.id || '',
    name: item.name || '未命名菜品',
    cover: item.cover || '',
    reason: reason,
    // 删除前是「已下架」的，恢复后也仍然下架，所以给个徽标说明
    delisted: item.deletedFrom === 'delisted',
    timeText: format.formatTime(item.deletedAt),
    daysText: daysText(item.daysLeft),
    selected: false
  };
}

function decorateMenu(raw) {
  var item = raw || {};
  var bits = [];
  if (item.dateText) {
    bits.push(String(item.dateText));
  }
  if (item.mealType) {
    bits.push(String(item.mealType));
  }
  var headcount = Number(item.headcount);
  bits.push(headcount > 0 ? Math.floor(headcount) + ' 人' : '人数未填');
  var dishCount = Number(item.dishCount);
  return {
    id: item._id || item.id || '',
    title: item.title || '未命名点菜单',
    metaText: bits.join(' · '),
    dishText: (dishCount > 0 ? Math.floor(dishCount) : 0) + ' 道菜',
    timeText: format.formatTime(item.deletedAt),
    daysText: daysText(item.daysLeft),
    selected: false
  };
}

Page({
  data: {
    isOwner: false,
    type: TYPE_DISH,
    dishCount: 0,
    menuCount: 0,
    dishCountText: '0',
    menuCountText: '0',
    // 当前分类已渲染的那一段
    list: [],
    total: 0,
    visible: 0,
    selectedCount: 0,
    selectAll: false,
    loading: false,
    skeleton: true
  },

  onLoad: function () {
    var self = this;
    // 全量列表与选中集合放在实例上，不进 data
    this.dishes = [];
    this.menus = [];
    this.selMap = {};
    resolveRole().then(function (owner) {
      self.setData({ isOwner: owner });
      if (!owner) {
        leaveAsGuest();
        return;
      }
      self.ready = true;
      self.fetchList();
    });
  },

  onShow: function () {
    // 冷启动那次由 onLoad 负责；从别处回到本页时重新拉一次
    if (!this.ready) {
      return;
    }
    this.fetchList();
  },

  onPullDownRefresh: function () {
    this.fetchList().then(
      function () {
        wx.stopPullDownRefresh();
      },
      function () {
        wx.stopPullDownRefresh();
      }
    );
  },

  // 触底加载：回收站一次拿全量，这里只把渲染窗口往后推 CHUNK 条
  onReachBottom: function () {
    if (this.data.loading || this.data.visible >= this.data.total) {
      return;
    }
    this.applyList(this.data.visible + CHUNK);
  },

  /* ---------------- 数据 ---------------- */

  fetchList: function () {
    var self = this;
    if (this.data.loading) {
      return Promise.resolve();
    }
    this.setData({ loading: true, skeleton: this.data.list.length === 0 });
    return api.recycleList().then(
      function onSuccess(res) {
        var payload = res || {};
        var rawDishes = payload.dishes || [];
        var rawMenus = payload.menus || [];
        var dishes = [];
        var menus = [];
        var i;
        for (i = 0; i < rawDishes.length; i++) {
          dishes.push(decorateDish(rawDishes[i]));
        }
        for (i = 0; i < rawMenus.length; i++) {
          menus.push(decorateMenu(rawMenus[i]));
        }
        self.dishes = dishes;
        self.menus = menus;
        self.pruneSelection();
        self.setData({ loading: false, skeleton: false });
        self.applyList(CHUNK);
      },
      function onFail(err) {
        // api.js 已经 toast 过，这里收尾即可
        console.error('[recycle] 回收站加载失败', err);
        self.setData({ loading: false, skeleton: false });
      }
    );
  },

  // 列表重新拉过之后，已经不在回收站里的 id 不能留在选中集合里，
  // 否则批量操作会拿旧 id 打到后端
  pruneSelection: function () {
    var type = this.data.type;
    var source = type === TYPE_MENU ? this.menus : this.dishes;
    var alive = {};
    var next = {};
    var i;
    for (i = 0; i < source.length; i++) {
      alive[source[i].id] = true;
    }
    for (var id in this.selMap) {
      if (!Object.prototype.hasOwnProperty.call(this.selMap, id)) {
        continue;
      }
      if (alive[id]) {
        next[id] = true;
      }
    }
    this.selMap = next;
  },

  /**
   * 取某个分类的全量列表；type 不传就用当前分类。
   * 切换分类时要显式传，别依赖 setData 之后 this.data 是否已更新。
   */
  sourceOf: function (type) {
    var mode = type === TYPE_MENU || type === TYPE_DISH ? type : this.data.type;
    return mode === TYPE_MENU ? this.menus : this.dishes;
  },

  currentSource: function () {
    return this.sourceOf();
  },

  countSelectedIn: function (source) {
    var count = 0;
    for (var i = 0; i < source.length; i++) {
      if (this.selMap[source[i].id] === true) {
        count++;
      }
    }
    return count;
  },

  countSelected: function () {
    return this.countSelectedIn(this.currentSource());
  },

  selectedIds: function () {
    var ids = [];
    for (var id in this.selMap) {
      if (Object.prototype.hasOwnProperty.call(this.selMap, id) && this.selMap[id] === true) {
        ids.push(id);
      }
    }
    return ids;
  },

  /**
   * 用全量数据重建 data.list（只渲染前 visible 条），
   * 顺带把顶部分类数量与选中数一起刷新。
   * @param {number} visible 想渲染多少条，会被总数截断
   * @param {string} [type] 目标分类，不传用当前分类
   */
  applyList: function (visible, type) {
    var source = this.sourceOf(type);
    var wanted = Math.floor(Number(visible) || 0);
    var limit = Math.min(Math.max(wanted, 0), source.length);
    var list = [];
    var i;
    for (i = 0; i < limit; i++) {
      var row = source[i];
      list.push({
        id: row.id,
        name: row.name,
        cover: row.cover,
        reason: row.reason,
        delisted: row.delisted,
        title: row.title,
        metaText: row.metaText,
        dishText: row.dishText,
        timeText: row.timeText,
        daysText: row.daysText,
        selected: this.selMap[row.id] === true
      });
    }
    var selectedCount = this.countSelectedIn(source);
    this.setData({
      list: list,
      total: source.length,
      visible: limit,
      selectedCount: selectedCount,
      selectAll: source.length > 0 && selectedCount === source.length,
      dishCount: this.dishes.length,
      menuCount: this.menus.length,
      dishCountText: countText(this.dishes.length),
      menuCountText: countText(this.menus.length)
    });
  },

  /* ---------------- 分类切换 / 多选 ---------------- */

  switchType: function (event) {
    var next = event.currentTarget.dataset.type;
    if (next !== TYPE_DISH && next !== TYPE_MENU) {
      return;
    }
    if (next === this.data.type) {
      return;
    }
    // 批量操作只作用于当前分类，换分类就把选中清掉，避免误删另一栏
    this.selMap = {};
    this.setData({ type: next });
    this.applyList(CHUNK, next);
  },

  toggleAt: function (index) {
    var row = this.data.list[index];
    if (!row || !row.id) {
      return;
    }
    if (this.selMap[row.id] === true) {
      delete this.selMap[row.id];
    } else {
      this.selMap[row.id] = true;
    }
    var selectedCount = this.countSelected();
    var patch = {
      selectedCount: selectedCount,
      selectAll: this.data.total > 0 && selectedCount === this.data.total
    };
    patch['list[' + index + '].selected'] = this.selMap[row.id] === true;
    this.setData(patch);
  },

  // 左侧圆框
  onToggle: function (event) {
    this.toggleAt(Number(event.currentTarget.dataset.index));
  },

  // 选中态下点卡片本体 = 切换勾选（回收站没有详情可进）
  onTapCard: function (event) {
    if (this.data.selectedCount <= 0) {
      return;
    }
    this.toggleAt(Number(event.currentTarget.dataset.index));
  },

  onToggleAll: function () {
    var source = this.currentSource();
    if (!source.length) {
      return;
    }
    var allPicked = this.data.selectedCount === source.length;
    var next = {};
    var i;
    if (!allPicked) {
      for (i = 0; i < source.length; i++) {
        next[source[i].id] = true;
      }
    }
    this.selMap = next;
    this.applyList(Math.max(this.data.visible, CHUNK));
  },

  /* ---------------- 就地更新 ---------------- */

  /**
   * 从本地列表移除一批 id（删除成功 / 恢复成功都走这里），
   * 不整页重刷：列表和顶部计数一起就地更新。
   */
  dropLocal: function (type, ids) {
    var gone = {};
    var i;
    for (i = 0; i < ids.length; i++) {
      gone[ids[i]] = true;
    }
    var source = type === TYPE_MENU ? this.menus : this.dishes;
    var kept = [];
    for (i = 0; i < source.length; i++) {
      if (gone[source[i].id] === true) {
        delete this.selMap[source[i].id];
      } else {
        kept.push(source[i]);
      }
    }
    if (type === TYPE_MENU) {
      this.menus = kept;
    } else {
      this.dishes = kept;
    }
    this.applyList(this.data.visible, type);
  },

  /* ---------------- 恢复（不做二次确认：不是破坏性操作） ---------------- */

  onRestoreOne: function (event) {
    var id = event.currentTarget.dataset.id;
    if (!id || this.data.loading) {
      return;
    }
    this.restore([id]);
  },

  onRestoreSelected: function () {
    if (this.data.loading) {
      return;
    }
    var ids = this.selectedIds();
    if (!ids.length) {
      return;
    }
    this.restore(ids);
  },

  restore: function (ids) {
    var self = this;
    var type = this.data.type;
    this.setData({ loading: true });
    return api.recycleRestore(type, ids).then(
      function onSuccess(res) {
        var restored = Number(res && res.restored) || 0;
        self.setData({ loading: false });
        self.dropLocal(type, ids);
        toast('已恢复 ' + restored + ' 项');
        return restored;
      },
      function onFail(err) {
        console.error('[recycle] 恢复失败', err);
        self.setData({ loading: false });
        return 0;
      }
    );
  },

  /* ---------------- 清除操作一：单项永久删除 ---------------- */

  onPurgeOne: function (event) {
    var id = event.currentTarget.dataset.id;
    if (!id || this.data.loading) {
      return;
    }
    var self = this;
    wx.showModal({
      title: '永久删除',
      content: '永久删除后无法恢复。确定要删掉这一项吗？',
      confirmText: '永久删除',
      success: function (res) {
        if (!res || !res.confirm) {
          return;
        }
        self.purge([id]);
      },
      fail: function (err) {
        console.error('[recycle] 永久删除确认框失败', err);
      }
    });
  },

  /* ---------------- 清除操作二：多选批量永久删除 ---------------- */

  onPurgeSelected: function () {
    if (this.data.loading) {
      return;
    }
    var ids = this.selectedIds();
    if (!ids.length) {
      return;
    }
    var self = this;
    var label = this.data.type === TYPE_MENU ? '点菜单' : '菜品';
    wx.showModal({
      title: '永久删除',
      content: '永久删除后无法恢复。确定要删掉选中的 ' + ids.length + ' 个' + label + '吗？',
      confirmText: '永久删除',
      success: function (res) {
        if (!res || !res.confirm) {
          return;
        }
        self.purge(ids);
      },
      fail: function (err) {
        console.error('[recycle] 批量删除确认框失败', err);
      }
    });
  },

  purge: function (ids) {
    var self = this;
    var type = this.data.type;
    this.setData({ loading: true });
    return api.recyclePurge(type, ids).then(
      function onSuccess(res) {
        var purged = Number(res && res.purged) || 0;
        self.setData({ loading: false });
        self.dropLocal(type, ids);
        toast('已永久删除 ' + purged + ' 项');
        return purged;
      },
      function onFail(err) {
        console.error('[recycle] 永久删除失败', err);
        self.setData({ loading: false });
        return 0;
      }
    );
  },

  /* ---------------- 清除操作三：清空本分类 ---------------- */

  onClearType: function () {
    var type = this.data.type;
    var label = type === TYPE_MENU ? '点菜单' : '菜品';
    var count = type === TYPE_MENU ? this.menus.length : this.dishes.length;
    if (this.data.loading) {
      return;
    }
    if (!count) {
      toast('这一栏已经是空的');
      return;
    }
    var self = this;
    wx.showModal({
      title: '清空' + label,
      content: '这一栏的 ' + count + ' 项会被永久删除，无法恢复。确定吗？',
      confirmText: '清空',
      success: function (res) {
        if (!res || !res.confirm) {
          return;
        }
        self.clear(type);
      },
      fail: function (err) {
        console.error('[recycle] 清空本分类确认框失败', err);
      }
    });
  },

  /* ---------------- 清除操作四：清空整个回收站 ---------------- */

  onClearAll: function () {
    var total = this.dishes.length + this.menus.length;
    if (this.data.loading) {
      return;
    }
    if (!total) {
      toast('回收站已经是空的');
      return;
    }
    var self = this;
    wx.showModal({
      title: '清空整个回收站',
      content: '菜品和点菜单都会被永久删除，共 ' + total + ' 项，无法恢复。确定吗？',
      confirmText: '全部清空',
      success: function (res) {
        if (!res || !res.confirm) {
          return;
        }
        // 不传 type = 清空全部
        self.clear('');
      },
      fail: function (err) {
        console.error('[recycle] 清空回收站确认框失败', err);
      }
    });
  },

  /**
   * @param {string} type 'dish' / 'menu' / ''（空 = 清空整个回收站）
   */
  clear: function (type) {
    var self = this;
    this.setData({ loading: true });
    return api.recycleClear(type).then(
      function onSuccess(res) {
        var purged = Number(res && res.purged) || 0;
        if (type === TYPE_MENU) {
          self.menus = [];
        } else if (type === TYPE_DISH) {
          self.dishes = [];
        } else {
          self.dishes = [];
          self.menus = [];
        }
        self.selMap = {};
        self.setData({ loading: false });
        self.applyList(CHUNK);
        toast('已清空 ' + purged + ' 项');
        return purged;
      },
      function onFail(err) {
        console.error('[recycle] 清空失败', err);
        self.setData({ loading: false });
        return 0;
      }
    );
  }
});
