/**
 * dishes 相关 action：
 *   list / get / create / update / remove / mine / reviewList / review（v1.0.7 存量）
 *   edit / editList / editReview / editHistory / like / unlike / want / unwant（SPEC-v1.0.8 §2.1）
 *   orderers（SPEC-v1.0.8 §4.3）
 * 契约见 SPEC.md §4 + SPEC-v1.0.8 §2/§3/§4，数据模型见 SPEC.md §3 + SPEC-v1.0.8 §1。
 */

const { db, _, dishes, dishEdits, orders, resolveContext, now } = require('../lib/db');
const { unauthorized, notFound, invalid } = require('../lib/response');
const {
  LIMITS,
  pickText,
  pickTextArray,
  pickTextArraySafe,
  pickMethods,
  pickId,
  pickPaging,
  listResult,
  pickProfile,
} = require('../lib/validate');
const { checkUserText, joinText } = require('../lib/security');
const { attachTempUrls, isCloudFileId } = require('../lib/storage');

/**
 * 读取类接口要转换的图片字段：封面 + 图片数组 + 提交者头像（一层嵌套字段）
 * + 喜欢的人 / 想吃的人 / 参与修改的人的头像（对象数组的元素字段，v1.0.8）。
 * 落库仍存 fileID 原文。
 */
const IMAGE_FIELDS = [
  'cover',
  'images',
  'submitter.avatar',
  'likes.avatar',
  'wants.avatar',
  'contributors.avatar',
];

/** 菜品可编辑字段（SPEC-v1.0.8 §1.2 的 snapshot 全量）。 */
const EDITABLE_FIELDS = [
  'name',
  'cover',
  'images',
  'story',
  'ingredients',
  'seasonings',
  'methods',
  'tags',
];

/** wants 上限（SPEC-v1.0.8 §1.1：≤200 条，按 openid 去重）。 */
const WANTS_MAX = 200;

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
  // v1.0.8：材料 / 调料 / 烹饪方式。三者都是可选修饰字段，一律宽松清洗、绝不抛错。
  const ingredients = pickTextArraySafe(src.ingredients, {
    maxCount: LIMITS.INGREDIENT_MAX_COUNT,
    maxItemLen: LIMITS.INGREDIENT_MAX_LEN,
  });
  const seasonings = pickTextArraySafe(src.seasonings, {
    maxCount: LIMITS.SEASONING_MAX_COUNT,
    maxItemLen: LIMITS.SEASONING_MAX_LEN,
  });
  const methods = pickMethods(src.methods);
  return {
    name: name,
    story: story,
    tags: tags,
    images: images,
    cover: cover,
    ingredients: ingredients,
    seasonings: seasonings,
    methods: methods,
  };
}

/** 昵称兜底：界面只显示头像、点击才看昵称，所以快照里的 nickname 必须有值（SPEC-v1.0.8 §3.7）。 */
const NICKNAME_FALLBACK = '朋友';

/** 人像快照：{ openid, nickname, avatar, at }，avatar 只认云存储 fileID，落库存原文。 */
function personSnapshot(openid, profile, ts) {
  const nickname = profile && profile.nickname ? profile.nickname : NICKNAME_FALLBACK;
  const avatar = profile && isCloudFileId(profile.avatar) ? profile.avatar : '';
  return { openid: openid, nickname: nickname, avatar: avatar, at: ts };
}

/** 人像数组防读：非数组 -> []，混入非对象/字段类型不对的项跳过，绝不抛错。 */
function normalizePeople(value, keepAt) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (let i = 0; i < value.length; i += 1) {
    const row = value[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const person = {
      openid: typeof row.openid === 'string' ? row.openid : '',
      nickname: typeof row.nickname === 'string' ? row.nickname : '',
      avatar: typeof row.avatar === 'string' ? row.avatar : '',
    };
    if (keepAt && typeof row.at === 'number' && Number.isFinite(row.at)) person.at = row.at;
    out.push(person);
  }
  return out;
}

/**
 * 读取接口出参补齐 v1.0.8 字段（只新增键，不改既有键）：
 * likeCount / likes / wants / contributors / ingredients / seasonings / methods。
 */
function shapeDish(dish) {
  if (!dish || typeof dish !== 'object') return dish;
  const out = Object.assign({}, dish);
  const likes = normalizePeople(dish.likes, true);
  out.likes = likes;
  out.likeCount = likes.length;
  out.wants = normalizePeople(dish.wants, true);
  out.contributors = normalizePeople(dish.contributors, false);
  out.ingredients = Array.isArray(dish.ingredients) ? dish.ingredients : [];
  out.seasonings = Array.isArray(dish.seasonings) ? dish.seasonings : [];
  out.methods = Array.isArray(dish.methods) ? dish.methods : [];
  return out;
}

/** 先换临时链接，再补齐新字段；数组进数组出、单对象进单对象出。 */
async function withReadFields(items) {
  const attached = await attachTempUrls(items, { fields: IMAGE_FIELDS });
  if (Array.isArray(attached)) {
    const output = [];
    for (let i = 0; i < attached.length; i += 1) output.push(shapeDish(attached[i]));
    return output;
  }
  return shapeDish(attached);
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

  // 先拿原始 data、转成临时链接并补齐 v1.0.8 字段，再交给分页组装
  const list = await withReadFields(listRes && listRes.data);
  return listResult(list, total, paging);
}

async function get(ctx) {
  const id = pickId(ctx.payload && ctx.payload.id, '菜品 id');
  const dish = await findDish(id);
  if (!dish) notFound('菜品不存在或已被删除');

  const resolved = await resolveContext(ctx.openid);
  assertVisible(dish, ctx.openid, resolved.isOwner);
  // 单对象进出：返回结构仍是 Dish，不包数组
  return withReadFields(dish);
}

async function create(ctx) {
  const payload = ctx.payload || {};
  const fields = readDishFields(payload);
  const resolved = await resolveContext(ctx.openid);
  const profile = pickProfile(payload);
  // avatar 只接受云存储 fileID，其它值（外链等）一律落空串，防止塞外链
  const avatar = isCloudFileId(profile.avatar) ? profile.avatar : '';

  // 内容安全：命中违规直接 INVALID，不落库
  await checkUserText(
    ctx.openid,
    joinText(fields.name, fields.story, fields.tags, fields.ingredients, fields.seasonings)
  );

  const ts = now();
  const isOwner = resolved.isOwner;
  const doc = {
    name: fields.name,
    cover: fields.cover || '',
    images: fields.images,
    story: fields.story || '',
    tags: fields.tags,
    // v1.0.8 新增字段：材料 / 调料 / 烹饪方式 + 三个反应数组
    ingredients: fields.ingredients,
    seasonings: fields.seasonings,
    methods: fields.methods,
    likes: [],
    wants: [],
    contributors: [],
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
  await checkUserText(
    ctx.openid,
    joinText(fields.name, fields.story, fields.tags, fields.ingredients, fields.seasonings)
  );

  const patch = {
    name: fields.name,
    cover: fields.cover || '',
    images: fields.images,
    story: fields.story || '',
    tags: fields.tags,
    ingredients: fields.ingredients,
    seasonings: fields.seasonings,
    methods: fields.methods,
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

  const list = await withReadFields(listRes && listRes.data);
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

  const list = await withReadFields(listRes && listRes.data);
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

/* ---------------------------------------------------------------- v1.0.8 新增 */

/** 修改提案集合里要转临时链接的图片字段（snapshot 内嵌 + 提案人头像）。 */
const EDIT_IMAGE_FIELDS = ['snapshot.cover', 'snapshot.images', 'submitter.avatar'];

/** 按 id 取修改提案；不存在返回 null。 */
async function findEditProposal(id) {
  try {
    const res = await dishEdits().doc(id).get();
    return res && res.data ? res.data : null;
  } catch (err) {
    console.warn('[dish] 读取修改提案失败或不存在', id, err && (err.errCode || err.message));
    return null;
  }
}

/** 可编辑字段快照（SPEC-v1.0.8 §1.2 的 snapshot 全量八项）。 */
function buildSnapshot(fields) {
  return {
    name: fields.name,
    cover: fields.cover || '',
    images: fields.images,
    story: fields.story || '',
    ingredients: fields.ingredients,
    seasonings: fields.seasonings,
    methods: fields.methods,
    tags: fields.tags,
  };
}

/**
 * dish.edit —— 所有人可改，但落点不同（SPEC-v1.0.8 §3.1）：
 *  - 主人家：直接写 dishes 的可编辑字段，返回 { id: dishId, status: 'approved' }
 *  - 其他人（包括原提交者）：写 dishEdits 一条 pending 提案，不动 dishes，返回 { id: 提案 id, status: 'pending' }
 * 已存在 pending 提案时**不拒绝**再次提交，允许同一人多条，审核时逐条处理。
 */
async function edit(ctx) {
  const payload = ctx.payload || {};
  const id = pickId(payload.id, '菜品 id');
  const dish = await findDish(id);
  if (!dish) notFound('菜品不存在或已被删除');

  const resolved = await resolveContext(ctx.openid);
  // 看不见的菜（别人的 pending / rejected）不能提修改，沿用既有可见性规则
  assertVisible(dish, ctx.openid, resolved.isOwner);

  const fields = readDishFields(payload);
  // 内容安全照旧：命中违规直接 INVALID，不落库
  await checkUserText(
    ctx.openid,
    joinText(fields.name, fields.story, fields.tags, fields.ingredients, fields.seasonings)
  );

  const snapshot = buildSnapshot(fields);
  const ts = now();

  if (resolved.isOwner) {
    const patch = Object.assign({}, snapshot, { updatedAt: ts });
    await dishes().doc(id).update({ data: patch });
    return { id: id, status: STATUS.APPROVED };
  }

  const profile = pickProfile(payload);
  const person = personSnapshot(ctx.openid, profile, ts);
  delete person.at;
  const proposal = {
    dishId: id,
    dishName: typeof dish.name === 'string' ? dish.name : '',
    snapshot: snapshot,
    submitter: person,
    status: STATUS.PENDING,
    createdAt: ts,
    reviewedAt: null,
  };
  const res = await dishEdits().add({ data: proposal });
  return { id: res && res._id ? res._id : '', status: STATUS.PENDING };
}

/** dish.editList —— 主人家看待审提案列表。 */
async function editList(ctx) {
  const resolved = await resolveContext(ctx.openid);
  if (!resolved.isOwner) unauthorized('只有主人家可以查看待审核的修改');

  const paging = pickPaging(ctx.payload);
  const where = { status: STATUS.PENDING };

  const countRes = await dishEdits().where(where).count();
  const total = countRes && typeof countRes.total === 'number' ? countRes.total : 0;
  const listRes = await dishEdits()
    .where(where)
    .orderBy('createdAt', 'desc')
    .skip(paging.skip)
    .limit(paging.pageSize)
    .get();

  const list = await attachTempUrls(listRes && listRes.data, { fields: EDIT_IMAGE_FIELDS });
  return listResult(list, total, paging);
}

/**
 * dish.editReview —— 主人家审核一条修改提案。
 * 通过：snapshot 覆盖 dishes 可编辑字段 + 提案人并入 contributors + 提案 approved。
 * 驳回：只改提案，不动 dishes。
 * 已 approved / rejected 的提案再次审核 -> INVALID。
 */
async function editReview(ctx) {
  const resolved = await resolveContext(ctx.openid);
  if (!resolved.isOwner) unauthorized('只有主人家可以审核修改');

  const payload = ctx.payload || {};
  const id = pickId(payload.id, '修改提案 id');
  if (typeof payload.accept !== 'boolean') invalid('accept 必须是布尔值');

  const proposal = await findEditProposal(id);
  if (!proposal) notFound('修改提案不存在或已被删除');
  if (proposal.status !== STATUS.PENDING) invalid('这条修改已经处理过了');

  const ts = now();

  if (!payload.accept) {
    await dishEdits().doc(id).update({ data: { status: STATUS.REJECTED, reviewedAt: ts } });
    return { status: STATUS.REJECTED };
  }

  const dishId = typeof proposal.dishId === 'string' ? proposal.dishId : '';
  const dish = dishId ? await findDish(dishId) : null;
  // 菜已经被删了：没有可合并的对象。直接置为驳回，否则这条提案会永久挂在待审列表里，
  // 主人家点进去又合并不了，形成死循环。
  if (!dish) {
    await dishEdits().doc(id).update({ data: { status: STATUS.REJECTED, reviewedAt: ts } });
    return { status: STATUS.REJECTED };
  }

  // 1) snapshot 覆盖可编辑字段；status / source / ownerOpenid / submitter / createdAt 一律不动
  const snapshot =
    proposal.snapshot && typeof proposal.snapshot === 'object' && !Array.isArray(proposal.snapshot)
      ? proposal.snapshot
      : {};
  const patch = { updatedAt: ts };
  for (let i = 0; i < EDITABLE_FIELDS.length; i += 1) {
    const key = EDITABLE_FIELDS[i];
    if (snapshot[key] !== undefined) patch[key] = snapshot[key];
  }

  // 2) 提案人并入 contributors（按 openid 去重）。
  // **参与者不含提供者本人**（SPEC-v1.0.8 §1.1）：界面上「提供者」和「参与者」是两个并列展示的角色，
  // 同一个人同时出现在两处会让用户困惑，所以提案人就是 submitter.openid 时直接跳过。
  const proposer =
    proposal.submitter && typeof proposal.submitter === 'object' && !Array.isArray(proposal.submitter)
      ? proposal.submitter
      : {};
  const provider =
    dish.submitter && typeof dish.submitter === 'object' && !Array.isArray(dish.submitter)
      ? dish.submitter
      : {};
  const providerOpenid = typeof provider.openid === 'string' ? provider.openid : '';
  const proposerOpenid = typeof proposer.openid === 'string' ? proposer.openid : '';
  const contributors = normalizePeople(dish.contributors, false);
  let added = false;
  // 提案人 = 提供者本人 -> 不加入 contributors；无 openid 也无法加入
  if (proposerOpenid && proposerOpenid !== providerOpenid) {
    let exists = false;
    for (let i = 0; i < contributors.length; i += 1) {
      if (contributors[i].openid === proposerOpenid) {
        exists = true;
        break;
      }
    }
    if (!exists) {
      contributors.push({
        openid: proposerOpenid,
        nickname:
          typeof proposer.nickname === 'string' && proposer.nickname
            ? proposer.nickname
            : NICKNAME_FALLBACK,
        avatar: isCloudFileId(proposer.avatar) ? proposer.avatar : '',
      });
      added = true;
    }
  }
  if (added) patch.contributors = contributors;

  await dishes().doc(dishId).update({ data: patch });
  await dishEdits().doc(id).update({ data: { status: STATUS.APPROVED, reviewedAt: ts } });
  return { status: STATUS.APPROVED };
}

/** dish.editHistory —— 该菜的全部修改记录（含状态、时间、提交人、snapshot）。 */
async function editHistory(ctx) {
  const payload = ctx.payload || {};
  const dishId = pickId(payload.dishId, '菜品 id');
  const paging = pickPaging(payload);
  const where = { dishId: dishId };

  const countRes = await dishEdits().where(where).count();
  const total = countRes && typeof countRes.total === 'number' ? countRes.total : 0;
  const listRes = await dishEdits()
    .where(where)
    .orderBy('createdAt', 'desc')
    .skip(paging.skip)
    .limit(paging.pageSize)
    .get();

  const list = await attachTempUrls(listRes && listRes.data, { fields: EDIT_IMAGE_FIELDS });
  return listResult(list, total, paging);
}

/**
 * 喜欢 / 想吃 的共同实现（SPEC-v1.0.8 §3.5）：
 *  - 幂等：已存在则忽略，不存在再取消不报错
 *  - ≤200 条（WANTS_MAX），满了之后不再追加，也不报错
 *  - 不受菜单状态影响
 * 返回 { list: 最新完整数组, changed: 是否真的变了 }。
 */
async function togglePeople(field, ctx, add) {
  const payload = ctx.payload || {};
  const id = pickId(payload.id, '菜品 id');
  const dish = await findDish(id);
  if (!dish) notFound('菜品不存在或已被删除');

  const resolved = await resolveContext(ctx.openid);
  // 看不见的菜不能被点喜欢 / 想吃（与 order.create 的可见性规则一致）
  if (!canSeeDish(dish, ctx.openid, resolved.isOwner)) notFound('菜品不存在或暂不可见');

  const current = normalizePeople(dish[field], true);
  let exists = false;
  for (let i = 0; i < current.length; i += 1) {
    if (current[i].openid === ctx.openid) {
      exists = true;
      break;
    }
  }

  let next = current;
  if (add) {
    if (!exists && current.length < WANTS_MAX) {
      const profile = pickProfile(payload);
      next = current.slice();
      next.push(personSnapshot(ctx.openid, profile, now()));
    }
  } else if (exists) {
    next = [];
    for (let i = 0; i < current.length; i += 1) {
      if (current[i].openid !== ctx.openid) next.push(current[i]);
    }
  }

  if (next !== current) {
    const patch = {};
    patch[field] = next;
    try {
      await dishes().doc(id).update({ data: patch });
    } catch (err) {
      // 反应写失败不影响本次返回：仅告警，不把写库异常抛给客户端
      console.warn('[dish] 反应写入失败', field, id, err && (err.errCode || err.message));
    }
  }

  return { list: next, changed: next !== current };
}

/** 出参前把人像数组的元素头像换成临时链接（对象数组元素字段）。 */
async function withAvatarUrls(rows) {
  const attached = await attachTempUrls({ rows: rows }, { fields: ['rows.avatar'] });
  return normalizePeople(attached && attached.rows, true);
}

/** dish.like -> { liked, likeCount, likes }（likes 是完整数组）。 */
async function like(ctx) {
  const result = await togglePeople('likes', ctx, true);
  const likes = await withAvatarUrls(result.list);
  return { liked: true, likeCount: likes.length, likes: likes };
}

async function unlike(ctx) {
  const result = await togglePeople('likes', ctx, false);
  const likes = await withAvatarUrls(result.list);
  return { liked: false, likeCount: likes.length, likes: likes };
}

/** dish.want / dish.unwant -> { wants }（数组）。 */
async function want(ctx) {
  const result = await togglePeople('wants', ctx, true);
  const wants = await withAvatarUrls(result.list);
  return { wants: wants };
}

async function unwant(ctx) {
  const result = await togglePeople('wants', ctx, false);
  const wants = await withAvatarUrls(result.list);
  return { wants: wants };
}

/* ------------------------------------------ v1.0.8 §4.3：点过这道菜的人 */

/** 最多返回 50 人；一次查询 100 条、最多 5 页。 */
const ORDERERS_MAX = 50;
const ORDERERS_FETCH_PAGE = 100;
const ORDERERS_FETCH_MAX_PAGES = 5;

/** 已取消的点菜记录不算「点过」（本地常量，避免 require order.js 形成环）。 */
const ORDER_CANCELLED = 'cancelled';

/** 按 dishId 拉订单（分页，最多 500 条；读失败降级为空）。 */
async function fetchOrdersByDish(dishId) {
  const out = [];
  for (let page = 0; page < ORDERERS_FETCH_MAX_PAGES; page += 1) {
    let batch = [];
    try {
      const res = await orders()
        .where({ dishId: dishId })
        .orderBy('createdAt', 'desc')
        .skip(page * ORDERERS_FETCH_PAGE)
        .limit(ORDERERS_FETCH_PAGE)
        .get();
      batch = res && Array.isArray(res.data) ? res.data : [];
    } catch (err) {
      console.warn('[dish] 读取点菜记录失败', dishId, err && (err.errCode || err.message));
      break;
    }
    for (let i = 0; i < batch.length; i += 1) out.push(batch[i]);
    if (batch.length < ORDERERS_FETCH_PAGE) break;
  }
  return out;
}

/**
 * dish.orderers —— 点过这道菜的人（SPEC-v1.0.8 §4.3）。
 * 按 openid 聚合 times（点过几次）/ lastAt（最近一次），按 lastAt 倒序，最多 50 人。
 * 昵称/头像取该人最近一次下单的快照；昵称为空兜底「朋友」；头像走临时链接。
 */
async function orderers(ctx) {
  const id = pickId(ctx.payload && ctx.payload.id, '菜品 id');

  const rows = await fetchOrdersByDish(id);
  const map = {};
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || typeof row !== 'object') continue;
    // 已取消的订单不算点过
    if (row.status === ORDER_CANCELLED) continue;

    const orderer =
      row.orderer && typeof row.orderer === 'object' && !Array.isArray(row.orderer)
        ? row.orderer
        : {};
    const openid = typeof orderer.openid === 'string' ? orderer.openid : '';
    if (!openid) continue;

    const at = typeof row.createdAt === 'number' && Number.isFinite(row.createdAt) ? row.createdAt : 0;
    let person = map[openid];
    if (!person) {
      person = { openid: openid, nickname: '', avatar: '', times: 0, lastAt: 0 };
      map[openid] = person;
    }
    person.times += 1;
    // 用最近一次的快照覆盖昵称/头像
    if (at >= person.lastAt) {
      person.lastAt = at;
      person.nickname = typeof orderer.nickname === 'string' ? orderer.nickname : '';
      person.avatar = typeof orderer.avatar === 'string' ? orderer.avatar : '';
    }
  }

  const people = [];
  const openids = Object.keys(map);
  for (let i = 0; i < openids.length; i += 1) people.push(map[openids[i]]);
  people.sort(function (a, b) {
    return b.lastAt - a.lastAt;
  });

  const top = people.slice(0, ORDERERS_MAX);
  const attached = await attachTempUrls(top, { fields: ['avatar'] });
  const list = Array.isArray(attached) ? attached : top;

  const output = [];
  for (let i = 0; i < list.length; i += 1) {
    const person = list[i];
    output.push({
      openid: person.openid,
      nickname: person.nickname ? person.nickname : NICKNAME_FALLBACK,
      avatar: person.avatar ? person.avatar : '',
      times: person.times,
      lastAt: person.lastAt,
    });
  }
  return { people: output };
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
  edit: edit,
  editList: editList,
  editReview: editReview,
  editHistory: editHistory,
  like: like,
  unlike: unlike,
  want: want,
  unwant: unwant,
  orderers: orderers,
  STATUS: STATUS,
  SOURCE: SOURCE,
  findDish: findDish,
  canSeeDish: canSeeDish,
  normalizePeople: normalizePeople,
  shapeDish: shapeDish,
};
