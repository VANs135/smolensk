import {
  chartsCrt,
  chartsSupplyRepl,
  chartsTables,
  chartsTec,
  markers,
  panelScans,
  rulesConstants,
} from '@/data'
import type { DeepReadonly, PanelScanScreen } from '@/data'
import type { ArrivalPlan } from '@/engine/rules'

/**
 * **表格屏的只读投影**（B16；方案 §5/§6「`charts.*` 视图模型 —— 当前零渲染，需新增只读投影」）
 *
 * ## 为什么单写一个模块
 * 底部托盘的「表格」段要显示五屏（CRT / 补给与补员 / TEC / 回合与天气 / 到货），
 * 数据本身早就入库（`charts-*.json` + `markers.turnTrack` + 专规常量 + 到达计划），
 * 但**没有任何一处把它变成"行 × 列 + 单元格文本"**。把这层放在 `render/` 里当**纯函数**：
 *   · 组件只画（不解析嵌套结构、不拼字符串）；
 *   · 可以单测"行数/列数与数据文件一致"（方案 §8 的门禁：防手抄）；
 *   · **不改任何规则**：单元格文本一律照录数据里的结果代码（`DG` / `AL1` / `[1/2]` / `P` …）。
 *
 * ## 五屏的形状
 * 所有表都归一到同一个形状 `TableView`（行标注 × 列标注 + 行主序单元格），
 * 这样托盘只写一个 `<table>` 模板就能画完五屏；差异只在"哪几个列标注"。
 */

/** 一张可渲染的表（行标注 × 列标注 + 单元格文本） */
export interface TableView {
  /** 表标识（同数据文件里的 `id`；界面上只作 `key`） */
  id: string
  /** 表名（中文短名 + 规则号） */
  title: string
  /** 行标注（照录原文，多为骰值/值域/类别） */
  rows: readonly string[]
  /** 列标注（照录原文；缺省＝无表头的一列式，如"结果"列） */
  columns: readonly string[]
  /** 行主序单元格（`cells[row][col]`） */
  cells: readonly (readonly string[])[]
  /** 行尾成本列（可选：如轰炸表每列的成本） */
  cost?: readonly number[]
  /** 附注（照录数据里的 `idNote`；没有就不给） */
  note?: string
}

/** CRT 的四条地形线（列标注里就是这四条，逐条摊成一张表更好读） */
const CRT_TERRAIN_LINES = ['Extr Close', 'Very Close', 'Close', 'Open'] as const

/**
 * **CRT（9.9）**：掷骰值 × 地形列位 → 结果代码
 *
 * 数据是「15 个掷骰行 × 4 条地形线各自 13 个列位」+ 一份 15×13 的结果矩阵
 * ⇒ 这里按**地形线**摊成四张表（每张 15 行 × 13 列），免得横着塞 52 列。
 */
export function crtViews(): readonly TableView[] {
  const crt = chartsCrt.crt
  const matrix = crt.matrix as readonly (readonly string[])[]
  return CRT_TERRAIN_LINES.map((line) => {
    const columns = crt.terrainColumns[line]
    return {
      id: `crt-${line}`,
      title: `CRT（9.9）· ${line}`,
      rows: [...crt.diceRows],
      columns: columns === undefined ? [] : [...columns],
      cells: matrix.map((row) => [...row]),
    }
  })
}

/** 结果代码释义（数据里给了就给：`raw` → 人话；托盘的 CRT 屏用它作表脚注） */
export function crtResultCodes(): readonly { code: string; text: string }[] {
  const codes = chartsCrt.crt.resultCodes
  if (codes === undefined) return []
  return Object.entries(codes).map(([code, text]) => ({ code, text }))
}

/** 通用网格表（`charts-tables.json` 的 6 张：轰炸 / 对设施 / 夺取 / 防空任务损失 / 奇袭 / 损耗） */
export function gridTableViews(): readonly TableView[] {
  return chartsTables.tables.map((table) => ({
    id: table.id,
    title: table.name ?? table.id,
    rows: table.rows.map((row) => String(row)),
    columns: table.columns === undefined ? [] : [...table.columns],
    cells: table.grid.map((row) => [...row]),
    ...(table.cost === undefined ? {} : { cost: [...table.cost] }),
    ...(table.idNote === undefined ? {} : { note: table.idNote }),
  }))
}

/**
 * **补给表（13.6b / 专规 1.6b）**：掷骰值域 → 该方当日可得的 SP
 *
 * 数据按方给了两份（1941-08-19 前后不同）⇒ 两列并排（`spBefore19Aug` / `spFrom19Aug`），
 * 让玩家一眼看出"这次提升之后会变成多少"（专规 1.6 的补给提升日期就是 8/19）。
 */
export function supplyTableViews(): readonly TableView[] {
  const sides: readonly ('axis' | 'soviet')[] = ['axis', 'soviet']
  return sides.map((side) => {
    const table = chartsSupplyRepl.supply[side]
    return {
      id: `supply-${side}`,
      title: `补给表（13.6b）· ${side === 'axis' ? '轴心国' : '苏联'}`,
      rows: [...table.rows],
      columns: ['8/19 前', '8/19 起'],
      cells: table.rows.map((_row, index) => [
        String(table.spBefore19Aug[index] ?? ''),
        String(table.spFrom19Aug[index] ?? ''),
      ]),
    }
  })
}

/** **补员表（13.5 / 专规 1.6b）**：掷骰值域 × 四类补员（Ftr/Tac/Pax/Eq） */
export function replTableViews(): readonly TableView[] {
  const sides: readonly ('axis' | 'soviet')[] = ['axis', 'soviet']
  return sides.map((side) => {
    const table = chartsSupplyRepl.repl[side]
    return {
      id: `repl-${side}`,
      title: `补员表（13.5）· ${side === 'axis' ? '轴心国' : '苏联'}`,
      rows: [...table.rows],
      columns: [...table.columns],
      cells: table.grid.map((row) => row.map((value) => String(value))),
    }
  })
}

/** **特殊补员表（专规 1.6c）**：掷骰值域 → 免费内容（标签照录） */
export function specialReplTableViews(): readonly TableView[] {
  const sides: readonly ('axis' | 'soviet')[] = ['axis', 'soviet']
  return sides.map((side) => {
    const rows = chartsSupplyRepl.specialRepl[side]
    return {
      id: `special-repl-${side}`,
      title: `特殊补员（专规 1.6c）· ${side === 'axis' ? '轴心国' : '苏联'}`,
      rows: rows.map((row) =>
        row.dieFrom === row.dieTo ? `${row.dieFrom}` : `${row.dieFrom}–${row.dieTo}`,
      ),
      columns: ['内容'],
      cells: rows.map((row) => [row.label]),
    }
  })
}

/** **重建表（13.5）**：单位类别 → 重建费用与来源（列表式，故只有一列"费用/来源"） */
export function rebuildTableViews(): readonly TableView[] {
  const sides: readonly ('axis' | 'soviet')[] = ['axis', 'soviet']
  return sides.map((side) => {
    const rows = chartsSupplyRepl.rebuild[side]
    return {
      id: `rebuild-${side}`,
      title: `重建表（13.5）· ${side === 'axis' ? '轴心国' : '苏联'}`,
      rows: rows.map((row) => row.unitType),
      columns: ['重建方式'],
      cells: rows.map((row) => [rebuildCostTextOf(row.rebuild, row.sourceLabel)]),
    }
  })
}

/** 重建方式的文本化（`replOnly` ⇒ 只能走补员表；`normal` ⇒ 列出资源费用；其余照录来源） */
function rebuildCostTextOf(
  rebuild: {
    kind: string
    cost?: readonly { resource: string; amount: number }[]
  },
  sourceLabel: string | undefined,
): string {
  if (rebuild.kind === 'replOnly') return sourceLabel ?? '仅经补员表'
  if (rebuild.kind === 'normal') {
    const cost = (rebuild.cost ?? [])
      .map((item) => `${String(item.amount)} ${item.resource.toUpperCase()}`)
      .join(' + ')
    return cost === '' ? (sourceLabel ?? '常规重建') : cost
  }
  return sourceLabel ?? rebuild.kind
}

/**
 * **TEC（地形效果表，专规 / 通规 17.0）**：地形 → 各机动模式的 MP 与各攻方类别的修正
 *
 * 数据里 MP 与攻击修正是**结构化**的（`{kind:'fixed',value}` / `{kind:'multiplier',mult}`），
 * 这里把它折成可读文本（如 `1` / `×2（仅攻方）`）——**只做显示**，判据仍在引擎（6.2 / 9.4d）。
 */
export function tecTableView(): TableView {
  const tec = chartsTec.tec
  const modes = [...tec.mobilityModes]
  const columns = [
    ...modes.map((mode) => `MP·${mode}`),
    ...tec.attackerTypes.map((type) => `攻·${type}`),
    '战斗线',
  ]
  return {
    id: 'tec',
    title: '地形效果表（TEC）',
    rows: tec.features.map((feature) => feature.feature),
    columns,
    cells: tec.features.map((feature) => [
      ...modes.map((mode) => mpTextOf(feature.mp[mode])),
      ...tec.attackerTypes.map((type) => attackTextOf(feature.attack[type])),
      feature.combatLine ?? '',
    ]),
  }
}

/** TEC 图例（数据里给了 `legend`；逐条照录，供托盘的表脚注） */
export function tecLegend(): readonly { key: string; text: string }[] {
  const legend = chartsTec.tec.legend
  if (legend === undefined) return []
  return Object.entries(legend).map(([key, text]) => ({ key, text }))
}

/** 机动消耗的文本化（`fixed` ⇒ `1`；`prohibited` ⇒ `P`） */
function mpTextOf(entry: { kind: string; value?: number } | undefined): string {
  if (entry === undefined) return ''
  if (entry.kind === 'prohibited') return 'P'
  return entry.kind === 'fixed' ? String(entry.value ?? '') : ''
}

/** 攻击修正的文本化（倍率 `[攻,守]`：攻方乘前者、守方乘后者；`attackerOnly` 标出只在攻击时） */
function attackTextOf(
  entry: { kind: string; mult?: readonly number[]; attackerOnly?: boolean } | undefined,
): string {
  if (entry === undefined) return ''
  if (entry.kind !== 'multiplier') return ''
  const attack = entry.mult?.[0] ?? 1
  const defence = entry.mult?.[1] ?? 1
  const suffix = entry.attackerOnly === true ? '（仅攻方）' : ''
  if (attack === defence) return `×${String(attack)}${suffix}`
  return `攻×${String(attack)} / 守×${String(defence)}${suffix}`
}

/**
 * **回合与天气（2.2 / 专规 1.5 / 专规 1.2）**
 *
 * 三样东西并排：回合轨（回合号 → 日期）、当日天气档（1 = 受限飞行、2–6 = 正常，取自专规常量）、
 * 铁路容量（专规 1.2 的**提升日期**前后两档）。★ 天气的**判定**在引擎 `resolveTurnWeather`，
 * 本表只把"什么点数会出什么天气"摆出来（它正是掷骰前要看的那张表）。
 */
export function turnWeatherTableView(): TableView {
  const weather = rulesConstants.smolensk.weather
  const rail = rulesConstants.smolensk
  return {
    id: 'turn-weather',
    title: '回合与天气（2.2 / 专规 1.2 / 1.5）',
    rows: markers.turnTrack.map((row) => `${String(row.turn)} 回合`),
    columns: ['日期', '天气（1d6）', '铁路容量 轴 / 苏'],
    cells: markers.turnTrack.map((row) => [
      row.date,
      `${String(weather.dieCount)} 骰：1 = 受限飞行，2–${String(weather.dieCount + 5)} = 正常飞行`,
      railCapacityTextFor(row.date, rail),
    ]),
  }
}

/** 铁路容量文本（专规 1.2：`railCapBoostDate` 起用提升后的容量） */
function railCapacityTextFor(
  date: string,
  rail: {
    railCapBoostDate: string
    railCapBefore: { axis: number; soviet: number }
    railCapAfter: { axis: number; soviet: number }
  },
): string {
  const after = date >= rail.railCapBoostDate
  const caps = after ? rail.railCapAfter : rail.railCapBefore
  return `${String(caps.axis)} / ${String(caps.soviet)}${after ? '（已提升）' : ''}`
}

/**
 * **到货（13.6 / 专规 1.6）**：当日到达卡的逐条需求
 *
 * 入参是 store 的 `arrivalPlan`（**只读投影**：本函数不查任何状态）。
 * 没有计划（不在增援段 / 当日无到货）时返回 null，托盘据此显示"当日无到货卡"。
 */
export function arrivalTableView(plan: ArrivalPlan | null): TableView | null {
  if (plan === null) return null
  return {
    id: `arrivals-${plan.side}-${plan.date}`,
    title: `到货（13.6）· ${plan.side === 'axis' ? '轴心国' : '苏联'} · ${plan.date}`,
    rows: plan.units.map((unit) => unit.name ?? unit.raw),
    columns: ['数量', '落点', '备注'],
    cells: plan.units.map((unit) => [
      unit.count > 1 ? `${String(unit.count)}×` : '1×',
      unit.placement.label,
      [
        unit.designation,
        unit.factors,
        unit.stepsLost > 0 ? `带损 ${String(unit.stepsLost)}` : null,
        unit.loadedWithSp ? '满载 SP（13.6c）' : null,
      ]
        .filter((text): text is string => text !== null && text !== '')
        .join('｜'),
    ]),
  }
}

/** 到货卡的强制移除与关闭提示（1.6a / 2.1a；同屏表脚注用） */
export function arrivalNotesOf(plan: ArrivalPlan | null): readonly {
  removals: readonly string[]
  shutdowns: readonly string[]
  notes: readonly string[]
}[] {
  if (plan === null) return []
  return [
    {
      removals: plan.removals.map((item) => item.detail),
      shutdowns: [...plan.shutdowns],
      notes: [...plan.notes],
    },
  ]
}

/** 数据文件的只读投影（供托盘把"表从哪来"写在脚注里） */
export function chartSources(): readonly { file: string; version: string; description: string }[] {
  const files: readonly [string, DeepReadonly<{ version: string; description?: string }>][] = [
    ['charts-crt.json', chartsCrt.meta],
    ['charts-tables.json', chartsTables.meta],
    ['charts-supply-repl.json', chartsSupplyRepl.meta],
    ['charts-tec.json', chartsTec.meta],
    // B22：表格屏还能直接看**印卡扫描图** ⇒ 它的清单也是一份数据来源
    ['panel-scans.json', panelScans.meta],
  ]
  return files.map(([file, meta]) => ({
    file,
    version: meta.version,
    description: meta.description ?? '',
  }))
}

/* ────────────────────── B22：印卡扫描图（表格屏的"看原卡"那一半） ────────────────────── */

/**
 * **某一屏的印卡扫描图**（用户口径 2026-09-16「盒还有表格可以直接用素材库里辅助卡图片」）
 *
 * 表格屏上的每张表都是引擎投影（行 × 列 + 单元格文本），好处是可核对、可断言；
 * 但**版式与图例是官方卡面的一部分**（脚注、表注、图例符号），照画的表格给不了。
 * 故屏上并存两种看法：**印卡图**（原卡，权威版式）与**数据表**（引擎投影，便于核对）。
 * 本函数只做"按屏取图"的筛选，不解释图档内容（组件照 URL 画即可）。
 */
export function panelScansOf(screen: PanelScanScreen): readonly PanelScanView[] {
  return panelScans.scans
    .filter((scan) => scan.screen === screen)
    .map((scan) => ({
      id: scan.id,
      title: scan.title,
      image: scan.image,
      imageSize: { w: scan.imageSize.w, h: scan.imageSize.h },
      ...(scan.note === undefined ? {} : { note: scan.note }),
      ...(scan.side === undefined ? {} : { side: scan.side }),
    }))
}

/**
 * **某一方的到达卡**（B34②：用户 #4「OOA 卡的窗口都做了，把图加进去吧」）
 *
 * 到达卡是**按方成对**印的（轴 / 苏各一张），故取图要带方 —— 这是"按方取图"的**唯一入口**，
 * 组件不自己按文件名挑（文件名与方的对应关系只写在这里与数据文件里）。
 * 取不到（某剧本没印/图没入清单）时返回 `null`，界面按"没有卡图"处理而不是画空白框。
 */
export function ooaScanOf(side: 'axis' | 'soviet'): PanelScanView | null {
  return panelScansOf('ooa').find((scan) => scan.side === side) ?? null
}

/** 一张印卡扫描图的投影（组件只画，不解析数据文件） */
export interface PanelScanView {
  id: string
  /** 屏上小标题（照卡面内容写） */
  title: string
  /** 图档名（组件交给 `panelScanImageUrl` 编码取图） */
  image: string
  /** 卡面像素尺寸（算显示比例用） */
  imageSize: { w: number; h: number }
  /** 可选补充说明 */
  note?: string
  /** 这张图属于哪一方（按方成对的卡才有；单方共用的表不给） */
  side?: 'axis' | 'soviet'
}
