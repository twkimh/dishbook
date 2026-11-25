/**
 * dishes 相关 action：list / get / create / update / remove / mine / reviewList / review
 * 契约见 SPEC §4 表格，数据模型见 SPEC §3。
 */

const { db, _, dishes, resolveContext, now } = require('../lib/db');
const { unauthorized, notFound, invalid } = require('../lib/response');
const {
  LIMITS,
  pickText,
  pickTextArray,
  pickId,
  pickPaging,
  listResult,
  pickProfile,
} = require('../lib/validate');
const { checkUserText, joinText } = require('../lib/security');
const { attachTempUrls, isCloudFileId } = require('../lib/storage');

/**
 * 读取类接口要转换的图片字段：封面 + 图片数组 + 提交者头像（一层嵌套字段）。
 * 落库仍存 fileID 原文。
 */
const IMAGE_FIELDS = ['cover', 'images', 'submitter.avatar'];

const STATUS = {
  APPROVED: 'approved',
  PENDING: 'pending',
  REJECTED: 'rejected',
};

const SOURCE = {
  OWNER: 'owner',
  GUEST: 'guest',
};

/** 按 id 取菜品；文档不存在时返回 null（不把 SDK 的抛错形态漏给上层）。 */
async function findDish(id) {
  try {
    const res = await dishes().doc(id).get();
    return res && res.data ? res.data : null;
  } catch (err) {
    console.warn('[dish] 读取失败或不存在', id, err && (err.errCode || err.message));
    return null;
  }
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** pending / rejected 的可见性：仅主人家或创建者本人，其他人一律 NOT_FOUND（约束 10）。 */
function canSeeDish(dish, openid, isOwner) {
  if (!dish) return false;
  if (dish.status === STATUS.APPROVED) return true;
  if (isOwner) return true;
  return dish.ownerOpenid === openid;
}

function assertVisible(dish, openid, isOwner) {
  if (!canSeeDish(dish, openid, isOwner)) notFound('菜品不存在或暂不可见');
}

/** 收集并校验用户可填文本（§3 上限 + 约束 8）。 */
function readDishFields(payload) {
  const src = payload || {};
  const name = pickText(src.name, { field: 'name', label: '菜名', required: true, max: LIMITS.NAME_MAX });
  const story = pickText(src.story, { field: 'story', label: '一句话说明', max: LIMITS.STORY_MAX });
  const tags = pickTextArray(src.tags, {
    field: 'tags',
    label: '标签',
    maxCount: LIMITS.TAG_MAX_COUNT,
    maxItemLen: LIMITS.TAG_MAX_LEN,
  });
  const images = pickTextArray(src.images, {
    field: 'images',
    label: '图片',
    maxCount: LIMITS.IMAGES_MAX,
  });
  const cover = pickText(src.cover, { field: 'cover', label: '封面', max: LIMITS.AVATAR_MAX });
  return { name: name, story: story, tags: tags, images: images, cover: cover };
}

async function list(ctx) {
  const payload = ctx.payload || {};
  const paging = pickPaging(payload);
  const keyword = pickText(payload.keyword, { field: 'keyword', label: '搜索词', max: LIMITS.KEYWORD_MAX });
  const tag = pickText(payload.tag, { field: 'tag', label: '标签', max: LIMITS.TAG_MAX_LEN });

  const parts = [];
  if (keyword) {
    const reg = db.RegExp({ regexp: escapeRegExp(keyword), options: 'i' });
    parts.push(_.or([{ name: reg }, { story: reg }, { tags: reg }]));
  }
  if (tag) parts.push({ tags: tag });

  const where = parts.length ? _.and([{ status: STATUS.APPROVED }].concat(parts)) : { status: STATUS.APPROVED };

  const countRes = await dishes().where(where).count();
  const total = countRes && typeof countRes.total === 'number' ? countRes.total : 0;
  const listRes = await dishes()
    .where(where)
    .orderBy('createdAt', 'desc')
    .skip(paging.skip)
    .limit(paging.pageSize)
    .get();

  // 先拿原始 data、转成临时链接，再交给分页组装
  const list = await attachTempUrls(listRes && listRes.data, { fields: IMAGE_FIELDS });
  return listResult(list, total, paging);
}

async function get(ctx) {
  const id = pickId(ctx.payload && ctx.payload.id, '菜品 id');
  const dish = await findDish(id);
  if (!dish) notFound('菜品不存在或已被删除');

  const resolved = await resolveContext(ctx.openid);
  assertVisible(dish, ctx.openid, resolved.isOwner);
  // 单对象进出：返回结构仍是 Dish，不包数组
  return attachTempUrls(dish, { fields: IMAGE_FIELDS });
}

async function create(ctx) {
  const payload = ctx.payload || {};
  const fields = readDishFields(payload);
  const resolved = await resolveContext(ctx.openid);
  const profile = pickProfile(payload);
  // avatar 只接受云存储 fileID，其它值（外链等）一律落空串，防止塞外链
  const avatar = isCloudFileId(profile.avatar) ? profile.avatar : '';

  // 内容安全：命中违规直接 INVALID，不落库
  await checkUserText(ctx.openid, joinText(fields.name, fields.story, fields.tags));

  const ts = now();
  const isOwner = resolved.isOwner;
  const doc = {
    name: fields.name,
    cover: fields.cover || '',
    images: fields.images,
    story: fields.story || '',
    tags: fields.tags,
    status: isOwner ? STATUS.APPROVED : STATUS.PENDING,
    source: isOwner ? SOURCE.OWNER : SOURCE.GUEST,
    ownerOpenid: ctx.openid,
    submitter: {
      openid: ctx.openid,
      nickname: profile.nickname,
      avatar: avatar,
    },
    cookedCount: 0,
    createdAt: ts,
    updatedAt: ts,
    reviewedAt: isOwner ? ts : null,
  };

  const res = await dishes().add({ data: doc });
  return { id: res && res._id ? res._id : '', status: doc.status };
}

async function update(ctx) {
  const payload = ctx.payload || {};
  const id = pickId(payload.id, '菜品 id');
  const dish = await findDish(id);
  if (!dish) notFound('菜品不存在或已被删除');
  if (dish.ownerOpenid !== ctx.openid) unauthorized('只有菜品创建者可以修改');
  const resolved = await resolveContext(ctx.openid);

  const fields = readDishFields(payload);
  const profile = pickProfile(payload);
  await checkUserText(ctx.openid, joinText(fields.name, fields.story, fields.tags));

  const patch = {
    name: fields.name,
    cover: fields.cover || '',
    images: fields.images,
    story: fields.story || '',
    tags: fields.tags,
    updatedAt: now(),
  };

  // 头像快照：只有 payload 显式带了 avatar 才更新 submitter.avatar，
  // 未传时保持库里原值（避免一次编辑把已有头像清空）。
  if (payload.avatar !== undefined && payload.avatar !== null) {
    const current = dish.submitter;
    const baseSubmitter =
      current && typeof current === 'object' && !Array.isArray(current) ? current : {};
    patch.submitter = Object.assign(
      { openid: dish.ownerOpenid || ctx.openid, nickname: '' },
      baseSubmitter,
      { avatar: isCloudFileId(profile.avatar) ? profile.avatar : '' }
    );
  }

  // 访客改的菜若已上架，必须退回待审核，否则可绕过主人家审核改出任意内容；
  // 主人家自己编辑任何菜品都保持原状态不变。
  let nextStatus = dish.status;
  if (!resolved.isOwner && dish.status === STATUS.APPROVED && dish.source === SOURCE.GUEST) {
    nextStatus = STATUS.PENDING;
    patch.status = STATUS.PENDING;
    patch.reviewedAt = null;
  }

  await dishes().doc(id).update({ data: patch });
  return { id: id, status: nextStatus };
}

async function remove(ctx) {
  const id = pickId(ctx.payload && ctx.payload.id, '菜品 id');
  const dish = await findDish(id);
  if (!dish) notFound('菜品不存在或已被删除');
  if (dish.ownerOpenid !== ctx.openid) unauthorized('只有菜品创建者可以删除');

  await dishes().doc(id).remove();
  return {};
}

async function mine(ctx) {
  const paging = pickPaging(ctx.payload);
  const where = { ownerOpenid: ctx.openid };

  const countRes = await dishes().where(where).count();
  const total = countRes && typeof countRes.total === 'number' ? countRes.total : 0;
  const listRes = await dishes()
    .where(where)
    .orderBy('createdAt', 'desc')
    .skip(paging.skip)
    .limit(paging.pageSize)
    .get();

  const list = await attachTempUrls(listRes && listRes.data, { fields: IMAGE_FIELDS });
  return listResult(list, total, paging);
}

async function reviewList(ctx) {
  const resolved = await resolveContext(ctx.openid);
  if (!resolved.isOwner) unauthorized('只有主人家可以查看待审核列表');

  const paging = pickPaging(ctx.payload);
  const where = { status: STATUS.PENDING };

  const countRes = await dishes().where(where).count();
  const total = countRes && typeof countRes.total === 'number' ? countRes.total : 0;
  const listRes = await dishes()
    .where(where)
    .orderBy('createdAt', 'desc')
    .skip(paging.skip)
    .limit(paging.pageSize)
    .get();

  const list = await attachTempUrls(listRes && listRes.data, { fields: IMAGE_FIELDS });
  return listResult(list, total, paging);
}

async function review(ctx) {
  const resolved = await resolveContext(ctx.openid);
  if (!resolved.isOwner) unauthorized('只有主人家可以审核菜品');

  const payload = ctx.payload || {};
  const id = pickId(payload.id, '菜品 id');
  if (typeof payload.accept !== 'boolean') invalid('accept 必须是布尔值');

  const dish = await findDish(id);
  if (!dish) notFound('菜品不存在或已被删除');
  if (dish.status !== STATUS.PENDING) invalid('只有待审核的菜品可以审核');

  const status = payload.accept ? STATUS.APPROVED : STATUS.REJECTED;
  const ts = now();
  await dishes().doc(id).update({
    data: { status: status, reviewedAt: ts, updatedAt: ts },
  });
  return { status: status };
}

module.exports = {
  list: list,
  get: get,
  create: create,
  update: update,
  remove: remove,
  mine: mine,
  reviewList: reviewList,
  review: review,
  STATUS: STATUS,
  SOURCE: SOURCE,
  findDish: findDish,
  canSeeDish: canSeeDish,
};
