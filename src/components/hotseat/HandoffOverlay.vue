<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

import { BaseButton } from '@/components/base'
import { useHotseatStore } from '@/stores'

/**
 * 热坐交接屏（W7 C13）
 *
 * ## 它是什么
 *   双人同机（hot-seat）轮流操作时，「交接」会**切到对手方**并亮起这块全屏遮罩：
 *   在接手方点「确认交接」之前**盘面完全不可见** —— 因为 4.9a 要求「玩家永远不能检查敌方堆叠」，
 *   贴在一起换手时若不遮屏，上一位玩家的部队明细就全被下一位看见了。
 *
 * ## 依据与边界
 *   - 规则书里**没有** hot-seat 条文（通则与专规均已核实「未找到」）⇒ 本屏是**设备交接的礼仪**，
 *     不是规则要求；因此它可被关掉（`hotseat.setHotseatEnabled(false)`，单人试算时用）。
 *   - 与遮罩无关的**规则级**可见性由 `engine/rules/fog.ts` 承担（敌方格只见最上方单位）。
 *   - 遮罩**不可点关**：只有「确认交接」（接手方就位）或「反悔」（回到原方）才消失。
 *
 * 分层纪律：本组件只画字与收点击，观察方与纪律全部取自 store。
 */

const hotseat = useHotseatStore()

const heading = ref<HTMLElement | null>(null)
watch(
  () => hotseat.handoffPending,
  async (pending) => {
    if (!pending) return
    await nextTick()
    heading.value?.focus()
  },
  { immediate: true },
)
</script>

<template>
  <Teleport to="body">
    <div
      v-if="hotseat.handoffPending"
      class="handoff"
      role="dialog"
      aria-modal="true"
      aria-label="热坐交接"
    >
      <!-- 遮罩只是视觉隔离：点它不会关屏（须显式确认或反悔） -->
      <div class="handoff__mask" />
      <div class="handoff__panel">
        <header class="handoff__header">
          <span>换手</span>
          <span class="num">4.9a</span>
        </header>

        <h2 ref="heading" class="handoff__to" tabindex="-1">
          {{ hotseat.viewerSide === 'axis' ? '轴心国' : '苏联' }}接手
        </h2>
        <p class="handoff__hint">{{ hotseat.handoffNotice }}</p>

        <div class="handoff__row">
          <BaseButton variant="primary" size="sm" @click="hotseat.confirmHandoff()">
            显示盘面
          </BaseButton>
          <BaseButton variant="ghost" size="sm" @click="hotseat.cancelHandoff()"> 返回 </BaseButton>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.handoff {
  position: fixed;
  inset: 0;
  z-index: var(--z-panel);
  display: flex;
  align-items: center;
  justify-content: center;
}

.handoff__mask {
  position: absolute;
  inset: 0;
  /* 全不透明：交接期间**不显示盘面**（若只做半透明，堆叠明细仍会被对手看到） */
  background: var(--color-command-bg);
}

.handoff__panel {
  position: relative;
  width: min(560px, 92vw);
  --color-bg-2: var(--color-command-raised);
  --color-ink: var(--color-command-ink);
  --color-accent-2: var(--color-command-teal-bg);
  padding: var(--space-6);
  background: var(--color-command-panel);
  border: 1px solid var(--color-command-line);
  border-top: 3px solid var(--color-command-teal);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
}

.handoff__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-5);
  color: var(--color-command-teal);
  font-size: var(--text-sm);
}

.handoff__to {
  margin: var(--space-2) 0;
  font-size: var(--text-xl);
  color: var(--color-ink);
  text-align: center;
}

.handoff__hint {
  color: var(--color-command-muted);
  font-size: var(--text-sm);
  text-align: center;
}

.handoff__row {
  display: flex;
  justify-content: center;
  gap: var(--space-2);
  margin: var(--space-3) 0 var(--space-1);
}

.muted {
  color: var(--color-muted);
  font-size: var(--text-sm);
}
</style>
