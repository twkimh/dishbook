/**
 * 时间 / 文本格式化工具（SPEC §2 utils/format.js）
 * 纯函数，不依赖 wx API，不读写全局状态。
 */

var MINUTE = 60 * 1000;
var HOUR = 60 * MINUTE;
var DAY = 24 * HOUR;

function pad(value) {
  return value < 10 ? '0' + value : '' + value;
}

// 兼容 毫秒时间戳 / 数字字符串 / Date / 'YYYY-MM-DD hh:mm' 字符串（iOS 需要把 - 换成 /）
function toDate(value) {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'number') {
    return new Date(value);
  }
  if (typeof value === 'string' && value !== '') {
    var numeric = Number(value);
    if (!isNaN(numeric)) {
      return new Date(numeric);
    }
    return new Date(value.replace(/-/g, '/'));
  }
  return new Date();
}

// 'YYYY-MM-DD'
function formatDate(value) {
  var d = toDate(value);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// 'YYYY-MM-DD HH:mm'
function formatTime(value) {
  var d = toDate(value);
  return formatDate(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// 刚刚 / N 分钟前 / N 小时前 / 昨天 HH:mm / M月D日 / YYYY年M月D日
function formatRelativeTime(value, base) {
  var d = toDate(value);
  var now = base === undefined || base === null ? Date.now() : toDate(base).getTime();
  var diff = now - d.getTime();

  if (diff < 0) {
    return formatTime(d);
  }
  if (diff < MINUTE) {
    return '刚刚';
  }
  if (diff < HOUR) {
    return Math.floor(diff / MINUTE) + ' 分钟前';
  }
  if (diff < DAY) {
    return Math.floor(diff / HOUR) + ' 小时前';
  }
  if (diff < 2 * DAY) {
    return '昨天 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  if (d.getFullYear() === new Date(now).getFullYear()) {
    return d.getMonth() + 1 + '月' + d.getDate() + '日';
  }
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

// 超长文本截断，默认 30 字，尾部用省略号
function truncate(text, max) {
  var limit = max === undefined || max === null ? 30 : max;
  var source = text === undefined || text === null ? '' : String(text);
  if (limit <= 0 || source.length <= limit) {
    return source;
  }
  return source.slice(0, limit) + '…';
}

// 计数展示：0 -> '0'，超过 999 收敛为 '999+'
function formatCount(count) {
  var value = Number(count);
  if (isNaN(value) || value < 0) {
    return '0';
  }
  return value > 999 ? '999+' : String(Math.floor(value));
}

module.exports = {
  formatDate: formatDate,
  formatTime: formatTime,
  formatRelativeTime: formatRelativeTime,
  truncate: truncate,
  formatCount: formatCount
};
