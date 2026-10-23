import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, hexDistance, isOnMap, neighbor } from '@/engine/hex-geometry'
import { modifierTotal } from '@/engine/derivation'
import { createMapFacts, holdingsToT, selectMovementTerrain } from '@/engine/rules'
import { createRngState } from '@/engine/rng'
import {
  defenseTerrainChoices,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
  type ConsoleUnit,
  actionGateOf,
  type ActionKey,
  type ConsolePhase,
} from '@/stores'

/**
 * C6 战斗交互的**端到端流程**（store 级）
 *
 * 覆盖用户要求的交互链：行动值指定 → 逐堆叠地形宣布 → 战斗补给确认与拒付 → 选项逐项分配 →
 * 撤退方向与战后推进；并核对**战果应用的先后顺序**（9.2 九步，攻方先、守方后）。
 *
 * 用**真实地图与真实单位库**（不造数）：结论全部来自引擎，故断言的是「流程走通 + 状态写对」。
 * 规则细节（CRT 取整、9.11c 分布、9.12e 额外损失等）在 `tests/engine/combat-interaction.test.ts`。
 */

/**
 * B8：把 store 放到**本段里允许做该动作的那个环节**
 *
 * 段内动作只在对应环节放行（用户口径：「每个环节只能执行该环节能进行的操作」）。
 * 用 B7 的闸门表反查环节，而不是写死序号或环节名。
 */
function goToActionStep(
  store: {
    phase: ConsolePhase
    playerSegmentSteps: readonly { id: string }[]
    setSegmentStepIndex(index: number): boolean
  },
  key: ActionKey,
): void {
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error(`${store.phase} 段没有允许 ${key} 的环节`)
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${key}）`)
}

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

const mapFacts = createMapFacts()

/** 该记录能否从 `from` 进入 `to`（与 `createBattleFacts.canEnterForAttack` 同口径的 9.1f 探针） */
function canEnter(mobility: 'leg' | 'truck' | 'track', from: HexRef, to: HexRef): boolean {
  const result = selectMovementTerrain({
    terrainsPresent: mapFacts.terrainsAt(to),
    mobility,
    crossing: mapFacts.crossingBetween(from, to),
    followingRoad: true,
    forOverrun: false,
  })
  return result.ok
}

/** 取一个六邻格都在图内、且可作防御格（有格内战斗地形）的格 —— 便于构造撤退直线路径 */
const DEFENDER_HEX: HexRef = (() => {
  const found = mapLayers.hexes.find((hex) => {
    const ref = { col: hex.col, row: hex.row }
    if (defenseTerrainChoices(ref).length === 0) return false
    return HEX_DIRECTIONS.every((direction) => {
      const candidate = neighbor(ref, direction)
      return (
        isOnMap(candidate) &&
        mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
      )
    })
  })
  if (found === undefined) throw new Error('地图上找不到「六邻皆图内且可作防御格」的格')
  return { col: found.col, row: found.row }
})()

/** 攻击格：防御格的一个图内邻格，且步兵可进入（9.1f） */
const ATTACKER_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(DEFENDER_HEX, direction)
    if (!isOnMap(candidate)) continue
    if (!mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)) {
      continue
    }
    if (canEnter('leg', candidate, DEFENDER_HEX)) return candidate
  }
  throw new Error('防御格没有「步兵可进入」的图内邻格')
})()

/** 从 `from` 向某方向直线走 `count` 格（落点与起点的直线距离＝count ⇒ 满足 9.12 完整撤退距离） */
function straightPath(from: HexRef, count: number): HexRef[] {
  for (const direction of HEX_DIRECTIONS) {
    const path: HexRef[] = []
    let current = from
    let valid = true
    for (let index = 0; index < count; index += 1) {
      const next = neighbor(current, direction)
      if (
        !isOnMap(next) ||
        !mapLayers.hexes.some((h) => h.col === next.col && h.row === next.row)
      ) {
        valid = false
        break
      }
      path.push(next)
      current = next
    }
    if (valid && hexDistance(from, current) === count) return path
  }
  throw new Error(`找不到 ${count} 格的直线撤退路径`)
}

/** 单位库取记录（找不到即失败，避免静默用错夹具） */
function pickRecord(
  side: 'axis' | 'soviet',
  predicate: (record: ReturnType<typeof unitChoices>[number]) => boolean,
): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices(side).find(predicate)
  if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return found
}

/** 摆一个算子并返回它 */
function place(
  store: ReturnType<typeof newStore>,
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side })
  store.units.push(unit)
  return unit
}

const attackerRecord = (): ReturnType<typeof unitChoices>[number] =>
  pickRecord(
    'axis',
    (record) =>
      record.isCombat === true &&
      record.attackCapable === true &&
      record.classes?.movementClass === 'leg' &&
      (record.factors?.combat?.attack ?? 0) >= 3,
  )

const defenderRecord = (): ReturnType<typeof unitChoices>[number] =>
  pickRecord(
    'soviet',
    (record) =>
      record.isCombat === true &&
      record.attackCapable === true &&
      (record.factors?.combat?.attack ?? 0) >= 1,
  )

/** 摆好攻守并走到「战斗补给」步（9.2 第 1 步） */
function setupBattle(store: ReturnType<typeof newStore>) {
  store.setPhase('combat')
  // B8：F 段首环是炮击 ⇒ 宣告战斗前先进战斗环节
  goToActionStep(store, 'combat.declare')
  store.setTool('battle')
  store.setFuelPool(0, 20)
  const attacker = place(store, attackerRecord(), ATTACKER_HEX, 'axis', 'a1')
  const defender = place(store, defenderRecord(), DEFENDER_HEX, 'soviet', 'd1')
  store.clickHex(ATTACKER_HEX)
  store.clickHex(DEFENDER_HEX)
  return { attacker, defender }
}

/** 该方选项：优先用军力损失满足；军力不够时才用撤退（两条都由 9.10a 允许） */
function driveOptions(store: ReturnType<typeof newStore>, side: 'attacker' | 'defender') {
  const requirement = store.combatRequirement
  if (requirement === null) throw new Error('此刻不该没有损失/选项需求')
  const units = side === 'attacker' ? store.combatAttackers : store.battleDefenders
  const capacity = units.reduce((sum, unit) => sum + unit.steps, 0)
  if (requirement.options <= capacity) {
    store.combatInputs.optionRetreatHexes = 0
    store.combatInputs.optionLossPoints = requirement.options
  } else {
    store.combatInputs.optionRetreatHexes = requirement.options
    store.combatInputs.optionLossPoints = 0
  }
  expect(store.confirmCombatOptions()).toBe(true)
}

/**
 * B47（12.8e）：走到移动阶段的**「模式与移动」环节**
 *
 * 突围环节是该段的**首环节**（"before any other movement"）—— 场上有断补单位时它会占住当前环节，
 * 故这些用例在 `setPhase('movement')
  goToMovementStep(store)` 之后要先按流程走一环，再调各自的动作。
 */
function goToMovementStep(store: {
  playerSegmentSteps: readonly { id: string }[]
  setSegmentStepIndex(index: number): boolean
}): void {
  const index = store.playerSegmentSteps.findIndex((step) => step.id === 'movement.modeAndMovement')
  if (index >= 0) store.setSegmentStepIndex(index)
}
describe('C6 9.2 九步流程：顺序推进', () => {
  let store: ReturnType<typeof newStore>

  beforeEach(() => {
    store = newStore()
  })

  it('9.0：非战斗阶段不能发起常规战斗（当前 C 移动段）', () => {
    store.setTool('battle')
    place(store, attackerRecord(), ATTACKER_HEX, 'axis', 'a1')
    place(store, defenderRecord(), DEFENDER_HEX, 'soviet', 'd1')
    store.clickHex(ATTACKER_HEX)
    store.clickHex(DEFENDER_HEX)
    expect(beginCombatWithSupply(store)).toBe(false)
    // ★ B8：C 段（且当前是"模式与移动"环）宣告战斗由**统一闸门**拦下（段/环节判据只有一处）
    expect(store.actionRefusal).toMatchObject({ key: 'combat.declare', rule: '9.2' })
  })

  it('H①：攻方在承受选项前被全灭 ⇒ 跳过攻方选项页；没有可推进单位时战斗直接结束（9.10c 例 B / 9.12g-D）', () => {
    /*
     * 9.10c 例 B：「AL1o1，Do1……**唯一的攻击者因 L1 摧毁**，因此防御者可以忽略他的选项。」
     * 9.12g-D：「……由拥有者玩家选择哪些攻击单位进行推进（**如果有的话**）。」
     * 本用例把攻方压到 1 军力，并**扫种子**找一个"AL1 恰好把它打光"的骰序（骰子自动 ⇒ 用种子复算，
     * 与仓库的"掷骰可复算"同一口径）；找不到即抛错（不会静默变成一条不测该情形的用例）。
     */
    let found = false
    for (let seed = 1; seed <= 80 && !found; seed += 1) {
      const store = newStore()
      store.rng = createRngState(seed)
      setupBattle(store)
      const attackerInStore = store.units.find((unit) => unit.instanceId === 'a1')
      if (attackerInStore === undefined) throw new Error('夹具里找不到攻方 a1')
      attackerInStore.steps = 1
      driveToResolution(store)
      if (store.combatState?.step !== 'losses') continue
      if (!store.confirmCombatLosses()) continue
      if (store.combatAttackers.length > 0) continue // 这一骰序没把攻方打光 ⇒ 换种子
      found = true

      // ① 攻方选项页**不再出现**（stage 直落守方强制损失）
      expect(store.combatState!.resolution.stage).toBe('defenderLosses')
      expect(store.combatState!.resolution.attacker.optionsSkipped).toBe('attackerWipedOut')
      expect(store.log.some((entry) => (entry.text ?? '').includes('跳过攻方的选项'))).toBe(true)

      // ② 守方的强制损失与选项照常结算（这一步不能被跳掉）
      expect(store.confirmCombatLosses()).toBe(true)
      expect(store.combatState!.resolution.stage).toBe('defenderOptions')
      driveOptions(store, 'defender')
      expect(store.combatState!.step).toBe('retreat')

      // ③ 撤退（守方若需撤就给它直线路径）⇒ 9.12g-D：攻方无人可推 ⇒ 战斗**直接结束**
      const requirement = store.combatRetreatRequirement
      const paths: Record<string, string> = {}
      if (requirement.defender > 0) {
        for (const unit of store.battleDefenders) {
          paths[unit.instanceId] = straightPath(unit.hex, requirement.defender)
            .map((hex) => `${hex.col}.${hex.row}`)
            .join(',')
        }
      }
      store.combatInputs.retreatPaths = paths
      expect(store.confirmCombatRetreats()).toBe(true)
      expect(store.combatState!.finished).toBe(true)
    }
    expect(found, '扫了 80 个种子都没出现"攻方被 AL1 打光"的骰序（用例前提不成立）').toBe(true)
  })

  it('9.0：不相邻的单位不能参战（选防御格时即被拦下）', () => {
    store.setPhase('combat')
    goToActionStep(store, 'combat.declare')
    store.setTool('battle')
    const far = straightPath(DEFENDER_HEX, 2)[1]!
    place(store, attackerRecord(), far, 'axis', 'a1')
    place(store, defenderRecord(), DEFENDER_HEX, 'soviet', 'd1')
    store.selectCombatDefenderHex(DEFENDER_HEX)
    // 不相邻 ⇒ 既不会被自动取为攻方，也不会建立交战
    expect(store.battleTarget).toBeNull()
  })

  it('走完九步：9.1 构成 → 9.5 补给 → 9.6 AR → 9.4 地形 → 9.8 奇袭 → 9.9 掷骰 → 9.11/9.10 结算 → 9.12 撤退 → 9.12g 推进', () => {
    const { attacker } = setupBattle(store)
    /*
     * ★ 契约变更（H①，2026-09-19，**不是放宽**）：9.10c 例 B 现在会让"攻方在承受选项前被全灭"的
     *   战斗**跳过攻方选项步**（修前会停在一个填不动的选项页）。本用例要验的是**完整九步**，
     *   故给攻方补足军力，让它扛得住这一笔强制损失（否则走的就是短路那条路 —— 那条由
     *   `tests/engine/combat-interaction.test.ts` 的 H① 组覆盖）。
     */
    const attackerInStore = store.units.find((unit) => unit.instanceId === attacker.instanceId)!
    attackerInStore.steps = Math.max(attackerInStore.steps, 3)

    // ① 构成（9.1）
    expect(beginCombatWithSupply(store)).toBe(true)
    expect(store.combatState!.step).toBe('combatSupply')
    expect(store.combatState!.composition.attackerIds).toEqual([attacker.instanceId])

    // ② 战斗补给（9.5/12.4）
    expect(store.confirmCombatSupply()).toBe(true)
    expect(store.combatState!.step).toBe('declareAr')
    expect(store.combatState!.supply!.attacker.paid).toBe(true)

    // ③ 行动值（9.6：攻方先宣布，守方后宣布）
    store.combatInputs.attackerArUnitId = attacker.instanceId
    expect(store.declareCombatArStep('attacker')).toBe(true)
    // 只宣布攻方时流程不前进（等守方）
    expect(store.combatState!.step).toBe('declareAr')
    store.combatInputs.defenderArUnitId = store.battleDefenders[0]!.instanceId
    expect(store.declareCombatArStep('defender')).toBe(true)
    expect(store.combatState!.step).toBe('declareTerrain')
    expect(store.combatState!.ar!.drm).toBe(
      store.combatState!.ar!.attackerAr - store.combatState!.ar!.defenderAr,
    )

    // ④ 地形与初始攻防比（9.4b/9.4c/9.7）
    expect(store.declareCombatTerrainStep()).toBe(true)
    expect(store.combatState!.step).toBe('surprise')
    expect(store.combatState!.odds!.oddsLabel).not.toBe('')

    // ⑥ 奇袭（9.8）：发生奇袭须再掷横移骰
    expect(store.rollCombatSurprise()).toBe(true)
    if (store.combatAwaitingShiftDie) {
      expect(store.combatState!.step).toBe('surprise')
      expect(store.rollCombatShiftDie()).toBe(true)
    }
    expect(store.combatState!.step).toBe('battleDice')

    // ⑦ 掷战斗骰（9.9）
    expect(store.rollCombatDice()).toBe(true)
    expect(store.combatState!.step).toBe('losses')
    expect(store.combatSummary).not.toBeNull()

    // ⑧ 结算：攻方先（9.10b）—— 强制损失
    expect(store.combatState!.resolution.stage).toBe('attackerLosses')
    expect(store.confirmCombatLosses()).toBe(true)
    expect(store.combatState!.resolution.stage).toBe('attackerOptions')

    // ⑧ 攻方选项
    driveOptions(store, 'attacker')
    expect(store.combatState!.resolution.stage).toBe('defenderLosses')

    // ⑧ 守方强制损失（守方后）
    expect(store.confirmCombatLosses()).toBe(true)
    expect(store.combatState!.resolution.stage).toBe('defenderOptions')

    // ⑧ 守方选项
    driveOptions(store, 'defender')
    expect(store.combatState!.step).toBe('retreat')

    // ⑨ 撤退（9.12）：按各方剩余撤退格数给直线路径
    const requirement = store.combatRetreatRequirement
    const paths: Record<string, string> = {}
    if (requirement.attacker > 0) {
      for (const unit of store.combatAttackers) {
        paths[unit.instanceId] = straightPath(unit.hex, requirement.attacker)
          .map((hex) => `${hex.col}.${hex.row}`)
          .join(',')
      }
    }
    if (requirement.defender > 0) {
      for (const unit of store.battleDefenders) {
        paths[unit.instanceId] = straightPath(unit.hex, requirement.defender)
          .map((hex) => `${hex.col}.${hex.row}`)
          .join(',')
      }
    }
    store.combatInputs.retreatPaths = paths
    expect(store.confirmCombatRetreats()).toBe(true)
    expect(store.combatState!.step).toBe('advance')

    // ⑨ 战后推进（9.12g）＋ 进击（9.13）：本测试不推进
    store.combatInputs.advanceUnitIds = []
    expect(store.confirmCombatAdvance()).toBe(true)
    expect(store.combatState!.finished).toBe(true)
  })

  it('账本闭合（B0④）：战斗跑完后「盘面算子数 + 死亡堆数」守恒，阵亡者确实在死亡堆里', () => {
    setupBattle(store)
    const before = store.units.length + store.deadPile.length

    driveToResolution(store)
    driveResolution(store)

    // 本用例不断言具体骰果（真骰决定），只断言**没有算子凭空消失**——
    // 这正是原先三处淘汰各自 splice 掉单位、死亡堆却空着时能通过的断言类型（即原先不存在的断言）。
    expect(store.units.length + store.deadPile.length).toBe(before)
    // 死亡堆与盘面不得重复计同一单位（否则上面的守恒会假性成立）
    for (const dead of store.deadPile) {
      expect(store.units.some((unit) => unit.instanceId === dead.instanceId)).toBe(false)
    }
  })

  it('账本闭合（B0④）：战斗补给**从被声明的补给站扣款**，扣减额恰等于 12.4 的要求量', () => {
    const store = newStore()
    const { attacker } = setupBattle(store)
    // 声明一座补给站（4 SP + 0 T = 16 T）；12.1a 要求可用量**含 SP 折算**
    store.spDumpDraft = { hexText: `${ATTACKER_HEX.col}.${ATTACKER_HEX.row}`, sp: 4, t: 0 }
    expect(store.addSpDump()).toBe(true)
    const dumpId = store.spDumps[0]!.id
    const beforeT = holdingsToT({ sp: store.spDumps[0]!.sp, t: store.spDumps[0]!.t })

    expect(beginCombatWithSupply(store)).toBe(true)
    expect(store.pickCombatSupplyDump('attacker', dumpId)).toBe(true)
    // 原先只取 `dump.t`（= 0）⇒ 4 SP 的补给站被报成 0 T，合法攻击被 12.4 拒掉
    expect(store.combatInputs.attackerAvailableT).toBe(beforeT)
    const beforePoolT = holdingsToT(store.fuelPool)

    expect(store.confirmCombatSupply()).toBe(true)
    const supply = store.combatState!.supply!

    // 扣款必须落在**被声明的补给站**上（原先扣的是共用池、该站分文未动 ⇒ 同一座站可反复支付）
    const after = store.spDumps[0]!
    expect(holdingsToT({ sp: after.sp, t: after.t })).toBe(beforeT - supply.attacker.requiredT)
    // 12.4：**攻守各自付款**——守方份额落在**守方自己的补给站**上（夹具为双方各放了一座）
    const defenderDump = store.spDumps.find((dump) => dump.id === 'sd-soviet')!
    expect(holdingsToT({ sp: defenderDump.sp, t: defenderDump.t })).toBe(
      32 - (supply.defender.paid ? supply.defender.requiredT : 0),
    )
    // 共用池**完全不参与**战斗补给（12.3a/12.3b 是仅有的取补途径）
    expect(holdingsToT(store.fuelPool)).toBe(beforePoolT)
    expect(attacker.steps).toBeGreaterThan(0)
  })

  it('12.4 / 12.6：未声明补给站来源 ⇒ 攻方付不出而**不能发起战斗**（不存在凭空可用的池子）', () => {
    const store = newStore()
    setupBattle(store)
    // setupBattle 会给一个共用演示池；但 12.3a/12.3b 是仅有的取补途径，
    // 除专规补给储备标记（1.7 / 21.10）外 SP 只能从己方补给站扣 ⇒ 池子不得充作来源。
    expect(store.fuelPool.t).toBe(20)
    expect(store.beginCombatNow()).toBe(true)
    // 不声明任何来源
    expect(store.confirmCombatSupply()).toBe(false)
    // 引擎给的是 12.4 的拒绝理由，且**账本分文未动**
    expect(store.combatError).toMatchObject({ rule: '12.4' })
    expect(store.fuelPool.t).toBe(20)

    // 声明一座**足量**补给站后即可发起（证明上一步拒的是"没来源"，不是别的）
    declareSupplyForBoth(store)
    expect(store.confirmCombatSupply()).toBe(true)
    const attackerDump = store.spDumps.find((dump) => dump.id === 'sd-axis')!
    const required = store.combatState!.supply!.attacker.requiredT
    // 8 SP = 32 T，扣掉攻方应付款后按 12.1a 规范化
    expect(holdingsToT({ sp: attackerDump.sp, t: attackerDump.t })).toBe(32 - required)
  })

  it('9.12a：战斗表 DG 结果 ⇒ 掷骰后**全部防御单位立即 DG**（先于任何撤退，9.12e 要用这一事实）', () => {
    setupBattle(store)
    driveToResolution(store)
    const summary = store.combatSummary!
    const defenders = store.battleDefenders
    // 不变式：摘要说守方 DG ⟺ 每个参战守方单位都已置 DG
    for (const unit of defenders) {
      expect(unit.mode.dg).toBe(summary.defender.dg)
    }
    // 且落盘发生在撤退之前（此刻还没到撤退步）
    expect(store.combatState!.step).toBe('losses')
  })

  it('9.12d：未参战战斗单位可加入撤退并随堆叠一起落地（同一条路径）', () => {
    setupBattle(store)
    driveToResolution(store)
    driveResolution(store)
    const plan = store.combatRetreatPlans[0]!
    expect(plan.distance).toBeGreaterThan(0)

    // 在撤退方某一单位的所在格放入一枚**未参战**的同方战斗单位
    const host = plan.units[0]!
    const faction = plan.side === 'attacker' ? 'axis' : 'soviet'
    const extra = place(
      store,
      faction === 'axis' ? attackerRecord() : defenderRecord(),
      host.from,
      faction,
      'tag1',
    )
    const candidate = store.combatTagalongCandidates.find(
      (item) => item.unit.instanceId === extra.instanceId,
    )
    expect(candidate).toBeDefined()
    expect(candidate!.hostId).toBe(host.unitId)

    store.toggleCombatTagalong(extra.instanceId)
    expect(store.combatTagalongIds).toContain(extra.instanceId)
    // 点它的落点（第一个合法落点）给宿主，跟随者自动沿用
    const destination = host.destinations[0]!
    expect(store.setRetreatDestinationNow(host.unitId, destination.hex)).toBe(true)
    for (const other of plan.units) {
      if (other.unitId === host.unitId) continue
      expect(store.setRetreatDestinationNow(other.unitId, other.destinations[0]!.hex)).toBe(true)
    }
    // 攻方先选完才轮到守方：把其余各方也选齐
    for (const sidePlan of store.combatRetreatPlans) {
      for (const row of sidePlan.units) {
        if (row.chosen !== null) continue
        expect(store.setRetreatDestinationNow(row.unitId, row.destinations[0]!.hex)).toBe(true)
      }
    }
    expect(store.confirmCombatRetreats()).toBe(true)
    // 9.12c/9.12d：跟随者与宿主落在同一格
    expect(store.units.find((unit) => unit.instanceId === extra.instanceId)!.hex).toEqual(
      destination.hex,
    )
  })

  it('9.5：攻方付不出全额 ⇒ 取消攻击（12.4）', () => {
    setupBattle(store)
    expect(beginCombatWithSupply(store)).toBe(true)
    store.combatInputs.attackerAvailableT = 0
    expect(store.confirmCombatSupply()).toBe(false)
    expect(store.combatError).toMatchObject({ rule: '12.4' })
    // 仍停在补给步
    expect(store.combatState!.step).toBe('combatSupply')
  })

  it('9.5-B：守方拒付 ⇒ 战斗继续但守方以一半战斗值防御', () => {
    setupBattle(store)
    expect(beginCombatWithSupply(store)).toBe(true)
    store.combatInputs.defenderProvides = false
    expect(store.confirmCombatSupply()).toBe(true)
    expect(store.combatState!.supply!.defender.paid).toBe(false)
    expect(store.combatState!.supply!.defender.declined).toBe(true)
  })

  it('9.2：步骤未到就调用后一步 ⇒ 被拒绝（顺序不可颠倒）', () => {
    setupBattle(store)
    expect(beginCombatWithSupply(store)).toBe(true)
    // 还在补给步就宣布 AR ⇒ 拒绝
    store.combatInputs.attackerArUnitId = store.combatAttackers[0]!.instanceId
    expect(store.declareCombatArStep('attacker')).toBe(false)
    // 也还没到掷骰/损失步
    expect(store.rollCombatDice()).toBe(false)
    expect(store.confirmCombatLosses()).toBe(false)
  })

  it('9.11：强制损失落盘到单位军力；军力归零者移出盘面', () => {
    setupBattle(store)
    expect(beginCombatWithSupply(store)).toBe(true)
    expect(store.confirmCombatSupply()).toBe(true)
    store.combatInputs.attackerArUnitId = store.combatAttackers[0]!.instanceId
    store.declareCombatArStep('attacker')
    store.combatInputs.defenderArUnitId = store.battleDefenders[0]!.instanceId
    store.declareCombatArStep('defender')
    store.declareCombatTerrainStep()
    store.rollCombatSurprise()
    if (store.combatAwaitingShiftDie) store.rollCombatShiftDie()
    store.rollCombatDice()

    const before = new Map(store.units.map((unit) => [unit.instanceId, unit.steps]))
    expect(store.confirmCombatLosses()).toBe(true)
    // 攻方强制损失已落盘：每个攻方单位的军力不大于结算前，且至少有一个真的减少了
    const attackerIds = store.combatState!.composition.attackerIds
    let decreased = false
    for (const id of attackerIds) {
      const unit = store.units.find((item) => item.instanceId === id)
      const previous = before.get(id) ?? 0
      if (unit === undefined) {
        decreased = true // 军力归零 → 已移入死亡堆
        continue
      }
      expect(unit.steps).toBeLessThanOrEqual(previous)
      if (unit.steps < previous) decreased = true
    }
    expect(decreased).toBe(store.combatState!.dice!.result.attacker.losses > 0)
  })

  it('放弃本场战斗 ⇒ 交互状态清空（可重新选子）', () => {
    setupBattle(store)
    expect(beginCombatWithSupply(store)).toBe(true)
    store.cancelCombat()
    expect(store.combatState).toBeNull()
    expect(store.combatAttackerIds).toEqual([])
  })
})

describe('W7 C11：操作台战斗路径的结算复核（骰点 / 计算过程 / 规则号 / 修正来源）', () => {
  let store: ReturnType<typeof newStore>

  beforeEach(() => {
    store = newStore()
  })

  /** 走到第 6 步（terrain → surprise） */
  function driveToSurprise(store: ReturnType<typeof newStore>) {
    setupBattle(store)
    expect(beginCombatWithSupply(store)).toBe(true)
    expect(store.confirmCombatSupply()).toBe(true)
    store.combatInputs.attackerArUnitId = store.combatAttackers[0]!.instanceId
    store.declareCombatArStep('attacker')
    store.combatInputs.defenderArUnitId = store.battleDefenders[0]!.instanceId
    store.declareCombatArStep('defender')
    store.declareCombatTerrainStep()
  }

  it('C11：走到奇袭只有地形步时还没有复核过程（不臆造结论）', () => {
    driveToSurprise(store)
    expect(store.combatReview).toBeNull()
  })

  it('C11：奇袭结论给出 9.8 复核（DRM 与守方工事 −1 逐项写出）', () => {
    driveToSurprise(store)
    expect(store.rollCombatSurprise()).toBe(true)
    if (store.combatAwaitingShiftDie) expect(store.rollCombatShiftDie()).toBe(true)

    const review = store.combatReview
    expect(review).not.toBeNull()
    expect(review!.rule).toBe('9.8')
    expect(modifierTotal(review!)).toBe(
      store.combatState!.ar!.drm + (store.combatState!.defenderInHedgehog ? -1 : 0),
    )
  })

  it('C11：战斗掷骰给出 9.9 复核 —— 修正项之和 + 骰值 == 引擎的修正后骰值', () => {
    driveToSurprise(store)
    store.rollCombatSurprise()
    if (store.combatAwaitingShiftDie) store.rollCombatShiftDie()
    expect(store.rollCombatDice()).toBe(true)

    const review = store.combatReview
    const summary = store.combatSummary
    expect(review).not.toBeNull()
    expect(summary).not.toBeNull()
    expect(review!.rule).toBe('9.9')
    // 恒等式：骰值 + 各项修正之和 == 引擎给出的修正后骰值（界面看到的即引擎算的）
    expect(summary!.die + modifierTotal(review!)).toBe(summary!.modifiedDice)
    // 结果码与引擎一致
    const resultStep = review!.steps.find((step) => step.kind === 'result')
    expect(resultStep?.kind === 'result' && resultStep.value).toBe(summary!.raw)
    // 骰面来自本局的真实掷骰（日志与复核同源）
    const diceStep = review!.steps.find((step) => step.kind === 'dice')
    expect(diceStep?.kind === 'dice' && diceStep.rolls[0]?.total).toBe(summary!.die)
  })

  it('C11：战斗日志带上复核过程（骰点 / 计算过程 / 规则号 / 修正来源可展开）', () => {
    driveToSurprise(store)
    store.rollCombatSurprise()
    if (store.combatAwaitingShiftDie) store.rollCombatShiftDie()
    store.rollCombatDice()

    const withReview = store.log.filter((entry) => entry.derivation !== undefined)
    expect(withReview.length).toBeGreaterThan(0)
    const combatLog = withReview.find((entry) => entry.rule === '9.9')
    expect(combatLog).toBeDefined()
    expect(combatLog!.derivation!.title).toContain('战斗结算')
    // 修正项都写出值与来源
    const modifiers = combatLog!.derivation!.steps.filter((step) => step.kind === 'modifier')
    expect(modifiers).toHaveLength(3)
    expect(modifiers.every((step) => step.kind === 'modifier' && step.source.length > 0)).toBe(true)
  })

  it('C11：战果摘要所用的修正后骰值 == 复核合计步的值（两处口径一致）', () => {
    driveToSurprise(store)
    store.rollCombatSurprise()
    if (store.combatAwaitingShiftDie) store.rollCombatShiftDie()
    store.rollCombatDice()

    const subtotal = store.combatReview!.steps.find((step) => step.kind === 'subtotal')
    expect(subtotal?.kind === 'subtotal' && subtotal.value).toBe(store.combatSummary!.modifiedDice)
  })
})

/* ──────────── W7 C16：地图优先的战斗收尾（9.12 撤退落点 / 9.12g 推进 / 12.4 补给站） ──────────── */

/**
 * 12.4 / 12.6：为**双方各放一座足量补给站并声明为战斗补给来源**
 *
 * 规则依据：战斗补给只能从**己方补给站**经 12.3a 直接拖取 / 12.3b HQ 投递扣除；
 * 除专规的补给储备标记（1.7 / 21.10 的 Shells 与 Forage）外不存在「凭空可用的池子」。
 * 故夹具必须真的给双方摆出补给站，不能再靠一个共用池兜底。
 *
 * ★ 须在 `beginCombatNow()` **之后**调用：来源候选按当前战斗的攻守方分派。
 */
function declareSupplyForBoth(store: ReturnType<typeof newStore>): void {
  if (!store.spDumps.some((dump) => dump.id === 'sd-axis'))
    store.spDumps.push({ id: 'sd-axis', hex: { ...ATTACKER_HEX }, side: 'axis', sp: 8, t: 0 })
  if (!store.spDumps.some((dump) => dump.id === 'sd-soviet'))
    store.spDumps.push({ id: 'sd-soviet', hex: { ...DEFENDER_HEX }, side: 'soviet', sp: 8, t: 0 })
  for (const entry of store.combatSupplyDumps) {
    if (store.combatSupplyDumpIds[entry.side] !== null) continue
    const dump = entry.dumps[0]
    if (dump !== undefined) store.pickCombatSupplyDump(entry.side, dump.id)
  }
}

/**
 * 发起战斗并为双方声明补给来源（12.4：来源必须真实存在，见 `declareSupplyForBoth`）
 *
 * 夹具统一走本函数而不是裸 `beginCombatNow()`——否则战斗会停在"付不出战斗补给"而被 12.4 拒绝。
 * 断言"发起被拒"的用例不受影响：发起失败时不会去声明来源。
 */
function beginCombatWithSupply(store: ReturnType<typeof newStore>): boolean {
  const opened = store.beginCombatNow()
  if (opened) declareSupplyForBoth(store)
  return opened
}

/** 走完 9.2 的补给 → AR → 地形 → 奇袭 → 掷骰（停在「结算结果」） */
function driveToResolution(store: ReturnType<typeof newStore>) {
  expect(beginCombatWithSupply(store)).toBe(true)
  declareSupplyForBoth(store)
  expect(store.confirmCombatSupply()).toBe(true)
  store.combatInputs.attackerArUnitId = store.combatAttackers[0]!.instanceId
  store.declareCombatArStep('attacker')
  store.combatInputs.defenderArUnitId = store.battleDefenders[0]!.instanceId
  store.declareCombatArStep('defender')
  expect(store.declareCombatTerrainStep()).toBe(true)
  store.rollCombatSurprise()
  if (store.combatAwaitingShiftDie) store.rollCombatShiftDie()
  expect(store.rollCombatDice()).toBe(true)
}

/**
 * 从**当前步**推进到「结算结果」（战斗补给 → AR → 地形 → 奇袭 → 掷骰）
 *
 * 与 `driveToResolution` 的区别：本函数不自己发起战斗，故可用于**突袭**（8.0 已由 `overrunNow`
 * 建好战斗并停在 `combatSupply`）。
 */
function driveCombatSteps(store: ReturnType<typeof newStore>): void {
  let declared = false
  let guard = 0
  while (guard < 16) {
    guard += 1
    const state = store.combatState
    if (state === null || state.finished) break
    if (state.step === 'combatSupply') {
      // 12.4：先把双方来源声明好，再确认补给
      if (!declared) {
        declareSupplyForBoth(store)
        declared = true
      }
      if (!store.confirmCombatSupply()) break
      continue
    }
    if (state.step === 'declareAr') {
      if (store.combatInputs.attackerArUnitId === null) {
        store.combatInputs.attackerArUnitId = store.combatAttackers[0]?.instanceId ?? null
      }
      if (!store.declareCombatArStep('attacker')) break
      if (store.combatInputs.defenderArUnitId === null) {
        store.combatInputs.defenderArUnitId = store.battleDefenders[0]?.instanceId ?? null
      }
      if (!store.declareCombatArStep('defender')) break
      continue
    }
    if (state.step === 'declareTerrain') {
      if (!store.declareCombatTerrainStep()) break
      continue
    }
    if (state.step === 'surprise') {
      if (!store.rollCombatSurprise()) break
      if (store.combatAwaitingShiftDie) store.rollCombatShiftDie()
      continue
    }
    if (state.step === 'battleDice') {
      if (!store.rollCombatDice()) break
      continue
    }
    break
  }
}

/**
 * 结算第 8 步的另一种分配：**先尽量用军力损失**，军力不够时才用撤退格数
 *
 * 用于突袭（8.0）：9.12g-B 规定「攻方在选项中撤退 ⇒ 不得推进」，故要检验推进记账就得让攻方不必撤退。
 */
function driveResolutionLossFirst(store: ReturnType<typeof newStore>): void {
  let guard = 0
  while (guard < 12) {
    guard += 1
    const state = store.combatState
    if (state === null || state.finished) break
    if (state.step === 'losses') {
      if (!store.confirmCombatLosses()) break
      continue
    }
    if (state.step === 'options') {
      const requirement = store.combatRequirement!
      const isAttacker = state.resolution.stage === 'attackerOptions'
      const units = isAttacker ? store.combatAttackers : store.battleDefenders
      const capacity = units.reduce((sum, unit) => sum + unit.steps, 0)
      if (requirement.options <= capacity) {
        store.combatInputs.optionRetreatHexes = 0
        store.combatInputs.optionLossPoints = requirement.options
      } else {
        store.combatInputs.optionRetreatHexes = requirement.options
        store.combatInputs.optionLossPoints = 0
      }
      if (!store.confirmCombatOptions()) break
      continue
    }
    break
  }
}

/** 结算第 8 步：强制损失与选项都走完，且**至少让一方用 1 格撤退**（以便检验 9.12 的地图优先交互） */
function driveResolution(store: ReturnType<typeof newStore>): void {
  let guard = 0
  while (guard < 12) {
    guard += 1
    const state = store.combatState
    if (state === null || state.finished) break
    if (state.step === 'losses') {
      if (!store.confirmCombatLosses()) break
      continue
    }
    if (state.step === 'options') {
      const requirement = store.combatRequirement!
      const retreat = Math.min(1, requirement.options)
      store.combatInputs.optionRetreatHexes = retreat
      store.combatInputs.optionLossPoints = requirement.options - retreat
      if (!store.confirmCombatOptions()) break
      continue
    }
    break
  }
}

describe('W7 C16：战斗收尾的地图优先交互', () => {
  let store: ReturnType<typeof newStore>

  beforeEach(() => {
    store = newStore()
  })

  it('12.4：点地图上的补给站 ⇒ 声明战斗补给的付款来源（写进可用 T）', () => {
    setupBattle(store)
    // 摆一个含 6 T 的补给站（12.1b：任何含 SP 的位置都是补给站）
    store.spDumpDraft.hexText = `${ATTACKER_HEX.col}.${ATTACKER_HEX.row}`
    store.spDumpDraft.sp = 0
    store.spDumpDraft.t = 6
    expect(store.addSpDump()).toBe(true)
    const dump = store.spDumps[0]!

    expect(beginCombatWithSupply(store)).toBe(true)
    expect(store.combatState!.step).toBe('combatSupply')
    /*
     * 候选表须在**开战之后**看：12.3a 直接拖取与 12.3b HQ 投递的可达性都是相对
     * **本次战斗的防御格**算的（开战前没有防御格，无从判断哪座补给站够得着）。
     */
    expect(store.combatSupplyDumps[0]!.dumps.map((item) => item.id)).toContain(dump.id)
    store.combatInputs.attackerAvailableT = 0
    expect(store.pickCombatSupplyDump('attacker', dump.id)).toBe(true)
    expect(store.combatInputs.attackerAvailableT).toBe(6)
    expect(store.combatSupplyDumpIds.attacker).toBe(dump.id)
    // 补给齐了就能继续（9.5）
    expect(store.confirmCombatSupply()).toBe(true)
  })

  it('9.12：撤退落点由引擎规划；点地图上的落点即写入该单位的撤退路径，攻方选完才轮到守方', () => {
    setupBattle(store)
    driveToResolution(store)
    driveResolution(store)
    expect(store.combatState!.step).toBe('retreat')

    const plans = store.combatRetreatPlans
    expect(plans.length).toBeGreaterThan(0)
    // 9.12c/9.10b：攻方在守方之前
    if (plans.length === 2) expect(plans[0]!.side).toBe('attacker')
    for (const plan of plans) {
      expect(plan.distance).toBeGreaterThan(0)
      expect(plan.units.length).toBeGreaterThan(0)
      // 落点必须落在完整撤退距离上，且引擎给了等长路径（9.12）
      for (const row of plan.units) {
        expect(row.destinations.length).toBeGreaterThan(0)
        for (const destination of row.destinations) {
          expect(hexDistance(row.from, destination.hex)).toBe(plan.distance)
          expect(destination.path).toHaveLength(plan.distance)
        }
      }
    }

    // 逐个单位点它的第一个合法落点 ⇒ 路径写进 combatInputs.retreatPaths
    for (const plan of plans) {
      for (const row of plan.units) {
        const destination = row.destinations[0]!
        expect(store.setRetreatDestinationNow(row.unitId, destination.hex)).toBe(true)
        expect(store.combatInputs.retreatPaths[row.unitId]).not.toBe('')
      }
    }
    // 全部选齐后地图优先交互判定为 complete，且能直接确认撤退
    expect(store.combatRetreatPlans.every((plan) => plan.complete)).toBe(true)
    expect(store.confirmCombatRetreats()).toBe(true)
    expect(store.combatState!.step).toBe('advance')
  })

  it('9.12g：推进格由防御格是否清空决定；点它就是选出可推进单位，确认后收束', () => {
    setupBattle(store)
    driveToResolution(store)
    driveResolution(store)
    if (store.combatState!.step === 'retreat') {
      for (const plan of store.combatRetreatPlans) {
        for (const row of plan.units) {
          store.setRetreatDestinationNow(row.unitId, row.destinations[0]!.hex)
        }
      }
      expect(store.confirmCombatRetreats()).toBe(true)
    }
    expect(store.combatState!.step).toBe('advance')

    const cleared = store.combatDefendingHexCleared
    expect(store.combatAdvanceHex === null).toBe(!cleared)
    if (cleared && store.combatAdvanceCandidates.some((item) => item.paid)) {
      expect(store.advanceNow(store.combatAdvanceHex!)).toBe(true)
      expect(store.combatInputs.advanceUnitIds.length).toBeGreaterThan(0)
      // 选错了格 ⇒ 拒绝
      expect(store.advanceNow({ col: DEFENDER_HEX.col, row: DEFENDER_HEX.row + 20 })).toBe(false)
    } else {
      store.clearAdvanceNow()
      expect(store.combatInputs.advanceUnitIds).toEqual([])
    }
    expect(store.confirmCombatAdvance()).toBe(true)
    expect(store.combatState!.finished).toBe(true)
  })
})

/* ──────────── W7 C16：移动中的突袭（8.0/8.1）端到端 ──────────── */

describe('W7 C16：行进间突袭的地图优先流程', () => {
  let store: ReturnType<typeof newStore>

  beforeEach(() => {
    store = newStore()
    // 固定种子 ⇒ 骰点可复现（本组的断言涉及战果后的移动记账，必须在确定结果下核对）
    store.resetAll(11)
  })

  /** 强攻方（A20 师，军力 ≥4 ⇒ 不会在战果里被一次打光，便于核对记错） */
  const overrunMover = () =>
    pickRecord(
      'axis',
      (record) =>
        record.classes?.movementClass === 'leg' &&
        record.attackCapable === true &&
        (record.factors?.combat?.attack ?? 0) >= 20 &&
        (record.steps?.total ?? 0) >= 4,
    )

  /** 弱守方（9.0：常规战斗只针对战斗单位；弱守方让攻方战果稳定） */
  const weakDefender = () =>
    pickRecord(
      'soviet',
      (record) => record.isCombat === true && (record.factors?.combat?.attack ?? 0) <= 2,
    )

  /** 弱突袭者（战斗值低 ⇒ CRT 会逼出攻方选项，用于覆盖 8.1f 的撤退分支） */
  const weakMover = () =>
    pickRecord(
      'axis',
      (record) =>
        record.classes?.movementClass === 'leg' &&
        record.attackCapable === true &&
        (record.factors?.combat?.attack ?? 0) >= 3 &&
        (record.factors?.combat?.attack ?? 0) <= 4,
    )

  /** 强守方（与弱突袭者配对，制造低攻防比；苏军最强为 A20 坦克师） */
  const strongDefender = () =>
    pickRecord(
      'soviet',
      (record) => record.isCombat === true && (record.factors?.combat?.attack ?? 0) >= 20,
    )

  /** 把守方摆在「起点相邻且满足 8.1」的格上并返回它（资格由引擎判，测试不自己算） */
  function placeDefenderForOverrun(): HexRef {
    const mover = place(store, overrunMover(), ATTACKER_HEX, 'axis', 'ov1')
    store.setPhase('movement')
    goToMovementStep(store)
    store.setTool('move')
    store.setFuelPool(0, 60)
    // 条 10（批 M）：点格只建取子清单，开拔交由「开始移动」按钮
    store.clickHex(mover.hex)
    expect(store.confirmMovePick()).toBe(true)
    expect(store.moveInteraction).not.toBeNull()

    for (const direction of HEX_DIRECTIONS) {
      const candidate = neighbor(ATTACKER_HEX, direction)
      if (!isOnMap(candidate)) continue
      if (!mapLayers.hexes.some((h) => h.col === candidate.col && h.row === candidate.row)) continue
      const defender = place(store, weakDefender(), candidate, 'soviet', `ovd-${direction}`)
      if (store.overrunTargets.some((hint) => hexDistance(hint.hex, candidate) === 0)) {
        return candidate
      }
      // 该格不满足 8.1 ⇒ 收回这枚，换下一格
      store.units = store.units.filter((unit) => unit.instanceId !== defender.instanceId)
    }
    throw new Error('起点周围找不到满足 8.1 的突袭目标格')
  }

  it('8.0/8.1a：移动中点紫环格 ⇒ 发起突袭（attackType=overrun）；结算后扣 3 MP 并按 8.0 进格', () => {
    const target = placeDefenderForOverrun()
    const before = store.units.find((unit) => unit.instanceId === 'ov1')!
    const mpBefore = before.mpSpent

    expect(store.overrunNow(target)).toBe(true)
    expect(store.combatState).not.toBeNull()
    expect(store.combatState!.attackType).toBe('overrun')
    expect(store.overrunContext).not.toBeNull()

    // 8.1e：突袭永不给予进击标记；走完九步后由 confirmCombatAdvance 收束记账
    driveCombatSteps(store)
    driveResolutionLossFirst(store)
    if (store.combatState!.step === 'retreat') {
      for (const plan of store.combatRetreatPlans) {
        for (const row of plan.units) {
          store.setRetreatDestinationNow(row.unitId, row.destinations[0]!.hex)
        }
      }
      expect(store.confirmCombatRetreats()).toBe(true)
    }
    if (!store.confirmCombatAdvance()) {
      // 规则允许的拒绝（9.12g-A/-B）；突袭的 3 MP 与 8.0 后果仍已记账
      expect(store.combatError?.rule).toMatch(/9\.12g/)
      store.clearAdvanceNow()
      expect(store.confirmCombatAdvance()).toBe(true)
    }

    const after = store.units.find((unit) => unit.instanceId === 'ov1')!
    // 8.1a：每次突袭固定 3 MP
    expect(after.mpSpent).toBeCloseTo(mpBefore + 3, 6)
    // 8.0：防御方离开该格 ⇒ 参突者必须进入该格（不额外扣 MP）
    if (store.combatDefendingHexCleared) {
      expect(after.hex).toEqual(target)
    }
    // 托管信息用毕即清（不可重复记账）
    expect(store.overrunContext).toBeNull()
    expect(store.combatState!.finished).toBe(true)
  })

  it('9.12g-B：攻方在选项中撤退时推进被拒，但突袭的 3 MP 仍记账、移动就地结束（8.1f）', () => {
    const target = placeDefenderForOverrun()
    const mpBefore = store.units.find((unit) => unit.instanceId === 'ov1')!.mpSpent
    expect(store.overrunNow(target)).toBe(true)

    // 走完 9.2 前七步（8.0 已由 overrunNow 建好战斗并停在补给步）
    driveCombatSteps(store)
    // 选项一律吃撤退（9.10a 允许把全部点数用在撤退上）
    let guard = 0
    while (guard < 12) {
      guard += 1
      const state = store.combatState
      if (state === null || state.finished) break
      if (state.step === 'losses') {
        if (!store.confirmCombatLosses()) break
        continue
      }
      if (state.step === 'options') {
        const requirement = store.combatRequirement!
        store.combatInputs.optionRetreatHexes = requirement.options
        store.combatInputs.optionLossPoints = 0
        if (!store.confirmCombatOptions()) break
        continue
      }
      break
    }
    if (store.combatState!.step === 'retreat') {
      for (const plan of store.combatRetreatPlans) {
        for (const row of plan.units) {
          expect(store.setRetreatDestinationNow(row.unitId, row.destinations[0]!.hex)).toBe(true)
        }
      }
      expect(store.confirmCombatRetreats()).toBe(true)
    }

    const attackerRetreated = (store.combatState!.resolution.attacker.option?.retreatHexes ?? 0) > 0
    const advanced = store.confirmCombatAdvance()
    if (!advanced) {
      // 被拒是规则允许的：攻方在选项中撤退（9.12g-B）或没有付过补给的攻方单位（9.12g-A）
      expect(attackerRetreated || store.combatError?.rule === '9.12g-A').toBe(true)
      store.clearAdvanceNow()
      expect(store.confirmCombatAdvance()).toBe(true)
    }

    const after = store.units.find((unit) => unit.instanceId === 'ov1')!
    expect(after.mpSpent).toBeCloseTo(mpBefore + 3, 6)
    expect(store.overrunContext).toBeNull()
    expect(store.combatState!.finished).toBe(true)
    // 本场的骰点未必给攻方选项点；只有**确实**选了撤退才该结束移动（8.1f），故按事实断言
    if (attackerRetreated) {
      expect(after.movementEnded).toBe(true)
      expect(store.activeMoveUnits).toHaveLength(0)
    }
  })

  it('8.1f：攻方**确实**在选项中撤退 ⇒ 其本阶段移动自动结束（不只是不能再突袭）', () => {
    // 强攻方 vs 弱守方 + 固定种子 31（该种子下 CRT 以「Ao1」逼攻方撤退 1 格，且攻方存活）
    // ——这样才真正走到 8.1f 的撤退分支（低攻值单位会在损失步直接阵亡，覆盖不到该分支）
    store.resetAll(31)
    const mover = place(store, overrunMover(), ATTACKER_HEX, 'axis', 'ov1')
    store.setPhase('movement')
    goToMovementStep(store)
    store.setTool('move')
    store.setFuelPool(0, 60)
    // 先开始移动（突袭目标依赖「移动中的单位」，顺序不能反）
    store.clickHex(ATTACKER_HEX)
    expect(store.confirmMovePick()).toBe(true)
    expect(store.moveInteraction?.unitIds).toEqual([mover.instanceId])

    let target: HexRef | null = null
    for (const direction of HEX_DIRECTIONS) {
      const candidate = neighbor(ATTACKER_HEX, direction)
      if (!isOnMap(candidate)) continue
      if (!mapLayers.hexes.some((h) => h.col === candidate.col && h.row === candidate.row)) continue
      const defender = place(store, weakDefender(), candidate, 'soviet', `ovd-${direction}`)
      if (store.overrunTargets.some((hint) => hexDistance(hint.hex, candidate) === 0)) {
        target = candidate
        break
      }
      store.units = store.units.filter((unit) => unit.instanceId !== defender.instanceId)
    }
    expect(target, '应能找到满足 8.1 的突袭目标格').not.toBeNull()

    const mpBefore = mover.mpSpent
    expect(store.overrunNow(target!)).toBe(true)

    driveCombatSteps(store)
    // 攻方选项一律吃撤退（9.10a：整点可用撤退满足）
    let guard = 0
    while (guard < 12) {
      guard += 1
      const state = store.combatState
      if (state === null || state.finished) break
      if (state.step === 'losses') {
        if (!store.confirmCombatLosses()) break
        continue
      }
      if (state.step === 'options') {
        const requirement = store.combatRequirement!
        store.combatInputs.optionRetreatHexes = requirement.options
        store.combatInputs.optionLossPoints = 0
        if (!store.confirmCombatOptions()) break
        continue
      }
      break
    }
    if (store.combatState?.step === 'retreat') {
      for (const plan of store.combatRetreatPlans) {
        for (const row of plan.units) {
          store.setRetreatDestinationNow(row.unitId, row.destinations[0]!.hex)
        }
      }
      store.confirmCombatRetreats()
    }

    const attackerRetreated = (store.combatState!.resolution.attacker.option?.retreatHexes ?? 0) > 0
    expect(attackerRetreated, '本场必须让攻方撤退才算覆盖 8.1f').toBe(true)

    expect(store.confirmCombatAdvance()).toBe(true)
    // 8.1a：3 MP 仍要记（撤退不豁免突袭成本）
    expect(mover.mpSpent).toBeCloseTo(mpBefore + 3, 6)
    // 8.1f：撤退 ⇒ 当前阶段移动结束，且不再有任何「仍在移动中」的单位
    expect(mover.movementEnded).toBe(true)
    expect(store.activeMoveUnits).toHaveLength(0)
    expect(store.overrunContext).toBeNull()
  })

  it('8.0：放弃本场突袭 ⇒ 不记账、不消耗 MP（8.1a 尚未扣除）', () => {
    const target = placeDefenderForOverrun()
    const before = store.units.find((unit) => unit.instanceId === 'ov1')!
    const mpBefore = before.mpSpent

    expect(store.overrunNow(target)).toBe(true)
    store.cancelCombat()

    expect(store.overrunContext).toBeNull()
    expect(store.combatState).toBeNull()
    expect(store.units.find((unit) => unit.instanceId === 'ov1')!.mpSpent).toBeCloseTo(mpBefore, 6)
  })

  it('9.2：前一场未收束时不得再发起突袭（不静默顶掉前一场的结论与记账）', () => {
    const target = placeDefenderForOverrun()
    expect(store.overrunNow(target)).toBe(true)
    const firstHex = store.combatState!.composition.defendingHex

    // 同一目标再点一次：应被拒，且前一场仍在
    expect(store.overrunNow(target)).toBe(false)
    expect(store.combatState).not.toBeNull()
    expect(store.combatState!.composition.defendingHex).toEqual(firstHex)
    expect(store.log[0]!.rule).toBe('9.2')
  })

  it('8.1a：突袭未结算时不能结束移动（否则 3 MP 与进格无处记账）', () => {
    const target = placeDefenderForOverrun()
    expect(store.overrunNow(target)).toBe(true)

    store.finishMove()

    // 移动交互未被结束，突袭托管信息仍在 ⇒ 玩家可继续结算或放弃
    expect(store.moveInteraction).not.toBeNull()
    expect(store.overrunContext).not.toBeNull()
    expect(store.log[0]!.rule).toBe('8.1a')

    // 放直这场突袭之后，结束移动恢复可用
    store.cancelCombat()
    expect(store.overrunContext).toBeNull()
    store.finishMove()
    expect(store.moveInteraction!.finished).toBe(true)
  })

  it('8.1a：参突单位阵亡 ⇒ 突袭无需记账，且移动交互**就地收束**（不留悬挂的已亡 id）', () => {
    // 低攻值攻方（A≤4，军力 1）遇强守方：损失步即阵亡 ⇒ 参突者已不在盘面
    store.resetAll(18)
    const mover = place(store, weakMover(), ATTACKER_HEX, 'axis', 'ov1')
    store.setPhase('movement')
    goToMovementStep(store)
    store.setTool('move')
    store.setFuelPool(0, 60)
    store.clickHex(ATTACKER_HEX)
    expect(store.confirmMovePick()).toBe(true)
    expect(store.moveInteraction?.unitIds).toEqual([mover.instanceId])

    let target: HexRef | null = null
    for (const direction of HEX_DIRECTIONS) {
      const candidate = neighbor(ATTACKER_HEX, direction)
      if (!isOnMap(candidate)) continue
      if (!mapLayers.hexes.some((h) => h.col === candidate.col && h.row === candidate.row)) continue
      const defender = place(store, strongDefender(), candidate, 'soviet', `ovd-${direction}`)
      if (store.overrunTargets.some((hint) => hexDistance(hint.hex, candidate) === 0)) {
        target = candidate
        break
      }
      store.units = store.units.filter((unit) => unit.instanceId !== defender.instanceId)
    }
    expect(target).not.toBeNull()
    expect(store.overrunNow(target!)).toBe(true)

    driveCombatSteps(store)
    // 损失步把攻方打光（军力归零 ⇒ 移出盘面）
    let guard = 0
    while (guard < 12) {
      guard += 1
      const state = store.combatState
      if (state === null || state.finished) break
      if (state.step === 'losses') {
        if (!store.confirmCombatLosses()) break
        continue
      }
      if (state.step === 'options') {
        // 选项点必须刚好分完（9.10a）；超出能承受的军力时改用撤退格数
        const requirement = store.combatRequirement!
        const isAttacker = state.resolution.stage === 'attackerOptions'
        const units = isAttacker ? store.combatAttackers : store.battleDefenders
        const capacity = units.reduce((sum, unit) => sum + unit.steps, 0)
        if (requirement.options <= capacity) {
          store.combatInputs.optionRetreatHexes = 0
          store.combatInputs.optionLossPoints = requirement.options
        } else {
          store.combatInputs.optionRetreatHexes = requirement.options
          store.combatInputs.optionLossPoints = 0
        }
        if (!store.confirmCombatOptions()) break
        continue
      }
      break
    }
    if (store.combatState?.step === 'retreat') {
      for (const plan of store.combatRetreatPlans) {
        for (const row of plan.units) {
          store.setRetreatDestinationNow(row.unitId, row.destinations[0]!.hex)
        }
      }
      store.confirmCombatRetreats()
    }
    expect(
      store.units.some((unit) => unit.instanceId === mover.instanceId),
      '本场应把攻方打光（否则覆盖不到「参突者已不在盘面」）',
    ).toBe(false)

    expect(store.confirmCombatAdvance()).toBe(true)

    // 无需记账（没有对象），但交互必须收束：否则界面卡在「移动中」、点别的单位也走不动
    expect(store.overrunContext).toBeNull()
    expect(store.moveInteraction).not.toBeNull()
    expect(store.moveInteraction!.finished).toBe(true)
    expect(store.activeMoveUnits).toHaveLength(0)
    expect(store.log.some((row) => row.text.includes('参突单位已不在盘面'))).toBe(true)
  })

  /** 摆一个 N 枚的**移动堆叠**（同格同方）并让它们一起开始移动，返回满足 8.1 的突袭目标格 */
  function placeStackForOverrun(count: number): HexRef {
    const movers = Array.from({ length: count }, (_, index) =>
      place(store, overrunMover(), ATTACKER_HEX, 'axis', `ov${index + 1}`),
    )
    store.setPhase('movement')
    goToMovementStep(store)
    store.setTool('move')
    store.setFuelPool(0, 60)
    // 6.1：整堆叠移动（界面上就是「整堆叠」开关）
    store.setStackSelect(true)
    // 条 10（批 M）：点格只建取子清单，开拔交由「开始移动」按钮
    store.clickHex(movers[0]!.hex)
    expect(store.confirmMovePick()).toBe(true)
    expect(store.moveInteraction).not.toBeNull()
    expect(store.moveInteraction!.unitIds).toHaveLength(count)

    for (const direction of HEX_DIRECTIONS) {
      const candidate = neighbor(ATTACKER_HEX, direction)
      if (!isOnMap(candidate)) continue
      if (!mapLayers.hexes.some((h) => h.col === candidate.col && h.row === candidate.row)) continue
      const defender = place(store, weakDefender(), candidate, 'soviet', `ovd-${direction}`)
      if (store.overrunTargets.some((hint) => hexDistance(hint.hex, candidate) === 0)) {
        return candidate
      }
      store.units = store.units.filter((unit) => unit.instanceId !== defender.instanceId)
    }
    throw new Error('起点周围找不到满足 8.1 的突袭目标格')
  }

  /** 走完 9.2 九步并收束推进步（含规则允许的拒绝分支） */
  function finishOverrunFlow(): void {
    driveCombatSteps(store)
    driveResolutionLossFirst(store)
    if (store.combatState?.step === 'retreat') {
      for (const plan of store.combatRetreatPlans) {
        for (const row of plan.units) {
          store.setRetreatDestinationNow(row.unitId, row.destinations[0]!.hex)
        }
      }
      store.confirmCombatRetreats()
    }
    if (!store.confirmCombatAdvance()) {
      expect(store.combatError?.rule).toMatch(/9\.12g/)
      store.clearAdvanceNow()
      expect(store.confirmCombatAdvance()).toBe(true)
    }
  }

  it('8.1g：两枚堆叠一起突袭 ⇒ **两枚都**各扣 3 MP 并一并记账（不可只记第一枚）', () => {
    const target = placeStackForOverrun(2)
    const mpBefore = new Map(
      store.units
        .filter((unit) => unit.instanceId === 'ov1' || unit.instanceId === 'ov2')
        .map((unit) => [unit.instanceId, unit.mpSpent]),
    )
    expect(mpBefore.size).toBe(2)

    expect(store.overrunNow(target)).toBe(true)
    finishOverrunFlow()

    // 8.1a：每次突袭固定 3 MP —— 参突的**每一枚**都要记上
    for (const id of ['ov1', 'ov2']) {
      const after = store.units.find((unit) => unit.instanceId === id)!
      expect(after.mpSpent, `${id} 未记账`).toBeCloseTo(mpBefore.get(id)! + 3, 6)
    }
    expect(store.overrunContext).toBeNull()
  })

  it('8.1g：两枚堆叠突袭后同步进格（防御方离开时两枚都进）', () => {
    const target = placeStackForOverrun(2)
    expect(store.overrunNow(target)).toBe(true)
    finishOverrunFlow()

    if (store.combatDefendingHexCleared) {
      for (const id of ['ov1', 'ov2']) {
        const after = store.units.find((unit) => unit.instanceId === id)!
        expect(after.hex, `${id} 未进入防御格`).toEqual(target)
      }
    }
  })

  /**
   * 8.1g + 8.1h：堆叠里混有**不可参突**的单位时，必须能只挑合格者参突
   *
   * 这是「突袭打不出来」的根因：`canOverrun` 要求每一名参突者都合格，
   * 故整堆叠参突会被整体否决（紫环一个都不出现）；而 8.1h 明确允许其余单位留驻。
   * 有了堆叠取子，只勾合格者就能照常发起并结算。
   */
  it('8.1g/8.1h：堆叠含不可攻击单位 ⇒ 整堆叠突袭无目标；只勾合格者即可正常结算', () => {
    // 一枚合格的突袭者 + 一枚不可攻击的卡车（同格同方）
    const mover = place(store, overrunMover(), ATTACKER_HEX, 'axis', 'ov1')
    const carrier = place(
      store,
      pickRecord('axis', (record) => record.attackCapable !== true && record.isCombat !== true),
      ATTACKER_HEX,
      'axis',
      'truck1',
    )
    store.setPhase('movement')
    goToMovementStep(store)
    store.setTool('move')
    store.setFuelPool(0, 60)
    // 先只选合格那枚开拔（取子路径），再摆守方
    store.clickHex(ATTACKER_HEX)
    expect(store.movePickHex).toEqual(ATTACKER_HEX)
    store.setMovePickOnly(mover.instanceId)
    expect(store.confirmMovePick()).toBe(true)
    expect(store.moveInteraction!.unitIds).toEqual([mover.instanceId])

    let target: HexRef | null = null
    for (const direction of HEX_DIRECTIONS) {
      const candidate = neighbor(ATTACKER_HEX, direction)
      if (!isOnMap(candidate)) continue
      if (!mapLayers.hexes.some((h) => h.col === candidate.col && h.row === candidate.row)) continue
      const defender = place(store, weakDefender(), candidate, 'soviet', `ovd-${direction}`)
      if (store.overrunTargets.some((hint) => hexDistance(hint.hex, candidate) === 0)) {
        target = candidate
        break
      }
      store.units = store.units.filter((unit) => unit.instanceId !== defender.instanceId)
    }
    expect(target, '只勾合格者后应出现可突袭目标格').not.toBeNull()

    const moverMpBefore = mover.mpSpent
    expect(store.overrunNow(target!)).toBe(true)
    finishOverrunFlow()

    // 8.1a：参突者记账
    expect(mover.mpSpent).toBeCloseTo(moverMpBefore + 3, 6)
    expect(store.overrunContext).toBeNull()
    // 8.1h：留驻的卡车不受影响（既没动、也没耗 MP）
    expect(carrier.hex).toEqual(ATTACKER_HEX)
    expect(carrier.mpSpent).toBe(0)
  })
})

/**
 * 5.10b-A / 5.7 / 5.8：模式折算**经状态桥**生效（B1 接线验证）
 *
 * 引擎单测（`tests/engine/battle.test.ts`）证明 `unitBattleStrength` 会折算，但证明不了
 * 「桥接层把 `dg` / `mode` / `releasedFromReserve` 传下去了」——而这正是原来出问题的地方：
 * 模式矩阵一直在算，战斗路径读的却是印值。本组用例走**真实 store 流程**跑完 9.2 前四步，
 * 直接读引擎给出的攻守战斗值，故桥接层漏传任一字段都会变红。
 */
describe('5.10b-A / 5.7 / 5.8：模式折算经状态桥生效', () => {
  /** 走完 ①构成 → ②补给 → ③行动值 → ④地形，返回双方战斗值合计（此时 9.7 攻防比已算出） */
  function strengthsWith(configureDefender: (defender: ConsoleUnit) => void): {
    attackerTotal: number
    defenderTotal: number
  } {
    const store = newStore()
    const { attacker, defender } = setupBattle(store)
    configureDefender(defender)

    expect(beginCombatWithSupply(store)).toBe(true)
    expect(store.confirmCombatSupply()).toBe(true)
    store.combatInputs.attackerArUnitId = attacker.instanceId
    expect(store.declareCombatArStep('attacker')).toBe(true)
    store.combatInputs.defenderArUnitId = store.battleDefenders[0]!.instanceId
    expect(store.declareCombatArStep('defender')).toBe(true)
    expect(store.declareCombatTerrainStep()).toBe(true)

    const odds = store.combatState!.odds!
    return {
      attackerTotal: odds.attackerStrengthById.reduce((sum, item) => sum + item.strength, 0),
      defenderTotal: odds.defenderStrengthById.reduce((sum, item) => sum + item.strength, 0),
    }
  }

  it('对照：无标记时守方按印值参战（基线）', () => {
    const { attackerTotal, defenderTotal } = strengthsWith(() => {})
    expect(attackerTotal).toBeGreaterThan(0)
    expect(defenderTotal).toBeGreaterThan(0)
  })

  it('5.10b-A：守方 DG ⇒ 防御值减半（印值 × ½，由桥接层传入的 dg 触发）', () => {
    const plain = strengthsWith(() => {})
    const dg = strengthsWith((defender) => {
      defender.mode.dg = true
    })
    expect(dg.defenderTotal).toBe(plain.defenderTotal * 0.5)
    // 攻方不带 DG，故不变——证明折算按**角色**生效，不是对全场统一打折
    expect(dg.attackerTotal).toBe(plain.attackerTotal)
  })

  it('5.7：守方处于预备模式（未释放）⇒ 防御值减半', () => {
    const plain = strengthsWith(() => {})
    const reserve = strengthsWith((defender) => {
      defender.mode.mode = 'reserve'
    })
    expect(reserve.defenderTotal).toBe(plain.defenderTotal * 0.5)
    expect(reserve.attackerTotal).toBe(plain.attackerTotal)
  })

  it('5.7b：守方预备**已释放** ⇒ 回到印值（标记已移除）', () => {
    const plain = strengthsWith(() => {})
    const released = strengthsWith((defender) => {
      defender.mode.mode = 'reserve'
      defender.mode.releasedFromReserve = true
    })
    expect(released.defenderTotal).toBe(plain.defenderTotal)
  })

  it('5.8：战略模式守方 ⇒ 战斗值为零（9.14a 零战斗值的列位特例随后生效）', () => {
    const { defenderTotal } = strengthsWith((defender) => {
      defender.mode.mode = 'strat'
      defender.mode.orientation = 'move'
    })
    expect(defenderTotal).toBe(0)
  })

  it('12.8d：断补守方战斗值减半——把 12.6 的标记串到战斗结算上', () => {
    const plain = strengthsWith(() => {})
    const outOfSupply = strengthsWith((defender) => {
      defender.hasTraceSupply = false
    })
    // 9.5a/12.8d：断补 ×½；攻方不受影响（折算按单位判，不是全场打折）
    expect(outOfSupply.defenderTotal).toBe(plain.defenderTotal * 0.5)
    expect(outOfSupply.attackerTotal).toBe(plain.attackerTotal)
  })
})
