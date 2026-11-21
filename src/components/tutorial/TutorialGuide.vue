<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import type { HexRef } from '@/data'
import { useTutorialStore } from '@/stores'

/**
 * Vitebsk 教学模式的**指针层**（用户 2026-11-18 第 2 条）
 *
 * 只做两件事：
 *   1. 把当前步的落点画成一个环（格子/算子用地图坐标，按钮/盒/面板用 DOM 位置）；
 *   2. 浮一张短卡（step n/N + 标题 + 一行提示），不挡盘面、不接管点击。
 *
 * 指向目标由 `stores/tutorial.ts` 给出；本组件不判断“做完没有”，只看 `currentStep`。
 */
const props = defineProps<{
  /** 地图格 → 窗口坐标（由对局台的地图桥提供；没有时不画格子环） */
  hexToWindow?: (hex: HexRef) => { x: number; y: number } | null
}>()

const tutorial = useTutorialStore()

interface Ring {
  left: number
  top: number
  width: number
  height: number
  radius: number
}

const ring = ref<Ring | null>(null)

/** 候选的可点/可读元素；先用文字定位，找不到再退回地图格 */
const CANDIDATES = [
  'button',
  '[role="button"]',
  '.tray__head',
  '.tray__tab',
  '.queue__card',
  '.picker__title',
  '.box-card',
  '[class*="box-card__head"]',
  '[class*="arrival"]',
  '.face__action',
  '.picker__cell',
  '.base-roster__plane',
  '.boxmenu__item',
  'label',
  'input',
].join(',')

/** 按钮级候选（用户 2026-11-19 第 1 条：引导要直接框住该点的按钮） */
const BUTTONS = [
  'button',
  '[role="button"]',
  '.face__action',
  '.boxmenu__item',
  '.picker__cell',
  '.base-roster__plane',
  'label',
].join(',')

function compact(text: string): string {
  return text.replace(/\s+/gu, '')
}

function visible(rect: DOMRect): boolean {
  if (rect.width < 4 || rect.height < 4) return false
  if (rect.bottom <= 0 || rect.right <= 0) return false
  if (rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false
  return true
}

function findText(texts: readonly string[], selector = CANDIDATES): HTMLElement | null {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector))
  for (const text of texts) {
    const needle = compact(text)
    let best: { node: HTMLElement; area: number } | null = null
    for (const node of nodes) {
      if (node.closest('.tut') !== null) continue
      const content = compact(node.textContent ?? '')
      const title = node.getAttribute('title') ?? ''
      const aria = node.getAttribute('aria-label') ?? ''
      const hit = content.includes(needle) || title.includes(text) || aria.includes(text)
      if (!hit) continue
      const rect = node.getBoundingClientRect()
      if (!visible(rect)) continue
      const area = rect.width * rect.height
      if (best === null || area < best.area) best = { node, area }
    }
    if (best !== null) {
      // 面板标题（.picker__title）指整块；其余指控件本身
      return best.node.classList.contains('picker__title')
        ? ((best.node.closest('.picker') as HTMLElement | null) ?? best.node)
        : best.node
    }
  }
  return null
}

function ringFrom(node: HTMLElement): void {
  const rect = node.getBoundingClientRect()
  const pad = 5
  ring.value = {
    left: rect.left - pad,
    top: rect.top - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
    radius: 10,
  }
}

function refresh(): void {
  const step = tutorial.currentStep
  if (!tutorial.active || step === null) {
    ring.value = null
    return
  }

  // ⓪ 逐枚飞机：任务选机面板里同名机有两枚，只能按实例 id 框住该点的那一枚
  if (step.target.airInstanceId !== undefined) {
    const node = Array.from(document.querySelectorAll<HTMLElement>('[data-air-instance-id]')).find(
      (item) => item.dataset.airInstanceId === step.target.airInstanceId,
    )
    if (node !== null && node !== undefined && visible(node.getBoundingClientRect())) {
      ringFrom(node)
      return
    }
  }

  // ① 按钮级目标优先：直接框住该点的按钮（整备 / 发起任务 / 拦截复选框…）
  const buttonTexts = step.target.buttonTexts ?? []
  if (buttonTexts.length > 0) {
    const node = findText(buttonTexts, BUTTONS)
    if (node !== null) {
      ringFrom(node)
      return
    }
  }

  const texts = step.target.texts ?? []
  if (texts.length > 0) {
    const node = findText(texts)
    if (node !== null) {
      ringFrom(node)
      return
    }
  }

  if (step.target.hex !== undefined && props.hexToWindow !== undefined) {
    const point = props.hexToWindow(step.target.hex)
    if (point !== null) {
      const size = 62
      ring.value = {
        left: point.x - size / 2,
        top: point.y - size / 2,
        width: size,
        height: size,
        radius: 999,
      }
      return
    }
  }

  ring.value = null
}

let timer: number | undefined

onMounted(() => {
  timer = window.setInterval(refresh, 180)
  window.addEventListener('resize', refresh)
  document.addEventListener('scroll', refresh, true)
  refresh()
})

onUnmounted(() => {
  if (timer !== undefined) window.clearInterval(timer)
  window.removeEventListener('resize', refresh)
  document.removeEventListener('scroll', refresh, true)
})

watch(
  () => `${tutorial.active}|${tutorial.currentStep?.id ?? ''}`,
  () => refresh(),
)
</script>

<template>
  <div v-if="tutorial.active" class="tut" aria-live="polite">
    <div
      v-if="ring !== null"
      class="tut__ring"
      :style="{
        left: `${String(ring.left)}px`,
        top: `${String(ring.top)}px`,
        width: `${String(ring.width)}px`,
        height: `${String(ring.height)}px`,
        borderRadius: `${String(ring.radius)}px`,
      }"
    />

    <aside v-if="tutorial.currentStep !== null" class="tut__card">
      <header class="tut__head">
        <span class="tut__num num">{{ tutorial.progressLabel }}</span>
        <strong class="tut__title">{{ tutorial.currentStep.title }}</strong>
        <button type="button" class="tut__close" aria-label="退出教学" @click="tutorial.stop()">
          ×
        </button>
      </header>
      <p v-if="tutorial.currentStep.intro !== undefined" class="tut__intro">
        {{ tutorial.currentStep.intro }}
      </p>
      <p class="tut__hint">{{ tutorial.currentStep.hint }}</p>
      <!-- 2026-11-21：后三步不再由阶段推进自动放行，玩家确实不做时必须能显式跳过，否则引导会卡住 -->
      <button type="button" class="tut__skip" @click="tutorial.skipCurrent()">跳过这一步</button>
    </aside>

    <aside v-else-if="tutorial.completed" class="tut__card tut__card--done">
      <strong class="tut__title">教学完成</strong>
      <p v-if="tutorial.reactionOutcome !== null" class="tut__intro">
        苏军反击战果 {{ tutorial.reactionOutcome }}：攻方损失，进攻失败。
      </p>
      <p v-else class="tut__intro">苏军由 AI 指挥；本回合教学结束，后续按 2.2 流程继续。</p>
      <button type="button" class="tut__close" aria-label="关闭教学" @click="tutorial.stop()">
        关闭
      </button>
    </aside>
  </div>
</template>

<style scoped>
.tut {
  position: fixed;
  inset: 0;
  z-index: calc(var(--layer-modal) + 2);
  pointer-events: none;
}

.tut__ring {
  position: fixed;
  border: 2px solid var(--color-gold);
  box-shadow:
    0 0 0 4px color-mix(in srgb, var(--color-gold) 26%, transparent),
    0 0 18px color-mix(in srgb, var(--color-gold) 45%, transparent);
  pointer-events: none;
  animation: tut-pulse 1.5s ease-in-out infinite;
}

@keyframes tut-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}

.tut__card {
  position: fixed;
  left: 12px;
  bottom: 108px;
  width: min(320px, calc(100vw - 24px));
  padding: 8px 10px 9px;
  color: var(--color-ink);
  background: var(--color-panel);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  box-shadow: 0 6px 20px rgb(32 30 26 / 18%);
  pointer-events: auto;
  font-size: var(--text-sm);
  line-height: 1.45;
}

.tut__head {
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.tut__num {
  flex: none;
  padding: 0 6px;
  color: var(--color-on-accent);
  background: var(--color-accent);
  border-radius: 999px;
  font-size: var(--text-xs);
}

.tut__title {
  flex: 1;
  font-size: var(--text-sm);
}

.tut__close {
  flex: none;
  padding: 0 4px;
  color: var(--color-muted);
  background: none;
  border: 0;
  font-size: var(--text-base-size);
  line-height: 1;
  cursor: pointer;
}

.tut__hint {
  margin: 5px 0 0;
  color: var(--color-muted);
}

.tut__intro {
  margin: 4px 0 0;
  color: var(--color-ink);
  font-size: var(--text-xs);
  opacity: 0.8;
}

.tut__card--done {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
}
</style>
