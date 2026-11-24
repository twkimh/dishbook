Component({
  options: {
    addGlobalClass: true
  },
  data: {
    selected: 0,
    list: [
      { pagePath: '/pages/index/index', text: '菜谱', icon: 'index' },
      { pagePath: '/pages/add/add', text: '记一道', icon: 'add' },
      { pagePath: '/pages/mine/mine', text: '我的', icon: 'mine' }
    ]
  },
  attached: function () {
    this.syncSelected();
  },
  pageLifetimes: {
    show: function () {
      this.syncSelected();
    }
  },
  methods: {
    // 每个 tab 页都有一份自己的 tabBar 实例，按当前页面路由回填选中态
    syncSelected: function () {
      var pages = getCurrentPages();
      if (!pages || !pages.length) {
        return;
      }
      var route = '/' + pages[pages.length - 1].route;
      var list = this.data.list;
      for (var i = 0; i < list.length; i++) {
        if (list[i].pagePath === route) {
          if (i !== this.data.selected) {
            this.setData({ selected: i });
          }
          return;
        }
      }
    },
    onTap: function (event) {
      var index = Number(event.currentTarget.dataset.index);
      var item = this.data.list[index];
      if (!item) {
        return;
      }
      // 不做 index === selected 的提前返回：自定义 tabBar 的 selected 可能滞后，
      // 一旦滞后就会把「点击另一个 tab」误判成「点的是当前页」而直接吞掉点击。
      // switchTab 到当前页本身是无害的空操作，所以这里只做乐观更新再切换。
      if (index !== this.data.selected) {
        this.setData({ selected: index });
      }
      wx.switchTab({
        url: item.pagePath,
        fail: function () {
          // 目标就是当前页时 switchTab 会失败，属正常情况
        }
      });
    }
  }
});
