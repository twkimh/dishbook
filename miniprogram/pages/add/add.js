/**
 * 加一道菜（SPEC §3 / §4 / §6）
 * - 主人家提交 -> dish.create 直接 approved，文案「已加入菜谱」
 * - 访客提交 -> dish.create 落 pending，文案必须说清「还没生效」
 * - 图片走客户端直传云存储（SPEC §4 唯一允许客户端直接使用的云能力）
 */

var api = require('../../utils/api.js');

var NAME_MAX = 30;
var STORY_MAX = 200;
var TAG_COUNT_MAX = 5;
var TAG_LEN_MAX = 8;
var IMAGES_MAX = 8;
var IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];

// 同一批图片连续上传可能落在同一毫秒，用自增序号保证 cloudPath 不撞车
var pathSeq = 0;

function toast(title) {
  wx.showToast({
    title: title,
    icon: 'none',
    duration: 2000
  });
}

function readNickname() {
  try {
    var stored = wx.getStorageSync('nickname');
    return typeof stored === 'string' ? stored : '';
  } catch (err) {
    console.error('[add] 读取昵称失败', err);
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
    console.error('[add] 保存昵称失败', err);
  }
}

// 头像在本地缓存里存的是云存储 fileID（不是临时链接）
function readAvatar() {
  try {
    var stored = wx.getStorageSync('avatar');
    return typeof stored === 'string' ? stored : '';
  } catch (err) {
    console.error('[add] 读取头像失败', err);
    return '';
  }
}

function extOf(filePath) {
  var matched = /\.([a-zA-Z0-9]+)(?:\?|$)/.exec(filePath || '');
  var ext = matched ? matched[1].toLowerCase() : 'jpg';
  return IMAGE_EXT.indexOf(ext) < 0 ? 'jpg' : ext;
}

// cloudPath 约定：dishes/{openid}-{时间戳}.{后缀}
function buildCloudPath(filePath) {
  var app = getApp();
  var openid = app && app.globalData && app.globalData.openid ? app.globalData.openid : 'anon';
  pathSeq += 1;
  return 'dishes/' + openid + '-' + (Date.now() + pathSeq) + '.' + extOf(filePath);
}

/**
 * 上传单张图片到云存储。
 * @param {string} filePath 本地临时路径
 * @param {Function} onProgress 进度回调，参数为 0-100
 * @returns {Promise<string>} fileID
 */
function uploadOne(filePath, onProgress) {
  var cloudPath = buildCloudPath(filePath);
  return new Promise(function (resolve, reject) {
    var task = wx.cloud.uploadFile({
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
        reject(err || new Error('上传失败'));
      }
    });
    if (task && typeof task.onProgressUpdate === 'function' && typeof onProgress === 'function') {
      task.onProgressUpdate(function (res) {
        onProgress(res && res.progress ? res.progress : 0);
      });
    }
  });
}

/**
 * 选图。用户取消不算失败，返回空数组；真正失败才 reject。
 * @param {number} count 最多选几张（1-9）
 * @returns {Promise<string[]>} 本地临时路径
 */
function chooseMedia(count) {
  return new Promise(function (resolve, reject) {
    wx.chooseMedia({
      count: count,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: function (res) {
        var files = (res && res.tempFiles) || [];
        var paths = [];
        for (var i = 0; i < files.length; i++) {
          if (files[i] && files[i].tempFilePath) {
            paths.push(files[i].tempFilePath);
          }
        }
        resolve(paths);
      },
      fail: function (err) {
        var message = (err && err.errMsg) || '';
        if (message.indexOf('cancel') >= 0) {
          resolve([]);
          return;
        }
        reject(err || new Error('选图失败'));
      }
    });
  });
}

/* ---------- 二次构图（选图后、上传前裁剪） ---------- */

// 比例表与 CROP_SCALES 一一对应；最后一项 '' 表示不裁剪
var CROP_OPTIONS = ['1:1 方形（推荐）', '4:3 横图', '3:4 竖图', '16:9 宽幅', '不裁剪，用原图'];
var CROP_SCALES = ['1:1', '4:3', '3:4', '16:9', ''];

// 低版本基础库（< 2.26.0）没有这个接口，直接跳过裁剪、用原图上传
function canCropImage() {
  return typeof wx.cropImage === 'function' && typeof wx.canIUse === 'function' && wx.canIUse('cropImage');
}

/**
 * 问一次裁剪比例（本次选中的图共用这一个选择）。
 * @returns {Promise<string>} 合法的 cropScale；'' 表示不裁剪（用户选了「不裁剪」或直接取消）
 */
function askCropScale() {
  return new Promise(function (resolve) {
    wx.showActionSheet({
      itemList: CROP_OPTIONS,
      success: function (res) {
        var tapIndex = res && typeof res.tapIndex === 'number' ? res.tapIndex : -1;
        var scale = tapIndex >= 0 && tapIndex < CROP_SCALES.length ? CROP_SCALES[tapIndex] : '';
        resolve(scale || '');
      },
      fail: function (err) {
        var message = (err && err.errMsg) || '';
        // 用户主动取消等同「不裁剪」；其它原因也不阻断选图，记一笔就够了
        if (message.indexOf('cancel') < 0) {
          console.warn('[add] 打开裁剪比例选择失败，改用原图', message || err);
        }
        resolve('');
      }
    });
  });
}

/**
 * 裁剪单张图。任何异常（接口缺失 / 用户取消 / 裁剪失败 / 没返回路径）都降级成原图。
 * 注意裁剪接口只支持 success/fail 回调，没有 Promise 风格。
 * @param {string} filePath 本地临时路径
 * @param {string} cropScale 合法比例，'' 表示不裁剪
 * @returns {Promise<string>} 裁剪后的临时路径，或原路径
 */
function cropOne(filePath, cropScale) {
  return new Promise(function (resolve) {
    if (!filePath || !cropScale || !canCropImage()) {
      resolve(filePath);
      return;
    }
    var settled = false;
    // 无论成功、失败还是同步抛错，loading 都要关掉，且只关一次
    function finish(path) {
      if (settled) {
        return;
      }
      settled = true;
      wx.hideLoading();
      resolve(path);
    }
    wx.showLoading({ title: '正在裁剪…', mask: true });
    try {
      wx.cropImage({
        src: filePath,
        cropScale: cropScale,
        success: function (res) {
          var cropped = res && res.tempFilePath;
          if (!cropped) {
            console.warn('[add] 裁剪没有返回 tempFilePath，改用原图');
            finish(filePath);
            return;
          }
          finish(cropped);
        },
        fail: function (err) {
          console.warn('[add] 裁剪失败，改用原图', (err && err.errMsg) || err);
          finish(filePath);
        }
      });
    } catch (err) {
      console.warn('[add] 调用裁剪接口抛错，改用原图', err);
      finish(filePath);
    }
  });
}

/**
 * 串行裁剪一批图（微信不允许同时弹多个弹窗，也不宜并发调裁剪）。
 * @returns {Promise<string[]>} 与输入等长、同序的路径数组
 */
function cropBatch(paths, cropScale) {
  var results = [];
  var chain = Promise.resolve();
  for (var i = 0; i < paths.length; i++) {
    (function (index) {
      chain = chain.then(function () {
        return cropOne(paths[index], cropScale).then(function (path) {
          results[index] = path;
        });
      });
    })(i);
  }
  return chain.then(function () {
    return results;
  });
}

/**
 * 选完图后的二次构图入口：一次 actionSheet 应用到本次选中的全部图片，再逐张串行裁剪。
 * 封面与其他图片复用本函数，比例表首项 1:1 就是封面的首选。
 * @param {string[]} paths chooseMedia 拿到的临时路径
 * @returns {Promise<string[]>} 永远 resolve；低版本 / 取消 / 失败都给回原图
 */
function cropPicked(paths) {
  var list = paths || [];
  if (!list.length) {
    return Promise.resolve([]);
  }
  if (!canCropImage()) {
    return Promise.resolve(list.slice());
  }
  return askCropScale().then(function (cropScale) {
    if (!cropScale) {
      return list.slice();
    }
    return cropBatch(list, cropScale);
  });
}

/**
 * 解析身份。app.onLaunch 的 login 是异步的，冷启动直达本页时 role 可能还没回来，
 * 此时用 openid 是否已就绪判断「还没登录」还是「确实是访客」。
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

Page({
  data: {
    isOwner: false,
    nameMax: NAME_MAX,
    storyMax: STORY_MAX,
    tagCountMax: TAG_COUNT_MAX,
    tagLenMax: TAG_LEN_MAX,
    imagesMax: IMAGES_MAX,
    name: '',
    nameLen: 0,
    story: '',
    storyLen: 0,
    cover: { id: '', temp: '', uploading: false, progress: 0 },
    // [{ key, id, temp, uploading, progress }]
    images: [],
    tags: [],
    tagInput: '',
    nickname: '',
    uploading: false,
    submitting: false,
    canSubmit: false
  },

  onLoad: function () {
    this.setData({ nickname: readNickname() });
    this.syncRole();
  },

  onShow: function () {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
    }
    this.syncRole();
  },

  // 加菜页不是列表页，触底没有更多内容可加载；保留处理器以对齐 SPEC §6 的列表页约定
  onReachBottom: function () {},

  onPullDownRefresh: function () {
    this.syncRole().then(function () {
      wx.stopPullDownRefresh();
    });
  },

  syncRole: function () {
    var self = this;
    // onLoad 与 onShow 都会调到这里，缓存一次解析结果，避免重复 login
    if (!this.roleTask) {
      this.roleTask = resolveRole();
    }
    return this.roleTask.then(function (owner) {
      self.setData({ isOwner: owner });
      self.syncBusy();
    });
  },

  /* ---------- 状态汇总：上传中 / 可提交 ---------- */

  syncBusy: function () {
    var data = this.data;
    var uploading = !!data.cover.uploading;
    for (var i = 0; i < data.images.length; i++) {
      if (data.images[i].uploading) {
        uploading = true;
      }
    }
    var canSubmit = !uploading && !data.submitting && (data.name || '').trim() !== '';
    if (uploading !== data.uploading || canSubmit !== data.canSubmit) {
      this.setData({ uploading: uploading, canSubmit: canSubmit });
    }
  },

  /* ---------- 菜名 / 说明 ---------- */

  onNameInput: function (event) {
    var value = (event.detail && event.detail.value) || '';
    this.setData({ name: value, nameLen: value.length });
    this.syncBusy();
  },

  onStoryInput: function (event) {
    var value = (event.detail && event.detail.value) || '';
    this.setData({ story: value, storyLen: value.length });
  },

  /* ---------- 封面 ---------- */

  onChooseCover: function () {
    var self = this;
    if (this.data.cover.uploading) {
      toast('封面正在上传，稍等一下');
      return;
    }
    chooseMedia(1).then(
      function onPicked(paths) {
        if (!paths.length) {
          return null;
        }
        // 封面先问比例（首项 1:1 就是首选），裁完再交给原来的上传逻辑
        return cropPicked(paths.slice(0, 1)).then(function onCropped(cropped) {
          return self.uploadCover(cropped[0] || paths[0]);
        });
      },
      function onChooseFail(err) {
        console.error('[add] 选封面失败', err);
        toast('选图失败，请重试');
      }
    );
  },

  uploadCover: function (filePath) {
    var self = this;
    this.setData({ cover: { id: '', temp: filePath, uploading: true, progress: 0 } });
    this.syncBusy();
    return uploadOne(filePath, function (progress) {
      self.setData({ 'cover.progress': progress });
    }).then(
      function onUploaded(fileID) {
        self.setData({ cover: { id: fileID, temp: fileID, uploading: false, progress: 100 } });
        self.syncBusy();
      },
      function onUploadFail(err) {
        console.error('[add] 封面上传失败', err);
        // 上传失败就丢掉这一张，绝不把半成品留在表单里
        self.setData({ cover: { id: '', temp: '', uploading: false, progress: 0 } });
        self.syncBusy();
        toast('封面上传失败，请重试');
      }
    );
  },

  onRemoveCover: function () {
    if (this.data.cover.uploading) {
      return;
    }
    this.setData({ cover: { id: '', temp: '', uploading: false, progress: 0 } });
    this.syncBusy();
  },

  /* ---------- 其他图片 ---------- */

  onChooseImages: function () {
    var self = this;
    var remain = IMAGES_MAX - this.data.images.length;
    if (remain <= 0) {
      toast('最多再选 8 张');
      return;
    }
    chooseMedia(remain).then(
      function onPicked(paths) {
        if (!paths.length) {
          return null;
        }
        // 一次 actionSheet 应用到本次选中的全部图片，多选也只问一次
        return cropPicked(paths).then(function onCropped(croppedPaths) {
          var base = self.data.images.slice();
          var added = [];
          for (var i = 0; i < croppedPaths.length; i++) {
            added.push({
              key: 'img-' + Date.now() + '-' + i,
              id: '',
              temp: croppedPaths[i],
              uploading: true,
              progress: 0
            });
          }
          self.setData({ images: base.concat(added) });
          self.syncBusy();
          // 顺序上传：并发过多容易被云存储限流，也便于展示单张进度。
          // 用 key 定位而不是下标——某张失败被移出数组时下标会整体前移。
          var chain = Promise.resolve();
          for (var j = 0; j < added.length; j++) {
            chain = chain.then(self.makeImageUploader(added[j].key));
          }
          return chain;
        });
      },
      function onChooseFail(err) {
        console.error('[add] 选图失败', err);
        toast('选图失败，请重试');
      }
    );
  },

  // 按 key 找当前下标：上传期间数组可能因失败的图片被移出而变短
  indexOfImage: function (key) {
    var list = this.data.images;
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === key) {
        return i;
      }
    }
    return -1;
  },

  // 单张上传无论成败都不向上抛，避免未处理的 rejection 中断后面的上传
  makeImageUploader: function (key) {
    var self = this;
    return function () {
      var index = self.indexOfImage(key);
      if (index < 0) {
        return Promise.resolve();
      }
      return uploadOne(self.data.images[index].temp, function (progress) {
        var at = self.indexOfImage(key);
        if (at < 0) {
          return;
        }
        var patch = {};
        patch['images[' + at + '].progress'] = progress;
        self.setData(patch);
      }).then(
        function onUploaded(fileID) {
          var at = self.indexOfImage(key);
          if (at < 0) {
            return;
          }
          var patch = {};
          patch['images[' + at + '].id'] = fileID;
          patch['images[' + at + '].temp'] = fileID;
          patch['images[' + at + '].uploading'] = false;
          patch['images[' + at + '].progress'] = 100;
          self.setData(patch);
          self.syncBusy();
        },
        function onUploadFail(err) {
          console.error('[add] 图片上传失败', err);
          // 失败的那张直接移出列表，不让它混进 images 数组
          var at = self.indexOfImage(key);
          if (at < 0) {
            return;
          }
          var list = self.data.images.slice();
          list.splice(at, 1);
          self.setData({ images: list });
          self.syncBusy();
          toast('有图片上传失败，请重新选');
        }
      );
    };
  },

  onRemoveImage: function (event) {
    var index = Number(event.currentTarget.dataset.index);
    var item = this.data.images[index];
    if (!item || item.uploading) {
      return;
    }
    var list = this.data.images.slice();
    list.splice(index, 1);
    this.setData({ images: list });
    this.syncBusy();
  },

  /* ---------- 标签 ---------- */

  onTagInput: function (event) {
    this.setData({ tagInput: (event.detail && event.detail.value) || '' });
  },

  onTagConfirm: function () {
    this.addTag();
  },

  onAddTag: function () {
    this.addTag();
  },

  addTag: function () {
    var value = (this.data.tagInput || '').trim();
    if (!value) {
      return;
    }
    if (value.length > TAG_LEN_MAX) {
      toast('每个标签最多 8 个字');
      return;
    }
    if (this.data.tags.length >= TAG_COUNT_MAX) {
      toast('最多 5 个标签');
      return;
    }
    if (this.data.tags.indexOf(value) >= 0) {
      this.setData({ tagInput: '' });
      return;
    }
    this.setData({ tags: this.data.tags.concat([value]), tagInput: '' });
  },

  onRemoveTag: function (event) {
    var index = Number(event.currentTarget.dataset.index);
    var list = this.data.tags.slice();
    if (index < 0 || index >= list.length) {
      return;
    }
    list.splice(index, 1);
    this.setData({ tags: list });
  },

  /* ---------- 访客昵称 ---------- */

  onNicknameInput: function (event) {
    this.setData({ nickname: (event.detail && event.detail.value) || '' });
  },

  onNicknameBlur: function () {
    writeNickname((this.data.nickname || '').trim());
  },

  /* ---------- 提交 ---------- */

  onSubmit: function () {
    var self = this;
    if (this.data.submitting) {
      return;
    }
    if (this.data.uploading) {
      toast('图片还在上传，请等上传完成');
      return;
    }

    var name = (this.data.name || '').trim();
    if (!name) {
      toast('先给这道菜起个名字');
      return;
    }
    if (name.length > NAME_MAX) {
      toast('菜名最多 30 个字');
      return;
    }
    var story = (this.data.story || '').trim();
    if (story.length > STORY_MAX) {
      toast('一句话说明最多 200 个字');
      return;
    }
    if (this.data.tags.length > TAG_COUNT_MAX) {
      toast('最多 5 个标签');
      return;
    }

    var images = [];
    for (var i = 0; i < this.data.images.length; i++) {
      var item = this.data.images[i];
      if (item.uploading || !item.id) {
        toast('图片还在上传，请等上传完成');
        return;
      }
      images.push(item.id);
    }
    if (images.length > IMAGES_MAX) {
      toast('其他图片最多 8 张');
      return;
    }

    var payload = {
      name: name,
      cover: this.data.cover.id || '',
      images: images,
      story: story,
      tags: this.data.tags.slice(),
      // 头像昵称一起进 submitter；本地没设置过就是空串，后端按空处理
      avatar: readAvatar()
    };

    var isOwner = this.data.isOwner;
    if (!isOwner) {
      var nickname = (this.data.nickname || '').trim();
      writeNickname(nickname);
      payload.nickname = nickname;
    }

    this.setData({ submitting: true });
    this.syncBusy();

    api.dishCreate(payload).then(
      function onCreated() {
        self.setData({ submitting: false });
        self.resetForm();
        if (isOwner) {
          // 主人家：直接进菜谱
          wx.showToast({ title: '已加入菜谱', icon: 'success', duration: 1800 });
        } else {
          // 访客：明确说明还没上架，别让人以为立刻生效
          wx.showToast({ title: '已提交，等主人家审核通过', icon: 'none', duration: 2600 });
        }
      },
      function onFail(err) {
        // api.js 已经 toast 过失败信息，这里只恢复按钮，表单内容保留
        console.error('[add] 提交失败', err);
        self.setData({ submitting: false });
        self.syncBusy();
      }
    );
  },

  resetForm: function () {
    this.setData({
      name: '',
      nameLen: 0,
      story: '',
      storyLen: 0,
      cover: { id: '', temp: '', uploading: false, progress: 0 },
      images: [],
      tags: [],
      tagInput: '',
      submitting: false,
      uploading: false,
      canSubmit: false
    });
  }
});
