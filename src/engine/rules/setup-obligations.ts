import type { Side } from '@/data'
import {
  planTruckFullLoad,
  planSupplyOwnership,
  type TruckLoadRequest,
  type SupplyOwnershipRequest,
} from './setup'
import { SP_TO_T } from './supply'

export interface SetupObligation {
  id: string
  side: Side
  rule: string
  detail: string
}

/** Setup Note F/3.4b：当前选择必须合法并已提交到实际补给站归属，不能沿用旧完成标记。 */
export function assessSetupSpOwnership(
  request: SupplyOwnershipRequest,
  actual: Readonly<Record<string, 'hoth' | 'guderian'>>,
) {
  const plan = planSupplyOwnership(request)
  if (!plan.ok)
    return { complete: false, rule: plan.rule, detail: '请完成初设SP装甲集群归属选择并确认' }
  const complete = plan.data.entries.every(
    (entry) => entry.panzerGroup === null || actual[entry.id] === entry.panzerGroup,
  )
  return {
    complete,
    rule: plan.rule,
    detail: complete ? '初设SP归属已落实' : '初设SP归属尚未与实际补给站一致，请重新确认',
  }
}

/** IV-D/13.2h：所选满载名单与实际载货都吻合才算完成，旧的完成标记不能代替盘面。 */
export function assessSetupTruckLoad(
  request: TruckLoadRequest,
  loads: readonly { instanceId: string; loadedSpT: number | null }[],
) {
  const plan = planTruckFullLoad(request)
  if (!plan.ok)
    return {
      complete: false,
      rule: plan.rule,
      detail: '编内卡车满载名单不符合剧本要求，请完成满载选择并落账',
    }
  const complete = request.trucks.every((truck) => {
    const load = loads.find((item) => item.instanceId === truck.instanceId)
    return load?.loadedSpT === (plan.data.full.includes(truck.instanceId) ? SP_TO_T : 0)
  })
  return {
    complete,
    rule: plan.rule,
    detail: complete
      ? '编内卡车初设载货已完成'
      : '编内卡车所选名单尚未与实际载货一致，请重新确认满载名单',
  }
}

/** ch10/ch11/初设流程：必做处置与双方确认单列，普通未摆单位的放弃不消除这些义务。 */
export function pendingSetupObligations(input: {
  shifts: readonly { formationId: string }[]
  draws: readonly { kind: string; applied: boolean; reason: string | null }[]
  truck: ReturnType<typeof assessSetupTruckLoad>
  cursor: Side | null
  ownership?: ReturnType<typeof assessSetupSpOwnership>
}): SetupObligation[] {
  const issues: SetupObligation[] = input.shifts.map((item) => ({
    id: `shift:${item.formationId}`,
    side: 'axis',
    rule: 'ch10 / ch11',
    detail: `请先完成编队西移放置：${item.formationId}`,
  }))
  for (const draw of input.draws) {
    if (draw.applied || (draw.kind === 'shiftWest' && input.shifts.length > 0)) continue
    issues.push({
      id: `draw:${draw.kind}`,
      side: 'axis',
      rule: 'ch10 / ch11',
      detail: `请先完成编队抽取处置：${draw.reason ?? draw.kind}`,
    })
  }
  if (!input.truck.complete)
    issues.push({
      id: 'truckLoad',
      side: 'axis',
      rule: input.truck.rule,
      detail: input.truck.detail,
    })
  if (input.ownership !== undefined && !input.ownership.complete)
    issues.push({
      id: 'spOwnership',
      side: 'axis',
      rule: input.ownership.rule,
      detail: input.ownership.detail,
    })
  if (input.cursor !== null)
    issues.push({
      id: 'sideConfirmation',
      side: input.cursor,
      rule: 'IV',
      detail: `请先完成双方布设确认，当前轮到${input.cursor === 'axis' ? '轴心国' : '苏联'}`,
    })
  return issues
}
