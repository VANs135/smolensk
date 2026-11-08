<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { counterImages } from '@/render/token-images'
import type { AuxCardView } from '@/stores'

import { auxCardImageUrl } from './aux-card-image'

/**
 * **盒卡卡面**（B35 切片 C-2 从 `BoxCard.vue` 抽出）
 *
 * 只画被给的东西：**卡面图 + 标定好的分区矩形 + 每格里的算子贴图**（卡面像素 × 显示比例）。
 * 抽出来的原因：托盘里（320px）与**浮窗**里（更宽）要看**同一张卡** ⇒ 一份渲染、两处使用，
 * 免得"托盘里改了、浮窗里没跟上"。
 *
 * 分层纪律：不算坐标（换算只是"卡面像素 × 比例"）、不判规则、不管展开与浮窗开关（那在 BoxCard）。
 */
const props = defineProps<{
  card: AuxCardView
  /** 显示宽度（像素）；比例由它除以卡面原始宽度得出 */
  width: number
}>()

/** ⑤：盒内算子被点选（第二次点同一枚 = 取消）；没有规则含义，只是"我指的是这一枚" */
const pickedUnitId = ref<string | null>(null)

const emit = defineEmits<{ unitContext: [unitId: string] }>()

/** 卡面显示比例（分区矩形 × 这个比例 = 屏上像素） */
const scale = computed(() => props.width / props.card.imageSize.w)
const displayHeight = computed(() => props.card.imageSize.h * scale.value)

/**
 * 批 D 切片 1（方案 §3 批 D 步骤 2，用户口径 #12）：**算子贴图放大到 32–40px**
 *
 * 按**显示宽度**分档：托盘里 320px 宽 ⇒ 32px；浮窗（`BoxCard` 的弹出视图）更宽 ⇒ 40px。
 * 修前一律固定 18px —— 在同一张卡面上小到看不清印值，与"盒里的算子要显示贴图"的口径不符。
 */
const unitSizePx = computed<number>(() => (props.width >= 420 ? 40 : 32))

/** 卡面图 URL（图档名含空格与大写 ⇒ 编码后取；与 `token-images` 同一套做法） */
const imageUrl = computed(() => auxCardImageUrl(props.card.image))

/**
 * ⑤（用户 2026-11-09）：**盒内算子的图也要读进来** —— 修前只预载了卡面图，
 * 于是每枚算子都命中 `counterImages.get(url) === null`，画成空占位（"盒里是空框"）。
 *
 * `counterImages` 是普通 Map（非响应式）⇒ 加载完要把 `imagesTick` 加一，模板才会重算。
 */
const imagesTick = ref(0)

const unitUrls = computed<string[]>(() =>
  props.card.regions.flatMap((region) =>
    region.units
      .map((unit) => unit.imageUrl)
      .filter((url): url is string => typeof url === 'string' && url.length > 0),
  ),
)

watch(
  [imageUrl, unitUrls],
  ([cardUrl, urls]) => {
    void counterImages.preload([cardUrl, ...urls]).then(() => {
      imagesTick.value += 1
    })
  },
  { immediate: true },
)

/** 卡面图是否已就绪（读 `imagesTick` 让加载完成后重算） */
const imageReady = computed(() => {
  void imagesTick.value
  return counterImages.get(imageUrl.value) !== null
})

/** 某一枚算子的图是否已就绪（同上） */
function unitReady(url: string): boolean {
  void imagesTick.value
  return counterImages.get(url) !== null
}

/** 点选 / 取消（只影响卡面高亮，不提交任何动作） */
function pickUnit(unitId: string): void {
  pickedUnitId.value = pickedUnitId.value === unitId ? null : unitId
}

/** 右键：选中该枚并把"盒内动作"交给上层（展开那张卡 ⇒ 既有会话框出该盒的动作） */
function onUnitContext(unitId: string, event: MouseEvent): void {
  event.preventDefault()
  pickedUnitId.value = unitId
  emit('unitContext', unitId)
}

/** 分区在屏上的像素矩形（卡面像素 × 比例） */
function regionStyle(rect: { x: number; y: number; w: number; h: number }): Record<string, string> {
  return {
    left: `${rect.x * scale.value}px`,
    top: `${rect.y * scale.value}px`,
    width: `${rect.w * scale.value}px`,
    height: `${rect.h * scale.value}px`,
  }
}
</script>

<template>
  <div class="face" :style="{ width: `${width}px`, height: `${displayHeight}px` }">
    <img v-if="imageReady" class="face__image" :src="imageUrl" alt="" />
    <div v-else class="face__image face__image--pending" />

    <div
      v-for="region in card.regions"
      :key="region.id"
      class="face__region"
      :class="{ 'face__region--active': region.active === true }"
      :style="regionStyle(region.rect)"
    >
      <!--
        批 D 切片 1（口径 #12）：**分区标签只留名字与枚数** —— 规则号文字已去掉（标签在卡面上占位置，
        规则号属"旁边查得到"的信息，压掉视觉噪声才看得清卡面与算子）。
      -->
      <span class="face__region-label">
        {{ region.label }}
        <span v-if="region.units.length > 0" class="num">· {{ region.units.length }}</span>
      </span>

      <!--
        B31（用户口径 #12「盒里的算子要显示**贴图**，算子紧密排列在 box 区域里，一排不够就多排」）：
        只画算子图、**不显示额外文字**（名字/番号进 `title`），不截断枚数，靠 flex-wrap 自动多排。
      -->
      <ul class="face__units">
        <li
          v-for="unit in region.units"
          :key="unit.unitId"
          class="face__unit"
          :class="{ 'face__unit--picked': pickedUnitId === unit.unitId }"
        >
          <!--
            ⑤（用户 2026-11-09）：盒内算子**可点选、可右键**。
            点 = 选中这一枚（再点取消）；右键 = 选中并由上层把该盒的既有动作会话摆出来。
            这里不判规则、不提交动作。
          -->
          <button
            type="button"
            class="face__unit-btn"
            :title="unit.name ?? unit.unitId"
            :aria-pressed="pickedUnitId === unit.unitId"
            @click="pickUnit(unit.unitId)"
            @contextmenu="onUnitContext(unit.unitId, $event)"
          >
            <img
              v-if="unit.imageUrl !== null && unitReady(unit.imageUrl)"
              class="face__unit-img"
              :style="{ width: `${unitSizePx}px`, height: `${unitSizePx}px` }"
              :src="unit.imageUrl"
              :alt="unit.name ?? unit.unitId"
            />
            <span
              v-else
              class="face__unit-img face__unit-img--missing"
              :style="{ width: `${unitSizePx}px`, height: `${unitSizePx}px` }"
            >
              {{ (unit.name ?? unit.unitId).slice(0, 2) }}
            </span>
          </button>
        </li>
      </ul>
      <p v-if="region.units.length === 0 && region.note !== null" class="face__note">
        {{ region.note }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.face {
  position: relative;
  margin: var(--space-1);
}

.face__image {
  width: 100%;
  height: 100%;
  display: block;
  border-radius: var(--radius-sm);
}

.face__image--pending {
  background: var(--color-bg-2);
}

.face__region {
  position: absolute;
  border: 1px dashed var(--color-accent);
  border-radius: 2px;
  /*
   * 批 D 切片 1（口径 #12）：**分区底不再盖卡面** —— 原来铺一层约七成不透明的白底，
   * 把卡面印的说明与图示糊掉了；现在只留虚线框（谁在哪一区一眼可辨），卡面本身透出来。
   */
  overflow: visible;
  padding: 1px 2px;
  font-size: var(--text-xs);
}

/* B31c：记录轨的"当前格"（运力标记推到这里）——金色实心边框 + 底纹，一眼看出推到哪一格 */
.face__region--active {
  border-color: var(--color-gold);
  border-style: solid;
  border-width: 3px;
  background: color-mix(in srgb, var(--color-gold) 22%, transparent);
}

.face__region-label {
  display: flex;
  gap: var(--space-1);
  color: var(--color-muted);
  white-space: nowrap;
}
/* 批 D 切片 1：分区标签上的规则号文字已删（对应那条样式类也随之删除） */

.face__units {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 1px;
}

.face__unit {
  display: flex;
  align-items: center;
  gap: 2px;
}

.face__unit-btn {
  display: block;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 2px;
  background: none;
  cursor: pointer;
  line-height: 0;
}

/* ⑤：点选中的那一枚给一圈金色，与地图上"已选中"同一套视觉 */
.face__unit--picked .face__unit-btn {
  border-color: var(--color-gold);
  box-shadow: 0 0 0 1px var(--color-gold);
}

/* 尺寸由 `unitSizePx` 内联给（托盘 32px / 浮窗 40px）；这里只兜底一个最小值 */
.face__unit-img {
  width: 32px;
  height: 32px;
}

/* 图还没读进来时的占位：写出前两个字，至少能认出是哪一枚（修前是纯空框） */
.face__unit-img--missing {
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--color-rule);
  border-radius: 2px;
  color: var(--color-muted);
  font-size: var(--text-xs);
  line-height: 1;
  overflow: hidden;
}

.face__note {
  margin: 0;
  color: var(--color-muted);
}
</style>
