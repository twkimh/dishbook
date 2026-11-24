/**
 * 入参清洗与长度校验（SPEC §3 表格的字数/数量上限，约束 8）。
 * 字数一律按 Unicode 码点数（Array.from），中文按 1 字计。
 */

const { invalid } = require('./response');

/** 各字段上限，唯一来源，路由层不得再写死数字。 */
const LIMITS = {
  NAME_MAX: 30,
  STORY_MAX: 200,
  TAG_MAX_COUNT: 5,
  TAG_MAX_LEN: 8,
  IMAGES_MAX: 8,
  NOTE_MAX: 100,
  NICKNAME_MAX: 20,
  AVATAR_MAX: 512,
  KEYWORD_MAX: 50,
  ID_MAX: 128,
  SECURITY_CONTENT_MAX: 2500,
};

function charLength(value) {
  return Array.from(String(value)).length;
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

/** 单行字符串：去首尾空白，超长即报错并给出具体中文提示。 */
function pickText(value, options) {
  const opt = options || {};
  const label = opt.label || opt.field;
  if (isBlank(value)) {
    if (opt.required) invalid(label + '不能为空');
    return '';
  }
  const text = String(value).trim();
  if (opt.max && charLength(text) > opt.max) {
    invalid(label + '最多 ' + opt.max + ' 字，当前 ' + charLength(text) + ' 字');
  }
  return text;
}

/** 字符串数组：逐项清洗、去掉空项，并校验数量与单项长度。 */
function pickTextArray(value, options) {
  const opt = options || {};
  const label = opt.label || opt.field;
  if (isBlank(value) || (Array.isArray(value) && value.length === 0)) return [];
  if (!Array.isArray(value)) invalid(label + '格式不正确，应为字符串数组');

  const cleaned = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (item === undefined || item === null) continue;
    if (typeof item !== 'string' && typeof item !== 'number') {
      invalid(label + '第 ' + (i + 1) + ' 项格式不正确');
    }
    const text = String(item).trim();
    if (!text) continue;
    if (opt.maxItemLen && charLength(text) > opt.maxItemLen) {
      invalid(
        label + '第 ' + (i + 1) + ' 项最多 ' + opt.maxItemLen + ' 字，当前 ' + charLength(text) + ' 字'
      );
    }
    cleaned.push(text);
  }

  if (opt.maxCount && cleaned.length > opt.maxCount) {
    invalid(label + '最多 ' + opt.maxCount + ' 个，当前 ' + cleaned.length + ' 个');
  }
  return cleaned;
}

/** 文档 id / 业务 id：必填字符串。 */
function pickId(value, label) {
  const name = label || 'id';
  if (typeof value !== 'string' || !value.trim()) invalid('缺少' + name + '参数');
  const id = value.trim();
  if (charLength(id) > LIMITS.ID_MAX) invalid(name + ' 参数过长');
  return id;
}

/** 分页：page 从 1 开始，pageSize 默认 20、上限 50，越界修正而不是报错（约束 7）。 */
function pickPaging(payload) {
  const src = payload && typeof payload === 'object' ? payload : {};
  const DEFAULT_SIZE = 20;
  const MAX_SIZE = 50;

  let page = Number(src.page);
  if (!Number.isFinite(page) || page < 1) page = 1;
  page = Math.floor(page);

  let pageSize = Number(src.pageSize);
  if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = DEFAULT_SIZE;
  pageSize = Math.floor(pageSize);
  if (pageSize > MAX_SIZE) pageSize = MAX_SIZE;

  return {
    page: page,
    pageSize: pageSize,
    skip: (page - 1) * pageSize,
  };
}

/** 列表信封（约束 7）：{ list, total, hasMore } */
function listResult(list, total, paging) {
  const items = Array.isArray(list) ? list : [];
  return {
    list: items,
    total: typeof total === 'number' ? total : items.length,
    hasMore: paging.page * paging.pageSize < (typeof total === 'number' ? total : items.length),
  };
}

/**
 * 昵称/头像：SPEC §3 的 submitter / orderer 都带 nickname、avatar，
 * 但 §4 的 payload 里没有对应字段（见交付说明的 SPEC 矛盾条目）。
 * 这里按「可选入参」接收，缺失时退化为空串，绝不因此阻断主流程。
 */
function pickProfile(payload) {
  const src = payload && typeof payload === 'object' ? payload : {};
  let nickname = '';
  let avatar = '';
  if (!isBlank(src.nickname)) {
    nickname = String(src.nickname).trim();
    if (charLength(nickname) > LIMITS.NICKNAME_MAX) {
      nickname = Array.from(nickname).slice(0, LIMITS.NICKNAME_MAX).join('');
    }
  }
  if (!isBlank(src.avatar)) {
    avatar = String(src.avatar).trim();
    if (charLength(avatar) > LIMITS.AVATAR_MAX) avatar = '';
  }
  return { nickname: nickname, avatar: avatar };
}

module.exports = {
  LIMITS,
  charLength,
  isBlank,
  pickText,
  pickTextArray,
  pickId,
  pickPaging,
  listResult,
  pickProfile,
};
