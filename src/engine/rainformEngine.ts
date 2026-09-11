// Required Notice: Rainform / 数据成雨 © 2026 afterimage — https://rainform.pages.dev/
// Rainform 的 Three.js 渲染引擎，整体封装在【这一个文件】里。
//
// 设计约定：
//   1) 引擎不再自己创建页面骨架 —— 外壳、工具栏、侧边面板都由 Vue 渲染，
//      引擎只负责 onMounted 之后接管 #scene-root 里的 WebGL 画布。
//   2) 高频更新的读数（#selection-readout 里的时/值）仍由引擎直接写 DOM，
//      避免每帧走一遍 Vue 响应式；这部分节点由 Vue 静态渲染、不做响应式绑定。
//   3) 需要通知 Vue 的状态（雨声开关、主题应用结果、重建提示）通过 options 回调发出。
//
// 用法：
//   const engine = createRainformEngine({ container });
//   engine.setRainfallData(values);
//   engine.dispose();

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { i18n, locale, isXEmbeddedLaunch } from '../i18n';

export interface TuningParameterDescriptor {
  key: string;
  label: string;
  desc: string;
  type: 'number' | 'color' | 'toggle';
  mode: 'live' | 'reload';
  min?: number;
  max?: number;
  step?: number;
}

export interface TuningSectionDescriptor {
  id: string;
  title: string;
  icon?: string;
  desc?: string;
  open?: boolean;
  params: TuningParameterDescriptor[];
}

  /** 主题色应用后的结果，交给效果控制台同步主题输入框与状态文案。 */
  export interface ThemeAppliedPayload {
    /** 已应用的十六进制颜色（大写，形如 #0091FF）。 */
    hex: string;
    /** 被主题联动改写过的参数路径。 */
    linkedPaths: string[];
  }

export interface RainformEngineOptions {
  /** WebGL 画布要挂载到的容器（Vue 渲染的 #scene-root）。 */
  container?: HTMLElement | null;
  /** 雨声开关状态变化（含首次同步）。 */
  onRainSoundChange?: (enabled: boolean) => void;
  /** 主题色应用完成。 */
  onThemeApplied?: (payload: ThemeAppliedPayload) => void;
  /** 有「需要刷新才生效」的参数被改动。 */
  onRefreshDirty?: () => void;
}

export interface RainformEngine {
  readonly container: HTMLElement;
  readonly defaultRainfall: readonly number[];
  /** 当前生效的 25 个逐时降雨量（mm/h）。 */
  getRainfallData(): number[];
  /** 应用一组新数据并重建雨幕。 */
  setRainfallData(values: number[]): void;
  /** 恢复内置默认曲线。 */
  resetRainfallData(): void;
  getRainfallMaximum(): number;
  /** 把任意数吸附到 1 / 2 / 2.5 / 5 × 10ⁿ 的「好看刻度」。 */
  niceAxisCeiling(value: number): number;
  /** 刻度文本（整数不带小数位，小数最多一位）。 */
  formatRainfallTick(value: number): string | number;
  /** 把输入值规整到 0.1 精度。 */
  normalizeRainfallValue(value: number): number;
  isRainSoundEnabled(): boolean;
  setRainSoundEnabled(enabled: boolean): void;
  toggleRainSound(): void;
  getGlobalThemeColor(): string;
  applyGlobalColor(value: number): void;
  resetView(): void;
  clearChartHover(): void;
  /** 调参面板的区块与参数描述（dev-only 面板渲染用）。 */
  getTuningSections(): TuningSectionDescriptor[];
  getTuningValue(path: string): unknown;
  /** 代码里的默认值（不算用户改动），用于「恢复此参数默认值」。 */
  getTuningDefault(path: string): unknown;
  /** 写入并落盘一个调参值；返回清洗后的值。 */
  commitTuningValue(param: TuningParameterDescriptor, raw: unknown): unknown;
  /** 当前全部视觉/性能/图层参数快照（控制台的「复制全部配置」用）。 */
  getTuningSnapshot(): Record<string, unknown>;
  /** 恢复所有视觉/性能/图层参数并重新加载。 */
  resetAllTuning(): void;
  dispose(): void;
}

export function createRainformEngine(options: RainformEngineOptions = {}): RainformEngine {
  const root = options.container ?? document.querySelector<HTMLElement>('#scene-root');
  if (!root) throw new Error('Rainform: 找不到画布容器 #scene-root');

  const dashboard = root.closest('.rainfall-dashboard') ?? document.querySelector('.rainfall-dashboard');
  const readout = document.querySelector('#selection-readout');
  const readoutTime = readout?.querySelector('.readout-time');
  const readoutValue = readout?.querySelector('.readout-value');

  root.dataset.locale = locale;
  root.dataset.launchContext = isXEmbeddedLaunch() ? 'x-embedded' : 'standard';

  // 渲染循环句柄与释放标记（dispose() 用）
  let animationFrameId = 0;
  let disposed = false;

function showWebGLFallback(message) {
  let fallback = root.querySelector<HTMLElement>('.webgl-fallback');
  if (!fallback) {
    fallback = document.createElement('section');
    fallback.className = 'webgl-fallback';
    fallback.setAttribute('role', 'status');
    fallback.setAttribute('aria-live', 'polite');
    const title = document.createElement('strong');
    const detail = document.createElement('span');
    title.textContent = i18n('webglTitle');
    fallback.append(title, detail);
    root.appendChild(fallback);
  }
  fallback.querySelector('span').textContent = message;
  fallback.hidden = false;
}

function hideWebGLFallback() {
  const fallback = root.querySelector<HTMLElement>('.webgl-fallback');
  if (fallback) fallback.hidden = true;
}

// The visual tuning console is strictly local-development tooling. Production
// builds always tree-shake the panel, its controls and stored tuning readers.
const ENABLE_TUNING_CONSOLE = import.meta.env.DEV;

const defaultRainfall = Object.freeze([
  2.1, 3.8, 4.6, 3.2, 2.5, 5.2, 7.7, 7.4,
  9.3, 9.8, 10.0, 6.7, 6.3, 1.6, 2.2, 3.8,
  5.9, 7.4, 9.1, 10.0, 8.8, 5.3, 3.1, 1.8,
  1.2
]);

// Rainfall edits are intentionally session-only. Every reload starts from the
// built-in curve so an older browser value cannot override the current demo.
let activeRainfall = [...defaultRainfall];
let rainfallMax = Math.max(...activeRainfall);
let axisMax = 12.8;
let peakWaterfallRanges = [];
let rainCeilingValue = axisMax;
let rainCeilingY = 0;

const BASE_AXIS_MAX = 12.8;
const VISUAL_RAINFALL_REFERENCE = 10;
const WATER_LEVEL = -0.14;
const RAIN_LAYOUT_SEED = 0x6d2b79f5;
const RAIN_CLUSTER_SEED = 0x2f6e2b1d;
const AMBIENT_RAIN_SEED = 0x53a91d7b;
const DOWNPOUR_RAIN_SEED = 0x31c7af59;
const WATER_LAYOUT_SEED = 0x7a4d31c9;
const IMPACT_LAYOUT_SEED = 0x4c8f6e27;
// Temporary master switch for foam, spray droplets and crown splashes.
// Set this back to true when the splash layer should return.
const SPLASH_IMPACTS_ENABLED = false;
const RAIN_ROLE = {
  BASE: 0,
  AMBIENT: 1,
  DOWNPOUR: 2
};
const CROWN_KIND = {
  RADIAL: 0,
  NEEDLE: 1
};
const WORLD = {
  width: 22.5,
  depth: 10.4,
  frontZ: 4.9,
  backZ: -4.2
};

// 雨幕深度(前后/z 方向)厚度。center=雨帘中心 z，thickness=半厚度。
// 调小 thickness → 从侧面看雨幕更薄、更像一片窄雨帘；调大 → 前后更立体。
const RAIN_DEPTH = { center: 0.2, thickness: 0.85, jitter: 0.22 };

const preparedRainAudio = window.__rainAudioBoot;
const initialShortViewportEdge = Math.min(window.innerWidth, window.innerHeight);
const initialLongViewportEdge = Math.max(window.innerWidth, window.innerHeight);
const mobileSoundDefault = window.matchMedia('(pointer: coarse)').matches
  || (initialShortViewportEdge <= 500 && initialLongViewportEdge <= 1000);
const rainAudio = {
  enabled: preparedRainAudio?.context?.state === 'running' || mobileSoundDefault,
  started: false,
  context: preparedRainAudio?.context ?? null,
  gain: preparedRainAudio?.gain ?? null,
  buffer: preparedRainAudio?.buffer ?? null,
  preloadPromise: null,
  source: null,
  intentToken: 0,
  sourceToken: 0,
  contextObserved: false
};
const RAIN_SOUND_PLAYBACK_RATE = 1;
const RAIN_SOUND_VOLUME_SCALE = 4.8;
const RAIN_SOUND_MAX_GAIN = 1.8;

function rainSoundStrength() {
  if (rainfallMax <= 0) return 0;
  const mean = activeRainfall.reduce((sum, value) => sum + value, 0) / activeRainfall.length;
  const meanStrength = clamp(mean / VISUAL_RAINFALL_REFERENCE, 0, 1);
  const peakStrength = clamp(rainfallMax / VISUAL_RAINFALL_REFERENCE, 0, 1);
  return clamp(meanStrength * 0.76 + peakStrength * 0.24, 0, 1);
}

function rainSoundTargetVolume() {
  const strength = rainSoundStrength();
  root.dataset.rainSoundStrength = strength.toFixed(3);
  const baseVolume = strength > 0 ? 0.18 + Math.pow(strength, 0.62) * 0.4 : 0;
  return clamp(baseVolume * RAIN_SOUND_VOLUME_SCALE, 0, RAIN_SOUND_MAX_GAIN);
}

function ensureRainAudioGraph() {
  if (!rainAudio.context) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return null;
    let context;
    try {
      context = new AudioContext({ latencyHint: 'interactive' });
    } catch {
      context = new AudioContext();
    }
    const gain = context.createGain();
    gain.gain.value = 0;
    gain.connect(context.destination);
    rainAudio.context = context;
    rainAudio.gain = gain;
  }
  const { context } = rainAudio;
  if (rainAudio.contextObserved) return context;
  rainAudio.contextObserved = true;
  root.dataset.rainSoundEngine = 'web-audio-buffer-loop';
  root.dataset.rainSoundContext = context.state;
  root.dataset.rainSoundBaseLatency = Number.isFinite(context.baseLatency)
    ? context.baseLatency.toFixed(4)
    : 'unknown';
  context.addEventListener('statechange', () => {
    root.dataset.rainSoundContext = context.state;
    if (context.state === 'running' && rainAudio.enabled && rainAudio.source) {
      root.dataset.rainSoundAutoplay = 'playing';
    }
  });
  return context;
}

function setRainSoundVolumeImmediately(targetVolume) {
  const { context, gain } = rainAudio;
  if (!context || !gain) return;
  const now = context.currentTime;
  gain.gain.cancelScheduledValues(now);
  gain.gain.value = targetVolume;
  gain.gain.setValueAtTime(targetVolume, now);
  root.dataset.rainSoundGain = targetVolume.toFixed(3);
}

function updateRainSoundFromData() {
  const targetVolume = rainAudio.enabled ? rainSoundTargetVolume() : 0;
  setRainSoundVolumeImmediately(targetVolume);
}



function preloadRainSound() {
  const context = ensureRainAudioGraph();
  if (!context) return Promise.reject(new Error('Web Audio is not supported'));
  if (rainAudio.buffer) return Promise.resolve(acceptRainSoundBuffer(rainAudio.buffer));
  if (rainAudio.preloadPromise) return rainAudio.preloadPromise;

  rainAudio.preloadPromise = fetch('/audio/rain-loop.wav')
    .then(response => {
      if (!response.ok) throw new Error(`Rain audio request failed: ${response.status}`);
      return response.arrayBuffer();
    })
    .then(encoded => context.decodeAudioData(encoded))
    .then(acceptRainSoundBuffer)
    .catch(error => {
      rainAudio.preloadPromise = null;
      throw error;
    });
  return rainAudio.preloadPromise;
}

function acceptRainSoundBuffer(buffer) {
  rainAudio.buffer = buffer;
  root.dataset.rainSoundDuration = buffer.duration.toFixed(3);
  root.dataset.rainSoundLoop = 'seamless-buffer';
  root.dataset.rainSoundLoaded = 'true';
  ensureRainSoundSource(buffer);
  return buffer;
}

function ensureRainSoundSource(buffer = rainAudio.buffer) {
  if (rainAudio.source || !buffer || !rainAudio.context || !rainAudio.gain) {
    return rainAudio.source;
  }
  const source = rainAudio.context.createBufferSource();
  const sourceToken = ++rainAudio.sourceToken;
  source.buffer = buffer;
  source.loop = true;
  source.playbackRate.value = RAIN_SOUND_PLAYBACK_RATE;
  source.connect(rainAudio.gain);
  source.onended = () => {
    if (sourceToken === rainAudio.sourceToken) rainAudio.source = null;
  };
  source.start();
  rainAudio.source = source;
  rainAudio.started = true;
  root.dataset.rainSoundStarted = 'true';
  root.dataset.rainSoundPlaybackRate = RAIN_SOUND_PLAYBACK_RATE.toFixed(1);

  const canBeAudible = rainAudio.enabled && rainAudio.context.state === 'running';
  setRainSoundVolumeImmediately(canBeAudible ? rainSoundTargetVolume() : 0);
  root.dataset.rainSoundAutoplay = canBeAudible ? 'playing' : 'waiting-for-gesture';
  return source;
}

function stopRainSoundPlayback() {
  const source = rainAudio.source;
  if (!source) return;
  rainAudio.source = null;
  ++rainAudio.sourceToken;
  source.onended = null;
  source.stop();
}

function startRainSoundPlayback(intentToken) {
  const context = ensureRainAudioGraph();
  if (!context) {
    rainAudio.enabled = false;
    syncRainSoundButton();
    return;
  }

  // Resume and loading begin in parallel inside the gesture task. A decoded
  // source is kept alive, so later toggles only touch the gain value.
  const resumePromise = context.state === 'running'
    ? Promise.resolve()
    : context.resume();
  const loadPromise = preloadRainSound();
  setRainSoundVolumeImmediately(rainSoundTargetVolume());

  Promise.all([resumePromise, loadPromise]).then(([, buffer]) => {
    if (intentToken !== rainAudio.intentToken || !rainAudio.enabled) return;
    ensureRainSoundSource(buffer);
    setRainSoundVolumeImmediately(rainSoundTargetVolume());
    root.dataset.rainSoundAutoplay = 'playing';
  }).catch(() => {
    if (intentToken !== rainAudio.intentToken) return;
    setRainSoundVolumeImmediately(0);
    root.dataset.rainSoundAutoplay = 'waiting-for-gesture';
  });
}

function setRainSoundEnabled(enabled) {
  const intentToken = ++rainAudio.intentToken;
  rainAudio.enabled = enabled;
  syncRainSoundButton();

  if (enabled) {
    startRainSoundPlayback(intentToken);
  } else {
    setRainSoundVolumeImmediately(0);
  }
}

function startDefaultRainSound() {
  if (!rainAudio.enabled) return;
  startRainSoundPlayback(rainAudio.intentToken);
}



const startRainSoundOnFirstGesture = (event) => {
  if (event.target instanceof Element && event.target.closest('#rain-sound-toggle')) return;
  startDefaultRainSound();
};
document.addEventListener('pointerdown', startRainSoundOnFirstGesture, { capture: true, passive: true });
document.addEventListener('keydown', startRainSoundOnFirstGesture);
document.addEventListener('visibilitychange', () => {
  const { context } = rainAudio;
  if (!context) return;
  if (document.hidden) {
    context.suspend().catch(() => {});
  } else if (rainAudio.enabled && rainAudio.started) {
    context.resume().then(() => {
      if (rainAudio.enabled) setRainSoundVolumeImmediately(rainSoundTargetVolume());
    }).catch(() => {});
  }
});
window.addEventListener('pagehide', () => {
  setRainSoundVolumeImmediately(0);
  stopRainSoundPlayback();
}, { once: true });
root.dataset.rainSoundStarted = 'false';
root.dataset.rainSoundLoaded = 'false';
root.dataset.rainSoundProfile = 'procedurally-generated-rain-loop';
syncRainSoundButton();
root.dataset.rainSoundAutoplay = 'waiting-for-gesture';
preloadRainSound().catch(() => {});
preparedRainAudio?.autoplayPromise?.then(allowed => {
  const userAlreadyActed = navigator.userActivation?.hasBeenActive === true;
  if (!allowed || userAlreadyActed || rainAudio.intentToken !== 0 || rainAudio.enabled) return;
  rainAudio.enabled = true;
  syncRainSoundButton();
  setRainSoundVolumeImmediately(rainSoundTargetVolume());
  root.dataset.rainSoundAutoplay = 'playing';
});

const AXIS_CONFIG = {
  worldHeight: 6.6,
  plotWidth: 17,
  z: RAIN_DEPTH.center + RAIN_DEPTH.thickness + 0.32,
  fadeDuration: 0.2,
  dragThreshold: 5,
  // 图表顶线到「标题 / 动态读数」顶线的距离。右上角的读数面板就挂在这条顶线上，
  // 所以悬停判定必须把它算进图表范围，否则鼠标一移到读数上，读数会被自己的判定关掉。
  headerHeight: 1.42
};

// Runtime rainfall metrics are refreshed whenever the user applies a new day.
// The world-space height stays fixed so changing the data never breaks framing;
// only the value represented by that height and the generated rain layers change.
refreshRainfallMetrics();

// GPU ping-pong heightfield for water ripples — a 2D wave equation solved on the
// GPU (discrete Laplacian) so raindrop impacts spread, interfere and decay as
// real waves, instead of independent procedural arcs.
const RIPPLE_FIELD = {
  // Medium-density field: 2.25x the original texel count, with compact impacts.
  resX: 768,
  resZ: 384,
  xMin: -WORLD.width * 0.55,
  xMax: WORLD.width * 0.55,
  zMin: -WORLD.depth * 0.6,
  zMax: WORLD.frontZ * 1.5
};

const PALETTE = {
  fog: 0x000000,
  pearlBright: new THREE.Color(0xd2d8de),
  pearlMid: new THREE.Color(0x8492a2),
  pearlDark: new THREE.Color(0x424e5c),
  waterBright: new THREE.Color(0xa2b0bc),
  waterMid: new THREE.Color(0x5a6878),
  waterDark: new THREE.Color(0x283040)
};

// 把 JS 数字转成 GLSL 的 float 字面量(整数补 ".0")，用于把 TUNING 的值注入着色器。
const glf = (n) => (Number.isInteger(n) ? `${n}.0` : `${n}`);
const glslVec3 = (rgb) => `vec3(${rgb.map(glf).join(', ')})`;

// ════════════════════════════════════════════════════════════════════════════
// 🎛️  视觉调参面板 TUNING
// ────────────────────────────────────────────────────────────────────────────
// 这里集中了常用视觉参数。改这里 → 保存 → 浏览器自动刷新即可看到效果。
// 每个参数后面都标了：它控制什么、调大会怎样、调小会怎样。
// 快速定位：
// camera 构图视角 | mist 水线雾霭 | pearls 雨珠大小/透明度 | rain 时间分布
// floorGlow 近水提亮 | glint 水面光点 | foam/spray 撞击水花 | water 水面/涟漪
// metalRain 液态金属材质 | waterfallBody 峰值瀑布体积 | waterfallFilaments 瀑布雨丝
// ripple 涟漪物理
// orbit 鼠标旋转/缩放范围
// ════════════════════════════════════════════════════════════════════════════
const TUNING = {
  // ── 图表读数位置 ── 使用世界坐标偏移定位右上角动态读数，随图表一起旋转。
  readout: {
    offsetX: 0,
    offsetY: 0
  },

  // ── 相机视角 ── 整体构图。按屏宽分三档，桌面端用 desktop。
  // pos: 相机位置 [x, y, z]。y 调大更俯视，调小更贴近水面；z 调大更远，调小更近。
  // target: 注视点 [x, y, z]。y 调大画面抬高，调小画面压低。
  // fov: 视野角。调大更广角、空间更夸张；调小更压缩、雨幕更平稳。
  camera: {
    frameTargetYOffset: 1.15,
    desktop: { pos: [-0.27, 3.6, 16.6], target: [-0.27, 2.45, 0.26], fov: 35 },
    tablet: { pos: [-0.27, 4.5, 20.4], target: [-0.27, 3.35, 0.2], fov: 37 },
    mobile: { pos: [-0.27, 4.9, 24.2], target: [-0.27, 3.75, 0.16], fov: 40 }
  },

  // ── 水线雾霭带 ── 水线处的薄雾辉光，跟随降雨强度变化。
  mist: {
    color: 0xabb6bf, // 雾色。调亮会偏银白发光；调暗会更冷、更隐入背景。
    opacity: 0.28, // 雾整体不透明度。调大会水线更亮更奶雾；调小会减少底部光带。
    height: 3.5, // 雾带高度。调大雾往上铺得更高；调小雾更贴近水面。
    reflectionOpacity: 0 // 水线倒影强度。调大会多一层竖向反光；调小会更干净克制。
  },

  // ── 雨珠尺寸 / 透明度 ── 控制珍珠雨点本身。
  pearls: {
    maxPointSize: 1.9, // 近景雨珠最大像素。调大会珠子更圆更显眼；调小会变成更细的雨丝。
    minPointSize: 25.3, // 远景雨珠最小像素。调大会远处仍有颗粒；调小会让远景更暗更轻。
    alpha: 3 // 雨珠整体透明度。调大会雨幕更实；调小会更稀薄、更像雾。
  },

  // ── 雨的时间分布 ── 连续响应真实雨量，控制雨集中在峰值时段，还是铺满全天。
  rain: {
    baseWeight: 0.62, // 低谷权重。只放大已有的小雨，不再给所有非零时段增加固定雨量。
    exponent: 0.05 // 强度曲线偏移。调大会雨更集中在峰值；调小会让分布更均匀。
  },

  // ── 液态金属雨 ── 程序反射带，同时驱动雨珠、雨丝与峰值瀑布。
  metalRain: {
    darkColor: 0x000000,
    midColor: 0xc2cbdb,
    brightColor: 0xfafbff,
    tintColor: 0x0091ff,
    pearlBandFrequency: 5.5,
    pearlBandSpeed: -2.55,
    pearlSpecularPower: 30,
    pearlFresnelStrength: 1.56,
    threadBandDensity: 0.081,
    threadBandSpeed: -0.9,
    threadMirrorStrength: 0.93,
    bodyBandDensity: 5.4,
    bodyBandSpeed: -1.1,
    bodyMirrorStrength: 0.78,
    filamentBandDensity: 2.35,
    filamentBandSpeed: 0.84,
    filamentMirrorStrength: 0.58,
    highlightMirrorStrength: 0.9
  },

  // ── 近水提亮 ── 雨珠靠近水线时的亮度补偿，主要影响底部是否发白。
  floorGlow: {
    base: -0.77, // 普通雨基础提亮。调大会水线附近更亮；调小会压暗底部光带。
    baseByStrength: 0.48, // 普通雨随雨强增加的提亮。调大会暴雨段底部更亮；调小会减少峰值发白。
    lowerCurtain: 0.13, // 低层雨帘额外提亮。调大会底部短雨帘更明显；调小会让它们更隐。
    lowerCurtainByStrength: -0.89, // 低层雨帘随雨强增加的提亮。调大会峰值下沿更亮；调小会更暗。
    downpour: -1.43, // 瀑布雨近水基础提亮。调大会瀑布底部更白；调小会保留暗部。
    downpourByStrength: 0.67, // 瀑布雨随雨强增加的提亮。调大会峰值底部更强；调小会更柔。
    ambient: -0.06 // 背景雨近水提亮。调大会背景水线更有雾光；调小会更干净。
  },

  // ── 水面光点 / 撞击泡沫 ── 水线附近的细碎反光与水花。
  glint: {
    opacity: 3, // 水面光点整体不透明度。调大会水面更闪；调小会更安静。
    alphaMax: 2.13, // 单个光点最亮上限。调大会出现更亮的闪点；调小会削掉刺眼高光。
    maxSize: 62 // 水面光点最大尺寸。调大会反光更大更软；调小会更碎更细。
  },
  foam: {
    opacity: 2.67, // 撞击泡沫透明度。调大会水花白沫更明显；调小会减少落点噪点。
    maxSize: 73.6 // 泡沫粒最大尺寸(px)。调大会白沫更大更软；调小会更细碎。
  },
  spray: {
    opacity: 2.33, // 溅起水滴透明度。调大会飞溅水珠更亮；调小会更低调。
    maxSize: 86.3 // 溅起水滴最大尺寸(px)。调大会飞溅更粗；调小会更针尖。
  },

  // ── 天空 ── 白天乌云。天空穹顶每帧跟随相机，所以永远不会被 camera.far 裁掉。
  // 这一组颜色是“直出”的：着色器结尾自己做了 linear→sRGB，所以十六进制就是屏幕上看到的颜色。
  sky: {
    topColor: 0x6a7787,     // 天顶。乌云压顶的灰蓝；调暗更阴沉，调亮更接近多云。
    horizonColor: 0xd2d6da, // 地平线。云缝里透出来的亮白，主要靠它撑起“白天”的观感。
    cloudColor: 0x535b66,   // 云的暗部。调暗云更厚重，调亮更像薄云。
    cloudCover: 0.58,       // 云量。0 是万里无云，1 是整片阴云。
    cloudScale: 1.35,       // 云团大小。调大云更粗更大块，调小更碎。
    cloudSpeed: 0.0075,     // 云飘移速度。调 0 就完全静止。
    horizonFade: 150,       // 湖面向远处融入天空色的距离（世界单位）。调小水天交界更近，调大湖面更开阔。
    fogColor: 0x9aa4ae,     // 远景雾色。要贴近地平线色，远景才会自然融进天空而不是发黑。
    fogDensity: 0.007       // 雾的浓度。调大远景更朦胧，调小能看得更远。
  },

  // ── 水面底色 / 涟漪显影 ──
  // 注意：水面是自定义 ShaderMaterial，而它没有 #include <colorspace_fragment>，
  // 所以着色器输出的是【线性值】、会被直接当 sRGB 显示 —— 视觉上被压暗约 2.2 次幂。
  // 下面两个十六进制是「补偿之后」的值，看起来偏亮，但在屏幕上才是正常的深湖蓝。
  water: {
    deepColor: 0x4a5865,    // 深水底色。屏幕上约 rgb(18,26,35)，湖面因此有“底”而不是一块纯黑。
    surfaceColor: 0x92a0b0, // 表层色，用于近端渐变。屏幕上约 rgb(73,90,111)，近端能读出层次。
    roughness: 1,           // 磨砂程度。0 接近镜面，1 更柔和、更漫反射。
    specularStrength: 2.5,  // 镜面高光强度。
    rippleHighlight: 3,     // 波峰反光强度。
    surfaceOpacity: 5,      // 水面基础浓度；过高会产生磨砂白雾感。
    wavePrimary: 0.34,      // 大波顶点位移幅度（波长约 120 世界单位）。0 是纹丝不动的镜面。
    waveSecondary: 0.12,    // 中波顶点位移幅度。叠在大波上做中等尺度的起伏。
    waveNormal: 0.28,       // 法线层面的细节波纹强度。只影响光泽、不改动几何；调大波光更碎更明显。
    reflStrength: 0.5,      // 雨柱倒影亮度。调大水面镜像更亮(竖条更明显)；调小更隐入黑底。
    reflFade: 2.15,         // 倒影长度(世界单位)。调大倒影拖得更远；调小更紧贴水线。
    rearFadeNearZ: -110,    // 后缘渐隐起点。湖面扩大后，边缘必须退到很远处才不会露馅。
    rearFadeFarZ: -195      // 后缘完全透明的位置，避免看见水面的硬边。
  },

  // ── 峰值瀑布体积 ── 暴雨峰值处的雾状水体和明暗纹理。
  waterfallBody: {
    deepColor: 0x1a1e23, // 暗部色。调亮会减少深色缝隙；调暗会瀑布更有阴影。
    midColor: 0xccd4db, // 中间色。调亮会瀑布整体更白；调暗会更冷灰。
    brightColor: 0x0a0c0f, // 亮部色。调亮会峰值更银白；调暗会减少发光感。
    broadSway: 0, // 大尺度摆动。调大会瀑布左右漂动更明显；调小会更垂直。
    fineSway: 0, // 细节摆动。调大会边缘更活；调小会更稳。
    streakFrequency: 38.1, // 主雨丝密度。调大会竖纹更细密；调小会变成更宽的水柱。
    fineStreakFrequency: 499.6, // 细雨丝密度。调大会细纹更多；调小会更干净。
    streakSharpness: 0.05, // 主雨丝锐度。调大会丝更硬更分明；调小会更糊。
    fineStreakSharpness: 40, // 细雨丝锐度。调大会细线更脆；调小会更柔。
    fineStreakWeight: -2, // 细雨丝占比。调大会纹理更碎；调小会只剩大体积。
    baseMass: 0, // 底部水体质量。调大会底部更厚更亮；调小会更轻。
    riseMass: 0.64, // 向上雾化质量。调大会雾体上升更满；调小会只亮底部。
    cloudLow: 0.68, // 云团暗部系数。调大会暗区变亮；调小会增强明暗对比。
    cloudHigh: 1.05, // 云团亮部系数。调大会亮团更亮；调小会更平。
    gapDarkness: 0.05, // 雨丝缝隙亮度。调大会缝隙变亮更糊；调小会黑缝更清楚。
    streakBrightness: 1.4, // 雨丝亮度。调大会竖向水流更亮；调小会削弱雨丝感。
    bottomFeather: 0.2, // 底边羽化。调大会底部更空、更少波浪伪影；调小会更贴水面。
    opacity: 3 // 体积整体透明度。调大会峰值更亮更密；调小会更轻更透。
  },

  // ── 峰值瀑布雨丝 ── 叠在体积上的竖向水流线。
  waterfallFilaments: {
    edgeWidth: 3, // 普通雨丝宽度。调大会雨丝更粗更软；调小会更细更锐。
    highlightEdgeWidth: 1.75, // 高光雨丝宽度。调大会高光更宽；调小会只留细亮线。
    opacity: 0, // 普通雨丝透明度。调大会瀑布线条更密；调小会体积感更软。
    highlightOpacity: 0.28, // 高光雨丝透明度。调大会前景亮线更强；调小会减少闪烁。
    bottomMistOpacity: 5 // 雨丝底部雾化。调大会落点更白雾；调小会底部更清爽。
  },

  // ── 水面涟漪(GPU 高度场波动) ──
  ripple: {
    gain: 0.7,     // 涟漪亮度增益。0 会把波峰反光完全关掉（湖面读作死平的镜子）；0.7 能让雨滴环纹看得见。调大会更亮更明显；调小会更隐。
    damping: 0.9999, // 波衰减。调大会波传播更久；调小会更快消失。
    dropRain: 1.51, // 普通雨滴涟漪强度。调大会每滴雨更容易出圈；调小会更平静。
    dropClick: 0.95, // 点击涟漪强度。
    displace: 0.012 // 涟漪顶点位移幅度，太大会在掠射角下产生条纹。
  },

  // ── 3D 轨道相机(鼠标拖拽旋转 + 滚轮缩放) ──
  orbit: {
    minDistance: 9, // 滚轮最近距离。调小可以拉得更近；调大会限制近距离观察。
    maxDistance: 30, // 滚轮最远距离。调大可以退得更远；调小会锁住构图。
    azimuthDeg: 60, // 左右旋转范围。调大会能转到更多侧面；调小会更接近固定正面。
    minPolarDeg: 52, // 最俯视角。调小更能从上往下看水面；调大更低视角。
    maxPolarDeg: 93, // 最仰视角。调大可更贴水面仰看；调小会限制低角度。
    damping: 0.08 // 旋转惯性阻尼。调大会拖拽更黏更慢；调小会更灵敏。
  }
};

const DEFAULT_TUNING = JSON.parse(JSON.stringify(TUNING));

// 面板保存的「需刷新生效」参数，在 shader 构建前覆盖
;(function () {
  if (!ENABLE_TUNING_CONSOLE) return;
  const saved = localStorage.getItem('rf-tuning');
  if (!saved) return;
  try {
    for (const [path, val] of Object.entries(JSON.parse(saved))) {
      // 旧版读数是屏幕悬浮层，不继承像素定位值到新的三维世界坐标。
      if (path === 'readout.right' || path === 'readout.bottom' || path === 'readout.top') continue;
      const p = path.split('.'); let o = TUNING;
      for (let i = 0; i < p.length - 1; i++) o = o[p[i]];
      o[p[p.length - 1]] = val;
    }
    // Initial and reset views must remain exactly front-on even when an older
    // local tuning snapshot contains the former low, upward-looking camera.
    for (const profileName of ['desktop', 'tablet', 'mobile']) {
      const profile = TUNING.camera[profileName];
      profile.pos[0] = profile.target[0];
      profile.pos[1] = profile.target[1] + TUNING.camera.frameTargetYOffset;
    }
  } catch {}
})();

const GLOBAL_THEME_STORAGE_KEY = 'rf-global-theme-v1';

function normalizeThemeHex(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(0xffffff, Math.round(value)));
  }
  const text = String(value ?? '').trim().replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(text) ? parseInt(text, 16) : 0x000000;
}

function themeHexCss(value) {
  return `#${(Number(value) >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
}

function themeRgb(value) {
  const numeric = Number(value) >>> 0;
  return `${(numeric >> 16) & 255}, ${(numeric >> 8) & 255}, ${numeric & 255}`;
}

function mixThemeColor(from, to, amount) {
  return new THREE.Color(from).lerp(new THREE.Color(to), clamp(amount, 0, 1)).getHex();
}

function deriveGlobalTheme(baseColor) {
  const base = normalizeThemeHex(baseColor);
  if (base === 0x000000) {
    return {
      base,
      backgroundTop: 0x000000,
      backgroundMid: 0x000000,
      backgroundBottom: 0x000000,
      fog: 0x000000,
      shadow: 0x000000,
      panel: 0x080c14,
      panelTop: 0x1c2230,
      panelBottom: 0x060910,
      accent: 0x0091ff,
      textStrong: 0xfafbff,
      textMid: 0xc2cbdb,
      textSoft: 0x8f9db8,
      axisLine: 0xe5e9f0,
      axisTick: 0xc2cbdb,
      axisStrong: 0xffffff,
      axisTime: 0xdce2eb,
      axisValue: 0xf4f6fa,
      axisUnit: 0xb8c1cf,
      metalDark: 0x000000,
      metalMid: 0xc2cbdb,
      metalBright: 0xfafbff,
      metalTint: 0x0091ff,
      waterDeep: 0x000000,
      waterSurface: 0x2b3240,
      mist: 0xabb6bf,
      waterfallDeep: 0x1a1e23,
      waterfallMid: 0xccd4db,
      waterfallBright: 0x0a0c0f
    };
  }

  const linear = new THREE.Color(base);
  const luminance = linear.r * 0.2126 + linear.g * 0.7152 + linear.b * 0.0722;
  const contrast = luminance > 0.42 ? 0x000000 : 0xffffff;
  // Controls stay on a dark frosted surface even when the selected scene
  // color is bright; the chart itself still switches contrast automatically.
  const panel = mixThemeColor(base, 0x000000, 0.7);

  return {
    base,
    backgroundTop: mixThemeColor(base, contrast, 0.035),
    backgroundMid: base,
    backgroundBottom: mixThemeColor(base, 0x000000, 0.24),
    fog: mixThemeColor(base, 0x000000, 0.18),
    shadow: 0x000000,
    panel,
    panelTop: mixThemeColor(panel, 0xffffff, 0.09),
    panelBottom: mixThemeColor(panel, 0x000000, 0.38),
    accent: mixThemeColor(base, contrast, 0.56),
    textStrong: mixThemeColor(base, 0xffffff, 0.95),
    textMid: mixThemeColor(base, 0xffffff, 0.76),
    textSoft: mixThemeColor(base, 0xffffff, 0.58),
    axisLine: mixThemeColor(base, contrast, 0.9),
    axisTick: mixThemeColor(base, contrast, 0.72),
    axisStrong: mixThemeColor(base, contrast, 0.98),
    axisTime: mixThemeColor(base, contrast, 0.84),
    axisValue: mixThemeColor(base, contrast, 0.94),
    axisUnit: mixThemeColor(base, contrast, 0.66),
    metalDark: mixThemeColor(base, contrast, 0.08),
    metalMid: mixThemeColor(base, contrast, 0.64),
    metalBright: mixThemeColor(base, contrast, 0.96),
    metalTint: mixThemeColor(base, contrast, 0.34),
    waterDeep: mixThemeColor(base, contrast, 0.035),
    waterSurface: mixThemeColor(base, contrast, 0.24),
    mist: mixThemeColor(base, contrast, 0.62),
    waterfallDeep: mixThemeColor(base, contrast, 0.12),
    waterfallMid: mixThemeColor(base, contrast, 0.68),
    waterfallBright: mixThemeColor(base, contrast, 0.92)
  };
}

function loadGlobalThemeColor() {
  if (!ENABLE_TUNING_CONSOLE) return 0x000000;
  try {
    return normalizeThemeHex(localStorage.getItem(GLOBAL_THEME_STORAGE_KEY) || '#000000');
  } catch {
    return 0x000000;
  }
}

function globalThemeTuningValues(theme) {
  return {
    'metalRain.darkColor': theme.metalDark,
    'metalRain.midColor': theme.metalMid,
    'metalRain.brightColor': theme.metalBright,
    'metalRain.tintColor': theme.metalTint,
    'water.deepColor': theme.waterDeep,
    'water.surfaceColor': theme.waterSurface,
    'mist.color': theme.mist,
    'waterfallBody.deepColor': theme.waterfallDeep,
    'waterfallBody.midColor': theme.waterfallMid,
    'waterfallBody.brightColor': theme.waterfallBright
  };
}

function applyGlobalThemeCss(theme) {
  const style = document.documentElement.style;
  const themedSurfaceAlpha = theme.base === 0x000000 ? 0.72 : 0.9;
  const themedSurfaceBottomAlpha = theme.base === 0x000000 ? 0.8 : 0.94;
  style.setProperty('--background-top', themeHexCss(theme.backgroundTop));
  style.setProperty('--background-mid', themeHexCss(theme.backgroundMid));
  style.setProperty('--background-bottom', themeHexCss(theme.backgroundBottom));
  style.setProperty('--model-metal-dark', themeHexCss(theme.metalDark));
  style.setProperty('--model-metal-mid', themeHexCss(theme.metalMid));
  style.setProperty('--model-metal-bright', themeHexCss(theme.metalBright));
  style.setProperty('--model-metal-tint', themeHexCss(theme.metalTint));
  style.setProperty('--theme-highlight-rgb', themeRgb(theme.textMid));
  style.setProperty('--theme-shadow-rgb', themeRgb(theme.shadow));
  style.setProperty('--theme-panel-rgb', themeRgb(theme.panel));
  style.setProperty('--panel-surface-top', `rgba(${themeRgb(theme.panelTop)}, ${themedSurfaceAlpha})`);
  style.setProperty('--panel-surface-bottom', `rgba(${themeRgb(theme.panelBottom)}, ${themedSurfaceBottomAlpha})`);
  style.setProperty('--panel-border', `rgba(${themeRgb(theme.textStrong)}, 0.17)`);
  style.setProperty('--panel-divider', `rgba(${themeRgb(theme.textStrong)}, 0.1)`);
  style.setProperty('--panel-card-border', `rgba(${themeRgb(theme.textStrong)}, 0.13)`);
  style.setProperty('--panel-control-bg', `rgba(${themeRgb(theme.textStrong)}, 0.055)`);
  style.setProperty('--panel-control-hover', `rgba(${themeRgb(theme.textStrong)}, 0.1)`);
  style.setProperty('--panel-text-main', `rgba(${themeRgb(theme.textStrong)}, 0.94)`);
  style.setProperty('--panel-text-soft', `rgba(${themeRgb(theme.textMid)}, 0.58)`);
  style.setProperty('--panel-accent', `rgba(${themeRgb(theme.accent)}, 0.78)`);
  style.setProperty('--panel-accent-soft', `rgba(${themeRgb(theme.accent)}, 0.14)`);
}

function applyGlobalThemePalette(theme) {
  // 白天湖景：轴刻度与文字统一用白色 —— 试过天空蓝，压在灰白天穹上反而不如白字清楚。
  // 刻度数字（12.8 / 6.4）用的是 axisValue，别只改 axisTick 漏掉它。
  // 浅色文字靠 createAxisLabel 里的深色柔光托底；初始化和切全局主题都会经过这里。
  theme.axisValue = 0xffffff;
  theme.axisLine = 0xdfe6ee;
  theme.axisTick = 0xffffff;
  theme.axisStrong = 0xffffff;
  theme.axisTime = 0xf2f6fb;
  theme.axisUnit = 0xe9eef6;
  PALETTE.fog = theme.fog;
  PALETTE.pearlBright.setHex(theme.metalBright);
  PALETTE.pearlMid.setHex(theme.metalMid);
  PALETTE.pearlDark.setHex(theme.metalDark);
  PALETTE.waterBright.setHex(theme.mist);
  PALETTE.waterMid.setHex(theme.waterSurface);
  PALETTE.waterDark.setHex(theme.waterDeep);
}

let globalThemeColor = loadGlobalThemeColor();
let globalThemePalette = deriveGlobalTheme(globalThemeColor);
applyGlobalThemeCss(globalThemePalette);
applyGlobalThemePalette(globalThemePalette);

function applyReadoutPosition() {
  const offsetX = Number(TUNING.readout.offsetX) || 0;
  const offsetY = Number(TUNING.readout.offsetY) || 0;
  if (axisSystem?.readout) {
    axisSystem.readout.mesh.position.set(
      axisSystem.readout.anchorX + offsetX,
      axisSystem.readout.anchorY + offsetY,
      axisSystem.readout.anchorZ
    );
  }
  root.dataset.readoutMode = 'world-space-rotating';
  root.dataset.readoutOffsetX = String(offsetX);
  root.dataset.readoutOffsetY = String(offsetY);
  delete root.dataset.readoutBottom;
  delete root.dataset.readoutRight;
  delete root.dataset.readoutTop;
}

const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function isPhoneLandscapeViewport() {
  const shortEdge = Math.min(window.innerWidth, window.innerHeight);
  const longEdge = Math.max(window.innerWidth, window.innerHeight);
  return window.innerWidth > window.innerHeight && shortEdge <= 500 && longEdge <= 1000;
}

function syncRainSoundButton() {
  root.dataset.rainSound = rainAudio.enabled ? 'on' : 'off';
  options.onRainSoundChange?.(rainAudio.enabled);
}

function toggleRainSound() {
  setRainSoundEnabled(!rainAudio.enabled);
}


function targetRendererPixelRatio() {
  const cap = isPhoneLandscapeViewport() ? 2 : isCoarsePointer ? 1.65 : 1.75;
  return Math.min(window.devicePixelRatio || 1, cap);
}

// Mobile screens render far fewer pixels than the desktop canvas, so they can
// keep the same scene density without the old, visibly sparse particle tier.
// Only cap raster resolution slightly lower to control fill-rate and heat.
let pixelRatio = targetRendererPixelRatio();

// 🎛️ 粒子密度 / 性能参数。左边是触屏设备，右边是桌面设备。
// chains: 主雨串数量，调大会雨幕更密但更耗性能。
// ambientChains: 背景细雨数量，调大会全天氛围更满。
// downpourChains: 暴雨峰值雨串数量，调大会峰值段更像瀑布。
// waterfallFilaments: 瀑布竖向雨丝数量，调大会峰值线条更丰富。
// waterGlints: 水面反光点数量，调大会水面更闪。
// impactPearls: 撞击水花粒子池大小，调大会水花更不容易断档。
// impactEventsPerSecond: 每秒水花事件预算，调大会落点更热闹。
// rippleEventsPerSecond: 每秒涟漪事件预算，调大会水面环纹更多。
// maxRipples: 兼容旧数据标记，当前 GPU 涟漪系统主要使用 rippleEventsPerSecond。
const QUALITY = isCoarsePointer
  ? {
    chains: 2000,
    ambientChains: 800,
    downpourChains: 1400,
    waterfallFilaments: 1900,
    waterGlints: 0,
    impactPearls: 3100,
    impactEventsPerSecond: 160,
    rippleEventsPerSecond: 28,
    maxRipples: 22
  }
  : {
    chains: 2000,
    ambientChains: 800,
    downpourChains: 1400,
    waterfallFilaments: 1900,
    waterGlints: 0,
    impactPearls: 7600,
    impactEventsPerSecond: 520,
    rippleEventsPerSecond: 60,
    maxRipples: 42
  };

const DEFAULT_QUALITY = { ...QUALITY };
;(function () {
  if (!ENABLE_TUNING_CONSOLE) return;
  try {
    const saved = JSON.parse(localStorage.getItem('rf-quality') || '{}');
    for (const [key, value] of Object.entries(saved)) {
      if (key in QUALITY && Number.isFinite(Number(value))) {
        QUALITY[key] = Math.max(0, Math.round(Number(value)));
      }
    }
  } catch {}
})();

const FEATURES = {
  showAxes: true,
  showWater: true,
  showMist: true,
  showRainLines: true,
  showPearls: true,
  showWaterGlints: true,
  showImpacts: SPLASH_IMPACTS_ENABLED,
  showPeakWaterfall: false
};
const DEFAULT_FEATURES = { ...FEATURES };
;(function () {
  if (!ENABLE_TUNING_CONSOLE) return;
  try {
    const saved = JSON.parse(localStorage.getItem('rf-features') || '{}');
    for (const [key, value] of Object.entries(saved)) {
      if (key in FEATURES) FEATURES[key] = Boolean(value);
    }
  } catch {}
})();
FEATURES.showImpacts = FEATURES.showImpacts && SPLASH_IMPACTS_ENABLED;

const state = {
  pointerActive: false,
  pointerDown: false,
  pointerMoved: false,
  pointerHour: 18,
  pointerWorld: new THREE.Vector3(),
  pointerNdc: new THREE.Vector2(),
  pointerClient: { x: 0, y: 0 },
  downClient: { x: 0, y: 0 },
  downView: { x: 0, y: 0 },
  activePointerId: null,
  selectedHour: 18,
  selectedActive: false,
  burst: 0,
  lastHoverRippleAt: -1,
  view: { x: 0, y: 0, targetX: 0, targetY: 0 },
  readoutKey: ''
};

let renderer;
try {
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance'
  });
  root.dataset.webglStatus = 'ready';
} catch (error) {
  showWebGLFallback(i18n('webglUnavailable'));
  root.dataset.webglStatus = 'unavailable';
  throw error;
}
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
root.dataset.rendererPixelRatio = pixelRatio.toFixed(2);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.domElement.setAttribute('aria-label', i18n('canvasAria'));
root.appendChild(renderer.domElement);
renderer.domElement.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  root.dataset.webglStatus = 'lost';
  showWebGLFallback(i18n('webglInterrupted'));
});
renderer.domElement.addEventListener('webglcontextrestored', () => {
  root.dataset.webglStatus = 'ready';
  hideWebGLFallback();
});

const scene = new THREE.Scene();
// 白天湖景：雾必须跟着天空走，否则远景会糊成一团黑。
// PALETTE.fog 会被全局主题覆盖（见 applyGlobalThemePalette），所以这里显式取天空的雾色，
// 保证不管主题怎么变，远景都是亮的。
scene.fog = new THREE.FogExp2(TUNING.sky.fogColor, TUNING.sky.fogDensity);

const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 110);
const cameraBase = new THREE.Vector3();
const cameraTargetBase = new THREE.Vector3();
const cameraTarget = new THREE.Vector3();
const CAMERA_FIT_MARGIN = 0.04;
let chartCameraFitBounds = null;
let controls = null;
applyCameraPreset();

// 3D 轨道相机：拖拽旋转 + 滚轮缩放，范围在 TUNING.orbit 限制以保持构图。
controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = TUNING.orbit.damping;
controls.enablePan = false;
controls.enableZoom = true;
controls.rotateSpeed = 0.55;
controls.zoomSpeed = 0.8;
controls.minDistance = TUNING.orbit.minDistance;
controls.maxDistance = TUNING.orbit.maxDistance;
controls.minPolarAngle = THREE.MathUtils.degToRad(TUNING.orbit.minPolarDeg);
controls.maxPolarAngle = THREE.MathUtils.degToRad(TUNING.orbit.maxPolarDeg);
controls.minAzimuthAngle = -THREE.MathUtils.degToRad(TUNING.orbit.azimuthDeg);
controls.maxAzimuthAngle = THREE.MathUtils.degToRad(TUNING.orbit.azimuthDeg);
controls.target.copy(cameraTargetBase);
controls.update();

const raycaster = new THREE.Raycaster();
const pointerPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -WATER_LEVEL);
const chartPointerPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -AXIS_CONFIG.z);
const chartPointerWorld = new THREE.Vector3();
const clock = new THREE.Clock();
const rainPlotBounds = new THREE.Vector4(0, 1, 0, 1);
const rainPlotFeather = new THREE.Vector3(0.002, 0, 0.002);
const rainViewport = new THREE.Vector2();
const rainPlotClip = { value: 0 };

const worldGroup = new THREE.Group();
worldGroup.name = 'pearl-rainfall-visualization';
scene.add(worldGroup);

let axisSystem = createAxisSystem();
chartCameraFitBounds = axisSystem.fitBounds.clone();
applyCameraPreset();
applyReadoutPosition();
syncAxisLabelScale(axisSystem);
updateRainPlotMask();

// 天空穹顶直接挂在 scene 上，不进 worldGroup：它每帧跟随相机，
// 不应该受 worldGroup 的任何变换影响。
const skyDome = createSkyDome();
scene.add(skyDome);

const waterPlane = createWaterPlane();
const poolFloor = createPoolFloor();
let mistBand = createMistBand();
// 水面倒影复用 mistBand 的降雨强度 LUT，实现与上方雨柱逐列对齐的镜像
waterPlane.material.uniforms.uRainLut.value = mistBand.lut;
waterPlane.material.uniforms.uLutBounds.value.set(mistBand.lutXMin, mistBand.lutSpan);
const initialDry = rainfallMax <= 0;
const initialHasPeaks = peakWaterfallRanges.length > 0;
const initialCapacityScale = initialDry ? 0 : rainCapacityResponse(rainfallMax);
let rainChains = createRainChainSystem(
  initialDry ? 0 : Math.max(1, Math.round(QUALITY.chains * initialCapacityScale)),
  initialDry ? 0 : Math.max(1, Math.round(QUALITY.ambientChains * Math.pow(initialCapacityScale, 1.08))),
  initialDry || !initialHasPeaks ? 0 : QUALITY.downpourChains
);
let peakWaterfall = createPeakWaterfallSystem(
  initialDry || !initialHasPeaks ? 0 : QUALITY.waterfallFilaments,
  rainChains.data
);
let waterGlints = createWaterGlintSystem(initialDry ? 0 : QUALITY.waterGlints);
let impactPearls = createImpactPearlSystem(
  !initialDry && SPLASH_IMPACTS_ENABLED ? QUALITY.impactPearls : 0,
  !initialDry && SPLASH_IMPACTS_ENABLED ? QUALITY.impactEventsPerSecond : 0,
  QUALITY.rippleEventsPerSecond
);
const rippleSystem = createRippleFieldSystem(renderer);

// 峰值瀑布（平滑体积"雾柱"）会与点状雨形成前后分层，让雨幕显得"分开"。
// 关掉后整个降雨是一带统一的点状雨幕。需要时改回 true 即可恢复。
worldGroup.add(
  axisSystem.group,
  poolFloor,
  waterPlane,
  mistBand.mesh,
  rainChains.lines,
  rainChains.points,
  peakWaterfall.group,
  waterGlints.points,
  impactPearls.foam,
  impactPearls.droplets,
  impactPearls.crowns
);

applyFeatureVisibility();

if (prefersReducedMotion) {
  if (SPLASH_IMPACTS_ENABLED) seedReducedMotionImpacts(impactPearls);
  updateRainChains(rainChains, 0, 0);
  if (FEATURES.showPeakWaterfall) updatePeakWaterfall(peakWaterfall, 0);
  updateWaterGlints(waterGlints, 0, 0);
  if (SPLASH_IMPACTS_ENABLED) updateImpactPearls(impactPearls, 0, 0);
}

syncRuntimeDatasets();
updateDomState();

renderer.domElement.addEventListener('pointerdown', onPointerDown, { passive: true });
renderer.domElement.addEventListener('pointermove', onPointerMove, { passive: true });
renderer.domElement.addEventListener('pointerup', onPointerUp, { passive: true });
renderer.domElement.addEventListener('pointercancel', onPointerCancel, { passive: true });
renderer.domElement.addEventListener('pointerleave', onPointerLeave, { passive: true });
renderer.domElement.addEventListener('dblclick', resetView);
document.addEventListener('pointermove', (event) => {
  if (event.target !== renderer.domElement) clearChartHover();
}, { passive: true });
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', onResize);
window.visualViewport?.addEventListener('resize', onResize);
window.addEventListener('blur', onInteractionInterrupted);

root.dataset.releaseChannel = ENABLE_TUNING_CONSOLE ? 'development' : 'public';
animate();

  // ══════════════════════════════════════════════════════════════════════
  // 调参注册表：由原 initTuningPanelV2 里与「参数定义 / 应用 / 持久化」相关的
  // 部分抽出。UI 完全交给 Vue 组件渲染，这里只提供数据与提交入口。
  // ══════════════════════════════════════════════════════════════════════
  const STORAGE = {
    tuning: 'rf-tuning',
    quality: 'rf-quality',
    feature: 'rf-features'
  };

  const activeCameraProfile = cameraProfileName;

  function getNamespace(path, defaults = false) {
    if (path.startsWith('quality.')) {
      return { object: defaults ? DEFAULT_QUALITY : QUALITY, keys: path.slice(8).split('.') };
    }
    if (path.startsWith('feature.')) {
      return { object: defaults ? DEFAULT_FEATURES : FEATURES, keys: path.slice(8).split('.') };
    }
    return { object: defaults ? DEFAULT_TUNING : TUNING, keys: path.split('.') };
  }

  function readPath(path, defaults = false) {
    const { object, keys } = getNamespace(path, defaults);
    return keys.reduce((value, key) => value[key], object);
  }

  function writePath(path, value) {
    const { object, keys } = getNamespace(path);
    let target = object;
    for (let i = 0; i < keys.length - 1; i += 1) target = target[keys[i]];
    target[keys[keys.length - 1]] = value;
  }

  function flattenObject(object, prefix = '', output = {}) {
    for (const [key, value] of Object.entries(object)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object') flattenObject(value, path, output);
      else output[path] = value;
    }
    return output;
  }

  function persistNamespace(path) {
    try {
      if (path.startsWith('quality.')) {
        localStorage.setItem(STORAGE.quality, JSON.stringify(QUALITY));
      } else if (path.startsWith('feature.')) {
        localStorage.setItem(STORAGE.feature, JSON.stringify(FEATURES));
      } else {
        localStorage.setItem(STORAGE.tuning, JSON.stringify(flattenObject(TUNING)));
      }
    } catch {}
  }

  function sanitizeNumber(path, raw, fallback) {
    let value = Number(raw);
    if (!Number.isFinite(value)) return fallback;

    if (path.startsWith('quality.')) return Math.max(0, Math.round(value));
    if (path.endsWith('.fov')) return clamp(value, 1, 179);
    if (path === 'ripple.damping') return clamp(value, 0, 0.99999);
    if (path === 'orbit.damping') return clamp(value, 0, 1);
    if (path === 'orbit.minPolarDeg' || path === 'orbit.maxPolarDeg') {
      return clamp(value, 0.1, 179.9);
    }
    if (path === 'orbit.minDistance' || path === 'orbit.maxDistance') {
      return Math.max(0.01, value);
    }
    if (path === 'readout.offsetX' || path === 'readout.offsetY') return value;
    if (path === 'mist.height') return Math.max(0.001, value);
    if (/PointSize|maxSize$|edgeWidth$|bottomFeather$/.test(path)) return Math.max(0, value);
    return value;
  }

  const bodyUniforms = {
    'waterfallBody.broadSway': 'uBroadSway',
    'waterfallBody.fineSway': 'uFineSway',
    'waterfallBody.streakFrequency': 'uStreakFrequency',
    'waterfallBody.fineStreakFrequency': 'uFineStreakFrequency',
    'waterfallBody.streakSharpness': 'uStreakSharpness',
    'waterfallBody.fineStreakSharpness': 'uFineStreakSharpness',
    'waterfallBody.fineStreakWeight': 'uFineStreakWeight',
    'waterfallBody.baseMass': 'uBaseMass',
    'waterfallBody.riseMass': 'uRiseMass',
    'waterfallBody.cloudLow': 'uCloudLow',
    'waterfallBody.cloudHigh': 'uCloudHigh',
    'waterfallBody.gapDarkness': 'uGapDarkness',
    'waterfallBody.streakBrightness': 'uStreakBrightness',
    'waterfallBody.bottomFeather': 'uBottomFeather',
    'waterfallBody.opacity': 'uOpacity'
  };

  function applyLive(path, value) {
    if (path.startsWith('feature.')) {
      applyFeatureVisibility();
      return;
    }

    if (path.startsWith('camera.')) {
      if (path === 'camera.frameTargetYOffset' || path.split('.')[1] === activeCameraProfile()) {
        applyCameraPreset();
      }
      return;
    }

    const bodyUniform = bodyUniforms[path];
    if (bodyUniform) {
      peakWaterfall.materials[0].uniforms[bodyUniform].value = value;
      return;
    }

    switch (path) {
      case 'readout.offsetX':
      case 'readout.offsetY': applyReadoutPosition(); break;
      case 'mist.color': mistBand.material.uniforms.uColor.value.setHex(value); break;
      case 'mist.opacity': mistBand.material.uniforms.uOpacity.value = value; break;
      case 'mist.height': updateMistBandHeight(mistBand, value); break;
      case 'mist.reflectionOpacity': mistBand.material.uniforms.uReflOpacity.value = value; break;
      case 'pearls.maxPointSize': rainChains.points.material.uniforms.uMaxPointSize.value = value; break;
      case 'pearls.minPointSize': rainChains.points.material.uniforms.uMinPointSize.value = value; break;
      case 'pearls.alpha': rainChains.points.material.uniforms.uBeadAlpha.value = value; break;
      case 'metalRain.darkColor':
        rainChains.points.material.uniforms.uMetalDark.value.setHex(value);
        rainChains.lines.material.uniforms.uMetalDark.value.setHex(value);
        peakWaterfall.materials.forEach(material => material.uniforms.uDeep.value.setHex(value));
        break;
      case 'metalRain.midColor':
        rainChains.points.material.uniforms.uMetalMid.value.setHex(value);
        rainChains.lines.material.uniforms.uMetalMid.value.setHex(value);
        peakWaterfall.materials.forEach(material => material.uniforms.uMid.value.setHex(value));
        break;
      case 'metalRain.brightColor':
        rainChains.points.material.uniforms.uMetalBright.value.setHex(value);
        rainChains.lines.material.uniforms.uMetalBright.value.setHex(value);
        peakWaterfall.materials.forEach(material => material.uniforms.uBright.value.setHex(value));
        break;
      case 'metalRain.tintColor': rainChains.points.material.uniforms.uMetalTint.value.setHex(value); break;
      case 'metalRain.pearlBandFrequency': rainChains.points.material.uniforms.uPearlBandFrequency.value = value; break;
      case 'metalRain.pearlBandSpeed': rainChains.points.material.uniforms.uPearlBandSpeed.value = value; break;
      case 'metalRain.pearlSpecularPower': rainChains.points.material.uniforms.uPearlSpecularPower.value = value; break;
      case 'metalRain.pearlFresnelStrength': rainChains.points.material.uniforms.uPearlFresnelStrength.value = value; break;
      case 'metalRain.threadBandDensity': rainChains.lines.material.uniforms.uThreadBandDensity.value = value; break;
      case 'metalRain.threadBandSpeed': rainChains.lines.material.uniforms.uThreadBandSpeed.value = value; break;
      case 'metalRain.threadMirrorStrength': rainChains.lines.material.uniforms.uThreadMirrorStrength.value = value; break;
      case 'metalRain.bodyBandDensity': peakWaterfall.materials[0].uniforms.uBodyBandDensity.value = value; break;
      case 'metalRain.bodyBandSpeed': peakWaterfall.materials[0].uniforms.uBodyBandSpeed.value = value; break;
      case 'metalRain.bodyMirrorStrength': peakWaterfall.materials[0].uniforms.uBodyMirrorStrength.value = value; break;
      case 'metalRain.filamentBandDensity':
        peakWaterfall.materials[1].uniforms.uFilamentBandDensity.value = value;
        peakWaterfall.materials[2].uniforms.uFilamentBandDensity.value = value;
        break;
      case 'metalRain.filamentBandSpeed':
        peakWaterfall.materials[1].uniforms.uFilamentBandSpeed.value = value;
        peakWaterfall.materials[2].uniforms.uFilamentBandSpeed.value = value;
        break;
      case 'metalRain.filamentMirrorStrength':
        peakWaterfall.materials[1].uniforms.uFilamentMirrorStrength.value = value;
        break;
      case 'metalRain.highlightMirrorStrength':
        peakWaterfall.materials[2].uniforms.uFilamentMirrorStrength.value = value;
        break;
      case 'glint.opacity': waterGlints.points.material.uniforms.uOpacity.value = value; break;
      case 'glint.maxSize': waterGlints.points.material.uniforms.uMaxSize.value = value; break;
      case 'foam.opacity': impactPearls.foam.material.uniforms.uOpacity.value = value; break;
      case 'foam.maxSize': impactPearls.foam.material.uniforms.uMaxSize.value = value; break;
      case 'spray.opacity': impactPearls.droplets.material.uniforms.uOpacity.value = value; break;
      case 'spray.maxSize': impactPearls.droplets.material.uniforms.uMaxSize.value = value; break;
      case 'water.deepColor':
        waterPlane.material.uniforms.uColorDeep.value.setHex(value);
        poolFloor.material.uniforms.uColor.value.setHex(value);
        break;
      case 'water.surfaceColor': waterPlane.material.uniforms.uColorSurface.value.setHex(value); break;
      case 'water.roughness': waterPlane.material.uniforms.uRoughness.value = value; break;
      case 'water.specularStrength': waterPlane.material.uniforms.uSpecularStrength.value = value; break;
      case 'water.rippleHighlight': waterPlane.material.uniforms.uRippleHighlight.value = value; break;
      case 'water.surfaceOpacity': waterPlane.material.uniforms.uSurfaceOpacity.value = value; break;
      case 'water.wavePrimary': waterPlane.material.uniforms.uWavePrimary.value = value; break;
      case 'water.waveSecondary': waterPlane.material.uniforms.uWaveSecondary.value = value; break;
      case 'water.waveNormal': waterPlane.material.uniforms.uWaveNormal.value = value; break;
      case 'water.reflStrength': waterPlane.material.uniforms.uReflStrength.value = value; break;
      case 'water.reflFade': waterPlane.material.uniforms.uReflFade.value = value; break;
      case 'water.rearFadeNearZ':
        waterPlane.material.uniforms.uRearFadeNearZ.value = value;
        poolFloor.material.uniforms.uRearFadeNearZ.value = value;
        break;
      case 'water.rearFadeFarZ':
        waterPlane.material.uniforms.uRearFadeFarZ.value = value;
        poolFloor.material.uniforms.uRearFadeFarZ.value = value;
        break;
      case 'sky.topColor': skyDome.material.uniforms.uSkyTop.value.setHex(value); break;
      case 'sky.horizonColor':
        skyDome.material.uniforms.uSkyHorizon.value.setHex(value);
        waterPlane.material.uniforms.uSkyColor.value.setHex(value);
        break;
      case 'sky.cloudColor': skyDome.material.uniforms.uCloudColor.value.setHex(value); break;
      case 'sky.cloudCover': skyDome.material.uniforms.uCloudCover.value = value; break;
      case 'sky.cloudScale': skyDome.material.uniforms.uCloudScale.value = value; break;
      case 'sky.cloudSpeed': skyDome.material.uniforms.uCloudSpeed.value = value; break;
      case 'sky.horizonFade': waterPlane.material.uniforms.uHorizonFade.value = value; break;
      case 'sky.fogColor': scene.fog.color.setHex(value); break;
      case 'sky.fogDensity': scene.fog.density = value; break;
      case 'waterfallBody.deepColor': peakWaterfall.materials[0].uniforms.uDeep.value.setHex(value); break;
      case 'waterfallBody.midColor': peakWaterfall.materials[0].uniforms.uMid.value.setHex(value); break;
      case 'waterfallBody.brightColor': peakWaterfall.materials[0].uniforms.uBright.value.setHex(value); break;
      case 'waterfallFilaments.edgeWidth': peakWaterfall.materials[1].uniforms.uEdgeWidth.value = value; break;
      case 'waterfallFilaments.highlightEdgeWidth': peakWaterfall.materials[2].uniforms.uEdgeWidth.value = value; break;
      case 'waterfallFilaments.opacity': peakWaterfall.materials[1].uniforms.uOpacity.value = value; break;
      case 'waterfallFilaments.highlightOpacity': peakWaterfall.materials[2].uniforms.uOpacity.value = value; break;
      case 'waterfallFilaments.bottomMistOpacity':
        peakWaterfall.materials[1].uniforms.uBottomMistOpacity.value = value;
        peakWaterfall.materials[2].uniforms.uBottomMistOpacity.value = value;
        break;
      case 'ripple.gain': waterPlane.material.uniforms.uRippleGain.value = value; break;
      case 'ripple.damping': rippleSystem.simMaterial.uniforms.uDamping.value = value; break;
      case 'ripple.displace': waterPlane.material.uniforms.uRippleDisplace.value = value; break;
      case 'orbit.minDistance': if (controls) controls.minDistance = value; break;
      case 'orbit.maxDistance': if (controls) controls.maxDistance = value; break;
      case 'orbit.azimuthDeg':
        if (controls) {
          controls.minAzimuthAngle = -THREE.MathUtils.degToRad(value);
          controls.maxAzimuthAngle = THREE.MathUtils.degToRad(value);
        }
        break;
      case 'orbit.minPolarDeg': if (controls) controls.minPolarAngle = THREE.MathUtils.degToRad(value); break;
      case 'orbit.maxPolarDeg': if (controls) controls.maxPolarAngle = THREE.MathUtils.degToRad(value); break;
      case 'orbit.damping': if (controls) controls.dampingFactor = value; break;
    }
  }

  let refreshDirty = false;

  /** 有「需刷新才生效」的参数被改动：交给外壳显示刷新提示。 */
  function markRefreshDirty() {
    refreshDirty = true;
    options.onRefreshDirty?.();
  }

  function commitValue(param, raw) {
    let value = raw;
    const current = readPath(param.key);
    if (param.type === 'number') value = sanitizeNumber(param.key, raw, current);
    writePath(param.key, value);
    persistNamespace(param.key);
    if (param.mode === 'reload') markRefreshDirty();
    else applyLive(param.key, value);
    return value;
  }

  // 调参描述符：显式标注返回类型，让 sections 推断出正确的字面量联合
  // （否则 type/mode 会被拓宽成 string，组件侧就拿不到类型收窄了）。
  const num = (
    key: string, label: string, desc: string,
    min: number, max: number, step: number,
    mode: 'live' | 'reload' = 'live'
  ): TuningParameterDescriptor => ({
    key, label, desc, min, max, step, mode, type: 'number'
  });
  const color = (key: string, label: string, desc: string): TuningParameterDescriptor =>
    ({ key, label, desc, mode: 'live', type: 'color' });
  const toggle = (key: string, label: string, desc: string): TuningParameterDescriptor =>
    ({ key, label, desc, mode: 'live', type: 'toggle' });

  function cameraParams(profile: string, label: string): TuningParameterDescriptor[] {
    const prefix = `camera.${profile}`;
    return [
      num(`${prefix}.pos.0`, `${label} · 相机 X`, '相机左右位置；负值向左，正值向右。', -40, 40, 0.05),
      num(`${prefix}.pos.1`, `${label} · 相机 Y`, '相机高度；调大更俯视，调小更贴近水面。', -20, 50, 0.05),
      num(`${prefix}.pos.2`, `${label} · 相机 Z`, '相机前后位置；通常调大更远，调小更近。', -50, 100, 0.05),
      num(`${prefix}.target.0`, `${label} · 注视 X`, '构图注视点的左右位置。', -40, 40, 0.05),
      num(`${prefix}.target.1`, `${label} · 注视 Y`, '构图注视点高度；调大画面抬高。', -20, 50, 0.05),
      num(`${prefix}.target.2`, `${label} · 注视 Z`, '构图注视点的前后位置。', -50, 50, 0.05),
      num(`${prefix}.fov`, `${label} · 视野角`, '调大更广角，调小更压缩；安全范围 1–179°。', 5, 150, 0.5)
    ];
  }

  // 参数注册表只在开发构建里构建：生产环境 ENABLE_TUNING_CONSOLE 是字面量 false，
  // 整个数组字面量（128 个中文标签/说明，约 3KB gzip）会被摇树剔除，
  // getTuningSections() 在生产返回空数组 —— 反正效果控制台也不存在。
  const sections: TuningSectionDescriptor[] = ENABLE_TUNING_CONSOLE ? [
    {
      id: 'interface', icon: '⌖', title: '界面布局', open: true,
      desc: '调整界面叠加信息的位置，修改后立即生效并自动保存。',
      params: [
        num('readout.offsetX', '右上角数据 · 水平位置', '世界坐标水平偏移；正值向右，负值向左，读数会随图表一起旋转。', -6, 6, 0.05),
        num('readout.offsetY', '右上角数据 · 垂直位置', '世界坐标垂直偏移；正值向上，负值向下，读数会随图表一起旋转。', -3, 3, 0.05)
      ]
    },
    {
      id: 'features', icon: '◉', title: '图层开关', open: true,
      desc: '先隔离图层，再调整细节；所有开关实时生效并自动保存。',
      params: [
        toggle('feature.showAxes', '坐标轴与刻度', '显示或隐藏时间轴、数值轴和文字刻度。'),
        toggle('feature.showWater', '水面与池底', '同时显示或隐藏水面和下方池底。'),
        toggle('feature.showMist', '水线雾带', '显示或隐藏雨体与水面的连接雾。'),
        toggle('feature.showRainLines', '雨丝连线', '显示或隐藏雨珠之间的竖向线段。'),
        toggle('feature.showPearls', '珍珠雨点', '显示或隐藏主体点状雨珠。'),
        toggle('feature.showWaterGlints', '水面光点', '显示或隐藏水面碎光；还需性能区的光点数量大于 0。'),
        toggle('feature.showImpacts', '落水泡沫与飞溅', '同时显示或隐藏泡沫、飞溅水滴和皇冠水花。'),
        toggle('feature.showPeakWaterfall', '峰值瀑布层', '显示或隐藏暴雨峰值的体积瀑布与雨丝。')
      ]
    },
    {
      id: 'camera', icon: '◫', title: '相机构图',
      desc: '按屏幕宽度自动选桌面、平板或手机档；当前档修改后立即更新。',
      params: [
        num('camera.frameTargetYOffset', '初始画面整体下移', '提高相机注视点，让坐标轴、雨幕和标题整体向下构图。', -5, 5, 0.05),
        ...cameraParams('desktop', '桌面'),
        ...cameraParams('tablet', '平板'),
        ...cameraParams('mobile', '手机')
      ]
    },
    {
      id: 'rain', icon: '╏', title: '雨体与雨珠', open: true,
      desc: '控制雨珠外观和全天雨量分布。雨量分布会改变生成布局，因此刷新生效。',
      params: [
        num('pearls.maxPointSize', '近景雨珠最大尺寸', '近处雨珠像素上限；调大会更圆、更显眼。', 0.1, 40, 0.1),
        num('pearls.minPointSize', '远景雨珠最小尺寸', '远处雨珠像素下限；调小可让远景更轻。', 0.1, 40, 0.1),
        num('pearls.alpha', '雨珠整体透明度', '调大雨幕更实，调小更稀薄；允许高于 1 做强效果。', 0, 3, 0.01),
        num('rain.baseWeight', '低谷基础雨量', '无雨时段仍保留多少雨帘；调整后刷新重建雨串。', 0, 2, 0.005, 'reload'),
        num('rain.exponent', '雨强分布曲线', '调大更集中在峰值，调小全天更均匀；调整后刷新重建。', 0.05, 8, 0.05, 'reload')
      ]
    },
    {
      id: 'metal-rain', icon: '◈', title: '液态金属雨', open: true,
      desc: '实时控制雨珠、连接雨丝、峰值金属体与高光细丝的黑银反射。',
      params: [
        color('metalRain.darkColor', '金属暗部色', '水银阴影、反射空洞和暗缝的颜色。'),
        color('metalRain.midColor', '金属中间色', '雨丝主体的铬银中间调。'),
        color('metalRain.brightColor', '镜面高光色', '移动反射带和镜面亮点的颜色。'),
        color('metalRain.tintColor', '雨珠冷色偏光', '只影响点状雨珠的冷色环境偏光。'),
        num('metalRain.pearlBandFrequency', '雨珠反射带密度', '调大雨珠表面的黑银条带更细密。', 0, 20, 0.1),
        num('metalRain.pearlBandSpeed', '雨珠反射流速', '控制雨珠黑银反射在表面流动的速度。', -6, 6, 0.01),
        num('metalRain.pearlSpecularPower', '雨珠高光锐度', '调大镜面亮点更小更硬，调小更宽更柔。', 1, 100, 1),
        num('metalRain.pearlFresnelStrength', '雨珠边缘反光', '控制雨珠轮廓边缘的金属反光强度。', 0, 2, 0.01),
        num('metalRain.threadBandDensity', '连接雨丝条带密度', '控制细雨丝上流动明暗带的间距。', 0, 0.2, 0.001),
        num('metalRain.threadBandSpeed', '连接雨丝流速', '控制细雨丝上高光向下流动的速度。', -10, 10, 0.05),
        num('metalRain.threadMirrorStrength', '连接雨丝亮度', '控制普通细雨丝的镜面银白强度。', 0, 2, 0.01),
        num('metalRain.bodyBandDensity', '峰值金属带密度', '调大峰值水银体上的竖向反射带更细密。', 0, 16, 0.1),
        num('metalRain.bodyBandSpeed', '峰值金属带流速', '控制峰值水银体反射带的流动速度。', -8, 8, 0.05),
        num('metalRain.bodyMirrorStrength', '峰值镜面强度', '控制峰值金属体银白镜面区域的亮度。', 0, 2, 0.01),
        num('metalRain.filamentBandDensity', '峰值细丝条带密度', '控制峰值瀑布细丝上的反射带间距。', 0, 12, 0.05),
        num('metalRain.filamentBandSpeed', '峰值细丝流速', '控制峰值细丝上反射高光的流动速度。', -8, 8, 0.05),
        num('metalRain.filamentMirrorStrength', '峰值细丝反光', '普通峰值细丝的金属反光强度。', 0, 2, 0.01),
        num('metalRain.highlightMirrorStrength', '高光细丝反光', '前景高光细丝的金属反光强度。', 0, 2, 0.01)
      ]
    },
    {
      id: 'floor', icon: '⌄', title: '近水提亮', open: true,
      desc: '决定雨体底部是否厚实、发亮，以及黑底会不会从雨脚之间透出。',
      params: [
        num('floorGlow.base', '普通雨基础提亮', '所有普通雨珠接近水面时的底部亮度。', -2, 5, 0.01),
        num('floorGlow.baseByStrength', '普通雨随强度提亮', '雨越大时普通雨脚额外增加的亮度。', -2, 5, 0.01),
        num('floorGlow.lowerCurtain', '低层雨帘提亮', '短雨帘靠近水面的固定提亮量。', -2, 5, 0.01),
        num('floorGlow.lowerCurtainByStrength', '低层雨帘强度提亮', '峰值区域短雨帘的额外亮度。', -2, 5, 0.01),
        num('floorGlow.downpour', '瀑布雨基础提亮', '峰值瀑布雨靠近水面时的基础亮度。', -2, 5, 0.01),
        num('floorGlow.downpourByStrength', '瀑布雨强度提亮', '峰值越高，瀑布雨脚增加的亮度。', -2, 5, 0.01),
        num('floorGlow.ambient', '背景雨底部提亮', '弱雨帘在水线附近的雾光亮度。', -2, 5, 0.01)
      ]
    },
    {
      id: 'sky', icon: '☁', title: '天空与远景', open: false,
      desc: '白天乌云的天穹、云量与飘移速度，以及湖面向远处融入天空的距离。',
      params: [
        color('sky.topColor', '天顶色', '乌云压顶处的颜色；调暗更阴沉。'),
        color('sky.horizonColor', '地平线色', '云缝透光的亮色，主要靠它撑起白天的观感。'),
        color('sky.cloudColor', '云的暗部', '云团本身的颜色；调暗云更厚重。'),
        num('sky.cloudCover', '云量', '0 是万里无云，1 是整片阴云。', 0, 1, 0.01),
        num('sky.cloudScale', '云团大小', '调大云更粗更大块，调小更碎。', 0.2, 5, 0.05),
        num('sky.cloudSpeed', '云飘移速度', '调 0 则完全静止。', 0, 0.05, 0.0005),
        num('sky.horizonFade', '水天交界距离', '湖面向远处融入天空色的距离（世界单位）。', 20, 400, 5),
        color('sky.fogColor', '远景雾色', '贴近地平线色，远景才会自然融入天空而不是发黑。'),
        num('sky.fogDensity', '雾浓度', '调大远景更朦胧，调小能看得更远；调整后刷新生效。', 0, 0.03, 0.0005, 'reload'),
      ]
    },
    {
      id: 'water', icon: '≈', title: '水面与倒影', open: true,
      desc: '控制近黑水体、镜面高光、程序波动和雨柱倒影。',
      params: [
        color('water.deepColor', '深水底色', '水体和池底的暗部颜色。'),
        color('water.surfaceColor', '水面高光色', '水面基础反光与近端渐变颜色。'),
        num('water.roughness', '磨砂程度', '0 接近镜面；调大高光更宽、更柔。', 0, 3, 0.01),
        num('water.specularStrength', '镜面高光强度', '控制窄高光亮度；可输入高于滑块范围的值。', 0, 30, 0.05),
        num('water.rippleHighlight', '波峰反光强度', '控制涟漪坡面蓝白高光。', 0, 30, 0.05),
        num('water.surfaceOpacity', '水面基础浓度', '调大更实，调小更通透；过大会发白。', 0, 3, 0.01),
        num('water.wavePrimary', '大波顶点幅度', '大尺度长波的起伏高度；可用负值反转相位。', -2, 2, 0.01),
        num('water.waveSecondary', '中波顶点幅度', '叠在大波上的中等起伏；可用负值反转相位。', -2, 2, 0.01),
        num('water.waveNormal', '细节波光强度', '法线层面的细碎波纹，只影响光泽、不改动几何。', 0, 1, 0.005),
        num('water.reflStrength', '雨柱倒影亮度', '调大水中竖向镜像更明显。', 0, 10, 0.05),
        num('water.reflFade', '雨柱倒影长度', '调大倒影向前延伸更远。', 0.25, 40, 0.05),
        num('water.rearFadeNearZ', '后缘渐隐起点', '从该世界 Z 坐标开始向远景渐隐。', -300, 10, 1),
        num('water.rearFadeFarZ', '后缘完全消失位置', '到该世界 Z 坐标时水面和池底透明度为 0。', -400, 10, 1)
      ]
    },
    {
      id: 'mist', icon: '≋', title: '水线雾霭',
      desc: '用柔雾连接上方雨体和水面，可消除正面视角的黑色分界。',
      params: [
        color('mist.color', '雾霭颜色', '水线薄雾的色调。'),
        num('mist.opacity', '雾霭浓度', '调大连接更厚、更亮；允许超过 1。', 0, 3, 0.01),
        num('mist.height', '雾带高度', '雾向上铺开的世界单位高度。', 0.05, 20, 0.05),
        num('mist.reflectionOpacity', '雾带垂直倒影', '调大水线下方竖向反光更明显。', 0, 5, 0.02)
      ]
    },
    {
      id: 'ripple', icon: '◎', title: 'GPU 涟漪物理',
      desc: '控制雨滴落水后的传播、衰减、冲击与顶点位移。',
      params: [
        num('ripple.gain', '涟漪显影增益', '只放大波纹反光信号，不直接增加几何高度。', 0, 150, 0.5),
        num('ripple.damping', '波纹持续时间', '越接近 1 传播越久；为稳定性硬上限为 0.99999。', 0.8, 0.99999, 0.0001),
        num('ripple.dropRain', '雨滴冲击强度', '每次自然落水写入高度场的强度。', 0, 10, 0.01),
        num('ripple.dropClick', '点击冲击强度', '鼠标点击水面触发的波纹强度。', 0, 10, 0.01),
        num('ripple.displace', '涟漪顶点位移', '波场对水面几何的影响；过大可能出现条纹。', -0.5, 0.5, 0.001)
      ]
    },
    {
      id: 'glint', icon: '✦', title: '水面碎光',
      desc: '控制水面漂动光点；性能区“水面光点数量”需大于 0。',
      params: [
        num('glint.opacity', '光点整体透明度', '所有水面碎光的材质透明度。', 0, 3, 0.01),
        num('glint.alphaMax', '单点亮度上限', '动态闪烁计算后的单个光点透明度上限。', 0, 3, 0.01),
        num('glint.maxSize', '光点最大尺寸', '水面光点的像素尺寸上限。', 0.1, 80, 0.1)
      ]
    },
    {
      id: 'impact', icon: '⁕', title: '落水泡沫与飞溅',
      desc: '控制撞击后短暂出现的横向泡沫和向上飞溅水滴。',
      params: [
        num('foam.opacity', '泡沫透明度', '落点横向白沫的整体可见度。', 0, 3, 0.01),
        num('foam.maxSize', '泡沫最大尺寸', '泡沫粒子的像素尺寸上限。', 0.1, 100, 0.1),
        num('spray.opacity', '飞溅水滴透明度', '向上飞溅小水滴的整体可见度。', 0, 3, 0.01),
        num('spray.maxSize', '飞溅最大尺寸', '飞溅水滴的像素尺寸上限。', 0.1, 100, 0.1)
      ]
    },
    {
      id: 'waterfall-body', icon: '▥', title: '峰值瀑布 · 体积',
      desc: '控制暴雨峰值的雾状水体、竖纹、明暗和底部质量；需先打开峰值瀑布层。',
      params: [
        color('waterfallBody.deepColor', '体积暗部色', '瀑布阴影和深缝颜色。'),
        color('waterfallBody.midColor', '体积中间色', '瀑布主体的冷灰中间调。'),
        color('waterfallBody.brightColor', '体积亮部色', '雨丝和底部水雾的银白高光。'),
        num('waterfallBody.broadSway', '大尺度左右摆动', '整体瀑布随高度产生的慢速横向摆动。', -1, 1, 0.001),
        num('waterfallBody.fineSway', '细节左右摆动', '高频小幅摆动；调大边缘更活。', -0.5, 0.5, 0.001),
        num('waterfallBody.streakFrequency', '主雨丝频率', '调大主竖纹更细密。', 0.1, 250, 0.5),
        num('waterfallBody.fineStreakFrequency', '细雨丝频率', '调大叠加的细竖纹更多。', 0.1, 500, 0.5),
        num('waterfallBody.streakSharpness', '主雨丝锐度', '调大主竖纹更硬、更分明。', 0.05, 30, 0.05),
        num('waterfallBody.fineStreakSharpness', '细雨丝锐度', '调大细线边缘更脆。', 0.05, 40, 0.05),
        num('waterfallBody.fineStreakWeight', '细雨丝占比', '调大纹理更碎，调小更像整片水体。', -2, 5, 0.01),
        num('waterfallBody.baseMass', '底部水体质量', '调大瀑布底部更厚、更亮。', -3, 8, 0.02),
        num('waterfallBody.riseMass', '向上雾化质量', '调大雾状体积向上填充得更满。', -3, 8, 0.02),
        num('waterfallBody.cloudLow', '云团暗部系数', '调大暗区被抬亮，调小对比更强。', -3, 8, 0.02),
        num('waterfallBody.cloudHigh', '云团亮部系数', '调大亮团更强，调小体积更平。', -3, 8, 0.02),
        num('waterfallBody.gapDarkness', '雨丝缝隙亮度', '调大黑缝变亮更糊，调小缝隙更深。', -2, 5, 0.01),
        num('waterfallBody.streakBrightness', '竖向雨丝亮度', '调大竖向水流纹理更醒目。', -3, 10, 0.02),
        num('waterfallBody.bottomFeather', '底边羽化', '调大底部过渡更空、更柔；数值保持非负。', 0, 3, 0.01),
        num('waterfallBody.opacity', '体积整体透明度', '调大瀑布体积更实；允许超过 1。', 0, 3, 0.01)
      ]
    },
    {
      id: 'waterfall-filaments', icon: '╿', title: '峰值瀑布 · 雨丝',
      desc: '控制叠加在体积瀑布上的普通雨丝、高光雨丝和落点雾化。',
      params: [
        num('waterfallFilaments.edgeWidth', '普通雨丝宽度', '普通雨丝从中心到边缘的软宽度。', 0, 3, 0.01),
        num('waterfallFilaments.highlightEdgeWidth', '高光雨丝宽度', '前景亮丝的边缘宽度。', 0, 3, 0.01),
        num('waterfallFilaments.opacity', '普通雨丝透明度', '普通雨丝层的整体可见度。', 0, 3, 0.01),
        num('waterfallFilaments.highlightOpacity', '高光雨丝透明度', '加色高光雨丝层的整体可见度。', 0, 3, 0.01),
        num('waterfallFilaments.bottomMistOpacity', '雨丝底部雾化', '雨丝落到水面附近时的雾化补偿。', 0, 5, 0.01)
      ]
    },
    {
      id: 'orbit', icon: '↻', title: '交互视角轨道',
      desc: '控制拖拽旋转、滚轮距离和惯性；与上方相机初始构图互相独立。',
      params: [
        num('orbit.minDistance', '最近观察距离', '滚轮可拉近到的最小距离。', 0.1, 100, 0.1),
        num('orbit.maxDistance', '最远观察距离', '滚轮可后退到的最大距离。', 0.1, 200, 0.1),
        num('orbit.azimuthDeg', '水平旋转范围', '左右各允许旋转的角度；0° 锁定正面。', 0, 180, 1),
        num('orbit.minPolarDeg', '最俯视极角', '调小可从更高处俯看；安全范围 0.1–179.9°。', 0.1, 179, 0.5),
        num('orbit.maxPolarDeg', '最仰视极角', '调大可更贴近水面仰看。', 0.1, 179.9, 0.5),
        num('orbit.damping', '旋转惯性阻尼', '调大拖拽更黏、更慢；调小更直接。', 0, 1, 0.005)
      ]
    },
    {
      id: 'quality', icon: '⚡', title: '粒子数量与性能',
      desc: '改变数组和几何容量，需要刷新页面重建；数字框可输入远高于滑块范围的值。',
      params: [
        num('quality.chains', '主雨串数量', '全天数据雨串的基础数量。', 0, 12000, 10, 'reload'),
        num('quality.ambientChains', '背景细雨数量', '补足低谷时段的轻雨帘数量。', 0, 8000, 10, 'reload'),
        num('quality.downpourChains', '暴雨峰值雨串数量', '集中在峰值段的加密雨串数量。', 0, 12000, 10, 'reload'),
        num('quality.waterfallFilaments', '瀑布雨丝容量', '峰值瀑布实例化雨丝数量。', 0, 12000, 10, 'reload'),
        num('quality.waterGlints', '水面光点数量', '水面碎光粒子容量；当前为 0 时碎光参数不可见。', 0, 10000, 10, 'reload'),
        num('quality.impactPearls', '撞击粒子池大小', '泡沫、飞溅与皇冠水花的总容量。', 0, 30000, 50, 'reload'),
        num('quality.impactEventsPerSecond', '每秒撞击事件预算', '每秒可生成的落水水花事件。', 0, 3000, 5, 'reload'),
        num('quality.rippleEventsPerSecond', '每秒涟漪事件预算', '每秒写入 GPU 高度场的自然雨滴事件。', 0, 1000, 1, 'reload'),
        num('quality.maxRipples', '兼容涟漪上限', '旧版兼容参数；当前 GPU 高度场主要使用每秒事件预算。', 0, 1000, 1, 'reload')
      ]
    }
  ] : [];

  if (ENABLE_TUNING_CONSOLE) {
    // 防止今后新增 TUNING 参数却忘记加入面板：自动补进“未分类”区。
    const declaredTuning = new Set(
      sections.flatMap(section => section.params.map(param => param.key))
        .filter(path => !path.startsWith('quality.') && !path.startsWith('feature.'))
    );
    const missingTuning = Object.keys(flattenObject(TUNING)).filter(path => !declaredTuning.has(path));
    if (missingTuning.length) {
      sections.push({
        id: 'uncategorized', icon: '…', title: '新增未分类参数',
        desc: '代码中新出现但尚未编写专属说明的参数，已自动加入，避免调参遗漏。',
        params: missingTuning.map(path => {
          const value = readPath(path);
          if (typeof value === 'boolean') return toggle(path, path, '自动发现的布尔参数。');
          if (/color/i.test(path)) return color(path, path, '自动发现的颜色参数。');
          const span = Math.max(1, Math.abs(Number(value)) * 10);
          return num(path, path, '自动发现的数值参数；数字输入不受滑块软范围限制。', -span, span, span / 500);
        })
      });
    }

    // 调试与自动化验证标记（只在开发构建里写）。
    const allParams = sections.flatMap(section => section.params);
    root.dataset.tuningParameterCount = String(allParams.length);
    root.dataset.tuningUnmappedCount = '0';
    root.dataset.tuningAutoCoveredCount = String(missingTuning.length);
  }

  // 主题色应用（原本内联在面板里，剥掉 DOM 操作后放回引擎）
  function applyGlobalColor(value) {
    globalThemeColor = normalizeThemeHex(value);
    globalThemePalette = deriveGlobalTheme(globalThemeColor);
    applyGlobalThemeCss(globalThemePalette);
    applyGlobalThemePalette(globalThemePalette);

    for (const [path, nextValue] of Object.entries(globalThemeTuningValues(globalThemePalette))) {
      writePath(path, nextValue);
      applyLive(path, nextValue);
    }

    scene.fog.color.setHex(globalThemePalette.fog);
    persistNamespace('metalRain.darkColor');
    try {
      localStorage.setItem(GLOBAL_THEME_STORAGE_KEY, themeHexCss(globalThemeColor));
    } catch {}

    rebuildRainfallSystems();
    state.readoutKey = '';
    updateDomState(true);
    root.dataset.globalThemeColor = themeHexCss(globalThemeColor).toUpperCase();
    root.dataset.globalThemeLinkedLayers = 'background,rain,water,mist,axes,interface';
    options.onThemeApplied?.({
      hex: root.dataset.globalThemeColor,
      linkedPaths: Object.keys(globalThemeTuningValues(globalThemePalette))
    });
  }

function animate() {
  const delta = Math.min(clock.getDelta(), 0.04);
  const elapsed = clock.elapsedTime;

  state.burst = Math.max(0, state.burst - delta * 1.1);

  mistBand.material.uniforms.uTime.value = prefersReducedMotion ? 6.2 : elapsed;

  // 天空穹顶每帧跟到相机位置：它表现的是“无穷远”，所以半径 1 也永远不会被裁剪。
  skyDome.position.copy(camera.position);
  skyDome.material.uniforms.uTime.value = prefersReducedMotion ? 0 : elapsed;

  if (!prefersReducedMotion) {
    beginImpactFrame(impactPearls, elapsed, delta);
    updateRainChains(rainChains, elapsed, delta);
    updateWaterGlints(waterGlints, elapsed, delta);
    if (SPLASH_IMPACTS_ENABLED) updateImpactPearls(impactPearls, elapsed, delta);
  }

  if (FEATURES.showPeakWaterfall) {
    updatePeakWaterfall(peakWaterfall, prefersReducedMotion ? 0 : elapsed);
  }

  if (state.pointerActive && elapsed - state.lastHoverRippleAt > 0.18) {
    state.lastHoverRippleAt = elapsed;
    addRipple(
      rippleSystem,
      state.pointerWorld.x,
      state.pointerWorld.z,
      0.34 + sampleRainStrength(state.pointerHour) * 0.28,
      false,
      elapsed
    );
  }

  updateRippleField(rippleSystem, renderer, elapsed);
  updateWaterPlane(elapsed);
  updateCamera(delta);
  updateAxisSystem(axisSystem, elapsed);
  updateDomState();

  renderer.render(scene, camera);
  if (!disposed) animationFrameId = requestAnimationFrame(animate);
}

function applyFeatureVisibility() {
  axisSystem.group.visible = FEATURES.showAxes;
  // visible 只决定“画不画”，这里同时把轴的半透明材质归位，
  // 免得开关过坐标轴之后个别材质残留旧的不透明度。
  setAxisOpacity(axisSystem, FEATURES.showAxes ? 1 : 0);
  waterPlane.visible = FEATURES.showWater;
  poolFloor.visible = FEATURES.showWater;
  mistBand.mesh.visible = FEATURES.showMist;
  rainChains.lines.visible = FEATURES.showRainLines;
  rainChains.points.visible = FEATURES.showPearls;
  waterGlints.points.visible = FEATURES.showWaterGlints;
  const splashImpactsVisible = SPLASH_IMPACTS_ENABLED && FEATURES.showImpacts;
  impactPearls.foam.visible = splashImpactsVisible;
  impactPearls.droplets.visible = splashImpactsVisible;
  impactPearls.crowns.visible = splashImpactsVisible;
  peakWaterfall.group.visible = FEATURES.showPeakWaterfall;
  root.dataset.axisVisibility = FEATURES.showAxes ? 'visible' : 'hidden';
}

function syncRuntimeDatasets() {
  root.dataset.rainMaterial = 'procedural-liquid-metal';
  root.dataset.rainEdgeMode = isPhoneLandscapeViewport() ? 'mobile-crisp' : 'authored';
  root.dataset.rainfallMax = String(Number(rainfallMax.toFixed(3)));
  root.dataset.axisMax = String(Number(axisMax.toFixed(3)));
  root.dataset.rainfallValues = activeRainfall.join(',');
  root.dataset.rainfallPointCount = String(activeRainfall.length);
  const zeroRainfallHours = activeRainfall
    .map((value, hour) => value === 0 ? hour : null)
    .filter(hour => hour !== null);
  root.dataset.zeroRainfallCount = String(zeroRainfallHours.length);
  root.dataset.zeroRainfallHours = zeroRainfallHours.join(',');
  root.dataset.zeroRainSuppression = 'anchor-feathered';
  root.dataset.rainfallResponse = 'continuous-raw-hourly-v2';
  root.dataset.rainfallDry = String(rainfallMax <= 0);
  root.dataset.chainCount = String(rainChains.data.count);
  root.dataset.zeroSuppressedChainCount = String(
    rainChains.data.presence?.reduce((count, value) => count + (value <= 0.08 ? 1 : 0), 0) ?? 0
  );
  root.dataset.baseChainCount = String(rainChains.data.baseCount);
  root.dataset.ambientChainCount = String(rainChains.data.ambientCount);
  root.dataset.downpourChainCount = String(rainChains.data.downpourCount);
  root.dataset.pearlCount = String(rainChains.data.pearlCount);
  root.dataset.streakCount = String(rainChains.data.downpourCount);
  root.dataset.waterfallBodyCount = String(peakWaterfall.bodyCount);
  root.dataset.waterfallPeakCount = String(peakWaterfall.peakCount);
  root.dataset.waterfallFilamentCapacity = String(peakWaterfall.filamentCapacity);
  root.dataset.activeWaterfallFilaments = String(peakWaterfall.visibleFilamentCount);
  root.dataset.bridgeFilamentCount = String(peakWaterfall.bridgeFilamentCount);
  root.dataset.coreFilamentCount = String(peakWaterfall.coreFilamentCount);
  root.dataset.lowerFilamentCount = String(peakWaterfall.lowerFilamentCount);
  root.dataset.wideFilamentCount = String(peakWaterfall.wideFilamentCount);
  root.dataset.foregroundFilamentCount = String(peakWaterfall.foregroundFilamentCount);
  root.dataset.highlightFilamentCount = String(peakWaterfall.highlightFilamentCount);
  root.dataset.waterfallRibbonSegments = String(peakWaterfall.ribbonSegments);
  root.dataset.activeBridgeTrails = String(rainChains.data.activeBridgeTrailCount);
  root.dataset.waterfallPlotClip = 'off';
  root.dataset.baselineImpactCount = String(impactPearls.data.staticSeedCount);
  root.dataset.splashImpactsEnabled = String(SPLASH_IMPACTS_ENABLED);
  root.dataset.activeStormParticles = String(impactPearls.data.activeCount);
  root.dataset.activeFoamParticles = String(impactPearls.data.activeFoamCount);
  root.dataset.activeSprayDroplets = String(impactPearls.data.activeDropletCount);
  root.dataset.activeCrownLines = String(impactPearls.data.activeCrownCount);
  root.dataset.peakImpactCount = String(impactPearls.data.totalPeakCollisions);
  root.dataset.stormEmissionRate = impactPearls.data.currentEmissionRate.toFixed(1);
  root.dataset.activeRipples = '0';
  root.dataset.rainPlotClip = 'off';
  root.dataset.rainCeilingValue = String(Number(rainCeilingValue.toFixed(3)));
  root.dataset.rainCeilingWorldY = rainCeilingY.toFixed(3);
  root.dataset.ambientCurtainMode = 'data-driven-ceiling';
  root.dataset.axisMode = '3d-reference-labels';
  root.dataset.axisVisibility = axisSystem.group.visible ? 'visible' : 'hidden';
  root.dataset.timeTickCount = String(axisSystem.timeTickCount);
  root.dataset.valueTickCount = String(axisSystem.valueTickCount);
  root.dataset.axisLabelCount = String(axisSystem.labelCount);
}

function applyRainfallData(values) {
  if (!Array.isArray(values) || values.length !== defaultRainfall.length) {
    throw new TypeError(i18n('dataLengthError', { count: defaultRainfall.length }));
  }
  const nextValues = values.map((rawValue) => {
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(i18n('dataValueError'));
    }
    return normalizeRainfallValue(value);
  });

  activeRainfall = nextValues;
  refreshRainfallMetrics();
  rebuildRainfallSystems();
  updateRainSoundFromData();
  state.readoutKey = '';
  updateDomState(true);
}

function rebuildRainfallSystems() {
  const dry = rainfallMax <= 0;
  const hasPeaks = peakWaterfallRanges.length > 0;
  const capacityScale = dry ? 0 : rainCapacityResponse(rainfallMax);
  const nextAxisSystem = createAxisSystem();
  const nextMistBand = createMistBand();
  const nextRainChains = createRainChainSystem(
    dry ? 0 : Math.max(1, Math.round(QUALITY.chains * capacityScale)),
    dry ? 0 : Math.max(1, Math.round(QUALITY.ambientChains * Math.pow(capacityScale, 1.08))),
    dry || !hasPeaks ? 0 : QUALITY.downpourChains
  );
  const nextPeakWaterfall = createPeakWaterfallSystem(
    dry || !hasPeaks ? 0 : QUALITY.waterfallFilaments,
    nextRainChains.data
  );
  const nextWaterGlints = createWaterGlintSystem(dry ? 0 : QUALITY.waterGlints);
  const nextImpactPearls = createImpactPearlSystem(
    !dry && SPLASH_IMPACTS_ENABLED ? QUALITY.impactPearls : 0,
    !dry && SPLASH_IMPACTS_ENABLED ? QUALITY.impactEventsPerSecond : 0,
    QUALITY.rippleEventsPerSecond
  );

  const oldObjects = [
    axisSystem.group,
    mistBand.mesh,
    rainChains.lines,
    rainChains.points,
    peakWaterfall.group,
    waterGlints.points,
    impactPearls.foam,
    impactPearls.droplets,
    impactPearls.crowns
  ];

  waterPlane.material.uniforms.uRainLut.value = nextMistBand.lut;
  waterPlane.material.uniforms.uLutBounds.value.set(nextMistBand.lutXMin, nextMistBand.lutSpan);
  worldGroup.remove(...oldObjects);
  oldObjects.forEach(disposeObject3D);

  axisSystem = nextAxisSystem;
  chartCameraFitBounds = axisSystem.fitBounds.clone();
  applyReadoutPosition();
  syncAxisLabelScale(axisSystem);
  mistBand = nextMistBand;
  rainChains = nextRainChains;
  peakWaterfall = nextPeakWaterfall;
  waterGlints = nextWaterGlints;
  impactPearls = nextImpactPearls;

  worldGroup.add(
    axisSystem.group,
    mistBand.mesh,
    rainChains.lines,
    rainChains.points,
    peakWaterfall.group,
    waterGlints.points,
    impactPearls.foam,
    impactPearls.droplets,
    impactPearls.crowns
  );

  clearRippleField(rippleSystem);
  applyFeatureVisibility();

  if (prefersReducedMotion) {
    if (SPLASH_IMPACTS_ENABLED) seedReducedMotionImpacts(impactPearls);
    updateRainChains(rainChains, 0, 0);
    if (FEATURES.showPeakWaterfall) updatePeakWaterfall(peakWaterfall, 0);
    updateWaterGlints(waterGlints, 0, 0);
    if (SPLASH_IMPACTS_ENABLED) updateImpactPearls(impactPearls, 0, 0);
  }

  syncRuntimeDatasets();
}

function disposeObject3D(object) {
  if (!object) return;
  const geometries = new Set<any>();
  const materials = new Set<any>();
  const textures = new Set<any>();

  object.traverse((node) => {
    if (node.geometry) geometries.add(node.geometry);
    const nodeMaterials = Array.isArray(node.material) ? node.material : [node.material];
    nodeMaterials.filter(Boolean).forEach(material => materials.add(material));
  });

  for (const material of materials) {
    for (const value of Object.values(material) as any[]) {
      if (value?.isTexture) textures.add(value);
    }
    for (const uniform of Object.values(material.uniforms || {}) as any[]) {
      if (uniform?.value?.isTexture) textures.add(uniform.value);
    }
  }

  textures.forEach(texture => texture.dispose());
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
}

function clearRippleField(system) {
  const previousTarget = renderer.getRenderTarget();
  const previousAutoClear = renderer.autoClear;
  renderer.autoClear = true;
  renderer.setRenderTarget(system.rtA);
  renderer.clear();
  renderer.setRenderTarget(system.rtB);
  renderer.clear();
  renderer.setRenderTarget(previousTarget);
  renderer.autoClear = previousAutoClear;
  system.dropCount = 0;
  system.dropGeometry.setDrawRange(0, 0);
  system.texture = system.rtA.texture;
  waterPlane.material.uniforms.uHeightField.value = system.texture;
  root.dataset.activeRipples = '0';
}

function drawAxisReadout(readoutPanel, displayHour) {
  const roundedHour = clamp(Math.round(displayHour), 0, 24);
  const valueText = sampleRainfall(displayHour).toFixed(1);
  const key = `${roundedHour}-${valueText}-${globalThemeColor}`;
  if (readoutPanel.key === key) return;

  const { canvas, context, texture } = readoutPanel;
  context.clearRect(0, 0, canvas.width, canvas.height);

  context.textAlign = 'left';
  context.textBaseline = 'middle';
  // 与轴标签保持一致：只加一圈深色柔光把字托出天穹，不做玻璃底板。
  context.shadowColor = 'rgba(4, 14, 28, 0.9)';
  context.shadowBlur = 12;

  const rightEdge = canvas.width - 12;
  const unitText = i18n('axisUnit');
  context.font = '450 32px Inter, "PingFang SC", "Microsoft YaHei", sans-serif';
  const unitWidth = context.measureText(unitText).width;
  const lineX = 18;
  const lineWidth = 8;
  const lineGap = 48;
  const lineTop = 26;
  const lineBottom = 218;
  const contentLeft = lineX + lineWidth + lineGap;
  const valueUnitGap = 16;
  let valueFontSize = 116;
  context.font = `350 ${valueFontSize}px Inter, "PingFang SC", "Microsoft YaHei", sans-serif`;
  let valueWidth = context.measureText(valueText).width;
  const availableValueWidth = rightEdge - unitWidth - valueUnitGap - contentLeft;
  if (valueWidth > availableValueWidth) {
    valueFontSize = Math.max(72, valueFontSize * availableValueWidth / valueWidth);
    context.font = `350 ${valueFontSize}px Inter, "PingFang SC", "Microsoft YaHei", sans-serif`;
    valueWidth = context.measureText(valueText).width;
  }
  const valueX = contentLeft;
  const unitX = Math.min(rightEdge - unitWidth, valueX + valueWidth + valueUnitGap);

  context.globalAlpha = 0.92;
  context.fillStyle = themeHexCss(globalThemePalette.axisTick);
  context.fillRect(lineX, lineTop, lineWidth, lineBottom - lineTop);

  context.globalAlpha = 1;
  context.fillStyle = themeHexCss(globalThemePalette.axisTime);
  context.font = '550 42px Inter, "PingFang SC", "Microsoft YaHei", sans-serif';
  context.fillText(`${String(roundedHour).padStart(2, '0')}:00`, valueX, 48);

  context.fillStyle = themeHexCss(globalThemePalette.axisStrong);
  context.font = `350 ${valueFontSize}px Inter, "PingFang SC", "Microsoft YaHei", sans-serif`;
  context.fillText(valueText, valueX, 158);

  context.fillStyle = themeHexCss(globalThemePalette.axisTick);
  context.font = '450 32px Inter, "PingFang SC", "Microsoft YaHei", sans-serif';
  context.fillText(unitText, unitX, 166);

  texture.needsUpdate = true;
  readoutPanel.key = key;
}

function createAxisReadoutPanel(anchorX, anchorY, anchorZ, opacity) {
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 260;
  const context = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false,
    side: THREE.DoubleSide
  });
  const worldHeight = 0.98;
  const worldWidth = worldHeight * canvas.width / canvas.height;
  const geometry = new THREE.PlaneGeometry(worldWidth, worldHeight);
  // 让画布右边缘固定在图表的最右端，内容自然向图表内部展开。
  geometry.translate(-worldWidth * 0.5, 0, 0);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'axis-dynamic-readout';
  mesh.position.set(anchorX, anchorY, anchorZ);
  mesh.renderOrder = 9.6;
  mesh.visible = false;

  const panel = {
    mesh,
    material,
    canvas,
    context,
    texture,
    anchorX,
    anchorY,
    anchorZ,
    key: ''
  };
  drawAxisReadout(panel, state.selectedHour);
  return panel;
}

function createAxisSystem() {
  const group = new THREE.Group();
  group.name = 'rainfall-3d-axes';
  const axisGraphicOpacity = 0.85;

  const axisMaterial = new THREE.MeshBasicMaterial({
    color: globalThemePalette.axisLine,
    // Keep this in Three.js' transparent pass so it is drawn after the water.
    transparent: true,
    opacity: axisGraphicOpacity,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false
  });
  const tickMaterial = new THREE.MeshBasicMaterial({
    color: globalThemePalette.axisTick,
    transparent: true,
    opacity: axisGraphicOpacity,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false
  });
  const selectedMaterial = new THREE.MeshBasicMaterial({
    color: globalThemePalette.axisStrong,
    transparent: true,
    opacity: axisGraphicOpacity,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false
  });
  const hoverMaterial = new THREE.MeshBasicMaterial({
    color: globalThemePalette.axisStrong,
    transparent: true,
    opacity: axisGraphicOpacity,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false
  });

  const xMin = hourToX(0);
  const xMax = hourToX(24);
  const xAxisY = WATER_LEVEL - 0.18;
  const yMax = rainCeilingY;
  const z = AXIS_CONFIG.z;
  // 信息架构统一使用同一条顶线：左侧标题与右侧动态读数互为镜像。
  const headerTop = yMax + AXIS_CONFIG.headerHeight;

  const axisVertices = [
    xMin, xAxisY, z,
    xMax, xAxisY, z,
    xMin, xAxisY, z,
    xMin, yMax, z
  ];
  const timeTickPositions = [];
  const labelGroup = new THREE.Group();
  labelGroup.name = 'axis-labels';
  const labelOpacityEntries = [];
  for (let hour = 0; hour <= 24; hour += 2) {
    const x = hourToX(hour);
    timeTickPositions.push(x, xAxisY, z);
    const label = createAxisLabel(`${String(hour).padStart(2, '0')}:00`, {
      height: 0.2,
      fontSize: 54,
      fontWeight: 400,
      mobileScale: 1.55,
      color: themeHexCss(globalThemePalette.axisTime)
    });
    label.sprite.position.set(x, xAxisY - 0.27, z + 0.04);
    labelGroup.add(label.sprite);
    labelOpacityEntries.push({ material: label.material, baseOpacity: label.opacity });
  }

  const valueTickVertices = [];
  const tickValues = rainfallAxisTicks();
  // Keep the complete Y-axis text column clear of the longest tick label.
  // Keep the left-aligned value/unit column clear of the Y-axis and its ticks,
  // including after the mobile label scale is applied.
  const yAxisLabelLeft = xMin - 0.72;
  for (const value of tickValues) {
    const y = rainfallToAxisY(value);
    // The X axis already marks zero; drawing another horizontal Y tick here
    // creates a misleading stationary cross beside the cursor marker.
    if (value > 0) {
      valueTickVertices.push(xMin - 0.08, y, z, xMin + 0.08, y, z);
    }

    const valueLabel = createAxisLabel(formatRainfallTick(value), {
      height: 0.33,
      fontSize: 64,
      fontWeight: 350,
      mobileOffsetX: -0.32,
      anchorX: 0,
      color: themeHexCss(globalThemePalette.axisValue)
    });
    valueLabel.sprite.position.set(yAxisLabelLeft, y + 0.02, z + 0.04);
    labelGroup.add(valueLabel.sprite);
    labelOpacityEntries.push({ material: valueLabel.material, baseOpacity: valueLabel.opacity });

    const unitLabel = createAxisLabel(i18n('axisUnit'), {
      height: 0.172,
      fontSize: 44,
      fontWeight: 450,
      mobileScale: 1.9,
      mobileOffsetX: -0.32,
      anchorX: 0,
      color: themeHexCss(globalThemePalette.axisUnit)
    });
    unitLabel.sprite.position.set(yAxisLabelLeft, y - 0.28, z + 0.04);
    labelGroup.add(unitLabel.sprite);
    labelOpacityEntries.push({ material: unitLabel.material, baseOpacity: unitLabel.opacity });
  }

  const yAxisHeadingLeft = yAxisLabelLeft;
  const titleLabels = locale === 'zh-CN'
    ? [
        { text: i18n('axisTitle'), y: headerTop - 0.22, height: 0.48, fontSize: 76, fontWeight: 550, mobileOffsetX: -0.32, color: themeHexCss(globalThemePalette.axisStrong) },
        { text: i18n('axisSubtitle'), y: headerTop - 0.57, height: 0.24, fontSize: 52, fontWeight: 450, mobileScale: 1.55, mobileOffsetX: -0.32, color: themeHexCss(globalThemePalette.axisTime) },
        { text: i18n('axisUnit'), y: headerTop - 0.82, height: 0.164, fontSize: 44, fontWeight: 450, mobileScale: 1.9, mobileOffsetX: -0.32, color: themeHexCss(globalThemePalette.axisUnit) }
      ]
    : [
        { text: i18n('axisTitle'), y: headerTop - 0.22, height: 0.436, fontSize: 76, fontWeight: 550, mobileOffsetX: -0.32, color: themeHexCss(globalThemePalette.axisStrong) },
        { text: i18n('axisSubtitle'), y: headerTop - 0.57, height: 0.207, fontSize: 46, fontWeight: 450, mobileScale: 1.55, mobileOffsetX: -0.32, color: themeHexCss(globalThemePalette.axisTime) },
        { text: i18n('axisUnit'), y: headerTop - 0.82, height: 0.164, fontSize: 44, fontWeight: 450, mobileScale: 1.9, mobileOffsetX: -0.32, color: themeHexCss(globalThemePalette.axisUnit) }
      ];
  for (const entry of titleLabels) {
    const titleLabel = createAxisLabel(entry.text, {
      height: entry.height,
      fontSize: entry.fontSize,
      fontWeight: entry.fontWeight,
      mobileScale: entry.mobileScale,
      mobileOffsetX: entry.mobileOffsetX,
      anchorX: 0,
      color: entry.color
    });
    titleLabel.sprite.position.set(yAxisHeadingLeft, entry.y, z + 0.04);
    titleLabel.material.opacity = axisGraphicOpacity;
    labelGroup.add(titleLabel.sprite);
    labelOpacityEntries.push({ material: titleLabel.material, baseOpacity: axisGraphicOpacity });
  }

  const readoutPanel = createAxisReadoutPanel(
    xMax,
    headerTop - 0.49,
    z + 0.05,
    axisGraphicOpacity
  );
  readoutPanel.mesh.position.x += Number(TUNING.readout.offsetX) || 0;
  readoutPanel.mesh.position.y += Number(TUNING.readout.offsetY) || 0;
  labelOpacityEntries.push({ material: readoutPanel.material, baseOpacity: axisGraphicOpacity });

  const axes = createAxisBars('axis-lines', axisVertices, axisMaterial, 0.009, 9);
  const timeTicks = createAxisDots('time-ticks', timeTickPositions, tickMaterial, 0.011, 9.1);
  const valueTickMeshes = createAxisBars('value-ticks', valueTickVertices, tickMaterial, 0.008, 9.1);
  const selectedMarker = createAxisBars(
    'selected-time-marker',
    [0, xAxisY, z + 0.012, 0, xAxisY + 0.48, z + 0.012],
    selectedMaterial,
    0.01,
    9.3
  );
  const hoverMarker = createAxisBars(
    'hover-time-marker',
    [0, xAxisY, z + 0.018, 0, xAxisY + 0.34, z + 0.018],
    hoverMaterial,
    0.008,
    9.4
  );
  selectedMarker.visible = false;
  hoverMarker.visible = false;

  group.add(axes, timeTicks, valueTickMeshes, labelGroup, readoutPanel.mesh, selectedMarker, hoverMarker);
  group.updateMatrixWorld(true);
  const fitBounds = new THREE.Box3().setFromObject(group, true);

  return {
    group,
    fitBounds,
    labelGroup,
    readout: readoutPanel,
    selectedMarker,
    hoverMarker,
    opacityEntries: [
      { material: axisMaterial, baseOpacity: axisGraphicOpacity },
      { material: tickMaterial, baseOpacity: axisGraphicOpacity },
      { material: selectedMaterial, baseOpacity: axisGraphicOpacity },
      { material: hoverMaterial, baseOpacity: axisGraphicOpacity },
      ...labelOpacityEntries
    ],
    opacity: 1,
    timeTickCount: 13,
    valueTickCount: valueTickVertices.length / 6,
    labelCount: 13 + tickValues.length * 2 + titleLabels.length + 1
  };
}

function createAxisDots(name, positions, material, radius, renderOrder) {
  const group = new THREE.Group();
  group.name = name;
  const geometry = new THREE.SphereGeometry(radius, 16, 10);

  for (let index = 0; index < positions.length; index += 3) {
    const dot = new THREE.Mesh(geometry, material);
    dot.position.set(positions[index], positions[index + 1], positions[index + 2]);
    dot.renderOrder = renderOrder;
    group.add(dot);
  }

  return group;
}

function createAxisLabel(text, {
  height,
  fontSize,
  fontWeight = 300,
  mobileScale = 1.28,
  mobileOffsetX = 0,
  anchorX = 0.5,
  color = '#ffffff'
}) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  const resolutionScale = 3;
  const renderFontSize = fontSize * resolutionScale;
  const font = `${fontWeight} ${renderFontSize}px Inter, "PingFang SC", "Microsoft YaHei", sans-serif`;
  context.font = font;
  const width = Math.ceil(context.measureText(text).width + 24 * resolutionScale);
  const canvasHeight = Math.ceil(renderFontSize * 1.45);
  canvas.width = width;
  canvas.height = canvasHeight;

  context.clearRect(0, 0, width, canvasHeight);
  context.font = font;
  context.fillStyle = color;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  // 深色柔光：亮天蓝压在灰白天穹上亮度太接近，靠这一圈把字托出背景。
  // 比玻璃底板轻，不会挡住后面的雨和湖面。
  context.shadowColor = 'rgba(4, 14, 28, 0.9)';
  context.shadowBlur = 10 * resolutionScale;
  context.fillText(text, width * 0.5, canvasHeight * 0.5);
  context.shadowBlur = 0;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 1,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false,
    side: THREE.DoubleSide
  });
  const worldWidth = height * width / canvasHeight;
  const geometry = new THREE.PlaneGeometry(worldWidth, height);
  // PlaneGeometry stays in the axis' XY plane. Unlike THREE.Sprite it does not
  // billboard toward the camera, so axis text keeps one fixed world orientation.
  geometry.translate((0.5 - anchorX) * worldWidth, 0, 0);
  const sprite = new THREE.Mesh(geometry, material);
  sprite.renderOrder = 9.5;
  sprite.userData.mobileScale = mobileScale;
  sprite.userData.mobileOffsetX = mobileOffsetX;

  return { sprite, material, opacity: 1 };
}

function syncAxisLabelScale(system) {
  const mobile = isPhoneLandscapeViewport();
  for (const label of system?.labelGroup?.children || []) {
    const scale = mobile ? label.userData.mobileScale || 1.28 : 1;
    if (!Number.isFinite(label.userData.basePositionX)) {
      label.userData.basePositionX = label.position.x;
    }
    label.scale.setScalar(scale);
    label.position.x = label.userData.basePositionX
      + (mobile ? label.userData.mobileOffsetX || 0 : 0);
  }
  root.dataset.axisLabelScale = mobile ? '1.28-1.90' : '1.00';
}

function createAxisBars(name, vertices, material, thickness, renderOrder) {
  const group = new THREE.Group();
  group.name = name;
  const xAxis = new THREE.Vector3(1, 0, 0);

  for (let index = 0; index < vertices.length; index += 6) {
    const start = new THREE.Vector3(vertices[index], vertices[index + 1], vertices[index + 2]);
    const end = new THREE.Vector3(vertices[index + 3], vertices[index + 4], vertices[index + 5]);
    const direction = end.clone().sub(start);
    const length = direction.length();
    const geometry = new THREE.BoxGeometry(length, thickness, thickness);
    const bar = new THREE.Mesh(geometry, material);
    bar.position.copy(start).add(end).multiplyScalar(0.5);
    bar.quaternion.setFromUnitVectors(xAxis, direction.normalize());
    bar.renderOrder = renderOrder;
    group.add(bar);
  }

  return group;
}

function rainfallToAxisY(value) {
  return WATER_LEVEL + clamp(value / axisMax, 0, 1) * AXIS_CONFIG.worldHeight;
}

function setAxisOpacity(system, opacity) {
  system.opacity = opacity;
  for (const entry of system.opacityEntries) {
    entry.material.opacity = entry.baseOpacity * opacity;
  }
}

// elapsed 用于驱动坐标轴标签/数据条的呼吸动画，由调用点统一传入。
function updateAxisSystem(system, elapsed) {
  // Keep click selection for the readout/highlight, but do not draw a second,
  // stationary X-axis marker beside the cursor-following hover marker.
  system.selectedMarker.visible = false;
  system.hoverMarker.position.x = hourToX(state.pointerHour);
  system.hoverMarker.visible = state.pointerActive;
  system.readout.mesh.visible = state.pointerActive;
  if (state.pointerActive) drawAxisReadout(system.readout, state.pointerHour);
  root.dataset.readoutVisibility = state.pointerActive ? 'visible' : 'hidden';
  root.dataset.cursorLineVisibility = state.pointerActive ? 'visible' : 'hidden';

}

function createRainChainSystem(baseCount, ambientCount = 0, downpourCount = 0) {
  const count = baseCount + ambientCount + downpourCount;
  const chain = {
    count,
    baseCount,
    ambientCount,
    downpourCount,
    role: new Uint8Array(count),
    style: new Uint8Array(count),
    resetSeed: new Uint32Array(count),
    seedIndex: new Uint32Array(count),
    hour: new Float32Array(count),
    strength: new Float32Array(count),
    presence: new Float32Array(count),
    stormWeight: new Float32Array(count),
    waterfallTop: new Float32Array(count),
    waterfallBlendTop: new Float32Array(count),
    waterfallFeather: new Float32Array(count),
    baseX: new Float32Array(count),
    z: new Float32Array(count),
    pathX: new Float32Array(count),
    pathZ: new Float32Array(count),
    top: new Float32Array(count),
    length: new Float32Array(count),
    headY: new Float32Array(count),
    speed: new Float32Array(count),
    near: new Float32Array(count),
    curtainLayer: new Uint8Array(count),
    driftX: new Float32Array(count),
    driftZ: new Float32Array(count),
    phase: new Float32Array(count),
    windSpeed: new Float32Array(count),
    alpha: new Float32Array(count),
    pearlStart: new Uint32Array(count),
    strandPearlCount: new Uint8Array(count),
    lineStart: new Uint32Array(count),
    lineCount: new Uint8Array(count),
    respawnCycle: new Uint32Array(count)
  };

  const random = createSeededRandom(RAIN_LAYOUT_SEED);
  const hourSampler = createHourSampler(TUNING.rain.baseWeight, TUNING.rain.exponent, random, true);
  const ambientRandom = createSeededRandom(AMBIENT_RAIN_SEED);
  // Even, low-opacity coverage supplies a restrained background curtain in
  // dry hours without changing the existing data-driven peak distribution.
  const ambientHourSampler = () => randomRange(0.04, 23.96, ambientRandom);
  const downpourRandom = createSeededRandom(DOWNPOUR_RAIN_SEED);
  const downpourHourSampler = createIntegratedDownpourHourSampler(downpourRandom);
  let pearlCount = 0;
  let lineCount = 0;

  for (let i = 0; i < baseCount; i += 1) {
    const hour = hourSampler();
    const strength = sampleRainStrength(hour);
    const visibility = rainVisibilityResponse(strength);
    const presence = sampleRainPresence(hour);
    const heightStrength = sampleRainHeightStrength(hour);
    const near = sampleNearness(random);
    const clusterHeight = lerp(0.88, 1.12, valueNoise(hour * 1.55, RAIN_CLUSTER_SEED ^ 0x51f2a93d));
    const strandScatter = randomRange(
      -0.32 - strength * 0.34,
      0.38 + strength * 0.68,
      random
    );
    const top = Math.min(
      rainCeilingY,
      WATER_LEVEL + clamp(
        0.95
          + Math.pow(heightStrength, 0.92) * 5.8 * clusterHeight
          + strandScatter,
        0.76,
        8.8
      )
    );
    const layerPick = random();
    const curtainLayer = layerPick < 0.5 ? 0 : layerPick < 0.85 ? 1 : 2;
    const columnHeight = Math.max(0.8, top - WATER_LEVEL);
    const baseLength = randomRange(0.78, 1.14, random)
      + strength * randomRange(0.62, 1.08, random)
      + near * randomRange(0.12, 0.32, random);
    const length = curtainLayer === 1
      ? Math.max(0.42, Math.min(
        baseLength * randomRange(0.64, 0.9, random),
        columnHeight * randomRange(0.24, 0.42, random)
      ))
      : baseLength;
    // Restrained bead spacing — pearls read as distinct beads strung along a
    // thread (bound by the faint connecting line), not a dense mush.
    const beads = Math.round(
      lerp(20, 34, Math.pow(strength, 0.55))
      + near * randomRange(0, 4, random)
      + (curtainLayer === 1 ? 1 : 0)
    );

    chain.hour[i] = hour;
    assignWaterfallEnvelope(chain, i, hour);
    chain.role[i] = RAIN_ROLE.BASE;
    chain.resetSeed[i] = RAIN_LAYOUT_SEED;
    chain.seedIndex[i] = i;
    chain.strength[i] = strength;
    chain.presence[i] = presence;
    chain.near[i] = near;
    chain.top[i] = top;
    chain.length[i] = length;
    chain.curtainLayer[i] = curtainLayer;
    chain.pearlStart[i] = pearlCount;
    chain.strandPearlCount[i] = clamp(beads, 16, 40);
    chain.lineStart[i] = lineCount;
    chain.lineCount[i] = chain.strandPearlCount[i] - 1;
    chain.speed[i] = randomRange(1.5, 2.45, random)
      + strength * randomRange(1.15, 2.55, random)
      + near * 0.42;
    chain.driftX[i] = randomRange(0.004, 0.014, random) + near * randomRange(0.003, 0.009, random);
    chain.driftZ[i] = randomRange(0.003, 0.01, random) + near * randomRange(0.002, 0.006, random);
    chain.phase[i] = random() * Math.PI * 2;
    chain.windSpeed[i] = randomRange(0.22, 0.58, random);
    chain.alpha[i] = randomRange(0.54, 0.96, random)
      * (0.22 + visibility * 1.18)
      * (0.76 + near * 0.72)
      * (curtainLayer === 1 ? 1.12 : 1)
      * presence;

    resetChainPosition(chain, i, true);

    pearlCount += chain.strandPearlCount[i];
    lineCount += chain.lineCount[i];
  }

  for (let localIndex = 0; localIndex < ambientCount; localIndex += 1) {
    const i = baseCount + localIndex;
    const hour = ambientHourSampler();
    const strength = sampleRainStrength(hour);
    const visibility = rainVisibilityResponse(strength);
    const presence = sampleRainPresence(hour);
    const near = sampleNearness(ambientRandom);
    const beads = Math.round(randomRange(28, 38, ambientRandom));

    chain.hour[i] = hour;
    assignWaterfallEnvelope(chain, i, hour);
    chain.role[i] = RAIN_ROLE.AMBIENT;
    chain.resetSeed[i] = AMBIENT_RAIN_SEED;
    chain.seedIndex[i] = localIndex;
    chain.strength[i] = strength;
    chain.presence[i] = presence;
    chain.near[i] = near;
    chain.top[i] = rainCeilingY;
    chain.length[i] = rainCeilingY - WATER_LEVEL + randomRange(0.12, 0.3, ambientRandom);
    chain.curtainLayer[i] = 2;
    chain.pearlStart[i] = pearlCount;
    chain.strandPearlCount[i] = beads;
    chain.lineStart[i] = lineCount;
    chain.lineCount[i] = beads - 1;
    chain.speed[i] = 0;
    chain.driftX[i] = randomRange(0.002, 0.008, ambientRandom);
    chain.driftZ[i] = randomRange(0.002, 0.006, ambientRandom);
    chain.phase[i] = ambientRandom() * Math.PI * 2;
    chain.windSpeed[i] = randomRange(0.18, 0.46, ambientRandom);
    chain.alpha[i] = randomRange(0.08, 0.2, ambientRandom)
      * (0.08 + visibility * 0.92)
      * presence;

    resetChainPosition(chain, i, true);
    pearlCount += beads;
    lineCount += beads - 1;
  }

  for (let localIndex = 0; localIndex < downpourCount; localIndex += 1) {
    const i = baseCount + ambientCount + localIndex;
    const hour = downpourHourSampler();
    const strength = sampleRainStrength(hour);
    const presence = sampleRainPresence(hour);
    const heightStrength = sampleRainHeightStrength(hour);
    const near = sampleNearness(downpourRandom);
    const clusterHeight = lerp(0.9, 1.12, valueNoise(hour * 1.55, RAIN_CLUSTER_SEED ^ 0x51f2a93d));
    const dataHeight = clamp(
      0.95
        + Math.pow(heightStrength, 0.92) * 5.8 * clusterHeight
        + randomRange(-0.22, 0.62, downpourRandom),
      1.2,
      8.8
    );
    const fullHeight = downpourRandom() < 0.45;
    const lowerRatio = downpourRandom() < 0.7
      ? randomRange(0.08, 0.38, downpourRandom)
      : randomRange(0.38, 0.58, downpourRandom);
    const topHeight = fullHeight
      ? dataHeight + randomRange(-0.12, 0.48, downpourRandom)
      : Math.max(0.82, dataHeight * lowerRatio + randomRange(-0.08, 0.24, downpourRandom));
    const stylePick = downpourRandom();
    const style = stylePick < 0.7 ? 0 : stylePick < 0.94 ? 1 : 2;
    const beads = Math.round(style === 0
      ? randomRange(13, 19, downpourRandom)
      : style === 1 ? randomRange(15, 21, downpourRandom) : randomRange(16, 22, downpourRandom));
    const length = fullHeight
      ? randomRange(0.82, 1.5, downpourRandom) + strength * randomRange(0.52, 1.02, downpourRandom)
      : Math.min(
        randomRange(0.38, 1.04, downpourRandom),
        topHeight * randomRange(0.48, 0.86, downpourRandom)
      );

    chain.hour[i] = hour;
    assignWaterfallEnvelope(chain, i, hour);
    chain.role[i] = RAIN_ROLE.DOWNPOUR;
    chain.style[i] = style;
    chain.resetSeed[i] = DOWNPOUR_RAIN_SEED;
    chain.seedIndex[i] = localIndex;
    chain.strength[i] = strength;
    chain.presence[i] = presence;
    chain.near[i] = near;
    chain.top[i] = Math.min(rainCeilingY, WATER_LEVEL + topHeight);
    chain.length[i] = Math.max(0.34, length);
    chain.curtainLayer[i] = 0;
    chain.pearlStart[i] = pearlCount;
    chain.strandPearlCount[i] = beads;
    chain.lineStart[i] = lineCount;
    chain.lineCount[i] = beads - 1;
    chain.speed[i] = randomRange(2.65, 4.35, downpourRandom) + strength * 0.72;
    chain.driftX[i] = 0;
    chain.driftZ[i] = 0;
    chain.phase[i] = downpourRandom() * Math.PI * 2;
    chain.windSpeed[i] = 0;
    chain.alpha[i] = randomRange(
      style === 0 ? 0.26 : 0.32,
      style === 2 ? 0.62 : 0.52,
      downpourRandom
    ) * (0.88 + strength * 0.34) * presence;

    resetChainPosition(chain, i, true);
    pearlCount += beads;
    lineCount += beads - 1;
  }

  for (let i = 0; i < count; i += 1) {
    chain.waterfallBlendTop[i] = chain.waterfallTop[i]
      + Math.sin(chain.phase[i] * 2.17 + chain.hour[i] * 0.41) * 0.2;
  }

  const pearlPositions = new Float32Array(pearlCount * 3);
  const pearlColors = new Float32Array(pearlCount * 3);
  const pearlAlphas = new Float32Array(pearlCount);
  const pearlBaseAlpha = new Float32Array(pearlCount);
  const pearlSizes = new Float32Array(pearlCount);
  const pearlUpperScales = new Float32Array(pearlCount);
  const pearlUpperProgress = new Float32Array(pearlCount);
  const pearlUpperSeed = new Float32Array(pearlCount);
  const pearlTopRetention = new Float32Array(pearlCount);
  const pearlTopSize = new Float32Array(pearlCount);
  const pearlTopAlpha = new Float32Array(pearlCount);
  const pearlAspects = new Float32Array(pearlCount);
  const pearlHighlights = new Float32Array(pearlCount);
  const pearlChain = new Uint16Array(pearlCount);
  const pearlFraction = new Float32Array(pearlCount);
  const pearlOffsetY = new Float32Array(pearlCount);
  const pearlShimmer = new Float32Array(pearlCount);
  const pearlStorm = new Float32Array(pearlCount);
  const pearlWaterfallTop = new Float32Array(pearlCount);
  const pearlWaterfallFeather = new Float32Array(pearlCount);

  const linePositions = new Float32Array(lineCount * 2 * 3);
  const lineColors = new Float32Array(lineCount * 2 * 3);
  const lineBandPhases = new Float32Array(lineCount * 2);
  const lineAlphas = new Float32Array(lineCount * 2);
  const lineBaseAlpha = new Float32Array(lineCount);
  const linePearlA = new Uint32Array(lineCount);
  const linePearlB = new Uint32Array(lineCount);
  const lineChain = new Uint16Array(lineCount);
  const lineStorm = new Float32Array(lineCount * 2);

  for (let i = 0; i < baseCount; i += 1) {
    const start = chain.pearlStart[i];
    const beads = chain.strandPearlCount[i];
    const strength = chain.strength[i];
    const near = chain.near[i];
    const baseSize = randomRange(1.15, 1.7, random)
      + near * randomRange(0.3, 0.82, random)
      + strength * randomRange(0.1, 0.4, random);

    for (let bead = 0; bead < beads; bead += 1) {
      const pearl = start + bead;
      const index = pearl * 3;
      const fraction = beads <= 1 ? 0 : bead / (beads - 1);
      const type = random();

      pearlChain[pearl] = i;
      pearlFraction[pearl] = fraction;
      pearlOffsetY[pearl] = randomRange(-0.006, 0.006, random);
      pearlShimmer[pearl] = random() * Math.PI * 2;
      pearlUpperScales[pearl] = 1;
      pearlUpperSeed[pearl] = random();
      pearlTopRetention[pearl] = 0.3;
      pearlTopSize[pearl] = randomRange(0.35, 0.55, random);
      pearlTopAlpha[pearl] = randomRange(0.18, 0.4, random);

      // Pearls within a strand stay near-uniform in size for a restrained,
      // precise look — only their "weight" (brightness/sheen) varies. A few
      // pearls read as independent and bright, most are quieter, but all are
      // about the same size; thickness varies between strands, not within one.
      pearlSizes[pearl] = baseSize * randomRange(0.92, 1.08, random);
      pearlAspects[pearl] = randomRange(1.04, 1.26, random);
      let weight;
      if (type < 0.14) {
        // independent bright pearl — the strand's luminous accents
        pearlHighlights[pearl] = randomRange(0.18, 0.32, random);
        weight = randomRange(0.95, 1.22, random);
      } else if (type < 0.46) {
        pearlHighlights[pearl] = randomRange(0.06, 0.16, random);
        weight = randomRange(0.56, 0.86, random);
      } else {
        // quiet thread pearl — dimmer, but still carries the dense curtain
        pearlHighlights[pearl] = randomRange(0.02, 0.08, random);
        weight = randomRange(0.26, 0.52, random);
      }

      pearlBaseAlpha[pearl] = clamp(
        weight * (0.68 + near * 0.5 + strength * 0.4),
        0,
        1.1
      );
      pearlAlphas[pearl] = pearlBaseAlpha[pearl];

      writeRainColor(
        pearlColors,
        index,
        strength,
        randomRange(0.72, 1.12, random) * (0.82 + near * 0.3) * (0.78 + weight * 0.36),
        random
      );
    }

    for (let segment = 0; segment < beads - 1; segment += 1) {
      const line = chain.lineStart[i] + segment;
      const colorIndex = line * 6;
      linePearlA[line] = start + segment;
      linePearlB[line] = start + segment + 1;
      lineChain[line] = i;
      lineBaseAlpha[line] = randomRange(0.009, 0.026, random)
        * (0.54 + strength * 0.44)
        * (0.6 + near * 0.42);
      writeRainColor(
        lineColors,
        colorIndex,
        strength,
        randomRange(0.2, 0.36, random) * (0.78 + near * 0.24),
        random
      );
      lineColors[colorIndex + 3] = lineColors[colorIndex] * 1.12;
      lineColors[colorIndex + 4] = lineColors[colorIndex + 1] * 1.12;
      lineColors[colorIndex + 5] = lineColors[colorIndex + 2] * 1.12;
    }
  }

  for (let localIndex = 0; localIndex < ambientCount; localIndex += 1) {
    const i = baseCount + localIndex;
    const start = chain.pearlStart[i];
    const beads = chain.strandPearlCount[i];
    const strength = chain.strength[i];
    const near = chain.near[i];
    const baseSize = randomRange(0.58, 1.02, ambientRandom) + near * randomRange(0.08, 0.28, ambientRandom);

    for (let bead = 0; bead < beads; bead += 1) {
      const pearl = start + bead;
      const index = pearl * 3;
      const fraction = beads <= 1 ? 0 : bead / (beads - 1);

      pearlChain[pearl] = i;
      pearlFraction[pearl] = fraction;
      pearlOffsetY[pearl] = randomRange(-0.004, 0.004, ambientRandom);
      pearlShimmer[pearl] = ambientRandom() * Math.PI * 2;
      pearlBaseAlpha[pearl] = randomRange(0.22, 0.5, ambientRandom) * (0.88 + near * 0.22);
      pearlAlphas[pearl] = pearlBaseAlpha[pearl];
      pearlUpperScales[pearl] = 1;
      pearlUpperSeed[pearl] = ambientRandom();
      pearlTopRetention[pearl] = randomRange(0.72, 0.84, ambientRandom);
      pearlTopSize[pearl] = randomRange(0.58, 0.78, ambientRandom);
      pearlTopAlpha[pearl] = randomRange(0.55, 0.75, ambientRandom);
      pearlSizes[pearl] = baseSize * randomRange(0.54, 0.88, ambientRandom);
      pearlAspects[pearl] = randomRange(1.35, 2.0, ambientRandom);
      pearlHighlights[pearl] = randomRange(0.04, 0.14, ambientRandom);
      writeExtensionRainColor(
        pearlColors,
        index,
        strength,
        randomRange(0.34, 0.62, ambientRandom),
        RAIN_ROLE.AMBIENT,
        0,
        ambientRandom
      );
    }

    for (let segment = 0; segment < beads - 1; segment += 1) {
      const line = chain.lineStart[i] + segment;
      const colorIndex = line * 6;
      linePearlA[line] = start + segment;
      linePearlB[line] = start + segment + 1;
      lineChain[line] = i;
      lineBaseAlpha[line] = randomRange(0.003, 0.009, ambientRandom) * (0.72 + strength * 0.24);
      writeExtensionRainColor(
        lineColors,
        colorIndex,
        strength,
        randomRange(0.1, 0.2, ambientRandom),
        RAIN_ROLE.AMBIENT,
        0,
        ambientRandom
      );
      lineColors[colorIndex + 3] = lineColors[colorIndex] * 1.08;
      lineColors[colorIndex + 4] = lineColors[colorIndex + 1] * 1.08;
      lineColors[colorIndex + 5] = lineColors[colorIndex + 2] * 1.08;
    }
  }

  for (let localIndex = 0; localIndex < downpourCount; localIndex += 1) {
    const i = baseCount + ambientCount + localIndex;
    const start = chain.pearlStart[i];
    const beads = chain.strandPearlCount[i];
    const strength = chain.strength[i];
    const near = chain.near[i];
    const style = chain.style[i];
    const styleScale = style === 0
      ? randomRange(0.35, 0.5, downpourRandom)
      : style === 1 ? randomRange(0.5, 0.7, downpourRandom) : randomRange(0.75, 0.95, downpourRandom);
    const baseSize = (
      randomRange(1.05, 1.72, downpourRandom)
        + near * randomRange(0.28, 0.82, downpourRandom)
        + strength * randomRange(0.1, 0.38, downpourRandom)
    ) * styleScale;

    for (let bead = 0; bead < beads; bead += 1) {
      const pearl = start + bead;
      const index = pearl * 3;
      const fraction = beads <= 1 ? 0 : bead / (beads - 1);
      const type = downpourRandom();

      pearlChain[pearl] = i;
      pearlFraction[pearl] = fraction;
      pearlOffsetY[pearl] = randomRange(-0.004, 0.004, downpourRandom);
      pearlShimmer[pearl] = downpourRandom() * Math.PI * 2;
      pearlBaseAlpha[pearl] = randomRange(0.2, style === 2 ? 0.64 : 0.5, downpourRandom)
        * (0.88 + near * 0.24 + strength * 0.2);
      pearlAlphas[pearl] = pearlBaseAlpha[pearl];
      pearlUpperScales[pearl] = 1;
      pearlUpperSeed[pearl] = downpourRandom();
      pearlTopRetention[pearl] = randomRange(0.34, 0.48, downpourRandom);
      pearlTopSize[pearl] = randomRange(0.48, 0.7, downpourRandom);
      pearlTopAlpha[pearl] = randomRange(0.32, 0.58, downpourRandom);
      pearlSizes[pearl] = baseSize * (type < 0.7
        ? randomRange(0.68, 0.94, downpourRandom)
        : randomRange(0.88, 1.14, downpourRandom));
      pearlAspects[pearl] = style === 0
        ? randomRange(1.28, 1.82, downpourRandom)
        : randomRange(1.05, 1.48, downpourRandom);
      pearlHighlights[pearl] = style === 2
        ? randomRange(0.3, 0.52, downpourRandom)
        : randomRange(0.08, 0.24, downpourRandom);
      writeExtensionRainColor(
        pearlColors,
        index,
        strength,
        randomRange(0.38, style === 2 ? 0.86 : 0.68, downpourRandom),
        RAIN_ROLE.DOWNPOUR,
        style,
        downpourRandom
      );
    }

    for (let segment = 0; segment < beads - 1; segment += 1) {
      const line = chain.lineStart[i] + segment;
      const colorIndex = line * 6;
      linePearlA[line] = start + segment;
      linePearlB[line] = start + segment + 1;
      lineChain[line] = i;
      lineBaseAlpha[line] = randomRange(0.008, style === 2 ? 0.025 : 0.021, downpourRandom)
        * (0.78 + strength * 0.34)
        * (0.82 + near * 0.22);
      writeExtensionRainColor(
        lineColors,
        colorIndex,
        strength,
        randomRange(0.2, style === 2 ? 0.42 : 0.34, downpourRandom),
        RAIN_ROLE.DOWNPOUR,
        style,
        downpourRandom
      );
      lineColors[colorIndex + 3] = lineColors[colorIndex] * 1.1;
      lineColors[colorIndex + 4] = lineColors[colorIndex + 1] * 1.1;
      lineColors[colorIndex + 5] = lineColors[colorIndex + 2] * 1.1;
    }
  }

  let bridgeTrailCapacity = 0;
  for (let pearl = 0; pearl < pearlCount; pearl += 1) {
    const chainIndex = pearlChain[pearl];
    pearlStorm[pearl] = chain.stormWeight[chainIndex];
    pearlWaterfallTop[pearl] = chain.waterfallBlendTop[chainIndex];
    pearlWaterfallFeather[pearl] = chain.waterfallFeather[chainIndex];
    if (pearlStorm[pearl] > 0.08 && pearlUpperSeed[pearl] > 0.55) {
      bridgeTrailCapacity += 1;
    }
  }
  for (let segment = 0; segment < lineCount; segment += 1) {
    const stormWeight = chain.stormWeight[lineChain[segment]];
    const bandPhaseSeed = Math.sin((lineChain[segment] + 1) * 12.9898) * 43758.5453;
    const bandPhase = (bandPhaseSeed - Math.floor(bandPhaseSeed)) * Math.PI * 2;
    lineStorm[segment * 2] = stormWeight;
    lineStorm[segment * 2 + 1] = stormWeight;
    lineBandPhases[segment * 2] = bandPhase;
    lineBandPhases[segment * 2 + 1] = bandPhase;
  }

  const pearlGeometry = new THREE.BufferGeometry();
  pearlGeometry.setAttribute('position', new THREE.BufferAttribute(pearlPositions, 3).setUsage(THREE.DynamicDrawUsage));
  pearlGeometry.setAttribute('aColor', new THREE.BufferAttribute(pearlColors, 3));
  pearlGeometry.setAttribute('aAlpha', new THREE.BufferAttribute(pearlAlphas, 1).setUsage(THREE.DynamicDrawUsage));
  pearlGeometry.setAttribute('aSize', new THREE.BufferAttribute(pearlSizes, 1));
  pearlGeometry.setAttribute('aUpperScale', new THREE.BufferAttribute(pearlUpperScales, 1).setUsage(THREE.DynamicDrawUsage));
  pearlGeometry.setAttribute('aUpperProgress', new THREE.BufferAttribute(pearlUpperProgress, 1).setUsage(THREE.DynamicDrawUsage));
  pearlGeometry.setAttribute('aAspect', new THREE.BufferAttribute(pearlAspects, 1));
  pearlGeometry.setAttribute('aHighlight', new THREE.BufferAttribute(pearlHighlights, 1));
  pearlGeometry.setAttribute('aStorm', new THREE.BufferAttribute(pearlStorm, 1));
  pearlGeometry.setAttribute('aWaterfallTop', new THREE.BufferAttribute(pearlWaterfallTop, 1));
  pearlGeometry.setAttribute('aWaterfallFeather', new THREE.BufferAttribute(pearlWaterfallFeather, 1));
  pearlGeometry.setAttribute('aMorphSeed', new THREE.BufferAttribute(pearlUpperSeed, 1));

  const pearlMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: pixelRatio },
      uFogDensity: { value: scene.fog.density },
      uMetalDark: { value: new THREE.Color(TUNING.metalRain.darkColor) },
      uMetalMid: { value: new THREE.Color(TUNING.metalRain.midColor) },
      uMetalBright: { value: new THREE.Color(TUNING.metalRain.brightColor) },
      uMetalTint: { value: new THREE.Color(TUNING.metalRain.tintColor) },
      uPearlBandFrequency: { value: TUNING.metalRain.pearlBandFrequency },
      uPearlBandSpeed: { value: TUNING.metalRain.pearlBandSpeed },
      uPearlSpecularPower: { value: TUNING.metalRain.pearlSpecularPower },
      uPearlFresnelStrength: { value: TUNING.metalRain.pearlFresnelStrength },
      uViewport: { value: rainViewport },
      uPlotBounds: { value: rainPlotBounds },
      uPlotFeather: { value: rainPlotFeather },
      uPlotClip: rainPlotClip,
      uMobileCrisp: { value: isPhoneLandscapeViewport() ? 1 : 0 },
      uMinPointSize: { value: TUNING.pearls.minPointSize },
      uMaxPointSize: { value: TUNING.pearls.maxPointSize }
    },
    vertexShader: `
      uniform float uPixelRatio;
      uniform float uBeadScale;
      uniform float uMobileCrisp;
      uniform float uMinPointSize;
      uniform float uMaxPointSize;
      attribute vec3 aColor;
      attribute float aAlpha;
      attribute float aSize;
      attribute float aUpperScale;
      attribute float aUpperProgress;
      attribute float aAspect;
      attribute float aHighlight;
      attribute float aStorm;
      attribute float aWaterfallTop;
      attribute float aWaterfallFeather;
      attribute float aMorphSeed;
      varying vec3 vColor;
      varying float vAlpha;
      varying float vAspect;
      varying float vHighlight;
      varying float vUpperProgress;
      varying float vTrailScale;
      varying float vFogDepth;
      varying float vStorm;
      varying float vWaterfall;

      void main() {
        float waterfallTransition = aStorm * (
          1.0 - smoothstep(
            aWaterfallTop - aWaterfallFeather,
            aWaterfallTop + aWaterfallFeather,
            position.y
          )
        );
        float massEntry = smoothstep(0.22, 0.92, waterfallTransition);
        float morphEligibility = mix(
          smoothstep(0.55, 0.82, aMorphSeed),
          0.62 + smoothstep(0.12, 0.98, aMorphSeed) * 0.38,
          massEntry
        );
        float trailEntry = smoothstep(0.04, 0.5, waterfallTransition);
        float lowerTrailRetention = 1.0 - smoothstep(0.96, 1.0, waterfallTransition) * 0.08;
        float trailScale = morphEligibility * trailEntry * lowerTrailRetention;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        float depthScale = clamp(20.0 / max(5.2, -mvPosition.z), 0.82, 2.42);
        vColor = aColor;
        vAlpha = aAlpha;
        vAspect = aAspect
          * (1.0 + trailScale * mix(0.9, 2.2, massEntry))
          * mix(1.0, 0.72, massEntry);
        vHighlight = aHighlight;
        vUpperProgress = aUpperProgress;
        vTrailScale = trailScale;
        vFogDepth = -mvPosition.z;
        vStorm = aStorm;
        vWaterfall = waterfallTransition;
        gl_PointSize = mix(1.0, 0.5, uMobileCrisp) * uBeadScale * clamp(
          aSize * aUpperScale * (1.0 + trailScale * mix(0.7, 1.75, massEntry)) * uPixelRatio * depthScale,
          uMinPointSize * uPixelRatio,
          uMaxPointSize * uPixelRatio
        );
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uFogDensity;
      uniform vec3 uMetalDark;
      uniform vec3 uMetalMid;
      uniform vec3 uMetalBright;
      uniform vec3 uMetalTint;
      uniform float uPearlBandFrequency;
      uniform float uPearlBandSpeed;
      uniform float uPearlSpecularPower;
      uniform float uPearlFresnelStrength;
      uniform float uMobileCrisp;
      uniform vec2 uViewport;
      uniform vec4 uPlotBounds;
      uniform vec3 uPlotFeather;
      uniform float uPlotClip;
      uniform float uBeadAlpha;
      varying vec3 vColor;
      varying float vAlpha;
      varying float vAspect;
      varying float vHighlight;
      varying float vUpperProgress;
      varying float vTrailScale;
      varying float vFogDepth;
      varying float vStorm;
      varying float vWaterfall;

      void main() {
        vec2 point = gl_PointCoord - vec2(0.5);
        vec2 pearlPoint = vec2(point.x * vAspect, point.y);
        float distanceToEdge = length(pearlPoint);
        float waterfallMass = smoothstep(0.28, 1.0, vWaterfall);
        float edge = mix(
          1.0 - smoothstep(0.46, 0.5, distanceToEdge),
          1.0 - smoothstep(0.28, 0.58, distanceToEdge),
          waterfallMass
        );
        float crispEdge = 1.0 - smoothstep(0.44, 0.5, distanceToEdge);
        edge = mix(edge, crispEdge, uMobileCrisp);
        float sheetEdge = 1.0 - smoothstep(
          0.42,
          0.62,
          length(vec2(point.x * 0.94, point.y * 0.62))
        );
        edge = max(edge, sheetEdge * waterfallMass * mix(0.32, 0.08, uMobileCrisp));
        if (edge < 0.01) discard;

        float body = exp(-dot(pearlPoint, pearlPoint) * mix(4.6, 2.6, waterfallMass));
        float verticalSheet = exp(-(point.x * point.x * mix(18.0, 5.8, waterfallMass) + point.y * point.y * mix(6.0, 1.36, waterfallMass)))
          * waterfallMass;
        float lowerGlow = smoothstep(-0.34, 0.42, point.y) * mix(0.12, 0.28, waterfallMass);
        // Soft satin pearl sheen instead of a tight gem specular.
        vec2 sheenPoint = pearlPoint - vec2(-0.12, 0.18);
        float highlight = exp(-dot(sheenPoint, sheenPoint) * 40.0)
          * vHighlight
          * mix(1.0, 0.4, vUpperProgress);
        // Cool rim light on the lower/shadow side gives pearls roundness + weight.
        float opticalDetail = mix(1.0, 0.15, uMobileCrisp);
        float rimLight = smoothstep(0.32, 0.5, distanceToEdge)
          * smoothstep(0.05, -0.4, point.y) * vHighlight * 0.28 * opticalDetail;
        float rim = smoothstep(0.36, 0.5, distanceToEdge) * 0.08 * opticalDetail;
        float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
        vec2 screenUv = vec2(
          gl_FragCoord.x / uViewport.x,
          1.0 - gl_FragCoord.y / uViewport.y
        );
        float horizontalMask = smoothstep(
          uPlotBounds.x,
          uPlotBounds.x + uPlotFeather.x,
          screenUv.x
        ) * (1.0 - smoothstep(
          uPlotBounds.y - uPlotFeather.x,
          uPlotBounds.y,
          screenUv.x
        ));
        horizontalMask = mix(1.0, horizontalMask, uPlotClip);
        float lowerMask = 1.0 - smoothstep(
          uPlotBounds.w - uPlotFeather.z,
          uPlotBounds.w,
          screenUv.y
        );
        lowerMask = mix(1.0, lowerMask, uPlotClip);
        float plotMask = horizontalMask * lowerMask;

        // Reconstruct a soft sphere normal from the point sprite. Alternating
        // dark and bright reflection bands make the pearl read as mercury
        // without converting every drop to a costly lit mesh.
        vec2 metalPoint = clamp(pearlPoint / 0.5, vec2(-1.0), vec2(1.0));
        float metalZ = sqrt(max(0.0, 1.0 - dot(metalPoint, metalPoint)));
        vec3 metalNormal = normalize(vec3(metalPoint, metalZ));
        vec3 keyDirection = normalize(vec3(-0.42, 0.62, 1.0));
        float metalSpecular = pow(
          max(0.0, dot(metalNormal, keyDirection)),
          max(0.01, uPearlSpecularPower)
        );
        float metalFresnel = pow(1.0 - clamp(metalNormal.z, 0.0, 1.0), 2.4);
        float reflectionWave = 0.5 + 0.5 * sin(
          metalNormal.y * uPearlBandFrequency
          + metalNormal.x * 2.4
          - uTime * uPearlBandSpeed
          + vStorm * 2.2
        );
        float mirrorBand = smoothstep(0.34, 0.86, reflectionWave);
        float shadowBand = smoothstep(0.68, 0.98, 1.0 - reflectionWave);
        vec3 color = mix(uMetalDark, uMetalMid, mirrorBand * 0.82 + body * 0.12);
        color = mix(color, uMetalBright, clamp(
          metalSpecular * 1.2 + metalFresnel * uPearlFresnelStrength,
          0.0,
          1.0
        ));
        float tintStrength = (verticalSheet * 0.2 + lowerGlow * 0.08)
          * mix(1.0, 0.62, uMobileCrisp);
        color = mix(color, uMetalTint, tintStrength);
        color = mix(color, uMetalDark, shadowBand * 0.56 + rim * 0.16);
        color += uMetalBright * (highlight * 0.18 + rimLight * 0.2);
        color *= mix(1.0, 0.78, vUpperProgress);
        color = mix(color, vec3(0.0, 0.0, 0.0), fogFactor * 0.48);
        float alpha = uBeadAlpha * edge * vAlpha * plotMask
          * mix(1.0, 0.45, uMobileCrisp)
          * (0.78 + highlight * 0.05 * opticalDetail + rimLight * 0.18 + verticalSheet * mix(0.16, 0.04, uMobileCrisp))
          * (1.0 - fogFactor * 0.38);
        if (alpha < 0.001) discard;
        gl_FragColor = vec4(color, min(0.94, alpha));
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending
  });

  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3).setUsage(THREE.DynamicDrawUsage));
  lineGeometry.setAttribute('aColor', new THREE.BufferAttribute(lineColors, 3));
  lineGeometry.setAttribute('aAlpha', new THREE.BufferAttribute(lineAlphas, 1).setUsage(THREE.DynamicDrawUsage));
  lineGeometry.setAttribute('aStorm', new THREE.BufferAttribute(lineStorm, 1));
  lineGeometry.setAttribute('aBandPhase', new THREE.BufferAttribute(lineBandPhases, 1));

  const lineMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFogDensity: { value: scene.fog.density },
      uMetalDark: { value: new THREE.Color(TUNING.metalRain.darkColor) },
      uMetalMid: { value: new THREE.Color(TUNING.metalRain.midColor) },
      uMetalBright: { value: new THREE.Color(TUNING.metalRain.brightColor) },
      uThreadBandDensity: { value: TUNING.metalRain.threadBandDensity },
      uThreadBandSpeed: { value: TUNING.metalRain.threadBandSpeed },
      uThreadMirrorStrength: { value: TUNING.metalRain.threadMirrorStrength },
      uViewport: { value: rainViewport },
      uPlotBounds: { value: rainPlotBounds },
      uPlotFeather: { value: rainPlotFeather },
      uPlotClip: rainPlotClip,
      uMobileCrisp: { value: isPhoneLandscapeViewport() ? 1 : 0 }
    },
    vertexShader: `
      attribute vec3 aColor;
      attribute float aAlpha;
      attribute float aStorm;
      attribute float aBandPhase;
      varying vec3 vColor;
      varying float vAlpha;
      varying float vFogDepth;
      varying float vStorm;
      varying float vBandPhase;

      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vColor = aColor;
        vAlpha = aAlpha;
        vFogDepth = -mvPosition.z;
        vStorm = aStorm;
        vBandPhase = aBandPhase;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uFogDensity;
      uniform vec3 uMetalDark;
      uniform vec3 uMetalMid;
      uniform vec3 uMetalBright;
      uniform float uThreadBandDensity;
      uniform float uThreadBandSpeed;
      uniform float uThreadMirrorStrength;
      uniform float uMobileCrisp;
      uniform vec2 uViewport;
      uniform vec4 uPlotBounds;
      uniform vec3 uPlotFeather;
      uniform float uPlotClip;
      varying vec3 vColor;
      varying float vAlpha;
      varying float vFogDepth;
      varying float vStorm;
      varying float vBandPhase;

      void main() {
        float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
        vec2 screenUv = vec2(
          gl_FragCoord.x / uViewport.x,
          1.0 - gl_FragCoord.y / uViewport.y
        );
        float horizontalMask = smoothstep(
          uPlotBounds.x,
          uPlotBounds.x + uPlotFeather.x,
          screenUv.x
        ) * (1.0 - smoothstep(
          uPlotBounds.y - uPlotFeather.x,
          uPlotBounds.y,
          screenUv.x
        ));
        horizontalMask = mix(1.0, horizontalMask, uPlotClip);
        float lowerMask = 1.0 - smoothstep(
          uPlotBounds.w - uPlotFeather.z,
          uPlotBounds.w,
          screenUv.y
        );
        lowerMask = mix(1.0, lowerMask, uPlotClip);
        float alpha = vAlpha * horizontalMask * lowerMask
          * mix(1.0, 5.0, uMobileCrisp)
          * (1.0 - fogFactor * 0.42);
        if (alpha < 0.0005) discard;
        float reflectionWave = 0.5 + 0.5 * sin(
          gl_FragCoord.y * uThreadBandDensity
          + gl_FragCoord.x * uThreadBandDensity * 0.1777778
          + vBandPhase
          - uTime * uThreadBandSpeed
          + vStorm * 2.6
        );
        float mirrorBand = smoothstep(0.42, 0.86, reflectionWave);
        float darkBand = smoothstep(0.7, 0.98, 1.0 - reflectionWave);
        vec3 color = mix(uMetalDark, uMetalMid, mirrorBand);
        color = mix(
          color,
          uMetalBright,
          mirrorBand * mirrorBand * (uThreadMirrorStrength + vStorm * 0.26)
        );
        color = mix(color, uMetalDark, darkBand * 0.58);
        color = mix(color, vec3(0.0, 0.0, 0.0), fogFactor * 0.55);
        gl_FragColor = vec4(color, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending
  });

  const points = new THREE.Points(pearlGeometry, pearlMaterial);
  points.renderOrder = 3;
  pearlMaterial.uniforms.uBeadScale = { value: 1.0 };
  pearlMaterial.uniforms.uBeadAlpha = { value: TUNING.pearls.alpha };

  const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
  lines.renderOrder = 2;

  const data = {
    ...chain,
    pearlCount,
    lineTotal: lineCount,
    pearlPositions,
    pearlAlphas,
    pearlBaseAlpha,
    pearlUpperScales,
    pearlUpperProgress,
    pearlUpperSeed,
    pearlTopRetention,
    pearlTopSize,
    pearlTopAlpha,
    pearlChain,
    pearlFraction,
    pearlOffsetY,
    pearlShimmer,
    linePositions,
    lineAlphas,
    lineBaseAlpha,
    linePearlA,
    linePearlB,
    lineChain,
    activeBridgeTrailCount: bridgeTrailCapacity
  };

  return { points, lines, data };
}

function updateRainChains(system, elapsed, delta) {
  const data = system.data;
  system.points.material.uniforms.uTime.value = elapsed;
  system.lines.material.uniforms.uTime.value = elapsed;

  for (let chain = 0; chain < data.count; chain += 1) {
    const isAmbientCurtain = data.role[chain] === RAIN_ROLE.AMBIENT;
    const previousTail = data.headY[chain] - data.length[chain];
    if (isAmbientCurtain) {
      data.headY[chain] = rainCeilingY - 0.03;
    } else {
      data.headY[chain] -= data.speed[chain] * delta * 0.58 * (0.92 + state.burst * 0.08);
    }
    const tail = data.headY[chain] - data.length[chain];
    const phase = data.phase[chain];
    const wind = Math.sin(elapsed * data.windSpeed[chain] + phase);
    const counterWind = Math.cos(elapsed * data.windSpeed[chain] * 0.72 + phase * 0.7);
    const pathX = data.baseX[chain] + wind * data.driftX[chain];
    const pathZ = data.z[chain] + counterWind * data.driftZ[chain];
    data.pathX[chain] = pathX;
    data.pathZ[chain] = pathZ;

    if (
      !isAmbientCurtain
      && data.presence[chain] > 0.08
      && previousTail >= WATER_LEVEL
      && tail < WATER_LEVEL
    ) {
      const stormWeight = queueRainImpact(
        impactPearls,
        pathX,
        pathZ,
        data.hour[chain],
        data.strength[chain],
        data.near[chain],
        data.role[chain],
        elapsed
      );
      tryEmitImpactRipple(
        impactPearls,
        rippleSystem,
        pathX,
        pathZ,
        data.strength[chain],
        stormWeight,
        data.role[chain],
        elapsed
      );
    }

    // Recycle at the impact plane. The water shader supplies the reflection;
    // the actual rain geometry must never continue into the water volume.
    if (!isAmbientCurtain && tail < WATER_LEVEL) {
      resetChainPosition(data, chain, false);
    }
  }

  for (let pearl = 0; pearl < data.pearlCount; pearl += 1) {
    const chain = data.pearlChain[pearl];
    const fraction = data.pearlFraction[pearl];
    const positionIndex = pearl * 3;
    const rawY = data.headY[chain] - fraction * data.length[chain] + data.pearlOffsetY[pearl];
    const y = Math.min(rawY, rainCeilingY);
    const ceilingFade = 1 - smoothstep(
      rainCeilingY - 0.055,
      rainCeilingY,
      rawY
    );
    const columnHeight = Math.max(0.8, data.top[chain] - WATER_LEVEL);
    const heightRatio = (y - WATER_LEVEL) / columnHeight;
    const nearWater = 1 - clamp(heightRatio, 0, 1);
    const pathX = data.pathX[chain];
    const pathZ = data.pathZ[chain];
    const focus = chainFocus(data.hour[chain], data.baseX[chain], data.z[chain]);
    const shimmer = 0.9 + Math.sin(elapsed * 4.2 + data.pearlShimmer[pearl]) * 0.12;
    const upperProgress = smoothstep(0.55, 1, heightRatio);
    const retention = lerp(1, data.pearlTopRetention[pearl], Math.pow(upperProgress, 1.15));
    const densityVisibility = upperProgress <= 0
      ? 1
      : 1 - smoothstep(retention - 0.06, retention + 0.06, data.pearlUpperSeed[pearl]);
    const upperSizeScale = lerp(1, data.pearlTopSize[pearl], Math.pow(upperProgress, 1.05));
    const upperAlphaScale = lerp(1, data.pearlTopAlpha[pearl], Math.pow(upperProgress, 1.1))
      * densityVisibility;
    const role = data.role[chain];
    const stormWeight = data.stormWeight[chain];
    const transitionTop = data.waterfallBlendTop[chain];
    const transitionWidth = data.waterfallFeather[chain];
    const waterfallTransition = stormWeight * (
      1 - smoothstep(transitionTop - transitionWidth, transitionTop + transitionWidth, y)
    );
    const morphRetention = clamp((data.pearlUpperSeed[pearl] - 0.55) / 0.27, 0, 1);
    const finalPearlScale = role === RAIN_ROLE.DOWNPOUR
      ? lerp(0.5, 0.82, morphRetention)
      : lerp(0.4, 0.68, morphRetention);
    const curtainFloorScale = lerp(
      1,
      finalPearlScale,
      waterfallTransition
    );
    const sizeWaterfallScale = lerp(
      1,
      role === RAIN_ROLE.DOWNPOUR
        ? lerp(0.96, 1.62, morphRetention)
        : lerp(0.78, 1.36, morphRetention),
      smoothstep(0.22, 1, waterfallTransition)
    );
    const deepWaterfallFade = lerp(
      1,
      role === RAIN_ROLE.DOWNPOUR
        ? lerp(0.76, 0.98, morphRetention)
        : lerp(0.62, 0.86, morphRetention),
      smoothstep(0.48, 1, waterfallTransition)
    );
    // Fade the bead before its screen-space body reaches the water. Mist and
    // impact particles bridge the contact, while the rain itself stays above.
    const rainFloorFade = role === RAIN_ROLE.DOWNPOUR
      ? smoothstep(WATER_LEVEL + 0.015, WATER_LEVEL + 0.1, y)
      : smoothstep(WATER_LEVEL + 0.02, WATER_LEVEL + 0.12, y);
    const lowerCurtain = data.curtainLayer[chain] === 1 ? 1 : 0;
    // 🎛️ 近水提亮对应 TUNING.floorGlow。数值越大，雨珠接近水面时越亮。
    const bottomGlow = role === RAIN_ROLE.BASE
      ? 1
        + smoothstep(0.02, 0.5, nearWater)
          * (TUNING.floorGlow.base + data.strength[chain] * TUNING.floorGlow.baseByStrength)
          * (1 - stormWeight)
        + lowerCurtain
          * (TUNING.floorGlow.lowerCurtain + data.strength[chain] * TUNING.floorGlow.lowerCurtainByStrength)
          * (1 - stormWeight)
      : role === RAIN_ROLE.DOWNPOUR
        ? 1 + smoothstep(0.02, 0.54, nearWater)
          * (TUNING.floorGlow.downpour + data.strength[chain] * TUNING.floorGlow.downpourByStrength)
          * (1 - stormWeight)
        : 1 + smoothstep(0.02, 0.5, nearWater) * TUNING.floorGlow.ambient;

    data.pearlPositions[positionIndex] = pathX;
    data.pearlPositions[positionIndex + 1] = y;
    data.pearlPositions[positionIndex + 2] = pathZ;
    data.pearlUpperScales[pearl] = upperSizeScale * sizeWaterfallScale;
    data.pearlUpperProgress[pearl] = upperProgress;
    data.pearlAlphas[pearl] = clamp(
      data.pearlBaseAlpha[pearl]
        * data.alpha[chain]
        * shimmer
        * ceilingFade
        * upperAlphaScale
        * rainFloorFade
        * bottomGlow
        * curtainFloorScale
        * deepWaterfallFade
        * (1 + focus * 0.56 + state.burst * localHourFocus(data.hour[chain], state.selectedHour) * 0.38),
      0,
      0.96
    );
  }

  for (let segment = 0; segment < data.lineTotal; segment += 1) {
    const a = data.linePearlA[segment] * 3;
    const b = data.linePearlB[segment] * 3;
    const lineIndex = segment * 6;
    const alphaIndex = segment * 2;
    const chain = data.lineChain[segment];
    const role = data.role[chain];
    const segmentY = (data.pearlPositions[a + 1] + data.pearlPositions[b + 1]) * 0.5;
    const stormWeight = data.stormWeight[chain];
    const transitionTop = data.waterfallBlendTop[chain];
    const transitionWidth = data.waterfallFeather[chain];
    const waterfallTransition = stormWeight * (
      1 - smoothstep(
        transitionTop - transitionWidth,
        transitionTop + transitionWidth,
        segmentY
      )
    );
    const bridgeBoost = 1 + 4 * waterfallTransition * (1 - waterfallTransition) * 0.88;
    const lineFloorScale = lerp(
      1,
      role === RAIN_ROLE.DOWNPOUR ? 0.12 : 0.2,
      waterfallTransition
    ) * bridgeBoost;
    const focus = chainFocus(data.hour[chain], data.baseX[chain], data.z[chain]);
    const endpointVisibility = clamp(
      (data.pearlAlphas[data.linePearlA[segment]] + data.pearlAlphas[data.linePearlB[segment]]) * 0.86,
      0,
      1
    );
    const lineRoleBoost = role === RAIN_ROLE.DOWNPOUR
      ? 2.45
      : role === RAIN_ROLE.AMBIENT ? 1.2 : 1;
    const alpha = data.lineBaseAlpha[segment]
      * endpointVisibility
      * (0.76 + focus * 0.52)
      * lineRoleBoost
      * lineFloorScale;

    data.linePositions[lineIndex] = data.pearlPositions[a];
    data.linePositions[lineIndex + 1] = Math.max(WATER_LEVEL + 0.006, data.pearlPositions[a + 1]);
    data.linePositions[lineIndex + 2] = data.pearlPositions[a + 2];
    data.linePositions[lineIndex + 3] = data.pearlPositions[b];
    data.linePositions[lineIndex + 4] = Math.max(WATER_LEVEL + 0.006, data.pearlPositions[b + 1]);
    data.linePositions[lineIndex + 5] = data.pearlPositions[b + 2];
    data.lineAlphas[alphaIndex] = alpha * 0.58;
    data.lineAlphas[alphaIndex + 1] = alpha;
  }

  system.points.geometry.attributes.position.needsUpdate = true;
  system.points.geometry.attributes.aAlpha.needsUpdate = true;
  system.points.geometry.attributes.aUpperScale.needsUpdate = true;
  system.points.geometry.attributes.aUpperProgress.needsUpdate = true;
  system.lines.geometry.attributes.position.needsUpdate = true;
  system.lines.geometry.attributes.aAlpha.needsUpdate = true;
}

// 白天乌云的天空穹顶。在球体内表面着色，每帧跟随相机位置（见 animate 里的
// skyDome.position.copy），所以半径取 1 就够 —— 它表现的是“无穷远”，
// 既不会被 camera.far 裁掉，也不会在镜头拉远时露出边界。
function createSkyDome() {
  const geometry = new THREE.SphereGeometry(1, 40, 24);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSkyTop: { value: new THREE.Color(TUNING.sky.topColor) },
      uSkyHorizon: { value: new THREE.Color(TUNING.sky.horizonColor) },
      uCloudColor: { value: new THREE.Color(TUNING.sky.cloudColor) },
      uCloudCover: { value: TUNING.sky.cloudCover },
      uCloudScale: { value: TUNING.sky.cloudScale },
      uCloudSpeed: { value: TUNING.sky.cloudSpeed }
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform vec3 uSkyTop;
      uniform vec3 uSkyHorizon;
      uniform vec3 uCloudColor;
      uniform float uCloudCover;
      uniform float uCloudScale;
      uniform float uCloudSpeed;
      varying vec3 vDir;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }
      float valueNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
      }
      float fbm(vec2 p) {
        float total = 0.0;
        float amplitude = 0.5;
        for (int i = 0; i < 5; i++) {
          total += amplitude * valueNoise(p);
          p *= 2.02;
          amplitude *= 0.5;
        }
        return total;
      }

      void main() {
        vec3 dir = normalize(vDir);
        float height = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);

        // 天顶 → 地平线的渐变
        vec3 color = mix(uSkyHorizon, uSkyTop, pow(height, 0.75));

        // 云：把球面方向投影到平面，形成云层的透视。除数不能太小 —— 之前钳到 0.02，
        // 地平线附近噪声坐标会爆炸成高频噪点，浮点精度丢失后被拉成竖条纹伪影。
        // 现在钳到 0.12，并且在地平线附近把云整体淡出：远处的云本来就该融进雾气。
        float above = max(dir.y, 0.12);
        vec2 cloudUv = dir.xz / above * uCloudScale;
        float drift = uTime * uCloudSpeed;
        float clouds = fbm(cloudUv + vec2(drift, drift * 0.35));
        // 第二层反向缓慢漂移，让云互相错动，而不是整片平移
        float clouds2 = fbm(cloudUv * 1.9 - vec2(drift * 0.6, drift * 0.2));
        clouds = mix(clouds, clouds2, 0.35);

        float edge = 1.0 - uCloudCover;
        float cloudMask = smoothstep(edge, edge + 0.32, clouds);
        cloudMask *= smoothstep(0.04, 0.22, dir.y);
        color = mix(color, uCloudColor, cloudMask * 0.88);

        // 地平线以下：水面是半透明的（alpha 上限 0.88），这里的颜色会从水面底下透出来。
        // 如果继续画云，就会看到“云从湖里透上来”的怪相 —— 上下移动镜头时尤其明显。
        // 所以地平线以下收敛成一个压暗的水雾色，把云彻底挡在水线以上。
        vec3 belowColor = uSkyHorizon * 0.42;
        color = mix(belowColor, color, smoothstep(-0.06, 0.04, dir.y));

        // 自定义着色器不带 colorspace_fragment，这里自己做 linear → sRGB
        gl_FragColor = vec4(pow(max(color, 0.0), vec3(0.4545)), 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  return mesh;
}

function createWaterPlane() {
  // 湖面要大到看不见边界，才读作“一整片湖”。段数只决定顶点起伏的采样精度：
  // 桌面给足，移动端往下砍一档，避免小 GPU 上顶点量白翻一倍。
  const lakeSize = 420;
  const lakeSegments = isCoarsePointer ? 120 : 220;
  const geometry = new THREE.PlaneGeometry(lakeSize, lakeSize, lakeSegments, lakeSegments);
  geometry.rotateX(-Math.PI / 2);
  // Keep the rendered surface on the same height as the rain impact plane.
  // A lower offset exposed a dark horizontal slit in near-frontal views.
  geometry.translate(0, WATER_LEVEL, 1.25);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColorDeep: { value: new THREE.Color(TUNING.water.deepColor) },
      uColorSurface: { value: new THREE.Color(TUNING.water.surfaceColor) },
      uRoughness: { value: TUNING.water.roughness },
      uSpecularStrength: { value: TUNING.water.specularStrength },
      uRippleHighlight: { value: TUNING.water.rippleHighlight },
      uSurfaceOpacity: { value: TUNING.water.surfaceOpacity },
      uHeightField: { value: null },
      uFieldBounds: {
        value: new THREE.Vector4(
          RIPPLE_FIELD.xMin,
          RIPPLE_FIELD.xMax,
          RIPPLE_FIELD.zMin,
          RIPPLE_FIELD.zMax
        )
      },
      uFieldTexel: { value: new THREE.Vector2(1 / RIPPLE_FIELD.resX, 1 / RIPPLE_FIELD.resZ) },
      uRippleGain: { value: TUNING.ripple.gain },
      uRippleDisplace: { value: TUNING.ripple.displace },
      uWavePrimary: { value: TUNING.water.wavePrimary },
      uWaveSecondary: { value: TUNING.water.waveSecondary },
      uWaveNormal: { value: TUNING.water.waveNormal },
      // 远处的水面要融进天空色，水天之间才是一条柔和的交界，而不是硬边
      uSkyColor: { value: new THREE.Color(TUNING.sky.horizonColor) },
      uHorizonFade: { value: TUNING.sky.horizonFade },
      // 降雨强度 LUT（与 mistBand 共享）：按世界 X 给出该列真实雨量，
      // 让水面倒影与上方雨柱逐列对齐。值在场景装配后注入。
      uRainLut: { value: null },
      uLutBounds: { value: new THREE.Vector2(hourToX(0), hourToX(24) - hourToX(0)) },
      // 倒影外观（面板实时可调）
      uReflStrength: { value: TUNING.water.reflStrength },
      uReflFade: { value: TUNING.water.reflFade },
      uRearFadeNearZ: { value: TUNING.water.rearFadeNearZ },
      uRearFadeFarZ: { value: TUNING.water.rearFadeFarZ }
    },
    vertexShader: `
      uniform float uTime;
      uniform sampler2D uHeightField;
      uniform vec4 uFieldBounds;
      uniform float uRippleDisplace;
      uniform float uWavePrimary;
      uniform float uWaveSecondary;
      varying vec2 vUv;
      varying vec3 vWorld;

      void main() {
        vec3 transformed = position;
        // 湖面放大到 420 之后，原来的频率会密成一片噪点。这里改成大尺度长波，
        // 近处的细节波光交给片元阶段的 uWaveNormal，不依赖网格密度。
        float wave = sin(uTime * 0.55 + position.x * 0.052 + position.z * 0.031) * uWavePrimary;
        wave += sin(-uTime * 0.41 + position.x * 0.107 - position.z * 0.083) * uWaveSecondary;
        // GPU 高度场驱动真实顶点起伏 — 雨滴落点在水面上顶出凹坑并向外扩散
        vec2 fUv = vec2(
          (position.x - uFieldBounds.x) / (uFieldBounds.y - uFieldBounds.x),
          (position.z - uFieldBounds.z) / (uFieldBounds.w - uFieldBounds.z)
        );
        if (fUv.x > 0.0 && fUv.x < 1.0 && fUv.y > 0.0 && fUv.y < 1.0) {
          wave += texture2D(uHeightField, fUv).r * uRippleDisplace;
        }
        transformed.y += wave;
        vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
        vWorld = worldPosition.xyz;
        vUv = uv;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform vec3 uColorDeep;
      uniform vec3 uColorSurface;
      uniform float uRoughness;
      uniform float uSpecularStrength;
      uniform float uRippleHighlight;
      uniform float uSurfaceOpacity;
      uniform sampler2D uHeightField;
      uniform vec4 uFieldBounds;
      uniform vec2 uFieldTexel;
      uniform float uRippleGain;
      uniform float uWaveNormal;
      uniform vec3 uSkyColor;
      uniform float uHorizonFade;
      uniform sampler2D uRainLut;
      uniform vec2 uLutBounds;
      uniform float uReflStrength;
      uniform float uReflFade;
      uniform float uRearFadeNearZ;
      uniform float uRearFadeFarZ;
      varying vec2 vUv;
      varying vec3 vWorld;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }
      float valueNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
      }
      float fbm(vec2 p) {
        float total = 0.0;
        float amplitude = 0.5;
        for (int k = 0; k < 4; k++) {
          total += amplitude * valueNoise(p);
          p *= 2.03;
          amplitude *= 0.5;
        }
        return total;
      }

      void main() {
        // Sample GPU height field neighbours → per-pixel surface normal
        vec2 fUv = vec2(
          (vWorld.x - uFieldBounds.x) / (uFieldBounds.y - uFieldBounds.x),
          (vWorld.z - uFieldBounds.z) / (uFieldBounds.w - uFieldBounds.z)
        );
        float hC = 0.0, hL = 0.0, hR = 0.0, hT = 0.0, hB = 0.0;
        if (fUv.x > 0.01 && fUv.x < 0.99 && fUv.y > 0.01 && fUv.y < 0.99) {
          hC = texture2D(uHeightField, fUv).r;
          hL = texture2D(uHeightField, fUv - vec2(uFieldTexel.x, 0.0)).r;
          hR = texture2D(uHeightField, fUv + vec2(uFieldTexel.x, 0.0)).r;
          hT = texture2D(uHeightField, fUv + vec2(0.0, uFieldTexel.y)).r;
          hB = texture2D(uHeightField, fUv - vec2(0.0, uFieldTexel.y)).r;
        }

        // Surface normal from finite-difference height gradients.
        // Fixed scale: gradient of ~0.08 → ~15° tilt — subtle but visible.
        // uRippleGain only controls reflected light energy, not geometry height.
        float nScale = 3.5;
        vec3 normal = normalize(vec3((hL - hR) * nScale, 1.0, (hB - hT) * nScale));

        // 常驻细节波纹：用流动噪声的梯度扰动法线，让【整片湖面】都有碎波光，
        // 而不是只有图表范围内的高度场涟漪 —— 高度场只覆盖图表区域，湖面其余部分
        // 全靠这一层提供“水感”。噪声约 3 个世界单位一个波包、随时间缓慢流动；
        // 只影响光泽、不改动几何，所以不受网格密度限制，uWaveNormal 调 0 即关闭。
        vec2 detailUv = vWorld.xz * 0.34;
        vec2 detailDrift = vec2(uTime * 0.06, uTime * 0.042);
        float detailE = 0.14;
        float detailC = fbm(detailUv + detailDrift);
        float detailX = fbm(detailUv + vec2(detailE, 0.0) + detailDrift);
        float detailZ = fbm(detailUv + vec2(0.0, detailE) + detailDrift);
        normal = normalize(
          normal + vec3(detailC - detailX, 0.0, detailC - detailZ) * (uWaveNormal / detailE)
        );

        // Physical water lighting: Fresnel + specular + diffuse
        vec3 viewDir   = normalize(cameraPosition - vWorld);
        vec3 lightDir  = normalize(vec3(-0.35, 0.88, 0.42));
        float diffuse  = max(dot(normal, lightDir), 0.0);
        float fresnel  = pow(1.0 - max(dot(normal, viewDir), 0.0), 3.5);
        vec3 reflDir   = reflect(-lightDir, normal);
        float specularPower = mix(150.0, 28.0, uRoughness);
        float specular = pow(max(dot(reflDir, viewDir), 0.0), specularPower);

        // Use local slope + curvature instead of broad height values. This keeps
        // highlights on the moving ripple rings rather than whitening the whole
        // surface into a frosted sheet.
        float neighbourAverage = (hL + hR + hT + hB) * 0.25;
        float rippleSlope = length(vec2(hL - hR, hB - hT));
        float rippleCurvature = abs(hC - neighbourAverage);
        float rippleSignal = (rippleSlope * 1.7 + rippleCurvature * 2.8) * uRippleGain;
        float rippleEnergy = smoothstep(0.08, 0.68, rippleSignal);
        float rippleHighlight = pow(rippleEnergy, 1.65);
        float rippleGlow = rippleHighlight * (0.42 + diffuse * 0.48);

        // Keep the base water dark and mirror-like; reserve the pale blue-white
        // energy for narrow specular and ripple highlights.
        vec3 edgeColor = vec3(0.58, 0.69, 0.82);
        vec3 rippleColor = vec3(0.72, 0.84, 0.96);
        float surfaceFill = mix(0.12, 0.34, uRoughness);
        float fresnelFill = mix(0.42, 0.24, uRoughness);
        float diffuseFill = mix(0.025, 0.2, uRoughness);
        vec3 color = mix(
          uColorDeep,
          uColorSurface,
          surfaceFill + fresnel * fresnelFill + diffuse * diffuseFill
        );
        color += edgeColor * specular * uSpecularStrength;
        color += rippleColor * rippleGlow * uRippleHighlight;

        // Rain-column reflection: rain above mirrors into the dark water surface
        float dz        = vWorld.z - 1.15;
        float depthFade = smoothstep(-0.7, 0.0, dz) * (1.0 - smoothstep(0.2, uReflFade, dz));
        float wobX      = vWorld.x + (hL - hR) * 1.15;
        float lutX      = clamp((wobX - uLutBounds.x) / uLutBounds.y, 0.0, 1.0);
        float colRain   = pow(texture2D(uRainLut, vec2(lutX, 0.5)).r, 1.3);
        float hMask     = smoothstep(-0.01, 0.05, lutX) * (1.0 - smoothstep(0.95, 1.01, lutX));
        // Gentle shimmer driven by height field, not synthetic sine stripes
        float shimmer = 0.7 + 0.3 * sin(uTime * 0.9 + wobX * 1.4 + dz * 2.2 + hC * 4.0);
        // Grey-blue reflection matches pearl colour → bridges rain-to-water
        float rippleReflection = 1.0 + rippleHighlight * 0.62;
        color += vec3(0.56, 0.66, 0.78)
          * colRain * depthFade * hMask * shimmer * uReflStrength * rippleReflection;

        // Broad waterline seam: soft grey-blue glow where rain meets water
        float seam = colRain * exp(-pow(dz * 1.4, 2.0)) * 0.5 * hMask;
        color += vec3(0.44, 0.54, 0.66) * seam;

        // Clamp the physical surface opacity first, then apply the rear mask.
        // This matters when surfaceOpacity > 1: otherwise the clamp keeps most
        // of the fade fully opaque and produces a sudden edge near the back.
        float frontFade = smoothstep(0.0, 0.14, vUv.y);
        float rearFade = smoothstep(
          min(uRearFadeFarZ, uRearFadeNearZ),
          max(uRearFadeFarZ, uRearFadeNearZ),
          vWorld.z
        );
        float surfaceAlpha = min(
          0.88,
          uSurfaceOpacity + fresnel * 0.18 + rippleGlow * 0.3
        );
        // Feather both physical side edges so rotating the scene never reveals
        // the water plane as a hard rectangular wall.
        float sideFade = smoothstep(0.0, 0.16, vUv.x)
          * smoothstep(0.0, 0.16, 1.0 - vUv.x);
        float alpha = surfaceAlpha * frontFade * rearFade * sideFade;
        if (alpha < 0.002) discard;

        // 远处的水面渐变成天空色：水天之间因此是一条柔和的交界，
        // 而不是一块深色水面硬生生贴在天空上。
        // uSkyColor 是线性值，这里同样补一次 linear→sRGB 才能和天空穹顶对上。
        float distToCamera = length(vWorld.xz - cameraPosition.xz);
        float horizon = smoothstep(uHorizonFade * 0.3, uHorizonFade, distToCamera);
        color = mix(color, pow(max(uSkyColor, 0.0), vec3(0.4545)) * 0.94, horizon);

        gl_FragColor = vec4(color, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 0;
  return mesh;
}

// A thin, dark-teal floor sitting 0.28 units below the water surface, visible
// through the semi-transparent water plane. Creates the "shallow pool" depth cue
// — you can almost see the bottom through the water.
function createPoolFloor() {
  const geometry = new THREE.PlaneGeometry(WORLD.width * 1.16, WORLD.depth * 2.3);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, WATER_LEVEL - 0.28, 1.25);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(TUNING.water.deepColor) },
      uRearFadeNearZ: { value: TUNING.water.rearFadeNearZ },
      uRearFadeFarZ: { value: TUNING.water.rearFadeFarZ }
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vWorld;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vUv = uv;
        vWorld = worldPosition.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uRearFadeNearZ;
      uniform float uRearFadeFarZ;
      varying vec2 vUv;
      varying vec3 vWorld;
      void main() {
        float frontFade = smoothstep(0.0, 0.12, vUv.y);
        float rearFade = smoothstep(
          min(uRearFadeFarZ, uRearFadeNearZ),
          max(uRearFadeFarZ, uRearFadeNearZ),
          vWorld.z
        );
        float sideFade = smoothstep(0.0, 0.18, vUv.x)
          * smoothstep(0.0, 0.18, 1.0 - vUv.x);
        float alpha = 0.75 * frontFade * rearFade * sideFade;
        if (alpha < 0.002) discard;
        gl_FragColor = vec4(uColor, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = -1;
  return mesh;
}

// Soft, continuous glowing mist hovering at the waterline. Its horizontal
// intensity follows the rainfall curve via a precomputed lookup texture, so the
// haze is brightest beneath heavy rain and fades where there is little — exactly
// the milky band in the reference, instead of scattered dots.
function createMistBand() {
  const N = 256;
  const xMin = hourToX(0);
  const xMax = hourToX(24);
  const span = xMax - xMin;

  const acc = new Float32Array(N);
  const wsum = new Float32Array(N);
  for (let h = 0; h <= 24; h += 0.04) {
    const frac = clamp((hourToX(h) - xMin) / span, 0, 1);
    const s = sampleRainStrength(h);
    const center = frac * (N - 1);
    const radius = 7;
    const lo = Math.max(0, Math.floor(center - radius));
    const hi = Math.min(N - 1, Math.ceil(center + radius));
    for (let j = lo; j <= hi; j += 1) {
      const d = (j - center) / radius;
      const w = Math.exp(-d * d * 1.3);
      acc[j] += s * w;
      wsum[j] += w;
    }
  }
  const packed = new Float32Array(N * 4);
  for (let j = 0; j < N; j += 1) {
    const hour = j / (N - 1) * 24;
    const presence = sampleRainPresence(hour);
    const intensity = (wsum[j] > 0 ? Math.pow(acc[j] / wsum[j], 1.12) : 0) * presence;
    packed[j * 4] = intensity;
    packed[j * 4 + 1] = intensity;
    packed[j * 4 + 2] = intensity;
    packed[j * 4 + 3] = 1;
  }
  const lut = new THREE.DataTexture(packed, N, 1, THREE.RGBAFormat, THREE.FloatType);
  lut.minFilter = THREE.LinearFilter;
  lut.magFilter = THREE.LinearFilter;
  lut.wrapS = THREE.ClampToEdgeWrapping;
  lut.wrapT = THREE.ClampToEdgeWrapping;
  lut.needsUpdate = true;

  const height = TUNING.mist.height;
  const geometry = new THREE.PlaneGeometry(span * 1.01, height, 1, 1);
  geometry.translate((xMin + xMax) * 0.5, WATER_LEVEL + height * 0.5 - 0.42, 1.15);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uLut: { value: lut },
      uColor: { value: new THREE.Color(TUNING.mist.color) },
      uOpacity: { value: TUNING.mist.opacity },
      uReflOpacity: { value: TUNING.mist.reflectionOpacity },
      uViewport: { value: rainViewport },
      uPlotBounds: { value: rainPlotBounds },
      uPlotFeather: { value: rainPlotFeather }
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform sampler2D uLut;
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uReflOpacity;
      uniform vec2 uViewport;
      uniform vec4 uPlotBounds;
      uniform vec3 uPlotFeather;
      varying vec2 vUv;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(41.21, 289.7))) * 43758.5453);
      }

      void main() {
        float intensity = texture2D(uLut, vec2(vUv.x, 0.5)).r;
        // Vertical profile: a bright core right at the waterline that fades up
        // into a low haze, and fades OUT below the waterline so the band never
        // shows as a panel beneath the axis.
        float core = exp(-pow((vUv.y - 0.14) * 6.4, 2.0));
        float haze = exp(-pow((vUv.y - 0.2) * 2.4, 2.0)) * 0.5;
        float lowerCut = smoothstep(0.05, 0.14, vUv.y);
        float yb = (core + haze) * lowerCut;
        // Gentle breathing + fine grain so the band reads as drifting vapour.
        float drift = 0.88 + 0.12 * sin(uTime * 0.5 + vUv.x * 7.3);
        float grain = 0.9 + 0.1 * hash(floor(vUv * vec2(120.0, 92.0)) + floor(uTime * 1.3));
        intensity *= drift * grain;

        vec2 screenUv = vec2(
          gl_FragCoord.x / uViewport.x,
          1.0 - gl_FragCoord.y / uViewport.y
        );
        float horizontalMask = smoothstep(
          uPlotBounds.x,
          uPlotBounds.x + uPlotFeather.x,
          screenUv.x
        ) * (1.0 - smoothstep(
          uPlotBounds.y - uPlotFeather.x,
          uPlotBounds.y,
          screenUv.x
        ));

        // Reflection of the rain in the water just below the waterline — a dim,
        // vertically-streaked glow that fades down with depth.
        float reflBand = smoothstep(0.0, 0.11, vUv.y) * (1.0 - smoothstep(0.1, 0.135, vUv.y));
        float reflStreak = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(vUv.x * 240.0 + hash(vec2(floor(vUv.x * 60.0), 1.0)) * 7.0), 1.8);
        float reflWobble = 0.85 + 0.15 * sin(uTime * 1.2 + vUv.x * 30.0);
        float refl = reflBand * reflStreak * reflWobble;

        float sideFade = smoothstep(0.0, 0.08, vUv.x)
          * smoothstep(0.0, 0.08, 1.0 - vUv.x);
        float a = intensity * (yb + refl * uReflOpacity) * uOpacity * horizontalMask * sideFade;
        if (a < 0.002) discard;
        vec3 color = uColor * (0.7 + intensity * 0.6);
        gl_FragColor = vec4(color, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'rain-mist-band';
  mesh.renderOrder = 1.7;
  mesh.frustumCulled = false;

  return { mesh, material, lut, lutXMin: xMin, lutSpan: span };
}

function updateMistBandHeight(system, height) {
  const safeHeight = Math.max(0.001, height);
  const centerX = system.lutXMin + system.lutSpan * 0.5;
  const geometry = new THREE.PlaneGeometry(system.lutSpan * 1.01, safeHeight, 1, 1);
  geometry.translate(centerX, WATER_LEVEL + safeHeight * 0.5 - 0.42, 1.15);
  system.mesh.geometry.dispose();
  system.mesh.geometry = geometry;
}

function createPeakWaterfallSystem(filamentCount, rainData) {
  const group = new THREE.Group();
  group.name = 'peak-waterfall-system';

  const bodyGeometry = createPeakWaterfallBodyGeometry();
  const bodyMaterial = createPeakWaterfallBodyMaterial();
  const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
  body.name = 'peak-waterfall-density-body';
  body.renderOrder = 1.5;
  body.frustumCulled = false;

  const filamentSet = createPeakWaterfallFilamentGeometry(filamentCount, rainData);
  const filamentMaterial = createPeakWaterfallFilamentMaterial(false);
  const filaments = new THREE.Mesh(filamentSet.geometry, filamentMaterial);
  filaments.name = 'peak-waterfall-filaments';
  filaments.renderOrder = 2.45;
  filaments.frustumCulled = false;

  const highlightMaterial = createPeakWaterfallFilamentMaterial(true);
  const highlights = new THREE.Mesh(filamentSet.highlightGeometry, highlightMaterial);
  highlights.name = 'peak-waterfall-filament-highlights';
  highlights.renderOrder = 2.75;
  highlights.frustumCulled = false;

  group.add(body, filaments, highlights);

  return {
    group,
    materials: [bodyMaterial, filamentMaterial, highlightMaterial],
    bodyCount: peakWaterfallRanges.length,
    peakCount: peakWaterfallRanges.length,
    filamentCapacity: filamentCount,
    visibleFilamentCount: filamentCount,
    bridgeFilamentCount: filamentSet.bridgeCount,
    coreFilamentCount: filamentSet.coreCount,
    lowerFilamentCount: filamentSet.lowerCount,
    wideFilamentCount: filamentSet.wideCount,
    foregroundFilamentCount: filamentSet.foregroundCount,
    highlightFilamentCount: filamentSet.highlightCount,
    ribbonSegments: filamentSet.ribbonSegments
  };
}

function createPeakWaterfallBodyGeometry() {
  const xSegments = 76;
  const ySegments = 30;
  const verticesPerPeak = (xSegments + 1) * (ySegments + 1);
  const vertexCount = verticesPerPeak * peakWaterfallRanges.length;
  const positions = new Float32Array(vertexCount * 3);
  const local = new Float32Array(vertexCount * 2);
  const storm = new Float32Array(vertexCount);
  const seed = new Float32Array(vertexCount);
  const indices = new Uint16Array(
    peakWaterfallRanges.length * xSegments * ySegments * 6
  );
  let vertexCursor = 0;
  let indexCursor = 0;

  for (let peak = 0; peak < peakWaterfallRanges.length; peak += 1) {
    const [startHour, endHour] = peakWaterfallRanges[peak];
    const peakVertexOffset = vertexCursor;

    for (let xIndex = 0; xIndex <= xSegments; xIndex += 1) {
      const xProgress = xIndex / xSegments;
      const hour = lerp(startHour, endHour, xProgress);
      const topY = sampleWaterfallTopY(hour);
      const stormWeight = sampleStormWeight(hour);
      const bottomY = WATER_LEVEL;
      const baseZ = 0.18 + (valueNoise(hour * 2.1, RAIN_CLUSTER_SEED ^ 0x71e503ab) - 0.5) * 0.16;

      for (let yIndex = 0; yIndex <= ySegments; yIndex += 1) {
        const yProgress = yIndex / ySegments;
        const positionIndex = vertexCursor * 3;
        const localIndex = vertexCursor * 2;
        positions[positionIndex] = hourToX(hour);
        positions[positionIndex + 1] = lerp(bottomY, topY, yProgress);
        positions[positionIndex + 2] = baseZ
          + (valueNoise(hour * 3.2 + yProgress * 1.7, RAIN_CLUSTER_SEED ^ 0x4f9a6d31) - 0.5) * 0.08;
        local[localIndex] = xProgress;
        local[localIndex + 1] = yProgress;
        storm[vertexCursor] = stormWeight;
        seed[vertexCursor] = peak * 17.3 + xProgress * 4.7;
        vertexCursor += 1;
      }
    }

    for (let xIndex = 0; xIndex < xSegments; xIndex += 1) {
      for (let yIndex = 0; yIndex < ySegments; yIndex += 1) {
        const column = ySegments + 1;
        const a = peakVertexOffset + xIndex * column + yIndex;
        const b = a + column;
        indices[indexCursor++] = a;
        indices[indexCursor++] = b;
        indices[indexCursor++] = a + 1;
        indices[indexCursor++] = b;
        indices[indexCursor++] = b + 1;
        indices[indexCursor++] = a + 1;
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aLocal', new THREE.BufferAttribute(local, 2));
  geometry.setAttribute('aStorm', new THREE.BufferAttribute(storm, 1));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  if (vertexCount > 0) geometry.computeBoundingSphere();
  return geometry;
}

function createPeakWaterfallBodyMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uMotion: { value: prefersReducedMotion ? 0 : 1 },
      uDeep: { value: new THREE.Color(TUNING.metalRain.darkColor) },
      uMid: { value: new THREE.Color(TUNING.metalRain.midColor) },
      uBright: { value: new THREE.Color(TUNING.metalRain.brightColor) },
      uBodyBandDensity: { value: TUNING.metalRain.bodyBandDensity },
      uBodyBandSpeed: { value: TUNING.metalRain.bodyBandSpeed },
      uBodyMirrorStrength: { value: TUNING.metalRain.bodyMirrorStrength },
      uBroadSway: { value: TUNING.waterfallBody.broadSway },
      uFineSway: { value: TUNING.waterfallBody.fineSway },
      uStreakFrequency: { value: TUNING.waterfallBody.streakFrequency },
      uFineStreakFrequency: { value: TUNING.waterfallBody.fineStreakFrequency },
      uStreakSharpness: { value: TUNING.waterfallBody.streakSharpness },
      uFineStreakSharpness: { value: TUNING.waterfallBody.fineStreakSharpness },
      uFineStreakWeight: { value: TUNING.waterfallBody.fineStreakWeight },
      uBaseMass: { value: TUNING.waterfallBody.baseMass },
      uRiseMass: { value: TUNING.waterfallBody.riseMass },
      uCloudLow: { value: TUNING.waterfallBody.cloudLow },
      uCloudHigh: { value: TUNING.waterfallBody.cloudHigh },
      uGapDarkness: { value: TUNING.waterfallBody.gapDarkness },
      uStreakBrightness: { value: TUNING.waterfallBody.streakBrightness },
      uBottomFeather: { value: TUNING.waterfallBody.bottomFeather },
      uOpacity: { value: TUNING.waterfallBody.opacity },
      uViewport: { value: rainViewport },
      uPlotBounds: { value: rainPlotBounds },
      uPlotFeather: { value: rainPlotFeather },
      uPlotClip: rainPlotClip
    },
    vertexShader: `
      uniform float uTime;
      uniform float uMotion;
      uniform float uBroadSway;
      uniform float uFineSway;
      attribute vec2 aLocal;
      attribute float aStorm;
      attribute float aSeed;
      varying vec2 vLocal;
      varying float vStorm;
      varying float vSeed;
      varying vec3 vWorld;

      void main() {
        float time = uTime * uMotion;
        vec3 transformed = position;
        float sway = sin(position.y * 2.8 - time * 1.9 + aSeed * 1.7) * uBroadSway;
        sway += sin(position.y * 7.1 - time * 4.2 - position.x) * uFineSway;
        transformed.x += sway * aStorm * (0.45 + aLocal.y * 0.55);
        vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
        vLocal = aLocal;
        vStorm = aStorm;
        vSeed = aSeed;
        vWorld = worldPosition.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform float uTime;
      uniform float uMotion;
      uniform vec3 uDeep;
      uniform vec3 uMid;
      uniform vec3 uBright;
      uniform float uBodyBandDensity;
      uniform float uBodyBandSpeed;
      uniform float uBodyMirrorStrength;
      uniform float uStreakFrequency;
      uniform float uFineStreakFrequency;
      uniform float uStreakSharpness;
      uniform float uFineStreakSharpness;
      uniform float uFineStreakWeight;
      uniform float uBaseMass;
      uniform float uRiseMass;
      uniform float uCloudLow;
      uniform float uCloudHigh;
      uniform float uGapDarkness;
      uniform float uStreakBrightness;
      uniform float uBottomFeather;
      uniform float uOpacity;
      uniform vec2 uViewport;
      uniform vec4 uPlotBounds;
      uniform vec3 uPlotFeather;
      uniform float uPlotClip;
      varying vec2 vLocal;
      varying float vStorm;
      varying float vSeed;
      varying vec3 vWorld;

      float hash(float n) { return fract(sin(n) * 43758.5453123); }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float n = i.x + i.y * 57.0;
        return mix(mix(hash(n), hash(n + 1.0), f.x), mix(hash(n + 57.0), hash(n + 58.0), f.x), f.y);
      }
      float fbm(vec2 p) {
        float value = noise(p) * 0.55;
        p = p * 2.03 + vec2(7.1, 13.7);
        value += noise(p) * 0.29;
        p = p * 2.07 + vec2(17.3, 5.9);
        value += noise(p) * 0.16;
        return value;
      }

      void main() {
        float time = uTime * uMotion;

        // Soft horizontal sheet edges.
        float edgeWarp = noise(vec2(vLocal.y * 6.0 - time * 0.6, vSeed));
        float edge = smoothstep(0.02 + edgeWarp * 0.04, 0.17, vLocal.x)
          * (1.0 - smoothstep(0.83, 0.98 - edgeWarp * 0.04, vLocal.x));

        // Vertical volume profile: a heavy bright mass at the base that billows
        // up and fades — the "reverse waterfall". Top feathers into the pearls.
        float baseMass = exp(-pow((vLocal.y - 0.04) * 2.6, 2.0));
        float rise = 1.0 - smoothstep(0.0, 0.8, vLocal.y);
        float topFade = 1.0 - smoothstep(0.6, 1.0, vLocal.y);

        // Soft organic billow (low frequency, slow) — this carries the volume
        // and light/dark, instead of hard procedural stripes.
        float billow = fbm(vec2(vWorld.x * 0.85 + vSeed * 0.3, vLocal.y * 1.7 - time * 0.5));
        float billow2 = fbm(vec2(vWorld.x * 1.7 - vSeed * 0.6, vLocal.y * 3.1 - time * 0.95));
        float cloud = smoothstep(0.22, 0.86, billow * 0.7 + billow2 * 0.42);

        // Vertical water-flow streaks give the bloom real texture (de-blur):
        // bright water columns separated by darker gaps, flowing downward.
        float warp = fbm(vec2(vWorld.x * 0.9 + vSeed, vLocal.y * 1.2 - time * 0.4));
        // 🎛️ 瀑布纹理对应 TUNING.waterfallBody：密度越大越细密，锐度越大越分明。
        float streaks = pow(
          0.5 + 0.5 * sin(vWorld.x * uStreakFrequency + warp * 5.0 + vSeed * 3.0),
          uStreakSharpness
        );
        float fineStreaks = pow(
          0.5 + 0.5 * sin(vWorld.x * uFineStreakFrequency + warp * 7.0),
          uFineStreakSharpness
        ) * uFineStreakWeight;
        float flow = clamp(streaks + fineStreaks, 0.0, 1.0);
        float advect = noise(vec2(vWorld.x * 8.0 + vSeed, vLocal.y * 6.0 + time * 2.0));
        flow *= (0.5 + advect * 0.75);

        // 🎛️ 瀑布密度对应 TUNING.waterfallBody：底部质量、云团对比、缝隙黑度、雨丝亮度。
        float volume = (baseMass * uBaseMass + rise * uRiseMass)
          * mix(uCloudLow, uCloudHigh, cloud)
          * mix(uGapDarkness, uStreakBrightness, flow);

        vec2 screenUv = vec2(
          gl_FragCoord.x / uViewport.x,
          1.0 - gl_FragCoord.y / uViewport.y
        );
        float horizontalMask = smoothstep(
          uPlotBounds.x,
          uPlotBounds.x + uPlotFeather.x,
          screenUv.x
        ) * (1.0 - smoothstep(
          uPlotBounds.y - uPlotFeather.x,
          uPlotBounds.y,
          screenUv.x
        ));
        horizontalMask = mix(1.0, horizontalMask, uPlotClip);
        float lowerMask = 1.0 - smoothstep(
          uPlotBounds.w - uPlotFeather.z,
          uPlotBounds.w,
          screenUv.y
        );
        lowerMask = mix(1.0, lowerMask, uPlotClip);

        // Feather the bottom edge to black so the noisy geometry base never reads
        // as a lit "wave" silhouette near the waterline — it dissolves into the dark.
        // 🎛️ 瀑布底边对应 TUNING.waterfallBody.bottomFeather。
        float bottomFeather = smoothstep(0.0, max(0.0001, uBottomFeather), vLocal.y);
        float intensity = volume * edge * topFade * vStorm * horizontalMask * lowerMask * bottomFeather;
        if (intensity < 0.002) discard;

        // Moving black/silver reflection bands turn the procedural volume into
        // a mercury sheet. Normal alpha blending is used below so the dark
        // chrome cavities remain visible instead of disappearing additively.
        float reflectionSweep = 0.5 + 0.5 * sin(
          vWorld.x * uBodyBandDensity
          + warp * 5.4
          - vLocal.y * 2.1
          - time * uBodyBandSpeed
        );
        float mirrorBand = smoothstep(0.46, 0.9, reflectionSweep + flow * 0.18);
        float cavityBand = smoothstep(0.6, 0.96, 1.0 - reflectionSweep + (1.0 - cloud) * 0.14);
        vec3 color = mix(uDeep, uMid, clamp(cloud * 0.5 + volume * 0.16, 0.0, 1.0));
        color = mix(color, uBright, clamp(
          mirrorBand * uBodyMirrorStrength + flow * 0.3 + baseMass * 0.08,
          0.0,
          1.0
        ));
        color = mix(color, uDeep, cavityBand * 0.72);
        float metalAlpha = clamp(1.0 - exp(-intensity * uOpacity * 0.72), 0.0, 0.92);
        gl_FragColor = vec4(color, metalAlpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending
  });
}

function createPeakWaterfallFilamentGeometry(count, rainData) {
  const geometry = new THREE.InstancedBufferGeometry();
  const ribbonSegments = 14;
  const vertexCount = (ribbonSegments + 1) * 2;
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint16Array(ribbonSegments * 6);
  let vertexCursor = 0;
  let indexCursor = 0;

  for (let segment = 0; segment <= ribbonSegments; segment += 1) {
    const localY = segment / ribbonSegments;
    for (let side = 0; side < 2; side += 1) {
      const positionIndex = vertexCursor * 3;
      const uvIndex = vertexCursor * 2;
      positions[positionIndex] = side === 0 ? -0.5 : 0.5;
      positions[positionIndex + 1] = localY;
      positions[positionIndex + 2] = 0;
      uvs[uvIndex] = side;
      uvs[uvIndex + 1] = localY;
      vertexCursor += 1;
    }
  }

  for (let segment = 0; segment < ribbonSegments; segment += 1) {
    const a = segment * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices[indexCursor++] = a;
    indices[indexCursor++] = b;
    indices[indexCursor++] = c;
    indices[indexCursor++] = c;
    indices[indexCursor++] = b;
    indices[indexCursor++] = d;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  const anchor = new Float32Array(count * 3);
  const dimensions = new Float32Array(count * 2);
  const flow = new Float32Array(count * 4);
  const breaks = new Float32Array(count * 2);
  const storm = new Float32Array(count);
  const drift = new Float32Array(count * 3);
  const filamentClass = new Float32Array(count);
  const random = createSeededRandom(RAIN_CLUSTER_SEED ^ 0x6e52c9b3);
  const peakHourSampler = createIntegratedDownpourHourSampler(random);
  const highlightCount = Math.round(count * 0.06);
  const foregroundTarget = highlightCount;
  const bridgeTarget = rainData.downpourCount > 0 ? Math.round(count * 0.24) : 0;
  const coreTarget = Math.round(count * 0.6);
  let bridgeCount = 0;
  let coreCount = 0;
  let wideCount = 0;
  let foregroundCount = 0;

  for (let i = 0; i < count; i += 1) {
    const isForeground = i < foregroundTarget;
    const isBridge = !isForeground && i < foregroundTarget + bridgeTarget;
    const isCore = !isForeground && !isBridge && i < foregroundTarget + bridgeTarget + coreTarget;
    const isWide = !isForeground && !isBridge && !isCore;
    filamentClass[i] = isBridge ? 0 : isCore ? 1 : isWide ? 2 : 3;
    let hour = 18;
    let stormWeight = 0;
    const positionIndex = i * 3;
    const dimensionIndex = i * 2;
    const flowIndex = i * 4;
    const breakIndex = i * 2;
    const driftIndex = i * 3;

    if (isBridge) {
      const downpourIndex = rainData.baseCount
        + rainData.ambientCount
        + Math.floor(random() * rainData.downpourCount);
      hour = rainData.hour[downpourIndex];
      stormWeight = rainData.stormWeight[downpourIndex];
      const topY = rainData.waterfallTop[downpourIndex];
      const bridgeBottom = Math.max(WATER_LEVEL, topY - randomRange(1.15, 1.95, random));
      const near = rainData.near[downpourIndex];

      anchor[positionIndex] = rainData.baseX[downpourIndex] + randomRange(-0.018, 0.018, random);
      anchor[positionIndex + 1] = bridgeBottom;
      anchor[positionIndex + 2] = rainData.z[downpourIndex];
      dimensions[dimensionIndex] = randomRange(0.008, 0.028, random) * (0.84 + near * 0.26);
      dimensions[dimensionIndex + 1] = randomRange(1.35, 2.35, random);
      flow[flowIndex] = clamp(rainData.speed[downpourIndex], 2.8, 6.4);
      flow[flowIndex + 1] = randomRange(0.006, 0.025, random);
      flow[flowIndex + 2] = rainData.phase[downpourIndex];
      flow[flowIndex + 3] = randomRange(0.26, 0.56, random);
      breaks[breakIndex] = randomRange(6.5, 13.0, random);
      breaks[breakIndex + 1] = randomRange(0.34, 0.58, random);
      drift[driftIndex] = rainData.windSpeed[downpourIndex];
      drift[driftIndex + 1] = rainData.driftX[downpourIndex];
      drift[driftIndex + 2] = rainData.driftZ[downpourIndex];
      bridgeCount += 1;
    } else {
      for (let attempt = 0; attempt < 14; attempt += 1) {
        hour = peakHourSampler();
        stormWeight = sampleStormWeight(hour);
        if (stormWeight > 0.08 && random() < Math.pow(stormWeight, 0.58)) break;
      }

      const near = random();
      const isMidBreak = isCore && random() < 0.34;
      const bottomY = Math.max(WATER_LEVEL, WATER_LEVEL + (isForeground
        ? randomRange(-0.02, 0.16, random)
        : isWide
          ? randomRange(-0.08, 0.18, random)
          : isMidBreak
            ? randomRange(0.18, 0.72, random)
            : randomRange(-0.12, 0.2, random)));
      const availableHeight = Math.max(0.55, sampleWaterfallTopY(hour) - bottomY);
      const width = isForeground
        ? randomRange(0.018, 0.044, random)
        : isWide
          ? randomRange(0.036, 0.082, random)
          : random() < 0.82
            ? randomRange(0.007, 0.022, random)
            : randomRange(0.022, 0.042, random);
      const speedTier = random();
      const speed = isWide
        ? randomRange(2.6, 4.2, random)
        : speedTier < 0.28
          ? randomRange(3.0, 4.0, random)
          : speedTier < 0.68
            ? randomRange(4.0, 5.4, random)
            : randomRange(5.4, 7.0, random);

      anchor[positionIndex] = hourToX(hour) + randomRange(-0.08, 0.08, random);
      anchor[positionIndex + 1] = bottomY;
      anchor[positionIndex + 2] = isForeground
        ? sampleDepth(randomRange(0.7, 1, random), random)
        : sampleDepth(near, random);
      dimensions[dimensionIndex] = width;
      dimensions[dimensionIndex + 1] = availableHeight * (isCore
        ? isMidBreak
          ? randomRange(0.34, 0.66, random)
          : randomRange(0.72, 1.1, random)
        : isWide
          ? randomRange(0.5, 0.92, random)
          : randomRange(0.68, 1.02, random));
      flow[flowIndex] = speed;
      flow[flowIndex + 1] = randomRange(0.006, isWide ? 0.045 : 0.034, random) * (0.78 + near * 0.36);
      flow[flowIndex + 2] = random() * Math.PI * 2;
      flow[flowIndex + 3] = isForeground
        ? randomRange(0.54, 0.92, random)
        : isCore
          ? randomRange(0.48, 0.9, random) * (0.82 + near * 0.26)
          : isWide
            ? randomRange(0.34, 0.64, random)
            : randomRange(0.3, 0.56, random);
      breaks[breakIndex] = isCore
        ? randomRange(4.0, 9.4, random)
        : isWide
          ? randomRange(2.6, 6.8, random)
          : randomRange(4.8, 10.0, random);
      breaks[breakIndex + 1] = isCore
        ? randomRange(0.22, 0.46, random)
        : isWide
          ? randomRange(0.18, 0.42, random)
          : randomRange(0.28, 0.52, random);
      drift[driftIndex] = randomRange(0.12, 0.42, random);
      drift[driftIndex + 1] = randomRange(0.0015, isWide ? 0.007 : 0.0055, random);
      drift[driftIndex + 2] = randomRange(0.0015, isWide ? 0.006 : 0.0045, random);
      if (isForeground) foregroundCount += 1;
      else if (isCore) coreCount += 1;
      else if (isWide) wideCount += 1;
    }

    storm[i] = stormWeight;
  }

  geometry.setAttribute('aAnchor', new THREE.InstancedBufferAttribute(anchor, 3));
  geometry.setAttribute('aDimensions', new THREE.InstancedBufferAttribute(dimensions, 2));
  geometry.setAttribute('aFlow', new THREE.InstancedBufferAttribute(flow, 4));
  geometry.setAttribute('aBreaks', new THREE.InstancedBufferAttribute(breaks, 2));
  geometry.setAttribute('aStorm', new THREE.InstancedBufferAttribute(storm, 1));
  geometry.setAttribute('aDrift', new THREE.InstancedBufferAttribute(drift, 3));
  geometry.setAttribute('aFilamentClass', new THREE.InstancedBufferAttribute(filamentClass, 1));
  geometry.instanceCount = count;
  const highlightGeometry = geometry.clone();
  highlightGeometry.instanceCount = highlightCount;
  return {
    geometry,
    highlightGeometry,
    highlightCount,
    bridgeCount,
    coreCount,
    lowerCount: wideCount,
    wideCount,
    foregroundCount,
    ribbonSegments
  };
}

function createPeakWaterfallFilamentMaterial(highlight) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uMotion: { value: prefersReducedMotion ? 0 : 1 },
      uDeep: { value: new THREE.Color(TUNING.metalRain.darkColor) },
      uMid: { value: new THREE.Color(TUNING.metalRain.midColor) },
      uBright: { value: new THREE.Color(TUNING.metalRain.brightColor) },
      uFilamentBandDensity: { value: TUNING.metalRain.filamentBandDensity },
      uFilamentBandSpeed: { value: TUNING.metalRain.filamentBandSpeed },
      uFilamentMirrorStrength: {
        value: highlight
          ? TUNING.metalRain.highlightMirrorStrength
          : TUNING.metalRain.filamentMirrorStrength
      },
      uEdgeWidth: {
        value: highlight
          ? TUNING.waterfallFilaments.highlightEdgeWidth
          : TUNING.waterfallFilaments.edgeWidth
      },
      uOpacity: {
        value: highlight
          ? TUNING.waterfallFilaments.highlightOpacity
          : TUNING.waterfallFilaments.opacity
      },
      uBottomMistOpacity: { value: TUNING.waterfallFilaments.bottomMistOpacity },
      uViewport: { value: rainViewport },
      uPlotBounds: { value: rainPlotBounds },
      uPlotFeather: { value: rainPlotFeather },
      uPlotClip: rainPlotClip
    },
    vertexShader: `
      uniform float uTime;
      uniform float uMotion;
      attribute vec3 aAnchor;
      attribute vec2 aDimensions;
      attribute vec4 aFlow;
      attribute vec2 aBreaks;
      attribute float aStorm;
      attribute vec3 aDrift;
      attribute float aFilamentClass;
      varying vec2 vUv;
      varying vec4 vFlow;
      varying vec2 vBreaks;
      varying float vStorm;
      varying float vFogDepth;
      varying float vFilamentClass;
      varying float vTurbulence;

      float hash(float n) { return fract(sin(n) * 43758.5453123); }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float n = i.x + i.y * 57.0;
        return mix(mix(hash(n), hash(n + 1.0), f.x), mix(hash(n + 57.0), hash(n + 58.0), f.x), f.y);
      }
      float fbm(vec2 p) {
        float value = noise(p) * 0.55;
        p = p * 2.03 + vec2(7.1, 11.3);
        value += noise(p) * 0.29;
        p = p * 2.11 + vec2(13.9, 5.7);
        value += noise(p) * 0.16;
        return value;
      }

      void main() {
        float time = uTime * uMotion;
        float localY = position.y;
        float bridgeClass = 1.0 - smoothstep(0.05, 0.95, abs(aFilamentClass - 0.0));
        float coreClass = 1.0 - smoothstep(0.05, 0.95, abs(aFilamentClass - 1.0));
        float wideClass = 1.0 - smoothstep(0.05, 0.95, abs(aFilamentClass - 2.0));
        float foregroundClass = 1.0 - smoothstep(0.05, 0.95, abs(aFilamentClass - 3.0));
        vec3 center = aAnchor;
        center.x += sin(time * aDrift.x + aFlow.z) * aDrift.y;
        center.z += cos(time * aDrift.x * 0.72 + aFlow.z * 0.7) * aDrift.z;
        center.y += localY * aDimensions.y;
        float fallTime = time * (0.22 + aFlow.x * 0.075);
        float localWarp = fbm(vec2(localY * 3.2 + aFlow.z * 0.43, fallTime * 0.55 + aAnchor.x * 0.18));
        float curl = fbm(vec2(
          localY * (6.0 + wideClass * 1.2) + localWarp * 1.1,
          aFlow.z * 0.77 - fallTime * 0.9
        )) * 2.0 - 1.0;
        float branch = sin(localY * (12.0 + wideClass * 2.0) + aFlow.z + fallTime * 1.45) * 0.45;
        branch += sin(localY * 31.0 - aFlow.z * 1.9 - fallTime * 2.15) * 0.16;
        branch += curl * (0.18 + foregroundClass * 0.08);
        float bendEnvelope = smoothstep(0.02, 0.22, localY)
          * (0.16 + localY * 0.48)
          * (1.0 - bridgeClass * 0.18);
        center.x += branch * aFlow.y * bendEnvelope * (0.42 + wideClass * 0.18 + foregroundClass * 0.12);
        center.z += curl * aFlow.y * (0.045 + wideClass * 0.04) * smoothstep(0.08, 0.74, localY);
        vec4 mvPosition = modelViewMatrix * vec4(center, 1.0);
        float pinch = fbm(vec2(localY * 9.0 + aFlow.z, fallTime * 0.92));
        float widthPulse = 0.7
          + pinch * 0.28
          + sin(localY * 18.0 + aFlow.z * 1.7) * 0.07;
        widthPulse *= mix(0.94, 1.18, wideClass);
        widthPulse *= mix(1.0, 1.08, foregroundClass);
        mvPosition.x += position.x * aDimensions.x * widthPulse;
        vUv = uv;
        vFlow = aFlow;
        vBreaks = aBreaks;
        vStorm = aStorm;
        vFogDepth = -mvPosition.z;
        vFilamentClass = aFilamentClass;
        vTurbulence = clamp(localWarp * 0.5 + abs(curl) * 0.26 + pinch * 0.24, 0.0, 1.08);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform float uTime;
      uniform float uMotion;
      uniform vec3 uDeep;
      uniform vec3 uMid;
      uniform vec3 uBright;
      uniform float uFilamentBandDensity;
      uniform float uFilamentBandSpeed;
      uniform float uFilamentMirrorStrength;
      uniform float uEdgeWidth;
      uniform float uOpacity;
      uniform float uBottomMistOpacity;
      uniform vec2 uViewport;
      uniform vec4 uPlotBounds;
      uniform vec3 uPlotFeather;
      uniform float uPlotClip;
      varying vec2 vUv;
      varying vec4 vFlow;
      varying vec2 vBreaks;
      varying float vStorm;
      varying float vFogDepth;
      varying float vFilamentClass;
      varying float vTurbulence;

      float hash(float n) { return fract(sin(n) * 43758.5453123); }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float n = i.x + i.y * 57.0;
        return mix(mix(hash(n), hash(n + 1.0), f.x), mix(hash(n + 57.0), hash(n + 58.0), f.x), f.y);
      }

      void main() {
        float time = uTime * uMotion;
        float centerDistance = abs(vUv.x - 0.5) * 2.0;
        float bridgeClass = 1.0 - smoothstep(0.05, 0.95, abs(vFilamentClass - 0.0));
        float coreClass = 1.0 - smoothstep(0.05, 0.95, abs(vFilamentClass - 1.0));
        float wideClass = 1.0 - smoothstep(0.05, 0.95, abs(vFilamentClass - 2.0));
        float foregroundClass = 1.0 - smoothstep(0.05, 0.95, abs(vFilamentClass - 3.0));
        float raggedEdge = noise(vec2(vFlow.z * 4.1 + vUv.y * 8.2, time * 0.22 + vUv.x * 2.3));
        // 🎛️ 瀑布雨丝宽度对应 TUNING.waterfallFilaments。
        float edgeWidth = uEdgeWidth
          + wideClass * 0.1
          + foregroundClass * 0.05;
        float core = 1.0 - smoothstep(${highlight ? '0.04' : '0.08'}, edgeWidth, centerDistance + (raggedEdge - 0.5) * 0.18);
        float endVariation = noise(vec2(vFlow.z, vBreaks.x));
        float bottomFade = smoothstep(0.0, 0.04 + endVariation * 0.075, vUv.y);
        float topFade = 1.0 - smoothstep(0.8 + endVariation * 0.12, 1.0, vUv.y);
        float advectedY = vUv.y * vBreaks.x + time * vFlow.x;
        ${highlight ? `
        float fastPulse = 0.5 + 0.5 * sin(advectedY * 2.95 + vFlow.z * 6.1);
        float secondaryPulse = 0.5 + 0.5 * sin(advectedY * 1.22 - vFlow.z * 3.7);
        float streamNoise = fastPulse * 0.68 + noise(vec2(vFlow.z * 9.0 + vUv.x * 2.0, advectedY * 0.5)) * 0.32;
        float continuity = smoothstep(0.44, 0.82, fastPulse + secondaryPulse * 0.16 + vTurbulence * 0.1);
        ` : `
        float domainWarp = noise(vec2(vFlow.z * 2.3, advectedY * 0.26));
        float streamNoise = noise(vec2(vFlow.z * 7.1 + domainWarp * 1.2 + vUv.x * 1.2, advectedY));
        float fineBreak = 0.5 + 0.5 * sin(advectedY * 2.65 + vFlow.z * 5.7 + domainWarp * 2.2);
        float secondaryBreak = noise(vec2(vFlow.z * 13.0 - vUv.x * 1.4, advectedY * 0.62 + domainWarp));
        float continuity = smoothstep(
          vBreaks.y - 0.18,
          vBreaks.y + 0.18,
          streamNoise * 0.52 + fineBreak * 0.3 + secondaryBreak * 0.18 + vTurbulence * 0.08
        );
        `}
        continuity = mix(continuity, 0.58 + continuity * 0.42, coreClass);
        continuity = mix(continuity, 0.38 + continuity * 0.62, wideClass);
        float verticalInk = smoothstep(
          0.46,
          0.92,
          noise(vec2(vFlow.z * 21.0 + vUv.x * 1.2, advectedY * 0.2))
        );
        float darkCut = smoothstep(
          0.5,
          0.9,
          noise(vec2(vFlow.z * 5.8 - vUv.x * 1.1, advectedY * 0.13 + 8.0))
        );
        float columnVoid = smoothstep(
          0.5,
          0.88,
          noise(vec2(vFlow.z * 3.6 + vUv.x * 0.7, floor(vUv.y * 7.0) * 0.37 + time * 0.08))
        );
        float columnFlicker = 0.72 + noise(vec2(vFlow.z * 11.0, vUv.y * 3.0 - time * 0.3)) * 0.48;
        float bottomMist = (1.0 - smoothstep(0.0, 0.22, vUv.y))
          * smoothstep(0.18, 0.72, streamNoise + vTurbulence * 0.2)
          * ${highlight ? '0.0' : '1.0'};
        float filament = core * bottomFade * topFade * continuity;
        float fogFactor = 1.0 - exp(-0.00046 * vFogDepth * vFogDepth);
        vec2 screenUv = vec2(
          gl_FragCoord.x / uViewport.x,
          1.0 - gl_FragCoord.y / uViewport.y
        );
        float horizontalMask = smoothstep(
          uPlotBounds.x,
          uPlotBounds.x + uPlotFeather.x,
          screenUv.x
        ) * (1.0 - smoothstep(
          uPlotBounds.y - uPlotFeather.x,
          uPlotBounds.y,
          screenUv.x
        ));
        horizontalMask = mix(1.0, horizontalMask, uPlotClip);
        float lowerMask = 1.0 - smoothstep(
          uPlotBounds.w - uPlotFeather.z,
          uPlotBounds.w,
          screenUv.y
        );
        lowerMask = mix(1.0, lowerMask, uPlotClip);
        float classOpacity = 0.66
          + bridgeClass * 0.0
          + coreClass * 0.78
          + wideClass * 0.34
          + foregroundClass * 0.22;
        // 🎛️ 瀑布雨丝透明度对应 TUNING.waterfallFilaments。
        float alpha = (filament + bottomMist * uBottomMistOpacity)
          * vFlow.w
          * vStorm
          * classOpacity
          * uOpacity
          * (1.0 - fogFactor * 0.44) * horizontalMask * lowerMask;
        alpha *= columnFlicker;
        alpha *= mix(1.0, 0.6, darkCut * (1.0 - foregroundClass * 0.35));
        alpha *= mix(1.0, 0.56, columnVoid * (1.0 - bottomMist * 0.45) * (1.0 - foregroundClass * 0.35));
        float mercuryWave = 0.5 + 0.5 * sin(
          advectedY * uFilamentBandDensity
          + vFlow.z * 5.8
          + centerDistance * 2.6
          - time * uFilamentBandSpeed
        );
        float mercuryMirror = smoothstep(0.46, 0.88, mercuryWave + streamNoise * 0.18);
        vec3 color = mix(uDeep, uMid, 0.28 + streamNoise * 0.32 + bottomMist * 0.12);
        color = mix(color, uBright, clamp(
          mercuryMirror * uFilamentMirrorStrength
          + ${highlight ? '0.28' : 'core * 0.12 + verticalInk * 0.16'},
          0.0,
          1.0
        ));
        color = mix(color, uDeep, (darkCut * 0.48 + columnVoid * 0.28) * (1.0 - foregroundClass * 0.35));
        if (alpha < 0.001) discard;
        gl_FragColor = vec4(color, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: highlight ? THREE.AdditiveBlending : THREE.NormalBlending
  });
}

function updatePeakWaterfall(system, elapsed) {
  for (const material of system.materials) {
    material.uniforms.uTime.value = elapsed;
  }
}

function createWaterGlintSystem(count) {
  const positions = new Float32Array(count * 3);
  const original = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const alphas = new Float32Array(count);
  const baseAlpha = new Float32Array(count);
  const sizes = new Float32Array(count);
  const aspects = new Float32Array(count);
  const hour = new Float32Array(count);
  const strength = new Float32Array(count);
  const presence = new Float32Array(count);
  const storm = new Float32Array(count);
  const shimmer = new Float32Array(count);
  const speed = new Float32Array(count);
  const random = createSeededRandom(WATER_LAYOUT_SEED);
  const hourSampler = createHourSampler(0.36, 1.02, random);

  for (let i = 0; i < count; i += 1) {
    const h = hourSampler();
    const s = sampleRainStrength(h);
    const p = sampleRainPresence(h);
    const index = i * 3;
    const spread = 0.34 + s * 0.52;
    const x = hourToX(h) + randomRange(-spread, spread, random);
    const z = random() < 0.62
      ? randomRange(0.35, WORLD.frontZ * 1.72, random)
      : sampleDepth(0.54, random);

    positions[index] = x;
    positions[index + 1] = WATER_LEVEL + randomRange(0.018, 0.06, random);
    positions[index + 2] = z;
    original.set(positions.subarray(index, index + 3), index);
    hour[i] = h;
    strength[i] = s;
    presence[i] = p;
    storm[i] = sampleStormWeight(h);
    shimmer[i] = random() * Math.PI * 2;
    speed[i] = randomRange(0.018, 0.052, random);
    baseAlpha[i] = randomRange(0.08, 0.32, random)
      * (0.32 + Math.pow(s, 0.7) * 1.25)
      * p;
    alphas[i] = baseAlpha[i] * (0.1 + storm[i] * 0.7);
    sizes[i] = randomRange(0.7, 2.6, random) * (0.74 + s * 0.3);
    aspects[i] = random() < 0.42
      ? randomRange(2.4, 5.4, random)
      : randomRange(1.18, 2.3, random);
    writeWaterColor(colors, index, s, randomRange(0.36, 0.86, random), random);
  }

  const points = createSoftPointCloud({
    positions,
    colors,
    alphas,
    sizes,
    aspects,
    horizontal: 1,
    opacity: TUNING.glint.opacity,
    maxSize: TUNING.glint.maxSize,
    renderOrder: 5
  });

  return {
    points,
    data: { positions, original, alphas, baseAlpha, hour, strength, presence, storm, shimmer, speed, count }
  };
}

function updateWaterGlints(system, elapsed, delta) {
  const data = system.data;

  for (let i = 0; i < data.count; i += 1) {
    const index = i * 3;
    const focus = chainFocus(data.hour[i], data.positions[index], data.positions[index + 2]);
    data.positions[index] = data.original[index] + Math.sin(elapsed * 0.34 + data.shimmer[i]) * 0.018;
    data.positions[index + 2] += data.speed[i] * delta;
    if (data.positions[index + 2] > WORLD.frontZ * 1.74) {
      data.positions[index + 2] = randomRange(-WORLD.depth * 0.55, -WORLD.depth * 0.16);
    }
    data.positions[index + 1] = WATER_LEVEL + 0.026
      + Math.sin(elapsed * 1.35 + data.shimmer[i]) * 0.006;
    const flicker = 0.78 + Math.sin(elapsed * 2.1 + data.shimmer[i]) * 0.18;
    data.alphas[i] = clamp(
      data.baseAlpha[i]
        * (0.1 + data.storm[i] * 0.7)
        * flicker
        * (1 + focus * 0.52 + state.burst * localHourFocus(data.hour[i], state.selectedHour) * 0.18),
      0,
      TUNING.glint.alphaMax
    );
  }

  system.points.geometry.attributes.position.needsUpdate = true;
  system.points.geometry.attributes.aAlpha.needsUpdate = true;
}

function createImpactPearlSystem(count, eventRate, rippleRate) {
  const foamCount = Math.floor(count * 0.55);
  const dropletCount = Math.floor(count * 0.35);
  const crownCount = count > 0 ? Math.max(1, count - foamCount - dropletCount) : 0;
  const foam = createImpactPointPool(foamCount, {
    horizontal: 1,
    opacity: TUNING.foam.opacity,
    maxSize: TUNING.foam.maxSize,
    renderOrder: 5,
    blending: THREE.AdditiveBlending
  });
  const droplets = createImpactPointPool(dropletCount, {
    horizontal: 0,
    opacity: TUNING.spray.opacity,
    maxSize: TUNING.spray.maxSize,
    renderOrder: 6,
    blending: THREE.NormalBlending
  });
  const crowns = createImpactCrownPool(crownCount);

  return {
    foam: foam.points,
    droplets: droplets.points,
    crowns: crowns.lines,
    data: {
      count,
      foam,
      droplets,
      crowns,
      eventRate,
      rippleRate,
      emissionCredit: eventRate * 0.2,
      rippleCredit: rippleRate * 0.2,
      random: createSeededRandom(IMPACT_LAYOUT_SEED),
      totalPeakCollisions: 0,
      emittedEvents: 0,
      windowEmitted: 0,
      windowStartedAt: 0,
      currentEmissionRate: 0,
      activeCount: 0,
      activeFoamCount: 0,
      activeDropletCount: 0,
      activeCrownCount: 0,
      staticSeedCount: 0
    }
  };
}

function createImpactPointPool(count, { horizontal, opacity, maxSize, renderOrder, blending }) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const alphas = new Float32Array(count);
  const baseAlpha = new Float32Array(count);
  const sizes = new Float32Array(count);
  const baseSizes = new Float32Array(count);
  const aspects = new Float32Array(count);
  const baseAspects = new Float32Array(count);
  const active = new Uint8Array(count);
  const startedAt = new Float32Array(count);
  const lifetime = new Float32Array(count);
  const originX = new Float32Array(count);
  const originZ = new Float32Array(count);
  const velocityX = new Float32Array(count);
  const velocityY = new Float32Array(count);
  const velocityZ = new Float32Array(count);
  const gravity = new Float32Array(count);
  const phase = new Float32Array(count);
  const hour = new Float32Array(count);
  const strength = new Float32Array(count);
  const near = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    positions[i * 3 + 1] = -100;
  }

  const points = createSoftPointCloud({
    positions,
    colors,
    alphas,
    sizes,
    aspects,
    horizontal,
    opacity,
    maxSize,
    renderOrder,
    dynamicColor: true,
    dynamicShape: true,
    blending
  });

  return {
    points,
    count,
    cursor: 0,
    positions,
    colors,
    alphas,
    baseAlpha,
    sizes,
    baseSizes,
    aspects,
    baseAspects,
    active,
    startedAt,
    lifetime,
    originX,
    originZ,
    velocityX,
    velocityY,
    velocityZ,
    gravity,
    phase,
    hour,
    strength,
    near
  };
}

function createImpactCrownPool(count) {
  const positions = new Float32Array(count * 6);
  const colors = new Float32Array(count * 6);
  const alphas = new Float32Array(count * 2);
  const baseAlpha = new Float32Array(count);
  const active = new Uint8Array(count);
  const kind = new Uint8Array(count);
  const startedAt = new Float32Array(count);
  const lifetime = new Float32Array(count);
  const originX = new Float32Array(count);
  const originZ = new Float32Array(count);
  const angle = new Float32Array(count);
  const radius = new Float32Array(count);
  const height = new Float32Array(count);
  const phase = new Float32Array(count);
  const hour = new Float32Array(count);
  const strength = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    positions[i * 6 + 1] = -100;
    positions[i * 6 + 4] = -100;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1).setUsage(THREE.DynamicDrawUsage));
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uFogDensity: { value: scene.fog.density }
    },
    vertexShader: `
      attribute vec3 aColor;
      attribute float aAlpha;
      varying vec3 vColor;
      varying float vAlpha;
      varying float vFogDepth;

      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vColor = aColor;
        vAlpha = aAlpha;
        vFogDepth = -mvPosition.z;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform float uFogDensity;
      varying vec3 vColor;
      varying float vAlpha;
      varying float vFogDepth;

      void main() {
        float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
        gl_FragColor = vec4(vColor, vAlpha * (1.0 - fogFactor * 0.3));
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.renderOrder = 8;

  return {
    lines,
    count,
    cursor: 0,
    positions,
    colors,
    alphas,
    baseAlpha,
    active,
    kind,
    startedAt,
    lifetime,
    originX,
    originZ,
    angle,
    radius,
    height,
    phase,
    hour,
    strength
  };
}

function beginImpactFrame(system, elapsed, delta) {
  const data = system.data;
  data.emissionCredit = Math.min(
    data.eventRate * 0.34,
    data.emissionCredit + data.eventRate * delta
  );
  data.rippleCredit = Math.min(
    data.rippleRate * 0.55,
    data.rippleCredit + data.rippleRate * delta
  );

  const windowDuration = elapsed - data.windowStartedAt;
  if (windowDuration >= 0.5) {
    data.currentEmissionRate = data.windowEmitted / Math.max(0.001, windowDuration);
    data.windowEmitted = 0;
    data.windowStartedAt = elapsed;
  }
}

function queueRainImpact(system, x, z, impactHour, impactStrength, impactNear, role, elapsed) {
  const data = system.data;
  const stormWeight = sampleStormWeight(impactHour);
  const rainActivity = clamp(impactStrength, 0, 1);
  if (rainActivity <= 0) return 0;
  if (!SPLASH_IMPACTS_ENABLED) return stormWeight;

  if (stormWeight > 0.001) data.totalPeakCollisions += 1;
  const roleChance = role === RAIN_ROLE.DOWNPOUR
    ? 1
    : role === RAIN_ROLE.BASE ? 0.34 : 0.16;
  const drizzleChance = Math.pow(rainActivity, 1.35)
    * roleChance
    * (0.08 + impactNear * 0.12);
  const stormChance = stormWeight
    * roleChance
    * (0.38 + impactNear * 0.62)
    * (0.82 + impactStrength * 0.34);
  const chance = clamp(
    drizzleChance + stormChance,
    0,
    1
  );

  if (data.emissionCredit < 1 || data.random() > chance) return stormWeight;

  data.emissionCredit -= 1;
  data.emittedEvents += 1;
  data.windowEmitted += 1;
  emitStormImpact(
    system,
    x,
    z,
    impactHour,
    impactStrength,
    impactNear,
    stormWeight,
    elapsed
  );
  return stormWeight;
}

function tryEmitImpactRipple(system, ripples, x, z, strength, stormWeight, role, elapsed) {
  const data = system.data;
  if (data.rippleCredit < 1) return;

  const roleChance = role === RAIN_ROLE.DOWNPOUR ? 1 : role === RAIN_ROLE.BASE ? 0.48 : 0.28;
  const chance = (0.012 + stormWeight * 0.14) * roleChance;
  if (data.random() > chance) return;

  data.rippleCredit -= 1;
  addRipple(
    ripples,
    x,
    z,
    0.13 + strength * 0.25 + stormWeight * 0.24,
    false,
    elapsed
  );
}

function emitStormImpact(system, x, z, impactHour, impactStrength, impactNear, stormWeight, elapsed, staticProgress = -1) {
  const data = system.data;
  const random = data.random;
  const foamSpawns = clamp(
    Math.round(8 + stormWeight * 7 + impactNear * 3 + random() * 3),
    7,
    21
  );
  const dropletSpawns = clamp(
    Math.round(3 + stormWeight * 4 + impactNear * 2 + random() * 2),
    3,
    10
  );
  const crownSpawns = clamp(Math.round(3 + stormWeight * 3 + random() * 3), 3, 9);

  for (let i = 0; i < foamSpawns; i += 1) {
    spawnFoamParticle(
      data.foam,
      data.random,
      x,
      z,
      impactHour,
      impactStrength,
      impactNear,
      stormWeight,
      elapsed,
      staticProgress
    );
  }
  for (let i = 0; i < dropletSpawns; i += 1) {
    spawnDropletParticle(
      data.droplets,
      data.random,
      x,
      z,
      impactHour,
      impactStrength,
      impactNear,
      stormWeight,
      elapsed,
      staticProgress
    );
  }
  for (let i = 0; i < crownSpawns; i += 1) {
    spawnCrownLine(
      data.crowns,
      data.random,
      x,
      z,
      impactHour,
      impactStrength,
      impactNear,
      stormWeight,
      elapsed,
      staticProgress
    );
  }
}

function spawnFoamParticle(pool, random, x, z, impactHour, impactStrength, impactNear, stormWeight, elapsed, staticProgress) {
  const i = pool.cursor;
  pool.cursor = (pool.cursor + 1) % pool.count;
  const index = i * 3;
  const angle = random() * Math.PI * 2;
  const depthGain = 0.7 + impactNear * 0.56;
  const scatter = randomRange(0.04, 0.34, random);
  const radialSpeed = randomRange(0.28, 1.16, random) * (0.82 + stormWeight * 0.54);

  pool.active[i] = 1;
  pool.originX[i] = x + Math.cos(angle) * scatter;
  pool.originZ[i] = z + Math.sin(angle) * scatter * 0.64;
  pool.velocityX[i] = Math.cos(angle) * radialSpeed;
  pool.velocityZ[i] = Math.sin(angle) * radialSpeed * 0.6;
  pool.velocityY[i] = randomRange(0.12, 0.42, random);
  pool.gravity[i] = random() < 0.68
    ? randomRange(0.18, 0.36, random)
    : randomRange(0.7, 1.05, random);
  pool.phase[i] = random() * Math.PI * 2;
  pool.hour[i] = impactHour;
  pool.strength[i] = impactStrength;
  pool.near[i] = impactNear;
  pool.lifetime[i] = randomRange(1.25, 2.1, random) * (0.9 + stormWeight * 0.22);
  pool.baseAlpha[i] = randomRange(0.22, 0.52, random) * (0.82 + stormWeight * 0.4) * depthGain;
  pool.baseSizes[i] = randomRange(1.55, 4.8, random) * depthGain;
  pool.baseAspects[i] = randomRange(1.8, 5.6, random);
  writeWaterColor(
    pool.colors,
    index,
    impactStrength,
    randomRange(0.82, 1.32, random) * depthGain,
    random
  );

  const ageOffset = staticProgress >= 0
    ? pool.lifetime[i] * clamp(staticProgress + randomRange(-0.08, 0.08, random), 0.03, 0.9)
    : 0;
  pool.startedAt[i] = elapsed - ageOffset;
  pool.positions[index] = pool.originX[i];
  pool.positions[index + 1] = WATER_LEVEL + 0.04;
  pool.positions[index + 2] = pool.originZ[i];
  pool.sizes[i] = pool.baseSizes[i];
  pool.aspects[i] = pool.baseAspects[i];
  pool.alphas[i] = 0;
}

function spawnDropletParticle(pool, random, x, z, impactHour, impactStrength, impactNear, stormWeight, elapsed, staticProgress) {
  const i = pool.cursor;
  pool.cursor = (pool.cursor + 1) % pool.count;
  const index = i * 3;
  const angle = random() * Math.PI * 2;
  const depthGain = 0.7 + impactNear * 0.58;
  const scatter = randomRange(0.015, 0.15, random);
  const radialSpeed = randomRange(0.38, 1.58, random) * (0.84 + stormWeight * 0.48);
  const launch = randomRange(1.6, 3.05, random)
    + stormWeight * randomRange(0.74, 1.5, random)
    + impactNear * randomRange(0.2, 0.72, random);

  pool.active[i] = 1;
  pool.originX[i] = x + Math.cos(angle) * scatter;
  pool.originZ[i] = z + Math.sin(angle) * scatter * 0.58;
  pool.velocityX[i] = Math.cos(angle) * radialSpeed;
  pool.velocityZ[i] = Math.sin(angle) * radialSpeed * 0.58;
  pool.velocityY[i] = launch;
  pool.gravity[i] = randomRange(5.8, 7.4, random);
  pool.phase[i] = random() * Math.PI * 2;
  pool.hour[i] = impactHour;
  pool.strength[i] = impactStrength;
  pool.near[i] = impactNear;
  pool.lifetime[i] = clamp(
    launch * 2 / pool.gravity[i] * randomRange(0.88, 1.1, random),
    0.42,
    1.25
  );
  pool.baseAlpha[i] = randomRange(0.58, 0.98, random) * (0.82 + stormWeight * 0.4) * depthGain;
  pool.baseSizes[i] = randomRange(1.05, 3.15, random) * depthGain;
  pool.baseAspects[i] = randomRange(1.6, 4.2, random);
  writeWaterColor(
    pool.colors,
    index,
    impactStrength,
    randomRange(0.9, 1.42, random) * depthGain,
    random
  );

  const ageOffset = staticProgress >= 0
    ? pool.lifetime[i] * clamp(staticProgress + randomRange(-0.08, 0.08, random), 0.04, 0.78)
    : 0;
  pool.startedAt[i] = elapsed - ageOffset;
  pool.positions[index] = pool.originX[i];
  pool.positions[index + 1] = WATER_LEVEL + 0.04;
  pool.positions[index + 2] = pool.originZ[i];
  pool.sizes[i] = pool.baseSizes[i];
  pool.aspects[i] = pool.baseAspects[i];
  pool.alphas[i] = 0;
}

function spawnCrownLine(pool, random, x, z, impactHour, impactStrength, impactNear, stormWeight, elapsed, staticProgress) {
  const i = pool.cursor;
  pool.cursor = (pool.cursor + 1) % pool.count;
  const index = i * 6;
  const alphaIndex = i * 2;
  const needle = random() < 0.42;
  const depthGain = 0.72 + impactNear * 0.55;
  const gain = randomRange(0.72, 1.16, random) * (0.82 + impactStrength * 0.28) * depthGain;

  pool.active[i] = 1;
  pool.kind[i] = needle ? CROWN_KIND.NEEDLE : CROWN_KIND.RADIAL;
  pool.originX[i] = x + randomRange(-0.09, 0.09, random);
  pool.originZ[i] = z + randomRange(-0.07, 0.07, random);
  pool.angle[i] = random() * Math.PI * 2;
  pool.phase[i] = random() * Math.PI * 2;
  pool.hour[i] = impactHour;
  pool.strength[i] = impactStrength;
  pool.lifetime[i] = needle
    ? randomRange(0.4, 0.74, random)
    : randomRange(0.3, 0.58, random);
  pool.radius[i] = needle
    ? randomRange(0.04, 0.18, random)
    : randomRange(0.26, 0.82, random) * (0.8 + stormWeight * 0.36);
  pool.height[i] = needle
    ? randomRange(0.72, 1.62, random) * (0.78 + stormWeight * 0.38 + impactNear * 0.16)
    : randomRange(0.24, 0.68, random) * (0.82 + stormWeight * 0.34);
  pool.baseAlpha[i] = randomRange(0.58, 0.96, random) * (0.86 + stormWeight * 0.46) * depthGain;
  pool.colors[index] = PALETTE.pearlBright.r * gain;
  pool.colors[index + 1] = PALETTE.pearlBright.g * gain;
  pool.colors[index + 2] = PALETTE.pearlBright.b * gain;
  pool.colors[index + 3] = pool.colors[index] * 1.12;
  pool.colors[index + 4] = pool.colors[index + 1] * 1.12;
  pool.colors[index + 5] = pool.colors[index + 2] * 1.12;
  pool.alphas[alphaIndex] = 0;
  pool.alphas[alphaIndex + 1] = 0;

  const ageOffset = staticProgress >= 0
    ? pool.lifetime[i] * clamp(staticProgress * 0.72, 0.04, 0.62)
    : 0;
  pool.startedAt[i] = elapsed - ageOffset;
  pool.positions[index] = pool.originX[i];
  pool.positions[index + 1] = WATER_LEVEL + 0.04;
  pool.positions[index + 2] = pool.originZ[i];
  pool.positions[index + 3] = pool.originX[i];
  pool.positions[index + 4] = WATER_LEVEL + 0.04;
  pool.positions[index + 5] = pool.originZ[i];
}

function seedReducedMotionImpacts(system) {
  const data = system.data;
  const random = data.random;
  const hourSampler = createIntegratedDownpourHourSampler(random);
  const eventCount = Math.round(data.count / 24);

  for (let i = 0; i < eventCount; i += 1) {
    const impactHour = hourSampler();
    const impactStrength = sampleRainStrength(impactHour);
    const stormWeight = sampleStormWeight(impactHour);
    if (stormWeight <= 0.02) continue;
    const impactNear = sampleNearness(random);
    emitStormImpact(
      system,
      hourToX(impactHour) + randomRange(-0.24, 0.24, random),
      sampleDepth(impactNear, random),
      impactHour,
      impactStrength,
      impactNear,
      stormWeight,
      0,
      randomRange(0.18, 0.68, random)
    );
    data.staticSeedCount += 1;
  }
}

// elapsed 用于驱动水花动画；第三个参数是帧间隔，当前实现用不到，保留以兼容调用点。
function updateImpactPearls(system, elapsed, _delta) {
  const data = system.data;
  const activeFoamCount = updateFoamPool(data.foam, elapsed);
  const activeDropletCount = updateDropletPool(data.droplets, elapsed);
  const activeCrownCount = updateCrownPool(data.crowns, elapsed);
  const activeCount = activeFoamCount + activeDropletCount + activeCrownCount;

  data.activeCount = activeCount;
  data.activeFoamCount = activeFoamCount;
  data.activeDropletCount = activeDropletCount;
  data.activeCrownCount = activeCrownCount;
  root.dataset.activeStormParticles = String(activeCount);
  root.dataset.activeFoamParticles = String(activeFoamCount);
  root.dataset.activeSprayDroplets = String(activeDropletCount);
  root.dataset.activeCrownLines = String(activeCrownCount);
  root.dataset.peakImpactCount = String(data.totalPeakCollisions);
  root.dataset.stormEmissionRate = data.currentEmissionRate.toFixed(1);
}

function updateFoamPool(pool, elapsed) {
  let activeCount = 0;

  for (let i = 0; i < pool.count; i += 1) {
    if (!pool.active[i]) continue;
    const index = i * 3;
    const age = elapsed - pool.startedAt[i];
    const progress = age / Math.max(0.001, pool.lifetime[i]);

    if (progress < 0 || progress >= 1) {
      pool.active[i] = 0;
      pool.alphas[i] = 0;
      pool.positions[index + 1] = -100;
      continue;
    }

    const focus = 1
      + chainFocus(pool.hour[i], pool.originX[i], pool.originZ[i]) * 0.2
      + state.burst * localHourFocus(pool.hour[i], state.selectedHour) * 0.14;
    const lift = Math.sin(progress * Math.PI)
      * (0.12 + pool.strength[i] * 0.24 + pool.near[i] * 0.1)
      * pool.gravity[i];
    const fade = smoothstep(0, 0.06, progress) * (1 - smoothstep(0.58, 1, progress));
    pool.positions[index] = pool.originX[i] + pool.velocityX[i] * age * (0.62 + progress * 0.52);
    pool.positions[index + 1] = WATER_LEVEL + 0.04 + lift
      + Math.sin(pool.phase[i] + progress * 8) * 0.01;
    pool.positions[index + 2] = pool.originZ[i] + pool.velocityZ[i] * age * (0.62 + progress * 0.46);
    pool.sizes[i] = pool.baseSizes[i] * (0.74 + progress * 1.02);
    pool.aspects[i] = pool.baseAspects[i] * (0.92 + progress * 0.42);
    pool.alphas[i] = clamp(pool.baseAlpha[i] * fade * focus, 0, 0.72);
    activeCount += 1;
  }

  for (const attribute of ['position', 'aAlpha', 'aSize', 'aAspect', 'aColor']) {
    pool.points.geometry.attributes[attribute].needsUpdate = true;
  }
  return activeCount;
}

function updateDropletPool(pool, elapsed) {
  let activeCount = 0;

  for (let i = 0; i < pool.count; i += 1) {
    if (!pool.active[i]) continue;
    const index = i * 3;
    const age = elapsed - pool.startedAt[i];
    const progress = age / Math.max(0.001, pool.lifetime[i]);

    if (progress < 0 || progress >= 1) {
      pool.active[i] = 0;
      pool.alphas[i] = 0;
      pool.positions[index + 1] = -100;
      continue;
    }

    const y = WATER_LEVEL + 0.04
      + pool.velocityY[i] * age
      - pool.gravity[i] * age * age * 0.5;
    if (y < WATER_LEVEL + 0.014 && progress > 0.16) {
      pool.active[i] = 0;
      pool.alphas[i] = 0;
      pool.positions[index + 1] = -100;
      continue;
    }

    const focus = 1
      + chainFocus(pool.hour[i], pool.originX[i], pool.originZ[i]) * 0.22
      + state.burst * localHourFocus(pool.hour[i], state.selectedHour) * 0.16;
    const fade = smoothstep(0, 0.045, progress) * (1 - smoothstep(0.72, 1, progress));
    pool.positions[index] = pool.originX[i] + pool.velocityX[i] * age;
    pool.positions[index + 1] = y;
    pool.positions[index + 2] = pool.originZ[i] + pool.velocityZ[i] * age;
    pool.sizes[i] = pool.baseSizes[i] * (1 - progress * 0.2);
    pool.aspects[i] = pool.baseAspects[i] * (1 + Math.sin(progress * Math.PI) * 0.18);
    pool.alphas[i] = clamp(pool.baseAlpha[i] * fade * focus, 0, 0.96);
    activeCount += 1;
  }

  for (const attribute of ['position', 'aAlpha', 'aSize', 'aAspect', 'aColor']) {
    pool.points.geometry.attributes[attribute].needsUpdate = true;
  }
  return activeCount;
}

function updateCrownPool(pool, elapsed) {
  let activeCount = 0;

  for (let i = 0; i < pool.count; i += 1) {
    if (!pool.active[i]) continue;
    const index = i * 6;
    const alphaIndex = i * 2;
    const age = elapsed - pool.startedAt[i];
    const progress = age / Math.max(0.001, pool.lifetime[i]);

    if (progress < 0 || progress >= 1) {
      pool.active[i] = 0;
      pool.alphas[alphaIndex] = 0;
      pool.alphas[alphaIndex + 1] = 0;
      pool.positions[index + 1] = -100;
      pool.positions[index + 4] = -100;
      continue;
    }

    const pulse = Math.sin(progress * Math.PI);
    const grow = smoothstep(0, 1, progress);
    const cos = Math.cos(pool.angle[i]);
    const sin = Math.sin(pool.angle[i]);
    const radial = pool.radius[i] * grow;
    const startRadial = radial * (pool.kind[i] === CROWN_KIND.NEEDLE ? 0 : 0.12);
    const endHeight = pool.height[i] * pulse;
    const sway = pool.kind[i] === CROWN_KIND.NEEDLE
      ? Math.sin(pool.phase[i] + progress * 5) * 0.035
      : 0;
    pool.positions[index] = pool.originX[i] + cos * startRadial;
    pool.positions[index + 1] = WATER_LEVEL + 0.008;
    pool.positions[index + 2] = pool.originZ[i] + sin * startRadial * 0.58;
    pool.positions[index + 3] = pool.originX[i] + cos * radial + sway;
    pool.positions[index + 4] = WATER_LEVEL + 0.008 + endHeight;
    pool.positions[index + 5] = pool.originZ[i] + sin * radial * 0.58;

    const focus = 1
      + chainFocus(pool.hour[i], pool.originX[i], pool.originZ[i]) * 0.18
      + state.burst * localHourFocus(pool.hour[i], state.selectedHour) * 0.12;
    const fade = smoothstep(0, 0.035, progress) * Math.pow(1 - progress, 1.35);
    pool.alphas[alphaIndex] = clamp(pool.baseAlpha[i] * fade * focus * 0.52, 0, 0.72);
    pool.alphas[alphaIndex + 1] = clamp(pool.baseAlpha[i] * fade * focus, 0, 0.94);
    activeCount += 1;
  }

  pool.lines.geometry.attributes.position.needsUpdate = true;
  pool.lines.geometry.attributes.aAlpha.needsUpdate = true;
  pool.lines.geometry.attributes.aColor.needsUpdate = true;
  return activeCount;
}

function createSoftPointCloud({
  positions,
  colors,
  alphas,
  sizes,
  aspects,
  orientations = null,
  horizontal,
  opacity,
  maxSize,
  renderOrder,
  dynamicColor = false,
  dynamicShape = false,
  blending = THREE.NormalBlending
}) {
  const pointCount = positions.length / 3;
  const pointOrientations = orientations ?? new Float32Array(pointCount).fill(horizontal);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('aColor', dynamicColor
    ? new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage)
    : new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('aSize', dynamicShape
    ? new THREE.BufferAttribute(sizes, 1).setUsage(THREE.DynamicDrawUsage)
    : new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aAspect', dynamicShape
    ? new THREE.BufferAttribute(aspects, 1).setUsage(THREE.DynamicDrawUsage)
    : new THREE.BufferAttribute(aspects, 1));
  geometry.setAttribute('aHorizontal', dynamicShape
    ? new THREE.BufferAttribute(pointOrientations, 1).setUsage(THREE.DynamicDrawUsage)
    : new THREE.BufferAttribute(pointOrientations, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uPixelRatio: { value: pixelRatio },
      uFogDensity: { value: scene.fog.density },
      uOpacity: { value: opacity },
      uMaxSize: { value: maxSize }
    },
    vertexShader: `
      uniform float uPixelRatio;
      uniform float uMaxSize;
      attribute vec3 aColor;
      attribute float aAlpha;
      attribute float aSize;
      attribute float aAspect;
      attribute float aHorizontal;
      varying vec3 vColor;
      varying float vAlpha;
      varying float vAspect;
      varying float vHorizontal;
      varying float vFogDepth;

      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        float depthScale = clamp(19.0 / max(5.4, -mvPosition.z), 0.76, 1.98);
        vColor = aColor;
        vAlpha = aAlpha;
        vAspect = aAspect;
        vHorizontal = aHorizontal;
        vFogDepth = -mvPosition.z;
        gl_PointSize = clamp(aSize * uPixelRatio * depthScale, 0.72 * uPixelRatio, uMaxSize * uPixelRatio);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform float uFogDensity;
      uniform float uOpacity;
      varying vec3 vColor;
      varying float vAlpha;
      varying float vAspect;
      varying float vHorizontal;
      varying float vFogDepth;

      void main() {
        vec2 point = gl_PointCoord - vec2(0.5);
        vec2 verticalShape = vec2(point.x * vAspect, point.y);
        vec2 horizontalShape = vec2(point.x / max(1.0, vAspect), point.y);
        vec2 shape = mix(verticalShape, horizontalShape, vHorizontal);
        float distanceToEdge = length(shape);
        float edge = 1.0 - smoothstep(0.38, 0.5, distanceToEdge);
        if (edge < 0.01) discard;

        float core = exp(-dot(shape, shape) * 6.8);
        float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
        vec3 color = vColor * (0.82 + core * 0.48);
        color = mix(color, vec3(0.0, 0.0, 0.0), fogFactor * 0.62);
        gl_FragColor = vec4(color, min(0.74, edge * vAlpha * uOpacity * (1.0 - fogFactor * 0.44)));
      }
    `,
    transparent: true,
    depthWrite: false,
    blending
  });

  const points = new THREE.Points(geometry, material);
  points.renderOrder = renderOrder;
  return points;
}

function createRippleFieldSystem(renderer) {
  const { resX, resZ, xMin, xMax, zMin, zMax } = RIPPLE_FIELD;
  const maxDrops = 160;
  const rtOptions = {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping
  };
  let rtA = new THREE.WebGLRenderTarget(resX, resZ, rtOptions);
  let rtB = new THREE.WebGLRenderTarget(resX, resZ, rtOptions);

  const simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // Zero both targets so the field starts flat.
  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(rtA);
  renderer.clear();
  renderer.setRenderTarget(rtB);
  renderer.clear();
  renderer.setRenderTarget(prevTarget);

  // Simulation pass: R = height, G = velocity. Each step relaxes height toward the
  // 4-neighbour average (discrete Laplacian) with light damping, and feathers the
  // border so waves dissipate at the edges instead of reflecting back in.
  const simMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uField: { value: null },
      uTexel: { value: new THREE.Vector2(1 / resX, 1 / resZ) },
      uDamping: { value: TUNING.ripple.damping }
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uField;
      uniform vec2 uTexel;
      uniform float uDamping;
      varying vec2 vUv;
      void main() {
        vec4 info = texture2D(uField, vUv);
        float l = texture2D(uField, vec2(vUv.x - uTexel.x, vUv.y)).r;
        float r = texture2D(uField, vec2(vUv.x + uTexel.x, vUv.y)).r;
        float t = texture2D(uField, vec2(vUv.x, vUv.y + uTexel.y)).r;
        float b = texture2D(uField, vec2(vUv.x, vUv.y - uTexel.y)).r;
        float average = (l + r + t + b) * 0.25;
        info.g += (average - info.r) * 2.0;
        info.g *= uDamping;
        info.r += info.g;
        float edge = smoothstep(0.0, 0.05, vUv.x)
          * smoothstep(0.0, 0.05, vUv.y)
          * smoothstep(0.0, 0.05, 1.0 - vUv.x)
          * smoothstep(0.0, 0.05, 1.0 - vUv.y);
        info.rg *= edge;
        gl_FragColor = info;
      }
    `,
    depthTest: false,
    depthWrite: false
  });
  const simScene = new THREE.Scene();
  simScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), simMaterial));

  // Drop pass: each raindrop impact stamps a small cosine dimple (negative height)
  // additively into the current field. All of a frame's impacts are drawn at once
  // as a point cloud.
  const dropPositions = new Float32Array(maxDrops * 3);
  const dropAmps = new Float32Array(maxDrops);
  const dropGeometry = new THREE.BufferGeometry();
  dropGeometry.setAttribute('position', new THREE.BufferAttribute(dropPositions, 3).setUsage(THREE.DynamicDrawUsage));
  dropGeometry.setAttribute('aAmp', new THREE.BufferAttribute(dropAmps, 1).setUsage(THREE.DynamicDrawUsage));
  dropGeometry.setDrawRange(0, 0);
  const dropMaterial = new THREE.ShaderMaterial({
    uniforms: {
      // About one sixth of the old world-space footprint after the denser field.
      uDropPx: { value: Math.max(5, resX / 210) }
    },
    vertexShader: `
      attribute float aAmp;
      uniform float uDropPx;
      varying float vAmp;
      void main() {
        vAmp = aAmp;
        gl_Position = vec4(position.xy, 0.0, 1.0);
        gl_PointSize = uDropPx;
      }
    `,
    fragmentShader: `
      varying float vAmp;
      void main() {
        vec2 c = (gl_PointCoord - 0.5) * 2.0;
        float d = length(c);
        if (d > 1.0) discard;
        float shape = exp(-d * d * 8.5);
        gl_FragColor = vec4(-shape * vAmp, 0.0, 0.0, 1.0);
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor
  });
  const dropScene = new THREE.Scene();
  dropScene.add(new THREE.Points(dropGeometry, dropMaterial));

  return {
    rtA,
    rtB,
    simCamera,
    simMaterial,
    simScene,
    dropScene,
    dropGeometry,
    dropMaterial,
    dropPositions,
    dropAmps,
    dropCount: 0,
    maxDrops,
    fieldBounds: { xMin, xMax, zMin, zMax },
    texture: rtA.texture
  };
}

function addRipple(system, x, z, intensity, selected, elapsed) {
  if (system.dropCount >= system.maxDrops) return;
  const b = system.fieldBounds;
  const u = (clamp(x, b.xMin, b.xMax) - b.xMin) / (b.xMax - b.xMin);
  const v = (clamp(z, b.zMin, b.zMax) - b.zMin) / (b.zMax - b.zMin);
  const i = system.dropCount;
  // Positions are written directly in clip space [-1, 1] for the drop point cloud.
  system.dropPositions[i * 3] = u * 2 - 1;
  system.dropPositions[i * 3 + 1] = v * 2 - 1;
  system.dropPositions[i * 3 + 2] = 0;
  system.dropAmps[i] = (selected ? TUNING.ripple.dropClick : TUNING.ripple.dropRain) * (0.6 + intensity);
  system.dropCount += 1;
}

function updateRippleField(system, renderer, elapsed) {
  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;

  // 1. Stamp this frame's raindrop dimples additively into the current field.
  if (system.dropCount > 0) {
    system.dropGeometry.setDrawRange(0, system.dropCount);
    system.dropGeometry.attributes.position.needsUpdate = true;
    system.dropGeometry.attributes.aAmp.needsUpdate = true;
    renderer.autoClear = false;
    renderer.setRenderTarget(system.rtA);
    renderer.render(system.dropScene, system.simCamera);
    renderer.autoClear = prevAutoClear;
  }

  // 2. Advance the wave equation: read rtA, write rtB.
  system.simMaterial.uniforms.uField.value = system.rtA.texture;
  renderer.setRenderTarget(system.rtB);
  renderer.render(system.simScene, system.simCamera);

  // 3. Ping-pong swap; the freshly written target becomes the live field.
  const tmp = system.rtA;
  system.rtA = system.rtB;
  system.rtB = tmp;
  system.texture = system.rtA.texture;

  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAutoClear;

  waterPlane.material.uniforms.uHeightField.value = system.texture;
  root.dataset.activeRipples = String(system.dropCount);
  system.dropCount = 0;
}

function updateWaterPlane(elapsed) {
  waterPlane.material.uniforms.uTime.value = prefersReducedMotion ? 0 : elapsed;
}

function resetChainPosition(data, i, initial) {
  if (!initial) {
    data.respawnCycle[i] += 1;
  }
  const resetSeed = data.resetSeed?.[i] || RAIN_LAYOUT_SEED;
  const seedIndex = data.seedIndex?.[i] ?? i;
  const random = createIndexedRandom(resetSeed, seedIndex, data.respawnCycle[i]);
  const strength = data.strength[i];
  const near = data.near[i];
  const layer = data.curtainLayer[i];
  const columnHeight = Math.max(0.8, data.top[i] - WATER_LEVEL);
  const spread = lerp(0.18, 0.68, Math.pow(strength, 0.82));
  data.baseX[i] = clamp(
    hourToX(data.hour[i]) + randomRange(-spread, spread, random),
    hourToX(0) + 0.12,
    hourToX(24) - 0.12
  );
  data.z[i] = sampleDepth(near, random);

  if (data.role[i] === RAIN_ROLE.AMBIENT) {
    data.headY[i] = rainCeilingY - 0.03;
    return;
  }

  if (layer === 1) {
    const lowerCeiling = WATER_LEVEL + columnHeight * randomRange(0.3, 0.44, random);
    data.headY[i] = randomRange(
      WATER_LEVEL + data.length[i] * 0.72,
      lowerCeiling + data.length[i] * 0.4,
      random
    );
    return;
  }

  if (layer === 0) {
    data.headY[i] = randomRange(
      WATER_LEVEL + data.length[i] * 0.78,
      data.top[i] + data.length[i] * 0.44,
      random
    );
    return;
  }

  data.headY[i] = initial
    ? randomRange(data.top[i] * 0.72, data.top[i] + data.length[i], random)
    : data.top[i] + data.length[i] + randomRange(0.04, 1.1, random);
}

function createIntegratedDownpourHourSampler(random = Math.random) {
  if (!peakWaterfallRanges.length) {
    return createHourSampler(0, 1, random, true);
  }

  const samplers = peakWaterfallRanges.map(([startHour, endHour]) => (
    createWeightedHourRangeSampler(startHour, endHour, random)
  ));
  const weights = peakWaterfallRanges.map(([startHour, endHour]) => {
    const samples = 24;
    let weight = 0;
    for (let index = 0; index < samples; index += 1) {
      const hour = lerp(startHour, endHour, (index + 0.5) / samples);
      weight += 0.02 + sampleStormWeight(hour) * (0.7 + sampleRelativeRainfall(hour));
    }
    return weight * Math.max(0.1, endHour - startHour);
  });
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) {
    return () => randomRange(0.04, 23.96, random);
  }
  const cumulative = [];
  let cursor = 0;
  for (const weight of weights) {
    cursor += weight / total;
    cumulative.push(cursor);
  }

  return () => {
    const pick = random();
    const index = Math.max(0, cumulative.findIndex(value => pick <= value));
    return samplers[index]();
  };
}

function createWeightedHourRangeSampler(startHour, endHour, random) {
  const binCount = 64;
  const binWidth = (endHour - startHour) / binCount;
  const weights = Array.from({ length: binCount }, (_, bin) => {
    const hour = startHour + (bin + 0.5) * binWidth;
    const strength = sampleRelativeRainfall(hour);
    const dataWeight = Math.pow(Math.max(0.001, strength - 0.2), 1.42);
    return 0.001 + dataWeight * sampleRainCluster(hour);
  });
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) {
    return () => randomRange(0.04, 23.96, random);
  }
  const cumulative = [];
  let cursor = 0;
  for (const weight of weights) {
    cursor += weight / total;
    cumulative.push(cursor);
  }

  return () => {
    const pick = random();
    const binIndex = Math.max(0, cumulative.findIndex((value) => pick <= value));
    return clamp(startHour + (binIndex + random()) * binWidth, startHour, endHour);
  };
}

function createHourSampler(
  baseWeight,
  exponent,
  random = Math.random,
  clustered = false,
  intensityGain = 2.35,
  spatiallyBalanced = false
) {
  const binCount = clustered ? 96 : 24;
  const binWidth = 24 / binCount;
  const weights = Array.from({ length: binCount }, (_, bin) => {
    const hour = (bin + 0.5) * binWidth;
    const strength = sampleRelativeRainfall(hour);
    const presence = sampleRainPresence(hour);
    const clusterWeight = clustered ? sampleRainCluster(hour) : 1;
    const spatialWeight = spatiallyBalanced ? sampleHourSpatialWeight(hour) : 1;
    // The old exponent of 0.05 flattened almost every positive value to 1,
    // while the additive base weight made 0.1 mm/h nearly as dense as 2 mm/h.
    // Keep the tuning control, but map it onto a perceptually useful range and
    // make its baseline proportional to the actual rainfall.
    const effectiveExponent = 0.55 + Math.max(0, exponent) * 0.35;
    const densityResponse = Math.pow(strength, effectiveExponent);
    const lowRainResponse = baseWeight * Math.pow(strength, 0.85);
    return presence
      * (lowRainResponse + densityResponse * intensityGain * clusterWeight)
      * spatialWeight;
  });
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) {
    return () => randomRange(0.04, 23.96, random);
  }
  const cumulative = [];
  let cursor = 0;
  for (const weight of weights) {
    cursor += weight / total;
    cumulative.push(cursor);
  }

  return () => {
    const pick = random();
    const binIndex = Math.max(0, cumulative.findIndex((value) => pick <= value));
    const hour = binIndex * binWidth;
    if (clustered) {
      return clamp(hour + random() * binWidth, 0.04, 23.96);
    }
    const strength = sampleRelativeRainfall(hour);
    const spread = lerp(0.54, 0.95, Math.pow(strength, 0.62));
    const centered = ((random() + random() + random()) / 3 - 0.5) * 2;
    return clamp(hour + 0.5 + centered * spread, 0.04, 23.96);
  };
}

function sampleHourSpatialWeight(hour) {
  const rightHalf = hour >= 12;
  const exponent = rightHalf ? 2.3 : 1.45;
  const edgeDistance = Math.abs(hour / 12 - 1);
  return clamp(exponent * Math.pow(edgeDistance, exponent - 1), 0.42, 2.3);
}

function sampleRainCluster(hour) {
  const broad = valueNoise(hour * 0.62, RAIN_CLUSTER_SEED);
  const detail = valueNoise(hour * 2.45, RAIN_CLUSTER_SEED ^ 0x7f4a7c15);
  return 0.68 + broad * 0.38 + detail * 0.34;
}

function sampleRainfall(hour) {
  const safeHour = clamp(hour, 0, 24);
  const left = Math.floor(safeHour);
  const right = Math.min(left + 1, activeRainfall.length - 1);
  const amount = safeHour - left;
  return lerp(activeRainfall[left], activeRainfall[right], amount);
}

// An explicit zero value is a hard semantic boundary: the corresponding hour
// must create a visible dry lane even when neighbouring hours contain rain.
// The short feather prevents a razor-thin cut while keeping non-zero datasets
// visually identical to the previous distribution.
function sampleRainPresence(hour) {
  const safeHour = clamp(hour, 0, 24);
  const left = Math.floor(safeHour);
  const right = Math.min(left + 1, activeRainfall.length - 1);
  const amount = safeHour - left;
  const leftWet = activeRainfall[left] > 0;
  const rightWet = activeRainfall[right] > 0;

  if (!leftWet && !rightWet) return 0;

  const featherHours = 0.68;
  let zeroAnchorGate = 1;
  if (!leftWet) zeroAnchorGate *= smoothstep(0, featherHours, amount);
  if (!rightWet) zeroAnchorGate *= 1 - smoothstep(1 - featherHours, 1, amount);

  // Non-zero values stay fully eligible; density and opacity now carry the
  // continuous magnitude response all the way down to very light rain.
  return clamp(zeroAnchorGate, 0, 1);
}

function sampleVisualRainfall(hour) {
  // The editable line already provides continuous interpolation between hourly
  // values. Using the raw curve here preserves small changes instead of lifting
  // low points toward their wetter neighbours.
  return sampleRainfall(hour) * sampleRainPresence(hour);
}

function sampleRelativeRainfall(hour) {
  if (rainfallMax <= 0) return 0;
  return clamp(sampleVisualRainfall(hour) / rainfallMax, 0, 1);
}

// Fixed-reference strength keeps the default 10 mm/h data visually identical,
// while a uniformly scaled dataset still makes the rain visibly heavier.
function sampleRainStrength(hour) {
  return clamp(sampleVisualRainfall(hour) / VISUAL_RAINFALL_REFERENCE, 0, 2);
}

function rainVisibilityResponse(strength) {
  const normalRain = Math.pow(clamp(strength, 0, 1), 0.58);
  const extremeRain = clamp(strength - 1, 0, 1) * 0.2;
  return normalRain + extremeRain;
}

function rainCapacityResponse(maximumRainfall) {
  const normalized = clamp(maximumRainfall / VISUAL_RAINFALL_REFERENCE, 0, 1);
  return normalized <= 0 ? 0 : 0.05 + Math.pow(normalized, 0.62) * 0.95;
}

function sampleRainHeightStrength(hour) {
  return clamp(sampleVisualRainfall(hour) / Math.max(0.001, rainCeilingValue), 0, 1);
}

function refreshRainfallMetrics() {
  rainfallMax = activeRainfall.reduce((maximum, value) => Math.max(maximum, value), 0);
  const expanded = rainfallMax > BASE_AXIS_MAX;
  axisMax = expanded ? niceAxisCeiling(rainfallMax) : BASE_AXIS_MAX;
  rainCeilingValue = axisMax;
  rainCeilingY = WATER_LEVEL + AXIS_CONFIG.worldHeight;
  peakWaterfallRanges = derivePeakWaterfallRanges();
}

function niceAxisCeiling(value) {
  if (!Number.isFinite(value) || value <= 0) return BASE_AXIS_MAX;
  const exponent = Math.floor(Math.log10(value));
  const scale = 10 ** exponent;
  const fraction = value / scale;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  const ceiling = niceFraction * scale;
  return Number.isFinite(ceiling) ? ceiling : value;
}

function rainfallAxisTicks() {
  return [0, axisMax * 0.5, axisMax];
}

function formatRainfallTick(value) {
  if (Math.abs(value) >= 1_000_000) return value.toExponential(1);
  if (Math.abs(value) >= 1000) return value.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(1)));
}

function derivePeakWaterfallRanges() {
  if (rainfallMax <= 0) return [];
  const step = 0.25;
  const rawRanges = [];
  let start = null;

  for (let hour = 0; hour <= 24 + step * 0.5; hour += step) {
    const safeHour = Math.min(24, hour);
    const active = sampleStormWeight(safeHour) > 0.08;
    if (active && start == null) start = Math.max(0, safeHour - step);
    if ((!active || safeHour === 24) && start != null) {
      const end = active && safeHour === 24 ? 24 : Math.min(24, safeHour + step);
      rawRanges.push([start, end]);
      start = null;
    }
  }

  const merged = [];
  for (const range of rawRanges) {
    const previous = merged[merged.length - 1];
    if (previous && range[0] - previous[1] <= 0.5) previous[1] = range[1];
    else merged.push([...range]);
  }
  return merged.filter(([startHour, endHour]) => endHour - startHour >= 0.5);
}

function sampleStormWeight(hour) {
  return smoothstep(5.8, 7.8, sampleVisualRainfall(hour));
}

function sampleWaterfallTopY(hour) {
  const strength = sampleRainHeightStrength(hour);
  const clusterHeight = lerp(
    0.91,
    1.09,
    valueNoise(hour * 1.55, RAIN_CLUSTER_SEED ^ 0x51f2a93d)
  );
  const fullColumnHeight = clamp(
    0.95 + Math.pow(strength, 0.92) * 5.8 * clusterHeight,
    1.2,
    8.8
  );
  const topNoise = lerp(
    0.92,
    1.08,
    valueNoise(hour * 3.4, RAIN_CLUSTER_SEED ^ 0x16c5a2d9)
  );
  return WATER_LEVEL + fullColumnHeight * 0.54 * topNoise;
}

function assignWaterfallEnvelope(chain, index, hour) {
  chain.stormWeight[index] = sampleStormWeight(hour);
  chain.waterfallTop[index] = sampleWaterfallTopY(hour);
  chain.waterfallFeather[index] = lerp(
    1.35,
    2.05,
    valueNoise(hour * 2.7 + index * 0.013, RAIN_CLUSTER_SEED ^ 0x762ad4f1)
  );
}

function sampleNearness(random = Math.random) {
  const pick = random();
  if (pick < 0.38) return randomRange(0.72, 1, random);
  if (pick < 0.68) return randomRange(0.38, 0.72, random);
  return randomRange(0, 0.38, random);
}

function sampleDepth(near, random = Math.random) {
  // 把雨压进一条窄深度带：near 越大越靠前(z 略大)，保留微弱前后层次，
  // 但整体厚度由 RAIN_DEPTH.thickness 控制，从侧面看是一片窄雨帘。
  const t = (near - 0.5) * 2; // -1(最远) .. 1(最近)
  return RAIN_DEPTH.center
    + t * RAIN_DEPTH.thickness
    + randomRange(-RAIN_DEPTH.jitter, RAIN_DEPTH.jitter, random);
}

function chainFocus(hour, x, z) {
  const selected = state.selectedActive ? localHourFocus(hour, state.selectedHour) * 0.44 : 0;
  if (!state.pointerActive) return selected;

  const hourFocus = localHourFocus(hour, state.pointerHour);
  const spatial = 1 - clamp(Math.hypot(x - state.pointerWorld.x, (z - state.pointerWorld.z) * 0.7) / 3.2, 0, 1);
  return Math.max(selected, hourFocus * spatial * 0.92);
}

function localHourFocus(hour, targetHour) {
  const distance = Math.abs(hour - targetHour);
  return Math.max(0, 1 - distance / 2.25);
}

function writeRainColor(target, index, strength, brightness, random = Math.random) {
  const color = strength > 0.62 && random() < 0.46
    ? PALETTE.pearlBright
    : random() < 0.68 ? PALETTE.pearlMid : PALETTE.pearlDark;
  const gain = brightness * (0.76 + strength * 0.28);
  target[index] = color.r * gain;
  target[index + 1] = color.g * gain;
  target[index + 2] = color.b * gain;
}

function writeExtensionRainColor(
  target,
  index,
  strength,
  brightness,
  role,
  style,
  random = Math.random
) {
  const brightChance = role === RAIN_ROLE.AMBIENT
    ? 0.01
    : style === 2 ? 0.72 : 0.018;
  const tone = random();
  const color = tone < brightChance
    ? PALETTE.pearlBright
    : tone < brightChance + 0.68 ? PALETTE.pearlMid : PALETTE.pearlDark;
  const gain = brightness * (0.76 + strength * 0.28);
  target[index] = color.r * gain;
  target[index + 1] = color.g * gain;
  target[index + 2] = color.b * gain;
}

function writeWaterColor(target, index, strength, brightness, random = Math.random) {
  const color = strength > 0.58 && random() < 0.34
    ? PALETTE.waterBright
    : random() < 0.7 ? PALETTE.waterMid : PALETTE.waterDark;
  const gain = brightness * (0.74 + strength * 0.24);
  target[index] = color.r * gain;
  target[index + 1] = color.g * gain;
  target[index + 2] = color.b * gain;
}

function hourToX(hour) {
  return (hour / 24 - 0.5) * AXIS_CONFIG.plotWidth;
}

function xToHour(x) {
  return clamp((x / AXIS_CONFIG.plotWidth + 0.5) * 24, 0, 24);
}

function onPointerDown(event) {
  state.pointerDown = true;
  state.pointerMoved = false;
  state.activePointerId = event.pointerId;
  renderer.domElement.setPointerCapture?.(event.pointerId);
  state.downClient.x = event.clientX;
  state.downClient.y = event.clientY;
  state.downView.x = state.view.targetX;
  state.downView.y = state.view.targetY;
  updatePointer(event);
}

function onPointerMove(event) {
  updatePointer(event);

  if (state.pointerDown) {
    // 旋转交给 OrbitControls；这里只判定是否发生拖拽(用于区分“点击选中”)。
    // 注意：拖拽期间不再隐藏坐标轴与读数 —— 轴线、刻度与右上角读数在旋转视角时同样要保持可见。
    const dx = event.clientX - state.downClient.x;
    const dy = event.clientY - state.downClient.y;
    if (Math.hypot(dx, dy) > AXIS_CONFIG.dragThreshold) {
      state.pointerMoved = true;
    }
  }
}

function onPointerUp(event) {
  updatePointer(event);

  if (!state.pointerMoved) {
    state.selectedHour = clamp(Math.round(state.pointerHour), 0, 24);
    state.selectedActive = true;
    state.burst = 1.55;
    addRipple(rippleSystem, state.pointerWorld.x, state.pointerWorld.z, 0.82, true, clock.elapsedTime);
  }

  releaseActivePointer(event.pointerId);
  state.pointerDown = false;
  state.pointerMoved = false;
  updateDomState(true);
}

function onPointerCancel(event) {
  releaseActivePointer(event.pointerId);
  state.pointerDown = false;
  state.pointerMoved = false;
  state.pointerActive = false;
  dashboard.classList.remove('is-pointer-active');
}

function clearChartHover() {
  state.pointerActive = false;
  dashboard.classList.remove('is-pointer-active');
}

function onPointerLeave() {
  clearChartHover();
}

function onInteractionInterrupted() {
  releaseActivePointer();
  state.pointerDown = false;
  state.pointerMoved = false;
  state.pointerActive = false;
  dashboard.classList.remove('is-pointer-active');
}

function releaseActivePointer(pointerId = state.activePointerId) {
  if (pointerId == null) return;
  if (renderer.domElement.hasPointerCapture?.(pointerId)) {
    renderer.domElement.releasePointerCapture(pointerId);
  }
  state.activePointerId = null;
}

function updatePointer(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  state.pointerClient.x = event.clientX;
  state.pointerClient.y = event.clientY;
  state.pointerNdc.set(x * 2 - 1, -(y * 2 - 1));
  raycaster.setFromCamera(state.pointerNdc, camera);
  raycaster.ray.intersectPlane(pointerPlane, state.pointerWorld);

  // The renderer fills the whole viewport, so pointerleave on the canvas is
  // not enough to detect leaving the chart. Hit-test the actual world-space
  // chart plane and keep the dynamic readout and cursor marker on one state.
  const chartHit = raycaster.ray.intersectPlane(chartPointerPlane, chartPointerWorld);
  const xMin = hourToX(0);
  const xMax = hourToX(24);
  const yMin = WATER_LEVEL - 0.18;
  // 上界要一直盖到右上角的动态读数面板（它挂在图表上方 AXIS_CONFIG.headerHeight 处）：
  // 只判到 rainCeilingY 的话，鼠标一移到读数上就会出界，读数随即把自己隐藏。
  const yMax = rainCeilingY + AXIS_CONFIG.headerHeight;
  const isInsideChart = Boolean(chartHit)
    && chartPointerWorld.x >= xMin
    && chartPointerWorld.x <= xMax
    && chartPointerWorld.y >= yMin
    && chartPointerWorld.y <= yMax;

  if (chartHit) state.pointerHour = xToHour(chartPointerWorld.x);
  state.pointerActive = isInsideChart;
  dashboard.classList.toggle('is-pointer-active', isInsideChart);
}

function resetView() {
  releaseActivePointer();
  state.pointerDown = false;
  state.pointerMoved = false;
  applyCameraPreset();
  state.selectedHour = 18;
  state.selectedActive = true;
  state.burst = 0.7;
  updateDomState(true);
}

function updateCamera(delta) {
  // 相机由 OrbitControls 接管(拖拽旋转 + 滚轮缩放)；每帧 update 以应用惯性阻尼。
  if (controls) controls.update();
}

function cameraProfileName() {
  if (window.innerWidth < 760) return 'mobile';
  // Laptop and portrait-tablet viewports need the wider tablet framing even
  // when their CSS width is above the former 980px breakpoint.
  if (window.innerWidth < 1100 || window.innerWidth / window.innerHeight < 1.72) {
    return 'tablet';
  }
  return 'desktop';
}

function cameraFitForBounds(bounds, target, forward, verticalFov, aspect, margin) {
  if (!bounds || bounds.isEmpty() || !Number.isFinite(aspect) || aspect <= 0) return null;

  const viewportLimit = 1 - clamp(margin, 0, 0.2) * 2;
  const tanVertical = Math.tan(THREE.MathUtils.degToRad(verticalFov * 0.5));
  const tanHorizontal = tanVertical * aspect;
  if (tanVertical <= 0 || tanHorizontal <= 0 || viewportLimit <= 0) return null;

  const right = forward.clone().cross(camera.up);
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
  right.normalize();
  const fitUp = right.clone().cross(forward).normalize();
  const samples = [];
  let requiredDistance = 0;

  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        const offset = new THREE.Vector3(x, y, z).sub(target);
        const horizontal = offset.dot(right);
        const vertical = offset.dot(fitUp);
        const depthOffset = offset.dot(forward);
        samples.push({ horizontal, vertical, depthOffset });
        requiredDistance = Math.max(
          requiredDistance,
          Math.abs(horizontal) / (tanHorizontal * viewportLimit) - depthOffset,
          Math.abs(vertical) / (tanVertical * viewportLimit) - depthOffset,
          camera.near + 0.05 - depthOffset
        );
      }
    }
  }

  return { requiredDistance, samples, tanHorizontal, tanVertical, viewportLimit };
}

function cameraFitUsage(fit, distance) {
  if (!fit) return { horizontal: 0, vertical: 0 };
  let horizontal = 0;
  let vertical = 0;
  for (const sample of fit.samples) {
    const depth = Math.max(camera.near, distance + sample.depthOffset);
    horizontal = Math.max(horizontal, Math.abs(sample.horizontal) / (depth * fit.tanHorizontal));
    vertical = Math.max(vertical, Math.abs(sample.vertical) / (depth * fit.tanVertical));
  }
  return { horizontal, vertical };
}

function syncOrbitDistanceLimits(fitDistance) {
  if (!controls) return;
  controls.minDistance = TUNING.orbit.minDistance;
  controls.maxDistance = Math.max(TUNING.orbit.maxDistance, fitDistance * 1.25);
}

function applyCameraPreset() {
  // Presets keep the authored direction and visual center. The curated axis
  // bounds then extend only the distance needed to fit labels and endpoints.
  const preset = TUNING.camera[cameraProfileName()];
  const presetPosition = new THREE.Vector3(preset.pos[0], preset.pos[1], preset.pos[2]);
  cameraTargetBase.set(
    preset.target[0],
    preset.target[1] + TUNING.camera.frameTargetYOffset,
    preset.target[2]
  );
  camera.fov = preset.fov;
  const viewDirection = cameraTargetBase.clone().sub(presetPosition);
  const fallbackDistance = viewDirection.length();
  if (fallbackDistance <= 1e-6) viewDirection.set(0, 0, -1);
  else viewDirection.multiplyScalar(1 / fallbackDistance);

  // The authored tablet target sits high in the scene. In a shallow phone
  // landscape viewport that wastes most of the lower half of the vertical FOV.
  // Balance the complete curated bounds vertically while preserving the same
  // front-facing direction. Center the rain plot itself horizontally so the
  // heavier left-side labels do not push the visual mass to the right.
  if (chartCameraFitBounds && isPhoneLandscapeViewport()) {
    cameraTargetBase.x = 0;
    cameraTargetBase.y = (chartCameraFitBounds.min.y + chartCameraFitBounds.max.y) * 0.5;
  }

  const fit = cameraFitForBounds(
    chartCameraFitBounds,
    cameraTargetBase,
    viewDirection,
    camera.fov,
    camera.aspect,
    CAMERA_FIT_MARGIN
  );
  // Phone landscape is the intended mobile presentation. Let the curated
  // bounds use the full safe area instead of preserving the more distant
  // tablet fallback; all other viewports keep their authored preset floor.
  const fitDistance = fit && isPhoneLandscapeViewport()
    ? fit.requiredDistance
    : Math.max(fallbackDistance, fit?.requiredDistance || 0);
  cameraBase.copy(cameraTargetBase).addScaledVector(viewDirection, -fitDistance);
  camera.position.copy(cameraBase);
  camera.lookAt(cameraTargetBase);
  camera.updateProjectionMatrix();

  if (controls) {
    syncOrbitDistanceLimits(fitDistance);
    controls.target.copy(cameraTargetBase);
    camera.position.copy(cameraBase);
    controls.update();
  }

  const usage = cameraFitUsage(fit, fitDistance);
  root.dataset.cameraFitMode = fit ? 'curated-axis-bounds' : 'preset-fallback';
  root.dataset.cameraFitMargin = CAMERA_FIT_MARGIN.toFixed(3);
  root.dataset.cameraFitDistance = fitDistance.toFixed(3);
  root.dataset.cameraFitRequiredDistance = fit ? fit.requiredDistance.toFixed(3) : 'unavailable';
  root.dataset.cameraFitHorizontalUsage = usage.horizontal.toFixed(3);
  root.dataset.cameraFitVerticalUsage = usage.vertical.toFixed(3);
  root.dataset.cameraFitPresetFloor = isPhoneLandscapeViewport() ? 'disabled' : 'preserved';
  const viewDelta = cameraTargetBase.clone().sub(cameraBase);
  const horizontalDistance = Math.hypot(viewDelta.x, viewDelta.z);
  root.dataset.initialCameraPitchDeg = THREE.MathUtils.radToDeg(
    Math.atan2(viewDelta.y, horizontalDistance)
  ).toFixed(3);
  root.dataset.initialCameraYawDeg = THREE.MathUtils.radToDeg(
    Math.atan2(viewDelta.x, -viewDelta.z)
  ).toFixed(3);
  root.dataset.initialCameraView = 'front-facing';
}

function updateDomState(force = false) {
  const displayHour = state.pointerActive ? state.pointerHour : state.selectedHour;
  dashboard.classList.toggle('is-selected', state.selectedActive);

  const roundedHour = clamp(Math.round(displayHour), 0, 24);
  const value = sampleRainfall(displayHour);
  const key = `${roundedHour}-${value.toFixed(1)}-${state.pointerActive}-${force}`;

  if (key !== state.readoutKey || force) {
    readoutTime.textContent = `${String(roundedHour).padStart(2, '0')}:00`;
    readoutValue.textContent = value.toFixed(1);
    state.readoutKey = key;
  }
}

let resizeSettleToken = 0;

function applyViewportLayout() {
  pixelRatio = targetRendererPixelRatio();
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  root.dataset.rendererPixelRatio = pixelRatio.toFixed(2);
  const mobileCrisp = isPhoneLandscapeViewport() ? 1 : 0;
  if (rainChains?.points?.material?.uniforms) {
    rainChains.points.material.uniforms.uPixelRatio.value = pixelRatio;
    rainChains.points.material.uniforms.uMobileCrisp.value = mobileCrisp;
  }
  if (rainChains?.lines?.material?.uniforms) {
    rainChains.lines.material.uniforms.uMobileCrisp.value = mobileCrisp;
  }
  root.dataset.rainEdgeMode = mobileCrisp ? 'mobile-crisp' : 'authored';
  camera.aspect = window.innerWidth / window.innerHeight;
  applyCameraPreset();
  syncAxisLabelScale(axisSystem);
  updateRainPlotMask();
}

function onResize() {
  const token = ++resizeSettleToken;
  applyViewportLayout();

  // Mobile browsers can report an intermediate viewport while the device is
  // rotating. Refit once on the next frame and again after the viewport has
  // settled so a stale portrait/landscape aspect cannot become the final view.
  requestAnimationFrame(() => {
    if (token === resizeSettleToken) applyViewportLayout();
  });
  window.setTimeout(() => {
    if (token === resizeSettleToken) applyViewportLayout();
  }, 240);
}

function updateRainPlotMask() {
  rainPlotBounds.set(0, 1, 0, 1);
  rainPlotFeather.set(0.002, 0, 0.002);
  renderer.getDrawingBufferSize(rainViewport);
}

function randomArcCoverage(seed, arc) {
  return 0.46 + (Math.sin(seed * 12.9898 + arc * 78.233) * 0.5 + 0.5) * 0.42;
}

function createSeededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ result >>> 15, result | 1);
    result ^= result + Math.imul(result ^ result >>> 7, result | 61);
    return ((result ^ result >>> 14) >>> 0) / 4294967296;
  };
}

function createIndexedRandom(seed, index, cycle) {
  const mixedSeed = seed
    ^ Math.imul(index + 1, 0x9e3779b1)
    ^ Math.imul(cycle + 1, 0x85ebca6b);
  return createSeededRandom(mixedSeed >>> 0);
}

function valueNoise(value, seed) {
  const left = Math.floor(value);
  const amount = smoothstep(0, 1, value - left);
  return lerp(hashNoise(left, seed), hashNoise(left + 1, seed), amount);
}

function hashNoise(index, seed) {
  let value = Math.imul(index ^ seed, 0x45d9f3b);
  value = Math.imul(value ^ value >>> 16, 0x45d9f3b);
  return ((value ^ value >>> 16) >>> 0) / 4294967295;
}

function randomRange(min, max, random = Math.random) {
  return min + random() * (max - min);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function normalizeRainfallValue(value) {
  const scaled = value * 10;
  return Number.isFinite(scaled) ? Math.round(scaled) / 10 : value;
}


  // ══════════════════════════════════════════════════════════════════════
  // 生命周期收尾：重置全部调参 & 释放资源（原本散在面板里的 reload 逻辑）
  // ══════════════════════════════════════════════════════════════════════
  function resetAllTuning() {
    try {
      localStorage.removeItem(STORAGE.tuning);
      localStorage.removeItem(STORAGE.quality);
      localStorage.removeItem(STORAGE.feature);
      localStorage.removeItem(GLOBAL_THEME_STORAGE_KEY);
    } catch {}
    location.reload();
  }

  function dispose() {
    disposed = true;
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = 0;
    }
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
    window.visualViewport?.removeEventListener('resize', onResize);
    window.removeEventListener('blur', onInteractionInterrupted);
    document.removeEventListener('pointermove', onInteractionInterrupted);
    controls?.dispose?.();
    disposeObject3D(worldGroup);
    // 天空穹顶挂在 scene 上而不是 worldGroup，所以要单独释放。
    disposeObject3D(skyDome);
    renderer.dispose?.();
    root.dataset.webglStatus = 'disposed';
  }

  return {
    container: root,
    defaultRainfall,
    getRainfallData: () => [...activeRainfall],
    setRainfallData: (values) => applyRainfallData(values),
    resetRainfallData: () => applyRainfallData([...defaultRainfall]),
    getRainfallMaximum: () => rainfallMax,
    niceAxisCeiling: (value) => niceAxisCeiling(value),
    formatRainfallTick: (value) => formatRainfallTick(value),
    normalizeRainfallValue: (value) => normalizeRainfallValue(value),
    isRainSoundEnabled: () => rainAudio.enabled,
    setRainSoundEnabled: (enabled) => setRainSoundEnabled(enabled),
    toggleRainSound: () => setRainSoundEnabled(!rainAudio.enabled),
    getGlobalThemeColor: () => themeHexCss(globalThemeColor),
    applyGlobalColor: (value) => applyGlobalColor(value),
    resetView: () => resetView(),
    clearChartHover: () => clearChartHover(),
    getTuningSections: () => sections,
    getTuningValue: (path) => readPath(path),
    getTuningDefault: (path) => readPath(path, true),
    commitTuningValue: (param, raw) => commitValue(param, raw),
    getTuningSnapshot: () => ({
      theme: { color: themeHexCss(globalThemeColor).toUpperCase() },
      tuning: TUNING,
      quality: QUALITY,
      features: FEATURES
    }),
    resetAllTuning: () => resetAllTuning(),
    dispose: () => dispose()
  };
}
