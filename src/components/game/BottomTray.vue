<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { BaseTag } from '@/components/base'
import { chartSources, panelScansOf } from '@/render/charts-view'
import { counterImages } from '@/render/token-images'
import { useContainersStore } from '@/stores'

import { panelScanImageUrl } from './aux-card-image'
import { BoxCard } from './index'

/**
 * **底部托盘**（B12 建托盘，B16 接真表格，B22 接印卡扫描图，**B35 只留卡图**；用户口径⑧①②）
 *
 * ## 用户口径
 *   「盒与表格都和其中一场参考图一样显示在**地图窗口下方**，方便提醒玩家，但**每个也可以折叠**」；
 *   ④「盒也是折叠打开（**同时只展开一张**）」；②「**平时不用的表格默认折叠**」；
 *   2026-09-16 追加：「**盒还有表格可以直接用素材库里辅助卡图片**」；
 *   **同日追加（B35）**：「**辅助卡只放卡图（不要数据表那一面）**」。
 *
 * ## 两段
 *   · **左「盒」**：辅助卡卡面（死人堆 / 地图外盒 / 空军盒 —— 见 `BoxCard.vue`，本来就是印卡图）；
 *   · **右「表格」**：**四屏**（CRT / 补给与补员 / TEC / 变量与事件），每屏**只画印卡原卡**
 *     （B22：版式、图例、脚注都是原卡的一部分）。
 *
 *   ★ 原先每屏还有第二面「**数据表**」（`render/charts-view.ts` 的行 × 列投影）——
 *     B35 按用户口径把它**从托盘移除**，挪到**引擎验证页**（`WorkbenchView`）保留可核对；
 *     投影表本身因此仍有调用点（架构门禁的零调用检查也照不到它）。
 *
 * ## 折叠纪律
 *   两段**默认都折叠为一行**，且**同时只展开一段**（否则地图会被挤掉）。
 */

const containers = useContainersStore()

/** 展开的那一段（null = 两段都折叠成一行） */
const openSection = ref<'boxes' | 'tables' | null>(null)

function toggle(section: 'boxes' | 'tables'): void {
  openSection.value = openSection.value === section ? null : section
}

/** 盒段：本剧本两方的卡（轴心 / 苏联） */
const axisCards = computed(() => containers.cardViewsOf('axis'))
const sovietCards = computed(() => containers.cardViewsOf('soviet'))

/** 盒段里还有多少枚没归位（卡头角标之和——沿用两侧的盘点口径） */
const boxUnitTotal = computed(() =>
  containers.cardViews.reduce(
    (total, card) => total + card.regions.reduce((sum, region) => sum + region.units.length, 0),
    0,
  ),
)

/* ── 表格段（B16 建屏 / B22 接印卡图 / **B35：只留卡图**） ── */

/**
 * 屏标识（同时只显示一屏）
 *
 * ★ B35（用户口径 2026-09-16 #11「辅助卡只放卡图」）：托盘**不再有**"引擎投影表"那一面
 * —— 投影表挪到**引擎验证页**（`WorkbenchView` 的「引擎投影表」段）核对；原 `turn` 屏
 * （天气/回合与铁路海运容量）随投影表一起撤，`arrivals`（到货）屏归**增援窗**。
 */
type ScreenKey = 'crt' | 'supply' | 'tec' | 'vars'

/** 四屏的清单（顺序即切换条的次序） */
const SCREENS: readonly { key: ScreenKey; label: string }[] = [
  { key: 'crt', label: 'CRT' },
  { key: 'supply', label: '补给与补员' },
  { key: 'tec', label: 'TEC' },
  { key: 'vars', label: '变量与事件' },
]

const screen = ref<ScreenKey>('crt')

/** 当前屏的印卡扫描图（只画原卡；表的那一面在验证页） */
const scans = computed(() => panelScansOf(screen.value))

/** 图档名 → URL（与盒卡面同一套编码；这里只做转交，不自己拼路径） */
function scanUrl(image: string): string {
  return panelScanImageUrl(image)
}

/** 图是否已读进来（未就绪先画占位，避免一闪而过的破图） */
function scanReady(image: string): boolean {
  return counterImages.get(panelScanImageUrl(image)) !== null
}

/** 展开表格段时把当前屏的图读进来（懒加载：折叠着不拉图） */
watch([openSection, screen], () => {
  if (openSection.value !== 'tables') return
  void counterImages.preload(scans.value.map((scan) => scanUrl(scan.image)))
})

/** 表格数据文件的版本（放在折叠头上，便于确认看的是哪一版） */
const sources = chartSources()
</script>

<template>
  <section class="tray" aria-label="底部托盘（盒 / 表格）">
    <!-- 左：盒 -->
    <div class="tray__section" :class="{ 'tray__section--open': openSection === 'boxes' }">
      <button type="button" class="tray__head" @click="toggle('boxes')">
        <span class="tray__caret">{{ openSection === 'boxes' ? '▾' : '▸' }}</span>
        <span class="tray__title">盒</span>
        <BaseTag kind="neutral">{{ axisCards.length + sovietCards.length }} 张卡</BaseTag>
        <span class="tray__meta num">{{ boxUnitTotal }} 枚在盒</span>
      </button>

      <div v-if="openSection === 'boxes'" class="tray__body">
        <div v-for="side in ['axis', 'soviet'] as const" :key="side" class="tray__col">
          <p class="tray__col-head num">{{ side === 'axis' ? '轴心国' : '苏联' }}</p>
          <BoxCard v-for="card in containers.cardViewsOf(side)" :key="card.id" :card="card" />
        </div>
        <!-- B31c：**双方共用**的卡（运力记录轨：一张卡上两组轨，标记按当前容量推格） -->
        <div v-if="containers.sharedCardViews.length > 0" class="tray__col">
          <p class="tray__col-head num">共用</p>
          <BoxCard v-for="card in containers.sharedCardViews" :key="card.id" :card="card" />
        </div>
      </div>
    </div>

    <!-- 右：表格（B16：五屏，逐屏切换） -->
    <div class="tray__section" :class="{ 'tray__section--open': openSection === 'tables' }">
      <button type="button" class="tray__head" @click="toggle('tables')">
        <span class="tray__caret">{{ openSection === 'tables' ? '▾' : '▸' }}</span>
        <span class="tray__title">表格</span>
        <span class="tray__meta num">{{ SCREENS.map((item) => item.label).join(' · ') }}</span>
        <span class="tray__meta num">数据 v{{ sources[0]?.version ?? '—' }}</span>
      </button>

      <div v-if="openSection === 'tables'" class="tray__body tray__body--tables">
        <!-- 屏切换（同时只显示一屏；屏内滚动） -->
        <div class="tray__tabs">
          <button
            v-for="item in SCREENS"
            :key="item.key"
            type="button"
            class="tray__tab"
            :class="{ 'tray__tab--on': screen === item.key }"
            @click="screen = item.key"
          >
            {{ item.label }}
          </button>
        </div>

        <!-- 印卡图：直接画素材库的官方卡面（点图在新标签打开原尺寸）——B35：托盘**只留卡图** -->
        <p v-if="scans.length === 0" class="tray__note">
          这一屏还没有对应的印卡扫描图（图档清单见 `panel-scans.json`）。
        </p>
        <div v-for="scan in scans" :key="scan.id" class="tray__scan">
          <p class="tray__scan-title">
            {{ scan.title }}
            <span class="tray__note num">{{ scan.imageSize.w }}×{{ scan.imageSize.h }}</span>
          </p>
          <p v-if="scan.note !== undefined" class="tray__note">{{ scan.note }}</p>
          <a class="tray__scan-link" :href="scanUrl(scan.image)" target="_blank" rel="noopener">
            <img
              v-if="scanReady(scan.image)"
              class="tray__scan-img"
              :src="scanUrl(scan.image)"
              :alt="scan.title"
            />
            <span v-else class="tray__scan-img tray__scan-img--pending">正在读图…</span>
          </a>
          <p class="tray__note num">图档：{{ scan.image }}</p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.tray {
  display: flex;
  gap: var(--space-2);
  /* 地图窗口下方（用户口径⑧）；两段各自可折叠，默认都只有一行高 */
  align-items: flex-start;
}

.tray__section {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-md);
  background: var(--color-panel);
  overflow: hidden;
}

.tray__section--open {
  box-shadow: var(--shadow-sm);
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

.tray__title {
  font-family: var(--font-head);
  font-weight: 700;
  letter-spacing: 0.02em;
}

.tray__meta {
  color: var(--color-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tray__body {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2);
  max-height: 40vh;
  overflow: auto;
}

.tray__body--tables {
  flex-direction: column;
}

.tray__col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.tray__col-head {
  margin: 0;
  color: var(--color-muted);
}

.tray__note {
  margin: 0;
  color: var(--color-muted);
  font-size: var(--text-sm);
}

/* ── B16：表格屏 ── */

.tray__tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.tray__tab {
  padding: 2px var(--space-2);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
  color: var(--color-ink);
  font-size: var(--text-xs);
  cursor: pointer;
}

.tray__tab--on {
  border-color: var(--color-gold);
  color: var(--color-gold);
}

/* ── B22：印卡扫描图 ── */

.tray__scan-title {
  margin: 0 0 var(--space-1);
  color: var(--color-gold);
  font-size: var(--text-xs);
  letter-spacing: 0.02em;
}

.tray__scan {
  margin-bottom: var(--space-2);
}

.tray__scan-link {
  display: block;
  max-width: 100%;
}

.tray__scan-img {
  max-width: 100%;
  height: auto;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
}

.tray__scan-img--pending {
  display: block;
  padding: var(--space-3);
  color: var(--color-muted);
  font-size: var(--text-xs);
}
</style>
