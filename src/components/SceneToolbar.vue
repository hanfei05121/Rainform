<script setup lang="ts">
// Required Notice: Rainform / 数据成雨 © 2026 afterimage — https://rainform.pages.dev/
//
// 右上角工具栏：编辑降雨数据 / 雨声开关。
// 第三颗「效果设置」按钮属于开发期的效果控制台，由 TuningConsolePanel.vue
// 通过 Teleport 插进这个 nav —— 这样按钮能和面板一起被摇树剔除。
//
// 按钮状态都由 Vue 拥有；雨声的实际开关动作交给引擎。

import { computed } from 'vue';
import { useI18n } from '../composables/useI18n';
import { useEngine } from '../composables/useRainformEngine';

const props = defineProps<{
  /** 降雨编辑器是否展开。 */
  editorOpen: boolean;
  /** 雨声是否开启（由引擎回调同步过来）。 */
  soundEnabled: boolean;
}>();

const emit = defineEmits<{ (event: 'toggle-editor'): void }>();

const { t } = useI18n();
const engine = useEngine();

const soundLabel = computed(() => t(props.soundEnabled ? 'soundDisable' : 'soundEnable'));
const editorLabel = computed(() => t('editorToggle'));

/** 指针按下就切换（比 click 早一帧，触屏手感更好）；click 只处理键盘激活。 */
function onSoundPointerDown(event: PointerEvent) {
  if (!event.isPrimary || event.button !== 0) return;
  engine.value?.toggleRainSound();
}

function onSoundClick(event: MouseEvent) {
  if (event.detail === 0) engine.value?.toggleRainSound();
}

/** 鼠标移入工具栏时清掉图表上的悬停读数，避免和画布 hover 冲突。 */
function onPointerEnter() {
  engine.value?.clearChartHover();
}
</script>

<template>
  <nav
    id="scene-toolbar"
    class="scene-toolbar"
    :aria-label="t('toolbarAria')"
    @pointerenter="onPointerEnter"
  >
    <button
      id="rainfall-editor-toggle"
      class="rainfall-editor-toggle"
      type="button"
      aria-controls="rainfall-editor"
      :aria-expanded="editorOpen"
      :aria-label="editorLabel"
      :title="editorLabel"
      @click="emit('toggle-editor')"
    >
      <span class="rainfall-editor-toggle__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M3.5 17.5 8.2 12l4.1 3.1 5.4-8.2 2.8 2.2" />
          <circle cx="3.5" cy="17.5" r="1.25" />
          <circle cx="8.2" cy="12" r="1.25" />
          <circle cx="12.3" cy="15.1" r="1.25" />
          <circle cx="17.7" cy="6.9" r="1.25" />
          <circle cx="20.5" cy="9.1" r="1.25" />
        </svg>
      </span>
    </button>

    <button
      id="rain-sound-toggle"
      class="rain-sound-toggle"
      type="button"
      :aria-pressed="soundEnabled"
      :aria-label="soundLabel"
      :title="soundLabel"
      @pointerdown="onSoundPointerDown"
      @click="onSoundClick"
    >
      <span class="rain-sound-toggle__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path class="rain-sound-toggle__speaker" d="M4.5 9.2h3.1l4-3.4v12.4l-4-3.4H4.5z" />
          <path class="rain-sound-toggle__wave rain-sound-toggle__wave--inner" d="M15 9.2c1.5 1.5 1.5 4.1 0 5.6" />
          <path class="rain-sound-toggle__wave rain-sound-toggle__wave--outer" d="M17.8 6.6c3 3 3 7.8 0 10.8" />
        </svg>
      </span>
    </button>
  </nav>
</template>
