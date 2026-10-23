import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { ACTION_GATES, ACTION_KEYS_WITHOUT_STORE_ENTRY, type ActionKey } from '@/stores'

/**
 * B8：闸门**接线覆盖**（源码守卫）
 *
 * B7 给了闸门表，但表本身不拦任何东西——**每个动作族都要在 store 里有真正的入口**
 * （`requireAction('<key>', …)`），否则"阶段隔离"只是纸面约束。故本文件用源码守卫
 * （与 `tests/stores/integration-sync.test.ts` 同一套路）核对：
 *
 *   ① 闸门表里的每个键，要么在 **store 层**里有 `requireAction('<key>'` 调用，
 *      要么明确登记在"无 store 入口"（实现缺口）或"待接线"（本批尚未轮到）里；
 *   ② 两个清单互不重叠，且**待接线**清单随每小批缩小（B8 收尾时必须清空 ⇒ 那时删掉这个常量）。
 *
 * 为什么用源码文本而不是运行时探针：这些动作大多需要真实盘面才能触发，逐个构造夹具既慢又脆；
 * 而"这个键有没有接线"是一个**结构性**事实，看源码最直接（且改错文件名/键名会立刻红）。
 *
 * ★ 批 E 切片 2：扫描面从 `workbench.ts` **扩大**到 `src/stores/` 下**全部 .ts**
 *   —— 入口可以合法地落在兄弟 store 里（例：`containers.drawAndApplyStepNow()` 就是
 *   `rein.formationDraw` 的入口，闸门仍走 `workbench.requireAction`）。判据未放宽：
 *   键仍然必须在 store 层被消费一次。
 */

const STORE_DIR = 'src/stores'

/** store 层全部源码（拼在一起扫；键名带引号，不会跨文件误配） */
const storeSource = readdirSync(STORE_DIR)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => readFileSync(`${STORE_DIR}/${name}`, 'utf8'))
  .join('\n')

/**
 * 待接线（B8 分四小批推进；每完成一小批删一条）
 *
 * B8-1 已完成：`air.refit` / `rein.arrival` / `rein.rebuild` / `rein.frontalReserves`
 * （★ 20.0d 的"吸收"**不在此列**：它按条文是段末强制收束，不是环节动作）
 */
const PENDING_WIRING: readonly ActionKey[] = [
  // B8-2（C 段；★ 突围 12.8e 无 store 入口 ⇒ 已在 ACTION_KEYS_WITHOUT_STORE_ENTRY 里登记）
  'move.modeChange',
  'move.order',
  'move.overrun',
  'move.railTransport',
  'move.railConversion',
  'move.loadUnload',
  'move.construction',
  'move.hedgehog',
  'move.breakdown',
  'move.dumpBlow',
  'air.baseReduce',
]

/** 该键在源码里出现的 `requireAction('<key>'` 次数 */
/*
 * B37：除了 `requireAction('key', …)`，还有一类接线是**经闸门查询消费**：
 *   `allowedActionsOf(segmentGateQuery.value).has('key')`（界面据此显示/隐藏，store 据此判定时机）。
 * 这类同样是"键真的被用着" ⇒ 守卫两种写法都算（要求没有放宽：键仍必须在源码里被消费一次）。
 */
function wiredCount(key: ActionKey): number {
  return (
    storeSource.split(`requireAction('${key}'`).length -
    1 +
    // B37：经闸门查询消费（store 里 `allowedActionsOf(...).has(key)`）也算接线
    storeSource.split(`has('${key}')`).length -
    1
  )
}

describe('B8：闸门接线覆盖（源码守卫）', () => {
  it('闸门表的每个键都被"接线 / 待接线 / 无入口"三者之一覆盖（不留悬空键）', () => {
    const missing = ACTION_GATES.map((gate) => gate.key).filter(
      (key) =>
        wiredCount(key) === 0 &&
        !PENDING_WIRING.includes(key) &&
        !ACTION_KEYS_WITHOUT_STORE_ENTRY.includes(key),
    )
    expect(missing, '这些键既没接线、也没登记原因').toEqual([])
  })

  it('已接线的键确实有调用点（防"清单说接了、源码里没有"）', () => {
    const notWired = ACTION_GATES.map((gate) => gate.key).filter(
      (key) => wiredCount(key) === 0 && !ACTION_KEYS_WITHOUT_STORE_ENTRY.includes(key),
    )
    // 未接线的必须都在待接线清单里
    for (const key of notWired) {
      expect(PENDING_WIRING, `${key} 未接线却不在待接线清单`).toContain(key)
    }
  })

  it('"待接线"与"无 store 入口"两份清单互不重叠', () => {
    for (const key of PENDING_WIRING) {
      expect(ACTION_KEYS_WITHOUT_STORE_ENTRY, `${key} 同时出现在两份清单里`).not.toContain(key)
    }
  })

  it('无 store 入口的键**确实**没有调用点（清单不许虚报）', () => {
    for (const key of ACTION_KEYS_WITHOUT_STORE_ENTRY) {
      expect(wiredCount(key), `${key} 已有调用点，应从"无入口"清单里删掉`).toBe(0)
    }
  })

  it('已接线的键至少有一个调用点（B8-1 的四项抽查）', () => {
    for (const key of [
      'air.refit',
      'rein.arrival',
      'rein.rebuild',
      'rein.frontalReserves',
    ] as ActionKey[]) {
      expect(wiredCount(key), `${key} 应有调用点`).toBeGreaterThan(0)
      expect(PENDING_WIRING, `${key} 已接线，应从待接线清单里删掉`).not.toContain(key)
    }
  })
})
