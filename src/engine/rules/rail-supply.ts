import type { HexRef, Side } from '@/data'

import { HEX_DIRECTIONS, neighbor, sameHex } from '../hex-geometry'
import type { RailFacts } from './rail'
import type { SupplyMobility } from './trace-supply'

/**
 * 铁路补给连接（12.7a-B/C）与**火车卸货格**（13.3c）——W6 C9 补全
 *
 * 本模块把「铁路线怎么把补给送出去」这条链补全：`12.6a` 列出三种补给源，其中
 * **② 火车卸货格** 与 **③ 延补队的连接** 都要靠铁路路径判定，此前由玩家手工声明；
 * 现在由本模块从地图与运行期事实推导。
 *
 * ## 条文索引
 *   - **12.6a** 补给源三类：① 允许增援入场的地图边缘铁路格（+专规其他补给源）
 *           ；② 火车卸货格（见 13.3c）；③ 含延补队且该延补队可与一个火车卸货格相连、
 *           或直接与一个补给源相连的格
 *   - **12.7a** 延补队唯一作用是「创造一个新的位置，以便从该位置上延续追溯补给」，具体三型：
 *           A) 与一个**火车卸货格**相连，或直接与一个**补给源**相连 ⇒ 可作追溯补给的补给来源；
 *           B) 位于**不同铁路线的两个铁路格之间**时，若**后方**那条铁路能连接到一个补给源，
 *              则**前方**那条铁路上的格即变为**火车卸货格**，此时延补队是追溯补给的连接；
 *           C) 位于**一个铁路格与一个补给源之间**时，延补队作为连接，使该铁路上的格成为火车卸货格
 *   - **12.7b** 延补队都有以 MP 为单位的**距离**（＝距后方被连接格的最远距离），永远放在连接的前方
 *   - **12.7c** 延补队可与其它延补队连接成**锁链**
 *   - **13.3c 火车卸货格**须同时满足：① 该格有村庄、城市（任意规模）、港口或**有工程能力的指挥部**
 *           （13.8a）；② 该格已被**控制**（13.3h）；③ 该格有一条由**铁路**构成的路径可延伸至一个
 *           补给源，且该路径上**没有敌方 ZOC**（判断与补给源是否连接时 EZOC **可以**按 4.5b 被抵消；
 *           但**运输货物时** EZOC 不可抵消——本模块只判「与补给源是否连接」，故按可抵消处理）。
 *           ★ 13.3c 明言：判断追溯补给时，**延补队的连接可以作为该路径的一部分**
 *   - **13.3f / 专规 1.2 轨距**：「铁路线始终处于两种轨距之一，宽轨或标准轨。**最初除剧本初设另有
 *           注明者外，全部为宽轨**。就**铁路运货与获得追溯补给**而言：苏方**只能**使用宽轨铁路，
 *           轴方**只能**使用标准轨铁路。玩家用铁路修理单位按 OCS 13.3f 改变这些线路的轨距。」
 *           ⇒ 13.3c③ 的「由铁路构成的路径」必须是**本方可用轨距**的铁路格连成的路径，
 *           故通路扩展（含补给源起点）一律受 `railGaugeUsable` 约束。
 *
 * ## 建模口径（不臆造）
 *   - 轨距**只**回答「谁能用这条铁路」（专规 1.2 / 13.3f），**不**参与运量费用计算——
 *     费用侧的「多轨减半」是**地形**（13.3a），两者不得混为一谈；
 *   - 铁路网络取自地图格边数据：`railNeighbors` 由调用方给出（一格边有轨即算铁路相邻）；
 *   - 延补队把「已连接的格」接到**它自己所在格**（12.7b：它总在连接的前方），跳接距离以
 *     延补队的 `rangeMp`（＝印值 MA，12.7b）为限 —— 于是「后段铁路 → 延补队 → 前段铁路」成立；
 *   - 多个延补队天然形成**锁链**（12.7c）：BFS 逐跳推进，无需额外规则；
 *   - 本模块**只**回答「哪些格成为火车卸货格 / 铁路可达」，不改动任何状态。
 */

/** 一格在铁路补给判定中的运行期事实 */
export interface RailSupplyFacts extends Pick<RailFacts, 'railGaugeUsable'> {
  /**
   * 13.3f / 专规 1.2：该铁路格的轨距是否为 `side` **可用**
   *
   * 与 `RailFacts.railGaugeUsable` **同一份声明**（同一条规则的同一个判定），不另立口径：
   * 苏方只能走宽轨、轴方只能走标准轨；「已转换」状态由调用方按剧本初设与 13.3f 转换记账给出。
   */
  railGaugeUsable(hex: HexRef, side: Side): boolean
  /** 该格的**格内**地形名（判 13.3c 的村庄/城市；城市与村庄的判读由调用方按 9.3b 口径给全） */
  terrainsPresentAt(hex: HexRef): readonly string[]
  /**
   * 13.3c①后半：该格是否有**港口**或**具工程能力的指挥部**（13.8a）
   *
   * 缺省视为无（本作港口为装饰性，见专规 1.1c；工程 HQ 极少）。
   */
  hasPortOrEngineerHqAt?(hex: HexRef): boolean
  /** 13.3h：该格是否由 `side` **控制**（被敌军夺取即失去控制） */
  isControlledBy(hex: HexRef, side: Side): boolean
  /** 13.3a：沿铁路相邻的格（该格边有铁路） */
  railNeighbors(hex: HexRef): readonly HexRef[]
  /**
   * 该格是否为**铁路格**（13.3a：至少有一条格边有铁路）
   *
   * 用于 12.7a-B/C 的「前段铁路」判定：延补队被放在连接的前方（12.7b），
   * 它**相邻**的那条铁路即前段铁路——两者之间未必有铁路格边（否则也不需要延补队了）。
   */
  isRailHex(hex: HexRef): boolean
  /**
   * 13.3c③：该格是否有**未被抵消**的敌方 ZOC
   *
   * 「判断与补给源是否连接时，EZOC 可以（按 4.5b）被抵消」⇒ 调用方须按「抵消后」的结果传入。
   */
  inUnnegatedEnemyZoc(hex: HexRef, side: Side): boolean
  /** 12.6a①：地图边缘铁路格 / 专规补给源格（铁路路径的**起点**） */
  baseSourceHexes(side: Side): readonly HexRef[]
  /**
   * 12.7a-B/C：延补队连接（所在格 + 其距离 MP，12.7b）
   *
   * ★ `mobility` 是 12.7b 的一部分：距离按其**印值 MA 的类型**计（卡车延补队＝轮式 20、马车＝徒步 10）。
   */
  extenderLinks(side: Side): readonly {
    hex: HexRef
    rangeMp: number
    mobility: SupplyMobility
  }[]
  /**
   * 12.7b / 12.7g：该延补队能否**回连**到某格（距离以 **MP** 计，含「相邻即可」）
   *
   * ★ **必须由调用方用 trace-supply 的同一实现注入**（`extenderConnectsBack`）：
   *   本条与 12.6 的追溯距离是同一条规则，`rail-supply` 不得自持 `hexDistance ≤ rangeMp`
   *   这套**格数**口径——两者在地形成本 > 1 MP/格（山地、沼泽、河）时结论**相反**。
   */
  extenderConnectsBack(input: {
    extenderHex: HexRef
    hex: HexRef
    side: Side
    mobility: SupplyMobility
    rangeMp: number
  }): boolean
}

/** 铁路补给连接结论 */
export interface RailSupplyPath {
  /** 13.3c：本次判定出的**火车卸货格**（可直接作为 12.6a② 补给源喂给追溯补给） */
  detrainableHexes: HexRef[]
  /** 沿铁路（含经延补队跳接）从补给源可达的全部格（供界面显示铁路补给线） */
  railReachableHexes: HexRef[]
  /** 实际起作用的延补队（其格被铁路线接续上者） */
  usedExtenderHexes: HexRef[]
  rule: string
  detail: string
}

const hexKey = (hex: HexRef): string => `${hex.col}.${hex.row}`

/** 13.3c①：该格是否有村庄/城市（任意规模）—— 城市与村庄的符号判读由调用方给全 */
export function hasVillageOrCity(terrains: readonly string[]): boolean {
  return terrains.some((name) => name === 'Village' || name.includes('City'))
}

/**
 * 12.6a② / 13.3c / 12.7a-B/C：铁路补给路径与**火车卸货格**判定
 *
 * 算法（逐条对应条文）：
 *   1. 起点＝12.6a① 的补给源格（边缘铁路格/专规补给源格）——**轨距不可用者不作起点**（专规 1.2：
 *      该方「只能使用」某种轨距的铁路，补给源是这条铁路路径的端点，同样在「路径」之内）；
 *   2. 沿**铁路**格边扩展（13.3a），跳过**轨距不可用**（13.3f）与**未被抵消**的敌方 ZOC（13.3c③）
 *      的格，两者都不得进入；
 *   3. 延补队：若当前已连接的某格在其 `rangeMp` 内，则把该延补队所在格接入（12.7a-B/C、12.7b），
 *      接入后继续沿铁路扩展 —— 于是「后段铁路 → 延补队 → 前段铁路」与延补队**锁链**（12.7c）都成立；
 *      ★ 延补队**自身所在格不受轨距约束**（它是汽车/马车队而非铁路），但它**接续的前段铁路格**照旧受约束；
 *   4. 卸货格＝铁路可达 ∧ **轨距可用** ∧ 有村庄/城市（或港口/工程 HQ） ∧ 受本方控制 ∧ 无未抵消敌 ZOC
 *      （13.3c①②③ ＋ 13.3f）。
 */
export function railSupplyPath(facts: RailSupplyFacts, side: Side): RailSupplyPath {
  const reached = new Set<string>()
  const railReachableHexes: HexRef[] = []
  const queue: HexRef[] = []
  const extenders = facts.extenderLinks(side)
  const usedExtenderKeys = new Set<string>()

  const push = (hex: HexRef): void => {
    const key = hexKey(hex)
    if (reached.has(key)) return
    reached.add(key)
    railReachableHexes.push(hex)
    queue.push(hex)
  }

  for (const source of facts.baseSourceHexes(side)) {
    // 专规 1.2：轨距不可用的铁路格不得作为本条铁路路径的一部分
    if (!facts.railGaugeUsable(source, side)) continue
    push(source)
  }

  while (queue.length > 0) {
    const hex = queue.shift()!
    for (const next of facts.railNeighbors(hex)) {
      // 13.3f：轨距须为**本方**可用（苏宽轨／德标准轨；含已转换状态）
      if (!facts.railGaugeUsable(next, side)) continue
      // 13.3c③：铁路路径上不得有**未被抵消**的敌方 ZOC
      if (facts.inUnnegatedEnemyZoc(next, side)) continue
      push(next)
    }
    // 12.7a-B/C + 12.7b：延补队把后方已连接的格接到自己所在格（距离以印值 MP 为限）
    let reachedExtender = false
    for (const extender of extenders) {
      const key = hexKey(extender.hex)
      if (reached.has(key)) {
        reachedExtender = true
        continue
      }
      // 12.7b：距离以 **MP** 计（唯一实现在 trace-supply；本模块不再用格数近似）
      if (
        !facts.extenderConnectsBack({
          extenderHex: extender.hex,
          hex,
          side,
          mobility: extender.mobility,
          rangeMp: extender.rangeMp,
        })
      )
        continue
      push(extender.hex)
      usedExtenderKeys.add(key)
      reachedExtender = true
    }
    // 12.7a-B：延补队在连接的前方（12.7b）⇒ 它**相邻的铁路格**（前段铁路）随接入而可达。
    // 注意前段铁路与延补队之间**未必有铁路格边**（有的话就不需要延补队了），故按「相邻 + 是铁路格」判。
    if (reachedExtender) {
      for (const extender of extenders) {
        if (!reached.has(hexKey(extender.hex))) continue
        for (const direction of HEX_DIRECTIONS) {
          const candidate = neighbor(extender.hex, direction)
          if (!facts.isRailHex(candidate)) continue
          // 13.3f：延补队把两段铁路接起来，接续的**铁路格**同样须轨距可用
          if (!facts.railGaugeUsable(candidate, side)) continue
          if (facts.inUnnegatedEnemyZoc(candidate, side)) continue
          push(candidate)
        }
      }
    }
  }

  /*
   * 13.3c：火车卸货格＝「**铁路格**」∧ **轨距为本方可用**（13.3f／专规 1.2）∧ 有村庄/城市
   * （或港口/有工程能力的指挥部）∧ 受控 ∧ 无未抵消敌 ZOC。
   *
   * ★ 「须是铁路格」这一条此前缺失：延补队常被放在**不在铁路上**的村庄/城市格（12.7a-B/C 的典型
   *   布置），于是该格会被误判为火车卸货格，进而当作 12.6a② 的补给源喂给追溯补给。
   * ★ 「须轨距可用」是**再兜一道底**：轨距不可用的格本已在扩展时被拦下，但延补队所在格是**无条件**
   *   接入的（见上），若它恰好压在一条轨距不可用的铁路上且格内有村庄，仍须在此拦掉。
   */
  const detrainableHexes = railReachableHexes.filter(
    (hex) =>
      facts.isRailHex(hex) &&
      facts.railGaugeUsable(hex, side) &&
      facts.isControlledBy(hex, side) &&
      !facts.inUnnegatedEnemyZoc(hex, side) &&
      (hasVillageOrCity(facts.terrainsPresentAt(hex)) ||
        facts.hasPortOrEngineerHqAt?.(hex) === true),
  )

  return {
    detrainableHexes,
    railReachableHexes,
    usedExtenderHexes: extenders
      .filter((extender) => usedExtenderKeys.has(hexKey(extender.hex)))
      .map((extender) => extender.hex),
    rule: '13.3c',
    detail:
      `铁路补给线：自 ${facts.baseSourceHexes(side).length} 个补给源沿铁路可达 ${railReachableHexes.length} 格` +
      (usedExtenderKeys.size === 0
        ? ''
        : `（其中 ${usedExtenderKeys.size} 处经延补队接续，12.7a-B/C）`) +
      `；其中**火车卸货格** ${detrainableHexes.length} 处（13.3c：铁路格 + 轨距可用 13.3f + 村庄/城市/港口/工程 HQ + 受控 + 无未抵消敌 ZOC）`,
  }
}

/**
 * 12.7a-A：延补队是否可作**追溯补给的补给来源**
 *
 * 「与一个火车卸货格相连，或直接与一个补给源相连」⇒ 判据是「该延补队所在格与
 * 12.6a① 的补给源、或（13.3c 判出的）火车卸货格**在连接距离内**」。
 * 本条与 `railSupplyPath` 的分工：前者判「延补队自己算不算源」，后者判「它把哪段铁路接通」。
 */
export function extenderIsASupplySource(input: {
  extenderHex: HexRef
  rangeMp: number
  /** 12.7b：距离按其**印值 MA 的类型**计 */
  mobility: SupplyMobility
  side: Side
  /** 12.6a① 补给源格 */
  baseSourceHexes: readonly HexRef[]
  /** 13.3c 判出的火车卸货格 */
  detrainableHexes: readonly HexRef[]
  /** 提供 12.7b 回连判定的唯一实现（同 `railSupplyPath` 用的那一份事实） */
  facts: RailSupplyFacts
}): boolean {
  const connected = [...input.baseSourceHexes, ...input.detrainableHexes]
  return connected.some((hex) =>
    input.facts.extenderConnectsBack({
      extenderHex: input.extenderHex,
      hex,
      side: input.side,
      mobility: input.mobility,
      rangeMp: input.rangeMp,
    }),
  )
}

/** 12.7a-B：该延补队是否接续了**另一段**铁路（后段可达、前段因它而可达） */
export function extenderBridgesRailLines(input: {
  extenderHex: HexRef
  railSupply: RailSupplyPath
}): boolean {
  return input.railSupply.usedExtenderHexes.some((hex) => sameHex(hex, input.extenderHex))
}
