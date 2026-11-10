import type { Side } from '@/data'
import { sopChainOf, sopStepById, type AirMissionSegment } from '@/engine/rules'

import {
  ACTION_GATES,
  type ActionGateWhere,
  type ActionKey,
  type ActionRole,
} from './workbench-model'

/**
 * 「阶段 × 环节 × 动作族」权威表（用户 2026-11-09 裁定）
 *
 * 为什么要有它：菜单（右键 / 面板 / 会话窗）各自拼一份"此刻能做什么"，同一能力
 * 会在多处出现，删入口时容易把某一阶段的能力一起删掉。本表把
 *   `ACTION_GATES`（合法性 + 条款号） × 动作族分组 × 当前入口
 * 合成一张**只读**表：菜单与面板一律从这里取值，删入口前先查"该能力是否只剩这一个入口"。
 *
 * 判据不在这里重写：`where` / `rule` 全部原样取自 `ACTION_GATES`；
 * 本模块只补两样 UI 事实——**动作族**（人话分类）与**入口**（现在从哪触发）。
 */

/** 动作族（界面用语；一个闸门键可同属多族，如 13.5/13.9 的「重建 / 整编」） */
export type ActionFamily =
  | '移动'
  | '战斗'
  | '炮击'
  | '补给'
  | '加油'
  | '装卸'
  | '拆分'
  | '合并'
  | '整编'
  | '补员'
  | '整备'
  | '空军任务'
  | '转移'
  | '铁路修理'
  | '换轨'
  | '建造'
  | '模式切换'
  | '预备'
  | '释放预备'
  | '突围'
  | '突袭'
  | '增援落位'
  | '专规义务'

/** 入口种类（当前 UI 实际存在的那几类） */
export type ActionEntryPoint = '右键菜单' | '面板' | '地图' | '会话窗' | '盒区' | '自动/裁判'

interface ActionMeta {
  /** 人话动作族（可多属） */
  families: readonly ActionFamily[]
  /** 现在能从哪些入口触发（G1–G4 删入口时同步改这里） */
  entry: readonly ActionEntryPoint[]
  /** 少数动作的触发者不能由 role/sides 直接推出时，在这里写明 */
  owner?: string
}

/**
 * 闸门键 → 动作族 / 入口（现状盘点）
 *
 * 注意：`entry` 描述的是**本表落盘时**的 UI；删除入口必须同步改这里，
 * 否则表会撒谎。守卫用例 `action-family-table.test.ts` 会检查键覆盖完整。
 */
const META: Readonly<Record<ActionKey, ActionMeta>> = {
  'air.refit': { families: ['整备'], entry: ['面板', '地图', '盒区'] },
  'air.baseReduce': { families: ['建造'], entry: ['面板'] },
  'rein.arrival': { families: ['增援落位'], entry: ['会话窗'] },
  'rein.supplyArrival': { families: ['增援落位'], entry: ['会话窗'] },
  'rein.rebuild': { families: ['整编', '补员', '合并'], entry: ['会话窗', '右键菜单'] },
  'rein.specialRepl': { families: ['补员'], entry: ['会话窗'] },
  'rein.frontalReserves': { families: ['补员'], entry: ['会话窗'] },
  'move.breakout': { families: ['突围'], entry: ['面板', '会话窗'] },
  'move.modeChange': { families: ['模式切换', '预备'], entry: ['面板', '右键菜单'] },
  'move.order': { families: ['移动'], entry: ['面板', '地图'] },
  'move.overrun': { families: ['突袭', '战斗'], entry: ['地图', '右键菜单'] },
  'move.railTransport': { families: ['移动'], entry: ['面板', '右键菜单'] },
  'move.railConversion': { families: ['换轨'], entry: ['面板', '右键菜单'] },
  'move.loadUnload': { families: ['装卸'], entry: ['面板'] },
  'move.transportMerge': { families: ['合并', '拆分'], entry: ['面板'] },
  'move.construction': { families: ['建造'], entry: ['右键菜单', '面板'] },
  'move.hedgehog': { families: ['建造'], entry: ['右键菜单', '面板'] },
  'move.breakdown': { families: ['拆分'], entry: ['右键菜单', '会话窗'] },
  'move.dumpBlow': { families: ['补给'], entry: ['面板'] },
  'move.extenderConvert': { families: ['补给'], entry: ['面板'] },
  'barrage.declare': { families: ['炮击'], entry: ['右键菜单', '地图', '面板'] },
  'combat.declare': { families: ['战斗'], entry: ['面板', '地图'] },
  'supply.recovery': { families: ['补给'], entry: ['面板'] },
  'supply.draw': { families: ['补给'], entry: ['面板'] },
  'supply.fuel': { families: ['加油'], entry: ['面板'] },
  'supply.attrition': { families: ['补给'], entry: ['面板'] },
  'reserve.release': { families: ['释放预备'], entry: ['面板'] },
  'air.mission': { families: ['空军任务'], entry: ['面板', '地图', '盒区'] },
  'exclusive.forage': { families: ['补给'], entry: ['面板'] },
  'exclusive.panzerObligation': {
    families: ['专规义务'],
    entry: ['自动/裁判'],
    owner: '轴方义务（段末由双方/裁判检查）',
  },
}

/** 表的一行＝一个「(阶段, 环节) × 动作族」组合 */
export interface ActionFamilyRow {
  key: ActionKey
  label: string
  rule: string
  families: readonly ActionFamily[]
  phase: ActionGateWhere['phase']
  phaseLabel: string
  segment: string
  segmentLabel: string
  /** 行动者（2.2：E 反应段是非行动方） */
  role: ActionRole
  /** 只对某一方存在时给出；双方均可为 null */
  sides: readonly Side[] | null
  /** 只在段末放行（B37） */
  at: 'end' | null
  /** 由谁触发（人话） */
  owner: string
  /** 该 (段, 环节) 的额外限定（如 10.0 第二段「移动环节仅空军」）；无则 null */
  note: string | null
  entry: readonly ActionEntryPoint[]
}

function ownerOf(where: ActionGateWhere): string {
  const role = where.role ?? 'active'
  const sideText =
    where.sides === undefined
      ? ''
      : `${where.sides.map((side) => (side === 'axis' ? '轴方' : '苏方')).join('/')}·`
  return `${sideText}${role === 'nonActive' ? '非行动方' : '行动方'}`
}

const SIDE_NAME: Readonly<Record<Side, string>> = { axis: '轴方', soviet: '苏方' }

function buildRows(): ActionFamilyRow[] {
  const rows: ActionFamilyRow[] = []
  for (const gate of ACTION_GATES) {
    const meta = META[gate.key]
    if (meta === undefined) throw new RangeError(`动作族表缺登记：${gate.key}`)
    for (const where of gate.where) {
      rows.push({
        key: gate.key,
        label: gate.label,
        rule: gate.rule,
        families: meta.families,
        phase: where.phase,
        phaseLabel: sopChainOf(where.phase).label,
        segment: where.segment,
        segmentLabel: sopStepById(where.segment)?.label ?? where.segment,
        role: where.role ?? 'active',
        sides: where.sides ?? null,
        at: where.at ?? null,
        owner: meta.owner ?? ownerOf(where),
        note: where.note ?? null,
        entry: meta.entry,
      })
    }
  }
  return rows
}

/** 权威表本体（机器读取；菜单/面板共用） */
export const ACTION_FAMILY_TABLE: readonly ActionFamilyRow[] = buildRows()

/** 某动作族的元数据（入口用） */
export function actionFamilyOf(key: ActionKey): ActionMeta {
  const meta = META[key]
  if (meta === undefined) throw new RangeError(`动作族表缺登记：${key}`)
  return meta
}

/** 此刻（段/环节/行动者/本方）在表里命中的行——菜单只查这里 */
export function actionFamilyRowsAt(query: {
  phase: ActionGateWhere['phase']
  segment: string
  role: ActionRole
  side?: Side
  atSegmentEnd?: boolean
}): ActionFamilyRow[] {
  return ACTION_FAMILY_TABLE.filter((row) => {
    if (row.phase !== query.phase || row.segment !== query.segment) return false
    if (row.role !== query.role) return false
    if (row.sides !== null && query.side !== undefined && !row.sides.includes(query.side))
      return false
    if (row.at === 'end' && query.atSegmentEnd !== true) return false
    return true
  })
}

/** 某动作族当前登记的入口（删入口时同步改 META） */
export function entryPointsOf(key: ActionKey): readonly ActionEntryPoint[] {
  return actionFamilyOf(key).entry
}

/**
 * **UI 有入口、闸门表未登记**的能力（现状缺口；确认后补 `ACTION_GATES` 或补闸门）
 *
 * 这些条目还不能进 `ACTION_FAMILY_TABLE`（没有 `where` 就没有"哪一段哪一环节"的答案），
 * 单独列出是为了让"删入口前先查表"这件事不漏项。
 * 其中引擎已经限定时机的，用 `segmentKind` 记下来（如 14.11 转移限移动环节），
 * 不再写成"无时机限制"。
 */
export interface UnregisteredFamily {
  id: string
  label: string
  rule: string
  families: readonly ActionFamily[]
  entry: readonly ActionEntryPoint[]
  /**
   * 引擎已经限定的时机（14.2e）；与 `AIR_MISSION_SEGMENT` 同口径
   *
   * 例：14.11 基地转移在引擎里是 `movementSegment`（「转移可在不同的移动环节中执行」），
   * 表里也照此登记，不能写成“无时机限制”。
   */
  segmentKind?: AirMissionSegment
  note: string
}

export const UNREGISTERED_ACTION_FAMILIES: readonly UnregisteredFamily[] = [
  {
    id: 'air.transfer',
    label: '飞机转移（基地 → 基地）',
    rule: '14.11',
    families: ['转移'],
    entry: ['面板', '盒区'],
    segmentKind: 'movementSegment',
    note: '14.2e：转移限移动环节（「转移可在不同的移动环节中执行」）；引擎 `AIR_MISSION_SEGMENT.base_transfer` 同口径；UI 入口仍在 AirPanel / 名册。',
  },
  {
    id: 'rail.repair',
    label: '铁路修理（13.3g 例外）',
    rule: '13.3g',
    families: ['铁路修理'],
    entry: ['面板'],
    note: '当前只在 SupplyPanel 的「运输」段给出候选，无 ACTION_GATES 条目。',
  },
]

export { SIDE_NAME }
