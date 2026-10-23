import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { SP_TO_T } from '@/engine/rules'
import {
  actionGateOf,
  needsFuelOf,
  toConsoleUnit,
  unitChoices,
  useSetupStore,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
  type ConsoleUnit,
} from '@/stores'

/**
 * 批 B 切片 1：**编队卡车满载自动落账**（13.2h / 通规 IV-D / 专规 Setup Note C）
 *
 * 规则原文：
 *   · 通规 **IV-D**：`Organic Trucks start "full" only if a scenario explicitly states that they do.`
 *   · 专规 **Setup Note C**：`Special Scenario Rules will say if organic trucks are Empty or Full.`
 *   · **13.2h**：满载面（带黄框的「F」）＝已满载，另一面＝空载 ⇒ 本作记作 `loadedSpT`（满载＝1 SP）。
 *   · **12.1b**：「任何含有 SP 的位置……都被称为补给站」⇒ 装载在卡车上（`loadedSpT > 0`）也是来源。
 *
 * **病灶（用户 2026-09-17 夜实测）**：剧本页明示"德军全部满载"时，12 辆车的 `loadedSpT` 只在
 * `designateTrucks()` 里写，而该方法**只由两个界面按钮**触发；这类剧本的卡车又不进决策队列
 * ⇒ 玩家不点那个按钮则 12 辆全 0 ⇒「编队从编队卡车加油」**候选为空**（走不下去）。
 *
 * ## 测法边界（如实交代）
 *   · 用**真实剧本数据**（`scenarios.json` 的 `setup.organicTrucks`）与真实算子库，不造数；
 *   · 端到端那条只用**同一格**构造（12.3a 的"相邻即可"），故与地形造价无关——跨格拖取的地形
 *     敏感性由 `carried-sp-source.test.ts` / `fuel-source-method.test.ts` 覆盖；
 *   · **不覆盖**界面渲染（本仓库不挂组件渲染测试）⇒ "面板只在自选时给勾选"靠
 *     `truckLoadSummary` 的投影断言＋源码守卫（见本文件末尾那条）。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return { setup: useSetupStore(), workbench: useWorkbenchStore() }
}

/**
 * B8：把 store 放到本段里允许做该动作的那个环节
 *
 * ★ 本轮实测（探针 `backup/2026-09-18-B1/audit-scripts/probe-truck-fuel.mjs`）：**自动落账不会**
 *   顺带放开付款——`payFuel` 仍受环节闸门约束（停在 C 段首环「突围」时被 12.5 拒，reason 明写
 *   「只能在 D 补给·加油 / C 移动·模式与移动 / E 反应·反应移动 / G 进击·进击移动 进行」）。
 *   这是**正确**行为：本切片只解决"卡车上没有油"，不改变"加油要在加油环节"。
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

describe('批 B 切片 1：编队卡车满载自动落账（13.2h / IV-D）', () => {
  let setup: ReturnType<typeof newStores>['setup']
  let workbench: ReturnType<typeof newStores>['workbench']

  beforeEach(() => {
    const stores = newStores()
    setup = stores.setup
    workbench = stores.workbench
  })

  /** 盘上某实例的算子（断言用；找不到即抛，避免静默放过） */
  const unitOf = (instanceId: string): ConsoleUnit => {
    const unit = workbench.units.find((item) => item.instanceId === instanceId)
    if (unit === undefined) throw new Error(`盘上没有算子 ${instanceId}`)
    return unit
  }

  it('★ 剧本 1（全部满载）：**不点任何按钮**也把 loadedSpT 落账（12 辆）', () => {
    // 只走"进对局台"的那一条（`GameTableView` 挂载时调的正是 ensureSetupLoaded）
    expect(setup.ensureSetupLoaded()).toBe(true)
    expect(setup.truckLoadMode).toBe('all_loaded')
    expect(setup.setupTrucks).toHaveLength(12)

    // ★ 这就是用户报的那条：修前这里 12 辆全是 0（没人点按钮）
    for (const truck of setup.setupTrucks) {
      expect(unitOf(truck.instanceId).loadedSpT).toBe(SP_TO_T)
    }
    // 步骤账本与回执（面板据此显示"已落账"）
    expect(setup.stepDone['truckLoad']).toBe(true)
    expect(setup.truckLoadSummary).toMatchObject({
      mode: 'all_loaded',
      automatic: true,
      total: 12,
      fullCount: 12,
      done: true,
      raw: '德军全部满载',
    })
    expect(setup.lastAction?.detail).toContain('编内卡车按剧本自动落账')
  })

  it('★ 12.1b：自动落账后，编队卡车**当场就是补给来源**（"含 SP 的位置"）', () => {
    setup.ensureSetupLoaded()
    const carried = workbench.carriedSpDumps
    // 12 辆满载 ⇒ 12 条"装载在运输点数上的 SP"
    expect(carried).toHaveLength(12)
    expect(carried.every((dump) => dump.id.startsWith('unit:'))).toBe(true)
    expect(carried.every((dump) => dump.sp === 1)).toBe(true)
  })

  it('★ 反向（"已点核验按钮"那条前置）：再点一次结果一致、账本不叠加（幂等）', () => {
    setup.ensureSetupLoaded()
    const before = setup.setupTrucks.map((truck) => unitOf(truck.instanceId).loadedSpT)
    expect(setup.designateTrucks()).toBe(true)
    const after = setup.setupTrucks.map((truck) => unitOf(truck.instanceId).loadedSpT)
    expect(after).toEqual(before)
    expect(workbench.carriedSpDumps).toHaveLength(12)
    // 再走一次"进对局台"也不会重复落盘（applied 已有 ⇒ 直接跳过）
    expect(setup.ensureSetupLoaded()).toBe(false)
    expect(workbench.carriedSpDumps).toHaveLength(12)
  })

  it('★ 剧本 7（全部空载）：自动落账为 0，且步骤照记完成', () => {
    setup.selectScenario('7')
    expect(setup.truckLoadMode).toBe('all_unloaded')
    for (const truck of setup.setupTrucks) {
      expect(unitOf(truck.instanceId).loadedSpT).toBe(0)
    }
    expect(setup.truckLoadSummary).toMatchObject({ automatic: true, fullCount: 0, done: true })
    expect(workbench.carriedSpDumps).toEqual([])
  })

  it('★ 剧本 3（玩家自选 4 辆）：**不自动落账**，勾选登记后才写（只有那 4 辆）', () => {
    setup.selectScenario('3')
    expect(setup.truckLoadMode).toBe('choose_loaded')
    expect(setup.truckLoadSummary.automatic).toBe(false)
    // 自选模式下**没有**人替玩家决定：全部 0，步骤未完成
    expect(setup.setupTrucks.every((truck) => unitOf(truck.instanceId).loadedSpT === 0)).toBe(true)
    expect(setup.stepDone['truckLoad']).toBe(false)

    for (const truck of setup.setupTrucks.slice(0, 4)) {
      setup.toggleTruckFull(truck.instanceId, true)
    }
    expect(setup.designateTrucks()).toBe(true)
    setup.setupTrucks.forEach((truck, index) => {
      expect(unitOf(truck.instanceId).loadedSpT).toBe(index < 4 ? SP_TO_T : 0)
    })
    expect(workbench.carriedSpDumps).toHaveLength(4)
  })

  it('★★ 端到端（用户报的卡死路径）：剧本 1 不点按钮 ⇒ 同编队单位**能从编队卡车加油**', () => {
    setup.ensureSetupLoaded()

    // 取一辆盘上的编队卡车（13.2g-B：它的 SP 只许**同一多单位编队**内的单位拖取）
    const truck = setup.setupTrucks[0]!
    const truckUnit = unitOf(truck.instanceId)
    const truckRecord = unitChoices('axis').find((record) => record.id === truck.unitId)!
    const formation = truckRecord.formation ?? null
    expect(formation).not.toBeNull() // 前提：本作编内卡车带编队号（13.2g-B 的"同一多单位编队"）

    // 同编队里**耗油**的单位（12.5a：轮式/履带战斗单位），摆到卡车所在格（12.3a 相邻即可）
    const mate = unitChoices('axis')
      .filter(
        (record) =>
          record.formation === formation &&
          record.isCombat === true &&
          record.id !== truckRecord.id &&
          (record.classes?.movementClass === 'tracked' ||
            record.classes?.movementClass === 'truck'),
      )
      .map((record) =>
        toConsoleUnit({
          record,
          instanceId: `mate-${record.id}`,
          hex: { ...truckUnit.hex } as HexRef,
          side: 'axis',
        }),
      )
      .find((unit) => needsFuelOf(unit))
    if (mate === undefined) throw new Error('数据里找不到"同编队的耗油单位"（13.2g-B 的前提）')

    /*
     * ★ 性能边界（如实交代，本轮实测）：整剧本盘面上切到移动段会触发 12.6 的**全场追溯重判**
     *   （178 枚地面算子，实测这一条要**几分钟**——既有已知瓶颈，见 §16.01 的"初设期不做全场追溯重判"，
     *   与批 B 无关）。故这里把盘面收敛到"这一辆卡车 + 这一枚受益单位"再切段：
     *   被裁掉的算子**不影响本用例的判据**（装载账本已在初设时落盘，见上面那几条用例），
     *   而 12.5 的付款与来源判定只涉及这两枚。
     */
    workbench.units.splice(0, workbench.units.length, truckUnit, mate)

    workbench.setPhase('movement')
    // 12.5：加油在「模式与移动」环节（12.5a/f 的"消耗时支付"也允许在移动环节付）
    goToActionStep(workbench, 'supply.fuel')

    workbench.selectedId = mate.instanceId
    workbench.fuelMethod = 'singleUnit'
    // 13.2g-B：同编队的拖取方 ⇒ 这辆车在候选里（★ 修前为空 ⇒ "编队从编队卡车加油会卡死"）
    expect(workbench.fuelDumpChoices.map((dump) => dump.id)).toContain(`unit:${truck.instanceId}`)

    // 真付一次（12.5c-C：单独单位法每枚 1T）⇒ 单位加注、卡车装载量减少
    workbench.pickFuelDump(`unit:${truck.instanceId}`)
    workbench.payFuel()
    expect(unitOf(mate.instanceId).fuelled).toBe(true)
    expect(unitOf(truck.instanceId).loadedSpT).toBe(SP_TO_T - 1)
  }, 30_000)

  it('源码守卫：面板与决策队列都按 truckLoadMode 分流（只在自选时给勾选/按钮）', () => {
    const panel = readFileSync('src/components/setup/SetupPanel.vue', 'utf8')
    // 勾选框与"核验"按钮在 `choose_loaded` 分支里（自动模式下不渲染）
    expect(panel).toContain(`v-if="setup.truckLoadSummary.mode === 'choose_loaded'"`)
    // 剧本原文那一份口径也搬进了 store（组件不再自己读剧本数据）
    expect(panel).toContain('setup.truckLoadSummary.raw')
    expect(panel).not.toContain('truckRaw')
    const queue = readFileSync('src/components/game/DecisionQueue.vue', 'utf8')
    expect(queue).toContain(`v-if="setup.truckLoadSummary.mode === 'choose_loaded'"`)
    // 反空转守卫：这两处判据真的指向 store 的那一份投影（而不是恰好同名的别的东西）
    const store = readFileSync('src/stores/setup.ts', 'utf8')
    expect(store).toContain('const truckLoadSummary = computed')
    expect(store).toContain("automatic: truckLoadMode.value === 'all_loaded'")
  })
})
