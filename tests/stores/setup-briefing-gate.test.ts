import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useHotseatStore, useSetupStore } from '@/stores'

/**
 * 进初设前的目标窗闸门（用户 2026-11-18 第 1 条）
 *
 * 口径：
 *   · 剧本选好后先弹「任务目标 / 胜利条件」窗，**确认后才进初设**；
 *   · 一个入口、每个剧本每局只弹一次（不额外弹第二遍）；
 *   · 关窗＝取消，不落盘；换剧本 / 重开一局重新弹。
 *
 * 闸门放在 store 而不是视图里：`enterSetup` 仍是对其他调用方的既有语义，
 * 目标窗走 `requestEnterSetup → confirmBriefing` 这一条新入口。
 */
const fresh = () => {
  setActivePinia(createPinia())
  const hotseat = useHotseatStore()
  hotseat.setMode('solo')
  return { hotseat, setup: useSetupStore() }
}

describe('目标窗闸门：requestEnterSetup / confirmBriefing', () => {
  let stores: ReturnType<typeof fresh>

  beforeEach(() => {
    stores = fresh()
  })

  it('模式未选齐 ⇒ blocked，不挂窗也不进初设', () => {
    setActivePinia(createPinia())
    const setup = useSetupStore()

    expect(setup.requestEnterSetup('1')).toBe('blocked')
    expect(setup.briefingPendingId).toBeNull()
    expect(setup.applied).toBe(false)
    expect(setup.lastAction?.ok).toBe(false)
  })

  it('★未确认 ⇒ 只挂窗、不进初设；确认后才进初设并关窗', () => {
    const { setup } = stores

    expect(setup.requestEnterSetup('1')).toBe('briefing')
    expect(setup.briefingPendingId).toBe('1')
    expect(setup.applied).toBe(false)

    expect(setup.confirmBriefing()).toBe(true)
    expect(setup.briefingPendingId).toBeNull()
    expect(setup.applied).toBe(true)
  })

  it('同一剧本再进 ⇒ 不再弹第二遍，直接进初设', () => {
    const { setup } = stores

    expect(setup.requestEnterSetup('1')).toBe('briefing')
    expect(setup.confirmBriefing()).toBe(true)
    expect(setup.requestEnterSetup('1')).toBe('setup')
  })

  it('关窗＝取消：不落盘，可再次请求（仍会弹）', () => {
    const { setup } = stores

    expect(setup.requestEnterSetup('1')).toBe('briefing')
    setup.dismissBriefing()
    expect(setup.briefingPendingId).toBeNull()
    expect(setup.applied).toBe(false)

    expect(setup.requestEnterSetup('1')).toBe('briefing')
  })

  it('换剧本 ⇒ 新剧本重新弹窗', () => {
    const { setup } = stores

    expect(setup.requestEnterSetup('1')).toBe('briefing')
    expect(setup.confirmBriefing()).toBe(true)

    expect(setup.requestEnterSetup('3')).toBe('briefing')
    expect(setup.briefingPendingId).toBe('3')
  })

  it('重开一局 ⇒ 目标重新确认（新局不继承上一局的已确认标记）', () => {
    const { setup } = stores

    expect(setup.requestEnterSetup('1')).toBe('briefing')
    expect(setup.confirmBriefing()).toBe(true)

    expect(setup.restartGameNow()).toBe(true)
    expect(setup.requestEnterSetup('1')).toBe('briefing')
  })
})
