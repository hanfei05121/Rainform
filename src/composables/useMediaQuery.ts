// Required Notice: Rainform / 数据成雨 © 2026 afterimage — https://rainform.pages.dev/

import { onUnmounted, ref, type Ref } from 'vue';

/**
 * 响应式 media query。用于竖屏门控：竖屏时只渲染提示、不创建 WebGL 引擎
 * （保持原实现在竖屏下完全不加载引擎的行为）。
 */
export function useMediaQuery(query: string): Ref<boolean> {
  const matches = ref(false);
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return matches;

  const media = window.matchMedia(query);
  matches.value = media.matches;
  const onChange = (event: MediaQueryListEvent) => {
    matches.value = event.matches;
  };
  media.addEventListener('change', onChange);
  onUnmounted(() => media.removeEventListener('change', onChange));
  return matches;
}
