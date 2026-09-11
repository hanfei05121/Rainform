import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Rainform / 数据成雨 — Required Notice: © 2026 afterimage — https://rainform.pages.dev/
export default defineConfig({
  plugins: [vue()],
  build: {
    minify: 'esbuild',
    // 生产环境绝不产出 source map：既保护源码，也让 check-project 的约束成立。
    sourcemap: false,
    rollupOptions: {
      output: {
        banner: '/*! Rainform © 2026 afterimage · PolyForm Noncommercial 1.0.0 · https://rainform.pages.dev/ */'
      }
    }
  }
});
