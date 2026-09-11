// Required Notice: Rainform / 数据成雨 © 2026 afterimage — https://rainform.pages.dev/
//
// 应用入口：把 Vue 外壳挂到 index.html 的 #app 上。
// 页面的全部 DOM（画布、工具栏、两个侧边面板、读数）都来自 App.vue，
// index.html 只剩 meta 与挂载点。

import { createApp } from 'vue';
import App from './App.vue';

createApp(App).mount('#app');
