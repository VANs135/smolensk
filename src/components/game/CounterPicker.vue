<script setup lang="ts">
import { computed, ref } from 'vue'

import { BaseTag } from '@/components/base'

/**
 * **算子图阵列选择器**（B13；用户口径⑪ —— 所有"选算子"的地方都用它）
 *
 * ## 用户口径（§4.9）
 *   「把当前可选的**算子图片**紧凑排出来；页面太多就在合适位置**加下拉**切换；
 *    **算子上信息已经够了，除了环节提示这种外不需要显示额外的文字**」。
 *
 * ## 五条硬规格（逐条落在本组件里）
 *   ① **图上不叠文字**：算子图本身信息已够 ⇒ 卡面只有图（必要时一个数字角标）；
 *      名字只进 `title`/`aria-label`（鼠标悬停有、屏幕上没有）；
 *   ② **紧凑**：缩略 40px（会话框）/ 32px（托盘·盒卡·决策队列）、间距 4px、
 *      一行按可用宽度自动放 6–8 张、一屏 ≥24 张（`maxRows` 默认 4 行即封顶）；
 *   ③ **选中**＝金框 + 1px 上浮；**禁用**＝降饱和、不可点，点它只**就地冒一行含规则号的灰提示**；
 *   ④ **分组下拉**放在标题栏右端，**组内滚动、不换页**（换组只换内容，不重新分页）；
 *   ⑤ **文字纪律三类**＝环节提示（`hint`）/ 分组标题（下拉里的选项）/ 点击后一行拒绝原因 —— 其余一律不写。
 *
 * ## 分层纪律
 *   本组件是**纯投影**：可选/已选/禁用原因/分组都由调用方算好（一般是 store 的派生），
 *   它只报 `pick`（点一枚）与 `hover`（悬停，供调用方同步地图高亮）。**不做任何规则判断**。
 */

/** 阵列里的一枚 */
export interface CounterPickerItem {
  /** 唯一键（同型多枚时各不相同；一般是实例 id 或库 id） */
  id: string
  /** 算子图 URL（调用方用 `counterImageUrlOf` 取；取不到时传 null，退回只写名字） */
  imageUrl: string | null
  /** 名字（**只进 title / aria-label**，不画在图上） */
  name: string
  /** 是否已选 */
  selected: boolean
  /** 不能选的原因（null / 缺省 = 可以选）；点它只就地出一行灰提示（含规则号时一并给） */
  disabledReason?: string | null
  /** 分组键（多于一组时标题栏右端出下拉） */
  groupKey?: string
  /** 分组显示名（缺省用 `groupKey`） */
  groupLabel?: string
  /** 该枚所在格（给出即悬停同步地图高亮） */
  hex?: { col: number; row: number } | null
  /** 数字角标（**仅在确实需要时给**，如枚数 / 序号）；不传就不画 */
  badge?: string
}

const props = withDefaults(
  defineProps<{
    /** 可选算子（调用方算好顺序） */
    items: readonly CounterPickerItem[]
    /** 标题（**可省**：多数场合由外层面板标题说明） */
    title?: string
    /**
     * **环节提示**（用户口径里**唯一允许**的额外文字）
     *
     * 例「C 移动 · 模式与移动：可改模式 / 移动」——一句话说清"此刻在哪个环节、能做什么"。
     */
    hint?: string
    /** 缩略边长（px）：40 = 会话框；32 = 托盘 / 盒卡 / 决策队列 */
    size?: number
    /** 最多显示几行（超出即内部滚动）；默认 4 行 ≈ 24–32 张 */
    maxRows?: number
  }>(),
  { title: '', hint: '', size: 40, maxRows: 4 },
)

const emit = defineEmits<{
  /** 点某一枚（语义由调用方定：单选 / 切换） */
  (e: 'pick', id: string): void
  /** 悬停某一枚（null = 移出）；调用方据此同步地图高亮 */
  (e: 'hover', id: string | null): void
}>()

/** 轮到的分组（null = 不分组的平铺） */
const activeGroup = ref<string | null>(null)

/** 分组清单（按出现顺序，去重） */
const groups = computed<readonly { key: string; label: string }[]>(() => {
  const seen: { key: string; label: string }[] = []
  for (const item of props.items) {
    if (item.groupKey === undefined) continue
    if (seen.some((group) => group.key === item.groupKey)) continue
    seen.push({ key: item.groupKey, label: item.groupLabel ?? item.groupKey })
  }
  return seen
})

/** 本组要显示的枚（不分组时即全部） */
const visible = computed<readonly CounterPickerItem[]>(() => {
  if (groups.value.length === 0) return props.items
  const key = activeGroup.value ?? groups.value[0]!.key
  return props.items.filter((item) => item.groupKey === key)
})

/** 点击后**就地一行**的拒绝原因（用户口径④：只冒一行，不弹窗、不换页） */
const refusal = ref<string | null>(null)

function pickItem(item: CounterPickerItem): void {
  const reason = item.disabledReason ?? null
  if (reason !== null) {
    refusal.value = `${item.name}：${reason}`
    return
  }
  refusal.value = null
  emit('pick', item.id)
}

function hoverItem(item: CounterPickerItem | null): void {
  emit('hover', item === null ? null : item.id)
}

/** 阵列的样式变量（尺寸 / 间距 / 行上限都在一处给，模板里不写字面量） */
const gridStyle = computed<Record<string, string>>(() => ({
  '--picker-size': `${props.size}px`,
  '--picker-max-height': `${props.maxRows * (props.size + 4)}px`,
}))
</script>

<template>
  <section class="picker" :style="gridStyle">
    <header v-if="props.title !== '' || groups.length > 1" class="picker__head">
      <span v-if="props.title !== ''" class="picker__title">{{ props.title }}</span>
      <!-- 分组下拉放**标题栏右端**；组内滚动、不换页 -->
      <select
        v-if="groups.length > 1"
        class="picker__group"
        :value="activeGroup ?? groups[0]!.key"
        @change="activeGroup = ($event.target as HTMLSelectElement).value"
      >
        <option v-for="group in groups" :key="group.key" :value="group.key">
          {{ group.label }}
        </option>
      </select>
    </header>

    <!-- 环节提示（唯一允许的额外文字） -->
    <p v-if="props.hint !== ''" class="picker__hint">
      <BaseTag kind="info">环节</BaseTag>
      {{ props.hint }}
    </p>

    <div class="picker__grid" @pointerleave="hoverItem(null)">
      <button
        v-for="item in visible"
        :key="item.id"
        type="button"
        class="picker__cell"
        :class="{
          'picker__cell--on': item.selected,
          'picker__cell--off': item.disabledReason != null,
        }"
        :title="item.disabledReason == null ? item.name : `${item.name}（${item.disabledReason}）`"
        :aria-label="item.name"
        :aria-pressed="item.selected"
        @click="pickItem(item)"
        @pointerenter="hoverItem(item)"
        @focus="hoverItem(item)"
        @blur="hoverItem(null)"
      >
        <img v-if="item.imageUrl !== null" class="picker__img" :src="item.imageUrl" alt="" />
        <span v-else class="picker__img picker__img--none" aria-hidden="true" />
        <span v-if="item.badge !== undefined" class="picker__badge num">{{ item.badge }}</span>
      </button>
    </div>

    <p v-if="visible.length === 0" class="picker__empty">本组没有可选的算子。</p>
    <p v-if="refusal !== null" class="picker__refusal">{{ refusal }}</p>
  </section>
</template>

<style scoped>
.picker {
  /*
   * 两个**组件内**自定义属性的缺省值（实际值由调用方的 size / maxRows 经内联样式覆盖）。
   * 门禁要求"用到的 CSS 变量必须有人定义"——这里就是它们的定义处；
   * 缺省按 40px 缩略 / 4 行封顶，与 `withDefaults` 里的默认参数保持一致，免得两边各说一套。
   */
  --picker-size: 40px;
  --picker-max-height: 176px;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.picker__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.picker__title {
  flex: 1;
  font-size: var(--text-sm);
  color: var(--color-muted);
}

.picker__group {
  margin-left: auto;
  max-width: 12em;
  font-size: var(--text-xs);
}

.picker__hint {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0;
  font-size: var(--text-xs);
  color: var(--color-muted);
}

.picker__grid {
  display: grid;
  /* 一行按可用宽度放 6–8 张（`auto-fill` + 4px 间距） */
  grid-template-columns: repeat(auto-fill, var(--picker-size));
  gap: 4px;
  max-height: var(--picker-max-height);
  overflow: auto;
  align-content: start;
}

.picker__cell {
  position: relative;
  width: var(--picker-size);
  height: var(--picker-size);
  padding: 0;
  border: 2px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
  cursor: pointer;
  transition: transform 60ms ease-out;
}

.picker__cell:hover {
  border-color: var(--color-rule);
}

/* 选中：金框 + 1px 上浮 */
.picker__cell--on {
  border-color: var(--color-gold);
  transform: translateY(-1px);
}

/* 禁用：降饱和、不可点 */
.picker__cell--off {
  filter: saturate(0.25);
  opacity: 0.55;
  cursor: not-allowed;
}

.picker__img {
  width: 100%;
  height: 100%;
  display: block;
  border-radius: calc(var(--radius-sm) - 1px);
  object-fit: contain;
}

/* 无图占位（只是空框，不写字） */
.picker__img--none {
  background: var(--color-rule);
}

.picker__badge {
  position: absolute;
  right: 0;
  bottom: 0;
  padding: 0 2px;
  border-radius: var(--radius-sm);
  background: rgb(32 30 26 / 0.72);
  color: var(--color-bg);
  font-size: var(--text-xs);
  line-height: 1.3;
}

.picker__empty,
.picker__refusal {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--color-muted);
}

.picker__refusal {
  color: var(--color-warning);
}
</style>
