/**
 * C9 14.11 转场交互（B3-2b24）
 *
 * 从 `workbench-air.ts` 整族搬出：5 个交互 state + 14.11 段的 13 个声明 + 段 B 的
 * `transferAircraftNow`（物理上在 B2-2d 区，语义属 14.11），共 19 个声明 / 262 行。
 * 函数体逐字不动，只对 3 个提升的 `function` 声明加 deps 前缀（按值传入，无 getter）。
 * 端口 17 项 = 9 内部派生/输入 + 8 按值 ports；return 19 项。
 */
import { computed, ref } from 'vue'
import type { HexRef, Side } from '@/data'
import { sameHex } from '@/engine/hex-geometry'
import type { Derivation } from '@/engine/derivation'
import type { RuleOutcome } from '@/engine/result-types'
import {
  activeAircraftInBase,
  airBoxEdgeColumn,
  airDistanceToOffMapBox,
  planBaseTransfer,
  type AirBaseView,
  type AirMissionAircraftView,
  type BaseTransferPlan,
} from '@/engine/rules'
import type { SettlementRecordInput } from './workbench-core'
import {
  hexLabel,
  isFighterAircraft,
  parseHexPath,
  type ActionKey,
  type AirInputs,
  type ConsoleAirUnit,
  type WorkbenchLogEntry,
} from './workbench-model'

export interface AirTransferDeps {
  airUnits: { readonly value: readonly ConsoleAirUnit[] }
  pushLog: (
    kind: WorkbenchLogEntry['kind'],
    text: string,
    rule?: string,
    derivation?: Derivation,
  ) => void
  recordSettlement: (input: SettlementRecordInput) => boolean
  setAirInBoxMembership: (instanceId: string, inBox: boolean) => void
  acceptAir: <T>(outcome: RuleOutcome<T>, action: string) => T | null
  airBoxMembers: { readonly value: readonly string[] }
  actionAllowedNow: (key: ActionKey) => boolean
  requireAction: (key: ActionKey, action: string) => boolean
  airInputs: { value: AirInputs }
  airActingSide: { readonly value: Side }
  allAirViews: { readonly value: readonly AirMissionAircraftView[] }
  airBases: { readonly value: readonly AirBaseView[] }
  ownAirUnits: { readonly value: readonly ConsoleAirUnit[] }
  ownAirBases: { readonly value: readonly AirBaseView[] }
  isAirInOffMapBox: (air: ConsoleAirUnit) => boolean
  airUnitsAt: (hex: HexRef, side: Side) => ConsoleAirUnit[]
  airDistanceFromRealBase: (air: ConsoleAirUnit, hex: HexRef) => number
}

export function createAirTransferDomain(deps: AirTransferDeps) {
  const {
    airUnits,
    pushLog,
    recordSettlement,
    setAirInBoxMembership,
    acceptAir,
    airBoxMembers,
    actionAllowedNow,
    requireAction,
    airInputs,
    airActingSide,
    allAirViews,
    airBases,
    ownAirUnits,
    ownAirBases,
  } = deps

  const transferBaseId = ref<string | null>(null)
  const transferMode = ref<'box' | 'base' | null>(null)
  const transferFromBox = ref(false)
  const transferSelectedIds = ref<string[]>([])
  const lastTransfer = ref<BaseTransferPlan | null>(null)
  const transferBase = computed(() =>
    transferBaseId.value === null
      ? null
      : (airBases.value.find((base) => base.id === transferBaseId.value) ?? null),
  )

  /** 可勾选的转场飞机：图上基地 = 本格驻机；盒 = 盒内驻机（盒只转入图上基地） */
  const transferCandidates = computed<readonly ConsoleAirUnit[]>(() => {
    if (transferFromBox.value) {
      return ownAirUnits.value.filter((air) => deps.isAirInOffMapBox(air))
    }
    const base = transferBase.value
    if (base === null) return []
    return deps.airUnitsAt(base.hex, base.side)
  })

  /** 14.11：基地 → 盒的航程（专规 1.4a：盒连接列 20/30 **加上**与连接列的列差） */
  function airDistanceToBox(air: ConsoleAirUnit): number {
    return airDistanceToOffMapBox(air.side, air.hex)
  }

  /** 这架机是否够得到（转场）盒：14.11 基地转移距离**可增加一倍** */
  function canTransferAirToBox(air: ConsoleAirUnit): boolean {
    return airDistanceToBox(air) <= air.rangeHexes * 2
  }

  const transferBoxReady = computed(
    () =>
      transferSelectedIds.value.length > 0 &&
      transferSelectedIds.value.every((id) => {
        const air = airUnits.value.find((item) => item.instanceId === id)
        return air !== undefined && canTransferAirToBox(air)
      }),
  )

  /** 14.11：基地→基地距离**可增加一倍**（`*2`）；图外盒按 专规 1.4a 也是空军基地，盒→基地按 专规 1.4a 盒代价 */
  const transferBaseCandidates = computed<HexRef[]>(() => {
    if (transferMode.value !== 'base' || transferSelectedIds.value.length === 0) return []
    const selected = transferSelectedIds.value
      .map((id) => airUnits.value.find((item) => item.instanceId === id))
      .filter((air): air is ConsoleAirUnit => air !== undefined)
    if (selected.length === 0) return []
    const fromBox = transferFromBox.value
    return ownAirBases.value
      .filter((base) => base.id !== transferBaseId.value)
      .filter((base) =>
        selected.every((air) =>
          fromBox
            ? airDistanceToOffMapBox(air.side, base.hex) <= air.rangeHexes * 2
            : deps.airDistanceFromRealBase(air, base.hex) <= air.rangeHexes * 2,
        ),
      )
      .map((base) => base.hex)
  })

  /** 14.11：该基地是否有飞机够得到图外盒（够 ⇒ 菜单出现「进入地图外盒」） */
  function transferHasBoxOption(baseId: string): boolean {
    const base = ownAirBases.value.find((item) => item.id === baseId)
    if (base === undefined) return false
    return deps.airUnitsAt(base.hex, base.side).some((air) => canTransferAirToBox(air))
  }

  /** 14.11：该基地是否有飞机够得到另一个己方基地（够 ⇒ 菜单出现「放入别的空军基地」） */
  function transferHasBaseOption(baseId: string): boolean {
    const base = ownAirBases.value.find((item) => item.id === baseId)
    if (base === undefined) return false
    const planes = deps.airUnitsAt(base.hex, base.side)
    return planes.some((air) =>
      ownAirBases.value.some(
        (dest) =>
          dest.id !== baseId && deps.airDistanceFromRealBase(air, dest.hex) <= air.rangeHexes * 2,
      ),
    )
  }

  /**
   * 14.11：**这一架**此刻是否有够得到的别的本方基地（右键菜单据此决定出不出「转移基地」）
   *
   * 与 `transferBaseCandidates` 同源判据（图上按格距、盒内按 专规 1.4a 盒代价，均可双倍航程），
   * 区别只是不要求先建转场中间态 —— 菜单要"能做的才出现"，不能在打开菜单时改状态。
   */
  function canTransferAirToBaseNow(instanceId: string): boolean {
    const air = airUnits.value.find((item) => item.instanceId === instanceId)
    if (air === undefined) return false
    const fromBox = airBoxMembers.value.includes(instanceId)
    return ownAirBases.value.some((dest) => {
      if (!fromBox && sameHex(dest.hex, air.hex)) return false
      return fromBox
        ? airDistanceToOffMapBox(air.side, dest.hex) <= air.rangeHexes * 2
        : deps.airDistanceFromRealBase(air, dest.hex) <= air.rangeHexes * 2
    })
  }

  /** 14.11：开始一次转场（`baseId` 为空 ⇒ 从盒出发） */
  function beginTransferNow(
    mode: 'box' | 'base',
    baseId: string | null,
    fromBox: boolean,
  ): boolean {
    if (!actionAllowedNow('air.transfer')) {
      pushLog('warning', '当前环节不能转场（14.11）', '14.11')
      return false
    }
    transferMode.value = mode
    transferBaseId.value = baseId
    transferFromBox.value = fromBox
    transferSelectedIds.value = []
    pushLog(
      'info',
      mode === 'box'
        ? '转场（14.11）：勾选要移入图外空军盒的飞机，再点「确认移入」'
        : '转场（14.11）：勾选要转场的飞机，再点「选择目的基地」',
      '14.11',
    )
    return true
  }

  function toggleTransferAircraft(instanceId: string): boolean {
    if (!transferCandidates.value.some((air) => air.instanceId === instanceId)) return false
    const current = transferSelectedIds.value
    transferSelectedIds.value = current.includes(instanceId)
      ? current.filter((id) => id !== instanceId)
      : [...current, instanceId]
    return true
  }

  /** 结束转场交互（不改盘面） */
  function cancelTransferNow(): void {
    transferMode.value = null
    transferBaseId.value = null
    transferFromBox.value = false
    transferSelectedIds.value = []
  }

  /**
   * 14.11：落到目的基地（用户点选高亮基地格后调用）
   *
   * 战斗机在**正常航程内**保持激活；超出正常航程（但 ≤ 双倍）转入非激活。
   * 盒→图上基地：先 `setAirInBoxMembership(false)` 把飞机放回图上，再改格。
   */
  function completeTransferToBaseNow(dest: HexRef): boolean {
    const selected = transferSelectedIds.value
      .map((id) => airUnits.value.find((item) => item.instanceId === id))
      .filter((air): air is ConsoleAirUnit => air !== undefined)
    if (selected.length === 0) return false
    if (!transferBaseCandidates.value.some((hex) => sameHex(hex, dest))) return false
    for (const air of selected) {
      // 14.11：盒→基地按 专规 1.4a 盒代价（20/30 + 列距）；图上基地→基地按格距
      const distance = transferFromBox.value
        ? airDistanceToOffMapBox(air.side, dest)
        : deps.airDistanceFromRealBase(air, dest)
      if (transferFromBox.value) setAirInBoxMembership(air.instanceId, false)
      air.hex = { col: dest.col, row: dest.row }
      // 14.11：只有**战斗机**在正常距离内保持激活；其余机型/超出正常距离一律非激活
      air.airStatus =
        isFighterAircraft(air.aircraftType) && distance <= air.rangeHexes ? 'active' : 'inactive'
    }
    pushLog('info', `转场（14.11）：${selected.length} 架飞机转到 ${hexLabel(dest)}`, '14.11')
    cancelTransferNow()
    return true
  }

  /** C9 14.11：把一架飞机转移到另一个**本方**基地（距离可加倍；战斗机在正常距离内保持激活） */
  function transferAircraftNow(instanceId: string, toHexText?: string): boolean {
    // 14.2e / 14.11：基地转移只在移动环节（C 移动 / G 进击；引擎同判 `movementSegment`）
    if (!requireAction('air.transfer', '飞机转移')) return false
    // 条 14：盒内飞出盒复用 14.11 落位判据，目的地可由调用方直接给（不写回面板输入）
    const air = airUnits.value.find((item) => item.instanceId === instanceId)
    if (air === undefined) return false
    // 专规 1.4a：盒成员从**盒**出发（盒内飞机没有"当前所在基地格"）
    const inBox = airBoxMembers.value.includes(air.instanceId)
    const fromBase = airBases.value.find((base) => sameHex(base.hex, air.hex))
    if (!inBox && fromBase === undefined) {
      pushLog('warning', `${air.name} 不在空军基地格内（14.1a）`, '14.1a')
      return false
    }
    const toHex = parseHexPath(toHexText ?? airInputs.value.transferToHexText)[0] ?? null
    if (toHex === null) {
      pushLog('warning', '转移目的地应为「列.行」（14.11）', '14.11')
      return false
    }
    const toBase = airBases.value.find((base) => sameHex(base.hex, toHex))
    if (toBase === undefined) {
      pushLog('warning', `${hexLabel(toHex)} 没有空军基地（14.11）`, '14.11')
      return false
    }
    // 专规 1.4a：盒 → 图上基地。代价＝连接列 20/30 + 列距；14.11 转移可用双倍航程。
    if (inBox) {
      const distance = airDistanceToOffMapBox(air.side, toHex)
      if (distance > air.rangeHexes * 2) {
        pushLog(
          'warning',
          `${air.name} 飞出盒超出航程：${String(distance)} > ${String(air.rangeHexes * 2)}（14.11 / 1.4a）`,
          '14.11',
        )
        return false
      }
      setAirInBoxMembership(air.instanceId, false)
      air.hex = { ...toHex }
      air.airStatus =
        isFighterAircraft(air.aircraftType) && distance <= air.rangeHexes ? 'active' : 'inactive'
      lastTransfer.value = {
        aircraftId: air.instanceId,
        fromHex: { col: airBoxEdgeColumn(air.side), row: 1 },
        toHex: { ...toHex },
        distanceHexes: distance,
        maxDistanceHexes: air.rangeHexes * 2,
        airStatus: air.airStatus,
        rule: '14.11',
        detail: `基地转移（图外盒 → ${hexLabel(toHex)}）：航程 ${String(distance)}/${String(air.rangeHexes * 2)}（14.11 / 1.4a）`,
      }
      pushLog('success', `${air.name} 从图外盒转场到 ${hexLabel(toHex)}（14.11 / 1.4a）`, '14.11')
      recordSettlement({
        action: 'airTransfer',
        rule: '14.11',
        data: { aircraftId: air.instanceId, toHex: { ...toHex }, airStatus: air.airStatus },
      })
      return true
    }
    if (fromBase === undefined) return false
    const data = acceptAir(
      planBaseTransfer({
        side: airActingSide.value,
        aircraft: {
          id: air.instanceId,
          isFighter: isFighterAircraft(air.aircraftType),
          rangeHexes: air.rangeHexes,
        },
        fromBase,
        toBase,
        activeAircraftAtDestination: activeAircraftInBase(allAirViews.value, toHex),
      }),
      '基地转移',
    )
    if (data === null) return false
    air.hex = { ...toHex }
    air.airStatus = data.airStatus
    lastTransfer.value = data
    pushLog('success', `${air.name} ${data.detail}`, '14.11')
    // ⑭ 接线：飞机转移（14.11）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'airTransfer',
      rule: '14.11',
      data: {
        aircraftId: air.instanceId,
        toHex: { ...toHex },
        airStatus: data.airStatus,
        detail: data.detail,
      },
    })
    return true
  }

  return {
    transferBaseId,
    transferMode,
    transferFromBox,
    transferSelectedIds,
    lastTransfer,
    transferBase,
    transferCandidates,
    airDistanceToBox,
    canTransferAirToBox,
    transferBoxReady,
    transferBaseCandidates,
    transferHasBoxOption,
    transferHasBaseOption,
    canTransferAirToBaseNow,
    beginTransferNow,
    toggleTransferAircraft,
    cancelTransferNow,
    completeTransferToBaseNow,
    transferAircraftNow,
  }
}

export type AirTransferDomain = ReturnType<typeof createAirTransferDomain>
