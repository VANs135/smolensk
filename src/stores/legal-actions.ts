import { ACTION_GATES, type ActionKey } from './workbench-model'

export { ACTION_GATES }

/**
 * B1：**合法动作只读聚合视图**
 *
 * 定位：给 AI 与 UI 一个共用的事实来源 —— 「此刻有哪些动作族、闸门是否放行、
 * 有哪些既有单位/格/选项候选、该走哪个提交入口」。
 *
 * ★ 纪律：本文件**只搬运**既有事实，不新增任何规则判据。
 *   合法性一律来自 `ACTION_GATES`（`workbench-model`）与各 store 的既有投影；
 *   某动作族没有单位/格级候选投影时如实标 `unsupported`，**不得临时造候选**。
 */

export type LegalActionStatus = 'available' | 'blocked' | 'unsupported'

export interface LegalActionCandidate {
  /** 单位 instanceId / 格 "c.r" / 选项 id / 初设 "entryIndex:hex" */
  ref: string
  label: string
  disabledReason?: string
}

export interface LegalActionEntry {
  /** ActionKey 或 'phase.advance' | 'panel.answer' | 'setup.place' */
  key: string
  label: string
  status: LegalActionStatus
  gated: boolean
  /** 既有提交入口函数名（没有入口时为 ''，并在 `note` 说明） */
  submit: string
  /** 可否作为「可点动作」上界面（`submit === ''` 的族一律 false） */
  clickable: boolean
  rule?: string
  candidates: LegalActionCandidate[]
  note?: string
}

export interface LegalActionsView {
  phase: string
  segment: string
  role: 'active' | 'nonActive'
  side: 'axis' | 'soviet'
  entries: LegalActionEntry[]
}

export interface LegalActionsInput {
  phase: string
  segment: string
  role: 'active' | 'nonActive'
  side: 'axis' | 'soviet'
  gatedKeys: ReadonlySet<string>
  terminated: boolean
  locked: boolean
  advance: { available: boolean; submit: 'advanceSegmentNow' }
  answer: { awaiting: boolean; options: { id: string; label: string }[] }
  setup: {
    active: boolean
    choices: { entryIndex: number; label: string; hexes: { ref: string; label: string }[] }[]
  }
  candidates: Partial<Record<string, LegalActionCandidate[]>>
}

/**
 * 动作族 → **既有提交入口**（纯映射表；只写函数名，不调用）
 *
 * 空字符串＝store 里没有该动作族的提交入口（`note` 会写明）。
 */
const SUBMIT_ENTRY_OF: Readonly<Record<ActionKey, string>> = {
  'air.refit': 'beginRefitNow',
  'air.baseReduce': 'reduceBaseNow',
  'rein.arrival': 'placeArrivalNow',
  'rein.supplyArrival': 'applySupplyArrivalsNow',
  'rein.supplyTrain': 'placeSupplyTrainSpNow',
  'rein.rebuild': 'rebuildUnitNow',
  'rein.specialRepl': 'drawSpecialRepl',
  'rein.frontalReserves': 'claimFrontalReservesNow',
  'move.breakout': 'breakoutNow',
  'move.modeChange': 'switchUnitMode',
  'move.order': 'beginMoveFor',
  'move.overrun': 'overrunNow',
  'move.railTransport': 'railMoveNow',
  'move.railConversion': 'convertRailGaugeNow',
  'move.loadUnload': 'loadTransportPointNow',
  'move.transportMerge': 'mergeTransportPointsNow',
  'move.construction': 'buildAirBaseNow',
  'move.hedgehog': 'buildHedgehogNow',
  'move.breakdown': 'createBreakdownNow',
  'move.dumpBlow': 'destructDumpNow',
  'move.extenderConvert': 'convertTransportToExtenderNow',
  'barrage.declare': 'beginBarrageNow',
  'combat.declare': 'openBattle',
  'supply.recovery': 'applySupplyPhaseRecoveryNow',
  'supply.draw': 'confirmSupplyPickupNow',
  'supply.fuel': 'payFuel',
  // 掷骰由结算入口触发；玩家落盘的是分摊结果，入口为 applyAttritionNow
  'supply.attrition': 'applyAttritionNow',
  'reserve.release': 'releaseReserveNow',
  'air.mission': 'beginAirMissionNow',
  'air.transfer': 'transferAircraftNow',
  'exclusive.forage': 'spendSupplyCacheNow',
  // 3.4a：段末义务由 `advanceSegmentNow` 的收束步骤结算，没有独立提交入口
  'exclusive.panzerObligation': '',
}

const NOTE_NO_CANDIDATES = '尚无单位/格级候选投影'
const NOTE_NO_SUBMIT = '无既有提交入口'

function entryNote(parts: readonly string[]): string | undefined {
  return parts.length === 0 ? undefined : parts.join('；')
}

/**
 * 把既有事实拼成只读视图（纯函数；所有判断都是对 `ACTION_GATES` 的查表与状态搬运）
 */
export function buildLegalActionsView(input: LegalActionsInput): LegalActionsView {
  const hardBlocked = input.terminated || input.locked
  const entries: LegalActionEntry[] = []

  for (const gate of ACTION_GATES) {
    const gated = input.gatedKeys.has(gate.key)
    const candidates = input.candidates[gate.key]
    const submit = SUBMIT_ENTRY_OF[gate.key] ?? ''
    const notes: string[] = []

    let status: LegalActionStatus
    if (hardBlocked || !gated) {
      status = 'blocked'
    } else if (candidates === undefined) {
      status = 'unsupported'
      notes.push(NOTE_NO_CANDIDATES)
    } else if (!candidates.some((candidate) => candidate.disabledReason === undefined)) {
      status = 'blocked'
      notes.push(candidates[0]?.disabledReason ?? '当前无可提交候选')
    } else {
      status = 'available'
    }
    if (submit === '') notes.push(NOTE_NO_SUBMIT)

    entries.push({
      key: gate.key,
      label: gate.label,
      status,
      gated,
      submit,
      clickable: status === 'available' && submit !== '',
      rule: gate.rule,
      candidates: hardBlocked || !gated ? [] : (candidates ?? []),
      ...(entryNote(notes) === undefined ? {} : { note: entryNote(notes) }),
    })
  }

  /* ── 三条非闸门入口（相位推进 / 待答面板 / 初设落位） ── */

  const advanceGated = input.advance.available && !input.terminated && !input.locked
  entries.push({
    key: 'phase.advance',
    label: '进入下一环节',
    status: advanceGated ? 'available' : 'blocked',
    gated: advanceGated,
    submit: input.advance.submit,
    clickable: advanceGated,
    candidates: advanceGated ? [{ ref: 'advance', label: '进入下一环节' }] : [],
  })

  const answerGated = input.answer.awaiting && !input.terminated
  entries.push({
    key: 'panel.answer',
    label: '答复会话问题',
    status: answerGated ? 'available' : 'blocked',
    gated: answerGated,
    submit: 'answerNow',
    clickable: answerGated,
    candidates: answerGated
      ? input.answer.options.map((option) => ({ ref: option.id, label: option.label }))
      : [],
  })

  const setupActive = input.setup.active && !hardBlocked
  const setupCandidates: LegalActionCandidate[] = setupActive
    ? input.setup.choices.flatMap((choice) =>
        choice.hexes.map((hex) => ({
          ref: `${String(choice.entryIndex)}:${hex.ref}`,
          label: `${choice.label} ⇒ ${hex.label}`,
        })),
      )
    : []
  entries.push({
    key: 'setup.place',
    label: '初设落位',
    status: setupActive ? 'available' : 'blocked',
    gated: setupActive,
    submit: 'placeSelfEntry',
    clickable: setupActive,
    candidates: setupCandidates,
    ...(setupActive && setupCandidates.length === 0 ? { note: '无待落位项' } : {}),
  })

  return {
    phase: input.phase,
    segment: input.segment,
    role: input.role,
    side: input.side,
    entries,
  }
}
