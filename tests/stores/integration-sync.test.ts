import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { scenarios } from '@/data'
import { createMemoryStorage, type KeyValueStorage } from '@/shared'
import {
  TURN_TRACK,
  turnDateOf,
  useContainersStore,
  useGameSessionStore,
  useHotseatStore,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
} from '@/stores'
import { CORE_HEX, combatRecord, placeGround } from '../flows/sop-harness'

/**
 * 全模块联调 · **跨模块一致性**（W7 联调基线）
 *
 * ## 本文件钉住什么
 *   子模块各自开发时，同一件事很容易被「各存一份」：剧本号有四个 store 各持一份、
 *   流程事实（当前方 / 阶段 / 回合）有「会话记录轨」与「操作台本地量」两套钟、
 *   地图覆盖层在两个视图各写一份。任一处分叉，界面就会自相矛盾。
 *
 *   联调确立的口径是：**会话 store 为唯一权威，其余一律只读投影**。本文件把这套口径固化成用例：
 *   | 用例 | 钉住的契约 |
 *   |---|---|
 *   | ① 剧本号单一权威 | `session` / `workbench` / `setup` / `containers` 四处永远同值 |
 *   | ② 读档后四处一致 | 读档只写会话，其余三处靠投影自动跟上（不靠各写一遍） |
 *   | ③ 流程钟单一 | 操作台切方 / 切段 / 改回合**写回记录轨**；流程条推进**反向**驱动操作台 |
 *   | ④ 未开局退回本地 | 无会话时操作台仍可独立演练（保住既有测试口径，不被联调改坏） |
 *   | ⑤ 地图覆盖层单一来源 | 两个视图共用 `mapView`，不再各写一份（源码级守卫） |
 *
 * ## 分层纪律
 *   本文件只做**编排层的状态一致性**断言，不重算任何规则（规则结论仍由 `engine/**` 负责，
 *   见 tests/regression/*）。因此这里不出现任何规则数值，只出现「同一件事在几处是否一致」。
 */

/* ────────────────────────────── 夹具 ────────────────────────────── */

/** 一套共享同一 Pinia 实例的 store（联调关心的是「它们之间是否一致」） */
function boot(adapter: KeyValueStorage = createMemoryStorage()) {
  setActivePinia(createPinia())
  const session = useGameSessionStore()
  session.setSaveStorage(adapter)
  return {
    adapter,
    session,
    workbench: useWorkbenchStore(),
    setup: useSetupStore(),
    containers: useContainersStore(),
    hotseat: useHotseatStore(),
    mapView: useMapViewStore(),
  }
}

type Booted = ReturnType<typeof boot>

/** 四处剧本号的快照（用于「永远同值」的断言） */
function scenarioIdsOf(stores: Booted): string[] {
  return [
    stores.session.scenarioId,
    stores.workbench.scenarioId,
    stores.setup.scenarioId,
    stores.containers.scenarioId,
  ]
}

/** 剥掉 `//` 与 `/* *\/` 注释后再匹配（否则注释里提到的东西会被误判） */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** 读源码文本（本文件在 tests/stores/，故上溯两级到仓库根） */
function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')
}

/** 开局共识（专规 4.0）：全部勾选并写入日志，之后即可推进流程 */
function confirmConsensus(session: Booted['session']): void {
  session.setAllAgreedChecks(true)
  expect(session.confirmAgreedChecklist()).toBe(true)
}

/* ────────────────────────────── ① 剧本号单一权威 ────────────────────────────── */

describe('联调①：剧本号只有一个权威（会话 store），其余三处是投影', () => {
  it('建店初始即四处同值（无会话也一致，剧本号不随会话是否存在而消失）', () => {
    const stores = boot()
    const ids = scenarioIdsOf(stores)
    expect(new Set(ids).size).toBe(1)
    expect(ids[0]).toBe(stores.session.scenarioId)
  })

  it('三个入口（初设 / 操作台 / 容器抽取盒）任一改剧本 ⇒ 四处同步跟随', () => {
    const stores = boot()

    // 入口一：初设面板（全程序唯一剧本入口）
    expect(stores.setup.selectScenario('3')).toBe(true)
    expect(scenarioIdsOf(stores)).toStrictEqual(['3', '3', '3', '3'])

    // 入口二：操作台
    stores.workbench.setScenarioId('2')
    expect(scenarioIdsOf(stores)).toStrictEqual(['2', '2', '2', '2'])

    // 入口三：容器抽取盒
    expect(stores.containers.setScenario('4')).toBe(true)
    expect(scenarioIdsOf(stores)).toStrictEqual(['4', '4', '4', '4'])
  })

  it('会话已开局 ⇒ 换剧本被拒，**四处一个都不动**（不做半更新）', () => {
    const stores = boot()
    expect(stores.setup.selectScenario('3')).toBe(true)
    expect(stores.session.startGame()).toBe(true)

    // 已开局：三处入口都应被会话锁住（2.2：避免流程与剧本错配）
    expect(stores.setup.selectScenario('5')).toBe(false)
    stores.workbench.setScenarioId('5')
    expect(stores.containers.setScenario('5')).toBe(false)

    expect(scenarioIdsOf(stores)).toStrictEqual(['3', '3', '3', '3'])
  })
})

/* ────────────────────────────── ② 读档后四处一致 ────────────────────────────── */

describe('联调②：读档只写会话，其余三处靠投影自动跟上', () => {
  it('存档里的剧本号读回后，四处一致（不需要谁再补写一遍）', () => {
    const adapter = createMemoryStorage()

    // 第一局：剧本 3 开局并存档
    const first = boot(adapter)
    expect(first.setup.selectScenario('3')).toBe(true)
    expect(first.session.startGame()).toBe(true)
    expect(first.session.saveNow()).toBe(true)

    // 新实例读档（结论来自存档文件，而非内存里的旧对象）
    const second = boot(adapter)
    expect(scenarioIdsOf(second)).toStrictEqual(['1', '1', '1', '1']) // 读档前是默认剧本
    expect(second.session.loadNow()).toBe(true)
    expect(scenarioIdsOf(second)).toStrictEqual(['3', '3', '3', '3'])
  })

  it('读档恢复记录轨后，操作台的流程投影（当前方 / 阶段 / 回合）随之复位', () => {
    const adapter = createMemoryStorage()
    const first = boot(adapter)
    first.session.startGame()
    confirmConsensus(first.session)
    first.session.stepNow() // 天气判定
    first.session.stepNow() // 先手判定 ⇒ 进入 A 整备段
    expect(first.session.records?.phase).toBe('aircraftRefit')
    expect(first.session.saveNow()).toBe(true)

    // 在原实例里把钟拨到别处，再读档 ⇒ 操作台投影必须回到存档那一刻
    first.workbench.setPhase('combat')
    first.workbench.setTurn(5)
    expect(first.workbench.phase).toBe('combat')

    expect(first.session.loadNow()).toBe(true)
    expect(first.workbench.phase).toBe('aircraftRefit')
    expect(first.workbench.turn).toBe(first.session.records?.turn)
    expect(first.workbench.activeSide).toBe(first.session.records?.activeSide ?? 'axis')
  })
})

/* ────────────────────────────── ③ 流程钟单一 ────────────────────────────── */

describe('联调③：流程事实只有一套钟（会话记录轨）；操作台与流程条读写同一处', () => {
  it('操作台手动切方 / 切段 / 改回合 ⇒ 写回记录轨（流程条读到的是同一份）', () => {
    const stores = boot()
    expect(stores.session.startGame()).toBe(true)
    const before = stores.session.records?.turn

    stores.workbench.setActiveSide('soviet')
    expect(stores.session.records?.activeSide).toBe('soviet')
    expect(stores.workbench.activeSide).toBe('soviet')

    stores.workbench.setPhase('combat')
    expect(stores.session.records?.phase).toBe('combat')
    expect(stores.workbench.phase).toBe('combat')

    stores.workbench.setTurn(4)
    expect(stores.session.records?.turn).toBe(4)
    expect(stores.workbench.turn).toBe(4)
    expect(before).toBe(1)
  })

  it('流程条推进（会话步进）⇒ 操作台的阶段投影自动跟随（反向也一致）', () => {
    const stores = boot()
    expect(stores.session.startGame()).toBe(true)
    confirmConsensus(stores.session)

    stores.session.stepNow() // 天气判定（首回合按剧本指定 ⇒ 不掷骰）
    stores.session.stepNow() // 先手判定
    expect(stores.session.records?.phase).toBe('aircraftRefit')
    expect(stores.workbench.phase).toBe('aircraftRefit')
  })

  it('回合号是日期的唯一来源（改回合，日期随之派生，二者不可能漂移）', () => {
    const stores = boot()
    for (const turn of [1, 4, 8, TURN_TRACK[TURN_TRACK.length - 1]?.turn ?? 19]) {
      stores.workbench.setTurn(turn)
      expect(stores.workbench.turn).toBe(turn)
      expect(stores.workbench.date).toBe(turnDateOf(turn))
    }
  })

  it('回合号越界即夹取到回合轨范围（不产生轨外日期）', () => {
    const stores = boot()
    const firstTurn = TURN_TRACK[0]?.turn ?? 1
    const lastTurn = TURN_TRACK[TURN_TRACK.length - 1]?.turn ?? firstTurn

    stores.workbench.setTurn(-5)
    expect(stores.workbench.turn).toBe(firstTurn)
    stores.workbench.setTurn(9999)
    expect(stores.workbench.turn).toBe(lastTurn)
    expect(stores.workbench.date).toBe(turnDateOf(lastTurn))
  })

  it('信息展示纪律（4.9a）的观察方跟着同一套钟：会话 → 操作台 → 热坐', () => {
    const stores = boot()
    expect(stores.session.startGame()).toBe(true)

    stores.session.patchRecords({ activeSide: 'soviet' })
    expect(stores.workbench.activeSide).toBe('soviet')
    expect(stores.hotseat.viewerSide).toBe('soviet')
    expect(stores.hotseat.opponentSide).toBe('axis')

    stores.workbench.switchSide()
    expect(stores.session.records?.activeSide).toBe('axis')
    expect(stores.hotseat.viewerSide).toBe('axis')
  })
})

/* ────────────────────────────── ④ 未开局退回本地演练值 ────────────────────────────── */

describe('联调④：无会话时操作台仍可独立演练（联调没有改坏既有口径）', () => {
  it('无会话 ⇒ 切方 / 切段 / 改回合只落在本地，不凭空造出会话', () => {
    const stores = boot()
    expect(stores.session.session).toBeNull()
    expect(stores.session.records).toBeNull()

    stores.workbench.setActiveSide('soviet')
    stores.workbench.setPhase('supply')
    stores.workbench.setTurn(7)

    expect(stores.workbench.activeSide).toBe('soviet')
    expect(stores.workbench.phase).toBe('supply')
    expect(stores.workbench.turn).toBe(7)
    // 会话仍未被创建（写会话的通道返回 false，调用方退回本地值）
    expect(stores.session.session).toBeNull()
    expect(stores.session.records).toBeNull()
  })

  it('会话建立后，本地演练值不再遮盖记录轨（投影优先）', () => {
    const stores = boot()
    stores.workbench.setPhase('supply') // 本地值 = supply
    expect(stores.workbench.phase).toBe('supply')

    expect(stores.session.startGame()).toBe(true) // 记录轨 = preTurn
    // preTurn 无对应行动段 ⇒ 段的**显示**沿用本地段；但行动由 `segmentLocked` 拦下（见联调⑦）
    expect(stores.workbench.phase).toBe('supply')
    expect(stores.workbench.segmentLocked).toBe(true)

    confirmConsensus(stores.session)
    stores.session.stepNow()
    stores.session.stepNow() // ⇒ aircraftRefit
    expect(stores.workbench.phase).toBe('aircraftRefit')
    expect(stores.workbench.segmentLocked).toBe(false)
  })
})

/* ────────────────────────────── ⑦ 联调遗留：派生账本 + preTurn 段闸 ────────────────────────────── */

/**
 * ⑦ 钉住两件"号变了、账本/权限没变"的漏网事：
 *
 * | 用例 | 钉住的契约 |
 * |---|---|
 * | ① 读档换剧本 ⇒ 派生账本重取 | 写会话的路径不止一条（本函数 / 容器盒 / **读档**），账本重取必须与入口无关 |
 * | ② 容器盒换剧本 ⇒ 同上 | 与 ① 同源，防"只修了读档那一条" |
 * | ③ preTurn 段闸 | 2.2 的回合准备环节**没有行动段**，移动/增援/空军一律拒绝并给 `2.2` |
 * | ④ 步进到移动段后放行 | 证明 ③ 挡的是"无段"而不是别的东西 |
 * | ⑤ 无会话时不锁 | 保住「未开局也能独立演练」的口径 |
 * | ⑥ 手动切段是临时的 | `Records.phase` 与 SOP 步指针的关系（口径固化，见 `patchRecords` 注释） |
 */
describe('联调⑦：剧本号一变，**随剧本重取的盘面账本**必须跟着变（与入口无关）', () => {
  it('读档换剧本 ⇒ 建造标记与初设换轨账本按**新剧本**重取', () => {
    const adapter = createMemoryStorage()

    // 第一局：剧本 3（建造标记 0）并存档
    const first = boot(adapter)
    expect(first.setup.selectScenario('3')).toBe(true)
    expect(first.workbench.constructionMarkers).toBe(0)
    expect(first.workbench.convertedRailHexes).toHaveLength(10) // 2+4+4
    expect(first.session.startGame()).toBe(true)
    expect(first.session.saveNow()).toBe(true)

    // 新实例（默认剧本 1：建造标记 3、换轨 2 格）
    const second = boot(adapter)
    expect(second.workbench.constructionMarkers).toBe(3)
    expect(second.workbench.convertedRailHexes).toEqual(['1.3', '2.2'])

    expect(second.session.loadNow()).toBe(true)
    expect(second.workbench.scenarioId).toBe('3')
    // ★ 修前：这两项停在剧本 1 的值（3 枚 / 2 格）⇒ 苏军多建 3 个工事、轴方铁路只放行 2 格
    expect(second.workbench.constructionMarkers).toBe(0)
    expect(second.workbench.convertedRailHexes).toHaveLength(10)
  })

  it('容器盒换剧本 ⇒ 同样重取（剧本 7 的四段走线去重后 84 格）', () => {
    const stores = boot()
    expect(stores.containers.setScenario('7')).toBe(true)
    expect(stores.workbench.scenarioId).toBe('7')
    /*
     * 剧本 7 的四段走线原文长度 2+34+39+11 = 86 格，但**两条走线共用两格**
     * （`01.19→34.18` 与北向支线 `15.10→18.18` 都含 `18.18`；`01.07→38.05` 与支线都含 `15.10`）
     * ⇒ 账本按格去重后为 **84** 格。
     */
    expect(stores.workbench.convertedRailHexes).toHaveLength(84)
    expect(stores.workbench.convertedRailHexes).toContain('18.18') // 北向支线端点
    expect(stores.workbench.convertedRailHexes).toContain('15.10') // 支线与主线交汇
    expect(stores.workbench.convertedRailHexes).toContain('38.5') // 最长一段的端点（账本键不带前导零）
  })

  it('初设面板换剧本 ⇒ 与上两条口径一致（三入口同结论）', () => {
    const stores = boot()
    expect(stores.setup.selectScenario('7')).toBe(true)
    expect(stores.workbench.convertedRailHexes).toHaveLength(84)
  })
})

describe('联调⑦：`preTurn` 没有行动段 ⇒ 段闸动作一律拒绝并给 2.2', () => {
  /** 开局并停在 preTurn（天气 / 先手判定还没走） */
  const startedAtPreTurn = () => {
    const stores = boot()
    expect(stores.session.startGame()).toBe(true)
    expect(stores.session.records?.phase).toBe('preTurn')
    return stores
  }

  it('preTurn：可走格数为 0，点单位也开拔不了（2.2）', () => {
    const stores = startedAtPreTurn()
    const unit = placeGround(stores.workbench, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    // 条 10（批 M）：点格建取子清单；确认开拔才被段闸（2.2）拦下
    stores.workbench.clickHex(CORE_HEX)
    expect(stores.workbench.confirmMovePick()).toBe(false)
    // 段闸锁住 ⇒ 一格都不给，也不会进入移动交互
    expect(stores.workbench.segmentLocked).toBe(true)
    expect(stores.workbench.groupReachable.hexes).toHaveLength(0)
    expect(stores.workbench.moveInteraction).toBeNull()
    expect(unit.hex).toEqual(CORE_HEX) // 没有被搬走
    const blocked = stores.workbench.moveBlocked
    expect(blocked?.rule).toBe('2.2')
  })

  it('preTurn：增援类动作（到达投放等）也被拒（同一把锁）', () => {
    const stores = startedAtPreTurn()
    // 13.6 的到达投放要求 B 增援段；preTurn 下应先被"无段"拦下（`requirePhase` 走同一把锁）
    expect(stores.workbench.placeArrivalNow(0)).toBe(false)
    // 拒绝口径是「无段 ⇒ 2.2」，而不是「段不对 ⇒ 13.6」（后者走 `reinforcementError`）
    expect(stores.workbench.moveBlocked?.rule).toBe('2.2')
    expect(stores.workbench.reinforcementError).toBeNull()
  })

  it('步进到 C 移动段后，同一把锁自动放开（挡的是"无段"而不是别的）', () => {
    const stores = startedAtPreTurn()
    const unit = placeGround(stores.workbench, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    confirmConsensus(stores.session)
    // 步进到移动段（有界循环，避免依赖步数正好是几）
    for (let i = 0; i < 12 && stores.session.records?.phase !== 'movement'; i += 1)
      stores.session.stepNow()
    expect(stores.session.records?.phase).toBe('movement')
    expect(stores.workbench.segmentLocked).toBe(false)
    expect(stores.workbench.phase).toBe('movement')
    stores.workbench.clickHex(CORE_HEX)
    expect(stores.workbench.confirmMovePick()).toBe(true)
    expect(stores.workbench.groupReachable.hexes.length).toBeGreaterThan(0)
    expect(unit.hex).toEqual(CORE_HEX) // 只是选中并进入移动，尚未落子
  })

  it('无会话 ⇒ 不锁（未开局仍可独立演练，保住联调④的口径）', () => {
    const stores = boot()
    expect(stores.session.records).toBeNull()
    expect(stores.workbench.segmentLocked).toBe(false)
    const unit = placeGround(stores.workbench, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    stores.workbench.clickHex(CORE_HEX)
    expect(stores.workbench.confirmMovePick()).toBe(true)
    expect(stores.workbench.groupReachable.hexes.length).toBeGreaterThan(0)
    expect(unit.hex).toEqual(CORE_HEX)
  })
})

describe('联调⑦：口径固化——手动切段是**临时**的（第三套钟：SOP 步指针）', () => {
  it('手动切段 ⇒ 记录轨立即变；下一次步进 ⇒ 流程按自身步序写回，手动那次被覆盖', () => {
    const stores = boot()
    expect(stores.session.startGame()).toBe(true)
    confirmConsensus(stores.session)
    stores.session.stepNow()
    stores.session.stepNow()
    expect(stores.session.records?.phase).toBe('aircraftRefit')

    stores.workbench.setPhase('movement')
    expect(stores.session.records?.phase).toBe('movement')
    expect(stores.workbench.phase).toBe('movement')

    stores.session.stepNow()
    // 流程按自己的步序走 ⇒ 手动切的那一段不再保留
    expect(stores.session.records?.phase).not.toBe('movement')
    expect(stores.workbench.phase).toBe(stores.session.records?.phase)
  })
})

/* ────────────────────────────── ⑤ 地图覆盖层单一来源 ────────────────────────────── */

describe('联调⑤：地图「画什么 + 点什么」只有一份实现（两个视图共用 mapView）', () => {
  it('`mapView.overlay` 就是完整那份（含突袭 / 撤退 / 推进 / 付款源 / 9.14 位移）', () => {
    const stores = boot()
    const overlay = stores.mapView.overlay
    // 这些字段是「共享覆盖层」相对旧操作台内联副本**多**出来的部分：
    // 少了它们，操作台点同一格就不会发起突袭 / 定撤退落点 / 选位移落点 —— 两个视图行为分叉。
    expect(overlay).toHaveProperty('overrunTargets')
    expect(overlay).toHaveProperty('retreat')
    expect(overlay).toHaveProperty('advance')
    expect(overlay).toHaveProperty('payDumps')
    expect(overlay).toHaveProperty('specialDisplace')
    expect(overlay).toHaveProperty('refitPay')
    // 以及两个视图原本就有、必须继续有的基础项
    expect(overlay).toHaveProperty('tokens')
    expect(overlay).toHaveProperty('reachable')
    expect(overlay).toHaveProperty('path')
    expect(overlay).toHaveProperty('setupCandidates')
  })

  it('源码守卫：两个视图都走 `mapView.overlay` + `mapView.onHexClick`，操作台不再自带副本', () => {
    for (const view of ['src/views/GameTableView.vue', 'src/views/WorkbenchView.vue']) {
      const code = stripComments(readSource(view))
      expect(code, `${view} 应消费共享覆盖层`).toContain('mapView.overlay')
      expect(code, `${view} 应走共享点选分派`).toContain('mapView.onHexClick')
      // 自带副本的标志：视图里再出现覆盖层裁剪函数或自建 overlay 计算
      expect(code, `${view} 不应再自带覆盖层裁剪`).not.toContain('fogVisibleTokens')
    }
    const workbenchCode = stripComments(readSource('src/views/WorkbenchView.vue'))
    expect(workbenchCode).not.toContain('const overlay = computed')
  })
})

/* ────────────────────────────── ⑥ 天气账本按当前剧本 ────────────────────────────── */

describe('联调⑥：容器抽取盒的天气账本按**当前剧本**取，不写死第一本剧本', () => {
  it('每个剧本的首回合空中条件都与该剧本数据一致（无会话时的本地账本）', () => {
    const stores = boot()
    for (const scenario of scenarios.scenarios) {
      expect(stores.containers.setScenario(scenario.id)).toBe(true)
      const expectedAir = scenario.firstWeather === 'restricted' ? 'limited' : 'normal'
      expect(stores.containers.weather.air, `剧本 ${scenario.id}`).toBe(expectedAir)
      expect(stores.containers.weather.ground).toBe('good') // 专规 1.5：本作地面恒为 good
    }
  })

  it('重置账本后仍按当前剧本取天气（不退回第一本）', () => {
    const stores = boot()
    const last = scenarios.scenarios[scenarios.scenarios.length - 1]!
    expect(stores.containers.setScenario(last.id)).toBe(true)
    stores.containers.resetContainers()
    const expectedAir = last.firstWeather === 'restricted' ? 'limited' : 'normal'
    expect(stores.containers.weather.air).toBe(expectedAir)
  })
})
