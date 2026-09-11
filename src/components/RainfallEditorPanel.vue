<script setup lang="ts">
// Required Notice: Rainform / 数据成雨 © 2026 afterimage — https://rainform.pages.dev/
//
// 右侧「编辑降雨数据」侧边面板。
//
// 原实现是 src/main.js 里的 initRainfallEditor()，直接操作 DOM 构建 SVG 折线图、
// 25 个输入框并挂事件。这里改成 Vue 组件：折线图几何全部由 computed 推导，
// 校验/状态文案走响应式状态。
//
// 唯一保留的命令式部分：25 个数字输入框的 value。
// 原因是用户正在输入时（例如刚敲下 "1."）不能被规范化后的值回写覆盖，否则光标会跳、
// 小数点会被吃掉 —— 原实现也是只在「同步」时机写 input.value。

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from '../composables/useI18n';
import { useEngine } from '../composables/useRainformEngine';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (event: 'update:open', value: boolean): void }>();

const { t } = useI18n();
const engine = useEngine();

// ── 图表几何（与 SVG viewBox 720×280 严格对应）────────────────────────
const CHART = { width: 720, height: 280, left: 42, right: 18, top: 24, bottom: 258 };
const PLOT_WIDTH = CHART.width - CHART.left - CHART.right;
const PLOT_HEIGHT = CHART.bottom - CHART.top;
const HOUR_COUNT = 25;

// ── 状态 ─────────────────────────────────────────────────────────────
/** 正在编辑的草稿值（打开面板时从引擎当前数据同步）。 */
const draft = ref<number[]>([]);
const chartMax = ref(20);
const selectedHour = ref(18);
const statusText = ref('');
const errorText = ref('');
const fieldErrors = ref<string[]>(Array.from({ length: HOUR_COUNT }, () => ''));
const preciseOpen = ref(false);
const applying = ref(false);

let draggingHour: number | null = null;
let draggingPointerId: number | null = null;
let liveApplyTimer: number | null = null;

const chartSvg = ref<SVGSVGElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const inputRefs = ref<any[]>([]);

// ── 工具 ─────────────────────────────────────────────────────────────
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const formatInputValue = (value: number) => Number(value).toFixed(1);
const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

function niceCeiling(value: number): number {
  return engine.value ? engine.value.niceAxisCeiling(value) : value;
}
function normalize(value: number): number {
  if (engine.value) return engine.value.normalizeRainfallValue(value);
  return Number.isFinite(value * 10) ? Math.round(value * 10) / 10 : value;
}
function formatTick(value: number): string | number {
  return engine.value ? engine.value.formatRainfallTick(value) : value;
}

// ── 折线图几何 ───────────────────────────────────────────────────────
const pointPositions = computed(() => draft.value.map((value, hour) => ({
  x: CHART.left + hour / (HOUR_COUNT - 1) * PLOT_WIDTH,
  y: CHART.bottom - clamp(value / Math.max(0.1, chartMax.value), 0, 1) * PLOT_HEIGHT
})));

const linePoints = computed(() => pointPositions.value.map((p) => `${p.x},${p.y}`).join(' '));

const areaPath = computed(() => {
  const points = pointPositions.value;
  if (!points.length) return '';
  return `M ${points[0].x} ${CHART.bottom} L ${points.map((p) => `${p.x} ${p.y}`).join(' L ')} L ${points[points.length - 1].x} ${CHART.bottom} Z`;
});

/** 横向网格线 + 刻度文字（0 / 50% / 100%）。 */
const horizontalTicks = computed(() => [0, 0.5, 1].map((ratio) => ({
  y: CHART.bottom - ratio * PLOT_HEIGHT,
  label: String(formatTick(chartMax.value * ratio))
})));

/** 纵向网格线（每 6 小时）。 */
const verticalTicks = computed(() => [0, 6, 12, 18, 24].map((hour) => ({
  x: CHART.left + hour / 24 * PLOT_WIDTH
})));

// ── 与引擎的数据交换 ─────────────────────────────────────────────────
function updateChartScale(values: number[]) {
  const maximum = values.reduce((max, value) => Math.max(max, value), 0);
  chartMax.value = Math.max(20, niceCeiling(maximum * 1.25));
}

function currentEngineData(): number[] {
  return engine.value ? [...engine.value.getRainfallData()] : [];
}

/** 把一组值写回输入框（唯一需要命令式写 value 的地方）。 */
function syncInputDom(values: number[]) {
  inputRefs.value.forEach((input, index) => {
    if (input && values[index] !== undefined) input.value = formatInputValue(values[index]);
  });
}

function syncInputs(values: number[], syncDraft = true) {
  if (syncDraft) draft.value = [...values];
  syncInputDom(values);
  fieldErrors.value = Array.from({ length: HOUR_COUNT }, () => '');
  errorText.value = '';
  if (syncDraft) updateChartScale(values);
}

function arraysEqual(left: number[], right: number[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function applyDraftRainfall() {
  const normalized = draft.value.map((value) => normalize(Number(value)));
  if (arraysEqual(normalized, currentEngineData())) return;
  engine.value?.setRainfallData(normalized);
}

function queueLiveApply() {
  if (liveApplyTimer !== null) return;
  liveApplyTimer = window.setTimeout(() => {
    liveApplyTimer = null;
    applyDraftRainfall();
  }, 90);
}

function flushLiveApply(message = '') {
  if (liveApplyTimer !== null) {
    window.clearTimeout(liveApplyTimer);
    liveApplyTimer = null;
  }
  applyDraftRainfall();
  syncInputs(currentEngineData(), false);
  if (message) statusText.value = message;
}

function setDraftValue(hour: number, value: number, live = true) {
  const normalized = normalize(clamp(Number(value), 0, chartMax.value));
  draft.value = draft.value.map((current, index) => (index === hour ? normalized : current));
  selectedHour.value = hour;
  if (inputRefs.value[hour]) inputRefs.value[hour].value = formatInputValue(normalized);
  if (live) queueLiveApply();
}

// ── 指针交互 ─────────────────────────────────────────────────────────
function valueFromPointer(event: PointerEvent): number {
  const node = chartSvg.value;
  if (!node) return 0;
  const rect = node.getBoundingClientRect();
  const chartY = (event.clientY - rect.top) / Math.max(1, rect.height) * CHART.height;
  const ratio = (CHART.bottom - chartY) / PLOT_HEIGHT;
  return normalize(clamp(ratio, 0, 1) * chartMax.value);
}

function pointHourFromEvent(event: Event): number | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const point = target.closest('.rainfall-chart-point');
  if (!(point instanceof SVGElement)) return null;
  return Number(point.dataset.hour);
}

function onChartPointerDown(event: PointerEvent) {
  const hour = pointHourFromEvent(event);
  if (hour === null) return;
  event.preventDefault();
  draggingHour = hour;
  draggingPointerId = event.pointerId;
  chartSvg.value?.setPointerCapture(event.pointerId);
  setDraftValue(hour, valueFromPointer(event));
}

function onChartPointerMove(event: PointerEvent) {
  if (draggingHour === null || event.pointerId !== draggingPointerId) return;
  event.preventDefault();
  setDraftValue(draggingHour, valueFromPointer(event));
}

function finishChartDrag(event: PointerEvent) {
  if (draggingHour === null || event.pointerId !== draggingPointerId) return;
  const hour = draggingHour;
  draggingHour = null;
  draggingPointerId = null;
  flushLiveApply(t('savedValue', { time: hourLabel(hour), value: formatInputValue(draft.value[hour]) }));
}

function onChartFocusIn(event: FocusEvent) {
  const hour = pointHourFromEvent(event);
  if (hour === null) return;
  selectedHour.value = hour;
}

/** 键盘微调：方向键 0.1，Shift+方向键 1，Home 归零，End 顶到刻度上限。 */
function onChartKeydown(event: KeyboardEvent) {
  const hour = pointHourFromEvent(event);
  if (hour === null) return;
  const amount = event.shiftKey ? 1 : 0.1;
  let nextValue: number | null = null;
  if (event.key === 'ArrowUp') nextValue = draft.value[hour] + amount;
  if (event.key === 'ArrowDown') nextValue = draft.value[hour] - amount;
  if (event.key === 'Home') nextValue = 0;
  if (event.key === 'End') nextValue = chartMax.value;
  if (nextValue === null) return;
  event.preventDefault();
  setDraftValue(hour, nextValue, false);
  flushLiveApply(t('savedValue', { time: hourLabel(hour), value: formatInputValue(draft.value[hour]) }));
}

// ── 输入框 ───────────────────────────────────────────────────────────
function onInput(hour: number) {
  fieldErrors.value = fieldErrors.value.map((message, index) => (index === hour ? '' : message));
  errorText.value = '';
  statusText.value = '';

  const raw = inputRefs.value[hour]?.value ?? '';
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value) || value < 0) return;

  const next = normalize(value);
  draft.value = draft.value.map((current, index) => (index === hour ? next : current));
  if (next > chartMax.value) chartMax.value = niceCeiling(next * 1.2);
  selectedHour.value = hour;
  queueLiveApply();
}

function onInputChange(hour: number) {
  const raw = inputRefs.value[hour]?.value ?? '';
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value) || value < 0) return;
  draft.value = draft.value.map((current, index) => (index === hour ? normalize(value) : current));
  flushLiveApply(t('savedHour', { time: hourLabel(hour) }));
}

function validateInputs(): number[] | null {
  const values: number[] = [];
  const invalid: number[] = [];
  const nextErrors = Array.from({ length: HOUR_COUNT }, () => '');

  inputRefs.value.forEach((input, hour) => {
    const raw = input?.value.trim() ?? '';
    const value = Number(raw);
    const isInvalid = raw === '' || !Number.isFinite(value) || value < 0;
    if (isInvalid) {
      invalid.push(hour);
      nextErrors[hour] = raw === '' ? t('emptyRainfall') : t('invalidRainfall');
    } else {
      values.push(normalize(value));
    }
  });

  fieldErrors.value = nextErrors;

  if (invalid.length) {
    preciseOpen.value = true;
    errorText.value = t('invalidCount', { count: invalid.length });
    nextTick(() => inputRefs.value[invalid[0]]?.focus());
    return null;
  }

  errorText.value = '';
  return values;
}

// ── 面板动作 ─────────────────────────────────────────────────────────
function submit() {
  const values = validateInputs();
  if (!values) return;

  applying.value = true;
  statusText.value = t('applying');
  try {
    draft.value = [...values];
    engine.value?.setRainfallData(values);
    syncInputs(currentEngineData());
    statusText.value = t('applied', {
      count: HOUR_COUNT,
      maximum: formatTick(engine.value?.getRainfallMaximum() ?? 0)
    });
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : t('applyFailed');
    statusText.value = '';
  } finally {
    applying.value = false;
  }
}

function restoreDefaults() {
  if (liveApplyTimer !== null) {
    window.clearTimeout(liveApplyTimer);
    liveApplyTimer = null;
  }
  const defaults = engine.value ? [...engine.value.defaultRainfall] : [];
  draft.value = [...defaults];
  engine.value?.resetRainfallData();
  syncInputs(currentEngineData());
  statusText.value = t('restored');
}

function close() {
  emit('update:open', false);
}

function onPanelKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
  }
}

/** 点击面板与工具栏之外的区域自动收起（捕获阶段，与原实现一致）。 */
function onDocumentPointerDown(event: PointerEvent) {
  if (!props.open) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (panelRoot.value?.contains(target)) return;
  if (document.getElementById('rainfall-editor-toggle')?.contains(target)) return;
  close();
}

const panelRoot = ref<HTMLElement | null>(null);

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  // 与原实现一致的自动化标记（挂在画布容器上，供外部脚本识别编辑器已就绪）。
  const sceneRoot = document.getElementById('scene-root');
  if (sceneRoot) {
    sceneRoot.dataset.rainfallEditorReady = 'true';
    sceneRoot.dataset.rainfallEditorMode = 'live-draggable-line-chart';
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  if (liveApplyTimer !== null) window.clearTimeout(liveApplyTimer);
});

// 打开时同步引擎当前数据；关闭时把未落盘的实时改动收尾提交。
watch(() => props.open, (open) => {
  if (open) {
    syncInputs(currentEngineData());
    statusText.value = t('editorReady');
    nextTick(() => closeButton.value?.focus());
  } else {
    if (liveApplyTimer !== null) flushLiveApply();
    statusText.value = '';
  }
}, { immediate: true });

// 引擎是异步创建的：就绪后补一次同步。
watch(engine, (instance) => {
  if (instance && props.open) syncInputs(currentEngineData());
});
</script>

<template>
  <aside
    id="rainfall-editor"
    ref="panelRoot"
    class="rainfall-editor"
    :class="{ 'is-open': open }"
    :data-applying="String(applying)"
    role="dialog"
    aria-modal="false"
    :aria-hidden="!open"
    :inert="!open"
    aria-labelledby="rainfall-editor-title"
    aria-describedby="rainfall-editor-description"
    @keydown="onPanelKeydown"
  >
    <header class="rainfall-editor__header">
      <div>
        <p class="rainfall-editor__eyebrow">00:00–24:00</p>
        <h1 id="rainfall-editor-title">{{ t('editorTitle') }}</h1>
        <p id="rainfall-editor-description">{{ t('editorDescription') }}</p>
      </div>
      <button
        id="rainfall-editor-close"
        ref="closeButton"
        class="rainfall-editor__close"
        type="button"
        :aria-label="t('editorCloseAria')"
        :title="t('close')"
        @click="close"
      >
        ×
      </button>
    </header>

    <form id="rainfall-data-form" class="rainfall-data-form" novalidate @submit.prevent="submit">
      <div class="rainfall-editor__scroll">
        <div class="rainfall-editor__section-heading">
          <h2>{{ t('curveTitle') }}</h2>
          <span class="rainfall-live-badge">{{ t('liveSave') }}</span>
        </div>

        <section class="rainfall-chart-card" :aria-label="t('chartAria')">
          <div class="rainfall-chart-readout" aria-live="polite">
            <span id="rainfall-chart-time">{{ hourLabel(selectedHour) }}</span>
            <strong id="rainfall-chart-value">{{ formatInputValue(draft[selectedHour] ?? 0) }}</strong>
            <span>mm/h</span>
          </div>

          <svg
            id="rainfall-line-chart"
            ref="chartSvg"
            class="rainfall-line-chart"
            viewBox="0 0 720 280"
            role="group"
            :aria-label="t('chartSvgAria')"
            @pointerdown="onChartPointerDown"
            @pointermove="onChartPointerMove"
            @pointerup="finishChartDrag"
            @pointercancel="finishChartDrag"
            @focusin="onChartFocusIn"
            @keydown="onChartKeydown"
          >
            <defs>
              <linearGradient id="rainfall-chart-area-gradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#c2cbdb" stop-opacity="0.28" />
                <stop offset="100%" stop-color="#687a96" stop-opacity="0.015" />
              </linearGradient>
            </defs>

            <g aria-hidden="true">
              <line
                v-for="tick in horizontalTicks"
                :key="`h-${tick.y}`"
                class="rainfall-chart-grid-line"
                :x1="CHART.left"
                :x2="CHART.width - CHART.right"
                :y1="tick.y"
                :y2="tick.y"
              />
              <text
                v-for="tick in horizontalTicks"
                :key="`hl-${tick.y}`"
                class="rainfall-chart-grid-label"
                :x="CHART.left - 9"
                :y="tick.y + 6"
                text-anchor="end"
              >{{ tick.label }}</text>
              <line
                v-for="tick in verticalTicks"
                :key="`v-${tick.x}`"
                class="rainfall-chart-grid-line"
                :x1="tick.x"
                :x2="tick.x"
                :y1="CHART.top"
                :y2="CHART.bottom"
              />
            </g>

            <path class="rainfall-chart-area" :d="areaPath" />
            <polyline class="rainfall-chart-line" :points="linePoints" />

            <g>
              <g
                v-for="(point, hour) in pointPositions"
                :key="hour"
                class="rainfall-chart-point"
                :class="{ 'is-active': hour === selectedHour }"
                :data-hour="hour"
                tabindex="0"
                role="slider"
                aria-orientation="vertical"
                :aria-valuemin="0"
                :aria-valuemax="chartMax"
                :aria-valuenow="draft[hour]"
                :aria-valuetext="t('rainfallValueText', { value: formatInputValue(draft[hour] ?? 0) })"
                :aria-label="t('chartPointAria', { time: hourLabel(hour) })"
                :transform="`translate(${point.x} ${point.y})`"
              >
                <circle class="rainfall-chart-handle-halo" r="13" />
                <circle class="rainfall-chart-handle" r="4.2" />
                <circle class="rainfall-chart-hit" r="14" />
              </g>
            </g>
          </svg>

          <div class="rainfall-chart-hours" aria-hidden="true">
            <span>00</span><span>06</span><span>12</span><span>18</span><span>24</span>
          </div>
          <p class="rainfall-chart-hint">{{ t('chartHint') }}</p>
        </section>

        <details id="rainfall-precise-editor" class="rainfall-precise-editor" :open="preciseOpen">
          <summary>
            <span>{{ t('preciseTitle') }}</span>
            <span>{{ t('preciseUnit') }}</span>
          </summary>
          <div id="rainfall-input-grid" class="rainfall-input-grid" role="group" :aria-label="t('inputGridAria')">
            <label
              v-for="hour in HOUR_COUNT"
              :key="hour - 1"
              class="rainfall-hour-field"
              :for="`rainfall-hour-${hour - 1}`"
            >
              <span class="rainfall-hour-label">{{ hourLabel(hour - 1) }}</span>
              <span class="rainfall-input-shell">
                <input
                  :id="`rainfall-hour-${hour - 1}`"
                  :ref="(el) => { if (el) inputRefs[hour - 1] = el; }"
                  class="rainfall-hour-input"
                  type="number"
                  name="rainfall-hour"
                  :data-hour="hour - 1"
                  min="0"
                  step="0.1"
                  inputmode="decimal"
                  required
                  :aria-label="t('rainfallInputAria', { time: hourLabel(hour - 1) })"
                  :aria-invalid="fieldErrors[hour - 1] ? 'true' : undefined"
                  :aria-describedby="`rainfall-hour-${hour - 1}-error`"
                  @input="onInput(hour - 1)"
                  @change="onInputChange(hour - 1)"
                />
                <span class="rainfall-input-unit" aria-hidden="true">mm/h</span>
              </span>
              <span
                :id="`rainfall-hour-${hour - 1}-error`"
                class="rainfall-field-error"
                :hidden="!fieldErrors[hour - 1]"
              >{{ fieldErrors[hour - 1] }}</span>
            </label>
          </div>
        </details>

        <div class="rainfall-editor__feedback">
          <p
            id="rainfall-editor-errors"
            class="rainfall-editor__error"
            role="alert"
            aria-live="assertive"
            :hidden="!errorText"
          >{{ errorText }}</p>
          <output id="rainfall-editor-status" class="rainfall-editor__status" aria-live="polite">{{ statusText }}</output>
        </div>
      </div>

      <footer class="rainfall-editor__actions">
        <button
          id="rainfall-restore"
          class="rainfall-editor__button rainfall-editor__button--secondary"
          type="button"
          @click="restoreDefaults"
        >
          <span>{{ t('restoreDefault') }}</span>
        </button>
        <button
          id="rainfall-apply"
          class="rainfall-editor__button rainfall-editor__button--primary"
          type="submit"
          :disabled="applying"
        >
          <span>{{ t('applyPrecise') }}</span>
        </button>
      </footer>
    </form>
  </aside>
</template>
