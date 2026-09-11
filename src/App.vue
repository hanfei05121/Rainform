<script setup lang="ts">
// Required Notice: Rainform / 数据成雨 © 2026 afterimage — https://rainform.pages.dev/
//
// 应用外壳。Vue 从这一层接管整个页面骨架：
//
//   .rainfall-dashboard
//     ├─ SceneCanvas           WebGL 画布（引擎宿主，竖屏不加载）
//     ├─ MobileLandscapeGate   竖屏提示（显示与否由 CSS 媒体查询控制）
//     ├─ SceneToolbar          右上角工具栏：编辑降雨数据 / 雨声
//     ├─ RainfallEditorPanel   右侧「编辑降雨数据」面板
//     ├─ TuningConsolePanel    右侧「效果控制台」+ 第三颗设置按钮（仅开发构建）
//     └─ SelectionReadout      悬停读数（静态节点，引擎直接写 textContent）
//
// 引擎与 i18n 都在这里 provide，子组件用 useEngine() / useI18n() 取。

import { ref, shallowRef, watch, type Component } from 'vue';
import SceneCanvas from './components/SceneCanvas.vue';
import SceneToolbar from './components/SceneToolbar.vue';
import MobileLandscapeGate from './components/MobileLandscapeGate.vue';
import RainfallEditorPanel from './components/RainfallEditorPanel.vue';
import SelectionReadout from './components/SelectionReadout.vue';
import { provideI18n } from './composables/useI18n';
import { provideEngine } from './composables/useRainformEngine';
import { useMediaQuery } from './composables/useMediaQuery';
import { applyDocumentLocale } from './i18n';
import type { ThemeAppliedPayload } from './engine/rainformEngine';

const PORTRAIT_QUERY = '(max-width: 760px) and (orientation: portrait)';

const { t } = provideI18n();
const engine = provideEngine();

// 同步 <html lang>、document.title 与社交分享 meta（这些不在 Vue 模板里）。
applyDocumentLocale();

const portrait = useMediaQuery(PORTRAIT_QUERY);

const editorOpen = ref(false);
const consoleOpen = ref(false);
const soundEnabled = ref(false);
const refreshDirty = ref(false);
const themeApplied = shallowRef<ThemeAppliedPayload | null>(null);

/**
 * 效果控制台只在开发构建里存在。
 * esbuild 会把 import.meta.env.DEV 换成字面量 false，于是这个分支连同
 * 动态 import 一起被摇树剔除 —— 面板代码和它的样式表都不会进生产产物。
 */
const TuningConsolePanel = shallowRef<Component | null>(null);
if (import.meta.env.DEV) {
  void import('./components/TuningConsolePanel.vue').then((module) => {
    TuningConsolePanel.value = module.default;
  });
}

/**
 * appState 标记（调试 / 自动化验证用）：
 *   loading            bootstrap 已加载，引擎还在路上
 *   waiting-landscape  竖屏，按约定不创建引擎
 *   ready              引擎已就绪
 *   error              创建失败
 */
watch([portrait, engine], ([isPortrait, instance]) => {
  if (instance) document.documentElement.dataset.appState = 'ready';
  else if (!isPortrait) document.documentElement.dataset.appState = 'loading';
  else document.documentElement.dataset.appState = 'waiting-landscape';
}, { immediate: true });

// 自动化 / 调试句柄：拿得到引擎就能直接调 API，不必走 UI。
watch(engine, (instance) => {
  window.__rainformEngine = instance ?? undefined;
});
</script>

<template>
  <main class="rainfall-dashboard" :aria-label="t('dashboardAria')">
    <SceneCanvas
      @sound-change="soundEnabled = $event"
      @theme-applied="themeApplied = $event"
      @refresh-dirty="refreshDirty = true"
    />

    <MobileLandscapeGate />

    <SceneToolbar
      :editor-open="editorOpen"
      :sound-enabled="soundEnabled"
      @toggle-editor="editorOpen = !editorOpen"
    />

    <RainfallEditorPanel v-model:open="editorOpen" />

    <!--
      效果控制台的设置按钮由这个组件自己 Teleport 进工具栏，
      所以生产构建里连按钮都不会出现。
    -->
    <component
      :is="TuningConsolePanel"
      v-if="TuningConsolePanel"
      v-model:open="consoleOpen"
      :theme-applied="themeApplied"
      :refresh-dirty="refreshDirty"
    />

    <SelectionReadout />
  </main>
</template>
