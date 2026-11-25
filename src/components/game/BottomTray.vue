<script setup lang="ts">
import { computed, ref } from 'vue'

import { BaseIcon, BaseTag } from '@/components/base'
import { useRefereeTools } from '@/components/ui-mode'
import { isAndroidPlatform } from '@/shared/platform'
import { useContainersStore, useHotseatStore } from '@/stores'
import type { Side } from '@/data'

import { BoxCard } from './index'

/**
 * **盒托盘**（2026-11-25 第二版：只剩盒段，常驻地图窗口下方）
 *
 * ## 为什么不再装表格
 *   表格已搬到左栏「表」抽屉（`ChartTableDrawer.vue`：chip 选表 → 只画印卡）。
 *   托盘因此只剩一段，不再需要"两段同时只展开一段"的纪律。
 *
 * ## 入口
 *   盒入口＝**本托盘的头行（卡头）**：点一下展开盒卡，再点一下收起。
 *   卡头本身带「N 张卡 / M 枚在盒」的计数，折叠时也看得见有多少没归位。
 *
 * ## 阵营隔离
 *   只列**视角方**的卡（用户 2026-11-18）。solo（同一人操作双方，`fogDisabled`）
 *   与裁判/验证页没有"对手" ⇒ 两方都列；共用盒（`side === null`）单列，不受视角影响。
 */

const containers = useContainersStore()
const hotseat = useHotseatStore()
const showsReferee = useRefereeTools()

/** 展开状态（默认折叠成一行；安卓保留旧口径：默认展开盒段，顶栏盒标记才能直接弹卡） */
const open = ref<boolean>(isAndroidPlatform())

function toggle(): void {
  open.value = !open.value
}

const showsAllSides = computed<boolean>(() => hotseat.fogDisabled || showsReferee)
const sideCards = computed<{ side: Side; cards: ReturnType<typeof containers.cardViewsOf> }[]>(
  () =>
    showsAllSides.value
      ? (['axis', 'soviet'] as const).map((side) => ({ side, cards: containers.cardViewsOf(side) }))
      : [{ side: hotseat.viewerSide, cards: containers.cardViewsOf(hotseat.viewerSide) }],
)

/** 盒段里还有多少枚没归位（玩家态只盘点**视角方** + 共用，不能借角标泄露对方数量） */
const boxUnitTotal = computed(() =>
  [...sideCards.value.flatMap((group) => group.cards), ...containers.sharedCardViews].reduce(
    (total, card) => total + card.regions.reduce((sum, region) => sum + region.units.length, 0),
    0,
  ),
)

/** 盒卡张数（卡头计数） */
const boxCardTotal = computed(() => sideCards.value.reduce((n, g) => n + g.cards.length, 0))
</script>

<template>
  <section class="tray" :class="{ 'tray--open': open }" aria-label="盒">
    <button type="button" class="tray__head" :aria-expanded="open" @click="toggle()">
      <span class="tray__caret">
        <BaseIcon :name="open ? 'chevron-down' : 'chevron-right'" />
      </span>
      <!-- 2026-11-26（用户）：去掉「盒」这个单字标题，卡头只留角标 + 计数 -->
      <BaseTag kind="neutral">{{ boxCardTotal === 0 ? '—' : `${boxCardTotal} 张卡` }}</BaseTag>
      <span class="tray__meta num">{{ boxUnitTotal }} 枚在盒</span>
    </button>

    <div v-if="open" class="tray__body">
      <div v-for="group in sideCards" :key="group.side" class="tray__col">
        <p class="tray__col-head num">{{ group.side === 'axis' ? '轴心国' : '苏联' }}</p>
        <BoxCard v-for="card in group.cards" :key="card.id" :card="card" />
      </div>
      <!-- 双方共用的卡（运力记录轨：一张卡上两组轨，标记按当前容量推格） -->
      <div v-if="containers.sharedCardViews.length > 0" class="tray__col">
        <p class="tray__col-head num">共用</p>
        <BoxCard v-for="card in containers.sharedCardViews" :key="card.id" :card="card" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.tray {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  background: var(--color-panel);
}

.tray--open {
  max-height: 44vh;
  overflow: auto;
}

.tray__head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  border: none;
  background: var(--color-bg-2);
  color: var(--color-ink);
  cursor: pointer;
  text-align: left;
  font-size: var(--text-sm);
}

.tray__meta {
  color: var(--color-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tray__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
}

.tray__col {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.tray__col-head {
  margin: 0;
  color: var(--color-muted);
}
</style>
