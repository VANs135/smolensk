import type { CombatLine } from '@/engine/rules'

export interface CombatInputs {
  /** 12.4：攻方本阶段可动用的 T（SP 与可动用部队储备之和） */
  attackerAvailableT: number
  /**
   * 12.10a：攻方是否**动用部队储备**补齐图上补给的缺口
   *
   * 勾上后由 `planCombatSupplyFunding` 逐单位定"图上付 / 储备付"：图上能全额付清的单位**必须**
   * 走图上（12.10a），付不清的改用储备并按 12.10b 降一级标记；已耗尽者无法再用（12.10c）
   * ⇒ 整笔拒绝（12.4：付不出全额就不能攻击）。
   */
  attackerUsesInternalStocks: boolean
  /** 9.5-B：守方是否愿意支付战斗补给（不付 ⇒ 以一半战斗值防御） */
  defenderProvides: boolean
  /** 12.4：守方本阶段可动用的 T */
  defenderAvailableT: number
  /** 12.10a：守方是否动用部队储备（口径同攻方） */
  defenderUsesInternalStocks: boolean
  /** 9.6：攻方 AR 草稿选择；正式公开声明由 CombatInteractionState 单独保存。 */
  attackerArUnitId: string | null
  /** 9.6：守方 AR 草稿选择（null＝未选择）。 */
  defenderArUnitId: string | null
  /** 9.4b：逐攻击堆叠地形（键＝`列.行`；缺项＝沿用守方格地形） */
  stackTerrain: Record<string, { kind: 'hex' | 'hexside'; terrain: string }>
  /** 9.4c：守方防御地形（决定战斗表横行） */
  defenderTerrain: string
  /** 9.10a：选项 —— 撤退格数 */
  optionRetreatHexes: number
  /** 9.10a：选项 —— 以军力损失满足的点数 */
  optionLossPoints: number
  /**
   * 9.11a/9.11c（第五批 A3）：选项损失的**逐单位分配**（unitId → 点数；全 0/缺省＝按规范分配）。
   * 给出正数时由引擎按 `validateBattleLossAllocation` 严格校验（AR 先受第一点、均匀展开）。
   */
  optionLossAllocation: Record<string, number>
  /** 9.10c：守方行使「忽略选项」（仅当 9.10c 给予该权利时合法） */
  ignoreOptions: boolean
  /** 9.12：撤退路径（unitId → `列.行,...`，**不含起始格**；长度＝完整撤退距离） */
  retreatPaths: Record<string, string>
  /** 9.12e：额外 1 点军力损失的承受者（从候选 DG 单位中选） */
  /** 9.11a（批 F 切片 2）：把"多受的那一点"改派给这一枚（null＝按规范分配） */
  lossTakerId: string | null
  extraLossTakerId: string | null

  /** 9.12g：战后推进单位 id（常规战斗可空＝不推进） */
  advanceUnitIds: string[]
}

/** C6：本场战斗的初始输入（未臆造任何数值：可用 T 由玩家填入 / 由演示补给池带入） */
export function createCombatInputs(): CombatInputs {
  return {
    attackerAvailableT: 0,
    attackerUsesInternalStocks: false,
    defenderProvides: true,
    defenderAvailableT: 0,
    defenderUsesInternalStocks: false,
    attackerArUnitId: null,
    defenderArUnitId: null,
    stackTerrain: {},
    defenderTerrain: '',
    optionRetreatHexes: 0,
    optionLossPoints: 0,
    optionLossAllocation: {},
    ignoreOptions: false,
    retreatPaths: {},
    lossTakerId: null,
    extraLossTakerId: null,
    advanceUnitIds: [],
  }
}

/**
 * C7：一次轰炸里的玩家输入（界面 v-model 绑定）
 *
 * 纪律同 C6：本项**只承载玩家的选择**，不含任何规则结论；横移、成本、结果一律由引擎裁决
 * （`barrage-interaction.ts` 的 10.0 通用流程状态机）。
 */
export interface BarrageInputs {
  /** 10.1b：轰炸方可动用的 T（只能来自 SP：同一 HQ 或同一 dump，不含部队储备） */
  availableT: number
  /** 10.1b-A：补给是否来自同一指挥部 */
  fromSameHq: boolean
  /** 10.1b-A：不用指挥部时是否来自同一补给站 */
  fromSameDump: boolean
  /** 10.1b-C：是否动用了部队储备（明令禁止） */
  usedInternalStocks: boolean
  /** 10.0b：是否有正确的观察员（由 `createBarrageFacts` 填，界面只读） */
  hasSpotter: boolean
  /** 10.0a：**目标玩家**选择的地形线（'' = 未选，按不移处理） */
  terrainLine: CombatLine | ''
  /** 10.0e-A：该格本阶段是否已被轰炸过 */
  hexAlreadyBarragedThisPhase: boolean
  /** 10.0b/C：本次是否为低空扫射（须有正确观察员） */
  hipShoot: boolean
  /** 10.0：轰炸骰（战斗单位 2d6 之和；设施 1d6） */
  die: number | null
  /** 10.0a：`1/2` 的取整骰（1–6） */
  halfDie: number | null
  /** 10.0a：损失分配（unitId → 军力点数） */
  losses: Record<string, number>
  /* ── 10.0c 对设施 ── */
  /** 10.0c-A：空军基地当前等级 */
  baseLevel: number
  /** 10.0c-A：目标是否为简易机场（永不降级） */
  isAirstrip: boolean
  /** 10.0c-B：港口既有累计伤害（0–4） */
  portDamageBefore: number
  /** 10.0c-A：格内每架飞机的掷骰（unitId → 1d6） */
  aircraftRolls: Record<string, number>
}

/** C7：本次轰炸的初始输入（数值一律由玩家填入，界面不代猜） */
export function createBarrageInputs(): BarrageInputs {
  return {
    availableT: 0,
    fromSameHq: true,
    fromSameDump: false,
    usedInternalStocks: false,
    hasSpotter: false,
    terrainLine: '',
    hexAlreadyBarragedThisPhase: false,
    hipShoot: false,
    die: null,
    halfDie: null,
    losses: {},
    baseLevel: 1,
    isAirstrip: false,
    portDamageBefore: 0,
    aircraftRolls: {},
  }
}
