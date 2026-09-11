// Required Notice: Rainform / 数据成雨 © 2026 afterimage — https://rainform.pages.dev/
//
// 语言解析与翻译入口。原先这段逻辑散在 src/main.js 与 src/bootstrap.js 两处，
// 现在统一到这里：引擎 import { i18n }，Vue 组件通过 provideI18n()/useI18n() 取 t()。

import { messages } from './messages';
import type { I18nVariables, Locale, MessageTable } from './types';

export { messages } from './messages';
export type { I18nVariables, Locale, MessageTable } from './types';

/** 在 X（Twitter）内置浏览器里打开时强制英文，避免内嵌 WebView 的中文字体回退问题。 */
export function isXEmbeddedLaunch(): boolean {
  const userAgent = navigator.userAgent || '';
  let referrerHost = '';

  try {
    referrerHost = document.referrer ? new URL(document.referrer).hostname : '';
  } catch {
    referrerHost = '';
  }

  const isXUserAgent = /Twitter(?:Android| for iPhone)?|com\.twitter|X\.com/i.test(userAgent);
  const isXReferrer = /(^|\.)(?:x\.com|twitter\.com|t\.co)$/i.test(referrerHost);
  return isXUserAgent || isXReferrer;
}

/** `?lang=zh` / `?lang=en` 优先，其次 X 内嵌强制英文，最后跟随浏览器语言。 */
export function detectLocale(): Locale {
  const requestedLanguage = new URLSearchParams(window.location.search).get('lang');
  const preferredLanguage = requestedLanguage
    || (isXEmbeddedLaunch() ? 'en' : navigator.languages?.[0] || navigator.language || 'en');
  return /^zh(?:-|$)/i.test(preferredLanguage) ? 'zh-CN' : 'en';
}

/** 应用启动时解析一次，运行期不变（切换语言靠刷新页面，与原实现一致）。 */
export const locale: Locale = detectLocale();

/** 供引擎等非组件环境直接调用。 */
export function i18n(key: string, variables: I18nVariables = {}): string {
  const table: MessageTable = messages[locale] ?? messages.en;
  const value = table[key] ?? messages.en[key] ?? key;
  return typeof value === 'function' ? value(variables) : value;
}

/** 绑定到固定语言的翻译函数（组件里用这个，避免每处都写 locale）。 */
export function createTranslator(target: Locale = locale) {
  const table: MessageTable = messages[target] ?? messages.en;
  return (key: string, variables: I18nVariables = {}): string => {
    const value = table[key] ?? messages.en[key] ?? key;
    return typeof value === 'function' ? value(variables) : value;
  };
}

/**
 * 同步 <html lang>、document.title、社交分享 meta，以及页面里所有
 * data-i18n / data-i18n-aria-label / data-i18n-title 声明的静态节点。
 *
 * Vue 接管后组件直接渲染文案，这个函数主要负责 meta 与 title；
 * 保留 DOM 扫描是为了兼容仍在 index.html 里的静态标记与竖屏门控。
 */
export function applyDocumentLocale(target: Locale = locale): void {
  const t = createTranslator(target);
  document.documentElement.lang = target;
  document.title = t('documentTitle');
  document.querySelector('meta[name="description"]')?.setAttribute('content', t('description'));
  document.querySelector('meta[property="og:locale"]')?.setAttribute('content', target === 'zh-CN' ? 'zh_CN' : 'en_US');
  document.querySelector('meta[property="og:title"]')?.setAttribute('content', t('documentTitle'));
  document.querySelector('meta[property="og:description"]')?.setAttribute('content', t('socialDescription'));
  document.querySelector('meta[property="og:image:alt"]')?.setAttribute('content', t('socialImageAlt'));
  document.querySelector('meta[name="twitter:title"]')?.setAttribute('content', t('documentTitle'));
  document.querySelector('meta[name="twitter:description"]')?.setAttribute('content', t('socialDescription'));

  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((element) => {
    const key = element.dataset.i18n;
    if (key) element.textContent = t(key);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-aria-label]').forEach((element) => {
    const key = element.dataset.i18nAriaLabel;
    if (key) element.setAttribute('aria-label', t(key));
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((element) => {
    const key = element.dataset.i18nTitle;
    if (key) element.setAttribute('title', t(key));
  });
}
