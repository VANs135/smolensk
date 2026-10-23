import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useContainersStore } from '@/stores'

/**
 * B35 切片 C：**盒内动作按展开卡过滤（C-1）** + **盒卡弹出浮窗（C-2）**
 *
 * 方案 §3 B35 步骤 7/8：
 *   ⑦ `containers` 会话带上"当前展开卡 id"，`ContainersPanel` 动作段按卡过滤；
 *   ⑧ `BoxCard` 加"弹出"按钮 ⇒ 复制一份到 `position: fixed` 浮层（可拖动、Esc 关）。
 *
 * 原始现象（C-1）：动作触发判据是"托盘里展开着一张盒卡"，但面板**不看是哪一张** ——
 * 展开空军盒也会把死亡堆、拆分池、编队盒的动作一并列出来。
 *
 * ★ 一条**测法边界（如实）**：本仓库**不挂组件渲染测试** ⇒ "动作段真的按卡过滤了/浮窗真的画出来了"
 *   由**源码守卫 + 人眼**确认；这里能钉住的是**判据本身**（`openCardBoxKinds` 的内容随展开哪张卡变化）
 *   与**渲染件的接线**。浮窗的拖动回弹几何**不重复测**：它复用的是唯一会话框那套
 *   `clampDockOffset`（`tests/components/dock-position.test.ts` 17 条已覆盖）。
 */
describe('B35 C-1：按展开的盒卡过滤动作', () => {
  const newContainers = () => {
    setActivePinia(createPinia())
    return useContainersStore()
  }

  it('★ 没展开卡 ⇒ `null`（不过滤，验证页/右栏那两份照旧全给）', () => {
    const containers = newContainers()
    expect(containers.cardOpenId).toBeNull()
    expect(containers.openCardBoxKinds).toBeNull()
    expect(containers.openCardName).toBeNull()
  })

  it('★ 展开"轴心死人堆" ⇒ 只覆盖死亡堆那类盒；换成"轴心空军地图外盒" ⇒ 只覆盖空军盒', () => {
    const containers = newContainers()
    const dead = containers.cardViews.find((card) => card.id === 'axis-dead-pile')
    const air = containers.cardViews.find((card) => card.id === 'axis-airfields')
    if (dead === undefined || air === undefined) throw new Error('辅助卡库里缺少这两张盒卡？')

    containers.toggleCardOpen(dead.id)
    expect(containers.openCardName).toBe(dead.name)
    expect(containers.openCardBoxKinds).toContain('dead_pile')
    // 关键：展开死亡堆**不该**把空军盒/拆分池也算进来（这正是 C-1 的病根）
    expect(containers.openCardBoxKinds).not.toContain('air_box_active')
    expect(containers.openCardBoxKinds).not.toContain('breakdown_pool')

    containers.toggleCardOpen(air.id)
    expect(containers.openCardName).toBe(air.name)
    expect(containers.openCardBoxKinds).toContain('air_box_active')
    expect(containers.openCardBoxKinds).not.toContain('dead_pile')

    // 再点一次同一张 ⇒ 收起（同时只展开一张）
    containers.toggleCardOpen(air.id)
    expect(containers.cardOpenId).toBeNull()
    expect(containers.openCardBoxKinds).toBeNull()
  })

  it('★ 面板动作段的判据＝该投影；每个盒的动作段都改用 `showsBoxActions(kind)`', () => {
    const panel = readFileSync('src/components/containers/ContainersPanel.vue', 'utf8')
    expect(panel).toContain('function showsBoxActions(kind: string): boolean')
    expect(panel).toContain('const kinds = containers.openCardBoxKinds')
    for (const kind of [
      'deadPile',
      'edgeBox',
      'airBox',
      'breakdownBox',
      'specialReplBox',
      'formationBox',
      'scenarioDrawBox',
    ]) {
      expect(panel, `动作段没按卡过滤：${kind}`).toContain(`showsBoxActions('${kind}')`)
    }
    // 旧的"按 box.kind 直接判"的写法已不存在（那是不看卡的写法）
    expect(panel).not.toContain('v-if="showsActions && box.kind === \'')

    // 会话标题点明是哪一张卡（C-1 的另一半：会话带上"当前展开卡"）
    const mapView = readFileSync('src/stores/map-view.ts', 'utf8')
    expect(mapView).toContain('containers.openCardName')
  })
})

describe('B35 C-2：盒卡弹出浮窗', () => {
  const newContainers = () => {
    setActivePinia(createPinia())
    return useContainersStore()
  }

  it('★ 浮窗状态在 store 里（不是组件局部），且与"托盘展开哪张"分开记', () => {
    const containers = newContainers()
    expect(containers.popupCardId).toBeNull()
    containers.setPopupCard('axis-dead-pile')
    expect(containers.popupCardId).toBe('axis-dead-pile')
    // 托盘的展开态不受影响（浮窗是"放大看"的临时视图）
    expect(containers.cardOpenId).toBeNull()
    containers.setPopupCard(null)
    expect(containers.popupCardId).toBeNull()
  })

  it('★ 收起/展开卡时顺手收浮窗（免得留一张看不见的浮窗）', () => {
    const containers = newContainers()
    const dead = containers.cardViews.find((card) => card.id === 'axis-dead-pile')
    if (dead === undefined) throw new Error('辅助卡库里缺少轴心死人堆？')
    containers.setPopupCard(dead.id)
    containers.toggleCardOpen(dead.id)
    expect(containers.popupCardId).toBeNull()
  })

  it('★ 卡面被抽成共用件；BoxCard 只画"头 + 浮窗"，浮窗可拖动且 Esc 关', () => {
    const face = readFileSync('src/components/game/BoxCardFace.vue', 'utf8')
    // 卡面（图 + 分区 + 算子贴图）在这一件里
    expect(face).toContain('auxCardImageUrl(props.card.image)')
    expect(face).toContain('v-for="region in card.regions"')
    expect(face).toContain('face__unit-img')
    expect(face).toContain('props.width / props.card.imageSize.w')

    const card = readFileSync('src/components/game/BoxCard.vue', 'utf8')
    // 两处共用同一份卡面（托盘 320px / 浮窗更宽）
    expect(card.match(/<BoxCardFace /gu)?.length).toBe(2)
    expect(card).toContain('containers.setPopupCard(props.card.id)')
    expect(card).toContain('<Teleport to="body">')
    expect(card).toContain('position: fixed')
    // 拖动 + 回弹复用唯一会话框那套几何（不另写一份）
    expect(card).toContain('clampDockOffset({')
    expect(card).toContain('onPopupPointerMove')
    expect(card).toContain("event.key !== 'Escape'")
    expect(card).toContain('window.addEventListener')
  })
})
