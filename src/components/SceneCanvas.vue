<script setup lang="ts">
// Required Notice: Rainform / 数据成雨 © 2026 afterimage — https://rainform.pages.dev/
//
// 引擎宿主：渲染 #scene-root，并在合适的时机创建 / 释放 Three.js 引擎。
//
// 两个与原实现一致的关键约定：
//   1) 竖屏时不创建引擎 —— Three.js 引擎是通过动态 import 加载的，
//      竖屏进来就根本不会下载它（原实现也是竖屏下完全不加载 main.js）。
//   2) 引擎一旦创建就不再销毁 —— 旋转屏幕不会清掉相机位置和用户编辑的雨量。
//      只有整个应用卸载时才 dispose()。

import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from '../composables/useI18n';
import { useEngine } from '../composables/useRainformEngine';
import { useMediaQuery } from '../composables/useMediaQuery';
import type { ThemeAppliedPayload } from '../engine/rainformEngine';

const PORTRAIT_QUERY = '(max-width: 760px) and (orientation: portrait)';

const emit = defineEmits<{
  (event: 'sound-change', enabled: boolean): void;
  (event: 'theme-applied', payload: ThemeAppliedPayload): void;
  (event: 'refresh-dirty'): void;
}>();

const { t } = useI18n();
const engine = useEngine();
const portrait = useMediaQuery(PORTRAIT_QUERY);
const root = ref<HTMLElement | null>(null);

let disposed = false;
let loading = false;

async function ensureEngine(): Promise<void> {
  if (disposed || loading || engine.value || portrait.value || !root.value) return;
  loading = true;
  try {
    // 雨声由 bootstrap 与应用并行准备；引擎在模块求值时就会读
    // window.__rainAudioBoot，所以这里必须先等它落地。
    const prepared = window.__rainAudioReady ? await window.__rainAudioReady : null;
    if (disposed) return;
    window.__rainAudioBoot = prepared;

    const { createRainformEngine } = await import('../engine/rainformEngine');
    // 等待 chunk 期间可能已经转过屏 / 已经卸载，需要重新确认。
    if (disposed || portrait.value || !root.value) return;
    engine.value = createRainformEngine({
      container: root.value,
      onRainSoundChange: (enabled) => emit('sound-change', enabled),
      onThemeApplied: (payload) => emit('theme-applied', payload),
      onRefreshDirty: () => emit('refresh-dirty')
    });
  } catch (error) {
    document.documentElement.dataset.appState = 'error';
    console.error('Rainform failed to start', error);
  } finally {
    loading = false;
  }
}

onMounted(() => { void ensureEngine(); });

watch(portrait, (isPortrait) => {
  if (!isPortrait) void ensureEngine();
});

onBeforeUnmount(() => {
  disposed = true;
  engine.value?.dispose();
  engine.value = null;
});
</script>

<template>
  <!--
    aria-label 由 Vue 绑定；data-* 标记（readoutMode、rainSound、webglStatus…）
    仍由引擎直接写在同一个节点上，用于调试与自动化验证。
  -->
  <div id="scene-root" ref="root" class="scene-root" :aria-label="t('sceneAria')"></div>
</template>
