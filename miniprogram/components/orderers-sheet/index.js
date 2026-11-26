/**
 * 谁点过这道菜（SPEC-v1.0.8 §4.3 dish.orderers）
 *
 * 半透明遮罩 + 底部浮出的面板。组件自己发请求：父页面只负责传
 * visible / dishId / dishName，并监听 close。
 * 挂载点必须在页面根节点（不能落在带 transform 的 .paper 里，否则遮罩的 fixed 会被改写）。
 */

var api = require('../../utils/api.js');
var format = require('../../utils/format.js');

var PERSON_FALLBACK = '朋友';

// 服务端按 openid 聚合、按 lastAt 倒序；这里只做字段兜底与展示用的派生值
function buildPeople(value) {
  var out = [];
  if (!Array.isArray(value)) {
    return out;
  }
  for (var i = 0; i < value.length; i += 1) {
    var row = value[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      continue;
    }
    var openid = typeof row.openid === 'string' ? row.openid : '';
    var nickname = typeof row.nickname === 'string' && row.nickname ? row.nickname : PERSON_FALLBACK;
    var times = Number(row.times);
    out.push({
      key: openid || 'p-' + i,
      nickname: nickname,
      initial: nickname.slice(0, 1),
      avatar: typeof row.avatar === 'string' ? row.avatar : '',
      broken: false,
      timesText: format.formatCount(isNaN(times) || times < 1 ? 1 : times),
      timeText: row.lastAt ? format.formatTime(row.lastAt) : ''
    });
  }
  return out;
}

Component({
  properties: {
    visible: {
      type: Boolean,
      value: false
    },
    dishId: {
      type: String,
      value: ''
    },
    dishName: {
      type: String,
      value: ''
    }
  },

  data: {
    loading: false,
    people: []
  },

  lifetimes: {
    // 标志位在 created 里初始化：observers 可能在 attached 之前就触发一次
    created: function () {
      // 卸载后回来的响应一律丢弃
      this.alive = true;
      this.seq = 0;
      this.wasVisible = false;
      this.loadedId = '';
    },
    detached: function () {
      this.alive = false;
      // 让所有在途响应失效
      this.seq = (this.seq || 0) + 1;
    }
  },

  observers: {
    // visible 变 true 且 dishId 非空才拉：从关闭变显示（含换了菜）拉一次，
    // 显示中的重复通知（另一个字段变化）不再请求
    'visible, dishId': function (visible, dishId) {
      var id = typeof dishId === 'string' ? dishId : '';
      var shown = visible === true;
      var was = this.wasVisible === true;
      this.wasVisible = shown;
      if (!shown || !id) {
        return;
      }
      if (was && this.loadedId === id) {
        return;
      }
      this.loadedId = id;
      this.fetch(id);
    }
  },

  methods: {
    fetch: function (dishId) {
      var self = this;
      if (!dishId) {
        return;
      }
      var seq = (this.seq || 0) + 1;
      this.seq = seq;
      this.setData({ loading: true, people: [] });

      var task;
      try {
        task = api.dishOrderers(dishId);
      } catch (err) {
        // api.js 已 toast；这里只收起加载态，不假装有数据
        console.error('[orderers-sheet] 调用异常', err);
        if (this.alive !== false && seq === this.seq) {
          this.setData({ loading: false, people: [] });
        }
        return;
      }

      task.then(function (result) {
        if (self.alive === false || seq !== self.seq) {
          return;
        }
        var payload = result || {};
        self.setData({ people: buildPeople(payload.people), loading: false });
      }, function (err) {
        if (self.alive === false || seq !== self.seq) {
          return;
        }
        console.error('[orderers-sheet] 拉取失败', err);
        self.setData({ loading: false, people: [] });
      });
    },

    // 头像加载失败 -> 露出容器的纯 CSS 圆形首字占位，不留裂图
    onAvatarError: function (event) {
      var dataset = (event && event.currentTarget && event.currentTarget.dataset) || {};
      var index = Number(dataset.index);
      var list = (this.data.people || []).slice();
      if (!list[index]) {
        return;
      }
      list[index].broken = true;
      this.setData({ people: list });
    },

    onMaskTap: function () {
      this.triggerEvent('close');
    },

    onClose: function () {
      this.triggerEvent('close');
    },

    // 面板本身吞掉点击与滚动穿透，只有遮罩与 × 能关
    noop: function () {}
  }
});
