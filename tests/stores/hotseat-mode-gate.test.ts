import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useHotseatStore } from '@/stores'

/**
 * 读档后「对局模式」闸门：**选完单选不能自己消失**（2026-11-15 对局台实点）
 *
 * 现场：读一份没记 `hotseat` 的档 ⇒ `mode=null`、`setupLocked=false`，棋桌弹出「这一档没有记录
 * 对局模式」。点一个单选后 `modeIssue` 立刻变 null，闸门按 `modeIssue !== null` 判断就自己关了 ——
 * 「确认并继续」（`lockMode()`）永远点不到，`setupLocked` 停在 false，之后仍可随时改组织方式。
 *
 * 口径（本文件钉住）：闸门开着的唯一条件是「模式没选齐 **或** 还没确认锁定」；
 * 选定 ≠ 确认，必须点一次「确认并继续」才算过闸。
 */
describe('读档后的对局模式闸门', () => {
  function boot() {
    setActivePinia(createPinia())
    return useHotseatStore()
  }

  it('★ 选完单选后闸门仍在，点「确认并继续」才关（修前选完即消失）', () => {
    const hotseat = boot()
    hotseat.restoreFromSave(undefined)
    expect(hotseat.modeGateNeeded).toBe(true)

    expect(hotseat.setMode('solo')).toBe(true)
    expect(hotseat.modeIssue).toBeNull()
    // 修前视图只看 modeIssue ⇒ 这里已经是 false，面板先没了
    expect(hotseat.modeGateNeeded).toBe(true)

    hotseat.lockMode()
    expect(hotseat.modeGateNeeded).toBe(false)
  })

  it('档里记了模式 ⇒ 读回即锁定，闸门不出现', () => {
    const hotseat = boot()
    hotseat.restoreFromSave({ mode: 'pvp' })
    expect(hotseat.modeIssue).toBeNull()
    expect(hotseat.modeGateNeeded).toBe(false)
  })

  it('PVE 选了却没指定 AI 方 ⇒ 闸门仍开着', () => {
    const hotseat = boot()
    hotseat.restoreFromSave(undefined)
    expect(hotseat.setMode('pve')).toBe(true)
    expect(hotseat.modeGateNeeded).toBe(true)
    expect(hotseat.setAiSide('soviet')).toBe(true)
    expect(hotseat.modeGateNeeded).toBe(true)
    hotseat.lockMode()
    expect(hotseat.modeGateNeeded).toBe(false)
  })

  it('源码守卫：棋桌的闸门读 store 的唯一判据，不在视图里另写 modeIssue', () => {
    const view = readFileSync('src/views/GameTableView.vue', 'utf8')
    expect(view).toContain('hotseat.modeGateNeeded')
    expect(view).not.toContain('hotseat.modeIssue !== null')
  })
})
