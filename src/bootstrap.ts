// Required Notice: Rainform / 数据成雨 © 2026 afterimage — https://rainform.pages.dev/
//
// 启动引导（index.html 的入口）。在 Vue 应用之前做两件事：
//
//   1) 标记 data-app-state = 'loading'，挂载后再由 App.vue 拨到
//      waiting-landscape / ready（调试与自动化验证用）。
//   2) 预取并解码雨声。雨声要在用户第一次点击时立即能播，所以音频和 Vue
//      应用【并行】准备 —— 引擎在创建前会 await 这个 promise
//      （见 components/SceneCanvas.vue），因此 window.__rainAudioBoot
//      一定在引擎模块求值之前写好。
//
// 这就是原来 bootstrap.js + main.js 里那两件事的全部；页面骨架已经交给 Vue。

const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;

async function prepareRainAudio(): Promise<RainSoundBoot | null> {
  if (!AudioContextConstructor) return null;
  let context: AudioContext;
  try {
    context = new AudioContextConstructor({ latencyHint: 'interactive' });
  } catch {
    context = new AudioContextConstructor();
  }
  const gain = context.createGain();
  gain.gain.value = 0;
  gain.connect(context.destination);

  const response = await fetch('/audio/rain-loop.wav');
  if (!response.ok) throw new Error(`Rain audio request failed: ${response.status}`);
  const encoded = await response.arrayBuffer();
  const buffer = await context.decodeAudioData(encoded);
  const autoplayPromise = context.state === 'running'
    ? Promise.resolve(true)
    : context.resume().then(() => context.state === 'running').catch(() => false);
  return { context, gain, buffer, autoplayPromise };
}

document.documentElement.dataset.appState = 'loading';

// 音频失败只是没有雨声，不影响界面：吞掉错误，交给引擎按「无音频」处理。
window.__rainAudioReady = prepareRainAudio().catch((error) => {
  console.warn('Rainform: rain audio unavailable', error);
  return null;
});

import('./main').catch((error) => {
  document.documentElement.dataset.appState = 'error';
  console.error('Rainform failed to start', error);
});
