<script setup lang="ts">
// Required Notice: Rainform / 数据成雨 © 2026 afterimage — https://rainform.pages.dev/
//
// 指针悬停时的「时:值」读数。
//
// 注意这里的契约：.readout-time / .readout-value 是【静态节点】，
// 故意不做任何响应式绑定 —— 它们的文字由引擎在每帧的 updateDomState() 里
// 直接写 textContent（见 engine/rainformEngine.ts 的说明）。
// 如果给它们加上绑定，Vue 的重渲染会把引擎写入的值覆盖掉。

import { useI18n } from '../composables/useI18n';

const { t } = useI18n();
</script>

<template>
  <div id="selection-readout" class="selection-readout" aria-live="polite">
    <span class="readout-time">18:00</span>
    <strong class="readout-value">12.6</strong>
    <span class="readout-unit">{{ t('axisUnit') }}</span>
  </div>
</template>
