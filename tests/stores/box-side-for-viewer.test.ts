import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import {
  boxesForViewer,
  useContainersStore,
  useHotseatStore,
  useSetupStore,
  useWorkbenchStore,
} from '@/stores'

/**
 * 图外盒面板按**当前视角方**取盒（用户 2026-11-18）
 *
 * 缺陷：玩家当苏联方时，图外盒面板仍把轴心盒排在前面（面板取的是全量 `containers.boxes`），
 * 苏军自己的盒被挤到后面/裁掉，看起来像"只显示轴心盒"。
 * 口径：玩家态只取视角方的盒（共用盒 `side === null` 恒在）；裁判 / 验证页看全；
 * 切方后立即换边，不要求重开窗口。
 */

function stores() {
  setActivePinia(createPinia())
  useSetupStore().enterSetup('Intro')
  const workbench = useWorkbenchStore()
  const hotseat = useHotseatStore()
  const containers = useContainersStore()
  return { workbench, hotseat, containers }
}

describe('图外盒面板的阵营来源', () => {
  it('★ 苏联视角：只返回苏方盒（死亡堆 / 空军盒 / 地图外盒），不混轴心盒', () => {
    const { containers } = stores()
    const list = boxesForViewer(containers.boxes, 'soviet')
    expect(list.length).toBeGreaterThan(0)
    expect(list.some((box) => box.side === 'axis')).toBe(false)
    expect(list.every((box) => box.side === null || box.side === 'soviet')).toBe(true)
    expect(list.map((box) => box.kind)).toEqual(
      expect.arrayContaining(['deadPile', 'airBox', 'breakdownBox']),
    )
  })

  it('★ 轴心视角：只返回轴心盒，不混苏方盒', () => {
    const { containers } = stores()
    const list = boxesForViewer(containers.boxes, 'axis')
    expect(list.some((box) => box.side === 'soviet')).toBe(false)
    expect(list.every((box) => box.side === null || box.side === 'axis')).toBe(true)
  })

  it('★ 视角切方即换边（同一份全量按新视角重算，不缓存旧方）', () => {
    const { containers, hotseat } = stores()
    hotseat.setViewerSide('soviet')
    const soviet = boxesForViewer(containers.boxes, hotseat.viewerSide)
    hotseat.setViewerSide('axis')
    const axis = boxesForViewer(containers.boxes, hotseat.viewerSide)
    expect(soviet.some((box) => box.side === 'axis')).toBe(false)
    expect(axis.some((box) => box.side === 'soviet')).toBe(false)
    expect(axis.map((box) => box.side)).toContain('axis')
  })

  it('★ 面板的盒列表按 viewerSide 取盒（源码守卫：不写死轴心）', async () => {
    const { readFileSync } = await import('node:fs')
    const panel = readFileSync('src/components/containers/ContainersPanel.vue', 'utf8')
    expect(panel).toContain('boxesForViewer(containers.boxes, sideNow)')
    expect(panel).toContain('hotseat.viewerSide')
  })
})
