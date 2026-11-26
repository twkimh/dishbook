/**
 * 我的申请（SPEC-v1.0.8 §5.2 权限矩阵 / §5.3 dish.remove）
 *
 * 创建者删自己传的菜必须先填理由、进审核队列，但审核结果不会通知他，
 * 提交完就再也看不到后续，所以这里给他一个回看入口。
 * 后端 dish.myEdits 按 openid 过滤，只返回当前用户自己提交的申请，不用传 openid。
 *
 * 分类：全部 / 删除申请 / 修改申请，默认停在「删除申请」。
 * 列表：下拉刷新 / 触底加载 / 空状态 / 骨架。
 */

var api = require('../../utils/api.js');
var format = require('../../utils/format.js');

var PAGE_SIZE = 10;

var STATUS_TEXT = {
  pending: '待审核',
  approved: '已通过',
  rejected: '未通过'
};

var TYPE_TEXT = {
  delete: '删除申请',
  edit: '修改申请'
};

// 空状态文案按当前分类给，别让用户看着「没有申请」却不知道自己在看哪一类
var EMPTY_TEXT = {
  all: '你还没有提交过任何申请',
  delete: '你还没有提交过删除申请',
  edit: '你还没有提交过修改申请'
};

var EMPTY_HINT = {
  all: '删菜、改菜时提交的申请都会记在这里',
  delete: '在菜品详情里点删除、填好理由，就会有一条记录',
  edit: '改别人的菜会先变成申请，主人家通过了才生效'
};

function toast(title) {
  wx.showToast({ title: title, icon: 'none', duration: 2000 });
}

function toText(value) {
  return typeof value === 'string' ? value : '';
}

function decorate(raw) {
  var item = raw || {};
  // type 缺失按 edit 处理：v1.0.8 之前只有修改提案
  var type = item.type === 'delete' ? 'delete' : 'edit';
  var status = STATUS_TEXT[item.status] ? item.status : 'pending';
  var reviewedAt = item.reviewedAt ? format.formatTime(item.reviewedAt) : '';
  return {
    id: toText(item._id) || toText(item.id),
    dishName: toText(item.dishName) || '已删除的菜',
    type: type,
    typeText: TYPE_TEXT[type],
    status: status,
    statusText: STATUS_TEXT[status],
    // 理由只有删除申请才有：修改申请的 reason 后端不写，别拿空串占一行
    reason: type === 'delete' ? toText(item.reason) : '',
    timeText: item.createdAt ? format.formatTime(item.createdAt) : '',
    reviewedText: reviewedAt ? '已于 ' + reviewedAt + ' 审核' : ''
  };
}

Page({
  data: {
    mode: 'delete',
    chips: [
      { key: 'all', label: '全部', countText: '0' },
      { key: 'delete', label: '删除申请', countText: '0' },
      { key: 'edit', label: '修改申请', countText: '0' }
    ],
    list: [],
    total: 0,
    page: 0,
    hasMore: true,
    loading: false,
    loadingMore: false,
    skeleton: true,
    emptyText: EMPTY_TEXT.delete,
    emptyHint: EMPTY_HINT.delete
  },

  onLoad: function () {
    // 请求序号：切分类 / 再下拉之后，旧请求的回包必须丢掉，否则两类记录会串在一屏
    this.reqSeq = 0;
    this.refreshAll();
  },

  onPullDownRefresh: function () {
    this.refreshAll().then(function () {
      wx.stopPullDownRefresh();
    }, function () {
      wx.stopPullDownRefresh();
    });
  },

  onReachBottom: function () {
    this.fetchList(false);
  },

  refreshAll: function () {
    return Promise.all([this.fetchCounts(), this.fetchList(true)]).then(
      function onDone() {
        return null;
      },
      function onFail(err) {
        console.error('[mydeletes] 刷新失败', err);
        return null;
      }
    );
  },

  /**
   * 三个 chip 的数字各取一次 total（pageSize 1，只要 total，不拉整页数据）。
   * 任一失败保留上一次的数字，不清零。
   */
  fetchCounts: function () {
    var self = this;
    function totalOf(type) {
      var params = { page: 1, pageSize: 1 };
      if (type) {
        params.type = type;
      }
      return api.dishMyEdits(params).then(
        function onSuccess(res) {
          return { ok: true, total: Number(res && res.total) || 0 };
        },
        function onFail(err) {
          // api.js 已经 toast 过，这里只标记失败
          console.error('[mydeletes] 申请数量加载失败', err);
          return { ok: false, total: 0 };
        }
      );
    }
    return Promise.all([totalOf(''), totalOf('delete'), totalOf('edit')]).then(function (results) {
      var patch = {};
      for (var i = 0; i < results.length; i++) {
        if (results[i].ok) {
          patch['chips[' + i + '].countText'] = format.formatCount(results[i].total);
        }
      }
      if (Object.keys(patch).length) {
        self.setData(patch);
      }
    });
  },

  /**
   * @param {boolean} reset true 拉第一页并替换列表，false 追加下一页
   */
  fetchList: function (reset) {
    var self = this;
    if (!reset && (this.data.loading || this.data.loadingMore || !this.data.hasMore)) {
      return Promise.resolve();
    }
    var nextPage = reset ? 1 : this.data.page + 1;
    var mode = this.data.mode;
    this.reqSeq = (this.reqSeq || 0) + 1;
    var seq = this.reqSeq;

    if (reset) {
      this.setData({ loading: true, skeleton: this.data.list.length === 0 });
    } else {
      this.setData({ loadingMore: true });
    }

    var params = { page: nextPage, pageSize: PAGE_SIZE };
    if (mode !== 'all') {
      params.type = mode;
    }

    return api.dishMyEdits(params).then(
      function onSuccess(res) {
        if (seq !== self.reqSeq) {
          // 这条回包对应的分类已经被切走 / 又下拉刷新了一次
          return;
        }
        var raw = (res && res.list) || [];
        var rows = [];
        for (var i = 0; i < raw.length; i++) {
          rows.push(decorate(raw[i]));
        }
        self.setData({
          list: reset ? rows : self.data.list.concat(rows),
          total: Number(res && res.total) || 0,
          page: nextPage,
          hasMore: !!(res && res.hasMore),
          loading: false,
          loadingMore: false,
          skeleton: false
        });
      },
      function onFail(err) {
        if (seq !== self.reqSeq) {
          return;
        }
        console.error('[mydeletes] 申请列表加载失败', err);
        self.setData({ loading: false, loadingMore: false, skeleton: false });
      }
    );
  },

  onSwitchMode: function (event) {
    var key = event.currentTarget.dataset.key;
    if (!key || key === this.data.mode) {
      return;
    }
    // 换分类 = 换查询条件：先清空，别让上一类的记录留在屏幕上被当成新分类的数据
    this.setData({
      mode: key,
      list: [],
      total: 0,
      page: 0,
      hasMore: true,
      skeleton: true,
      emptyText: EMPTY_TEXT[key],
      emptyHint: EMPTY_HINT[key]
    });
    this.fetchList(true);
  },

  // 申请对应的菜可能已经被删了，跳详情会报错：只提示去哪儿看，不做跳转
  onTapItem: function () {
    toast('看菜品详情请到「菜谱」页');
  }
});
