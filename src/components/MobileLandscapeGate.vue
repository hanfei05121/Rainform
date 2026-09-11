<script setup lang="ts">
// Required Notice: Rainform / 数据成雨 © 2026 afterimage — https://rainform.pages.dev/
//
// 竖屏提示页。显示与否由 styles.css 的媒体查询控制，所以这里常驻渲染即可。

import { useI18n } from '../composables/useI18n';

const { t } = useI18n();
</script>

<template>
  <section class="mobile-landscape-gate" role="status" aria-live="polite">
    <span class="mobile-landscape-gate__device" aria-hidden="true"><span></span></span>
    <div class="mobile-landscape-gate__copy">
      <strong>{{ t('rotateTitle') }}</strong>
      <p class="mobile-landscape-gate__lead">{{ t('rotateDescription') }}</p>
      <ul class="mobile-landscape-gate__tips">
        <li class="mobile-landscape-gate__sound">{{ t('rotateSoundSuggestion') }}</li>
        <li>{{ t('rotateDesktopSuggestion') }}</li>
        <li class="mobile-landscape-gate__browser">{{ t('rotateBrowserSuggestion') }}</li>
      </ul>
    </div>
  </section>
</template>
