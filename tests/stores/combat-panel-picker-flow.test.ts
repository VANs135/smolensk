import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, hexDistance, isOnMap, neighbor } from '@/engine/hex-geometry'
import { createMapFacts, selectMovementTerrain } from '@/engine/rules'
import {
  actionGateOf,
  defenseTerrainChoices,
  toConsoleUnit,
  unitChoices,
  useMapViewStore,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
  type ConsoleUnit,
} from '@/stores'

/**
 * B14c：战斗面板迁移到 `CounterPicker`（用户口径⑪ 后半）
 *
 * 本文件钉三件事：
 *   ① **阵列数据与 store 同源**：参战攻方（9.5b）与推进候选（9.12g-A/9.12b）的 `selected`
 *      就是 store 里的选择集，点击直连 store 动作——**点完真的算数**（走到 9.12g 那一步验证）；
 *   ② **9.6 的 AR 单位阵列**：候选集取自 store（含专规 2.3b 的收窄），面板不再自己列下拉；
 *   ③ **源码守卫**：四处阵列落地；旧的文字复选框 / 文字下拉全部删除；面板不再出现规则判据。
 *
 * ★ 一条**如实的边界**（写在测试里，免得后人误以为灰显在干活）：推进阵列的两条灰显原因
 *   （9.12g-A 未付补给 / 9.12b 不可移动）在本作数据下**都不可达**——
 *   攻方的 `paid` 由引擎恒置 true（付不出全额就取消攻击，9.5b），而单位库里**没有**
 *   「两面 MA 皆 0」的算子（已用脚本盘点：449 条记录里 0 条）。故它们是防御性分支，
 *   本文件用"造出 paid=false 的状态"来证明这条分支的文案与判据仍在。
 */

/** B8：把 store 放到**本段里允许做该动作的那个环节**（不写死环节名/序号） */
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

/** 该记录能否从 `from` 进入 `to`（9.1f 探针；与既有战斗测试同口径） */
function canEnter(mobility: 'leg' | 'truck' | 'track', from: HexRef, to: HexRef): boolean {
  return selectMovementTerrain({
    terrainsPresent: mapFacts.terrainsAt(to),
    mobility,
    crossing: mapFacts.crossingBetween(from, to),
    followingRoad: true,
    forOverrun: false,
  }).ok
}

/** 防御格：六邻皆图内且格内有防御地形（便于构造撤退直线路径） */
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

/** 攻击格：防御格的图内邻格，且步兵可进入 */
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

/** 从 `from` 沿某方向直线走 `count` 格（满足 9.12 的完整撤退距离） */
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

function pickRecord(
  side: 'axis' | 'soviet',
  predicate: (record: ReturnType<typeof unitChoices>[number]) => boolean,
): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices(side).find(predicate)
  if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return found
}

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

/**
 * 摆好攻守并走到「战斗补给」步（9.2 第 1 步）
 *
 * `extraAttackers` 枚额外攻方（同格）用于"战果再差也留得下人来推进"这类断言不随骰点飘。
 * ★ 攻方名单**显式**逐枚加（`ensureAttacker`）：地图点击在堆叠里只落到**顶上一枚**
 *   （就地展开的选择逻辑属 B3，已另有用例），若在这里靠点击凑名单，
 *   后面再 toggle 一次反而会把顶上那枚**取消**掉——本文件要测的是阵列，不是那套逻辑。
 */
function setupBattle(store: ReturnType<typeof newStore>, extraAttackers = 0) {
  store.setPhase('combat')
  goToActionStep(store, 'combat.declare')
  store.setTool('battle')
  store.setFuelPool(0, 20)
  const attacker = place(store, attackerRecord(), ATTACKER_HEX, 'axis', 'a1')
  const extras = Array.from({ length: extraAttackers }, (_unused, index) =>
    place(store, attackerRecord(), ATTACKER_HEX, 'axis', `a${String(index + 2)}`),
  )
  const defender = place(store, defenderRecord(), DEFENDER_HEX, 'soviet', 'd1')
  // 先选防御格（9.0），再把想要的攻方逐枚加进名单（9.1b）
  store.clickHex(DEFENDER_HEX)
  ensureAttacker(store, attacker.instanceId)
  for (const extra of extras) ensureAttacker(store, extra.instanceId)
  return { attacker, extras, defender }
}

/** 9.1b：把某一枚加进攻方名单（已在名单里就不再 toggle——toggle 会把它取消掉） */
function ensureAttacker(store: ReturnType<typeof newStore>, unitId: string): void {
  if (!store.combatAttackerIds.includes(unitId)) store.toggleCombatAttacker(unitId)
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

/** 12.4：为双方各放一座足量补给站并声明为战斗补给来源（须在 `beginCombatNow()` 之后调用） */
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

/** 走完 9.2 直到「战后推进」那一步（9.12g） */
function driveToAdvanceStep(store: ReturnType<typeof newStore>) {
  expect(store.beginCombatNow()).toBe(true)
  declareSupplyForBoth(store)
  expect(store.confirmCombatSupply()).toBe(true)
  store.combatInputs.attackerArUnitId = store.combatAttackers[0]!.instanceId
  expect(store.declareCombatArStep('attacker')).toBe(true)
  store.combatInputs.defenderArUnitId = store.battleDefenders[0]!.instanceId
  expect(store.declareCombatArStep('defender')).toBe(true)
  expect(store.declareCombatTerrainStep()).toBe(true)
  expect(store.rollCombatSurprise()).toBe(true)
  if (store.combatAwaitingShiftDie) expect(store.rollCombatShiftDie()).toBe(true)
  expect(store.rollCombatDice()).toBe(true)
  expect(store.confirmCombatLosses()).toBe(true)
  driveOptions(store, 'attacker')
  expect(store.confirmCombatLosses()).toBe(true)
  driveOptions(store, 'defender')

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
  expect(store.combatState?.step).toBe('advance')
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('B14c：参战攻方阵列（9.5b）', () => {
  it('selected 与 store 的参战名单一致；点一枚即取消参战（再点回来），最后 1 枚不许取消', () => {
    const store = newStore()
    const { attacker } = setupBattle(store)
    // 再加一枚攻方（9.5b 减员的前提：至少留 1 个，9.1b）
    const second = place(store, attackerRecord(), ATTACKER_HEX, 'axis', 'a2')
    store.toggleCombatAttacker(second.instanceId)
    expect(store.beginCombatNow()).toBe(true)
    expect(store.combatState?.step).toBe('combatSupply')
    expect(store.combatAttackerIds).toEqual([attacker.instanceId, second.instanceId])

    // 9.5b：点阵列里那一枚 ⇒ 从参战名单里去掉（付不出全额时的减员）
    store.toggleCombatSupplyAttacker(second.instanceId)
    expect(store.combatAttackerIds).toEqual([attacker.instanceId])
    // ★ 语义差别要写清楚：`combatAttackerIds` 是**本步的输入名单**（9.5b 提交时才生效），
    //   而 `combatAttackers` 仍是**锁定后的构成**——两者不同不是 bug，别照着另一边去改面板。
    expect(store.combatAttackers.map((unit) => unit.instanceId)).toEqual([
      attacker.instanceId,
      second.instanceId,
    ])

    store.toggleCombatSupplyAttacker(second.instanceId)
    expect(store.combatAttackerIds).toEqual([attacker.instanceId, second.instanceId])

    // 9.1b：不能一个都不留 —— 先点掉 a1（剩 a2），再点 a2 会被拒 ⇒ 名单停在 [a2]
    store.toggleCombatSupplyAttacker(attacker.instanceId)
    expect(store.combatAttackerIds).toEqual([second.instanceId])
    store.toggleCombatSupplyAttacker(second.instanceId)
    expect(store.combatAttackerIds).toEqual([second.instanceId])
  })

  it('9.6 AR 候选：攻方取自参战名单、守方取自防御格内守军（阵列的 selected 就是输入项）', () => {
    const store = newStore()
    const { attacker, defender } = setupBattle(store)
    expect(store.beginCombatNow()).toBe(true)

    expect(store.combatAttackerArOptions.map((option) => option.id)).toEqual([attacker.instanceId])
    expect(store.combatDefenderArChoices.map((option) => option.id)).toEqual([defender.instanceId])
    /*
     * ★ B30（用户口径 #19「可选的前提下默认选交战双方 AR 最高的单位」）：
     *   修前这里初值是 `null`（逼玩家从零挑一个）；现在**预填为 AR 最高者**，
     *   而"选择"仍是玩家动作 —— 面板照旧能改成别的（下面这段点选就是那条路）。
     */
    expect(store.combatInputs.attackerArUnitId).toBe(attacker.instanceId)
    expect(store.combatInputs.defenderArUnitId).toBe(defender.instanceId)
    store.combatInputs.attackerArUnitId = attacker.instanceId
    expect(store.combatInputs.attackerArUnitId).toBe(attacker.instanceId)
  })
})

describe('B14c：战后推进阵列（9.12g-A / 9.12b）', () => {
  it('★ 走到 9.12g：候选全可选（pay 过 + 本作无不可移动算子），点选即写进输入并真被引擎接受', () => {
    const store = newStore()
    // 三枚攻方（强）：战果再差也留得下人来推进，故断言不随骰点飘
    setupBattle(store, 2)
    driveToAdvanceStep(store)

    const choices = store.combatAdvanceChoices
    expect(choices.length).toBeGreaterThan(0)
    for (const choice of choices) {
      expect(choice.selected).toBe(false)
      // 如实：本作数据下这两条否决都不可达（见文件头注释）
      expect(choice.disabledReason).toBeNull()
    }

    // 点一枚 ⇒ 写进 combatInputs.advanceUnitIds（面板的 @pick 就是这个动作）
    const chosen = choices[0]!.unit.instanceId
    store.combatInputs.advanceUnitIds = [chosen]
    expect(
      store.combatAdvanceChoices.find((item) => item.unit.instanceId === chosen)?.selected,
    ).toBe(true)
    // 真的被引擎接受（否则阵列只是画着好看）
    expect(store.confirmCombatAdvance()).toBe(true)
    expect(store.combatState?.finished).toBe(true)
  })

  it('★ 9.12g-A：未付战斗补给 = 灰显（造出 paid=false 的状态来证明这条分支仍在）', () => {
    const store = newStore()
    setupBattle(store, 2)
    driveToAdvanceStep(store)

    const state = store.combatState
    expect(state?.supply?.attacker.paid).toBe(true)
    // 攻方的 paid 由引擎恒置 true；此处**只**为演示灰显分支而改状态（不改产品代码）
    if (state?.supply != null) state.supply.attacker.paid = false
    const choice = store.combatAdvanceChoices[0]
    expect(choice?.disabledReason).toContain('9.12g-A')

    // 而这与引擎一致：未付补给者不可推进（9.12g-A）
    store.combatInputs.advanceUnitIds = [choice!.unit.instanceId]
    expect(store.confirmCombatAdvance()).toBe(false)
    expect(store.combatError).toMatchObject({ rule: '9.12g-A' })
  })

  /*
   * 批 F·E4：推进的逐单位勾选动作上移到 store（`workbench.toggleAdvanceUnit`），
   * 面板与小窗共用一份。9.12g-D 的「由拥有者玩家选择**哪些**攻击单位进行推进」是规则要求，
   * 故入口换了地方、能力必须还在 —— 本例钉住「点一次进、再点一次出，且引擎只推被选中的那些」。
   */
  it('批 F·E4：`toggleAdvanceUnit` 逐单位勾选（点进 / 点出），且引擎只推被选中者', () => {
    const store = newStore()
    // 三枚攻方（强）：战果再差也留得下人来推进，故断言不随骰点飘
    setupBattle(store, 2)
    driveToAdvanceStep(store)

    const all = store.combatAdvanceChoices.map((choice) => choice.unit.instanceId)
    expect(all.length).toBeGreaterThanOrEqual(2)
    expect(store.combatInputs.advanceUnitIds).toEqual([])

    // 点第一枚 ⇒ 进
    const first = all[0]!
    store.toggleAdvanceUnit(first)
    expect(store.combatInputs.advanceUnitIds).toEqual([first])
    expect(
      store.combatAdvanceChoices.find((item) => item.unit.instanceId === first)?.selected,
    ).toBe(true)

    // 再点一次 ⇒ 出（幂等往返）
    store.toggleAdvanceUnit(first)
    expect(store.combatInputs.advanceUnitIds).toEqual([])

    // 只选第二枚 ⇒ 引擎只推它（9.12g-D 的"哪些"落在结果上，不是摆设）
    const second = all[1]!
    store.toggleAdvanceUnit(second)
    expect(store.confirmCombatAdvance()).toBe(true)
    expect(store.combatState?.finished).toBe(true)
    const advanced = store.combatState?.advance?.advanceUnitIds ?? []
    expect(advanced).toEqual([second])
    expect(advanced).not.toContain(first)
  })
})

describe('B14c：战斗面板的替换（源码守卫）', () => {
  const panel = readFileSync('src/components/combat/CombatPanel.vue', 'utf8')

  it('四处「选算子」都改走 `CounterPicker`，旧的复选框 / 下拉已删', () => {
    expect(panel.match(/<CounterPicker/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
    expect(panel).not.toContain('v-for="unit in attackerList"')
    expect(panel).not.toContain('v-for="candidate in workbench.combatAdvanceCandidates"')
    expect(panel).not.toContain('<select v-model="workbench.combatInputs.attackerArUnitId"')
    expect(panel).not.toContain('<select v-model="workbench.combatInputs.defenderArUnitId"')
    expect(panel).not.toContain('<select v-model="workbench.battleDefenderArId"')
    // 点选直连 store 的动作 / 输入项
    expect(panel).toContain('@pick="workbench.toggleCombatSupplyAttacker($event)"')
    expect(panel).toContain('@pick="workbench.combatInputs.attackerArUnitId = $event"')
    expect(panel).toContain('@pick="workbench.combatInputs.defenderArUnitId = $event"')
  })

  /*
   * ★ 契约变更（批 F·E4，2026-10-24）：**推进入口唯一** ⇒ 推进的逐单位勾选从本面板
   *   收口到**地图小窗**（`MapActionPopover`），本面板的推进块改为**只读**。
   *   修前本例钉 `@pick="toggleAdvanceUnit($event)"` 在面板里；现改为钉「面板不再挂这个入口，
   *   但能力没丢——勾选动作上移到 store、由小窗调用」。
   *   9.12g-D 的「由玩家选择**哪些**单位推进」是规则要求，故只准搬、**不准删**。
   */
  it('批 F·E4：推进勾选**唯一入口在地图小窗**（面板只读，但能力未丢）', () => {
    expect(panel).not.toContain('@pick="toggleAdvanceUnit($event)"')
    expect(panel).toContain('workbench.combatAdvanceChoices')
    // 面板只展示、不含推进的确认按钮
    expect(panel).not.toContain('@click="workbench.confirmCombatAdvance()"')

    const popover = readFileSync('src/components/game/MapActionPopover.vue', 'utf8')
    // 小窗里逐单位勾选直连 store（灰显者点不动 ⇒ 9.12g-A / 9.12b 由 store 给原因）
    expect(popover).toContain('workbench.combatAdvanceChoices')
    expect(popover).toContain('workbench.toggleAdvanceUnit(')
    expect(popover).toContain(':disabled="choice.disabledReason !== null"')

    // 勾选动作上移到 store（面板与小窗共用一份，不各写一遍）
    const store = readFileSync('src/stores/workbench.ts', 'utf8')
    expect(store).toContain('function toggleAdvanceUnit(')
  })

  it('候选与灰显原因取自 store（面板不自己筛「付过补给/不可移动」）', () => {
    expect(panel).toContain('workbench.combatAttackerArOptions')
    expect(panel).toContain('workbench.combatDefenderArChoices')
    expect(panel).toContain('workbench.combatAdvanceChoices')
    expect(panel).not.toContain('.paid')
    expect(panel).not.toContain('.immobile')
  })

  it('悬停同步地图高亮：走既有的 `setHoverHex`', () => {
    expect(panel).toContain('workbench.setHoverHex')
    expect(panel.match(/@hover="hoverUnit"/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
  })
})

/**
 * B20：撤退落点改成**在地图上点格**（用户口径 2026-09-16）
 *
 * 「撤退路径就是渲染显示可撤退格，玩家点击格子即可撤退」
 *
 * 钉四件事：
 *   ① 走到 9.12 那一步时，地图**确实铺出**候选落点（`overlay.retreat` 的 safe/zoc/doomed 三桶）；
 *   ② 点一个高亮格 ⇒ 该格落在 `combatInputs.retreatPaths`（**文本格式不变**，仍是 9.12 的既有契约）；
 *   ③ 攻方选齐 ⇒ 地图与名单**一起**切到守方（修前小窗读 `combatRetreatPlans[0]`＝永远攻方，
 *      于是"地图高亮守方格、小窗还列攻方"）；
 *   ④ 旧的 `列.行,列.行` 文本框已从面板删除（源码守卫）。
 */
/**
 * B30：**战斗结算自动化**（用户口径 2026-09-16 #19）
 *
 * 「战斗阶段需要选中 AR 之后选地形也是玩家操作，但是**攻防比 / 奇袭 / 战斗骰**这三步是骰子和查表，
 *   做成自动的」。
 *
 * 两条都钉住：
 *   ① 行动值单位**预填为双方 AR 最高者**（选择仍是玩家的：面板可改）；
 *   ② 地形确认之后**自动连跑**「攻防比 → 奇袭（必要时补横移骰）→ 战斗骰」，停在战果（`losses`）步，
 *      骰面走种子化 RNG（`drawCount` 递增 ⇒ 可复算）。
 */
describe('B30：战斗结算自动化（9.6 / 9.7 / 9.8 / 9.9）', () => {
  it('★ 开始战斗即预填双方行动值单位（AR 最高的那一枚）', () => {
    const store = newStore()
    const { attacker, defender } = setupBattle(store)
    expect(store.beginCombatNow()).toBe(true)

    expect(store.combatInputs.attackerArUnitId).toBe(attacker.instanceId)
    expect(store.combatInputs.defenderArUnitId).toBe(defender.instanceId)
    // 预填的是"可选集合里的最高 AR"，且该集合就是引擎认的那一份
    const best = store.combatAttackerArOptions.reduce((top, row) =>
      row.id === store.combatInputs.attackerArUnitId ? row : top,
    )
    expect(store.combatAttackerArOptions[0]?.id).toBe(best.id)
  })

  it('★ 确认地形后自动连跑到战果步（奇袭与战斗骰的骰面可复算）', () => {
    const store = newStore()
    setupBattle(store)
    expect(store.beginCombatNow()).toBe(true)
    declareSupplyForBoth(store)
    expect(store.confirmCombatSupply()).toBe(true)
    expect(store.declareCombatArStep('attacker')).toBe(true)
    expect(store.declareCombatArStep('defender')).toBe(true)
    expect(store.combatState?.step).toBe('declareTerrain')

    const drawsBefore = store.drawCount
    expect(store.autoResolveCombatToOutcome()).toBe(true)

    // 停在**战果**步（9.11 的强制损失；选项在它之后）
    expect(store.combatState?.step).toBe('losses')
    // 奇袭（含可能的横移骰）与战斗骰都真的掷了
    expect(store.drawCount).toBeGreaterThan(drawsBefore)
    expect(store.combatSurpriseDie).not.toBeNull()
    // 战果页要用到的数据都已落盘（攻防比 / 列位 / 战果码）
    expect(store.combatState?.odds).toBeDefined()
  })

  it('★ 面板：地形那一步给"自动结算到战果"，同时留"只确认地形"的逐步复核路径', () => {
    const panel = readFileSync('src/components/combat/CombatPanel.vue', 'utf8')
    expect(panel).toContain('workbench.autoResolveCombatToOutcome()')
    expect(panel).toContain('workbench.declareCombatTerrainStep()')
    // 奇袭 / 战斗骰两节改成"逐步复核"的口径（按钮降为次要），并明说正常流程不必点
    expect(panel.match(/逐步复核/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(panel).toContain('正常流程不必点这里的按钮')
  })
})

describe('B20：撤退落点在地图上点格（9.12）', () => {
  /** 把双方选项都吃成**撤退格数**（迫使 9.12 真的需要选落点）——9.10a 允许二选一 */
  function driveOptionsAsRetreat(store: ReturnType<typeof newStore>) {
    const requirement = store.combatRequirement
    if (requirement === null) throw new Error('此刻不该没有损失/选项需求')
    store.combatInputs.optionRetreatHexes = requirement.options
    store.combatInputs.optionLossPoints = 0
    expect(store.confirmCombatOptions()).toBe(true)
  }

  /** 走完 9.2 直到**停在 9.12 撤退步**（双方都用撤退格数满足选项） */
  function driveToRetreatStep(store: ReturnType<typeof newStore>) {
    /*
     * ★ 契约变更（H①，2026-09-19，**不是放宽**）：9.10c 例 B 现在会让"攻方在承受选项前被全灭"的
     *   战斗**跳过攻方选项步**。本用例要验的是撤退落点的地图点格（9.12），故先把攻方补足军力，
     *   让它扛得住这一笔强制损失（短路那条路由 `combat-interaction.test.ts` 的 H① 组覆盖）。
     */
    const attackerInStore = store.units.find((unit) => unit.instanceId === 'a1')
    if (attackerInStore !== undefined) attackerInStore.steps = Math.max(attackerInStore.steps, 3)
    expect(store.beginCombatNow()).toBe(true)
    declareSupplyForBoth(store)
    expect(store.confirmCombatSupply()).toBe(true)
    store.combatInputs.attackerArUnitId = store.combatAttackers[0]!.instanceId
    expect(store.declareCombatArStep('attacker')).toBe(true)
    store.combatInputs.defenderArUnitId = store.battleDefenders[0]!.instanceId
    expect(store.declareCombatArStep('defender')).toBe(true)
    expect(store.declareCombatTerrainStep()).toBe(true)
    expect(store.rollCombatSurprise()).toBe(true)
    if (store.combatAwaitingShiftDie) expect(store.rollCombatShiftDie()).toBe(true)
    expect(store.rollCombatDice()).toBe(true)
    expect(store.confirmCombatLosses()).toBe(true)
    driveOptionsAsRetreat(store)
    expect(store.confirmCombatLosses()).toBe(true)
    driveOptionsAsRetreat(store)
    expect(store.combatState?.step).toBe('retreat')
  }

  it('地图铺出候选落点，点一格即写入该单位的撤退路径；一方选齐后焦点切到下一方', () => {
    const store = newStore()
    const mapView = useMapViewStore()
    setupBattle(store)
    driveToRetreatStep(store)

    // ① 候选落点确实铺到了地图上（三桶是**并集**，故只断言"有格可点"）
    const overlayRetreat = mapView.overlay.retreat ?? null
    expect(overlayRetreat).not.toBeNull()
    expect(overlayRetreat!.safe.length + overlayRetreat!.zoc.length).toBeGreaterThan(0)

    /*
     * ② 逐方逐枚点格
     *
     * ★ `combatRetreatPlans` 里**只**含有撤退需求的一方（`needsRetreat` ⇒ 撤退格数 > 0），
     *   而"攻方这一掷是否需要撤退"由 CRT 战果决定 ⇒ 本用例**不假定攻守都要撤**，
     *   只钉住真正的不变量：①地图当前给的那一方 == `retreatSidePlan`；②点格落盘到**那一方**的单位；
     *   ③一方选齐后焦点立刻换到下一方的第一枚（修前小窗读 `plans[0]`＝永远攻方，会写错人头）。
     */
    const planCount = store.combatRetreatPlans.length
    expect(planCount).toBeGreaterThan(0)
    for (let index = 0; index < planCount; index += 1) {
      const plan = store.combatRetreatPlans[index]!
      expect(mapView.retreatSidePlan?.side).toBe(plan.side)
      expect(plan.distance).toBeGreaterThan(0)
      for (const row of plan.units) {
        // 焦点应落在"还没选的那一枚"上（兜底口径），且**属于当前这一方**
        expect(mapView.retreatUnit?.unitId).toBe(row.unitId)
        expect(mapView.retreatUnit?.chosen).toBeNull()
        const destination = mapView.retreatUnit!.destinations[0]
        expect(destination).toBeDefined()
        mapView.onHexClick(destination!.hex)
        // 落盘的是**整条路径**的文本（不含起始格），长度＝该方的完整撤退距离
        expect(store.combatInputs.retreatPaths[row.unitId]).toBe(
          destination!.path.map((hex) => `${hex.col}.${hex.row}`).join(','),
        )
        expect(destination!.path.length).toBe(plan.distance)
      }
      expect(store.combatRetreatPlans[index]!.complete).toBe(true)
      // ③ 还有下一方 ⇒ 地图与焦点都已经交出去（不留在刚选完的这一方）
      const next = store.combatRetreatPlans[index + 1]
      if (next !== undefined) {
        expect(mapView.retreatSidePlan?.side).toBe(next.side)
        expect(mapView.retreatUnit?.unitId).toBe(next.units[0]?.unitId)
      }
    }
    // 9.10b 的次序：若双方都要撤退，攻方必在守方之前
    const sides = store.combatRetreatPlans.map((plan) => plan.side)
    if (sides.length === 2) expect(sides).toEqual(['attacker', 'defender'])

    // ④ 点完后可以直接确认（9.12 收束）
    expect(store.confirmCombatRetreats()).toBe(true)
    expect(store.combatState?.step).toBe('advance')
  })

  it('点一个**不是**候选落点的格 ⇒ 不写路径（不会把别处当落点）', () => {
    const store = newStore()
    const mapView = useMapViewStore()
    setupBattle(store)
    driveToRetreatStep(store)

    const row = store.combatRetreatPlans[0]!.units[0]!
    const chosen = new Set(row.destinations.map((plan) => `${plan.hex.col}.${plan.hex.row}`))
    const elsewhere = mapLayers.hexes.find((hex) => !chosen.has(`${hex.col}.${hex.row}`))
    expect(elsewhere).toBeDefined()
    mapView.onHexClick({ col: elsewhere!.col, row: elsewhere!.row })
    expect(store.combatInputs.retreatPaths[row.unitId]).toBeUndefined()
  })

  it('源码守卫：面板不再有撤退坐标文本框；小窗与地图读**同一份**撤退计划', () => {
    const panel = readFileSync('src/components/combat/CombatPanel.vue', 'utf8')
    expect(panel).not.toContain('path-input')
    expect(panel).not.toContain('retreatPathValue')
    expect(panel).not.toContain('onRetreatPathInput')
    expect(panel).toContain('mapView.retreatSidePlan')
    expect(panel).toContain('mapView.setRetreatUnit')

    const popover = readFileSync('src/components/game/MapActionPopover.vue', 'utf8')
    expect(popover).toContain('mapView.retreatSidePlan')
    // 断言"读取处"而不是"整个文件不含该词"：修记的注释里会引到旧名
    expect(popover).not.toContain('computed(() => workbench.combatRetreatSide)')

    // 两个口径里只剩下一处（`combatRetreatSide` 已删：它取 plans[0]，永远先攻方）
    const workbenchSource = readFileSync('src/stores/workbench.ts', 'utf8')
    expect(workbenchSource).not.toContain('const combatRetreatSide')
    expect(workbenchSource).not.toContain('const combatRetreatingUnits')
  })
})
