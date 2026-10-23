<script setup lang="ts">
import { computed } from 'vue'

import { BaseButton, BaseTag } from '@/components/base'
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

/** 当前生效的信息纪律（共识开关的结论：1.4 隐藏盒 / 4.9e 秘密掷骰 / 2.4 同步回合 / 4.1–4.3） */
const policy = computed(() => hotseat.policy)
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
          <h3 class="handoff__title">热坐交接</h3>
          <BaseTag kind="warning">2.2 / 4.9a</BaseTag>
        </header>

        <p class="handoff__to">{{ hotseat.handoffNotice }}</p>
        <p class="handoff__hint muted">
          交接期间盘面已遮罩：换手时请勿让对手看到己方堆叠明细（4.9a：玩家永远不能检查敌方堆叠；
          敌方格只会显示**最上方战斗单位 / 最上方激活飞机 /
          环形工事**，以及是否战略模式、DG、断补）。
        </p>

        <p class="handoff__policy num">
          <BaseTag kind="info">{{ policy.rule }}</BaseTag>
          {{ policy.detail }}
        </p>

        <div class="handoff__row">
          <BaseButton variant="primary" size="sm" @click="hotseat.confirmHandoff()">
            确认交接，显示盘面
          </BaseButton>
          <BaseButton variant="ghost" size="sm" @click="hotseat.cancelHandoff()">
            反悔（回到 {{ hotseat.opponentSide === 'axis' ? '轴心国' : '苏联' }}）
          </BaseButton>
        </div>
        <p class="muted">单人试算可在「局况与切方」面板关掉热坐交接（关掉后切方不再遮屏）。</p>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.handoff {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
}

.handoff__mask {
  position: absolute;
  inset: 0;
  /* 全不透明：交接期间**不显示盘面**（若只做半透明，堆叠明细仍会被对手看到） */
  background: var(--color-bg);
}

.handoff__panel {
  position: relative;
  width: min(560px, 92vw);
  padding: var(--space-4);
  background: var(--color-panel);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-md);
  box-shadow: 0 12px 40px rgb(0 0 0 / 35%);
}

.handoff__header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.handoff__title {
  margin: 0;
  font-size: var(--text-lg);
}

.handoff__to {
  margin: var(--space-2) 0;
  font-size: var(--text-lg);
  color: var(--color-ink);
  text-align: center;
}

.handoff__hint {
  line-height: 1.6;
}

.handoff__policy {
  margin: var(--space-2) 0;
}

.handoff__row {
  display: flex;
  gap: var(--space-2);
  margin: var(--space-3) 0 var(--space-1);
}

.muted {
  color: var(--color-muted);
  font-size: var(--text-sm);
}
</style>
