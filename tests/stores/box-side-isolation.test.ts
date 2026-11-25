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
  it('★ 左栏盒组只渲染视角方（苏军看不到轴心列，反之亦然）', () => {
    const rail = read('src/components/game/box-rail.ts')
    // 2026-11-26：入口从底部托盘搬进左栏 ⇒ 隔离口径必须原样跟着走
    expect(rail).toContain('[hotseat.viewerSide]')
    expect(rail).toContain('containers.cardViewsOf(side)')
    expect(rail).not.toContain("v-for=\"side in ['axis', 'soviet'] as const\"")
    expect(rail).not.toContain('cardsBySide')
  })

  it('★ 盒卡挂载 / 浮窗只覆盖视角方 + 共用（不能泄露对方数量）', () => {
    const rail = read('src/components/game/box-rail.ts')
    // 挂载清单由同一份分组派生 ⇒ 视角方 + 共用，两张卡表都从这里来
    expect(rail).toContain('groups.value.flatMap')
    expect(rail).not.toContain('cardsBySide.value.axis')
    expect(rail).not.toContain('cardsBySide.value.soviet')
  })

  it('★ solo / 裁判页没有对手 ⇒ 两方盒都列（与盒面板同口径）', () => {
    const rail = read('src/components/game/box-rail.ts')
    expect(rail).toContain('hotseat.fogDisabled')
    expect(rail).toContain('showsAllSides.value')
    expect(rail).toContain("['axis', 'soviet']")
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
    expect(containers.cardOpenId).toBe('axis-dead-pile')
    // 2026-11-26：浮窗就是"展开"，两者互斥（开浮窗 ⇒ cardOpenId 归 null）
    containers.setPopupCard('axis-dead-pile')
    expect(containers.cardOpenId).toBeNull()
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

  it('★ 盒窗不再被裁切（浮窗自限高并整段滚动，点得到整张贴图）', () => {
    const card = read('src/components/game/BoxCard.vue')
    // 2026-11-26：托盘删除后盒窗改由 BoxCard 自己 Teleport 成浮窗 ⇒ 限高与滚动跟着它
    expect(card).toMatch(/\.boxpopup\s*\{[^}]*max-height:[^}]*overflow:\s*auto/s)
    // 浮窗必须居中锚定（只写 left:50% 会把 720 宽的窗推到视口外）
    expect(card).toContain('translateX(-50%)')
    expect(card).not.toMatch(/\.tray__section--open/)
  })

  it('★ 浮窗即"展开"：盒内动作判据认 popupCardId（托盘删掉后这些能力不能被带走）', () => {
    const store = read('src/stores/containers.ts')
    expect(store).toContain(
      'const focusedCardId = computed<string | null>(() => popupCardId.value ?? cardOpenId.value)',
    )
    // 五处判据（管哪些盒 / 卡名 / 卡方 / 要不要开盒内动作窗 / 能否拆分取用）都改读焦点卡；
    // 只剩切方清理那一处还直接读 `cardOpenId`
    const rawReads = store.split('const id = cardOpenId.value').length - 1
    expect(rawReads).toBe(1)
  })

  it('★ 浮窗打开地图外盒后，拆分取用那条"显式请求 → 盒内动作窗"仍可走通', () => {
    const { containers } = stores()
    expect(containers.openCardNeedsWindow).toBe(false)

    containers.setPopupCard('axis-offboard')
    expect(containers.openCardSide).toBe('axis')
    // 地图外盒不"开浮窗就弹窗"，要贴图上那枚按钮显式请求
    expect(containers.openCardNeedsWindow).toBe(false)
    expect(containers.requestCardWindow()).toBe(true)
    expect(containers.openCardNeedsWindow).toBe(true)

    containers.setPopupCard(null)
    expect(containers.openCardNeedsWindow).toBe(false)
  })

  it('★ 浮窗打开死亡堆 ⇒ 盒内动作只给死亡堆那几个盒（过滤跟着焦点卡走）', () => {
    const { containers } = stores()
    containers.setPopupCard('axis-dead-pile')
    expect(containers.openCardBoxKinds).toContain('deadPile')
    expect(containers.openCardName).toBe('轴心死人堆')
    containers.setPopupCard(null)
    expect(containers.openCardBoxKinds).toBeNull()
  })

  it('★ 共用运力记录轨：开浮窗不顶出会话框（卡面本身就是那两条轨）', () => {
    const { containers } = stores()
    containers.setPopupCard('rail-sea-cap')
    expect(containers.openCardNeedsWindow).toBe(false)
    containers.setPopupCard(null)
    expect(containers.openCardNeedsWindow).toBe(false)
  })
})
