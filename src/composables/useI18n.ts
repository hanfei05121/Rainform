// Required Notice: Rainform / 数据成雨 © 2026 afterimage — https://rainform.pages.dev/

import { inject, provide, type InjectionKey } from 'vue';
import { createTranslator, locale, type I18nVariables, type Locale } from '../i18n';

export interface I18nContext {
  locale: Locale;
  t: (key: string, variables?: I18nVariables) => string;
}

const I18N_KEY: InjectionKey<I18nContext> = Symbol('rainform-i18n');

function createContext(): I18nContext {
  return { locale, t: createTranslator(locale) };
}

/** 在 App.vue 里调用一次，子组件即可通过 useI18n() 取到翻译函数。 */
export function provideI18n(): I18nContext {
  const context = createContext();
  provide(I18N_KEY, context);
  return context;
}

/** 取翻译函数；脱离 provider 使用时回退到全局语言。 */
export function useI18n(): I18nContext {
  return inject(I18N_KEY, createContext());
}
