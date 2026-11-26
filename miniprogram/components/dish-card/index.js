Component({
  options: {
    addGlobalClass: true
  },
  properties: {
    dish: {
      type: Object,
      value: {}
    },
    // 列表中的位置，用于相邻卡片交替旋转（SPEC §5）
    index: {
      type: Number,
      value: 0
    },
    // 当前是否有进行中的点菜单：只影响「+」按钮的置灰态，页面算好传进来
    menuReady: {
      type: Boolean,
      value: false
    }
  },
  methods: {
    onTap: function () {
      var dish = this.data.dish || {};
      this.triggerEvent('tap', { id: dish._id || '' });
    },
    // 三个操作用 catchtap 绑定，事件只抛给页面：组件不碰 openid、不查菜单、不发请求
    onOrderTap: function () {
      this.triggerEvent('order', { id: (this.data.dish && this.data.dish._id) || '' });
    },
    onLikeTap: function () {
      this.triggerEvent('like', { id: (this.data.dish && this.data.dish._id) || '' });
    },
    onWantTap: function () {
      this.triggerEvent('want', { id: (this.data.dish && this.data.dish._id) || '' });
    },
    // 「被点 N 次」整块可点：把 id / name 抛给页面，页面负责打开「谁点过」浮层。
    // 组件不查数据、不发请求（和上面三个按钮一样只转发）。
    onOrderersTap: function () {
      this.triggerEvent('orderers', {
        id: (this.data.dish && this.data.dish._id) || '',
        name: (this.data.dish && this.data.dish.name) || ''
      });
    }
  }
});
