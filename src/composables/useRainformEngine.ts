// Required Notice: Rainform / 数据成雨 © 2026 afterimage — https://rainform.pages.dev/

import { inject, provide, shallowRef, type InjectionKey, type ShallowRef } from 'vue';
import type { RainformEngine } from '../engine/rainformEngine';

export type { RainformEngine, RainformEngineOptions } from '../engine/rainformEngine';
export type { TuningParameterDescriptor, TuningSectionDescriptor } from '../engine/rainformEngine';

/**
 * 引擎句柄用 shallowRef 持有：引擎内部有大量可变状态与 THREE 对象，
 * 不能走深度响应式（否则会把整个 WebGL 场景代理一遍，性能灾难）。
 */
export type EngineRef = ShallowRef<RainformEngine | null>;

const ENGINE_KEY: InjectionKey<EngineRef> = Symbol('rainform-engine');

/** 在 App.vue 调用一次。 */
export function provideEngine(): EngineRef {
  const engine = shallowRef<RainformEngine | null>(null);
  provide(ENGINE_KEY, engine);
  return engine;
}

/** 子组件取引擎句柄；引擎是异步创建的，使用前需判空。 */
export function useEngine(): EngineRef {
  const engine = inject(ENGINE_KEY);
  if (!engine) throw new Error('useEngine() 必须在 provideEngine() 之后调用');
  return engine;
}
