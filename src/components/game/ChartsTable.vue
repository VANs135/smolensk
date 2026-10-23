<script setup lang="ts">
/**
 * B35：**引擎投影表的只读渲染件**（从 `BottomTray.vue` 搬出来）
 *
 * 用户口径 2026-09-16：「**辅助卡只放卡图（不要数据表那一面）**；"数据表（引擎投影）"那一面也去掉，
 * 本来意思是只做卡图，结果你多此一举了，还得再去掉」。
 * ⇒ 对局台的托盘只画**印卡图**；这些"行 × 列 + 单元格文本"的投影表挪到**引擎验证页**
 * （`WorkbenchView`），保留可核对，也避免它们变成零调用导出（架构门禁）。
 *
 * 本组件只画：标题 / 附注 / 表头 / 行 × 列 / 成本列 / 表脚注。**不做任何规则判断**。
 */
import { BaseTag } from '@/components/base'

/** 一张可渲染的表（与 `render/charts-view.ts` 的 `TableView` 同构，此处只取用到的字段） */
export interface ChartsTableData {
  id: string
  title: string
  rows: readonly string[]
  columns: readonly string[]
  cells: readonly (readonly string[])[]
  cost?: readonly number[]
  note?: string
}

const props = defineProps<{
  table: ChartsTableData
  /** 表脚注（结果代码释义 / 图例 / 到货提示…；都是照录数据的只读说明） */
  footnotes?: readonly { key: string; text: string }[]
}>()
</script>

<template>
  <div class="chartstable">
    <p class="chartstable__title">
      {{ props.table.title }}
      <span v-if="props.table.note !== undefined" class="chartstable__note">{{
        props.table.note
      }}</span>
    </p>
    <table class="chartstable__table">
      <thead>
        <tr>
          <th class="chartstable__th chartstable__th--row" />
          <th v-for="(column, index) in props.table.columns" :key="index" class="chartstable__th">
            {{ column }}
          </th>
          <th v-if="props.table.cost !== undefined" class="chartstable__th">成本</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, rowIndex) in props.table.rows" :key="rowIndex">
          <th class="chartstable__th chartstable__th--row">{{ row }}</th>
          <td
            v-for="(_, colIndex) in props.table.columns"
            :key="colIndex"
            class="chartstable__td num"
          >
            {{ props.table.cells[rowIndex]?.[colIndex] ?? '' }}
          </td>
          <td v-if="props.table.cost !== undefined" class="chartstable__td num">
            {{ props.table.cost[rowIndex] ?? '' }}
          </td>
        </tr>
      </tbody>
    </table>
    <ul v-if="(props.footnotes?.length ?? 0) > 0" class="chartstable__foot">
      <li v-for="item in props.footnotes" :key="item.key" class="num">
        <BaseTag kind="neutral">{{ item.key }}</BaseTag>
        {{ item.text }}
      </li>
    </ul>
  </div>
</template>

<style scoped>
.chartstable {
  margin-bottom: var(--space-3);
  overflow-x: auto;
}

.chartstable__title {
  margin: 0 0 var(--space-1);
  font-size: var(--text-sm);
  font-weight: 600;
}

.chartstable__note {
  margin-left: var(--space-2);
  font-weight: 400;
  color: var(--color-muted);
  font-size: var(--text-xs);
}

.chartstable__table {
  border-collapse: collapse;
  font-size: var(--text-xs);
}

.chartstable__th,
.chartstable__td {
  border: 1px solid var(--color-rule);
  padding: 2px 6px;
  text-align: center;
  white-space: nowrap;
}

.chartstable__th {
  background: var(--color-bg-2);
  font-weight: 600;
}

.chartstable__th--row {
  text-align: left;
}

.chartstable__foot {
  margin: var(--space-1) 0 0;
  padding-left: var(--space-3);
  color: var(--color-muted);
  font-size: var(--text-xs);
}
</style>
