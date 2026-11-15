<script setup lang="ts">
import { BaseButton, BaseTag } from '@/components/base'
import { useWorkbenchStore } from '@/stores'

/**
 * 4.8a：**超堆叠结算**（任何环节/阶段末）
 *
 * 用户口径（2026-11-14）：「超 10 RE 的格必须由拥有者选择摧毁哪些单位直到回到上限，
 *   选完才能推进到下一环节；摧毁清单只列该格可摧毁的本方单位，不够选就不能过关，
 *   不要给『忽略』这类旁路。」
 *
 * 判据与规则号全部来自 store（`overstackDuties` 的 `detail` / `rule` 又是引擎
 * `stackingObligations()` 给的）；本组件只画清单、转发勾选与提交，不自己判堆叠。
 * 没有「稍后 / 忽略」按钮：未回到上限时「摧毁所选」不出现，流程条的推进也继续被拦。
 */

const workbench = useWorkbenchStore()

function sideName(side: 'axis' | 'soviet'): string {
  return side === 'axis' ? '轴心国' : '苏联'
}

function isPicked(key: string, instanceId: string): boolean {
  return (workbench.overstackPicks[key] ?? []).includes(instanceId)
}

function onToggle(key: string, instanceId: string): void {
  workbench.toggleOverstackPick(key, instanceId)
}

function onSubmit(): void {
  workbench.destroyOverstackPicksNow()
}
</script>

<template>
  <section
    v-if="workbench.overstackDuties.length > 0"
    class="overstack"
    aria-label="超堆叠结算"
    @pointerdown.stop
    @click.stop
    @wheel.stop
  >
    <header class="overstack__head">
      <h3 title="4.8a">超堆叠结算</h3>
    </header>

    <div v-for="duty in workbench.overstackDuties" :key="duty.key" class="overstack__duty">
      <p class="overstack__line">
        <strong class="num">{{ duty.key }}</strong>
        <BaseTag kind="neutral">{{ sideName(duty.side) }}</BaseTag>
        <span class="num">{{ duty.combatRe }} RE</span>
      </p>
      <label v-for="unit in duty.units" :key="unit.instanceId" class="overstack__unit">
        <input
          type="checkbox"
          :checked="isPicked(duty.key, unit.instanceId)"
          @change="onToggle(duty.key, unit.instanceId)"
        />
        <span class="overstack__unit-name">{{ unit.name }}</span>
        <span class="num">{{ unit.re }} RE</span>
      </label>
      <p class="overstack__remain num">
        勾选后剩余 {{ workbench.overstackRemainingRe[duty.key] ?? duty.combatRe }} RE
      </p>
    </div>

    <footer class="overstack__foot">
      <BaseButton v-if="workbench.overstackSettled" variant="primary" size="sm" @click="onSubmit">
        摧毁所选并回到上限
      </BaseButton>
    </footer>
  </section>
</template>

<style scoped>
.overstack {
  position: absolute;
  left: var(--space-3);
  bottom: var(--space-3);
  z-index: var(--layer-map-popup);
  width: min(360px, calc(100% - 2 * var(--space-3)));
  max-height: calc(100% - 2 * var(--space-3));
  overflow: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--color-rule);
  border-top: 3px solid var(--color-danger);
  border-radius: var(--radius-lg);
  background: var(--color-panel);
  color: var(--color-ink);
  box-shadow: var(--shadow-lg);
  font-size: var(--text-sm);
  line-height: 1.35;
  color-scheme: dark;
}

.overstack__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-rule);
}

.overstack__head h3 {
  margin: 0;
  font-size: var(--text-lg);
}

.overstack__duty {
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-rule);
}

.overstack__line,
.overstack__unit,
.overstack__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.overstack__line {
  margin: 0 0 var(--space-1);
}

.overstack__unit {
  padding: 2px 0;
  cursor: pointer;
}

.overstack__unit-name {
  flex: 1;
  min-width: 0;
}

.overstack__remain {
  margin: var(--space-1) 0 0;
  color: var(--color-muted);
}

.overstack__foot {
  padding: var(--space-2) var(--space-3);
}
</style>
