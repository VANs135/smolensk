/**
 * 训练用的 canonical action key（与运行时 `actionKeyOf` 分开）
 *
 * 为什么不直接改 `policy.ts` 的 `actionKeyOf`：
 * - 它是现有死锁判据/日志/测试的稳定签名，部分测试明确钉着 `combatOptions` / `combatRetreatPaths`
 *   这类旧泛化 key；
 * - 训练需要**全参数**的 key（同一基座不同飞机、同一重建单位不同落点、同一炮击不同损失分摊
 *   必须可区分），两者用途不同。
 *
 * 本文件只做「动作 → 字符串」，不反解；反解由候选表（key → action）承担。
 * 所有 ID 都经 `ActionIdResolver` 换成稳定别名，保证跨进程同盘面同字节。
 */

import type { AiAction } from '../policy'
import { hexKeyOf } from '../policy'

/** ID 归一化端口：训练投影提供稳定别名；运行时默认使用 identity 以保持旧行为 */
export interface ActionIdResolver {
  unit(id: string): string
  point(id: string): string
  dump(id: string): string
  base(id: string): string
  formation(id: string): string
}

/** 原样返回的解析器（只给兼容/测试用；训练必须传稳定别名） */
export const IDENTITY_ACTION_IDS: ActionIdResolver = {
  unit: (id) => id,
  point: (id) => id,
  dump: (id) => id,
  base: (id) => id,
  formation: (id) => id,
}

const cmpText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const keyOf = (resolver: (id: string) => string, id: string): string => resolver(id)

function hexOf(hex: { col: number; row: number } | null): string {
  return hex === null ? 'none' : hexKeyOf(hex)
}

function pathOf(
  ids: ActionIdResolver,
  unitId: string,
  path: readonly { col: number; row: number }[],
): string {
  return `${ids.unit(unitId)}@${path.map(hexKeyOf).join('>')}`
}

/**
 * canonical key
 *
 * 约定：
 * - 不变的是 `kind` 前缀；参数按固定字段顺序拼接，分隔符只用于可读性，不承担反解；
 * - 数组参数（飞机列表、损失分摊、撤退路径）先按稳定别名排序，语义相同的动作得到同一 key；
 * - 所有 `unitId` / `pointId` / `dumpId` / `baseId` / `formationId` 都走 resolver。
 */
export function canonicalActionKeyOf(action: AiAction, ids: ActionIdResolver): string {
  switch (action.kind) {
    case 'answer':
      return `answer:${action.optionId}`
    case 'advance':
      return 'advance'
    case 'preset':
      return 'preset'
    case 'modeChange':
      return `modeChange:${keyOf(ids.unit, action.unitId)}`
    case 'reserveRelease':
      return `reserveRelease:${keyOf(ids.unit, action.unitId)}`
    case 'fuelPay':
      return `fuelPay:${keyOf(ids.unit, action.unitId)}`
    case 'moveBegin':
      return `moveBegin:${keyOf(ids.unit, action.unitId)}`
    case 'moveClick':
      return `moveClick:${hexOf(action.hex)}`
    case 'moveFinish':
      return 'moveFinish'
    case 'moveUndo':
      return 'moveUndo'
    case 'moveCancel':
      return 'moveCancel'
    case 'modeChangeTo':
      return `modeChangeTo:${keyOf(ids.unit, action.unitId)}:${action.mode}`
    case 'dumpBlow':
      return `dumpBlow:${keyOf(ids.dump, action.dumpId)}`
    case 'overrun':
      return `overrun:${hexOf(action.hex)}`
    case 'railMove':
      return `railMove:${keyOf(ids.unit, action.unitId)}:${hexOf(action.toHex)}`
    case 'railMoveSp':
      return `railMoveSp:${keyOf(ids.dump, action.dumpId)}:${String(action.amount)}:${hexOf(action.toHex)}`
    case 'transportLoad':
      return `transportLoad:${keyOf(ids.point, action.pointId)}:${String(action.amount)}`
    case 'transportUnload':
      return `transportUnload:${keyOf(ids.point, action.pointId)}:${String(action.amount)}`
    case 'constructionMarker':
      return `constructionMarker:${action.marker}:${hexOf(action.hex)}`
    case 'gaugeConvert':
      return `gaugeConvert:${keyOf(ids.unit, action.unitId)}:${hexOf(action.hex)}`
    case 'specialConfirm':
      return 'specialConfirm'
    case 'setupPreset':
      return 'setupPreset'
    case 'setupDraw':
      return 'setupDraw'
    case 'setupConfirm':
      return 'setupConfirm'
    case 'setupShiftPlace':
      return `setupShiftPlace:${keyOf(ids.formation, action.formationId)}`
    case 'refitBase': {
      const aircraft = [...action.aircraftIds].map((id) => ids.unit(id)).sort(cmpText)
      return `refitBase:${keyOf(ids.base, action.baseId)}:${aircraft.join(',')}:${keyOf(ids.dump, action.dumpId)}`
    }
    case 'arrivalRemovals':
      return 'arrivalRemovals'
    case 'arrivalPlace':
      return `arrivalPlace:${String(action.index)}:${hexOf(action.hex)}`
    case 'arrivalSkip':
      return `arrivalSkip:${String(action.index)}`
    case 'supplyArrivalPick':
      return `supplyArrivalPick:${hexOf(action.hex)}`
    case 'supplyArrivalGroup':
      return `supplyArrivalGroup:${action.hexText}:${action.group}`
    case 'supplyArrivals':
      return 'supplyArrivals'
    case 'supplyTrainGroup':
      return `supplyTrainGroup:${action.group}`
    case 'supplyTrainPlace':
      return `supplyTrainPlace:${hexOf(action.hex)}`
    case 'rebuild':
      return `rebuild:${action.mode}:${keyOf(ids.unit, action.unitId)}:${hexOf(action.hex)}`
    case 'consolidate':
      return `consolidate:${keyOf(ids.unit, action.keepId)}:${keyOf(ids.unit, action.removeId)}`
    case 'overstackDestroy':
      return 'overstackDestroy'
    case 'interceptAnswer':
      return 'interceptAnswer'
    case 'airMission':
      return `airMission:${action.aircraftId === null ? 'none' : keyOf(ids.unit, action.aircraftId)}:${hexOf(action.target)}`
    case 'barrageTarget':
      return `barrageTarget:${hexOf(action.hex)}`
    case 'barrageToggleUnit':
      return `barrageToggleUnit:${keyOf(ids.unit, action.unitId)}`
    case 'barrageBegin':
      return 'barrageBegin'
    case 'barrageSupply':
      return `barrageSupply:${action.dumpId === null ? 'none' : keyOf(ids.dump, action.dumpId)}`
    case 'barrageShifts':
      return 'barrageShifts'
    case 'barrageDice':
      return 'barrageDice'
    case 'barrageOutcome': {
      const losses = action.losses
        .map((loss) => `${ids.unit(loss.unitId)}:${String(loss.steps)}`)
        .sort(cmpText)
      return `barrageOutcome:${losses.join(',')}`
    }
    case 'barrageCancel':
      return 'barrageCancel'
    case 'combatSelect':
      return `combatSelect:${hexOf(action.hex)}`
    case 'combatBegin':
      return 'combatBegin'
    case 'combatSupply':
      return [
        'combatSupply',
        action.side,
        action.attackerDumpId === null ? 'none' : keyOf(ids.dump, action.attackerDumpId),
        action.defenderDumpId === null ? 'none' : keyOf(ids.dump, action.defenderDumpId),
        action.attackerUsesInternalStocks === true ? '1' : '0',
        action.defenderUsesInternalStocks === true ? '1' : '0',
      ].join(':')
    case 'combatDeclareAr':
      return `combatDeclareAr:${action.side}`
    /* 9.6 选择步：key 里带稳定 id（`ids.unit` 会把运行时实例 id 换成 `u:side:library:n`） */
    case 'combatArUnit':
      return `combatArUnit:${action.side}:${ids.unit(action.unitId)}`
    case 'combatLossTaker':
      return `combatLossTaker:${action.unitId === null ? 'canonical' : ids.unit(action.unitId)}`
    case 'combatAutoResolve':
      return 'combatAutoResolve'
    case 'combatLosses':
      return 'combatLosses'
    case 'combatOptions':
      return `combatOptions:${String(action.retreatHexes)}:${String(action.lossPoints)}:${action.ignoreOptions ? '1' : '0'}`
    case 'combatRetreatPaths': {
      const paths = action.paths.map((entry) => pathOf(ids, entry.unitId, entry.path)).sort(cmpText)
      return `combatRetreatPaths:${paths.join(';')}`
    }
    case 'combatAdvance':
      return 'combatAdvance'
    case 'combatSkip':
      return 'combatSkip'
    case 'supplyPlan':
      return 'supplyPlan'
    case 'supplyRecovery':
      return 'supplyRecovery'
    case 'supplyFeeding':
      return 'supplyFeeding'
    case 'attritionRoll':
      return `attritionRoll:${action.key}`
    case 'attritionApply': {
      const allocation = action.allocation
        .map((entry) => `${ids.unit(entry.unitId)}:${String(entry.steps)}`)
        .sort(cmpText)
      return `attritionApply:${action.key}:${allocation.join(',')}`
    }
    case 'wait':
      return 'wait'
    case 'none':
      return 'none'
  }
}
