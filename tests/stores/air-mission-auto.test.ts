import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef, Side } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  aircraftChoices,
  toConsoleAirUnit,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
} from '@/stores'

/**
 * B29a：**空军任务正规化（第一批）**——用户口径 2026-09-16 #3
 *
 * 「空军任务应该点击机场选中飞机或者多选编队后点击目标格再选择可执行任务，
 *   然后**自动结算至各种单位战果结算**，出现空战或者地面单位受损时会有**可能出现的玩家自选**」。
 *
 * 本批三件事：
 *   ① 任务格改成**点地图选**（第 12 处待点格）；
 *   ② **14.3e-B 的迎战机**不再写死"名单第一架"——任务方点名的那一架才算数（缺省才回落）；
 *   ③ 新增 `autoResolveAirMissionNow()`：空战 → 拦截 → 防空 → 任务结算自动连跑，**停在返航**。
 */

const label = (hex: HexRef): string => `${hex.col}.${hex.row}`

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 六邻皆图内的格（基地与飞机都摆这里，避免航程/邻格断言受地图形状影响） */
const CORE_HEX: HexRef = (() => {
  const found = mapLayers.hexes.find((hex) => {
    const ref = { col: hex.col, row: hex.row }
    return HEX_DIRECTIONS.every((direction) => {
      const candidate = neighbor(ref, direction)
      return (
        isOnMap(candidate) &&
        mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
      )
    })
  })
  if (found === undefined) throw new Error('地图上找不到六邻皆图内的格')
  return { col: found.col, row: found.row }
})()

/** 任务格：与 CORE_HEX 相邻（航程内），且**无人**（空战/防空都不发生） */
const TARGET_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(CORE_HEX, direction)
    if (
      isOnMap(candidate) &&
      mapLayers.hexes.some((h) => h.col === candidate.col && h.row === candidate.row)
    ) {
      return candidate
    }
  }
  throw new Error('CORE_HEX 没有图内邻格')
})()

const airBaseRecord = () =>
  unitChoices('axis').find((record) => record.noncombatKind === 'air_base')!
const fighterRecord = (side: Side) =>
  aircraftChoices(side).find((record) => record.aircraftType === 'F')!

describe('B29a：任务格与迎战机（玩家自选）', () => {
  it('★ 任务格：待点格声明正确，点地图即写回（14.2f-B）', () => {
    const store = newStore()
    expect(store.hexPickView).toBeNull()
    store.beginAirTargetHexPickNow()
    expect(store.hexPickView).toMatchObject({ rule: '14.2f-B', candidates: 'any' })

    expect(store.pickHexFor({ col: 36, row: 13 })).toBe(true)
    expect(store.airInputs.targetHexText).toBe('36.13')
    expect(store.hexPickView).toBeNull()
  })

  it('★ 14.3e-B 的迎战机是**玩家输入**（缺省 null ＝ 交引擎按 ACV 最高）', () => {
    const store = newStore()
    expect(store.airInputs.namedDefenderId).toBeNull()
    store.airInputs.namedDefenderId = 'some-aircraft'
    expect(store.airInputs.namedDefenderId).toBe('some-aircraft')
  })

  it('★ 源码守卫：store 不再写死"名单第一架"当迎战机；面板给出点名阵列与自动结算按钮', () => {
    const store = readFileSync('src/stores/workbench.ts', 'utf8')
    /*
     * B29a 修的是"未点名就回落名单第一架"；B29b-2 把回落口径也换成**ACV 最高**
     * （与引擎 `pickHighestAcv` 的缺省一致）⇒ 现在 store 里**不再有**任何 `.value[0]` 式回落。
     * ★ 契约随动（第五批批 C 切片 1，**不是放宽**）：ACV 改取**当前面**（`airCombatRatingOf`，
     *   14.1b 减损机用减损面值）⇒ 判据文本随之更新，语义仍是"按 ACV 最高、不写死第一架"。
     */
    expect(store).not.toContain('airMissionAirUnits.value[0]')
    expect(store).toContain('namedDefenderId: null')
    expect(store).toContain('const airInterceptionDefender = computed')
    expect(store).toContain('airCombatRatingOf(plane) > airCombatRatingOf(best) ? plane : best')
    // 空战逐轮真的把点名传下去了（B29b-2 起是逐轮 picks 的载荷）
    expect(store).toContain('function airCombatPicksPayload()')
    expect(store).toContain('{ picks: [{ defenderAircraftId: named }] }')

    const panel = readFileSync('src/components/air/AirPanel.vue', 'utf8')
    expect(panel).toContain('beginAirTargetHexPickNow()')
    /*
     * ★ 契约变更（批 C 切片 1，**不是放宽**）：面板**不再**直接挂 `autoResolveAirMissionNow()`
     *   —— 宣布与自动结算已合成一次动作 `runAirMissionNow()`（选任务类型即触发）。
     *   旧断言"面板有自动结算按钮"随之改写为"面板走合并入口"；断言强度不变。
     */
    expect(panel).toContain('workbench.runAirMissionNow()')
    expect(panel).toContain('workbench.runAirMissionWithKind(')
    expect(panel).not.toContain('workbench.autoResolveAirMissionNow()')
    expect(panel).toContain('namedDefenderItems')
    expect(panel).toContain('workbench.airInputs.namedDefenderId = $event')
  })
})

describe('B29a：自动连跑到返航（不替玩家做选择）', () => {
  let store: ReturnType<typeof newStore>

  beforeEach(() => {
    store = newStore()
  })

  it('★ 未宣布任务时调用 ⇒ 不假装成功（状态机自己拦）', () => {
    expect(store.airState).toBeNull()
    expect(store.autoResolveAirMissionNow()).toBe(false)
  })

  it('★ 宣布之后（任务格无敌情）⇒ 一次点完即到**返航**（14.3/14.5/14.4/任务结算 连跑）', () => {
    /*
     * 夹具：本方基地 + 一架激活战机；任务格选**无人格** ⇒ 空战不发生、无人拦截、防空无目标，
     * 于是"自动连跑"要依次穿过四个环节直达返航 —— 这正是用户要的"点完自动结算到战果"。
     */
    const base = toConsoleUnit({
      record: airBaseRecord(),
      instanceId: 'base-1',
      hex: CORE_HEX,
      side: 'axis',
    })
    store.units.push(base)
    store.airUnits.push(
      toConsoleAirUnit({
        aircraft: fighterRecord('axis'),
        instanceId: 'air-1',
        hex: CORE_HEX,
        side: 'axis',
        airStatus: 'active',
      }),
    )
    store.setAirActive(true)
    store.airInputs.flyingAllowed = true
    store.airInputs.weatherNormal = true
    store.toggleAirMissionUnit('air-1')
    expect(store.setAirTargetFromText(label(TARGET_HEX))).toBe(true)

    expect(store.beginAirMissionNow()).toBe(true)
    const drawsBefore = store.drawCount
    expect(store.autoResolveAirMissionNow()).toBe(true)

    // 停在返航（要逐机定目的地 / 改状态，值得看一眼）
    expect(store.airState?.step).toBe('returnToBase')
    // 防空那一步真的掷了骰（14.4：2 骰 + 损失骰）
    expect(store.drawCount).toBeGreaterThan(drawsBefore)
  })
})

/**
 * 批 C 切片 1（用户口径 9.16 #3 / #11）：**选任务类型即"宣布 + 自动结算到停返航"**
 *
 * 原文流程（14.2f）：A/B 任务分配 → C 空战 → D 拦截 → E 防空 → F 结算 → G 返航。
 * 用户的玩法：「点机场选机 → **点目标格** → **选任务类型** → **自动结算**」⇒ 选类型就是最后一步输入，
 * 之后**不该再要点两次"宣布/自动结算"**。玩家步骤仍不合并（这里是空军侧；9.2 的 AR→地形那两步照旧）。
 */
describe('批 C 切片 1：选任务类型即跑到停返航（一次动作）', () => {
  let store: ReturnType<typeof newStore>

  beforeEach(() => {
    store = newStore()
  })

  /** 基地 + 一架激活战机 + 已点名参战 + 已选任务格（任务格无人 ⇒ 一路无表态需求） */
  const armMission = (): void => {
    const base = toConsoleUnit({
      record: airBaseRecord(),
      instanceId: 'base-1',
      hex: CORE_HEX,
      side: 'axis',
    })
    store.units.push(base)
    store.airUnits.push(
      toConsoleAirUnit({
        aircraft: fighterRecord('axis'),
        instanceId: 'air-1',
        hex: CORE_HEX,
        side: 'axis',
        airStatus: 'active',
      }),
    )
    store.setAirActive(true)
    store.airInputs.flyingAllowed = true
    store.airInputs.weatherNormal = true
    store.toggleAirMissionUnit('air-1')
    expect(store.setAirTargetFromText(label(TARGET_HEX))).toBe(true)
  }

  it('★ 一次性：`runAirMissionWithKind` ⇒ 宣布与结算连跑，停在**返航**（不必再点两次确认）', () => {
    armMission()
    const drawsBefore = store.drawCount
    expect(store.airState).toBeNull()

    expect(store.runAirMissionWithKind('barrage')).toBe(true)
    expect(store.airState?.step).toBe('returnToBase')
    expect(store.airState?.kind).toBe('barrage')
    // 14.4 防空那一步真的掷了骰（走种子化 RNG 并留痕）
    expect(store.drawCount).toBeGreaterThan(drawsBefore)
    // 留痕：宣布与任务结算各有一条日志（复核用）
    expect(store.log.some((entry) => entry.text.includes('宣布任务'))).toBe(true)
  })

  it('★ 条件不足时**如实说缺什么**（不静默、不半途进入状态机）', () => {
    // ① 什么都没选
    expect(store.runAirMissionNow()).toBe(false)
    expect(store.airState).toBeNull()
    expect(store.log.some((entry) => entry.text.includes('先点名参战飞机'))).toBe(true)

    // ② 点了参战机但还没选任务格
    const base = toConsoleUnit({
      record: airBaseRecord(),
      instanceId: 'base-1',
      hex: CORE_HEX,
      side: 'axis',
    })
    store.units.push(base)
    store.airUnits.push(
      toConsoleAirUnit({
        aircraft: fighterRecord('axis'),
        instanceId: 'air-1',
        hex: CORE_HEX,
        side: 'axis',
        airStatus: 'active',
      }),
    )
    store.setAirActive(true)
    store.airInputs.flyingAllowed = true
    store.airInputs.weatherNormal = true
    store.toggleAirMissionUnit('air-1')
    expect(store.runAirMissionNow()).toBe(false)
    expect(store.airState).toBeNull()
    expect(store.log.some((entry) => entry.text.includes('先选任务格'))).toBe(true)
  })

  it('源码守卫：正式界面没有"自由掷骰"与重复的逐步复核入口（验证页才有）', () => {
    const gameTable = readFileSync('src/views/GameTableView.vue', 'utf8')
    // ④ 顶栏「自由掷骰」已从对局台移走（验证页 `WorkbenchView` 仍有）
    expect(gameTable).not.toContain('workbench.rollDice()')
    expect(readFileSync('src/views/WorkbenchView.vue', 'utf8')).toContain('workbench.rollDice()')

    // ② 逐步复核的手动按钮只在验证页渲染（`stepwise`）
    const combat = readFileSync('src/components/combat/CombatPanel.vue', 'utf8')
    expect(combat).toContain('const props = withDefaults(defineProps<{ stepwise?: boolean }>()')
    // 三处手动入口：只确认地形 / 掷奇袭骰 / 掷战斗骰（数量级守卫：少一处即红）
    expect((combat.match(/v-if="props\.stepwise"/g) ?? []).length).toBe(3)
    // 玩家步骤（AR → 地形）**一个都不合并**：宣告按钮仍在（不受 stepwise 影响）
    expect(combat).toContain('workbench.declareCombatArStep(')
    const air = readFileSync('src/components/air/AirPanel.vue', 'utf8')
    expect(air).toContain('stepwise: false')
    // 空军侧的手动入口只有"结算空战环节"一处
    expect((air.match(/v-if="props\.stepwise"/g) ?? []).length).toBe(1)
    const bench = readFileSync('src/views/WorkbenchView.vue', 'utf8')
    expect(bench).toContain('<CombatPanel stepwise />')
    expect(bench).toContain('<AirPanel stepwise />')
  })
})
