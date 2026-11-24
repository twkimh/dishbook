/**
 * login —— SPEC §4：所有人可用，返回 { openid, role, hasTemplate, templateId, orderConfirmTemplateId }。
 *
 * templateId / orderConfirmTemplateId 用于客户端 wx.requestSubscribeMessage 的 tmplIds（拿不到模板 ID 就弹不出授权窗），
 * 模板 ID 不是秘密，可以下发；hasTemplate 保留给既有的兼容判断（语义只看主人家模板）。
 *
 * 主人家自举的唯一入口：meta.ownerOpenids 为空时，第一个调用 login 的人成为主人家。
 * 其它任何 action 都不得调用 bootstrapOwner（见 lib/db.js 的安全说明）。
 */

const { resolveContext, bootstrapOwner, defaultMeta } = require('../lib/db');

module.exports = async function login(ctx) {
  let resolved = await resolveContext(ctx.openid);

  // 纯读取拿到的 meta 里没有主人家 -> 在这里（且只在这里）写库自举
  if (!resolved.meta.ownerOpenids.length) {
    const meta = (await bootstrapOwner(ctx.openid)) || defaultMeta();
    const isOwner = meta.ownerOpenids.indexOf(ctx.openid) !== -1;
    resolved = {
      meta: meta,
      role: isOwner ? 'owner' : 'guest',
      isOwner: isOwner,
    };
  }

  const templateId =
    resolved.meta && typeof resolved.meta.subscribeTemplateId === 'string'
      ? resolved.meta.subscribeTemplateId.trim()
      : '';

  // 模板 B（点菜者收）的模板 ID；存量 meta 没有该字段，防御式按空串处理
  const orderConfirmTemplateId =
    resolved.meta && typeof resolved.meta.orderConfirmTemplateId === 'string'
      ? resolved.meta.orderConfirmTemplateId.trim()
      : '';

  // 五个字段：openid 取云调用上下文，templateId/orderConfirmTemplateId 取 meta（绝不从 payload 读）
  return {
    openid: ctx.openid,
    role: resolved.role,
    hasTemplate: templateId.length > 0,
    templateId: templateId,
    orderConfirmTemplateId: orderConfirmTemplateId,
  };
};
