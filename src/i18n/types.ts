// Required Notice: Rainform / 数据成雨 © 2026 afterimage — https://rainform.pages.dev/

/** 目前只支持简体中文与英文两套文案。 */
export type Locale = 'zh-CN' | 'en';

/** 文案里可插值的变量，例如 `{ time }` / `{ count }`。 */
export type I18nVariables = Record<string, string | number>;

/** 一条文案：静态字符串，或接受变量返回字符串的函数。 */
export type I18nMessage = string | ((variables: I18nVariables) => string);

/** 单语言的键值表。 */
export type MessageTable = Record<string, I18nMessage>;
