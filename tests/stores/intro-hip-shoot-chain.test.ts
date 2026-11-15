import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers, scenarios } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, hexDistance, neighbor } from '@/engine/hex-geometry'
import {
  actionGateOf,
  aircraftChoices,
  toConsoleAirUnit,
  toConsoleUnit,
  unitChoices,
  useGameSessionStore,
  useHotseatStore,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
} from '@/stores'

/*
 * Vitebsk（Intro）低空扫射全链实点（14.2f A→G / 14.7d / 14.4）
 *
 * 剧本页写的是「Weather: Limited Flight on 8 July」，专规 1.5 明确该天气**禁低空扫射**。
 * 用户 2026-11-15 放行：只在**本验证局面**里把记录轨天气临时改成正常，不改
 * `scenarios.json` 的 `firstWeather`、也不写进剧本数据（见本文件 `useNormalWeatherFixture`）。
 */
const PLAY_AREA: ReadonlySet<string> = (() => {
  const intro = scenarios.scenarios.find((item) => item.id === 'Intro')
  return new Set((intro?.playArea?.hexes ?? []).map((key) => key))
})()

const inPlay = (hex: HexRef): boolean => PLAY_AREA.has(`${String(hex.col)}.${String(hex.row)}`)

const DEFENDER_HEX: HexRef = (() => {
  for (const key of PLAY_AREA) {
    const [col, row] = key.split('.').map(Number)
    const ref = { col: col!, row: row! }
    if (!mapLayers.hexes.some((hex) => hex.col === ref.col && hex.row === ref.row)) continue
    if (HEX_DIRECTIONS.every((direction) => inPlay(neighbor(ref, direction)))) return ref
  }
  throw new Error('活动区内找不到六邻皆在活动区的格')
})()

const BASE_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(DEFENDER_HEX, direction)
    if (!inPlay(candidate)) continue
    if (!mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row))
      continue
    return candidate
  }
  throw new Error('防御格没有活动区内的邻格')
})()

const SOVIET_BASE_HEX: HexRef = (() => {
  for (const key of PLAY_AREA) {
    const [col, row] = key.split('.').map(Number)
    const ref = { col: col!, row: row! }
    if (!mapLayers.hexes.some((hex) => hex.col === ref.col && hex.row === ref.row)) continue
    if (hexDistance(ref, DEFENDER_HEX) === 2) return ref
  }
  throw new Error('活动区内找不到距目标格 2 格的格')
})()

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

describe('Vitebsk 低空扫射全链实点（14.2f A→G）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  /** 开 Intro 局面；记录轨天气临时改正常（仅夹具，不动剧本数据） */
  async function openIntroNormalWeather() {
    const session = useGameSessionStore()
    expect(session.setScenarioId('Intro')).toBe(true)
    expect(session.startGame()).toBe(true)
    const workbench = useWorkbenchStore()
    const mapView = useMapViewStore()
    useHotseatStore()
    workbench.resetAll(11)
    useSetupStore().finished = true

    const current = session.session!
    expect(current.state.records.weather.air).toBe('limited')
    session.session = {
      ...current,
      state: {
        ...current.state,
        records: {
          ...current.state.records,
          // 夹具：只改这一局的天气事实，不改 `firstWeather`
          weather: { ...current.state.records.weather, air: 'normal' },
        },
      },
    }
    await nextTick()
    expect(workbench.airInputs.weatherNormal).toBe(true)

    workbench.setPhase('movement')
    goToActionStep(workbench, 'air.mission')

    const base = unitChoices('axis').find((record) => record.noncombatKind === 'air_base')!
    workbench.units.push(
      toConsoleUnit({ record: base, instanceId: 'base-1', hex: BASE_HEX, side: 'axis' }),
    )
    // 10.0b：正确观察员＝与目标格相邻的友方战斗单位
    const spotter = unitChoices('axis').find((record) => record.isCombat === true)!
    workbench.units.push(
      toConsoleUnit({ record: spotter, instanceId: 'spot-1', hex: BASE_HEX, side: 'axis' }),
    )
    const defender = unitChoices('soviet').find((record) => record.isCombat === true)!
    workbench.units.push(
      toConsoleUnit({ record: defender, instanceId: 'def-1', hex: DEFENDER_HEX, side: 'soviet' }),
    )
    const plane = aircraftChoices('axis').find(
      (record) => record.airAbilities?.canHipShoot === true && (record.barrageStrength ?? 0) > 0,
    )!
    workbench.airUnits.push(
      toConsoleAirUnit({
        aircraft: plane,
        instanceId: 'hip-1',
        hex: BASE_HEX,
        side: 'axis',
        airStatus: 'active',
      }),
    )
    return { session, workbench, mapView }
  }

  it('★ 右键敌方格出「低空扫射」→ 第 1 步选机 → 第 2 步面板 2（拦截/防空已按 A→E 走完）', async () => {
    const { workbench, mapView } = await openIntroNormalWeather()

    // 入口：右键敌方格
    expect(mapView.openUnitContext(DEFENDER_HEX, 'def-1', { x: 0, y: 0 })).toBe(true)
    const action = mapView.contextOptions
      .find((item) => item.id === 'def-1')!
      .actions.find((item) => item.key === 'ops.hipShoot')!
    expect(action.label).toBe('低空扫射')
    expect(action.rule).toBe('14.7d')

    // 第 1 步：统一三操作流程
    expect(mapView.openContextAction('def-1', 'ops.hipShoot')).toBe(true)
    expect(mapView.opsFlow?.kind).toBe('hipShoot')
    expect(mapView.opsFlow?.step).toBe(1)
    expect(workbench.airMissionKind).toBe('hip_shoot')

    // 防空按 14.4 掷骰：夹具给定 2 骰 12 + 损失骰 1 ⇒ 命中（14.4f 落 1 点军力）
    workbench.airInputs = {
      ...workbench.airInputs,
      printedFlakValue: 3,
      flakDie: 12,
      lossDie: 1,
    }
    workbench.toggleAirMissionUnit('hip-1')
    expect(mapView.advanceOpsFlow()).toBe(true)

    // 面板顺序：宣布（A）⇒ 空战（C）⇒ 拦截（D）⇒ 防空（E）⇒ 停在结算任务（F）
    expect(mapView.opsFlow?.step).toBe(2)
    expect(workbench.airState?.step).toBe('resolveMission')
    expect(workbench.airState?.flak).toMatchObject({
      applies: true,
      hit: true,
      lossAircraftId: 'hip-1',
    })
    expect(workbench.airUnits.find((air) => air.instanceId === 'hip-1')?.steps).toBe(1)
  })

  it('★ 有合格拦截机时停在 D 步（不自动跳过），应答后才进防空与结算', async () => {
    const { session, workbench, mapView } = await openIntroNormalWeather()

    // 苏方空军基地 + 激活战斗机，距目标 2 格 ⇒ 目标在巡逻区内、拦截机在航程内
    const sovietBase = unitChoices('soviet').find((record) => record.noncombatKind === 'air_base')!
    workbench.units.push(
      toConsoleUnit({
        record: sovietBase,
        instanceId: 'sbase-1',
        hex: SOVIET_BASE_HEX,
        side: 'soviet',
      }),
    )
    const fighter = aircraftChoices('soviet').find(
      (record) => record.airAbilities?.canPatrolZone === true,
    )!
    workbench.airUnits.push(
      toConsoleAirUnit({
        aircraft: fighter,
        instanceId: 'sf-1',
        hex: SOVIET_BASE_HEX,
        side: 'soviet',
        airStatus: 'active',
      }),
    )

    expect(mapView.openUnitContext(DEFENDER_HEX, 'def-1', { x: 0, y: 0 })).toBe(true)
    expect(mapView.openContextAction('def-1', 'ops.hipShoot')).toBe(true)
    workbench.toggleAirMissionUnit('hip-1')
    expect(mapView.advanceOpsFlow()).toBe(true)

    // 14.5：该弹就弹——停在拦截步等应答，不替玩家跳过
    expect(workbench.airState?.step).toBe('interception')
    expect(workbench.airInterceptionResponse?.eligible).toBe(true)
    expect(workbench.airInterceptorCandidates.map((air) => air.instanceId)).toContain('sf-1')
    expect(session.log.some((entry) => entry.action === 'airFlak')).toBe(false)

    // 应答「不拦截」⇒ 才进 14.4 防空，再停在 14.2f-F 结算任务
    workbench.airInputs = { ...workbench.airInputs, interceptDeclared: false }
    expect(workbench.declareInterceptionNow()).toBe(true)
    expect(workbench.airState?.step).toBe('flak')
    expect(workbench.autoResolveAirMissionNow()).toBe(true)
    expect(workbench.airState?.step).toBe('resolveMission')
    expect(session.log.some((entry) => entry.action === 'airFlak')).toBe(true)
  })

  it('★ 任务格有敌方激活机+基地时停在 C 步（空战该弹就弹）', async () => {
    const { workbench, mapView } = await openIntroNormalWeather()

    // 14.3：任务格内双方皆有激活飞机、且有敌方基地 ⇒ 空战
    const sovietBase = unitChoices('soviet').find((record) => record.noncombatKind === 'air_base')!
    workbench.units.push(
      toConsoleUnit({
        record: sovietBase,
        instanceId: 'sbase-1',
        hex: DEFENDER_HEX,
        side: 'soviet',
      }),
    )
    const fighter = aircraftChoices('soviet').find(
      (record) => record.airAbilities?.canPatrolZone === true,
    )!
    workbench.airUnits.push(
      toConsoleAirUnit({
        aircraft: fighter,
        instanceId: 'sf-1',
        hex: DEFENDER_HEX,
        side: 'soviet',
        airStatus: 'active',
      }),
    )

    expect(mapView.openUnitContext(DEFENDER_HEX, 'def-1', { x: 0, y: 0 })).toBe(true)
    expect(mapView.openContextAction('def-1', 'ops.hipShoot')).toBe(true)
    workbench.toggleAirMissionUnit('hip-1')
    expect(mapView.advanceOpsFlow()).toBe(true)

    expect(workbench.airState?.step).toBe('airCombat')
    expect(workbench.airState?.combat).toMatchObject({ occurs: true })
  })

  it('★ 10.0b：没有正确观察员时，低空扫射的目标格在入口判据上就不成立', async () => {
    const { workbench } = await openIntroNormalWeather()
    expect(workbench.canAirMissionTarget('hip_shoot', DEFENDER_HEX)).toBe(true)
    const spotter = workbench.units.findIndex((unit) => unit.instanceId === 'spot-1')
    workbench.units.splice(spotter, 1)
    expect(workbench.canAirMissionTarget('hip_shoot', DEFENDER_HEX)).toBe(false)
  })

  it('★ 结算被 10.0b 拒时任务可中止返航，不把状态死在 resolveMission', async () => {
    const { workbench } = await openIntroNormalWeather()
    workbench.setAirMissionKind('hip_shoot')
    expect(
      workbench.setAirTargetFromText(`${String(DEFENDER_HEX.col)}.${String(DEFENDER_HEX.row)}`),
    ).toBe(true)
    workbench.toggleAirMissionUnit('hip-1')
    expect(workbench.beginAirMissionNow()).toBe(true)
    expect(workbench.autoResolveAirMissionNow()).toBe(true)
    expect(workbench.airState?.step).toBe('resolveMission')

    // 走到结算前拿掉观察员：轰炸宣布必被 10.0b 拒（模拟入口判据漏过的情形）
    const spotter = workbench.units.findIndex((unit) => unit.instanceId === 'spot-1')
    workbench.units.splice(spotter, 1)
    expect(workbench.settleAirMissionNow()).toBe(true)
    expect(workbench.airState?.finished).toBe(true)
    expect(workbench.airUnits.find((air) => air.instanceId === 'hip-1')?.airStatus).toBe('inactive')
  })

  it('★ 上一趟的轰炸结算后，下一趟换机宣布：新任务用新机参炸，不拿旧机触发 10.0e-B', async () => {
    const { workbench, mapView } = await openIntroNormalWeather()
    const second = aircraftChoices('axis').find(
      (record) => record.airAbilities?.canHipShoot === true && (record.barrageStrength ?? 0) > 0,
    )!
    workbench.airUnits.push(
      toConsoleAirUnit({
        aircraft: second,
        instanceId: 'hip-2',
        hex: BASE_HEX,
        side: 'axis',
        airStatus: 'active',
      }),
    )

    // 第一趟：hip-1 打 DEFENDER_HEX，结算并自动返航（barrageState 停在 done）
    expect(mapView.openUnitContext(DEFENDER_HEX, 'def-1', { x: 0, y: 0 })).toBe(true)
    expect(mapView.openContextAction('def-1', 'ops.hipShoot')).toBe(true)
    workbench.toggleAirMissionUnit('hip-1')
    expect(mapView.advanceOpsFlow()).toBe(true)
    expect(workbench.settleAirMissionNow()).toBe(true)
    expect(workbench.barrageState?.finished).toBe(true)

    // 第二趟：换 hip-2 打同一格（14.7d-A：低空扫射不占每格一次）
    // 与界面同路：右键开新任务时先 `clearAir()`（opsFlow 的空军分支）
    workbench.clearAir()
    workbench.setAirMissionKind('hip_shoot')
    expect(
      workbench.setAirTargetFromText(`${String(DEFENDER_HEX.col)}.${String(DEFENDER_HEX.row)}`),
    ).toBe(true)
    workbench.toggleAirMissionUnit('hip-2')
    expect(workbench.beginAirMissionNow(), JSON.stringify(workbench.airError)).toBe(true)
    expect(workbench.autoResolveAirMissionNow()).toBe(true)
    expect(workbench.airState?.step).toBe('resolveMission')

    expect(workbench.settleAirMissionNow()).toBe(true)
    expect(workbench.barrageState?.units.map((unit) => unit.unitId)).toEqual(['hip-2'])
  })

  it('★ 结算任务（F）真的落账：轰炸结论 + 14.4 防空损失 + 14.7d-A 格账本不记 → 自动返航（G）', async () => {
    const { session, workbench, mapView } = await openIntroNormalWeather()
    expect(mapView.openUnitContext(DEFENDER_HEX, 'def-1', { x: 0, y: 0 })).toBe(true)
    expect(mapView.openContextAction('def-1', 'ops.hipShoot')).toBe(true)
    workbench.airInputs = {
      ...workbench.airInputs,
      printedFlakValue: 3,
      flakDie: 12,
      lossDie: 1,
    }
    workbench.toggleAirMissionUnit('hip-1')
    expect(mapView.advanceOpsFlow()).toBe(true)

    // 结算前：宣布与防空各成一笔，且宣布在前（14.2f A→E 的顺序）
    const actionsBefore = session.log.map((entry) => entry.action)
    const declareAt = actionsBefore.indexOf('airMission')
    const flakAt = actionsBefore.indexOf('airFlak')
    expect(declareAt).toBeGreaterThanOrEqual(0)
    expect(flakAt).toBeGreaterThan(declareAt)
    // 夹具直接给了骰面（不产生自动掷骰记录），落账的是骰面与损失结论
    const flakOutcome = session.log[flakAt]?.outcome
    expect(flakOutcome?.ok).toBe(true)
    if (flakOutcome?.ok)
      expect(flakOutcome.data).toMatchObject({
        die2d6: 12,
        lossDie: 1,
        hit: true,
        lossAircraftId: 'hip-1',
      })

    // 14.2f-F：面板 2「结算任务」⇒ 跑轰炸链
    expect(workbench.settleAirMissionNow()).toBe(true)
    expect(workbench.barrageState?.finished).toBe(true)
    expect(workbench.log.some((entry) => (entry.text ?? '').includes('轰炸结果（10.0a）'))).toBe(
      true,
    )
    // 14.7d-A：低空扫射不写「每阶段每格一次」的格账本；10.0e-B 的单位账本照记
    expect(workbench.barragePhaseLedger.hexes).not.toContain(
      `${String(DEFENDER_HEX.col)}.${String(DEFENDER_HEX.row)}`,
    )
    expect(workbench.barragePhaseLedger.unitIds).toContain('hip-1')

    // 14.2f-G：低空扫射自动返航并变非激活
    await nextTick()
    expect(workbench.airState?.finished).toBe(true)
    expect(workbench.airState?.step).toBe('done')
    expect(workbench.airUnits.find((air) => air.instanceId === 'hip-1')?.airStatus).toBe('inactive')
    expect(mapView.opsFlow).toBeNull()
  })
})
