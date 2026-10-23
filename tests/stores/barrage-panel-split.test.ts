import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { mapLayers } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  aircraftChoices,
  toConsoleAirUnit,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
} from '@/stores'

/**
 * H②（用户 2026-09-18 报的第 3 条）：**炮兵与空军的轰炸结算页必须分开**
 *
 * 用户原话：「空军和炮兵的轰炸结算页面一定要分开，目前**炮兵轰炸时结算页面上还有空军**」。
 * 规则依据：**10.0e-F** 一次轰炸只能用**同一类型**；**10.2c** 空军轰炸**没有补给消耗**；
 * **14.7b** 空军轰炸按 10.2 结算（短程 +1 列、最多 4 机）。
 *
 * ## 修前的病灶
 *   `BarragePanel.vue` 里"参炸飞机"那一整块（说明 / 摆放 / 参炸机阵列 / 卸下）**没有任何
 *   `barrageKind` 条件**（`barrageKind` 全文只在下拉里出现一次），从宣布到战果确认全程渲染；
 *   反过来，**炮兵的单位阵列**与**付款补给站**在空军轰炸时也照旧显示（10.2c 明明免补给）。
 *   store 侧两份候选（`barrageUnitChoices` 火炮 / `barrageAirCandidates` 参炸机）同样不看类别。
 *
 * ## 测法边界（如实交代）
 *   · **本仓库没有组件渲染测试** ⇒ "页面上不再出现空军"这条由**源码守卫**（那一块包在
 *     `v-if="barrageKind === 'air'"` 里）＋ **store 候选按类别收口**（行为用例）两路共同钉住；
 *   · 行为用例只问"候选是不是按类别给"（10.0e-F 的界面侧口径），不重复引擎的混类拒绝（10.0e-F 有既有用例）。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

const CORE_HEX: HexRef = (() => {
  const found = mapLayers.hexes
    .map((hex) => ({ col: hex.col, row: hex.row }))
    .find((ref) =>
      HEX_DIRECTIONS.every((direction) => {
        const candidate = neighbor(ref, direction)
        return (
          isOnMap(candidate) &&
          mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
        )
      }),
    )
  if (found === undefined) throw new Error('地图上找不到六邻皆图内的格')
  return found
})()

/** 有印刷轰炸值的轴方机（10.2：能参炸的空军） */
function bomberRecord() {
  const found = aircraftChoices('axis').find((record) => (record.barrageStrength ?? 0) > 0)
  if (found === undefined) throw new Error('轴方飞机库里没有可轰炸的机')
  return found
}

/** 有印刷轰炸值的轴方地面单位（13.4：炮兵） */
function artilleryRecord() {
  const found = unitChoices('axis').find((record) => (record.factors?.combat?.barrage ?? 0) > 0)
  if (found === undefined) throw new Error('轴方单位库里没有带轰炸值的地面单位')
  return found
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('H②：轰炸结算页按类别分家（10.0e-F）', () => {
  it('★ 类别＝炮兵 ⇒ 空军候选为空；类别＝空军 ⇒ 火炮候选为空（两份候选都按类别收口）', () => {
    const store = newStore()
    store.setBarrageActive(true)
    // 场上同时有火炮与可轰炸的飞机（各一枚）
    store.units.push(
      toConsoleUnit({
        record: artilleryRecord(),
        instanceId: 'gun-1',
        hex: CORE_HEX,
        side: 'axis',
      }),
    )
    store.airUnits.push(
      toConsoleAirUnit({
        aircraft: bomberRecord(),
        instanceId: 'bmb-1',
        hex: CORE_HEX,
        side: 'axis',
        airStatus: 'active',
      }),
    )

    store.setBarrageKind('artillery')
    expect(store.barrageUnitChoices.map((item) => item.unit.instanceId)).toContain('gun-1')
    expect(store.barrageAirCandidates).toEqual([])
    expect(store.barrageAirChoices).toEqual([])

    store.setBarrageKind('air')
    expect(store.barrageAirCandidates.map((item) => item.instanceId)).toContain('bmb-1')
    expect(store.barrageUnitChoices).toEqual([])
  })

  it('★ 源码守卫：面板里"参炸飞机"整块包在 `barrageKind === \'air\'` 里，火炮阵列与付款站在 artillery 里', () => {
    const panel = readFileSync('src/components/barrage/BarragePanel.vue', 'utf8')
    // 空军那一块：从 v-if 到它自己的 </template> 之间必须含机型阵列、基地格输入、参炸机阵列与卸下
    const airGate = panel.indexOf(`v-if="workbench.barrageKind === 'air'"`)
    expect(airGate).toBeGreaterThanOrEqual(0)
    const airBlock = panel.slice(airGate, panel.indexOf('</template>', airGate))
    expect(airBlock).toContain('aircraftItems')
    expect(airBlock).toContain('airPlacement.hexText')
    expect(airBlock).toContain('barrageAirItems')
    expect(airBlock).toContain('barrageAirCandidates')
    // 火炮那一块：参炸单位阵列与付款补给站都必须在 artillery 分支里
    const gunGate = panel.indexOf(`v-if="workbench.barrageKind === 'artillery'"`)
    expect(gunGate).toBeGreaterThanOrEqual(0)
    const gunBlock = panel.slice(gunGate, panel.indexOf('</template>', gunGate))
    expect(gunBlock).toContain('barrageUnitItems')
    // 付款补给站那一段单独包了一层（10.2c：空军免补给 ⇒ 不给这座站的阵列）
    const dumpGate = panel.indexOf(`v-if="workbench.barrageKind === 'artillery'"`, gunGate + 1)
    expect(dumpGate).toBeGreaterThan(gunGate)
    expect(panel.slice(dumpGate, panel.indexOf('</template>', dumpGate))).toContain('dumpItems')
  })
})
