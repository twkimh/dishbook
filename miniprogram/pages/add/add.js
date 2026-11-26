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
var INGREDIENT_COUNT_MAX = 20;
var INGREDIENT_LEN_MAX = 20;
var SEASONING_COUNT_MAX = 20;
var SEASONING_LEN_MAX = 20;

// 烹饪方式白名单（SPEC-v1.0.8 §1.1），分组与词序照原样，共 41 个词；可多选、不限数量
var METHOD_GROUPS = [
  { key: 'fire', label: '火候', words: ['炒', '爆', '熘', '煸', '炝', '干煸'] },
  { key: 'oil', label: '油烹', words: ['炸', '煎', '烙', '烤', '炭烤', '熏', '焗'] },
  { key: 'steam', label: '汽烹', words: ['蒸', '清蒸', '粉蒸'] },
  { key: 'water', label: '水烹', words: ['煮', '炖', '焖', '煨', '烧', '红烧', '烩', '汆', '涮', '熬', '焯'] },
  { key: 'cold', label: '冷处理', words: ['拌', '凉拌', '腌', '卤', '酱', '醉', '糟'] },
  { key: 'other', label: '其他', words: ['白灼', '糖醋', '拔丝', '干锅', '砂锅', '铁板', '水煮'] }
];

/* ---------- 数组字段的防御式读写：缺失、类型不对都不抛错 ---------- */

function readStringList(value) {
  var list = [];
  if (!value || typeof value.length !== 'number') {
    return list;
  }
  for (var i = 0; i < value.length; i++) {
    if (typeof value[i] === 'string' && value[i]) {
      list.push(value[i]);
    }
  }
  return list;
}

// 面板视图：把白名单展开成带 selected 标记的分组，选中态与 data.methods 实时同步
function buildMethodGroups(selected) {
  var picked = readStringList(selected);
  var groups = [];
  for (var i = 0; i < METHOD_GROUPS.length; i++) {
    var source = METHOD_GROUPS[i];
    var words = [];
    for (var j = 0; j < source.words.length; j++) {
      words.push({
        name: source.words[j],
        selected: picked.indexOf(source.words[j]) >= 0
      });
    }
    groups.push({ key: source.key, label: source.label, words: words });
  }
  return groups;
}

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

/* ---------- 二次构图：跳转自建裁剪页（已废弃系统裁剪接口） ---------- */

/**
 * 跳到裁剪页让用户自由裁剪。
 * 任何异常（跳转失败 / 用户取消 / 导出失败）都回退成原图，绝不阻断上传。
 * @param {string} filePath 本地临时路径
 * @returns {Promise<string>} 裁剪后的临时路径，或原路径
 */
function cropWithPage(filePath) {
  return new Promise(function (resolve) {
    if (!filePath) {
      resolve(filePath);
      return;
    }
    var settled = false;
    function done(path) {
      if (settled) {
        return;
      }
      settled = true;
      resolve(path || filePath);
    }
    wx.navigateTo({
      url: '/pages/crop/crop?src=' + encodeURIComponent(filePath),
      events: {
        // croppedPath 为 null 表示用户取消裁剪 -> 沿用原图
        done: function (croppedPath) {
          done(croppedPath);
        }
      },
      fail: function (err) {
        console.warn('[add] 打开裁剪页失败，改用原图', (err && err.errMsg) || err);
        done('');
      }
    });
  });
}

/**
 * 串行裁剪一批图：页面栈上同时只压一个裁剪页，避免多层跳转。
 * @returns {Promise<string[]>} 与输入等长、同序的路径数组
 */
function cropWithPages(paths) {
  var results = [];
  var chain = Promise.resolve();
  for (var i = 0; i < paths.length; i++) {
    (function (index) {
      chain = chain.then(function () {
        return cropWithPage(paths[index]).then(function (path) {
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
    ingredientCountMax: INGREDIENT_COUNT_MAX,
    ingredientLenMax: INGREDIENT_LEN_MAX,
    seasoningCountMax: SEASONING_COUNT_MAX,
    seasoningLenMax: SEASONING_LEN_MAX,
    name: '',
    nameLen: 0,
    story: '',
    storyLen: 0,
    cover: { id: '', temp: '', uploading: false, progress: 0 },
    // [{ key, id, temp, uploading, progress }]
    images: [],
    tags: [],
    tagInput: '',
    ingredients: [],
    ingredientInput: '',
    seasonings: [],
    seasoningInput: '',
    methods: [],
    // 烹饪方式页内浮层：开启时用 methodGroups 渲染分组，选中态跟 methods 一起重算
    methodPanel: false,
    methodGroups: buildMethodGroups([]),
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
        // 封面默认先跳裁剪页（1:1 由用户在裁剪页里选），裁完再交给原来的上传逻辑
        return cropWithPage(paths[0]).then(function onCropped(croppedPath) {
          return self.uploadCover(croppedPath);
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
        // 逐张跳裁剪页（一次一个），全部裁完再进原来的上传流程
        return cropWithPages(paths).then(function onCropped(croppedPaths) {
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

  /* ---------- 材料 / 调料（与「标签」同一套胶囊交互） ---------- */

  onIngredientInput: function (event) {
    this.setData({ ingredientInput: (event.detail && event.detail.value) || '' });
  },

  onIngredientConfirm: function () {
    this.addIngredient();
  },

  onAddIngredient: function () {
    this.addIngredient();
  },

  addIngredient: function () {
    var value = (this.data.ingredientInput || '').trim();
    if (!value) {
      return;
    }
    if (value.length > INGREDIENT_LEN_MAX) {
      toast('每项材料最多 20 个字');
      return;
    }
    var list = readStringList(this.data.ingredients);
    if (list.length >= INGREDIENT_COUNT_MAX) {
      toast('最多 20 项材料');
      return;
    }
    if (list.indexOf(value) >= 0) {
      this.setData({ ingredientInput: '' });
      return;
    }
    this.setData({ ingredients: list.concat([value]), ingredientInput: '' });
  },

  onRemoveIngredient: function (event) {
    var index = Number(event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.index
      : NaN);
    var list = readStringList(this.data.ingredients);
    // 用「不成立就返回」判断，NaN（dataset 丢了）也一并挡掉，不会误删第 0 项
    if (!(index >= 0 && index < list.length)) {
      return;
    }
    list.splice(index, 1);
    this.setData({ ingredients: list });
  },

  onSeasoningInput: function (event) {
    this.setData({ seasoningInput: (event.detail && event.detail.value) || '' });
  },

  onSeasoningConfirm: function () {
    this.addSeasoning();
  },

  onAddSeasoning: function () {
    this.addSeasoning();
  },

  addSeasoning: function () {
    var value = (this.data.seasoningInput || '').trim();
    if (!value) {
      return;
    }
    if (value.length > SEASONING_LEN_MAX) {
      toast('每项调料最多 20 个字');
      return;
    }
    var list = readStringList(this.data.seasonings);
    if (list.length >= SEASONING_COUNT_MAX) {
      toast('最多 20 项调料');
      return;
    }
    if (list.indexOf(value) >= 0) {
      this.setData({ seasoningInput: '' });
      return;
    }
    this.setData({ seasonings: list.concat([value]), seasoningInput: '' });
  },

  onRemoveSeasoning: function (event) {
    var index = Number(event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.index
      : NaN);
    var list = readStringList(this.data.seasonings);
    if (!(index >= 0 && index < list.length)) {
      return;
    }
    list.splice(index, 1);
    this.setData({ seasonings: list });
  },

  /* ---------- 烹饪方式（白名单多选 + 页内浮层） ---------- */

  onOpenMethodPanel: function () {
    this.setData({ methodPanel: true, methodGroups: buildMethodGroups(this.data.methods) });
  },

  onCloseMethodPanel: function () {
    this.setData({ methodPanel: false });
  },

  // 再点一次取消选中；不限数量，所以不做上限判断
  onToggleMethod: function (event) {
    var dataset = event && event.currentTarget ? event.currentTarget.dataset : null;
    var name = dataset && typeof dataset.name === 'string' ? dataset.name : '';
    if (!name) {
      return;
    }
    var list = readStringList(this.data.methods);
    var at = list.indexOf(name);
    if (at >= 0) {
      list.splice(at, 1);
    } else {
      list.push(name);
    }
    // 面板开着就即时高亮；关掉面板后 methodGroups 也是最新的，再打开保留已选
    this.setData({ methods: list, methodGroups: buildMethodGroups(list) });
  },

  onRemoveMethod: function (event) {
    var index = Number(event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.index
      : NaN);
    var list = readStringList(this.data.methods);
    if (!(index >= 0 && index < list.length)) {
      return;
    }
    list.splice(index, 1);
    this.setData({ methods: list, methodGroups: buildMethodGroups(list) });
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
      toast('想说的话最多 200 个字');
      return;
    }
    if (this.data.tags.length > TAG_COUNT_MAX) {
      toast('最多 5 个标签');
      return;
    }
    var ingredients = readStringList(this.data.ingredients);
    if (ingredients.length > INGREDIENT_COUNT_MAX) {
      toast('最多 20 项材料');
      return;
    }
    var seasonings = readStringList(this.data.seasonings);
    if (seasonings.length > SEASONING_COUNT_MAX) {
      toast('最多 20 项调料');
      return;
    }
    var methods = readStringList(this.data.methods);

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
      // v1.0.8：材料 / 调料 / 烹饪方式；story 仍是原来那个字段，只是文案改成「想说的话」
      ingredients: ingredients,
      seasonings: seasonings,
      methods: methods,
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
      ingredients: [],
      ingredientInput: '',
      seasonings: [],
      seasoningInput: '',
      methods: [],
      methodPanel: false,
      methodGroups: buildMethodGroups([]),
      submitting: false,
      uploading: false,
      canSubmit: false
    });
  }
});
