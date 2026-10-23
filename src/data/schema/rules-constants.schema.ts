import { z } from 'zod'

import { DataFileMetaSchema, IsoDateSchema, RailGaugeSchema } from './common.schema'

/**
 * rules-constants.json 契约 v2（A9 全量规则常量）
 *
 * 本文件是整个引擎的数值唯一来源：engine/rules 模块引用此处冻结值，
 * 业务代码禁止出现数字字面量。每个数值均须能对应到规则编号（见字段 JSDoc）。
 */

/** 轰炸密度列移步骤：目标 RE 超过 maxRe 时采用该 shift；maxRe 为空表示无上限档 */
export const DensityStepSchema = z
  .object({
    maxRe: z.number().positive().nullish(),
    shift: z.number().int(),
  })
  .strict()

/**
 * 胜利条件的一档阈值（5.0a / 5.0b / 剧本 2·4 例外）
 *
 * `scenarios` 声明该档适用的剧本号——规则书表 4-1 与技能 ch11 参考表都按剧本号分档，
 * 故把「哪些剧本用哪一档」一并落在数据里，引擎不写死剧本号。
 */
export const VictoryTierSchema = z
  .object({
    /** 苏方须控制的清单格数（如 5.0a 的 ≥7） */
    sovietListedHexes: z.number().int().nonnegative(),
    /** 轴方须控制的清单格数（如 5.0a 的 ≥6） */
    axisListedHexes: z.number().int().nonnegative(),
    /** 适用剧本号 */
    scenarios: z.array(z.string().min(1)),
  })
  .strict()

/** 补给与储备（12.0 章） */
export const SupplySectionSchema = z
  .object({
    /** 1 SP = 4 T（3.3a / 12.1a） */
    spToT: z.number().int().positive(),
    /** 图上补给：1 T 对应 2 RE，向上取整（12.6c） */
    tracePerTwoReT: z.number().int().positive(),
    /** 图上补给的 RE 除数（12.6c：每 2 RE 计 1 T，与 tracePerTwoReT 成对使用） */
    traceRePerT: z.number().int().positive(),
    /** 延补队新建：消耗同型运输点的半个 MA（12.7） */
    extenderCreationMaFraction: z.number().positive(),
    /** 战斗补给：攻方每军力 1 T（9.5 / 12.4） */
    combatAttackerTPerStep: z.number().int().positive(),
    /** 战斗补给：守方 2 T（9.5 / 12.4） */
    combatDefenderT: z.number().int().positive(),
    /** 战斗补给：守方总 RE ≤ 1 时 1 T */
    combatDefenderMinT: z.number().int().positive(),
    /** 直接拖取距离上限（MP，12.3a） */
    directDrawRangeMp: z.number().int().positive(),
    /** 部队储备「低」：每 RE 2 T（12.10e；多军力单位的恢复基准） */
    stockLowTPerRe: z.number().int().positive(),
    /** 部队储备「低」：每单位基准 T（12.10e；单军力单位按此计） */
    stockLowTPerUnit: z.number().int().positive(),
    /** 部队储备「耗尽」：恢复成本为「低」的倍数（12.10e：「两倍的补给」） */
    stockExhaustedMult: z.number().int().positive(),
    /** 损耗表掷骰修正（12.8b：格中断补军力 ≥ minSteps 时 +modifier） */
    attritionDrm: z
      .object({
        minSteps: z.number().int().positive(),
        modifier: z.number().int(),
      })
      .strict(),
    /** 延补队运输点数：5（12.7d） */
    extenderTransportPoints: z.number().int().positive(),
    /** 突围判定距离：最近补给 15 格（12.8e-B） */
    breakoutRangeHexes: z.number().int().positive(),
    /** 突围掷骰：断补首回合 +1（12.8e） */
    breakoutFirstTurnDrm: z.number().int(),
    /** 突围资格：印刷 MA 至少为 1（12.8e） */
    breakoutMinPrintedMa: z.number().int().nonnegative(),
    /** 突围成功的最低修正骰（12.8e：掷骰 5–6 成功 ⇒ 阈值 5） */
    breakoutSuccessMinDice: z.number().int().positive(),
    /** 补给站爆破：骰面值段 → 损失百分比（12.11a，键如 `1` / `2-3` / `4-5` / `6`） */
    dumpBlowPct: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict()

/** 燃料（12.5） */
export const FuelSectionSchema = z
  .object({
    /** 多单位编队加油：1 SP（12.5c） */
    formationSp: z.number().int().positive(),
    /** HQ 加油：1 SP */
    hqSp: z.number().int().positive(),
    /** 独立单位加油：1 T */
    singleUnitT: z.number().int().positive(),
  })
  .strict()

/** 补员与重建（13.5 / 专规 1.6 Notes） */
export const ReplSectionSchema = z
  .object({
    /** 13.5e：每辆卡车重建消耗的装备补员点数（1 点 Eq/辆） */
    truckRebuildEquipment: z.number().int().positive(),
    /** 专规 1.6 Notes：Ftr / Tac 补员每次只补的 step 数（1） */
    airReplStepsPerCounter: z.number().int().positive(),
    /** 13.5a：重建补员所在的格须在友好 HQ 的几格内（含该数，2） */
    rebuildHqRangeHexes: z.number().int().positive(),
  })
  .strict()

/** 拆分单位与合并（20.0 / 13.9） */
export const BreakdownSectionSchema = z
  .object({
    /** 20.0：母单位创建拆分单位所需的最少军力（最后一点军力永远不能创建 ⇒ 2） */
    minParentStepsToCreate: z.number().int().min(2),
    /** 20.0f：拆分单位的规模（1 RE） */
    breakdownRe: z.number().int().positive(),
    /** 20.0f：拆分单位的军力（1 点） */
    breakdownSteps: z.number().int().positive(),
  })
  .strict()

/** 模式倍率与修正（5.0 章） */
export const ModesSectionSchema = z
  .object({
    /** 混乱：行动值 -1（5.10b） */
    dgArMod: z.number().int(),
    /** 混乱：战斗值 ×1/2 */
    dgCombatMult: z.number().positive(),
    /** 混乱：移动力 ×1/2 */
    dgMaMult: z.number().positive(),
    /** 混乱：轰炸值 ×1/2 */
    dgBarrageMult: z.number().positive(),
    /** 战略模式：移动力 ×2（5.8） */
    stratMaMult: z.number().positive(),
    /** 预备模式：防御 ×1/2（5.7） */
    reserveDefendMult: z.number().positive(),
    /** 预备模式：常规阶段释放移动 ×1/4 */
    reserveMaNormalMult: z.number().positive(),
    /** 预备模式：反应阶段释放移动 ×1/2 */
    reserveMaReactionMult: z.number().positive(),
    /** 预备模式：进击阶段释放移动 ×1 */
    reserveMaExploitMult: z.number().positive(),
    /** 进击模式：移动 ×1/2（5.9） */
    exploitMaMult: z.number().positive(),
  })
  .strict()

/** 移动、堆叠与铁路（6.0 / 4.6 / 4.8 / 13.3） */
export const MovementSectionSchema = z
  .object({
    /** 最小移动：MA>0 至少 1 格（6.1c） */
    minimumMoveHexes: z.number().int().positive(),
    /** 堆叠上限（RE，4.8） */
    stackingLimitRe: z.number().int().positive(),
    /** 分销 RE：营 0.5（4.6） */
    reScaleBattalion: z.number().positive(),
    /** 分销 RE：补员或连 0.25 */
    reScaleReplacement: z.number().positive(),
    /** 装载/卸载：各耗 MA 的 10%（13.2f） */
    loadingCostFraction: z.number().positive().max(1),
    /** 每移动阶段轨道转换上限（格，13.3g） */
    railConversionMaxPerPhase: z.number().int().positive(),
    /** 13.3e-1：登车前最多可消耗的 MA 比例（半个 MA） */
    railPreLoadMaFraction: z.number().positive().max(1),
    /** 4.7b：运输当量减半的「短腿」步行 MA 下界（含） */
    railShortLegMaMin: z.number().int().positive(),
    /** 4.7b：运输当量减半的「短腿」步行 MA 上界（含） */
    railShortLegMaMax: z.number().int().positive(),
    /** 4.7b：短腿单位的运输当量倍率（1/2） */
    railShortLegEquivalentMultiplier: z.number().positive().max(1),
    /** 13.3a：路径含运输破坏区 ⇒ 铁路容量费用加倍 */
    railTrainbustingMultiplier: z.number().positive(),
    /** 13.3a：路径全程多轨 ⇒ 铁路容量费用减半 */
    railMultiTrackMultiplier: z.number().positive(),
    /** 边缘盒进入费用：1 MP 或 1 铁路容量点（专规 1.4b） */
    edgeBoxEntryMp: z.number().int().positive(),
  })
  .strict()

/** 战斗与特殊战斗（9.0 章） */
export const CombatSectionSchema = z
  .object({
    /** 突袭：3 MP 门槛（8.1a） */
    overrunMpCost: z.number().int().positive(),
    /** 突袭：进入目标格的 MP 消耗上限（格内＋格边＋运输破坏之和，8.1b；超限或地形为 All 则不可突袭） */
    overrunMaxEntryMp: z.number().int().positive(),
    /** 环工事：奇袭掷骰 -1（9.8） */
    hedgehogSurpriseDrm: z.number().int(),
    /** 撤退 2+ 格即混乱（9.12） */
    retreatDgMinHexes: z.number().int().positive(),
    /** 空军基地夺取：2d6 ≥ 7 无损失（9.14f） */
    airBaseCaptureNoLossMinDice: z.number().int().positive(),
    /** 空军基地夺取的掷骰修正（9.14f 表下注：+2 该机 Active；+2 由战后推进夺取） */
    airBaseCaptureDrm: z
      .object({
        active: z.number().int(),
        byAdvanceAfterCombat: z.number().int(),
      })
      .strict(),
  })
  .strict()

/** 轰炸（10.0 章） */
export const BarrageSectionSchema = z
  .object({
    /** 单任务最多 4 机（10.0） */
    maxAircraftPerMission: z.number().int().positive(),
    /** 上表最低轰炸值 1（10.0） */
    minBarrageValue: z.number().int().positive(),
    /** 无观察员：左移 3 列（10.0b） */
    noSpotterShiftLeft: z.number().int().positive(),
    /** 距基地 10 格内自动右移 1（10.2b / 14.7c） */
    shortRangeHexes: z.number().int().positive(),
    /**
     * 密度统计的单「师/编队」上限（10.0a）
     *
     * 「单独一个师（即使是多单位编队）在计算单位密度的横移时，永远不会算作超过 3RE；
     *   如果少于 3RE 则使用实际数量」——注意这是**统计口径**，不是「≤3 RE 不移列」的阈值：
     * 密度列移一律查 `densityShifts`（1 RE 及以下为左移 1 列）。
     */
    densityCapRe: z.number().positive(),
    /** 密度列移步骤表（10.0a 表；正 = 右移，负 = 左移） */
    densityShifts: z.array(DensityStepSchema).min(2),
    /**
     * 其它列横移（10.0a 表下的「额外横移」，均正 = 右移 / 负 = 左移）
     *
     * 来源：中文辅助卡第 4 页轰炸表附注（与英文原版逐项一致）：
     *   - 存在**任意等级**环形工事 ⇒ 左移 1 列；
     *   - 目标格中**任何单位为战略模式** ⇒ 右移 3 列；
     *   - 所有飞机在其基地 **10 格及以内** ⇒ 右移 1 列（10.2b）；
     *   - 地形（**由目标玩家选择**）：复杂/非常复杂 ⇒ 左移 1 列，极端复杂 ⇒ 左移 2 列。
     */
    columnShifts: z
      .object({
        hedgehogAnyLevel: z.number().int(),
        stratModeInHex: z.number().int(),
        allAircraftInShortRange: z.number().int(),
        terrainByCombatLine: z.record(z.number().int()),
      })
      .strict(),
    /** `[1/2]` 视同 DG 的环形工事等级下限（10.0a：等级 3 或 4） */
    bracketHedgehogMinLevel: z.number().int().positive(),
    /** `1/2` 掷取整骰时损 1 步的最低骰值（10.0a：4-6 损 1 步并 DG，否则只 DG） */
    halfResultStepLossMinDie: z.number().int().positive(),
  })
  .strict()

/** 空军与空军基地（14.0 / 15.0 章） */
export const AirSectionSchema = z
  .object({
    /** 飞机军力 2（14.1b） */
    aircraftSteps: z.number().int().positive(),
    /** 整备：每基地 1 T（15.1） */
    refitTPerBase: z.number().int().positive(),
    /** 整备：每级每回合 2 架 */
    refitAircraftPerLevel: z.number().int().positive(),
    /** 卸载容量：每移动环节每级 2 T（15.0b / 14.9f） */
    unloadTPerLevelPerPhase: z.number().int().positive(),
    /** Active 堆叠上限：4 + 等级（14.2a） */
    activeStackingBase: z.number().int().nonnegative(),
    /** 巡逻区最大距离（格，14.4c） */
    patrolZoneMaxHexes: z.number().int().positive(),
    /** 防空击落：修正后 2d6 ≥ 11（14.4e） */
    flakKillMinDice: z.number().int().positive(),
    /** 空战：修正 2d6 ≤ 6 攻方退出（14.3e） */
    airCombatAttackerAbortMaxDice: z.number().int().positive(),
    /** 空战：= 7 双方退出 */
    airCombatBothAbortDice: z.number().int().positive(),
    /** 空战：≥ 8 守方退出 */
    airCombatDefenderAbortMinDice: z.number().int().positive(),
    /** 空战分出胜负后的损失骰：1–4 无损失（14.3e） */
    airCombatLossNoLossMaxDice: z.number().int().positive(),
    /** 空战损失骰：5–6 军力损失 */
    airCombatLossStepLossMinDice: z.number().int().positive(),
    /** Active 堆叠：每级 +1（14.2a，配合 activeStackingBase=4） */
    activeStackingPerLevel: z.number().int().nonnegative(),
    /** 基地防空值：每级 +1（15.0b，基地防空值 = 等级） */
    baseAaPerLevel: z.number().int().nonnegative(),
    /** 简易机场防空值（15.0b：简易机场 = 0） */
    airstripAaValue: z.number().int().nonnegative(),
    /** 计划空降须提前回合数（14.10b：提前 2 回合书面计划） */
    paradropPlanningTurnsAdvance: z.number().int().positive(),
    /** 防空修正（14.4e，加在防空 2d6 上；基地等级与印刷防空值按动态值另计） */
    flakModifiers: z
      .object({
        missionThreePlusAircraft: z.number().int(),
        targetHasHQ: z.number().int(),
        airBaseLevelPerLevel: z.number().int(),
        inEnemyPatrolZoneWithFighter: z.number().int(),
        inEnemyPatrolZoneNoFighter: z.number().int(),
        trainbustingInPatrolZone: z.number().int(),
      })
      .strict(),
    /** 防空适用任务（14.4e）：always 恒适用 / onlyInPatrolZone 仅巡逻区内 / never 不适用 */
    flakApplies: z
      .object({
        always: z.array(z.string()).min(1),
        onlyInPatrolZone: z.array(z.string()),
        never: z.array(z.string()),
      })
      .strict(),
    /**
     * 空运/空投成功表（14.10d，表 17-4）：四类最低骰 + 表内修正
     *
     * ★ 表 17-4 的 DRM 只有三项：苏军空投 −1、滑翔机降落 +1、[可选 21.12e] 地形 −1/−2。
     *   （「+2 Active / +2 战后推进夺取」属于**表 17-6 空军基地夺取**，见 `combat.airBaseCaptureDrm`）
     */
    airTransportSuccess: z
      .object({
        friendlyClearMin: z.number().int().positive(),
        friendlyClosedMin: z.number().int().positive(),
        enemyClearMin: z.number().int().positive(),
        enemyClosedMin: z.number().int().positive(),
        sovietAirdropDrm: z.number().int(),
        gliderDrm: z.number().int(),
        optional21_12eVeryCloseDrm: z.number().int(),
        optional21_12eExtrCloseDrm: z.number().int(),
      })
      .strict(),
  })
  .strict()

/** 建设与设施（15.2 / 15.3 / 16.0 / 专规 1.3） */
export const ConstructionSectionSchema = z
  .object({
    /** 环形工事可建最高等级：**本作 1**（专规 1.3b「任何一方都不得把工事改进到 1 级以上」，覆盖通规 16.0a 的 4 级刻度） */
    hedgehogMaxLevel: z.number().int().positive(),
    /** 环形工事：每级 2 SP（16.0b） */
    hedgehogCostSpPerLevel: z.number().int().positive(),
    /** 环形工事：每回合 ±1 级（16.0b / 16.0c） */
    hedgehogLevelsPerTurn: z.number().int().positive(),
    /** 地图印刷永久工事等级（专规 1.3a：永久且不可降低） */
    printedHedgehogLevel: z.number().int().positive(),
    /** 工程作业半径（格，13.8d：2 格；地形按**步行 MP** 计，无视敌方 ZOC） */
    constructionRadiusHexes: z.number().int().positive(),
    /** 施工执行者的最低 RE（16.0b/c、15.4：「1 RE 的单位」；具工程能力者可替代，见 13.8d） */
    minBuilderRe: z.number().int().nonnegative(),
    /** 空军基地最高等级 3（15.0） */
    airBaseMaxLevel: z.number().int().positive(),
    /** 空军基地最低等级 1（15.0c / 15.4：任何空军基地不得低于 1 级） */
    airBaseMinLevel: z.number().int().positive(),
    /** 空军基地修建：每级 1 SP（15.3） */
    airBaseCostSpPerLevel: z.number().int().positive(),
    /** 空军基地：每回合最多 ±1 级 */
    airBaseLevelsPerTurn: z.number().int().positive(),
    /** 简易机场修建：1 T（15.2） */
    airstripBuildT: z.number().int().positive(),
    /** 简易机场升级：3 T */
    airstripUpgradeT: z.number().int().positive(),
    /** 简易机场每整备阶段只能整备 1 架（15.2B） */
    airstripRefitAircraft: z.number().int().positive(),
  })
  .strict()

/** Smolensk 专规数值（专规 1.0–5.0，含勘误覆盖） */
export const SmolenskSectionSchema = z
  .object({
    /** 轴方空军盒任务射程 30 格（1.4a） */
    entryRangeAxisHexes: z.number().int().positive(),
    /** 苏方空军盒任务射程 20 格 */
    entryRangeSovietHexes: z.number().int().positive(),
    /** 边缘盒内可追溯补给（1.4b） */
    edgeBoxTraceSupply: z.boolean(),
    /** 方面军预备队每次 2 SP（2.3c，勘误覆盖） */
    frontalReservesSp: z.number().int().positive(),
    /** 方面军预备队三批（2.3c + 苏方到达卡）：批次含 2 SP + 一次编制转化 + 两次免费重建 */
    frontalReserves: z
      .object({
        source: z.string(),
        batches: z.array(
          z.object({
            date: IsoDateSchema,
            sp: z.number().int().positive(),
            convertFrom: z.string().min(1),
            convertTo: z.string().min(1),
            freeRebuilds: z.array(z.string().min(1)),
          }),
        ),
      })
      .strict(),
    /** 慢动员（2.4 表 2-2）：按日期释放各集团军的师数 */
    slowMobilization: z
      .object({
        source: z.string(),
        table: z.array(
          z.object({
            date: IsoDateSchema,
            army: z.enum(['30th', '28th', '24th']),
            unlockDivisions: z.number().int().positive(),
          }),
        ),
      })
      .strict(),
    /** 补给缓存：每方每剧本开局 2 枚（1.7） */
    supplyCachePerSide: z.number().int().positive(),
    /** 21.10 Shells：一枚补给缓存抵付的火炮轰炸成本（T） */
    supplyCacheShellsT: z.number().int().positive(),
    /** 1.8a：拆解单位（拆分团）的算子上限，按 AR 分档 */
    counterLimits: z
      .object({
        source: z.string(),
        axisBreakdown: z.array(
          z.object({ ar: z.number().int().nonnegative(), count: z.number().int().nonnegative() }),
        ),
        sovietBreakdown: z.array(
          z.object({ ar: z.number().int().nonnegative(), count: z.number().int().nonnegative() }),
        ),
      })
      .strict(),
    /** 随机事件期起（3.6，含 1.6b 前置） */
    randomEventFrom: IsoDateSchema,
    /** 随机事件期止 */
    randomEventTo: IsoDateSchema,
    /** 铁路容量提升日（1.2：轴 0→1、苏 2→3） */
    railCapBoostDate: IsoDateSchema,
    /** 提升前铁路容量：{axis:0, soviet:2}（1.2，勘误覆盖） */
    railCapBefore: z.object({
      axis: z.number().int().nonnegative(),
      soviet: z.number().int().nonnegative(),
    }),
    /** 提升后铁路容量：{axis:1, soviet:3} */
    railCapAfter: z.object({
      axis: z.number().int().nonnegative(),
      soviet: z.number().int().nonnegative(),
    }),
    /**
     * 专规 1.2：轨距 —— 回答「**谁能用**这条铁路」，与 13.3a「多轨减半」的**地形**口径分开
     *
     * 「铁路线始终处于两种轨距之一，宽轨或标准轨。**最初除剧本初设另有注明者外，全部为宽轨**。
     *  就铁路运货**与获得追溯补给**而言：苏方**只能**使用宽轨铁路，轴方**只能**使用标准轨铁路。
     *  玩家用铁路修理单位按 OCS 13.3f 改变这些线路的轨距。」
     *
     * ★ `printed`＝地图**印刷**初设轨距（与 map-layers.json 顶层 railGauge 同值，互为印证）；
     *   `usableBySide`＝各方**可用**的轨距。13.3f 换轨改变的是**逐格**的已转换状态，
     *   **不**改本表 —— 本表是规则常量，逐格状态属运行期账本。
     */
    railGauge: z.object({
      printed: RailGaugeSchema,
      usableBySide: z.object({ axis: RailGaugeSchema, soviet: RailGaugeSchema }),
    }),
    /** 可变撤离检查开始日（3.3c） */
    variableExitStart: IsoDateSchema,
    /** 可变撤离表：掷 1 骰查（3.3c）；键为骰面值段，值为结果描述 */
    variableExitTable: z.record(z.string(), z.string()),
    /** 提前决胜检查开始日（5.0b） */
    earlyDecisionStart: IsoDateSchema,
    /** 特殊补员截止日（1.6c） */
    specialReplEndDate: IsoDateSchema,
    /** 古德里安与霍特约束失效日（3.4） */
    panzerGroupConstraintEnd: IsoDateSchema,
    /**
     * 苏军可进入战略模式的起始日（专规 2.3e：8 月 1 日回合之前苏军不得进入战略模式，也不得修建环形工事）
     *
     * 这是**专规覆盖**：通规 5.8 本身不限制阵营。故引擎判定「能否进入战略模式」时须同时读本项。
     */
    sovietStratModeFrom: IsoDateSchema,
    /** 苏军可建环形工事的起始日（2.3e：「苏军单位在 8 月 1 日回合之前不能修建环形工事」） */
    sovietHedgehogBuildFrom: IsoDateSchema,
    /** 轴方建造标记的初设枚数（3.5：剧本 1/2 初设 3 枚，每枚只能用一次） */
    constructionMarkersPerSetup: z.number().int().nonnegative(),
    /** 补给源关闭（2.1a：Entry L / 南缘西段） */
    supplyShutdown: z
      .object({
        entryL: IsoDateSchema,
        southSources: IsoDateSchema,
      })
      .strict(),
    /**
     * 胜利条件阈值（5.0a 最终 / 5.0b 提前决胜 / 剧本 2·4 明文例外）
     *
     * 三档各自声明**适用剧本号**（规则书表 4-1 与玩家技能 ch11 的参考表）：
     * 5.0a/5.0b 列 1/3/5/6/7，剧本 2·4 用特例终局阈值（其列表未列 5.0b）。
     */
    victory: z
      .object({
        source: z.string(),
        final: VictoryTierSchema,
        decisive: VictoryTierSchema,
        scenario2And4: VictoryTierSchema,
      })
      .strict(),
    /** 天气掷骰（专规 1.5 / 图表 weather 表）：掷 1 骰，1=受限飞行，2–6=正常飞行；地面天气恒好 */
    weather: z
      .object({
        dieCount: z.number().int().positive(),
        limitedFlightMaxDice: z.number().int().positive(),
        normalFlightMinDice: z.number().int().positive(),
        groundAlwaysGood: z.boolean(),
      })
      .strict(),
    /**
     * 专规空军覆盖（**覆盖通规 14.x/15.x 的对应项**）
     *
     * - 苏联（专规 2.2「Red Air Force」）：禁低空扫射 2.2a / 禁计划空降 2.2b /
     *   禁反应·进击阶段任务 2.2c / 早期 IL-2 单军力 2.2d
     * - 轴心（专规 3.2a）：天气允许时可低空扫射
     */
    air: z
      .object({
        soviet: z
          .object({
            noHipShoot: z.boolean(),
            noPlannedAirdrop: z.boolean(),
            noReactionOrExploitationMission: z.boolean(),
            il2SingleStep: z.boolean(),
          })
          .strict(),
        axis: z
          .object({
            hipShootWhenWeatherPermits: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    /**
     * 地图外盒（专规 1.4）
     *
     * 1.4 总则：盒内不允许战斗或轰炸（双方同意可为额外战雾隐藏盒内内容）。
     * 1.4a 空军盒（Red Air Force Box / Luftwaffe Box）：无限驻机容量、每回合免费整备任意架数、
     *      盒内另有「额外」SP 可经空运任务飞入地图；射程见 entryRange*Hexes。
     * 1.4b 边缘盒（Northeast / Southeast Box）：仅苏方地面单位在移动阶段以 1 MP 或铁路容量进出；
     *      禁止撤退进出、不得在反应/进击阶段进出；盒内含追溯补给但**图上单位不得从中取补**；
     *      进入即停、离开时按「1T/单位」免费加注燃料。
     */
    offMapBox: z
      .object({
        /** 盒内不允许战斗或轰炸（1.4） */
        noCombatOrBarrage: z.boolean(),
        /** 图外空军盒（1.4a） */
        air: z
          .object({
            infiniteCapacity: z.boolean(),
            freeRefitPerTurn: z.boolean(),
          })
          .strict(),
        /** 边缘盒（1.4b） */
        edge: z
          .object({
            sovietOnly: z.boolean(),
            noRetreatEntryExit: z.boolean(),
            mustStopOnEntry: z.boolean(),
            exitFuelsFree: z.boolean(),
            onMapUnitsCannotDraw: z.boolean(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()

/**
 * 特殊战斗常量（通规 9.14）
 *
 * 9.14b 补给站：夺取部分归进入方，**其余被摧毁**（不做位移）。
 * 9.14c 运输点数：夺取部分归进入方，**其余由原主位移**——「有点像撤退」，位移落点由**玩家选择**；
 *       位移上限取自原文示例「转移到最远 10 格的地方」。
 * 9.14d 延补队：必须崩溃（位移到「特殊拖取距离」内**且有追溯补给**的任意格，落点由玩家选择）。
 */
export const SpecialCombatSectionSchema = z
  .object({
    /** 9.14c：运输点位移的**格距上限**（原文示例：最远 10 格） */
    transportDisplaceMaxHexes: z.number().int().positive(),
  })
  .strict()

/** 规则常量文件整体 */
export const RulesConstantsSchema = z
  .object({
    meta: DataFileMetaSchema,
    supply: SupplySectionSchema,
    fuel: FuelSectionSchema,
    repl: ReplSectionSchema,
    breakdown: BreakdownSectionSchema,
    modes: ModesSectionSchema,
    movement: MovementSectionSchema,
    combat: CombatSectionSchema,
    barrage: BarrageSectionSchema,
    air: AirSectionSchema,
    construction: ConstructionSectionSchema,
    specialCombat: SpecialCombatSectionSchema,
    smolensk: SmolenskSectionSchema,
  })
  .strict()

export type RulesConstantsData = z.infer<typeof RulesConstantsSchema>
export type SupplySection = z.infer<typeof SupplySectionSchema>
export type FuelSection = z.infer<typeof FuelSectionSchema>
export type ReplSection = z.infer<typeof ReplSectionSchema>
export type BreakdownSection = z.infer<typeof BreakdownSectionSchema>
export type ModesSection = z.infer<typeof ModesSectionSchema>
export type MovementSection = z.infer<typeof MovementSectionSchema>
export type CombatSection = z.infer<typeof CombatSectionSchema>
export type BarrageSection = z.infer<typeof BarrageSectionSchema>
export type AirSection = z.infer<typeof AirSectionSchema>
export type ConstructionSection = z.infer<typeof ConstructionSectionSchema>
export type SpecialCombatSection = z.infer<typeof SpecialCombatSectionSchema>
export type SmolenskSection = z.infer<typeof SmolenskSectionSchema>
export type DensityStep = z.infer<typeof DensityStepSchema>
