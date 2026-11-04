import type { HexRef } from '@/data'
import { isOnMap } from '../hex-geometry'
import { fail, succeed } from '../result-types'
import type { ScenarioDrawGroup, ScenarioDrawPlan } from './containers'

/** ch10：先核对整批西移的图上成员与落点，再允许写回执和移动单位。 */
export function validateSetupShiftCommit(input: {
  placements: readonly { formationId: string; unitIds: readonly string[]; hex?: HexRef }[]
  onMapIds: readonly string[]
}) {
  for (const item of input.placements) {
    if (item.hex === undefined || !isOnMap(item.hex))
      return fail('ch10', `西移编队缺少合法图上落点：${item.formationId}`)
    if (item.unitIds.length === 0 || item.unitIds.some((id) => !input.onMapIds.includes(id)))
      return fail('ch10', `西移编队缺少待移动的图上单位：${item.formationId}`)
  }
  return succeed('ch10', { detail: '编队西移成员及落点已核对' })
}

/** ch10/ch11：整组提交前检查实际来源和返场落点，避免只落实半次互换。 */
export function validateSetupDrawCommit(input: {
  plan: Pick<ScenarioDrawPlan, 'deposits' | 'returns'>
  onMapIds: readonly string[]
  groundDeadPileIds: readonly string[]
  returnHexes: Readonly<Record<string, HexRef | undefined>>
}) {
  const rule = 'ch10 / ch11'
  for (const patch of input.plan.deposits) {
    if (!input.onMapIds.includes(patch.unitId))
      return fail(rule, `待处置单位不在图上：${patch.unitId}`)
  }
  for (const patch of input.plan.returns) {
    if (!input.groundDeadPileIds.includes(patch.unitId))
      return fail(rule, `待返场地面单位不在死亡堆：${patch.unitId}`)
    const hex = input.returnHexes[patch.unitId]
    if (hex === undefined || !isOnMap(hex))
      return fail(rule, `待返场单位缺少合法图上落点：${patch.unitId}`)
  }
  return succeed(rule, { detail: '编队处置来源及返场落点已核对' })
}

interface DrawResult {
  kind: string
  formationIds: readonly string[]
}

interface DrawOutcome {
  groupKind: string
  formationIds: readonly string[]
  destinations: readonly { formationId: string; hexText: string }[]
}

/** ch10/ch11：抽中名单与处置回执分开核对，不能用“抽过”代替“已落盘”。 */
export function assessSetupDrawProgress(input: {
  groups: readonly ScenarioDrawGroup[]
  draws: readonly DrawResult[]
  outcomes: readonly DrawOutcome[]
  shiftHexes: Readonly<Record<string, string>>
}) {
  const groups = input.groups.map((group) => {
    const draw = input.draws.find((row) => row.kind === group.kind)
    const ids = draw?.formationIds ?? []
    const drawn = ids.length === group.count && new Set(ids).size === group.count
    const outcome = input.outcomes.find((row) => row.groupKind === group.kind)
    const applied =
      drawn &&
      outcome !== undefined &&
      outcome.formationIds.length === ids.length &&
      ids.every((id) => outcome.formationIds.includes(id)) &&
      (group.kind !== 'shiftWest' ||
        ids.every((id) => {
          const hex = input.shiftHexes[id]
          return (
            hex !== undefined &&
            outcome.destinations.some((item) => item.formationId === id && item.hexText === hex)
          )
        }))
    return {
      kind: group.kind,
      label: group.label,
      drawn,
      applied,
      reason: !drawn
        ? `${group.label}：需抽取 ${group.count} 个不同编队，当前 ${ids.length} 个`
        : applied
          ? null
          : `${group.label}：抽中编队尚未完成处置`,
    }
  })
  return { complete: groups.every((group) => group.applied), groups }
}
