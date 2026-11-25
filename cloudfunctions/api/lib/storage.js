/**
 * 云存储 fileID -> 带签名的临时 https 链接。
 *
 * 背景：云环境的存储权限是 PRIVATE（仅创建者可读写），而免费体验套餐不允许修改存储权限
 * （OperationDenied.FreePackageDenied）。客户端用 <image src="cloud://..."> 渲染别人上传的
 * 图片会失败，访客看到空白块。云函数是管理员身份，不受存储 ACL 限制，
 * 用 cloud.getTempFileURL() 把 fileID 换成临时链接后返回给客户端渲染。
 *
 * 【铁律】临时链接会过期，落库永远存 fileID 原文；读取接口出参才做转换。
 * 转换只是「尽力而为」的可选增强：任何异常都不得让列表/详情接口失败。
 */

const { cloud } = require('./db');

/** 临时链接有效期（秒）：2 小时。 */
const TEMP_URL_MAX_AGE = 7200;

/** 云开发单次 getTempFileURL 最多 50 个文件，超过必须分批。 */
const BATCH_LIMIT = 50;

const CLOUD_PREFIX = 'cloud://';

/** 只有 cloud:// 开头的字符串才需要转换；其它值（空串、https、undefined）原样保留。 */
function isCloudFileId(value) {
  return typeof value === 'string' && value.indexOf(CLOUD_PREFIX) === 0;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 字段名解析：支持平铺字段（'cover'）与一层点路径（'submitter.avatar'）。
 * 父对象不存在 / 不是普通对象时返回 null，由调用方安全跳过 —— 嵌套字段缺失不许抛错。
 * 超过一层的路径（'a.b.c'）不支持，同样返回 null。
 */
function resolveField(item, field) {
  const segments = String(field).split('.');
  if (segments.length === 1) {
    return segments[0] ? { container: item, key: segments[0], parentKey: '' } : null;
  }
  if (segments.length !== 2 || !segments[0] || !segments[1]) return null;
  const parent = item[segments[0]];
  if (!isPlainObject(parent)) return null;
  return { container: parent, key: segments[1], parentKey: segments[0] };
}

/**
 * 收集一条记录里指定字段的 fileID。
 * 字符串字段直接收；数组字段（如 images）逐项收。支持 'a.b' 形式的一层嵌套。
 */
function collectFileIds(item, fields, bucket) {
  if (!item || typeof item !== 'object') return;
  for (let i = 0; i < fields.length; i += 1) {
    const slot = resolveField(item, fields[i]);
    if (!slot) continue;
    const value = slot.container[slot.key];
    if (isCloudFileId(value)) {
      bucket.push(value);
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (let j = 0; j < value.length; j += 1) {
      if (isCloudFileId(value[j])) bucket.push(value[j]);
    }
  }
}

/**
 * 批量换取临时链接，按 fileID 建映射表。
 * 每批最多 50 个；换不出来的 filed（status 非 0 / tempFileURL 为空）不进表 ——
 * 调用方据此保留原 fileID，避免图片变成 undefined。
 */
async function buildUrlMap(fileIds) {
  const urlMap = {};
  for (let start = 0; start < fileIds.length; start += BATCH_LIMIT) {
    const batch = fileIds.slice(start, start + BATCH_LIMIT);
    const fileList = [];
    for (let i = 0; i < batch.length; i += 1) {
      fileList.push({ fileID: batch[i], maxAge: TEMP_URL_MAX_AGE });
    }
    const res = await cloud.getTempFileURL({ fileList: fileList });
    const resolved = res && Array.isArray(res.fileList) ? res.fileList : [];
    for (let i = 0; i < resolved.length; i += 1) {
      const entry = resolved[i];
      if (!entry || !isCloudFileId(entry.fileID)) continue;
      if (typeof entry.tempFileURL !== 'string' || !entry.tempFileURL) continue;
      urlMap[entry.fileID] = entry.tempFileURL;
    }
  }
  return urlMap;
}

/**
 * 把映射表写回一条记录的同名字段。命中才写，未命中（转换失败）保留原 fileID。
 * 支持 'a.b' 形式的一层嵌套：读 item.a.b，写回浅拷贝出来的 a 对象上 ——
 * 绝不原地修改入参的子对象。
 * 不修改入参对象；无字段命中时原样返回入参引用。
 */
function applyUrls(item, fields, urlMap) {
  if (!item || typeof item !== 'object') return item;
  let patched = null;

  for (let i = 0; i < fields.length; i += 1) {
    const slot = resolveField(item, fields[i]);
    if (!slot) continue;

    const value = slot.container[slot.key];
    let nextValue = null;
    let changed = false;

    if (isCloudFileId(value) && urlMap[value]) {
      nextValue = urlMap[value];
      changed = true;
    } else if (Array.isArray(value)) {
      const next = [];
      for (let j = 0; j < value.length; j += 1) {
        const sub = value[j];
        if (isCloudFileId(sub) && urlMap[sub]) {
          next.push(urlMap[sub]);
          changed = true;
        } else {
          next.push(sub);
        }
      }
      nextValue = next;
    }

    if (!changed) continue;

    if (!patched) patched = Object.assign({}, item);
    if (!slot.parentKey) {
      patched[slot.key] = nextValue;
      continue;
    }
    // 同一父对象上可能有多个字段命中：已拷贝过的那份直接复用，
    // 否则后一次会用入参里的原对象重建，把前一次的结果覆盖掉。
    const base = isPlainObject(patched[slot.parentKey]) ? patched[slot.parentKey] : slot.container;
    const parentCopy = Object.assign({}, base);
    parentCopy[slot.key] = nextValue;
    patched[slot.parentKey] = parentCopy;
  }

  return patched || item;
}

/**
 * 把 items 里指定字段的 cloud:// fileID 换成临时 https 链接。
 *
 * @param {Array|Object} items 记录数组或单条记录（同形状返回）
 * @param {{fields?: string[]}} options fields 为要处理的字段名数组
 * @returns {Promise<Array|Object>} items 为空、fields 为空、无 cloud:// 值、或接口异常时原样返回
 */
async function attachTempUrls(items, options) {
  try {
    const rawFields = options && Array.isArray(options.fields) ? options.fields : [];
    const fields = [];
    for (let i = 0; i < rawFields.length; i += 1) {
      if (typeof rawFields[i] === 'string' && rawFields[i]) fields.push(rawFields[i]);
    }
    if (!fields.length) return items;

    const isArray = Array.isArray(items);
    let list = null;
    if (isArray) list = items;
    else if (items && typeof items === 'object') list = [items];
    if (!list || list.length === 0) return items;

    const collected = [];
    for (let i = 0; i < list.length; i += 1) collectFileIds(list[i], fields, collected);
    if (collected.length === 0) return items;

    // 去重（同一张图可能被多条记录、多个字段引用），减少接口开销
    const seen = {};
    const unique = [];
    for (let i = 0; i < collected.length; i += 1) {
      const fileId = collected[i];
      if (seen[fileId]) continue;
      seen[fileId] = true;
      unique.push(fileId);
    }

    const urlMap = await buildUrlMap(unique);

    if (!isArray) return applyUrls(list[0], fields, urlMap);
    const output = [];
    for (let i = 0; i < list.length; i += 1) output.push(applyUrls(list[i], fields, urlMap));
    return output;
  } catch (err) {
    // 图片显示不出来不能导致整个列表接口失败：只告警，原样返回
    console.warn('[storage] 临时链接转换失败，保留原 fileID：', err && (err.errCode || err.message));
    return items;
  }
}

module.exports = {
  attachTempUrls: attachTempUrls,
  // 下面两个只为复用与自测导出：写入侧判断「是不是云存储 fileID」用 isCloudFileId，
  // applyUrls 用于 node -e 验证点路径替换行为，运行时均由 attachTempUrls 内部调用。
  applyUrls: applyUrls,
  isCloudFileId: isCloudFileId,
  TEMP_URL_MAX_AGE: TEMP_URL_MAX_AGE,
  BATCH_LIMIT: BATCH_LIMIT,
};
