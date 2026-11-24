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
