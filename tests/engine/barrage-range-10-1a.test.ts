import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { beginBarrage, canBarrageAtRange } from '@/engine/rules'

/**
 * 第六批批 P0 切片 3（条 20 的引擎内核）：**10.1a 火炮射程**
 *
 * 原文（`_ocs_v43_clean.txt:1641-1643`）：
 *   「10.1a 火炮轰炸的射程以**格**为单位计算。射程**不受天气和地形影响**。
 *     射程为 '3' 的火炮单位可以对 1 到 3 个格上的目标进行轰炸。」
 *
 * 修前的病灶：`canBarrageAtRange` 早已写好，但**零调用**（`src/engine/rules/barrage.ts:283`
 *   只有定义与两处注释）⇒ 候选是"全图本方有印值炮"，1～2 射程的炮照样能炸 3 格外的目标。
 *   现在 `beginBarrage` 对每个**带射程**的参炸单位逐个校验，够不着即按 10.1a 拒。
 *
 * ## 测法边界（如实交代）
 *   · 纯引擎层：**不造盘面**，只喂 `distanceHexes` / `rangeHexes` 两个事实；
 *   · 只对**带 `rangeHexes` 的**单位生效（空军不带它 —— 它走 14.2d 的航程，另一条判据）；
 *   · 商店/UI 侧的"候选里标出够不着者"在 `tests/stores/barrage-phase-ledger-cross-segment.test.ts`
 *     之外的候选用例里；射程**交集高亮**属批 U，本切片不做。
 */

const HEX = { col: 36, row: 13 }

const artillery = (
  over: Partial<Parameters<typeof beginBarrage>[0]['units'][number]> = {},
): Parameters<typeof beginBarrage>[0]['units'][number] => ({
  unitId: 'art-1',
  printedValue: 8,
  ...over,
})

const declare = (
  over: Partial<Parameters<typeof beginBarrage>[0]> = {},
): ReturnType<typeof beginBarrage> =>
  beginBarrage({
    kind: 'artillery',
    phase: 'combat',
    targetKind: 'combatUnits',
    targetHex: HEX,
    units: [artillery()],
    ...over,
  })

describe('第六批 P0-3：10.1a 火炮射程（条 20）', () => {
  it('前提自检：`canBarrageAtRange` 的口径（射程自 1 格起，含端点）', () => {
    expect(canBarrageAtRange({ rangeHexes: 3, distanceHexes: 1 })).toBe(true)
    expect(canBarrageAtRange({ rangeHexes: 3, distanceHexes: 3 })).toBe(true)
    expect(canBarrageAtRange({ rangeHexes: 3, distanceHexes: 4 })).toBe(false)
    // 10.1a：射程自 **1 格**起 ⇒ 格距 0（自己所在的格）不算射程内
    expect(canBarrageAtRange({ rangeHexes: 3, distanceHexes: 0 })).toBe(false)
  })

  it('★ 射程 2 的炮打 3 格外的目标 ⇒ 拒，且给 10.1a', () => {
    const outcome = declare({ units: [artillery({ rangeHexes: 2, distanceHexes: 3 })] })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.rule).toBe('10.1a')
      expect(outcome.reason).toContain('artilleryOutOfRange')
      expect(outcome.reason).toContain('3>2')
    }
  })

  it('★ 同一门炮打 2 格（＝射程端点）⇒ 放行', () => {
    const outcome = declare({ units: [artillery({ rangeHexes: 2, distanceHexes: 2 })] })
    expect(outcome.ok).toBe(true)
  })

  it('★ 多门炮里**只要有 1 门够不着** ⇒ 整次宣布被拒（不取最好/最差那一枚敷衍）', () => {
    const outcome = declare({
      units: [
        artillery({ unitId: 'art-1', rangeHexes: 3, distanceHexes: 1 }),
        artillery({ unitId: 'art-2', rangeHexes: 1, distanceHexes: 3 }),
      ],
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.rule).toBe('10.1a')
      expect(outcome.reason).toContain('art-2')
    }
  })

  it('不带 `rangeHexes` 的参炸单位**不参与**该判据（空军走 14.2d 的航程，另有一条判据）', () => {
    const outcome = declare({ units: [artillery({ rangeHexes: undefined })] })
    expect(outcome.ok).toBe(true)
  })

  it('射程判据在 10.0e 的资格链**之前**（够不着就不该进入资格链）', () => {
    // 同一请求里既射程不够、又处于预备模式 ⇒ 先报 10.1a（不是 13.4a）
    const outcome = declare({
      units: [artillery({ rangeHexes: 1, distanceHexes: 5, inReserveOrStrat: true })],
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.rule).toBe('10.1a')
  })

  it('源码守卫：`beginBarrage` 真的调了 `canBarrageAtRange`（不再是零调用）', () => {
    const source = readFileSync('src/engine/rules/barrage-interaction.ts', 'utf8')
    const start = source.indexOf('export function beginBarrage(')
    const body = source.slice(start, start + 5000)
    expect(body).toContain('canBarrageAtRange(')
    expect(body).toContain("'10.1a'")
  })
})
