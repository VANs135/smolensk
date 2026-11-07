import fs from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { toConsoleUnit, unitChoices, useGameSessionStore, useWorkbenchStore } from '@/stores'

/**
 * 专规 2.4 慢动员的 **store 端到端**（真实到达卡、真实单位库）
 *
 * 核对（用户 2026-11-05 裁定①⑨「不要管什么配额，按回合能动就行」）：
 * - 30/28/24 集团军的师**到场即锁定**，归属来自到达卡分组（单位库没有集团军字段）；
 * - 每回合由玩家在**仍锁定**的师中自选，可挑数＝表 2-2 **当日**数字；
 * - **不维护累计账本**：同回合已解锁数只从会话日志去重，跨回合不累计、不封顶；
 * - 一次提交=整批校验：超当日配额 / 跨集团军 / 无归属一律拒绝，规则号 2.4；
 * - 同日重复提交不会重复拿到配额；换方往返、读档后当日去重不重置（日志随档保存）；
 * - 未达"与指挥部同一到达卡分组"判据的师不进入专规集合。
 *
 * 用户给的验收例子（30th 共 5 师）：7.12 选 2 ⇒ 2 可动、3 仍锁；7.15 其余 3 一并可动。
 */

const newStore = () => {
  setActivePinia(createPinia())
  // 2.4 的"本回合已解锁"从会话日志推导（裁定①⑨：不加存档字段）⇒ 测试需要真实会话
  useGameSessionStore().startGame()
  return useWorkbenchStore()
}

const pickSovietDivision = () => {
  const record = unitChoices('soviet').find((item) => /Div/i.test(item.vassalName ?? ''))
  if (record === undefined) throw new Error('苏军单位库中没有师级记录')
  return record
}

describe('专规 2.4：慢动员（store 流程）', () => {
  it('2.4：12 Jul 到达的 30th 集团军师到场即锁定并带归属', () => {
    const store = newStore()
    store.setActiveSide('soviet')
    store.setTurn(2)
    store.setPhase('reinforcement')
    const plan = store.arrivalPlan
    if (plan === null) throw new Error('12 Jul 应有到达计划')
    const index = plan.units.findIndex((unit) => unit.slowMobilizationArmy === '30th')
    expect(index).toBeGreaterThanOrEqual(0)
    expect(store.placeArrivalNow(index, pickSovietDivision().id)).toBe(true)

    const arrived = store.units.filter((unit) => unit.slowMobilizationArmy === '30th')
    expect(arrived.length).toBeGreaterThan(0)
    expect(arrived.every((unit) => unit.locked)).toBe(true)
  })

  it('2.4：解锁只作用于玩家选中的师，当日配额用尽后第三枚被拒', () => {
    const store = newStore()
    store.setActiveSide('soviet')
    store.setTurn(2)
    store.setPhase('reinforcement')
    const plan = store.arrivalPlan
    if (plan === null) throw new Error('12 Jul 应有到达计划')
    const indices: number[] = []
    plan.units.forEach((unit, index) => {
      if (unit.slowMobilizationArmy === '30th') indices.push(index)
    })
    expect(indices.length).toBeGreaterThanOrEqual(3)
    const record = pickSovietDivision()
    for (const index of indices) {
      expect(store.placeArrivalNow(index, record.id)).toBe(true)
    }

    const lockedIds = store.units
      .filter((unit) => unit.slowMobilizationArmy === '30th' && unit.locked)
      .map((unit) => unit.instanceId)
    expect(lockedIds.length).toBeGreaterThanOrEqual(3)

    // 12 Jul 表 2-2 只给 30th 两个配额
    expect(store.unlockSlowMobilizationNow(lockedIds[0]!)).toBe(true)
    expect(store.unlockSlowMobilizationNow(lockedIds[1]!)).toBe(true)
    expect(store.unlockSlowMobilizationNow(lockedIds[2]!)).toBe(false)

    const unlocked = store.units.filter(
      (unit) => unit.slowMobilizationArmy === '30th' && !unit.locked,
    )
    expect(unlocked.map((unit) => unit.instanceId).sort()).toEqual(
      [lockedIds[0]!, lockedIds[1]!].sort(),
    )
  })

  it('2.4：30th 共 5 师——7.12 整批选 2（剩 3 锁），7.15 再整批 3 全解锁', () => {
    const store = newStore()
    store.setActiveSide('soviet')
    store.setTurn(2)
    store.setPhase('reinforcement')
    const plan = store.arrivalPlan
    if (plan === null) throw new Error('12 Jul 应有到达计划')
    const record = pickSovietDivision()
    plan.units.forEach((unit, index) => {
      if (unit.slowMobilizationArmy === '30th')
        expect(store.placeArrivalNow(index, record.id)).toBe(true)
    })
    expect(store.slowMobilizationLockedOf('30th').length).toBe(5)
    expect(store.slowMobilizationQuotaOf('30th')).toBe(2)

    const ids = store.slowMobilizationLockedOf('30th').map((unit) => unit.instanceId)
    // 超配额整批 3 枚 ⇒ 整批拒绝，规则号 2.4，账本不动
    expect(store.unlockSlowMobilizationBatch(ids.slice(0, 3))).toBe(false)
    expect(store.reinforcementError?.rule).toBe('2.4')
    expect(store.slowMobilizationLockedOf('30th').length).toBe(5)

    expect(store.unlockSlowMobilizationBatch(ids.slice(0, 2))).toBe(true)
    expect(store.slowMobilizationLockedOf('30th').length).toBe(3)

    // 同日再提交不重复给配额
    expect(store.unlockSlowMobilizationBatch(ids.slice(2, 4))).toBe(false)
    expect(store.slowMobilizationLockedOf('30th').length).toBe(3)

    // 7.15：表 2-2 当日 3（裁定①⑨：不再做"累计 5 − 已解锁 2"的账本差）
    store.setTurn(3)
    expect(store.slowMobilizationQuotaOf('30th')).toBe(3)
    const rest = store.slowMobilizationLockedOf('30th').map((unit) => unit.instanceId)
    expect(rest.length).toBe(3)
    expect(store.unlockSlowMobilizationBatch(rest)).toBe(true)
    expect(store.slowMobilizationLockedOf('30th').length).toBe(0)
  })

  it('2.4：跨集团军一次提交被拒（同批只能同一集团军）', () => {
    const store = newStore()
    store.setActiveSide('soviet')
    store.setTurn(2)
    store.setPhase('reinforcement')
    const first = store.arrivalPlan
    if (first === null) throw new Error('12 Jul 应有到达计划')
    const record = pickSovietDivision()
    first.units.forEach((unit, index) => {
      if (unit.slowMobilizationArmy === '30th') store.placeArrivalNow(index, record.id)
    })
    // 28th 于 15 Jul 到场；换回合后两边都仍有锁定师
    store.setTurn(3)
    const second = store.arrivalPlan
    if (second === null) throw new Error('15 Jul 应有到达计划')
    second.units.forEach((unit, index) => {
      if (unit.slowMobilizationArmy === '28th') store.placeArrivalNow(index, record.id)
    })
    const a = store.slowMobilizationLockedOf('30th')[0]
    const b = store.slowMobilizationLockedOf('28th')[0]
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(store.unlockSlowMobilizationBatch([a!.instanceId, b!.instanceId])).toBe(false)
  })

  it('2.4：锁定的师不能开拔；换方往返后当日配额不重置，15 Jul 才放下一批', () => {
    const store = newStore()
    store.setActiveSide('soviet')
    store.setTurn(2)
    store.setPhase('reinforcement')
    const record = pickSovietDivision()
    // 表 2-2 中 30th 两批合计只有 5 个师（12 Jul 2 + 15 Jul 3）；多摆一个用于验证上限
    const ids: string[] = []
    for (let index = 0; index < 6; index += 1) {
      const unit = toConsoleUnit({
        record,
        instanceId: `ru-locked-${index}`,
        hex: { col: 36, row: 13 },
        side: 'soviet',
      })
      unit.locked = true
      unit.slowMobilizationArmy = '30th'
      ids.push(unit.instanceId)
      store.units.push(unit)
    }

    store.setPhase('movement')

    // 锁定的师不能开拔：选中 36,13 的栈即被 2.4 拦下
    store.clickHex({ col: 36, row: 13 })
    expect(store.confirmMovePick()).toBe(false)
    expect(store.moveBlocked?.rule).toBe('专规 2.4')

    store.setPhase('reinforcement')
    expect(store.unlockSlowMobilizationNow(ids[0]!)).toBe(true)
    expect(store.unlockSlowMobilizationNow(ids[1]!)).toBe(true)
    expect(store.unlockSlowMobilizationNow(ids[2]!)).toBe(false)

    // 换方往返不重置当日配额
    store.setActiveSide('axis')
    store.setActiveSide('soviet')
    expect(store.unlockSlowMobilizationNow(ids[2]!)).toBe(false)

    // 15 Jul：当日表值 3（本回合已解锁 0；不再做累计差）
    store.setTurn(3)
    expect(store.unlockSlowMobilizationNow(ids[2]!)).toBe(true)
    expect(store.unlockSlowMobilizationNow(ids[3]!)).toBe(true)
    expect(store.unlockSlowMobilizationNow(ids[4]!)).toBe(true)
    // 第 6 个永远超出表 2-2 的合计 5（30th 再无后续批次）
    expect(store.unlockSlowMobilizationNow(ids[5]!)).toBe(false)
    expect(store.units.filter((unit) => unit.locked).map((unit) => unit.instanceId)).toEqual([
      ids[5]!,
    ])
    // 为何显式超时：该用例建会话 + 6 枚算子 + 两次推进回合，**单跑 2.0s**、并行全量负载下
    // **5.2s（曾观测到 7.5s）**，超过默认 5000ms ⇒ 会误报 `Test timed out in 5000ms`。
    // 这是**并行负载导致的测试级超时，不是规则回归**；断言一字未改，只放宽执行时间。
    // 取值 30000 与仓内同类重流程用例（`sp-ownership-load-merge`、`setup-obligations-flow`）一致。
  }, 30000)

  it('2.4：轴方增援阶段不出现慢动员 UI（按侧 + 编制双重过滤）', () => {
    const store = newStore()
    store.setActiveSide('axis')
    store.setTurn(2)
    store.setPhase('reinforcement')

    // ① 可见性：2.4 是苏联专规 ⇒ 轴方增援阶段不出现
    expect(store.slowMobilizationVisible).toBe(false)

    /*
     * ② 候选双重过滤：即便一枚**德军**算子被错标成 `30th` 集团军归属，也不能进苏方慢动员集合、
     *    更不能被"按表解锁"（侧 + 编制两道过滤）。
     */
    const axisRecord = unitChoices('axis')[0]
    if (axisRecord === undefined) throw new Error('轴方单位库为空')
    const german = toConsoleUnit({
      record: axisRecord,
      instanceId: 'ax-slow-mob',
      hex: { col: 5, row: 27 },
      side: 'axis',
    })
    german.locked = true
    german.slowMobilizationArmy = '30th'
    store.units.push(german)

    expect(store.slowMobilizationLockedOf('30th').map((unit) => unit.instanceId)).not.toContain(
      'ax-slow-mob',
    )
    expect(store.unlockSlowMobilizationBatch(['ax-slow-mob'])).toBe(false)
    expect(german.locked).toBe(true)

    // ③ 面板源码守卫：整段 2.4 UI 由可见性门包住；手动锁定阵列只取"苏方 + 30/28/24"
    const panel = fs.readFileSync('src/components/reinforcement/ReinforcementPanel.vue', 'utf8')
    expect(panel).toContain('v-if="workbench.slowMobilizationVisible"')
    expect(panel).toContain('slowMobilizationUnitItems(')
    expect(panel).not.toMatch(/慢动员[\s\S]{0,400}:items="rebuildUnitItems/)

    // ④ 苏方增援阶段恢复可见；离开增援阶段即收起
    store.setActiveSide('soviet')
    expect(store.slowMobilizationVisible).toBe(true)
    store.setPhase('movement')
    expect(store.slowMobilizationVisible).toBe(false)
  })

  it('2.4：没有到达卡集团军归属的算子不能按表解锁（不按番号前缀猜）', () => {
    const store = newStore()
    store.setActiveSide('soviet')
    store.setTurn(2)
    store.setPhase('reinforcement')
    const unit = toConsoleUnit({
      record: pickSovietDivision(),
      instanceId: 'ru-unverifiable',
      hex: { col: 1, row: 26 },
      side: 'soviet',
    })
    unit.locked = true
    store.units.push(unit)

    expect(store.unlockSlowMobilizationNow('ru-unverifiable')).toBe(false)
    expect(unit.locked).toBe(true)
  })
})
