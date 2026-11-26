/**
 * 裁剪页（替代系统裁剪接口，支持自由裁剪与自定义手势）
 * - 单指拖动 / 双指捏合缩放（相对「铺满舞台」1x ~ 5x），实时预览
 * - 自由比例：四角 + 四边手柄改框；固定比例：框锁定，只能拖/缩图片
 * - 确认后走 canvas 2d 导出，EventChannel emit('done', path) 回给调用页
 *
 * 坐标约定（导出公式依赖它，别改）：
 *   图片节点 layout 尺寸 = 原始像素尺寸 imgW/imgH
 *   transform-origin: 0 0，transform: translate(offsetX, offsetY) scale(scale)
 *   于是图片像素坐标 p 落在舞台坐标 offset + p * scale。
 */

var RATIOS = [
  { key: 'free', label: '自由', value: 0 },
  { key: '1:1', label: '1:1', value: 1 },
  { key: '4:3', label: '4:3', value: 4 / 3 },
  { key: '3:4', label: '3:4', value: 3 / 4 },
  { key: '16:9', label: '16:9', value: 16 / 9 }
];

var MAX_ZOOM = 5;          // 缩放下限是「铺满舞台」，上限是其 5 倍
var MIN_CROP_RPX = 120;    // 裁剪框最小边长（rpx）
var FREE_INSET = 0.1;      // 自由模式初始框相对舞台的内缩比例
var OUT_LONG_SIDE = 1080;  // 导出长边像素
var OUT_MAX_SIDE = 2048;   // 导出尺寸硬上限，防止大图撑爆内存

function clamp(value, min, max) {
  if (min > max) {
    return min;
  }
  return value < min ? min : (value > max ? max : value);
}

function px(value) {
  var n = Math.round(value * 100) / 100;
  return n + 'px';
}

function toast(title) {
  wx.showToast({ title: title, icon: 'none', duration: 2000 });
}

function ratioValueOf(key) {
  for (var i = 0; i < RATIOS.length; i++) {
    if (RATIOS[i].key === key) {
      return RATIOS[i].value;
    }
  }
  return 0;
}

// 舞台布局矩形：越界/取不到都当失败，交给上层降级
function measureStage(page) {
  return new Promise(function (resolve, reject) {
    wx.nextTick(function () {
      wx.createSelectorQuery()
        .in(page)
        .select('#cropStage')
        .boundingClientRect(function (rect) {
          if (!rect || !rect.width || !rect.height) {
            reject(new Error('舞台尺寸异常'));
            return;
          }
          resolve(rect);
        })
        .exec();
    });
  });
}

function readImageInfo(src) {
  return new Promise(function (resolve, reject) {
    wx.getImageInfo({
      src: src,
      success: function (res) {
        if (!res || !res.width || !res.height) {
          reject(new Error('图片尺寸异常'));
          return;
        }
        resolve({ width: res.width, height: res.height });
      },
      fail: function (err) {
        reject(err || new Error('读取图片信息失败'));
      }
    });
  });
}

// 按比例在舞台内取最大内接矩形，并尽量保持原有中心
function fitRatioRect(ratio, stageW, stageH, centerX, centerY) {
  var width;
  var height;
  if (stageW / stageH > ratio) {
    height = stageH;
    width = height * ratio;
  } else {
    width = stageW;
    height = width / ratio;
  }
  width = Math.min(width, stageW);
  height = Math.min(height, stageH);
  var left = clamp(centerX - width / 2, 0, stageW - width);
  var top = clamp(centerY - height / 2, 0, stageH - height);
  return { left: left, top: top, width: width, height: height };
}

Page({
  data: {
    src: '',
    ready: false,
    ratios: RATIOS,
    ratio: 'free',
    freeMode: true,
    exporting: false,
    zoomText: '1.0x',
    imgStyle: '',
    boxStyle: '',
    maskTop: '',
    maskBottom: '',
    maskLeft: '',
    maskRight: ''
  },

  onLoad: function (options) {
    var self = this;
    // 结果只 emit 一次：取消 / 返回箭头 / 系统返回 都靠这个标志位防重复
    this.emitted = false;
    this.gesture = { mode: 'none' };
    this.imgW = 0;
    this.imgH = 0;
    this.view = { scale: 1, offsetX: 0, offsetY: 0 };
    this.crop = { left: 0, top: 0, width: 0, height: 0 };

    var raw = (options && options.src) || '';
    try {
      this.srcPath = raw ? decodeURIComponent(raw) : '';
    } catch (err) {
      console.error('[crop] 解析图片路径失败', err);
      this.srcPath = '';
    }

    var windowWidth = 375;
    try {
      var info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      if (info && info.windowWidth) {
        windowWidth = info.windowWidth;
      }
    } catch (err) {
      console.warn('[crop] 读取窗口信息失败，用默认宽度估算 rpx', err);
    }
    this.windowWidth = windowWidth;
    this.minCrop = Math.round((MIN_CROP_RPX * windowWidth) / 750);

    if (!this.srcPath) {
      // 没有图片就没有可裁剪的东西，直接带着 null 回退给调用页
      this.finish(null);
      return;
    }
    this.setData({ src: this.srcPath });
  },

  onReady: function () {
    if (!this.srcPath) {
      return;
    }
    var self = this;
    measureStage(this)
      .then(function (rect) {
        self.stageRect = rect;
        return readImageInfo(self.srcPath);
      })
      .then(function (info) {
        self.imgW = info.width;
        self.imgH = info.height;
        self.resetTransform();
        self.crop = self.initialCrop();
        self.syncView();
        self.setData({ ready: true });
      })
      .catch(function (err) {
        console.error('[crop] 图片初始化失败', err);
        toast('这张图打不开，已跳过裁剪');
        self.finish(self.srcPath); // 异常也要放行，回调查页用原图
      });
  },

  /* ---------- 初始状态 ---------- */

  // 铺满舞台：scale 下限就是这个值，保证裁剪框内不出现空白
  resetTransform: function () {
    var stage = this.stageRect;
    var scale = Math.max(stage.width / this.imgW, stage.height / this.imgH);
    this.minScale = scale;
    this.maxScale = scale * MAX_ZOOM;
    this.view = {
      scale: scale,
      offsetX: (stage.width - this.imgW * scale) / 2,
      offsetY: (stage.height - this.imgH * scale) / 2
    };
  },

  initialCrop: function () {
    var stage = this.stageRect;
    var width = Math.max(this.minCrop, stage.width * (1 - FREE_INSET * 2));
    var height = Math.max(this.minCrop, stage.height * (1 - FREE_INSET * 2));
    return {
      left: (stage.width - width) / 2,
      top: (stage.height - height) / 2,
      width: width,
      height: height
    };
  },

  /* ---------- 渲染 ---------- */

  syncView: function () {
    var stage = this.stageRect;
    if (!stage) {
      return;
    }
    var view = this.view;
    var crop = this.crop;
    var right = crop.left + crop.width;
    var bottom = crop.top + crop.height;
    var zoom = this.minScale ? view.scale / this.minScale : 1;

    this.setData({
      imgStyle: 'width:' + px(this.imgW) + ';height:' + px(this.imgH) +
        ';transform:translate(' + px(view.offsetX) + ',' + px(view.offsetY) + ') scale(' +
        Math.round(view.scale * 100000) / 100000 + ');',
      boxStyle: 'left:' + px(crop.left) + ';top:' + px(crop.top) +
        ';width:' + px(crop.width) + ';height:' + px(crop.height) + ';',
      maskTop: 'left:0;top:0;width:' + px(stage.width) + ';height:' + px(crop.top) + ';',
      maskBottom: 'left:0;top:' + px(bottom) + ';width:' + px(stage.width) + ';height:' +
        px(Math.max(0, stage.height - bottom)) + ';',
      maskLeft: 'left:0;top:' + px(crop.top) + ';width:' + px(crop.left) + ';height:' +
        px(crop.height) + ';',
      maskRight: 'left:' + px(right) + ';top:' + px(crop.top) + ';width:' +
        px(Math.max(0, stage.width - right)) + ';height:' + px(crop.height) + ';',
      zoomText: (Math.round(zoom * 10) / 10).toFixed(1) + 'x'
    });
  },

  /* ---------- 手势：单指拖动 / 双指捏合 ---------- */

  onStageTouchStart: function (event) {
    var touches = (event && event.touches) || [];
    if (!touches.length) {
      return;
    }
    if (touches.length >= 2) {
      this.startPinch(touches);
    } else {
      this.startPan(touches[0]);
    }
  },

  onStageTouchMove: function (event) {
    if (this.data.exporting || !this.data.ready) {
      return;
    }
    var touches = (event && event.touches) || [];
    if (!touches.length) {
      return;
    }
    if (touches.length >= 2) {
      if (this.gesture.mode !== 'pinch') {
        this.startPinch(touches);
      }
      this.movePinch(touches);
    } else {
      if (this.gesture.mode !== 'pan') {
        this.startPan(touches[0]);
      }
      this.movePan(touches[0]);
    }
  },

  onStageTouchEnd: function (event) {
    var touches = (event && event.touches) || [];
    if (!touches.length) {
      this.gesture = { mode: 'none' };
      return;
    }
    // 手指减少后按剩下的手指重新起手，避免位移基准过期导致跳变
    if (touches.length >= 2) {
      this.startPinch(touches);
    } else {
      this.startPan(touches[0]);
    }
  },

  // 触摸点 -> 舞台内坐标
  stagePoint: function (touch) {
    var stage = this.stageRect;
    return {
      x: touch.clientX - stage.left,
      y: touch.clientY - stage.top
    };
  },

  startPan: function (touch) {
    this.gesture = {
      mode: 'pan',
      startX: touch.clientX,
      startY: touch.clientY,
      baseX: this.view.offsetX,
      baseY: this.view.offsetY
    };
  },

  movePan: function (touch) {
    var gesture = this.gesture;
    this.view.offsetX = gesture.baseX + (touch.clientX - gesture.startX);
    this.view.offsetY = gesture.baseY + (touch.clientY - gesture.startY);
    this.clampOffset();
    this.syncView();
  },

  startPinch: function (touches) {
    var a = touches[0];
    var b = touches[1];
    var dx = b.clientX - a.clientX;
    var dy = b.clientY - a.clientY;
    var distance = Math.sqrt(dx * dx + dy * dy);
    var mid = this.stagePoint({
      clientX: (a.clientX + b.clientX) / 2,
      clientY: (a.clientY + b.clientY) / 2
    });
    var view = this.view;
    this.gesture = {
      mode: 'pinch',
      startDist: distance > 0 ? distance : 1,
      baseScale: view.scale,
      // 锚点换算成「图片像素坐标」，缩放后让它仍然停在中点下面
      anchorX: (mid.x - view.offsetX) / view.scale,
      anchorY: (mid.y - view.offsetY) / view.scale
    };
  },

  movePinch: function (touches) {
    var gesture = this.gesture;
    var a = touches[0];
    var b = touches[1];
    var dx = b.clientX - a.clientX;
    var dy = b.clientY - a.clientY;
    var distance = Math.sqrt(dx * dx + dy * dy);
    var view = this.view;

    // scale 钳制：下限是「铺满舞台」，上限是它的 5 倍，裁剪框内不会露白
    var next = clamp(
      gesture.baseScale * (distance / gesture.startDist),
      this.minScale,
      this.maxScale
    );
    view.scale = next;

    // 以当前两指中点（舞台坐标）为锚点反解偏移，保证锚点下的图像内容不跳
    var mid = this.stagePoint({
      clientX: (a.clientX + b.clientX) / 2,
      clientY: (a.clientY + b.clientY) / 2
    });
    view.offsetX = mid.x - gesture.anchorX * next;
    view.offsetY = mid.y - gesture.anchorY * next;

    this.clampOffset();
    this.syncView();
  },

  // 图片必须始终覆盖整个舞台，否则裁剪框内会露出空白
  clampOffset: function () {
    var stage = this.stageRect;
    var view = this.view;
    var width = this.imgW * view.scale;
    var height = this.imgH * view.scale;
    view.offsetX = clamp(view.offsetX, stage.width - width, 0);
    view.offsetY = clamp(view.offsetY, stage.height - height, 0);
  },

  /* ---------- 裁剪框手柄（仅自由比例） ---------- */

  onHandleStart: function (event) {
    if (this.data.exporting || !this.data.ready) {
      return;
    }
    var handle = (event.currentTarget.dataset || {}).h;
    var touch = (event.touches && event.touches[0]) || null;
    if (!handle || !touch) {
      return;
    }
    this.gesture = {
      mode: 'handle',
      handle: handle,
      startX: touch.clientX,
      startY: touch.clientY,
      base: {
        left: this.crop.left,
        top: this.crop.top,
        width: this.crop.width,
        height: this.crop.height
      }
    };
  },

  onHandleMove: function (event) {
    var gesture = this.gesture;
    if (!gesture || gesture.mode !== 'handle') {
      return;
    }
    if (this.data.exporting || !this.data.ready) {
      return;
    }
    var touch = (event.touches && event.touches[0]) || null;
    if (!touch) {
      return;
    }
    var stage = this.stageRect;
    var min = this.minCrop;
    var base = gesture.base;
    var handle = gesture.handle;
    var dx = touch.clientX - gesture.startX;
    var dy = touch.clientY - gesture.startY;

    var left = base.left;
    var top = base.top;
    var right = base.left + base.width;
    var bottom = base.top + base.height;

    // 每条边双向钳制：内侧不小于最小边长，外侧不出舞台
    if (handle.indexOf('w') >= 0) {
      left = clamp(base.left + dx, 0, right - min);
    }
    if (handle.indexOf('e') >= 0) {
      right = clamp(base.left + base.width + dx, left + min, stage.width);
    }
    if (handle.indexOf('n') >= 0) {
      top = clamp(base.top + dy, 0, bottom - min);
    }
    if (handle.indexOf('s') >= 0) {
      bottom = clamp(base.top + base.height + dy, top + min, stage.height);
    }

    // 边界触顶后可能出现 left > right - min，再收一次保证宽高有效
    left = clamp(left, 0, stage.width - min);
    right = clamp(right, left + min, stage.width);
    top = clamp(top, 0, stage.height - min);
    bottom = clamp(bottom, top + min, stage.height);

    this.crop = {
      left: left,
      top: top,
      width: right - left,
      height: bottom - top
    };
    this.syncView();
  },

  onHandleEnd: function () {
    this.gesture = { mode: 'none' };
  },

  /* ---------- 比例切换 ---------- */

  onRatioTap: function (event) {
    if (this.data.exporting || !this.data.ready) {
      return;
    }
    var key = (event.currentTarget.dataset || {}).key;
    key = key === undefined || key === null ? 'free' : String(key);
    if (key === this.data.ratio) {
      return;
    }
    var stage = this.stageRect;
    var ratio = ratioValueOf(key);
    var centerX = this.crop.left + this.crop.width / 2;
    var centerY = this.crop.top + this.crop.height / 2;

    if (!ratio) {
      // 回到自由比例：沿用当前框，只把越界部分收回舞台内
      var rect = this.crop;
      var width = clamp(rect.width, this.minCrop, stage.width);
      var height = clamp(rect.height, this.minCrop, stage.height);
      this.crop = {
        left: clamp(rect.left, 0, stage.width - width),
        top: clamp(rect.top, 0, stage.height - height),
        width: width,
        height: height
      };
    } else {
      this.crop = fitRatioRect(ratio, stage.width, stage.height, centerX, centerY);
    }

    this.setData({ ratio: key, freeMode: !ratio });
    this.syncView();
  },

  /* ---------- 导出（canvas 2d） ---------- */

  onConfirmTap: function () {
    var self = this;
    if (this.data.exporting) {
      return;
    }
    if (!this.data.ready) {
      toast('图片还没准备好');
      return;
    }
    this.setData({ exporting: true });
    wx.showLoading({ title: '正在导出…', mask: true });
    this.exportCrop().then(
      function onExported(path) {
        wx.hideLoading();
        self.setData({ exporting: false });
        self.finish(path || self.srcPath);
      },
      function onExportFail(err) {
        console.error('[crop] 导出失败，改用原图', err);
        wx.hideLoading();
        self.setData({ exporting: false });
        toast('裁剪失败，已用原图');
        // 异常不是用户意图：放行原图让上传继续，绝不把人卡在裁剪页
        self.finish(self.srcPath);
      }
    );
  },

  // 输出尺寸：长边 1080，再兜一层 2048 上限
  outputSize: function () {
    var crop = this.crop;
    var k = OUT_LONG_SIDE / Math.max(crop.width, crop.height);
    var width = Math.round(crop.width * k);
    var height = Math.round(crop.height * k);
    var longest = Math.max(width, height);
    if (longest > OUT_MAX_SIDE) {
      var shrink = OUT_MAX_SIDE / longest;
      width = Math.round(width * shrink);
      height = Math.round(height * shrink);
    }
    return {
      width: Math.max(1, width),
      height: Math.max(1, height)
    };
  },

  exportCrop: function () {
    var self = this;
    return new Promise(function (resolve, reject) {
      var size = self.outputSize();
      wx.createSelectorQuery()
        .in(self)
        .select('#cropCanvas')
        .fields({ node: true, size: true })
        .exec(function (res) {
          var canvas = res && res[0] && res[0].node;
          if (!canvas) {
            reject(new Error('取不到 canvas 节点'));
            return;
          }
          var ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('取不到 canvas 上下文'));
            return;
          }
          // 先定尺寸再画：赋值会清空画布，顺序反了导出就是空白
          canvas.width = size.width;
          canvas.height = size.height;

          // canvas 2d 里不能直接把路径交给 drawImage，必须走 createImage + onload
          var image = canvas.createImage();
          image.onload = function () {
            try {
              ctx.fillStyle = 'rgba(255, 253, 248, 1)';
              ctx.fillRect(0, 0, size.width, size.height);

              // 导出换算：transform-origin 0 0，输出像素 / 舞台像素
              var k = size.width / self.crop.width;
              var dx = (self.view.offsetX - self.crop.left) * k;
              var dy = (self.view.offsetY - self.crop.top) * k;
              var dw = self.imgW * self.view.scale * k;
              var dh = self.imgH * self.view.scale * k;
              ctx.drawImage(image, dx, dy, dw, dh);
            } catch (err) {
              reject(err);
              return;
            }
            wx.canvasToTempFilePath({
              canvas: canvas,
              x: 0,
              y: 0,
              width: size.width,
              height: size.height,
              destWidth: size.width,
              destHeight: size.height,
              fileType: 'jpg',
              quality: 0.92,
              success: function (out) {
                if (out && out.tempFilePath) {
                  resolve(out.tempFilePath);
                  return;
                }
                reject(new Error('导出没有返回临时路径'));
              },
              fail: function (err) {
                reject(err || new Error('canvasToTempFilePath 失败'));
              }
            });
          };
          image.onerror = function () {
            reject(new Error('canvas 加载图片失败'));
          };
          image.src = self.srcPath;
        });
    });
  },

  /* ---------- 结果回传：done(path) / done(null) 只发一次 ---------- */

  emitResult: function (path) {
    if (this.emitted) {
      return false;
    }
    this.emitted = true;
    try {
      var channel = typeof this.getOpenerEventChannel === 'function'
        ? this.getOpenerEventChannel()
        : null;
      if (channel && typeof channel.emit === 'function') {
        channel.emit('done', path === undefined ? null : path);
      } else {
        console.warn('[crop] 没有 EventChannel，结果无法回传');
      }
    } catch (err) {
      console.error('[crop] 回传结果失败', err);
    }
    return true;
  },

  // 带路径的收尾（成功导出 / 异常降级都用它）
  finish: function (path) {
    if (this.emitted) {
      return;
    }
    this.emitResult(path);
    wx.navigateBack({
      delta: 1,
      fail: function (err) {
        // 页面栈异常时也不能卡住：navigateBack 失败就靠 onUnload 兜底
        console.warn('[crop] 返回上一页失败', err);
      }
    });
  },

  // 取消：取消按钮 / 标题栏返回箭头都走这里
  onCancelTap: function () {
    if (this.data.exporting) {
      return;
    }
    this.finish(null);
  },

  // 系统返回（物理返回键 / 手势返回 / 导航栏返回箭头）最后一道兜底
  onUnload: function () {
    if (this.emitted) {
      return;
    }
    this.emitResult(null);
  }
});
