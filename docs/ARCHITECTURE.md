# Architecture

Rainform is a client-only Vite application. No server runtime, database or secret environment variable is required.

## Layers

```
index.html              meta, mount point, stylesheet + rain audio preload
  └─ src/bootstrap.ts   data-app-state, rain audio preload, then import the app
       └─ src/main.ts   createApp(App).mount('#app')
            └─ src/App.vue        the shell: provides i18n + engine handle
                 ├─ components/SceneCanvas.vue          WebGL host (loads the engine lazily)
                 ├─ components/SceneToolbar.vue         editor / rain sound / effect settings
                 ├─ components/RainfallEditorPanel.vue  rainfall data editor
                 ├─ components/TuningConsolePanel.vue   effect console (development only)
                 ├─ components/MobileLandscapeGate.vue  portrait gate
                 └─ components/SelectionReadout.vue     hover readout
```

The whole Three.js renderer lives behind one factory in `src/engine/rainformEngine.ts`
(~6.5k lines) and is reached only through the `RainformEngine` interface. Vue owns every
DOM node; the engine takes over the `#scene-root` canvas and writes high-frequency values
(readout time/value, `data-*` debug markers) straight to the DOM instead of going through
reactivity.

## Startup lifecycle

1. `index.html` loads `src/bootstrap.ts` and preloads `/audio/rain-loop.wav`.
2. `bootstrap.ts` sets `data-app-state="loading"`, starts fetching/decoding the rain audio
   and stores the promise on `window.__rainAudioReady`, then imports the Vue entry.
   Audio and app bundle therefore load in parallel instead of one after the other.
3. `App.vue` provides the i18n context and the engine handle, and syncs `<html lang>`,
   `document.title` and the social meta tags.
4. `SceneCanvas.vue` awaits `window.__rainAudioReady`, writes `window.__rainAudioBoot`, then
   `import()`s the engine bundle and creates the scene. Portrait viewports never reach this
   step, so phones in portrait do not download Three.js at all.
5. Viewport and orientation events update layout without initializing a second scene:

   | `data-app-state` | meaning |
   | --- | --- |
   | `loading` | bootstrap done, engine not created yet |
   | `waiting-landscape` | portrait, engine intentionally not created |
   | `ready` | engine running |
   | `error` | engine creation or app bootstrap failed |

## Rendering model

The 25 values from 00:00 through 24:00 are the single source of truth for visual rainfall. Derived systems include:

- axis geometry and selected-hour feedback;
- rain chains, ambient rain and downpour sampling;
- peak waterfall geometry and materials;
- water, glints, impacts and ripple fields;
- sound intensity and editor feedback.

Seeded random generators keep the composition stable across rebuilds. Avoid replacing seeded paths with `Math.random()` where deterministic layout matters.

## Interaction model

- Dragging the main view changes the orbit camera.
- Double-click resets the camera.
- The rainfall editor previews curve changes and rebuilds systems after input.
- Audio playback uses intent and source tokens to prevent overlapping sources during rapid toggles.
- Rainfall edits are session-only by design; refresh restores the built-in curve. Effect-console
  parameters are persisted to `localStorage` under `rf-tuning` / `rf-quality` / `rf-features`.

## Production boundary

`ENABLE_TUNING_CONSOLE` must remain bound to `import.meta.env.DEV` (it lives in
`src/engine/rainformEngine.ts`, which owns the parameter registry). The console UI
(`TuningConsolePanel.vue` plus `src/styles/tuning-console.css`) is only reached through the
`if (import.meta.env.DEV)` branch in `App.vue`, so Rollup drops the component, its dynamic
import and its stylesheet from production output. Vite builds are minified without source maps.
`scripts/check-project.mjs` and `scripts/check-dist.mjs` fail the build when the tuning panel
or source-map references leak into `dist/`.

## Change strategy

The engine was migrated from a single 7.9k-line `src/main.js` without touching its numeric
behaviour. Keep it that way: change one subsystem at a time and verify with the headless
screenshot/interaction checks plus `npm run check` before touching the validated visual result.
