# Changelog

All notable Rainform releases are documented here.

## [Unreleased]

- Ported the application shell to Vue 3 + TypeScript. `index.html` is now just metadata plus
  the `#app` mount point; the canvas host, toolbar, rainfall editor, portrait gate and readout
  are single-file components under `src/components/`.
- Moved the whole Three.js renderer into `src/engine/rainformEngine.ts` behind one
  `createRainformEngine()` factory, so the engine no longer owns any page skeleton and is
  loaded on demand (portrait viewports never download it).
- Turned the effect console into a development-only Vue component: its button is teleported
  into the toolbar, and both the component and `src/styles/tuning-console.css` are tree-shaken
  from production output.
- Added `npm run typecheck` (`vue-tsc`) to the validation chain and extended
  `scripts/check-project.mjs` to the new file layout.
- Public source repository governance, validation and noncommercial licensing.

## [2.0.0] - 2026-07-23

- Released the interactive liquid-metal rainfall landscape.
- Added editable hourly rainfall data, bilingual UI and responsive controls.
- Added rain audio, mobile landscape gating and X in-app browser guidance.
- Added production security headers, source-map exclusion and Cloudflare Pages deployment.
