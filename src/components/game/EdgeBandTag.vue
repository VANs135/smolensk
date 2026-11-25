<script setup lang="ts">
import { BaseButton } from '@/components/base'

/**
 * **1.4b 入盒带的费用小签**（2026-11-26 用户第 2 条）
 *
 * 点地图外侧那条带 ⇒ 弹这一枚小签，只给两种付款方式（§4.1b）：
 *   · `1 MP`（默认，teal 实底；入盒即停，剩余 MP 作废）
 *   · `1 铁路运力`（扣本回合 Rail Cap）
 *
 * 只写「格号 + 费用」：带本身不写字，小签也不写规则解释（解释在 `?` 里）。
 * 位置由上层给（`position: fixed`，与右键菜单同一层）。
 */
const props = defineProps<{
  /** 窗口坐标（fixed 定位的 left/top） */
  x: number
  y: number
  /** 该格那一枚算子的短名（空串则只写格号） */
  label: string
  /** `列.行` */
  hexText: string
}>()

const emit = defineEmits<{ choose: [useRailCap: boolean] }>()
</script>

<template>
  <div
    class="edgetag"
    role="dialog"
    aria-label="边缘盒入盒"
    :style="{ left: props.x + 'px', top: props.y + 'px' }"
  >
    <span class="edgetag__head num">
      <template v-if="props.label !== ''">{{ props.label }} · </template>{{ props.hexText }}
    </span>
    <BaseButton variant="primary" size="sm" @click="emit('choose', false)">1 MP</BaseButton>
    <BaseButton variant="secondary" size="sm" @click="emit('choose', true)">1 铁路运力</BaseButton>
  </div>
</template>

<style scoped>
.edgetag {
  position: fixed;
  z-index: var(--layer-map-popup);
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: 4px 6px;
  border: 1px solid var(--color-command-line);
  border-radius: var(--radius-sm);
  background: var(--color-command-panel);
  color: var(--color-command-ink);
  box-shadow: var(--shadow-lg);
}

.edgetag__head {
  font-size: var(--text-xs);
  white-space: nowrap;
}
</style>
