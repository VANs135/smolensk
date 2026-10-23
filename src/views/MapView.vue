<script setup lang="ts">
import { computed, reactive, ref } from 'vue'

import { BaseButton, BasePanel, BaseTag } from '@/components/base'
import { MapCanvas } from '@/components/map'
import { mapConfig, mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { DEFAULT_MAP_LAYERS } from '@/render/map-render'
import { useUiStore } from '@/stores'

/**
 * 地图视图（C2 地图渲染与视口）
 *
 * 分工：本视图只管**界面状态**（图层开关、选中/悬停格）与**只读展示**，
 * 画布与视口交互在 `components/map/MapCanvas.vue`，几何在 `render/`。
 * 本视图不引引擎、不做任何规则计算——选中的格只显示数据层原样字段。
 */

const ui = useUiStore()

/** 图层开关（界面状态，交给画布组件只读消费） */
const layers = reactive({ ...DEFAULT_MAP_LAYERS })

/** 选中格 / 悬停格（均为界面状态） */
const selectedHex = ref<HexRef | null>(null)
const hoveredHex = ref<HexRef | null>(null)

/* ── 只读数据索引（避免每次渲染线性查找） ── */

const hexIndex = new Map<string, (typeof mapLayers.hexes)[number]>()
for (const hex of mapLayers.hexes) hexIndex.set(`${hex.col}.${hex.row}`, hex)

const hedgehogIndex = new Map<string, (typeof mapLayers.printedHedgehogs)[number]>()
for (const hog of mapLayers.printedHedgehogs) hedgehogIndex.set(`${hog.col}.${hog.row}`, hog)

function hexKey(hex: HexRef | null): string {
  return hex === null ? '' : `${hex.col}.${hex.row}`
}

/** 展示用格：优先显示选中格，没有则显示悬停格 */
const focusHex = computed(() => selectedHex.value ?? hoveredHex.value)

const focusHexData = computed(() => {
  const hex = focusHex.value
  return hex === null ? null : (hexIndex.get(hexKey(hex)) ?? null)
})

const focusHedgehog = computed(() => {
  const hex = focusHex.value
  return hex === null ? null : (hedgehogIndex.get(hexKey(hex)) ?? null)
})

/** 该格是否在入口字母表里（专规 1.1a 的入口标识，直接读 map-config） */
const focusEntryLetters = computed(() => {
  const hex = focusHex.value
  if (hex === null) return [] as string[]
  const key = hexKey(hex)
  return Object.entries(mapConfig.entryHexes ?? {})
    .filter(([, list]) => list.some((item) => `${item.col}.${item.row}` === key))
    .map(([letter]) => letter)
})

const layerOptions = [
  { key: 'image', label: '地图扫描图' },
  { key: 'grid', label: '六角网格' },
  { key: 'labels', label: '格号标注' },
  { key: 'edges', label: '河/路/铁' },
  { key: 'hedgehogs', label: '印刷工事' },
] as const

function onHexClick(hex: HexRef): void {
  selectedHex.value = hex
}

function onHexHover(hex: HexRef | null): void {
  hoveredHex.value = hex
}
</script>

<template>
  <div class="mapview">
    <div class="mapview__main">
      <div class="mapview__bar">
        <BaseTag kind="info">C2 地图渲染与视口</BaseTag>
        <BaseButton variant="ghost" size="sm" @click="ui.navigate('home')">返回开始台</BaseButton>
        <BaseButton variant="ghost" size="sm" @click="ui.navigate('workbench')"
          >骨架操作台（U0）</BaseButton
        >
      </div>

      <MapCanvas
        :layers="layers"
        :highlight-hex="selectedHex"
        @hex-click="onHexClick"
        @hex-hover="onHexHover"
      />
    </div>

    <div class="mapview__side">
      <BasePanel title="图层">
        <label v-for="option in layerOptions" :key="option.key" class="mapview__check">
          <input v-model="layers[option.key]" type="checkbox" />
          {{ option.label }}
        </label>
        <p class="mapview__note">
          扫描图为底，矢量图层按标定公式叠加；关闭扫描图后网格与格号即为唯一参照。
        </p>
      </BasePanel>

      <BasePanel title="格信息（只读数据）">
        <p v-if="focusHex === null" class="mapview__note">
          在地图上移入或单击一个六角格，这里显示 map-layers.json 中的原样字段。
        </p>
        <template v-else>
          <p class="num mapview__hex">
            {{ focusHex.col }}.{{ focusHex.row }}
            <BaseTag v-if="selectedHex !== null" kind="success">已选中</BaseTag>
            <BaseTag v-else kind="neutral">悬停</BaseTag>
          </p>
          <p v-if="focusHexData === null" class="mapview__note">该格不在图内格清单中。</p>
          <template v-else>
            <p class="mapview__note">地形：{{ focusHexData.terrainsPresent.join(' / ') }}</p>
            <p class="mapview__note">移动地形（最贵）：{{ focusHexData.movementTerrain }}</p>
            <p v-if="focusHexData.city !== undefined" class="mapview__note">
              城市：{{ focusHexData.city.name ?? '（无名）' }}
              <span v-if="focusHexData.city.level">· 等级 {{ focusHexData.city.level }}</span>
              <span v-if="focusHexData.city.role">· {{ focusHexData.city.role }}</span>
            </p>
            <p v-if="focusEntryLetters.length > 0" class="mapview__note">
              入口字母：{{ focusEntryLetters.join(' / ') }}
            </p>
            <p v-if="focusHexData.supplySource === true" class="mapview__note">苏军补给源格</p>
            <p v-if="focusHedgehog !== null" class="mapview__note">
              印刷永久工事：等级 {{ focusHedgehog.level }}（不可降低）
            </p>
          </template>
        </template>
      </BasePanel>

      <BasePanel title="图层数据量">
        <p class="mapview__note num">
          格 {{ mapLayers.hexes.length }} · 格边要素 {{ mapLayers.edges.length }} · 印刷工事
          {{ mapLayers.printedHedgehogs.length }}
        </p>
        <p class="mapview__note">
          整幅地图约 {{ Math.round(mapConfig.bounds.colEnd - mapConfig.bounds.colStart + 1) }} 列 ×
          {{ Math.round(mapConfig.bounds.rowEnd - mapConfig.bounds.rowStart + 1) }}
          行（四边削角，图内格以清单为准）。
        </p>
        <p class="mapview__note">
          视口裁剪：每帧只绘制落在视口（外扩一格半径）内的格、格边与工事，与缩放级别无关地保持流畅。
        </p>
      </BasePanel>
    </div>
  </div>
</template>

<style scoped>
.mapview {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: var(--space-4);
  align-items: start;
}

.mapview__main {
  min-width: 0;
}

.mapview__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.mapview__side {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.mapview__check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
  font-size: var(--text-sm);
  color: var(--color-ink);
}

.mapview__note {
  margin: var(--space-1) 0;
  color: var(--color-muted);
  font-size: var(--text-sm);
}

.mapview__hex {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 0 var(--space-2);
  font-size: var(--text-lg);
}
</style>
