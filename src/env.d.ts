/// <reference types="vite/client" />

// Required Notice: Rainform / 数据成雨 © 2026 afterimage — https://rainform.pages.dev/

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

// three 0.165 未内置 addons 的类型声明，这里按实际用到的成员补一份最小声明。
declare module 'three/addons/controls/OrbitControls.js' {
  export class OrbitControls {
    constructor(camera: unknown, domElement?: unknown);
    enableDamping: boolean;
    dampingFactor: number;
    enablePan: boolean;
    enableZoom: boolean;
    rotateSpeed: number;
    zoomSpeed: number;
    minDistance: number;
    maxDistance: number;
    minPolarAngle: number;
    maxPolarAngle: number;
    minAzimuthAngle: number;
    maxAzimuthAngle: number;
    target: { copy(target: unknown): void };
    update(): boolean | void;
    dispose(): void;
  }
}

interface RainSoundBoot {
  context: AudioContext | null;
  gain: GainNode | null;
  buffer: AudioBuffer | null;
  autoplayPromise: Promise<boolean> | null;
}

interface Window {
  __rainAudioBoot?: RainSoundBoot | null;
  /** bootstrap 里启动的雨声准备 promise；引擎创建前会 await 它。 */
  __rainAudioReady?: Promise<RainSoundBoot | null> | null;
  webkitAudioContext?: typeof AudioContext;
  /** 开发期暴露给调参面板与控制台调试用的引擎句柄。 */
  __rainformEngine?: unknown;
}
