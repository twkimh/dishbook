/**
 * 我的（SPEC §6）
 * 身份卡片 + 主人家专属入口（点菜记录 / 待审核，带待审核角标）+ 我的提交列表。
 * onShow 刷新角标与列表；下拉刷新 / 触底加载 / 空状态 / 骨架。
 */

var api = require('../../utils/api.js');
var format = require('../../utils/format.js');

var PAGE_SIZE = 10;
var STATUS_TEXT = {
  approved: '已上架',
  pending: '待审核',
  rejected: '未通过'
};

function toast(title) {
  wx.showToast({ title: title, icon: 'none', duration: 2000 });
}

function readNickname() {
  try {
    var stored = wx.getStorageSync('nickname');
    return typeof stored === 'string' ? stored : '';
  } catch (err) {
    console.error('[mine] 读取昵称失败', err);
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
    console.error('[mine] 保存昵称失败', err);
  }
}

// 本地缓存的是云存储 fileID（不是临时链接），可直接用于 <image src>
function readAvatar() {
  try {
    var stored = wx.getStorageSync('avatar');
    return typeof stored === 'string' ? stored : '';
  } catch (err) {
    console.error('[mine] 读取头像失败', err);
    return '';
  }
}

function writeAvatar(value) {
  try {
    if (value) {
      wx.setStorageSync('avatar', value);
    } else {
      wx.removeStorageSync('avatar');
    }
  } catch (err) {
    console.error('[mine] 保存头像失败', err);
  }
}

// 占位头像上的首字
function firstChar(value) {
  var text = typeof value === 'string' ? value.trim() : '';
  return text ? text.charAt(0) : '';
}

/**
 * 上传头像到云存储，换回 fileID。
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

/**
 * app.onLaunch 的 login 是异步的：首次进入时 role 可能还没回来。
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

function decorate(raw) {
  var item = raw || {};
  var status = STATUS_TEXT[item.status] ? item.status : 'pending';
  return {
    id: item._id || item.id || '',
    name: item.name || '未命名',
    cover: item.cover || '',
    status: status,
    statusText: STATUS_TEXT[status],
    timeText: format.formatRelativeTime(item.createdAt)
  };
}

Page({
  data: {
    isOwner: false,
    nickname: '',
    // 头像三件套：avatarUrl 只用于显示（临时路径 / https 链接 / fileID 都行），
    // avatarFileID 是最近一次拿到的 fileID，avatarText 是占位首字
    avatarUrl: '',
    avatarFileID: '',
    avatarText: '友',
    avatarUploading: false,
    pendingCount: 0,
    pendingText: '0',
    list: [],
    total: 0,
    page: 0,
    hasMore: true,
    loading: false,
    loadingMore: false,
    skeleton: true,
    noticeHint: ''
  },

  onLoad: function () {
    var nickname = readNickname();
    var avatar = readAvatar();
    this.setData({
      nickname: nickname,
      avatarUrl: avatar,
      avatarFileID: avatar,
      avatarText: firstChar(nickname) || '友'
    });
    this.loadProfile();
  },

  onShow: function () {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }
    var nickname = readNickname();
    this.setData({ nickname: nickname, avatarText: firstChar(nickname) || '友' });
    var self = this;
    // templateId 要等 login 回来才有；冷启动时 onShow 早于 signIn，
    // 直接同步读 globalData 会拿到空串，误显示「后台还没配置提醒模板」
    this.refreshAll().then(function () {
      self.refreshNoticeHint();
    }, function () {
      self.refreshNoticeHint();
    });
  },

  /* ---------- 头像 / 昵称（微信头像昵称填写能力） ---------- */

  // 服务器上的资料只是兜底：本地已选过的优先（可能刚换完还没同步完）
  loadProfile: function () {
    var self = this;
    return api.profileGet().then(
      function onSuccess(res) {
        var payload = res || {};
        var remoteAvatar = typeof payload.avatar === 'string' ? payload.avatar : '';
        var remoteNickname = typeof payload.nickname === 'string' ? payload.nickname : '';
        var patch = {};
        if (!self.data.avatarUrl && remoteAvatar) {
          patch.avatarUrl = remoteAvatar;
        }
        // 云端存的可能是 fileID（cloud:// 开头）也可能被转成临时链接：
        // 只有 fileID 才写回本地缓存/avatarFileID，否则下次保存资料会被归一成空串
        if (!self.data.avatarFileID && remoteAvatar.indexOf('cloud://') === 0) {
          writeAvatar(remoteAvatar);
          patch.avatarFileID = remoteAvatar;
        }
        if (!self.data.nickname && remoteNickname) {
          writeNickname(remoteNickname);
          patch.nickname = remoteNickname;
          patch.avatarText = firstChar(remoteNickname) || '友';
        }
        var keys = Object.keys(patch);
        if (keys.length) {
          self.setData(patch);
        }
      },
      function onFail(err) {
        // api.js 已经 toast 过，这里保持本地缓存展示即可
        console.error('[mine] 资料加载失败', err);
      }
    );
  },

  // 只同步昵称时用本地缓存里的 fileID，避免把头像清空
  saveProfile: function () {
    return api.profileSave({
      nickname: this.data.nickname || '',
      avatar: this.data.avatarFileID || readAvatar()
    }).then(
      function onSuccess(res) {
        return res;
      },
      function onFail(err) {
        console.error('[mine] 资料保存失败', err);
        return null;
      }
    );
  },

  onChooseAvatar: function (event) {
    var self = this;
    var tempPath = (event && event.detail && event.detail.avatarUrl) || '';
    if (!tempPath || this.data.avatarUploading) {
      return;
    }
    // 先用临时路径即时回显，不等上传完成
    this.setData({ avatarUrl: tempPath, avatarUploading: true });

    var app = getApp();
    var openid = (app && app.globalData && app.globalData.openid) || '';
    var cloudPath = 'avatars/' + (openid || 'anon') + '-' + Date.now() + '.jpg';

    uploadAvatar(tempPath, cloudPath).then(
      function onUploaded(fileID) {
        writeAvatar(fileID);
        self.setData({ avatarFileID: fileID, avatarUrl: fileID, avatarUploading: false });
        // 资料同步失败不回滚头像：fileID 已经在本地，下次保存会再带上
        self.saveProfile().then(function (res) {
          if (res) {
            toast('头像已更新');
          }
        });
      },
      function onUploadFail(err) {
        console.error('[mine] 头像上传失败', err);
        // 回退到上一次可用头像，别停在打不开的临时路径上
        self.setData({
          avatarUrl: self.data.avatarFileID || '',
          avatarUploading: false
        });
        toast('头像没存上，请重试');
      }
    );
  },

  // 头像加载失败：清掉 src，落回纯 CSS 占位，不留裂图
  onAvatarError: function () {
    this.setData({ avatarUrl: '' });
  },

  onNicknameInput: function (event) {
    var value = (event.detail && event.detail.value) || '';
    this.setData({ nickname: value, avatarText: firstChar(value) || '友' });
  },

  onNicknameBlur: function (event) {
    var value = (event && event.detail && event.detail.value) || this.data.nickname || '';
    this.applyNickname(value);
  },

  // 改称呼：写本地缓存（纯本地能力照旧）+ 同步到云端资料
  applyNickname: function (value) {
    var next = (value || '').trim();
    if (next.length > 20) {
      toast('称呼最多 20 个字');
      next = next.slice(0, 20);
    }
    writeNickname(next);
    this.setData({ nickname: next, avatarText: firstChar(next) || '友' });
    this.saveProfile();
    return next;
  },

  // 「点菜提醒」状态：看用户是否对该模板选过「总是保持以上选择」。
  // 一次性订阅的额度按接收者计，主人家自己授权过才有额度，朋友授权的不算。
  refreshNoticeHint: function () {
    var self = this;
    var app = getApp();
    var templateId = (app && app.globalData && app.globalData.templateId) || '';
    if (!templateId) {
      self.setData({ noticeHint: '后台还没配置提醒模板' });
      return;
    }
    if (typeof wx.getSetting !== 'function') {
      self.setData({ noticeHint: '当前微信版本不支持提醒' });
      return;
    }
    wx.getSetting({
      withSubscriptions: true,
      success: function (res) {
        var itemSettings =
          (res && res.subscriptionsSetting && res.subscriptionsSetting.itemSettings) || {};
        var state = itemSettings[templateId];
        var alwaysAccept =
          state === 'accept' || state === 'acceptWithAudio' || state === 'acceptWithAlert';
        self.setData({
          noticeHint: alwaysAccept
            ? '已开启，每次打开小程序自动补充额度'
            : '点一下开启，朋友点菜会用微信通知你'
        });
      },
      fail: function () {
        self.setData({ noticeHint: '点一下开启，朋友点菜会用微信通知你' });
      }
    });
  },

  onNoticeTap: function () {
    var self = this;
    var app = getApp();
    var templateId = (app && app.globalData && app.globalData.templateId) || '';
    if (!templateId) {
      toast('后台还没配置提醒模板');
      return;
    }
    if (typeof wx.requestSubscribeMessage !== 'function') {
      toast('当前微信版本不支持');
      return;
    }
    wx.requestSubscribeMessage({
      tmplIds: [templateId],
      success: function () {
        toast('已开启，请勾选「总是保持」以便自动补充');
        self.refreshNoticeHint();
      },
      fail: function () {
        toast('未开启提醒');
        self.refreshNoticeHint();
      }
    });
  },

  onPullDownRefresh: function () {
    this.refreshAll().then(function () {
      wx.stopPullDownRefresh();
    }, function () {
      wx.stopPullDownRefresh();
    });
  },

  onReachBottom: function () {
    this.fetchMine(false);
  },

  refreshAll: function () {
    var self = this;
    return resolveRole().then(
      function (owner) {
        self.setData({ isOwner: owner });
        var tasks = [self.fetchMine(true)];
        if (owner) {
          tasks.push(self.fetchPendingCount());
        }
        return Promise.all(tasks);
      },
      function (err) {
        console.error('[mine] 身份解析失败', err);
        self.setData({ isOwner: false });
        return self.fetchMine(true);
      }
    );
  },

  // 角标只要数量：pageSize 1 拿 total
  fetchPendingCount: function () {
    var self = this;
    return api.dishReviewList({ page: 1, pageSize: 1 }).then(
      function onSuccess(res) {
        var total = Number(res && res.total) || 0;
        self.setData({ pendingCount: total, pendingText: format.formatCount(total) });
      },
      function onFail(err) {
        console.error('[mine] 待审核数量加载失败', err);
      }
    );
  },

  /**
   * @param {boolean} reset true 拉第一页并替换列表，false 追加下一页
   */
  fetchMine: function (reset) {
    var self = this;
    if (this.data.loading || this.data.loadingMore) {
      return Promise.resolve();
    }
    if (!reset && !this.data.hasMore) {
      return Promise.resolve();
    }
    var nextPage = reset ? 1 : this.data.page + 1;
    if (reset) {
      this.setData({ loading: true, skeleton: this.data.list.length === 0 });
    } else {
      this.setData({ loadingMore: true });
    }

    return api.dishMine({ page: nextPage, pageSize: PAGE_SIZE }).then(
      function onSuccess(res) {
        var raw = (res && res.list) || [];
        var rows = [];
        for (var i = 0; i < raw.length; i++) {
          rows.push(decorate(raw[i]));
        }
        self.setData({
          list: reset ? rows : self.data.list.concat(rows),
          total: Number(res && res.total) || 0,
          page: nextPage,
          hasMore: !!(res && res.hasMore),
          loading: false,
          loadingMore: false,
          skeleton: false
        });
      },
      function onFail(err) {
        console.error('[mine] 我的提交加载失败', err);
        self.setData({ loading: false, loadingMore: false, skeleton: false });
      }
    );
  },

  onEditNickname: function () {
    var self = this;
    wx.showModal({
      title: '怎么称呼你',
      editable: true,
      placeholderText: '比如 小林',
      content: self.data.nickname,
      success: function (res) {
        if (!res || !res.confirm) {
          return;
        }
        var value = (res.content || '').trim();
        if (value.length > 20) {
          toast('称呼最多 20 个字');
          return;
        }
        // 本地缓存 + 云端资料一起更新
        self.applyNickname(value);
        toast(value ? '称呼已更新' : '称呼已清空');
      },
      fail: function (err) {
        console.error('[mine] 修改称呼弹窗失败', err);
      }
    });
  },

  goOrders: function () {
    wx.navigateTo({
      url: '/pages/orders/orders',
      fail: function (err) {
        console.error('[mine] 打开点菜记录失败', err);
      }
    });
  },

  goReview: function () {
    wx.navigateTo({
      url: '/pages/review/review',
      fail: function (err) {
        console.error('[mine] 打开待审核失败', err);
      }
    });
  },

  goDish: function (event) {
    var id = event.currentTarget.dataset.id;
    if (!id) {
      return;
    }
    wx.navigateTo({
      url: '/pages/detail/detail?id=' + id,
      fail: function (err) {
        console.error('[mine] 打开菜品详情失败', err);
      }
    });
  }
});
