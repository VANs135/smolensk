import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'

import { useContainersStore, useHotseatStore, useSetupStore, useWorkbenchStore } from '@/stores'

/**
 * 阵营隔离（用户 2026-11-18 实盘返修）
 *
 * 上版只收了「盒内动作」面板一处，实盘里**盒表**仍把轴心盒摆在苏军玩家面前，
 * 且苏军盒被挤到裁切区里点不开。口径：
 *   · 玩家态所有列盒子的位置只出现视角方盒 + 共用盒（`side === null`）；
 *   · 对方盒的条目 / 内容 / 右键菜单不出现、也不可展开；
 *   · 切方时，原先展开的对方盒立即收起（不能靠"旧展开态"继续操作）。
 */

function stores() {
  setActivePinia(createPinia())
  useSetupStore().enterSetup('Intro')
  const workbench = useWorkbenchStore()
  const hotseat = useHotseatStore()
  const containers = useContainersStore()
  return { workbench, hotseat, containers }
}

const read = (path: string): string => readFileSync(path, 'utf8')

describe('盒表阵营隔离', () => {
  it('★ 盒表只渲染视角方一列（苏军看不到轴心列，反之亦然）', () => {
    const tray = read('src/components/game/BottomTray.vue')
    expect(tray).toContain('containers.cardViewsOf(hotseat.viewerSide)')
    expect(tray).not.toContain("v-for=\"side in ['axis', 'soviet'] as const\"")
    expect(tray).not.toContain('cardsBySide')
  })

  it('★ 盒表盘点角标也只算视角方 + 共用（不能泄露对方数量）', () => {
    const tray = read('src/components/game/BottomTray.vue')
    expect(tray).toContain('...sideCards.value.flatMap')
    expect(tray).not.toContain('cardsBySide.value.axis')
    expect(tray).not.toContain('cardsBySide.value.soviet')
  })

  it('★ solo / 裁判页没有对手 ⇒ 两方盒都列（与盒面板同口径）', () => {
    const tray = read('src/components/game/BottomTray.vue')
    expect(tray).toContain('hotseat.fogDisabled')
    expect(tray).toContain('showsAllSides.value')
    expect(tray).toContain("['axis', 'soviet']")
  })

  it('★ 盒内动作面板按视角方取盒（actions 也不跟行动方吃对方盒）', () => {
    const panel = read('src/components/containers/ContainersPanel.vue')
    expect(panel).toContain('boxesForViewer(containers.boxes, sideNow)')
    expect(panel).toContain('hotseat.viewerSide')
    expect(panel).not.toContain("props.only === 'actions' || props.subjectId != null")
  })

  it('★ 切方即收起对方盒的展开态与浮窗（不可借旧状态继续操作）', async () => {
    const { containers, hotseat } = stores()
    hotseat.setViewerSide('axis')
    containers.toggleCardOpen('axis-dead-pile')
    containers.setPopupCard('axis-dead-pile')
    expect(containers.cardOpenId).toBe('axis-dead-pile')
    expect(containers.popupCardId).toBe('axis-dead-pile')

    hotseat.setViewerSide('soviet')
    await nextTick()
    expect(containers.cardOpenId).toBeNull()
    expect(containers.popupCardId).toBeNull()
  })

  it('★ 共用盒（side=null）切方后仍可展开', async () => {
    const { containers, hotseat } = stores()
    hotseat.setViewerSide('axis')
    containers.toggleCardOpen('rail-sea-cap')
    expect(containers.cardOpenId).toBe('rail-sea-cap')
    hotseat.setViewerSide('soviet')
    await nextTick()
    expect(containers.cardOpenId).toBe('rail-sea-cap')
  })

  it('★ 展开段不再被裁切（打开段按内容伸展，点得到下面的卡）', () => {
    const tray = read('src/components/game/BottomTray.vue')
    // 2026-11-25：托盘常驻地图下方 ⇒ 展开态由自身限高并整段滚动（不再靠抽屉滚动兜住裁切）
    expect(tray).toMatch(/\.tray--open\s*\{[^}]*max-height:[^}]*overflow:\s*auto/s)
    // 展开的卡面不得再被压成 basis 0（那正是"苏军盒点不开"的旧根因）
    expect(tray).not.toMatch(/\.tray__section--open/)
  })
})
