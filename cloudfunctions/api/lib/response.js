/**
 * 统一返回信封 + 业务异常类型。
 * 信封严格按 SPEC §4：
 *   { ok: true, data }
 *   { ok: false, code: 'UNAUTHORIZED'|'NOT_FOUND'|'INVALID'|'INTERNAL', message }
 */

const CODES = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  NOT_FOUND: 'NOT_FOUND',
  INVALID: 'INVALID',
  INTERNAL: 'INTERNAL',
};

/**
 * 业务异常：只允许四种 code，message 一定是可直接展示的中文。
 * 用 __apiError 标记，供 index.js 的兜底 catch 区分「预期内的业务异常」与「意外崩溃」。
 */
class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApiError';
    this.code = CODES[code] ? code : CODES.INTERNAL;
    this.__apiError = true;
  }
}

function ok(data) {
  return { ok: true, data: data === undefined ? null : data };
}

function fail(code, message) {
  return {
    ok: false,
    code: CODES[code] ? code : CODES.INTERNAL,
    message: message || '服务器开小差了，请稍后再试',
  };
}

function unauthorized(message) {
  throw new ApiError(CODES.UNAUTHORIZED, message || '没有权限执行该操作');
}

function notFound(message) {
  throw new ApiError(CODES.NOT_FOUND, message || '记录不存在或已被删除');
}

function invalid(message) {
  throw new ApiError(CODES.INVALID, message || '参数不合法');
}

module.exports = {
  CODES,
  ApiError,
  ok,
  fail,
  unauthorized,
  notFound,
  invalid,
};
