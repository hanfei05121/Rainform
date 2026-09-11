// Required Notice: Rainform / 数据成雨 © 2026 afterimage — https://rainform.pages.dev/
//
// 液态玻璃（Liquid Glass）。原理与 careercompass 导航所用的 LiquidGlass 组件一致：
//   生成一张「法线贴图」SVG（红/蓝渐变圆角矩形做 difference 混合 + 中心模糊实心块）
//   → 作为 feImage 输入 → 三条 feDisplacementMap 分别对 R/G/B 通道做不同强度位移
//   → screen 混合 → 通过 backdrop-filter: url(#filter) 应用，
//   得到「边缘折射、中间平滑」的玻璃质感。
//
// 用法：在 onMounted 里调用 installLiquidGlass(el, options)。
// 所有 ResizeObserver 会在 disposeLiquidGlass() 里统一断开。
//
// 注意：这份实现只服务于开发环境的「效果控制台」（设置按钮 + 面板），
// 生产构建里整块被摇树剔除。

export interface LiquidGlassConfig {
  /** 圆角半径；很大时等于胶囊/圆形。 */
  radius: number;
  /** 折射带宽度（相对短边的比例）。 */
  border: number;
  /** 贴图中心块的明度（hsl 的 0 0% L%）。 */
  lightness: number;
  /** 贴图中心块的 alpha。 */
  alpha: number;
  /** 贴图中心块的模糊半径。 */
  blur: number;
  /** 基础位移强度。 */
  scale: number;
  /** R/G/B 三通道的位移偏移（错开就产生色散边缘）。 */
  rOffset: number;
  gOffset: number;
  bOffset: number;
  /** 位移后再叠加的高斯模糊，用来压住长条面板的折射噪点。 */
  displace: number;
  /** 红/蓝渐变的混合模式。 */
  blend: string;
  xChannel: string;
  yChannel: string;
}

export const LIQUID_GLASS_DEFAULTS: LiquidGlassConfig = {
  radius: 999,
  border: 0.35,
  lightness: 50,
  alpha: 0.93,
  blur: 6,
  scale: -80,
  rOffset: 0,
  gOffset: 2,
  bOffset: 4,
  displace: 0,
  blend: 'difference',
  xChannel: 'R',
  yChannel: 'B'
};

/** 面板是竖直长条：收窄折射带，并追加少量高斯模糊以保证正文可读。 */
export const LIQUID_GLASS_PANEL: Partial<LiquidGlassConfig> = { radius: 0, border: 0.14, displace: 14 };

const LIQUID_GLASS_SVG_NS = 'http://www.w3.org/2000/svg';
let liquidGlassSeed = 0;
let liquidGlassDefs: SVGSVGElement | null = null;
const liquidGlassObservers = new Set<ResizeObserver>();

/** 不支持 backdrop-filter: url() 或用户要求降低动效/透明度时，退回毛玻璃。 */
const liquidGlassSupported = (() => {
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return false;
  const supportsUrl =
    CSS.supports('backdrop-filter', 'url(#a)') || CSS.supports('-webkit-backdrop-filter', 'url(#a)');
  if (!supportsUrl) return false;
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  const reduceTransparency =
    window.matchMedia?.('(prefers-reduced-transparency: reduce)')?.matches === true;
  return !reduceMotion && !reduceTransparency;
})();

/** 全局共享一份 <svg><defs> 容器，所有滤镜都挂进去。 */
function liquidGlassDefsNode(): SVGSVGElement {
  if (liquidGlassDefs && liquidGlassDefs.isConnected) return liquidGlassDefs;
  const svg = document.createElementNS(LIQUID_GLASS_SVG_NS, 'svg');
  svg.setAttribute('id', 'rf-liquid-glass-defs');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
  document.body.appendChild(svg);
  liquidGlassDefs = svg;
  return svg;
}

/** 法线贴图：黑底 + 红/蓝渐变圆角矩形（差值混合） + 中心模糊的灰色实心块。 */
function liquidGlassMap(width: number, height: number, config: LiquidGlassConfig): string {
  const edge = Math.min(width, height) * (config.border * 0.5);
  const radius = Math.min(config.radius, width / 2, height / 2);
  const innerRadius = Math.max(0, radius - edge);
  const innerWidth = Math.max(0, width - edge * 2);
  const innerHeight = Math.max(0, height - edge * 2);
  const svg =
    `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">` +
    '<defs>' +
    '<linearGradient id="rfLgRed" x1="100%" y1="0%" x2="0%" y2="0%">' +
    '<stop offset="0%" stop-color="#0000"/><stop offset="100%" stop-color="red"/></linearGradient>' +
    '<linearGradient id="rfLgBlue" x1="0%" y1="0%" x2="0%" y2="100%">' +
    '<stop offset="0%" stop-color="#0000"/><stop offset="100%" stop-color="blue"/></linearGradient>' +
    '</defs>' +
    `<rect x="0" y="0" width="${width}" height="${height}" fill="black"></rect>` +
    `<rect x="0" y="0" width="${width}" height="${height}" rx="${radius}" fill="url(#rfLgRed)"/>` +
    `<rect x="0" y="0" width="${width}" height="${height}" rx="${radius}" fill="url(#rfLgBlue)" style="mix-blend-mode:${config.blend}"/>` +
    `<rect x="${edge}" y="${edge}" width="${innerWidth}" height="${innerHeight}" rx="${innerRadius}" ` +
    `fill="hsl(0 0% ${config.lightness}% / ${config.alpha})" style="filter:blur(${config.blur}px)"/>` +
    '</svg>';
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** filter 主体：feImage → 三通道位移 → screen 混合（必要时再叠一层模糊）。 */
function liquidGlassFilterBody(mapUrl: string, config: LiquidGlassConfig): string {
  const displacement = (scale: number, result: string) =>
    `<feDisplacementMap in="SourceGraphic" in2="map" xChannelSelector="${config.xChannel}" ` +
    `yChannelSelector="${config.yChannel}" scale="${scale}" result="${result}"/>`;
  const channel = (input: string, values: string, result: string) =>
    `<feColorMatrix in="${input}" type="matrix" values="${values}" result="${result}"/>`;
  const perChannel = config.rOffset !== 0 || config.gOffset !== 0 || config.bOffset !== 0;
  const body = perChannel
    ? displacement(config.scale + config.rOffset, 'dispRed') +
      channel('dispRed', '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0', 'red') +
      displacement(config.scale + config.gOffset, 'dispGreen') +
      channel('dispGreen', '0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0', 'green') +
      displacement(config.scale + config.bOffset, 'dispBlue') +
      channel('dispBlue', '0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0', 'blue') +
      '<feBlend in="red" in2="green" mode="screen" result="rg"/>' +
      '<feBlend in="rg" in2="blue" mode="screen" result="output"/>'
    : displacement(config.scale, 'output');
  const blur = config.displace > 0 ? `<feGaussianBlur stdDeviation="${config.displace}"/>` : '';
  return (
    `<feImage x="0" y="0" width="100%" height="100%" href="${mapUrl}" result="map"/>` +
    body +
    blur
  );
}

/** 把液态玻璃挂到某个元素上：尺寸变化时重建贴图，并只在支持时启用滤镜。 */
export function installLiquidGlass(
  element: HTMLElement | null | undefined,
  options: Partial<LiquidGlassConfig> = {}
): void {
  if (!element) return;
  const config: LiquidGlassConfig = { ...LIQUID_GLASS_DEFAULTS, ...options };
  const filterId = `rfLiquidGlass-${(liquidGlassSeed += 1)}-${Math.random().toString(36).slice(2, 7)}`;
  const filter = document.createElementNS(LIQUID_GLASS_SVG_NS, 'filter');
  filter.setAttribute('id', filterId);
  filter.setAttribute('color-interpolation-filters', 'sRGB');
  liquidGlassDefsNode().appendChild(filter);

  element.classList.add('rf-liquid-glass');

  let painted = '';
  const paint = () => {
    if (!element.isConnected) return;
    const rect = element.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (width <= 0 || height <= 0) return;
    const key = `${width}x${height}`;
    if (key === painted) return;
    painted = key;
    filter.innerHTML = liquidGlassFilterBody(liquidGlassMap(width, height, config), config);
    if (liquidGlassSupported) {
      element.style.setProperty('backdrop-filter', `url(#${filterId})`);
      element.style.setProperty('-webkit-backdrop-filter', `url(#${filterId})`);
    }
  };

  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(paint);
    observer.observe(element);
    liquidGlassObservers.add(observer);
  }
  paint();
  requestAnimationFrame(paint);
}

/** 断开所有观察者并移除生成的滤镜节点（组件卸载时调用）。 */
export function disposeLiquidGlass(): void {
  liquidGlassObservers.forEach((observer) => observer.disconnect());
  liquidGlassObservers.clear();
  if (liquidGlassDefs) {
    liquidGlassDefs.innerHTML = '';
    liquidGlassDefs = null;
  }
}
