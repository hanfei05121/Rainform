<script setup lang="ts">
// Required Notice: Rainform / 数据成雨 © 2026 afterimage — https://rainform.pages.dev/
//
// 「效果控制台」侧边面板 + 它的设置按钮 —— 只在开发构建里存在。
//
// 原实现是 src/main.js 里的 initTuningPanelV2()，用 createElement 拼出整块
// 面板、给每个参数一行控件并手动同步 DOM。这里改成 Vue 组件：
//   · 参数表（区块 / 标签 / 说明 / 键名）全部来自引擎的 getTuningSections()；
//   · 控件值保存在 values 里，写回时用引擎的 commitTuningValue() 清洗并落盘；
//   · 搜索、展开/折叠、复制配置、恢复默认等行为与原实现保持一致。
//
// 按钮和面板都归这个组件管：折叠时按钮被 Teleport 进 #scene-toolbar（第三颗按钮），
// 展开时移到 body —— 面板和工具栏都带 backdrop-filter，会给固定定位后代创建包含块，
// 不挪出去就拿不到视口坐标。这样整块（组件 + 样式）在生产构建里一起被摇树剔除。

import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import '../styles/tuning-console.css';
import { useI18n } from '../composables/useI18n';
import { useEngine } from '../composables/useRainformEngine';
import {
  disposeLiquidGlass,
  installLiquidGlass,
  LIQUID_GLASS_PANEL
} from '../composables/useLiquidGlass';
import type {
  ThemeAppliedPayload,
  TuningParameterDescriptor,
  TuningSectionDescriptor
} from '../engine/rainformEngine';

const props = defineProps<{
  /** 面板是否展开（v-model:open）。 */
  open: boolean;
  /** 引擎刚应用过整体主题色。 */
  themeApplied: ThemeAppliedPayload | null;
  /** 有「需刷新才生效」的参数被改过。 */
  refreshDirty: boolean;
}>();

const emit = defineEmits<{ (event: 'update:open', value: boolean): void }>();

const { t } = useI18n();
const engine = useEngine();

const panel = ref<HTMLElement | null>(null);
const toggleButton = ref<HTMLButtonElement | null>(null);
/**
 * 液态玻璃是否已装好。必须由 Vue 拥有这个类名：
 * 面板的 class 绑定了 { open }，一旦展开 Vue 会重写整个 class 属性，
 * 把 installLiquidGlass() 命令式加上的 rf-liquid-glass 冲掉 —— 于是面板底色、
 * 描边、卡片圆角会悄悄退回非玻璃样式（按钮因为 class 恒定才不会中招）。
 */
const glassInstalled = ref(false);
const query = ref('');
const copyLabel = ref('复制全部配置');
const themeStatus = ref('当前 #000000');
const themePickerValue = ref('#000000');
const themeHexText = ref('#000000');

/** 控件值镜像：key 为参数路径，值来自引擎（写入也先过引擎清洗）。 */
const values = reactive<Record<string, unknown>>({});
/** 区块展开状态（用户点击 / 展开全部 / 折叠全部都会写这里）。 */
const openSections = reactive<Record<string, boolean>>({});

// ── 参数表 ───────────────────────────────────────────────────────────
const sections = computed<TuningSectionDescriptor[]>(() => engine.value?.getTuningSections() ?? []);
const allParams = computed(() => sections.value.flatMap((section) => section.params));

/** 引擎是异步创建的：就绪后（以及主题联动改写过参数后）重新拉一遍值。 */
function syncValues() {
  const instance = engine.value;
  if (!instance) return;
  allParams.value.forEach((param) => {
    values[param.key] = instance.getTuningValue(param.key);
  });
}

watch(sections, (list) => {
  list.forEach((section) => {
    if (!(section.id in openSections)) openSections[section.id] = Boolean(section.open);
  });
  syncValues();
}, { immediate: true });

watch(engine, (instance) => {
  if (!instance) return;
  syncValues();
  syncThemeInputs();
});

// ── 搜索 ─────────────────────────────────────────────────────────────
const normalizedQuery = computed(() => query.value.trim().toLowerCase());

function searchIndex(section: TuningSectionDescriptor, param: TuningParameterDescriptor): string {
  return `${section.title} ${param.label} ${param.desc} ${param.key}`.toLowerCase();
}

function visibleParams(section: TuningSectionDescriptor): TuningParameterDescriptor[] {
  const keyword = normalizedQuery.value;
  if (!keyword) return section.params;
  return section.params.filter((param) => searchIndex(section, param).includes(keyword));
}

const visibleCount = computed(() =>
  sections.value.reduce((total, section) => total + visibleParams(section).length, 0)
);

/** 当前命中的参数键集合，模板里用它来决定每一行是否显示。 */
const visibleKeys = computed(() => {
  const keys = new Set<string>();
  sections.value.forEach((section) => {
    visibleParams(section).forEach((param) => keys.add(param.key));
  });
  return keys;
});

/** 搜索时命中的区块强制展开，清空搜索后回到用户自己的展开状态。 */
function isSectionOpen(section: TuningSectionDescriptor): boolean {
  if (normalizedQuery.value) return visibleParams(section).length > 0;
  return Boolean(openSections[section.id]);
}

function onSectionToggle(section: TuningSectionDescriptor, event: Event) {
  const element = event.target;
  if (!(element instanceof HTMLDetailsElement)) return;
  openSections[section.id] = element.open;
}

function expandAll() {
  sections.value.forEach((section) => {
    if (visibleParams(section).length) openSections[section.id] = true;
  });
}

function collapseAll() {
  sections.value.forEach((section) => { openSections[section.id] = false; });
}

// ── 数值工具 ─────────────────────────────────────────────────────────
function decimalsFor(step: number): number {
  const text = String(step);
  if (text.includes('e-')) return Number(text.split('e-')[1]);
  return text.includes('.') ? text.split('.')[1].length : 0;
}

function formatNumber(value: unknown, step: number): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  const digits = Math.min(8, Math.max(decimalsFor(step), 0));
  return String(Number(numeric.toFixed(digits)));
}

function toHex(value: unknown): string {
  return `#${(Number(value) >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
}

function normalizeHexText(raw: string): string | null {
  const normalized = raw.trim().replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(normalized) ? `#${normalized.toLowerCase()}` : null;
}

function numberValue(param: TuningParameterDescriptor): number {
  const numeric = Number(values[param.key]);
  return Number.isFinite(numeric) ? numeric : 0;
}

const isOutsideSoft = (param: TuningParameterDescriptor) => (
  numberValue(param) < Number(param.min) || numberValue(param) > Number(param.max)
);

/** 写入一个参数：交回引擎清洗 + 落盘，并把清洗后的值同步到界面。 */
function setValue(param: TuningParameterDescriptor, raw: unknown): unknown {
  const instance = engine.value;
  if (!instance) return raw;
  const committed = instance.commitTuningValue(param, raw);
  values[param.key] = committed;
  return committed;
}

function resetParam(param: TuningParameterDescriptor) {
  const instance = engine.value;
  if (!instance) return;
  values[param.key] = instance.commitTuningValue(param, instance.getTuningDefault(param.key));
}

// ── 三种控件的交互 ───────────────────────────────────────────────────
function onRangeInput(param: TuningParameterDescriptor, event: Event) {
  setValue(param, (event.target as HTMLInputElement).value);
}

/** 正在输入 `-` / `.` / 空串时不提交，否则光标和符号会被吃掉。 */
function onNumberInput(param: TuningParameterDescriptor, event: Event) {
  const element = event.target as HTMLInputElement;
  if (element.value === '' || element.value === '-' || element.value === '.') return;
  const numeric = Number(element.value);
  if (Number.isFinite(numeric)) setValue(param, numeric);
}

function onNumberBlur(param: TuningParameterDescriptor, event: Event) {
  const element = event.target as HTMLInputElement;
  const committed = setValue(param, element.value);
  element.value = formatNumber(committed, Number(param.step));
}

function onColorInput(param: TuningParameterDescriptor, event: Event) {
  const element = event.target as HTMLInputElement;
  setValue(param, parseInt(element.value.slice(1), 16));
}

function onHexChange(param: TuningParameterDescriptor, event: Event) {
  const element = event.target as HTMLInputElement;
  const hex = normalizeHexText(element.value);
  if (hex) {
    setValue(param, parseInt(hex.slice(1), 16));
    return;
  }
  // 无效输入：回写当前值，避免框里留着一段非法文本。
  element.value = toHex(values[param.key]).toUpperCase();
}

function onToggleChange(param: TuningParameterDescriptor, event: Event) {
  setValue(param, (event.target as HTMLInputElement).checked);
}

// ── 整体调色 ─────────────────────────────────────────────────────────
function syncThemeInputs() {
  const hex = (engine.value?.getGlobalThemeColor() ?? '#000000').toUpperCase();
  themePickerValue.value = hex;
  themeHexText.value = hex;
  themeStatus.value = `当前 ${hex}`;
}

function onThemePick(event: Event) {
  const hex = (event.target as HTMLInputElement).value.toUpperCase();
  themePickerValue.value = hex;
  themeHexText.value = hex;
  themeStatus.value = '待应用';
}

function onThemeHexInput(event: Event) {
  const hex = normalizeHexText((event.target as HTMLInputElement).value);
  if (!hex) return;
  themePickerValue.value = hex;
  themeStatus.value = '待应用';
}

function applyThemeValue(value: number) {
  engine.value?.applyGlobalColor(value);
}

function applyTheme() {
  const hex = normalizeHexText(themeHexText.value);
  if (!hex) {
    syncThemeInputs();
    themeStatus.value = '请输入 6 位十六进制颜色';
    return;
  }
  applyThemeValue(parseInt(hex.slice(1), 16));
}

watch(() => props.themeApplied, (payload) => {
  if (!payload) return;
  themePickerValue.value = payload.hex;
  themeHexText.value = payload.hex;
  themeStatus.value = `已应用 ${payload.hex}`;
  // 主题联动会改写金属色 / 水面 / 雾霭等一批参数，需要整体重新同步。
  syncValues();
});

watch(engine, (instance) => {
  if (instance) syncThemeInputs();
});

// ── 底部动作 ─────────────────────────────────────────────────────────
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

async function copyConfig() {
  const snapshot = engine.value?.getTuningSnapshot() ?? {};
  try {
    await copyText(JSON.stringify(snapshot, null, 2));
    copyLabel.value = '已复制 ✓';
  } catch {
    copyLabel.value = '复制失败';
  }
  window.setTimeout(() => { copyLabel.value = '复制全部配置'; }, 1500);
}

function resetAll() {
  if (!confirm('恢复所有视觉、性能和图层参数为代码默认值？页面将刷新。')) return;
  engine.value?.resetAllTuning();
}

/** 「需刷新才生效」提示里的立即刷新：只重载页面，不动已保存的参数。 */
function reloadPage() {
  location.reload();
}

// ── 开合与键盘 ───────────────────────────────────────────────────────
function close() {
  emit('update:open', false);
}

function toggle() {
  emit('update:open', !props.open);
}

/**
 * Teleport 目标：折叠时插进工具栏当第三颗按钮，展开时挪到 body。
 * Vue 3.5 在 to 变化时是移动同一个 DOM 节点（不是重建），
 * 所以挂在按钮上的液态玻璃滤镜不会丢 —— 由 rf-verify 会话实测确认。
 */
const toggleTarget = computed(() => (props.open ? 'body' : '#scene-toolbar'));

function onPanelKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  close();
  // 焦点要等 Teleport 把按钮挪回工具栏之后再给，否则节点被移动时焦点会丢。
  nextTick(() => toggleButton.value?.focus());
}

function onDocumentPointerDown(event: PointerEvent) {
  if (!props.open) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (panel.value?.contains(target)) return;
  if (toggleButton.value?.contains(target)) return;
  close();
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  // 按钮不再挂液态玻璃滤镜：滤镜贴图中心是一块 93% alpha 的灰色实心块，
  // 会把透明圆钮染成一颗深灰球，跟旁边两颗原生按钮永远不是一个材质。
  if (panel.value) installLiquidGlass(panel.value, LIQUID_GLASS_PANEL);
  glassInstalled.value = true;
  syncValues();
  syncThemeInputs();
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  disposeLiquidGlass();
});
</script>

<template>
  <Teleport :to="toggleTarget">
    <button
      id="tuning-toggle"
      ref="toggleButton"
      class="scene-toolbar__toggle"
      type="button"
      aria-controls="tuning-panel"
      :aria-expanded="open"
      :aria-label="open ? t('consoleClose') : t('consoleToggle')"
      :title="open ? t('consoleClose') : t('consoleToggle')"
      @click="toggle"
    >
      <span aria-hidden="true">⚙</span>
    </button>
  </Teleport>

  <aside
    id="tuning-panel"
    ref="panel"
    :class="[{ 'rf-liquid-glass': glassInstalled }, { open }]"
    aria-label="效果参数控制台"
    :data-parameter-count="allParams.length"
    :data-refresh-dirty="String(refreshDirty)"
    :data-global-theme-color="themeHexText"
    @keydown="onPanelKeydown"
  >
    <header class="tc-head">
      <p class="tc-eyebrow">VISUAL PARAMETERS</p>
      <div class="tc-title-line">
        <h2 class="tc-title">效果控制台</h2>
        <span class="tc-count">{{ allParams.length }} 个参数</span>
      </div>
      <p class="tc-intro">
        <b>实时</b>参数立即更新；<em>刷新</em>参数先保存、刷新后重建。滑块是建议范围，数字框可直接越界输入。
      </p>
      <div class="tc-tools">
        <input
          v-model="query"
          class="tc-search"
          type="search"
          placeholder="搜索参数、说明或键名…"
          aria-label="搜索参数"
        />
        <button class="tc-tool-btn" type="button" @click="expandAll">展开</button>
        <button class="tc-tool-btn" type="button" @click="collapseAll">折叠</button>
      </div>
      <div class="tc-search-meta">显示 {{ visibleCount }} / {{ allParams.length }}</div>
    </header>

    <div class="tc-refresh" :hidden="!refreshDirty">
      <span>已修改需要重建的参数</span>
      <button type="button" @click="reloadPage">立即刷新</button>
    </div>

    <div class="tc-scroll">
      <section class="tc-theme-card" aria-label="整体调色">
        <div class="tc-theme-head">
          <h3 class="tc-theme-title">整体调色</h3>
          <span class="tc-theme-badge">全局联动</span>
        </div>
        <p class="tc-theme-desc">
          选择一个主色，一键联动背景、液态金属雨、水面、雾霭、坐标轴与界面色彩，并自动保持明暗层次。
        </p>
        <div class="tc-theme-controls">
          <input
            class="tc-theme-picker"
            type="color"
            aria-label="整体主题颜色"
            :value="themePickerValue"
            @input="onThemePick"
          />
          <input
            class="tc-hex tc-theme-hex"
            type="text"
            spellcheck="false"
            aria-label="整体主题十六进制颜色"
            v-model="themeHexText"
            @input="onThemeHexInput"
            @keydown.enter.prevent="applyTheme"
          />
          <button class="tc-theme-apply" type="button" @click="applyTheme">应用到整体</button>
        </div>
        <div class="tc-theme-foot">
          <button class="tc-theme-reset" type="button" @click="applyThemeValue(0x000000)">恢复黑色主题</button>
          <span class="tc-theme-status" aria-live="polite">{{ themeStatus }}</span>
        </div>
      </section>

      <details
        v-for="section in sections"
        :key="section.id"
        class="tc-section"
        :data-section-id="section.id"
        :open="isSectionOpen(section)"
        :hidden="Boolean(normalizedQuery) && visibleParams(section).length === 0"
        @toggle="onSectionToggle(section, $event)"
      >
        <summary>
          <span>{{ section.icon }}</span>
          <span>{{ section.title }}</span>
          <span class="tc-sec-count">{{ section.params.length }}</span>
        </summary>
        <p class="tc-sec-desc">{{ section.desc }}</p>

        <div
          v-for="param in section.params"
          :key="param.key"
          class="tc-param"
          :class="{ 'outside-soft': isOutsideSoft(param) }"
          :hidden="!visibleKeys.has(param.key)"
        >
          <div class="tc-param-head">
            <span class="tc-label">{{ param.label }}</span>
            <span class="tc-badge" :class="param.mode">{{ param.mode === 'reload' ? '刷新' : '实时' }}</span>
            <button
              class="tc-reset-one"
              type="button"
              title="恢复此参数默认值"
              :aria-label="`恢复${param.label}默认值`"
              @click="resetParam(param)"
            >↺</button>
          </div>

          <!-- 开关行的说明要跟在开关左边（见下方 .tc-switch-wrap），所以这里跳过 -->
          <p v-if="param.type !== 'toggle'" class="tc-desc">
            {{ param.desc }}<span class="tc-key">{{ param.key }}</span>
          </p>

          <template v-if="param.type === 'number'">
            <div class="tc-number-controls">
              <input
                class="tc-range"
                type="range"
                :step="param.step"
                :min="Math.min(Number(param.min), numberValue(param))"
                :max="Math.max(Number(param.max), numberValue(param))"
                :value="numberValue(param)"
                :aria-label="`${param.label}滑块`"
                @input="onRangeInput(param, $event)"
              />
              <input
                class="tc-number"
                type="number"
                :step="param.step"
                :value="formatNumber(values[param.key], Number(param.step))"
                :aria-label="`${param.label}数值`"
                @input="onNumberInput(param, $event)"
                @blur="onNumberBlur(param, $event)"
              />
            </div>
            <div class="tc-soft">建议滑块 {{ param.min }} ～ {{ param.max }} · 数字框不限软范围</div>
          </template>

          <div v-else-if="param.type === 'color'" class="tc-color-controls">
            <input
              class="tc-color"
              type="color"
              :value="toHex(values[param.key])"
              :aria-label="`${param.label}颜色`"
              @input="onColorInput(param, $event)"
            />
            <input
              class="tc-hex"
              type="text"
              spellcheck="false"
              :value="toHex(values[param.key]).toUpperCase()"
              :aria-label="`${param.label}十六进制颜色`"
              @change="onHexChange(param, $event)"
            />
          </div>

          <div v-else class="tc-switch-wrap">
            <p class="tc-desc">
              {{ param.desc }}<span class="tc-key">{{ param.key }}</span>
            </p>
            <label class="tc-switch">
              <input
                type="checkbox"
                :checked="Boolean(values[param.key])"
                :aria-label="param.label"
                @change="onToggleChange(param, $event)"
              />
              <span></span>
            </label>
          </div>
        </div>
      </details>
    </div>

    <footer class="tc-foot">
      <button class="tc-action" type="button" @click="copyConfig">{{ copyLabel }}</button>
      <button class="tc-action danger" type="button" @click="resetAll">恢复全部默认</button>
    </footer>
  </aside>
</template>
