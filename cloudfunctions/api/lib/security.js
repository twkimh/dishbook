/**
 * 内容安全（SPEC §4「内容安全」/ 约束 5）。
 *
 * 命中违规 -> 抛 INVALID，调用方因此不会落库；
 * 接口报错（网络/额度/未开通/版本不支持）-> console.warn 后放行，
 * 绝不因为安全接口抖动阻断正常用户。
 */

const { cloud } = require('./db');
const { invalid } = require('./response');
const { LIMITS } = require('./validate');

const PASS_SUGGEST = 'pass';

/**
 * @param {string} openid 调用者 openid（来自 getWXContext，不接受客户端传入）
 * @param {string} text   拼接后的待检文本
 * @returns {Promise<{checked:boolean, degraded:boolean}>}
 */
async function checkUserText(openid, text) {
  const content = String(text === undefined || text === null ? '' : text).trim();
  if (!content) return { checked: false, degraded: false };

  const payload = {
    version: 2,
    scene: 2,
    openid: openid,
    content: Array.from(content).slice(0, LIMITS.SECURITY_CONTENT_MAX).join(''),
  };

  let res = null;
  try {
    res = await cloud.openapi.security.msgSecCheck(payload);
  } catch (err) {
    // 降级放行：网络异常 / 未开通 / 额度超限 / 基础库不支持的统一出口
    console.warn(
      '[security] msgSecCheck 调用失败，已放行',
      err && (err.errCode !== undefined ? err.errCode : err.code),
      err && (err.errMsg || err.errMessage || err.message)
    );
    return { checked: false, degraded: true };
  }

  // 接口返回了错误码而不是抛异常，同样按降级处理
  if (res && typeof res.errCode === 'number' && res.errCode !== 0) {
    console.warn('[security] msgSecCheck 返回非 0 错误码，已放行', res.errCode, res.errMsg);
    return { checked: false, degraded: true };
  }

  const result = res && res.result ? res.result : null;
  const suggest = result && typeof result.suggest === 'string' ? result.suggest : '';
  const label = result && typeof result.label === 'number' ? result.label : 0;

  // 违规判定放在 try 之外，抛出的 INVALID 不会被上面的降级 catch 吞掉
  if (suggest && suggest !== PASS_SUGGEST) {
    console.warn('[security] msgSecCheck 命中违规', suggest, label);
    invalid('内容包含违规信息，请修改后再提交');
  }
  if (!suggest && label !== 0 && label !== 100) {
    console.warn('[security] msgSecCheck 命中违规标签', label);
    invalid('内容包含违规信息，请修改后再提交');
  }

  return { checked: true, degraded: false };
}

/** 把多段用户可填文本拼成一段待检文本（菜名 / 说明 / 标签 / 想吃的话）。 */
function joinText() {
  const parts = [];
  for (let i = 0; i < arguments.length; i += 1) {
    const item = arguments[i];
    if (item === undefined || item === null) continue;
    if (Array.isArray(item)) {
      for (let j = 0; j < item.length; j += 1) {
        if (item[j]) parts.push(String(item[j]).trim());
      }
      continue;
    }
    const text = String(item).trim();
    if (text) parts.push(text);
  }
  return parts.filter(Boolean).join('\n');
}

module.exports = {
  checkUserText: checkUserText,
  joinText: joinText,
};
