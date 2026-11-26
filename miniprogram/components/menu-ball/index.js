/**
 * 悬浮球 · 点菜单入口（SPEC-v1.0.8 §2.1 menu.*）
 *
 * 对外契约（另一个代理按这个挂球）：
 *   - 路径 /components/menu-ball/index，标签名 menu-ball
 *   - **没有任何 props**，页面里直接写 <menu-ball /> 即可
 *   - 组件自己调 api.menuCurrent() 取状态，自己处理拖动、吸附、位置记忆与跳转
 *   - pageLifetimes.show 会刷新一次状态（组件在普通页面里 pageLifetimes 可靠）
 *
 * 层级：球固定 z-index 800，低于 tabBar(100)？不——tabBar 是 100，引导浮层是 900，
 * 球取 800：盖住 tabBar，但会被引导浮层盖住，符合预期。
 *
 * 坐标一律用 px（拖动取到的是 clientX/clientY，即 px），只有尺寸/留白写成 rpx 再换算。
 */

var api = require('../../utils/api.js');

var BALL_RPX = 100; // 球的直径
var MARGIN_RPX = 16; // 贴边留白
var TABBAR_RPX = 240; // 底部安全边距：要让开三样东西——自定义 tabBar、详情页的固定操作条、以及球自身。120 不够，实测会压住 tabBar 和「点这道菜」按钮。
var DRAG_SLOP_PX = 10; // 移动小于这个距离视为「点击」，不是拖动
var STORAGE_KEY = 'menuBallPos';

/**
 * 取窗口尺寸：优先 wx.getWindowInfo()，取不到再降级到已废弃的 wx.getSystemInfoSync()。
 * @returns {{width:number,height:number,safeBottom:number,ratio:number}}
 */
function readWindow() {
  var info = null;
  try {
    if (typeof wx.getWindowInfo === 'function') {
      info = wx.getWindowInfo();
    }
  } catch (err) {
    info = null;
  }
  if (!info || !info.windowWidth) {
    try {
      info = wx.getSystemInfoSync();
    } catch (err2) {
      info = null;
    }
  }

  var width = info && info.windowWidth ? Number(info.windowWidth) : 0;
  var height = info && info.windowHeight ? Number(info.windowHeight) : 0;
  if (!(width > 0)) {
    width = 375;
  }
  if (!(height > 0)) {
    height = 667;
  }

  var safeBottom = 0;
  if (info && info.safeArea && typeof info.safeArea.bottom === 'number') {
    safeBottom = Math.max(0, height - info.safeArea.bottom);
  }

  return {
    width: width,
    height: height,
    safeBottom: safeBottom,
    ratio: width / 750
  };
}

Component({
  options: {
    addGlobalClass: true
  },

  // 契约要求：不暴露任何 props
  properties: {},

  data: {
    // 有进行中且未过期的菜单 -> 暖橙高亮 + 绿点；否则降饱和
    active: false,
    dragging: false,
    ballStyle: ''
  },

  attached: function () {
    this.alive = true;
    this.moved = false;
    this.touchStart = null;
    this.metrics = readWindow();
    this.pos = this.restorePosition();
    this.applyPosition();
    this.refreshStatus();
  },

  detached: function () {
    this.alive = false;
  },

  pageLifetimes: {
    show: function () {
      this.alive = true;
      // 屏幕尺寸、方向可能在后台变过，重新量一次再钳制当前位置
      this.metrics = readWindow();
      this.pos = this.clamp(this.pos.left, this.pos.top);
      this.applyPosition();
      this.refreshStatus();
    },
    hide: function () {
      this.alive = false;
    }
  },

  methods: {
    /* ---------- 坐标 ---------- */

    // 底部让出的高度：tabBar + 安全区
    bottomReserve: function () {
      var m = this.metrics || readWindow();
      return Math.round(TABBAR_RPX * m.ratio) + (m.safeBottom || 0);
    },

    ballSize: function () {
      var m = this.metrics || readWindow();
      return Math.max(40, Math.round(BALL_RPX * m.ratio));
    },

    /**
     * 钳制到屏幕内。
     * @returns {{left:number,top:number}}
     */
    clamp: function (left, top) {
      var m = this.metrics || readWindow();
      var size = this.ballSize();
      var maxLeft = Math.max(0, m.width - size);
      var maxTop = Math.max(0, m.height - size - this.bottomReserve());

      var l = Number(left);
      var t = Number(top);
      if (!isFinite(l)) {
        l = 0;
      }
      if (!isFinite(t)) {
        t = 0;
      }
      if (l < 0) {
        l = 0;
      }
      if (l > maxLeft) {
        l = maxLeft;
      }
      if (t < 0) {
        t = 0;
      }
      if (t > maxTop) {
        t = maxTop;
      }
      return { left: l, top: t };
    },

    applyPosition: function () {
      var pos = this.pos || { left: 0, top: 0 };
      this.setData({
        ballStyle: 'left:' + Math.round(pos.left) + 'px;top:' + Math.round(pos.top) + 'px;'
      });
    },

    /* ---------- 位置记忆 ---------- */

    // 首次使用默认右下（tabBar 上方）
    defaultPosition: function () {
      var m = this.metrics || readWindow();
      var size = this.ballSize();
      var margin = Math.round(MARGIN_RPX * m.ratio);
      // 默认停在右侧、竖直方向约 55% 处：避开 tabBar、也避开详情页那条很高的底部操作条。
      // （之前默认贴底部，实测会压住「喜欢/想吃」按钮。）
      var top = Math.round(m.height * 0.55);
      return this.clamp(m.width - size - margin, top);
    },

    restorePosition: function () {
      var saved = null;
      try {
        saved = wx.getStorageSync(STORAGE_KEY);
      } catch (err) {
        saved = null;
      }
      if (
        saved &&
        typeof saved === 'object' &&
        typeof saved.left === 'number' &&
        typeof saved.top === 'number' &&
        isFinite(saved.left) &&
        isFinite(saved.top)
      ) {
        // 存的时候可能是别的机型/别的方向，读回来一律重新钳制
        return this.clamp(saved.left, saved.top);
      }
      return this.defaultPosition();
    },

    savePosition: function (pos) {
      try {
        wx.setStorageSync(STORAGE_KEY, {
          left: Math.round(pos.left),
          top: Math.round(pos.top)
        });
      } catch (err) {
        console.warn('[menu-ball] 位置保存失败', err);
      }
    },

    /* ---------- 触摸：拖动 / 吸附 / 点击 ---------- */

    onTouchStart: function (event) {
      var touch = event && event.touches && event.touches[0];
      if (!touch) {
        return;
      }
      var pos = this.pos || { left: 0, top: 0 };
      this.touchStart = {
        x: Number(touch.clientX) || 0,
        y: Number(touch.clientY) || 0,
        left: pos.left,
        top: pos.top
      };
      this.moved = false;
      // 拖动期间关掉 transition，跟手；松手吸附时再打开
      this.setData({ dragging: true });
    },

    onTouchMove: function (event) {
      var touch = event && event.touches && event.touches[0];
      if (!touch || !this.touchStart) {
        return;
      }
      var dx = (Number(touch.clientX) || 0) - this.touchStart.x;
      var dy = (Number(touch.clientY) || 0) - this.touchStart.y;
      if (!this.moved && Math.sqrt(dx * dx + dy * dy) >= DRAG_SLOP_PX) {
        this.moved = true;
      }
      this.pos = this.clamp(this.touchStart.left + dx, this.touchStart.top + dy);
      this.applyPosition();
    },

    onTouchEnd: function () {
      var moved = this.moved;
      this.touchStart = null;
      this.moved = false;
      if (!moved) {
        // 位移 < 10px：当点击处理，进点菜单页
        this.setData({ dragging: false });
        this.openMenu();
        return;
      }
      this.snapToSide();
    },

    onTouchCancel: function () {
      var moved = this.moved;
      this.touchStart = null;
      this.moved = false;
      if (moved) {
        this.snapToSide();
        return;
      }
      this.setData({ dragging: false });
    },

    // 吸附到最近的左/右边缘，动画交给 CSS 的 transition: all 0.2s
    snapToSide: function () {
      var m = this.metrics || readWindow();
      var size = this.ballSize();
      var margin = Math.round(MARGIN_RPX * m.ratio);
      var pos = this.pos || { left: 0, top: 0 };
      var centerX = pos.left + size / 2;
      var left = centerX < m.width / 2 ? margin : m.width - size - margin;
      this.pos = this.clamp(left, pos.top);
      this.setData({ dragging: false });
      this.applyPosition();
      this.savePosition(this.pos);
    },

    /* ---------- 跳转 / 状态 ---------- */

    openMenu: function () {
      var pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
      var route = pages && pages.length ? '/' + pages[pages.length - 1].route : '';
      if (route === '/pages/menu/menu') {
        return;
      }
      wx.navigateTo({
        url: '/pages/menu/menu',
        fail: function (err) {
          console.error('[menu-ball] 打开点菜单失败', err);
        }
      });
    },

    // 状态只决定高亮与圆点，失败时保留上一次结果，不把球打成「未知」
    refreshStatus: function () {
      var self = this;
      api.menuCurrent().then(
        function onSuccess(menu) {
          if (!self.alive) {
            return;
          }
          self.setData({ active: !!menu && menu.expired !== true });
        },
        function onFail(err) {
          console.error('[menu-ball] 读取当前菜单失败', err);
        }
      );
    }
  }
});
