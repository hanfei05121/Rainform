# Rainform / 数据成雨


Rainform（数据成雨）把 00:00–24:00 的 25 个逐时降雨数据点转化为实时 Three.js/WebGL 粒子雨景。用户可以拖动降雨曲线，让雨幕、峰值瀑布、水面波纹、坐标轴与雨声随数据同步变化。

## 在线体验 / Live

- Experience Rainform: <https://rainform.pages.dev/>
- Best experienced in a desktop browser with WebGL2 and hardware acceleration
- Mobile devices require landscape orientation

## 功能 / Highlights

- 25 个逐时降雨数据点与实时可拖拽曲线 / 25 hourly rainfall values with a live draggable curve
- 数据驱动的粒子雨幕、峰值瀑布、水面波纹、坐标轴与雨声 / Data-driven rain, waterfall, water, axes and sound
- 桌面端视角拖拽、双击重置、声音切换与精确数据输入 / Desktop camera, reset, sound and precise editing
- 移动端横屏适配、安全区域与方向切换恢复 / Mobile landscape, safe-area and orientation recovery
- 中英文界面 / Chinese and English interface

## 本地开发 / Development

Requirements: Node.js 20 or newer.

```bash
npm ci
npm run dev
```

## 构建 / Build

```bash
npm run check
npm run preview
```

`npm run check` validates the Chinese/English interface and production build. Contributor validation requirements are documented in [CONTRIBUTING.md](CONTRIBUTING.md).

## 项目结构 / Structure

```text
.
├── index.html              # Metadata, mount point and asset preloads
├── src/
│   ├── bootstrap.ts        # Preloads rain audio, then imports the Vue entry
│   ├── main.ts             # createApp(App).mount('#app')
│   ├── App.vue             # Application shell (provides i18n + engine handle)
│   ├── components/         # Toolbar, rainfall editor, effect console, gate, readout
│   ├── composables/        # i18n / engine / media-query / liquid-glass helpers
│   ├── engine/             # The whole Three.js renderer behind one factory
│   ├── i18n/               # Chinese/English message tables
│   └── styles.css          # Responsive application styles
├── public/                 # Runtime assets and Cloudflare headers
├── scripts/                # Validation and maintainer media tools
├── docs/                   # Architecture, licensing and integration policy
└── .github/                # CI, dependency updates and contribution templates
```