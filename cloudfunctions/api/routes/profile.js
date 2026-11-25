/**
 * users 相关 action：profile.get / profile.save。
 *
 * 集合 users：{ _id: <openid>, nickname: string, avatar: string, updatedAt: number }
 *  - _id 直接用 openid，openid 只来自 ctx.openid，绝不从 payload 取；
 *  - 该集合由用户在控制台手动创建（数据库权限 ADMINONLY），代码只做读写；
 *  - 文档不存在不是错误：读出来两个空串即可。
 */

const { users, now } = require('../lib/db');
const { LIMITS, charLength } = require('../lib/validate');
const { isCloudFileId } = require('../lib/storage');

function emptyProfile() {
  return { nickname: '', avatar: '' };
}

/** 昵称：非字符串一律当空串；超长按码点截断，不报错（契约要求）。 */
function pickNickname(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  if (charLength(text) > LIMITS.NICKNAME_MAX) {
    return Array.from(text).slice(0, LIMITS.NICKNAME_MAX).join('');
  }
  return text;
}

/** 头像：只接受 cloud:// 开头的 fileID 或空串，其它值（外链等）归一成空串。 */
function pickAvatar(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!isCloudFileId(text)) return '';
  if (charLength(text) > LIMITS.AVATAR_MAX) return '';
  return text;
}

/** 读自己的资料文档；不存在或读取失败都返回 null（不抛错）。 */
async function findUser(openid) {
  if (!openid) return null;
  try {
    const res = await users().doc(openid).get();
    return res && res.data ? res.data : null;
  } catch (err) {
    console.warn('[profile] 读取失败或不存在', openid, err && (err.errCode || err.message));
    return null;
  }
}

async function get(ctx) {
  const doc = await findUser(ctx.openid);
  if (!doc || typeof doc !== 'object') return emptyProfile();
  return {
    nickname: typeof doc.nickname === 'string' ? doc.nickname : '',
    avatar: typeof doc.avatar === 'string' ? doc.avatar : '',
  };
}

/**
 * upsert 到 users（doc(openid).set 在文档不存在时创建）。
 * 字段整体缺省（undefined）时保留库里已有值：前端只改昵称时不会把头像清空；
 * 显式传了值就按规则归一（非法值 -> 空串）。
 */
async function save(ctx) {
  const payload = ctx.payload || {};
  const existing = await findUser(ctx.openid);
  const base = existing && typeof existing === 'object' ? existing : {};

  const storedNickname = typeof base.nickname === 'string' ? base.nickname : '';
  const storedAvatar = typeof base.avatar === 'string' ? base.avatar : '';

  const nickname = payload.nickname === undefined ? storedNickname : pickNickname(payload.nickname);
  const avatar = payload.avatar === undefined ? storedAvatar : pickAvatar(payload.avatar);

  // data 里不能带 _id（不可更新字段），id 由 doc() 决定
  await users()
    .doc(ctx.openid)
    .set({ data: { nickname: nickname, avatar: avatar, updatedAt: now() } });

  return { nickname: nickname, avatar: avatar };
}

module.exports = {
  get: get,
  save: save,
  findUser: findUser,
};
