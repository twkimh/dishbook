/**
 * 应用外壳（SPEC §1 / §6）
 * 启动即初始化云开发并调一次 api.login()，把
 * { openid, role, hasTemplate, templateId, orderConfirmTemplateId } 缓存到 globalData。
 * 登录失败不阻断启动：role 兜底为 'guest'，只打日志。
 */

var api = require('./utils/api.js');

App({
  globalData: {
    openid: '',
    role: 'guest',
    hasTemplate: false,
    // 订阅消息模板 ID；wx.requestSubscribeMessage 的 tmplIds 必须有值才能弹出授权窗
    templateId: '',
    // 模板 B：点菜者收「你已成功下单」的模板 ID，未配置为空串
    orderConfirmTemplateId: ''
  },

  onLaunch: function () {
    if (!wx.cloud) {
      console.error('[app] 当前基础库不支持 wx.cloud，请使用 2.20.0 及以上版本');
      return;
    }

    wx.cloud.init({
      env: wx.cloud.DYNAMIC_CURRENT_ENV,
      traceUser: true
    });

    this.signIn();
  },

  onShow: function () {
    // 冷启动时 onShow 可能早于 signIn 完成（role 还是 guest），所以 signIn 成功后也会再调一次
    this.topUpNoticeQuota();
  },

  /**
   * 补充「点菜提醒」的订阅额度。
   *
   * 背景：一次性订阅的额度是按「接收者」算的。朋友点菜时授权的是他自己的额度，
   * 只能用来给他自己发「下单成功」，不能用来给主人家发「有人点菜了」。
   * 所以主人家必须自己授权过模板 A，才有额度可消耗。
   *
   * 用户在授权弹窗上勾了「总是保持以上选择」之后，requestSubscribeMessage 不再弹窗、
   * 直接返回成功并 +1 条额度。因此这里每次启动静默补一条，主人家就不用手动维护。
   * 没勾过的（itemSettings 里没有 accept 记录）不在这里弹窗，留给他自己点「我的」页的按钮。
   */
  topUpNoticeQuota: function () {
    var app = this;
    if (typeof wx.requestSubscribeMessage !== 'function') {
      return;
    }
    var templateId = app.globalData.templateId;
    if (!templateId || app.globalData.role !== 'owner') {
      return;
    }
    if (typeof wx.getSetting !== 'function') {
      return;
    }
    try {
      wx.getSetting({
        withSubscriptions: true,
        success: function (res) {
          var itemSettings =
            (res && res.subscriptionsSetting && res.subscriptionsSetting.itemSettings) || {};
          var state = itemSettings[templateId];
          var alwaysAccept =
            state === 'accept' || state === 'acceptWithAudio' || state === 'acceptWithAlert';
          if (!alwaysAccept) {
            return;
          }
          wx.requestSubscribeMessage({
            tmplIds: [templateId],
            success: function () {},
            fail: function () {}
          });
        },
        fail: function () {}
      });
    } catch (err) {
      console.warn('[app] 补充订阅额度失败', err);
    }
  },

  /**
   * 登录并缓存身份。任何失败都只记录日志，把当前访问者当作访客放行。
   * @returns {Promise<{openid: string, role: string, hasTemplate: boolean, templateId: string, orderConfirmTemplateId: string}>}
   */
  signIn: function () {
    var app = this;
    return api.login().then(
      function onSuccess(result) {
        var data = result || {};
        app.globalData.openid = data.openid || '';
        app.globalData.role = data.role === 'owner' ? 'owner' : 'guest';
        app.globalData.hasTemplate = !!data.hasTemplate;
        app.globalData.templateId = typeof data.templateId === 'string' ? data.templateId : '';
        app.globalData.orderConfirmTemplateId =
          typeof data.orderConfirmTemplateId === 'string' ? data.orderConfirmTemplateId : '';
        // 冷启动时 onShow 早于这里，role 还是 guest，拿到真实身份后再补一次额度
        app.topUpNoticeQuota();
        return app.globalData;
      },
      function onFailure(err) {
        app.globalData.openid = '';
        app.globalData.role = 'guest';
        app.globalData.hasTemplate = false;
        app.globalData.templateId = '';
        app.globalData.orderConfirmTemplateId = '';
        console.error('[app] 登录失败，按访客放行', err);
        return app.globalData;
      }
    );
  },

  isOwner: function () {
    return this.globalData.role === 'owner';
  }
});
