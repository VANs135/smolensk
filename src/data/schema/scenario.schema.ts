import { z } from 'zod'

import { DataFileMetaSchema, HexRefSchema, SideSchema } from './common.schema'

/**
 * 剧本契约（scenarios.json，A8）
 *
 * 剧本差异仅靠四个旋钮：起止日期（起始态势）、随机化模式、后勤状态、胜利阈值；
 * 另含首次行动方与布设顺序（剧本 1、2 德军先行，3–7 反之，专规 Setup Notes A）。
 * 剧本 1-2 / 3-4 / 5-6 共用初设，以 inherits 指向被继承剧本。
 *
 * 本文件**不含单位位置**（见 scenario-setup.json），也不含到达表（见 arrivals-*.json）。
 */

/** 双方数值对（如 Reserve Markers / Rail Cap） */
export const SidePairSchema = z.object({
  axis: z.number().int(),
  soviet: z.number().int(),
})

/** 卡车满载方式（专规 Setup Notes：organic trucks） */
export const OrganicTrucksSchema = z
  .object({
    /** all_loaded 全部满载 / all_unloaded 全部空载 / choose_loaded 玩家自选 N 辆满载其余空载 */
    mode: z.enum(['all_loaded', 'all_unloaded', 'choose_loaded']),
    /** choose_loaded 时满载辆数 */
    count: z.number().int().nonnegative().optional(),
    /** 剧本原文（保留，便于校核） */
    raw: z.string(),
  })
  .strict()

/**
 * 编队抽取的一个组（W7 C12：剧本抽取盒）
 *
 * 规则出处：ch10 `Formation Chit Draw`（剧本 1/2）与 ch11 的「特殊规则与随机化」表
 * （剧本 3/4 = Move-Mode 5 个 + Mtr↔Aufk 5 个；剧本 5/6 = Krd 5 个 + Aufk 7 个）。
 * 三种处置：`shiftWest` 沿道路西移 / `moveMode` 全部战斗单位以 Move Mode 初设 /
 * `mtrAufkSwap` 摩托化团与死亡堆的侦察营互换 / `deadPileKrd`·`deadPileAufk` 把侦察营加入死亡堆。
 */
export const FormationDrawGroupSchema = z
  .object({
    kind: z.enum(['shiftWest', 'moveMode', 'mtrAufkSwap', 'deadPileKrd', 'deadPileAufk']),
    /** 该组抽取个数 */
    count: z.number().int().positive(),
    /** `shiftWest` 的西移格数 */
    shiftHexes: z.number().int().positive().optional(),
    label: z.string(),
    /** 规则出处（章节号或剧本页） */
    rule: z.string(),
    /** 处置的中文原文摘要 */
    effect: z.string(),
  })
  .strict()

export type FormationDrawGroup = z.infer<typeof FormationDrawGroupSchema>

/**
 * 编队抽取参数（剧本随机化；结构化自规则书，原文保留在 `formationDrawRaw`）
 *
 * 说明：**抽中的编队名单在规则原文里没有逐条列出**（入杯＝池成员，抽签决定），
 * 故本结构只给「池规模 + 各组数量 + 处置」，成员由引擎按 `formations.json` 推导，
 * 抽取结果由调用方用 rng 抽定（不预设名单）。
 */
export const FormationDrawSchema = z
  .object({
    /** 入杯总数（规则书给定的池规模） */
    pool: z.number().int().positive(),
    /** 池成员口径说明 */
    poolFrom: z.string(),
    /**
     * 入杯名单（Q3/Q7：由 `formations.json` 派生后**冻结为剧本数据**）
     *
     * 规则原文只给池规模、不逐条列名单；本字段给出冻结后的成员，引擎按名单取池，
     * 不再按番号后缀推导。`length` 必须等于 `pool`；每个 id 必须是该剧本轴方多单位编队。
     * 书写顺序不影响抽取：引擎取池后统一按 `formationId` 升序（`sortDrawPool`）。
     */
    poolFormations: z.array(z.string()).optional(),
    groups: z.array(FormationDrawGroupSchema),
    /** 'No Counterattack' 选项下每组只抽几个（ch10：各 2 个） */
    reducedCount: z.number().int().positive().optional(),
    /** 原文（保留，便于校核） */
    raw: z.string(),
    note: z.string().optional(),
  })
  .strict()

export type FormationDraw = z.infer<typeof FormationDrawSchema>

/**
 * 初设强制效果（规格 `docs/2026-11-10-剧本级初设强制效果-规格.md` §2）
 *
 * 只登记**剧本数据里真实声明过**的 kind：当前数据只有 `formationDraw` 一种
 * （剧本 1/3/5，剧本 2/4/6 经 `sharedSetupWith` 取源）。`applyStatus`（剧本 1 混乱）
 * 因原文缺失未落库，故此处不建空分支——新增 kind 时先有数据、再扩 schema 与注册表。
 *
 * 约束：`timing` 只允许 `afterSetupConfirm`、`once` 只允许 `perGame`（本批口径）；
 * `pool === poolFormations.length`（池规模与冻结名单必须对账）。
 */
export const FormationDrawEffectSchema = FormationDrawSchema.extend({
  kind: z.literal('formationDraw'),
  /** 稳定 id（写进台账 / 日志） */
  id: z.string().min(1),
  /** 执行时机：初设确认后 */
  timing: z.literal('afterSetupConfirm'),
  /** 每局只执行一次 */
  once: z.literal('perGame'),
  /** 条款出处（如 'ch10 / 剧本页'） */
  rule: z.string().min(1),
  /** 入杯名单（效果里必填：抽签池无安全默认） */
  poolFormations: z.array(z.string()),
})
  .strict()
  .refine((effect) => effect.pool === effect.poolFormations.length, {
    message: 'formationDraw.pool 必须等于 poolFormations.length（池规模与冻结名单对账）',
    path: ['pool'],
  })

/** 初设效果的联合（当前只有一支；加 `applyStatus` 前必须先有剧本数据） */
export const SetupEffectSchema = FormationDrawEffectSchema

export type FormationDrawEffect = z.infer<typeof FormationDrawEffectSchema>
export type SetupEffect = z.infer<typeof SetupEffectSchema>

/**
 * 飞机初设的激活规定（通规 IV Set Up Notes E 的默认 + 剧本页的明文覆盖）
 *
 * 规则出处：
 *   - 通规 **IV Set Up Notes E**：`Aircraft always begin Active.`（默认全部激活）；
 *   - 剧本页明文覆盖（逐字）：
 *     · 剧本 1 德军 `All planes must begin Inactive.`；
 *     · 剧本 1 苏军 `Half of the counters of each plane type (I.153, I.16, etc.) must begin
 *       Inactive. Round fractions up.`；
 *     · 剧本 3/5/7 德军同「每种机型半数非激活，小数向上取整」（机型举例随剧本页）；
 *     · 剧本 3/5/7 苏军剧本页**未述**激活态 ⇒ 按 IV-E 默认全激活（`statedInRules: false`）。
 *   - 剧本页 `"*" = one unit begins reduced` ⇒ 该型有一枚以**减损**状态初设（军力 −1）。
 *
 * 未列入本字段的方一律按 IV-E 默认（全激活）。
 */
export const AirSetupPolicySchema = z
  .object({
    /** all_active = IV-E 默认；all_inactive / half_inactive_round_up = 剧本页明文 */
    policy: z.enum(['all_active', 'all_inactive', 'half_inactive_round_up']),
    /** 剧本页用 `*` 标出的机型原文（保留原写法，引擎按归一名比对；匹配不上即记缺口） */
    reducedTypes: z.array(z.string()).optional(),
    /** 该方激活态是否为规则书**明文**规定（false = 剧本页未述，按 IV-E 默认） */
    statedInRules: z.boolean(),
    /** 剧本页原文（保留，便于校核） */
    raw: z.string(),
  })
  .strict()

export const AirSetupSchema = z
  .object({
    axis: AirSetupPolicySchema.optional(),
    soviet: AirSetupPolicySchema.optional(),
  })
  .strict()

export type AirSetup = z.infer<typeof AirSetupSchema>
export type AirSetupPolicy = z.infer<typeof AirSetupPolicySchema>

/**
 * 地图印刷工事的**剧本初始归属**（专规 1.3a + 本作裁定）
 *
 * 「地图印刷工事（58 处，永久且不可降低）视为一类**特殊工事单位**，按剧本初设定归属」：
 *   - 剧本 1（Smolensk Campaign）开局**全部属苏联**；
 *   - 剧本 3/5/7 按**德军推进线**：德军战线及其后方属德军，苏军战线及其后方属苏军
 *     （推导口径见 `rule`；逐格清单见 `axisOwned`，未列者属苏联）。
 * 归属会因 9.14e「可攻击单位进入」而翻转（等级按 1.3a 不变）。
 */
export const PrintedHedgehogOwnersSchema = z
  .object({
    /** 归属裁定与推导口径（原文，便于回溯与人工订正） */
    rule: z.string(),
    /** 开局属**德军**的印刷工事格清单（`列.行`，行补零两位）；其余全部属苏联 */
    axisOwned: z.array(z.string()),
  })
  .strict()

export type PrintedHedgehogOwners = z.infer<typeof PrintedHedgehogOwnersSchema>

/**
 * 剧本初设的「已转换的轴方铁路」（专规 1.2 剧本页 `Converted Axis Rails: A to B`）
 *
 * 「铁路线始终处于两种轨距之一……最初除剧本初设另有注明者外，全部为宽轨。」剧本页只给**两个端点**
 * （如「01.03 to 2.02」，并在端点标注驻该处的 RR Bn＝4.1c 铁路修理营），给的是**那一条铁路线**；
 * 逐格清单由引擎沿铁路邻接图取唯一最短路径推导（`engine/rules/rail.ts#convertedRailRun`，
 * 歧义即失败，不猜），因此本字段**只存原文与端点**、不存推导结果——推导留痕在运行期账本里。
 */
export const ConvertedAxisRailsSchema = z
  .object({
    /** 规则依据与读法（原文，便于回溯与人工订正） */
    rule: z.string(),
    /** 逐段走线：端点原文（如 `'01.03 to 2.02'`），按剧本页顺序 */
    runs: z.array(z.string()),
    /** 端点原文中该 RR Bn 的驻格说明（可缺） */
    notes: z.string().optional(),
  })
  .strict()

export type ConvertedAxisRails = z.infer<typeof ConvertedAxisRailsSchema>

/**
 * 剧本初设的**德军铁路端头**（13.3d；用户 2026-11-12 口径）
 *
 * `railhead` = 剧本页 `Converted Axis Rails: A to B` 的 **B 端** = 初设时标准轨的**东端终点**，
 * 也就是 `mk-38`（Neutral_Railhead）要画的那一格；13.3f 推进时 B **向东前移**，标记随之移动。
 * 本字段只存该格清单（`列.行`），不存轨距：标准轨段由 `convertedAxisRails.runs` 沿铁路图
 * 唯一路径推导（`engine/rules/rail.ts#convertedRailRun`），与 `map-layers.edges[].gauge` 无关。
 */
export const RailheadsSchema = z
  .object({
    /** 规则依据与读法（原文，便于回溯） */
    rule: z.string(),
    /** 初设端头格（原文 B 端，按剧本页顺序）；每段一个 */
    hexes: z.array(z.string()),
  })
  .strict()

export type Railheads = z.infer<typeof RailheadsSchema>

/** 剧本初设数值与选项（Setup Notes A 的剧本页旋钮） */
export const ScenarioSetupSchema = z
  .object({
    /** 开局铁路容量（专规 1.2；3/5/7 依 SmolenskErrata） */
    railCap: SidePairSchema,
    /** Reserve 标记数（开局可用的预备模式标记） */
    reserveMarkers: SidePairSchema,
    /** 剧本明禁初设进入预备模式（剧本 3「No units can setup in Reserve Mode.」） */
    reserveSetupForbidden: z.boolean().optional(),
    /**
     * E5：初设模式约束（规格 §2.1）
     *
     * 缺省＝四种主动模式都可设、预备上限取 `reserveMarkers`、不额外禁预备；
     * 有剧本明确写出时才覆盖。
     */
    modeConstraints: z
      .object({
        /** 初设可选模式集合（IV-B）；缺省 combat / move / reserve / strat */
        allowedSetupModes: z.array(z.enum(['combat', 'move', 'reserve', 'strat'])).optional(),
        /** 预备上限（5.4a 按格）；缺省取 `reserveMarkers` */
        reserveMax: z
          .object({
            axis: z.number().int().nonnegative().optional(),
            soviet: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
        /** 剧本明禁初设预备；缺省取旧字段 `reserveSetupForbidden` */
        reserveSetupForbidden: z.boolean().optional(),
      })
      .strict()
      .optional(),
    /** Supply Cache 枚数（每方） */
    supplyCache: z.number().int().nonnegative(),
    /**
     * 3.4 / 3.4b：本剧本是否适用「轴方 SP 须归属装甲集群」
     *
     * 缺省按首回合日期判（早于解除日即适用）；剧本页明示不适用时记 `false`
     * （Intro: Vitebsk 只有 Hoth 一个集群，不走 3.4 的分集群归属）。
     */
    panzerGroupSpAssignment: z.boolean().optional(),
    /**
     * 1.6b：开局时图外空军盒内的额外 SP（枚，每方）
     *
     * 原文未给数 ⇒ 缺省 0；有剧本明确给出时按印刷值录入。
     */
    offMapAirBoxSp: SidePairSchema.optional(),
    /** 建造标记（Construction Markers）枚数 */
    constructionMarkers: z.number().int().nonnegative(),
    /**
     * 德军卡车满载方式
     *
     * 剧本页未述时数据可缺省；运行时按通规 IV-D 默认 **空载**（Intro: Vitebsk 即此情形）。
     * 用缺省值而非可选字段，是为了让消费方（`setup.ts` / `stores/setup.ts`）不必到处判空。
     */
    organicTrucks: OrganicTrucksSchema.default({
      mode: 'all_unloaded',
      raw: '剧本页未述有机卡车载荷（按通规 IV-D 默认空载）',
    }),
    /** 首回合天气原文（如 'Normal Flight on 8 July'） */
    weatherFirstTurnRaw: z.string(),
    /** 编队抽取规则原文（各剧本差异） */
    formationDrawRaw: z.string().optional(),
    /**
     * 初设确认后执行的强制效果（规格 §2；数组顺序＝执行顺序）
     *
     * 编队抽签已由 `formationDraw` 迁入本字段（数据搬家，字段不变）；缺失＝该剧本无强制效果。
     * `id` 在剧本内唯一（写进台账/日志，重放时按 id 判「已执行」）。
     */
    effects: z
      .array(SetupEffectSchema)
      .superRefine((effects, ctx) => {
        const seen = new Set<string>()
        for (const effect of effects) {
          if (seen.has(effect.id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `effects.id 在剧本内必须唯一：${effect.id}`,
            })
          }
          seen.add(effect.id)
        }
      })
      .optional(),
    /** 飞机初设的激活规定（W7 C14；未列入的方按 IV-E 默认全激活） */
    airSetup: AirSetupSchema.optional(),
    /** 地图印刷工事的剧本初始归属（专规 1.3a + 本作裁定） */
    printedHedgehogOwners: PrintedHedgehogOwnersSchema.optional(),
    /** 5.0c：初设自由摆位之前已有的历史控制，不能用印刷工事归属替代。 */
    initialVictoryControl: z
      .object({ rule: z.string(), axisOwned: z.array(z.string()) })
      .strict()
      .optional(),
    /** 剧本初设的已转换轴方铁路（专规 1.2 剧本页；逐格清单由引擎沿铁路图推导） */
    convertedAxisRails: ConvertedAxisRailsSchema.optional(),
    /** 剧本初设的德军铁路端头格（13.3d；= 各段 B 端，`mk-38` 所在格） */
    railheads: RailheadsSchema.optional(),
    /** 其余初设选项原文（键 → 原文），保留未结构化的剧本差异 */
    options: z.record(z.string(), z.unknown()).optional(),
    /** 数据来源 */
    source: z.array(z.string()).optional(),
  })
  .strict()

/**
 * 关闭补给源条目（2.1a）
 *
 * 源库异构：多数为格号字符串；当某补给源在剧本期间关闭时，以对象记录
 * {hexId, date, rule}（关闭日期与依据）。
 */
export const ClosedSourceSchema = z.union([
  z.string(),
  z
    .object({
      hexId: z.string(),
      hexIdUser: z.string().optional(),
      date: z.string().optional(),
      rule: z.string().optional(),
    })
    .strict(),
])

/** 剧本生效补给源（专规 2.1 / 3.1 + errata；按首回合日期算出） */
export const SupplySourcesSchema = z
  .object({
    rule: z.string(),
    firstTurn: z.string(),
    sovietLive: z.array(z.string()),
    sovietClosed: z.array(ClosedSourceSchema),
    axisLive: z.array(z.string()),
    axisClosed: z.array(ClosedSourceSchema),
    /** 入场即满载（2.1 / 3.1 首段） */
    enteringLoaded: z.string().optional(),
    /** 放置规则（12.6a 等） */
    placement: z.string().optional(),
    /** 入场格登车 / 铁路机动（13.6b / 13.3b / 13.3c / 13.3e） */
    entrainOffMap: z.string().optional(),
    /** 免费铁运城市格（2.1/3.1 + 通规 13.3c） */
    freeRailCap: z.record(z.string(), z.unknown()).optional(),
    source: z.string().optional(),
  })
  .strict()

/** 单个剧本 */
export const ScenarioSchema = z
  .object({
    /** 剧本标识（'Intro' 与 '1'…'7'） */
    id: z.string().min(1),
    name: z.string().min(1),

    /** 首回合日期原文（如 '8 Jul 41'；不转回合号） */
    firstTurn: z.string().min(1),
    /** 末回合日期原文 */
    lastTurn: z.string().min(1),
    /** 回合数（剧本 1 为 19，剧本 2 为 8） */
    turns: z.number().int().positive(),

    /**
     * 本剧本只有**一个玩家回合**（剧本页 `1 player turn`，Intro: Vitebsk）
     *
     * 缺省 false（双方各走一次 A–H）。为真时先手方 H 之后直接进入终局。
     */
    singlePlayerTurn: z.boolean().optional(),

    /** 首次行动方 */
    firstPlayer: SideSchema,
    /** 先布设方（与 firstPlayer 相反者） */
    setupFirst: SideSchema,

    /** 首回合天气（剧本指定，不掷骰） */
    firstWeather: z.enum(['restricted', 'normal']),

    /** 初设与特殊规则继承自哪个剧本（1-2 / 3-4 / 5-6 共用初设） */
    inherits: z.string().optional(),

    /** 与该剧本共用初设的其他剧本（源库 shared_setup_with） */
    sharedSetupWith: z.array(z.string()).optional(),

    /** 该剧本是否含初设条目（源库 has_setup） */
    hasSetup: z.boolean().optional(),

    /**
     * 剧本页初设栏原文（按方列出可用量表述）：
     * 如 { axis: { 'Rail Cap': '0 at start', 'Reserve Markers': '14 available', … } }
     */
    setupInfo: z.record(z.string(), z.record(z.string(), z.string())).optional(),

    /** 初设数值与选项 */
    setup: ScenarioSetupSchema,

    /** 该剧本实际生效的补给源 */
    supplySources: SupplySourcesSchema.optional(),

    /** 带 † 的轴方师可在所列位置 1 格内初设（剧本 3–7） */
    daggerRule: z.string().optional(),

    /** 苏方首回合 1/2 移动力（1.5 / 剧本页） */
    sovietFirstTurnHalfMa: z.string().optional(),

    /** 该剧本是否须掷可变撤离（3.3c） */
    variableExitRequired: z.boolean().optional(),

    /** 每剧本单位计数（编制/下属/单位/HQ/SP/飞机/运输点） */
    counts: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

export type Scenario = z.infer<typeof ScenarioSchema>
export type ScenarioSetup = z.infer<typeof ScenarioSetupSchema>
export type SidePair = z.infer<typeof SidePairSchema>
export type { AirSetup as ScenarioAirSetup, AirSetupPolicy as ScenarioAirSetupPolicy }

/** 胜利条件（5.0a / 5.0b / 剧本 2·4 变体） */
export const VictorySchema = z
  .object({
    final: z.record(z.string(), z.string()).optional(),
    decisive: z.record(z.string(), z.string()).optional(),
    scenarios2And4: z.record(z.string(), z.string()).optional(),
    control: z.string().optional(),
    /** 通用胜利格清单（原文含格号与地名） */
    listedHexes: z.array(z.string()),
    /** 剧本 2/4 专用格清单（部分只有格号） */
    scenario2HexList: z.array(z.string()),
  })
  .strict()

/** 共识开关（agreed_options：须双方一致同意才生效，必须写入存档） */
export const AgreedOptionsSchema = z
  .object({
    note: z.string(),
    items: z.array(z.string()),
  })
  .strict()

/** 初设期须遵守的专属规则注记 */
export const SetupNotesSchema = z
  .object({
    /** 开局地图内 SP 须在初设期归属某一装甲集群（Setup Note F / 3.4） */
    spOwnership: z.string(),
    /** 新到轴方 SP 必须立即归属某一装甲集群 */
    newSpAssignment: z.string(),
  })
  .strict()

/** scenarios.json 文件整体 */
export const ScenariosDataSchema = z
  .object({
    meta: DataFileMetaSchema,
    agreedOptions: AgreedOptionsSchema,
    /** 可选规则 / 房规（4.1a–4.3） */
    optionalRules: z.record(z.string(), z.string()),
    /** 初设期规则注记（SP 归属等） */
    setupNotes: SetupNotesSchema,
    victory: VictorySchema,
    scenarios: z.array(ScenarioSchema).min(1),
  })
  .strict()

export type ScenariosData = z.infer<typeof ScenariosDataSchema>
export type VictoryData = z.infer<typeof VictorySchema>
export type SetupNotes = z.infer<typeof SetupNotesSchema>

/** 保留 hex 引用类型出口（胜利格解析用） */
export type { HexRef } from './common.schema'
export { HexRefSchema }
