import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useHotseatStore, useSetupStore, useWorkbenchStore } from '@/stores'

/**
 * 视角方默认值跟玩家阵营（用户 2026-11-18 实盘返修）
 *
 * 实盘：玩家玩苏军，进对局后「看苏联 / 看轴心国」仍默认**看轴心国**——
 * 盒表再按视角方过滤，就等于「苏军玩家看到轴心盒」；这也是盒子那条的根因。
 *
 * 口径：
 *   · PVE：玩家执 **AI 的另一方** ⇒ 视角默认＝玩家方；
 *   · PVP（热座）/ solo：没有唯一玩家方 ⇒ 默认跟**行动方**（说明：4.9a 只约束对手；
 *     热座双方轮流行动，跟行动方最不误导，且玩家仍可手动切）；
 *   · 裁判/验证页：看全（不靠视角过滤）；
 *   · 换执方 / 换剧本 ⇒ 视角随之重算，不留上一局旧值。
 */

function stores() {
  setActivePinia(createPinia())
  const workbench = useWorkbenchStore()
  const hotseat = useHotseatStore()
  return { workbench, hotseat }
}

describe('视角方默认值：跟玩家阵营', () => {
  it('★ PVE：AI 执轴心 ⇒ 玩家视角默认苏联', () => {
    const { hotseat } = stores()
    hotseat.setMode('pve')
    expect(hotseat.setAiSide('axis')).toBe(true)
    expect(hotseat.playerSide).toBe('soviet')
    expect(hotseat.viewerSide).toBe('soviet')
  })

  it('★ PVE：AI 执苏联 ⇒ 玩家视角默认轴心', () => {
    const { hotseat } = stores()
    hotseat.setMode('pve')
    expect(hotseat.setAiSide('soviet')).toBe(true)
    expect(hotseat.viewerSide).toBe('axis')
  })

  it('★ 换执方 ⇒ 视角跟着换，不留上一局旧值', () => {
    const { hotseat } = stores()
    hotseat.setMode('pve')
    hotseat.setAiSide('axis')
    expect(hotseat.viewerSide).toBe('soviet')
    hotseat.setAiSide('soviet')
    expect(hotseat.viewerSide).toBe('axis')
  })

  it('★ PVP（热座）：没有唯一玩家方 ⇒ 默认跟行动方', () => {
    const { hotseat, workbench } = stores()
    workbench.setActiveSide('soviet')
    hotseat.setViewerSide('axis')
    hotseat.setMode('pvp')
    expect(hotseat.playerSide).toBeNull()
    expect(hotseat.viewerSide).toBe('soviet')
  })

  it('★ solo：无对手 ⇒ 默认跟行动方（双方内容都可见）', () => {
    const { hotseat, workbench } = stores()
    workbench.setActiveSide('axis')
    hotseat.setViewerSide('soviet')
    hotseat.setMode('solo')
    expect(hotseat.fogDisabled).toBe(true)
    expect(hotseat.viewerSide).toBe('axis')
  })

  it('★ 尚未选模式 ⇒ 不凭空改写视角', () => {
    const { hotseat } = stores()
    hotseat.setViewerSide('soviet')
    expect(hotseat.defaultViewerSide()).toBeNull()
    hotseat.syncViewerToDefault()
    expect(hotseat.viewerSide).toBe('soviet')
  })

  it('★ 换剧本 ⇒ 视角按默认值重算（PVE 仍跟玩家方）', () => {
    setActivePinia(createPinia())
    const setup = useSetupStore()
    const hotseat = useHotseatStore()
    hotseat.setMode('pve')
    hotseat.setAiSide('axis')
    hotseat.setViewerSide('axis') // 上一局留下的错误视角
    setup.selectScenario('Intro')
    expect(hotseat.viewerSide).toBe('soviet')
  })

  it('★ 读档：PVE 档回到玩家方（不是档内行动方）', () => {
    const { hotseat, workbench } = stores()
    workbench.setActiveSide('axis')
    hotseat.restoreFromSave({ mode: 'pve', aiSide: 'axis' })
    expect(hotseat.viewerSide).toBe('soviet')
  })
})
