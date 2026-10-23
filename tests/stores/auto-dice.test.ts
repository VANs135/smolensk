import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

/**
 * B28：**随机数一律自动结算**（用户口径 2026-09-16 #9）
 *
 * 「**所有的随机数抽取一律自动结算**，需要玩家介入选择的才需要打开一个该事件选择的会话框」。
 *
 * 做法分两半，本文件各钉一半：
 *   ① **界面**上没有手填骰面了（源码守卫：那几处输入不存在），
 *      且需要"掷"的动作在**零输入**下能走通（行为用例）；
 *   ② **store 里那些字段保留**（验证页与既有测试用它们指定骰面）—— 这叫"把测试口留着"，
 *      不是"把规则口留着"：正式界面的入口已经撤掉。
 *
 * 方向是"自动"⇒ 骰面来自种子化 `rng`，可在结算日志里复算（`drawCount` 会随每次掷骰 +1）。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

const HEX: HexRef = { col: 36, row: 13 }

/** 轴方一枚战斗单位（当"要被损耗/被结算"的对象用） */
const combatRecord = () =>
  unitChoices('axis').find((record) => record.isCombat === true && record.attackCapable === true)!

describe('B28：零输入也能结算（12.11a 销毁补给站）', () => {
  it('★ 不传骰面、不传销毁量 ⇒ 自动掷 + 全额销毁，且账本照记', () => {
    const store = newStore()
    store.setPhase('movement')
    store.spDumpDraft = { hexText: `${HEX.col}.${HEX.row}`, sp: 2, t: 0 }
    store.addSpDump()
    const dumpId = store.spDumps[0]!.id
    const drawsBefore = store.drawCount

    // B28：**一个参数都不传**（修前两个都是必填）
    expect(store.destructDumpNow(dumpId)).toBe(true)

    // 掷骰计数 +1（骰面走种子化 RNG）；每阶段每站一次的账本照记
    expect(store.drawCount).toBeGreaterThan(drawsBefore)
    expect(store.dumpDestructionAttempts[dumpId] ?? 0).toBe(1)
    // 12.11a：只销毁 SP（该站 2 SP；掷骰决定百分比，1–6 分别 25/50/50/75/75/100%）
    const after = store.spDumps.find((dump) => dump.id === dumpId)!
    expect(after.sp).toBeLessThanOrEqual(2)
  })

  it('★ 给了骰面与销毁量 ⇒ 仍按给定值结算（验证页/复算用；界面已不提供输入）', () => {
    const store = newStore()
    store.setPhase('movement')
    store.spDumpDraft = { hexText: `${HEX.col}.${HEX.row}`, sp: 4, t: 0 }
    store.addSpDump()
    const dumpId = store.spDumps[0]!.id

    // 骰面 6 ⇒ 100% 销毁；请求 8 T（＝2 SP 的吨位）⇒ 只销毁请求量
    expect(store.destructDumpNow(dumpId, 8, 6)).toBe(true)
    const after = store.spDumps.find((dump) => dump.id === dumpId)!
    expect(after.sp).toBe(2)
  })
})

describe('B28：界面上的手填骰面已撤（源码守卫）', () => {
  const diceInputFields = [
    'workbench.airInputs.interceptDie',
    'workbench.airInputs.interceptLossDie',
    'workbench.airInputs.flakDie',
    'workbench.airInputs.lossDie',
    'workbench.barrageInputs.halfDie',
    'workbench.barrageInputs.die',
    'workbench.variableReplInputs.specialDie',
    'workbench.variableReplInputs.variableExitDie',
    'workbench.variableReplInputs.supplyDice',
    'workbench.variableReplInputs.replDice',
    'workbench.variableReplInputs.randomEventDice',
  ]
  const panels = [
    'src/components/air/AirPanel.vue',
    'src/components/barrage/BarragePanel.vue',
    'src/components/reinforcement/ReinforcementPanel.vue',
    'src/components/supply/SupplyPanel.vue',
  ]

  it('★ 四个面板里**没有任何**骰面输入（`v-model*.number` 绑到骰面字段）', () => {
    for (const file of panels) {
      const text = readFileSync(file, 'utf8')
      for (const field of diceInputFields) {
        expect(text, `${file} 仍绑着骰面输入：${field}`).not.toContain(`v-model.number="${field}"`)
      }
    }
  })

  it('★ 销毁补给站：骰面输入没了，销毁量留空＝全部', () => {
    const text = readFileSync('src/components/supply/SupplyPanel.vue', 'utf8')
    expect(text).not.toContain('v-model.number="destroyDie"')
    expect(text).toContain('留空＝全部 SP')
    expect(text).toContain('workbench.destructDumpNow(destroyDumpId, destroyT ?? undefined)')
  })

  it('★ store 侧的骰面字段**保留**（验证页与既有用例仍要指定骰面）', () => {
    const store = readFileSync('src/stores/workbench.ts', 'utf8')
    expect(store).toContain('interceptDie')
    expect(store).toContain('flakDie')
    expect(store).toContain('halfDie')
    expect(store).toContain('function drawDumpDestructionDie(')
  })

  it('★ 需要"掷"的动作在界面上都有一句话说明"自动结算"（不让玩家找输入框）', () => {
    const barrage = readFileSync('src/components/barrage/BarragePanel.vue', 'utf8')
    expect(barrage).toContain('掷骰自动结算')
    const reinf = readFileSync('src/components/reinforcement/ReinforcementPanel.vue', 'utf8')
    expect(reinf).toContain('骰面自动（')
  })
})

describe('B28：可变增援零输入也能掷（1.6b / 1.6c / 3.3c / 3.6）', () => {
  it('★ 不填任何骰面 ⇒ 一并按种子化 RNG 掷出结果', () => {
    const store = newStore()
    store.setPhase('reinforcement')
    const unit = toConsoleUnit({
      record: combatRecord(),
      instanceId: 'u1',
      hex: HEX,
      side: 'axis',
    })
    store.units.push(unit)

    // B28：骰面字段仍是缺省值，但 `autoRoll` 默认 true ⇒ 一律现掷（不再由界面驱动）
    expect(store.variableReplInputs.autoRoll).toBe(true)
    const drawsBefore = store.drawCount
    store.rollVariableReplNow()
    expect(store.drawCount).toBeGreaterThan(drawsBefore)
  })
})
