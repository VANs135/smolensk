<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { panelScansOf } from '@/render/charts-view'
import { counterImages } from '@/render/token-images'

import { panelScanImageUrl } from './aux-card-image'

/**
 * **表抽屉内容**（2026-11-25：表格从底部托盘搬进左栏）
 *
 * ## 口径
 *   · 入口：左栏一枚「表」图标 → 本抽屉（316，宽表才 498）；
 *   · 窗内**先选看哪张表**：顶排四枚 chip（CRT / 补给与补员 / TEC / 变量与事件）；
 *   · chip 下面**只画印卡扫描图**（官方卡面整张，不造 HTML 表、不带行列工具条）；
 *   · **无默认选中**：点开时四枚 chip 全描边、不预选任何一张，体只有 chip 一行；
 *   · chip 只写表名，不写「点击查看」这类句子。
 *
 * ## 与托盘的分工（2026-11-25 拍板）
 *   托盘只剩盒段（盒入口＝托盘卡头）；表格退出托盘，也不再是右侧「盒表」抽屉。
 *   投影表（`charts-view.ts` 的行 × 列）仍在引擎验证页保留核对，本抽屉不画那一面。
 */

/** 屏标识（同时只显示一屏；不预选 ⇒ 初值 null） */
type ScreenKey = 'crt' | 'supply' | 'tec' | 'vars'

/** 四屏的清单（顺序即 chip 的次序） */
const SCREENS: readonly { key: ScreenKey; label: string }[] = [
  { key: 'crt', label: 'CRT' },
  { key: 'supply', label: '补给与补员' },
  { key: 'tec', label: 'TEC' },
  { key: 'vars', label: '变量与事件' },
]

/** 当前选中的表（null = 还没选，抽屉只有 chip 一行） */
const screen = ref<ScreenKey | null>(null)

/** 当前屏的印卡扫描图（没选表 ⇒ 空数组） */
const scans = computed(() => (screen.value === null ? [] : panelScansOf(screen.value)))

/** 图档名 → URL（与盒卡面同一套编码；这里只做转交，不自己拼路径） */
function scanUrl(image: string): string {
  return panelScanImageUrl(image)
}

/**
 * 已读进来的图（URL 列表）
 *
 * 修前用 `counterImages.get()` 判就绪、未就绪就**不挂 `<img>`** ⇒ 图永远没人请求，
 * 四个屏全是「正在读图…」（2026-11-25 实机截到）。改成**始终挂 `<img>`**、由 `load`
 * 事件把 URL 记进这份响应式清单：图一到位，占位字立刻换成图。
 */
const readyUrls = ref<string[]>([])

function scanReady(image: string): boolean {
  return readyUrls.value.includes(scanUrl(image))
}

function markReady(url: string): void {
  if (!readyUrls.value.includes(url)) readyUrls.value = [...readyUrls.value, url]
}

/** 选中某张表时把图读进来（懒加载：没选不拉图） */
watch(screen, () => {
  if (screen.value === null) return
  void counterImages.preload(scans.value.map((scan) => scanUrl(scan.image)))
})
</script>

<template>
  <div class="charts" aria-label="表">
    <div class="charts__tabs" role="tablist">
      <button
        v-for="item in SCREENS"
        :key="item.key"
        type="button"
        role="tab"
        class="charts__tab"
        :class="{ 'charts__tab--on': screen === item.key }"
        :aria-selected="screen === item.key"
        @click="screen = item.key"
      >
        {{ item.label }}
      </button>
    </div>

    <p v-if="scans.length === 0" class="charts__blank" aria-hidden="true"></p>
    <div v-for="scan in scans" :key="scan.id" class="charts__scan">
      <a class="charts__link" :href="scanUrl(scan.image)" target="_blank" rel="noopener">
        <span v-if="!scanReady(scan.image)" class="charts__img charts__img--pending"
          >正在读图…</span
        >
        <img
          v-show="scanReady(scan.image)"
          class="charts__img"
          :src="scanUrl(scan.image)"
          :alt="scan.title"
          @load="markReady(scanUrl(scan.image))"
        />
      </a>
    </div>
  </div>
</template>

<style scoped>
.charts {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.charts__tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.charts__tab {
  padding: 2px var(--space-2);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
  color: var(--color-ink);
  font-size: var(--text-xs);
  cursor: pointer;
}

.charts__tab--on {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: var(--color-on-accent);
  font-weight: 700;
}

/* 没选表时不占高度：只留 chip 一行（口径：打开只有头 + chip） */
.charts__blank {
  margin: 0;
}

.charts__scan {
  margin: 0;
}

.charts__link {
  display: block;
  max-width: 100%;
}

.charts__img {
  max-width: 100%;
  height: auto;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
}

.charts__img--pending {
  display: block;
  padding: var(--space-3);
  color: var(--color-muted);
  font-size: var(--text-xs);
}
</style>
