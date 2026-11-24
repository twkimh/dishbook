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
    }
  },
  methods: {
    onTap: function () {
      var dish = this.data.dish || {};
      this.triggerEvent('tap', { id: dish._id || '' });
    }
  }
});
