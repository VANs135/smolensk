import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { counterImageUrlOf, toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

/**
 * B13：`CounterPicker` 算子图阵列（先用于增援面板）
 *
 * 用户口径⑪（§4.9）：「把当前可选的**算子图片**紧凑排出来……**算子上信息已经够了，
 * 除了环节提示这种外不需要显示额外的文字**」。
 *
 * 本文件钉两件事（组件本身是纯投影，真正的风险在**选图**与**替换是否彻底**）：
 *   ① **选图口径**：面板侧 `counterImageUrlOf` 与地图**同一条**实现——
 *      SP 按当前点数、空军基地按当前等级、编队卡车按**装载面**、地面单位按**朝向那一面**；
 *   ② **替换**：增援面板那处"待重建单位"确实换成了算子图阵列，且**旧的文字下拉已删**
 *      （先加后删在这里是"换了就删"，否则同一位选择会出现两套控件）。
 */

describe('B13：面板选图（counterImageUrlOf）与地图同源', () => {
  let workbench: ReturnType<typeof useWorkbenchStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    workbench = useWorkbenchStore()
  })

  const place = (recordId: string, side: 'axis' | 'soviet' = 'axis') => {
    const record = unitChoices(side).find((item) => item.id === recordId)
    if (record === undefined) throw new Error(`单位库没有 ${recordId}`)
    return record
  }

  it('地面战斗单位：**按朝向那一面**取图（5.4a；两面都有图时不能取错）', () => {
    const record = place('ax-breakdown-german-4-4-3-breakdown')
    const unit = toConsoleUnit({
      record,
      instanceId: 'u1',
      hex: { col: 36, row: 13 },
      side: 'axis',
      face: 'combat',
    })
    const combat = counterImageUrlOf(unit)
    expect(combat).not.toBeNull()
    expect(combat).toContain(record.images?.front ?? '')

    // 翻到移动面 ⇒ 取背面图（若该记录是单面算子则两面同图，断言随之成立）
    const moved = toConsoleUnit({
      record,
      instanceId: 'u2',
      hex: { col: 36, row: 13 },
      side: 'axis',
      face: 'move',
    })
    const moveFace = counterImageUrlOf(moved)
    expect(moveFace).not.toBeNull()
    expect(moveFace).toContain(record.images?.back ?? record.images?.front ?? '')
  })

  it('★ SP 算子：图**随当前点数走**（拆并后台面会变，图必须跟着变）', () => {
    const record = unitChoices('axis').find((item) => item.noncombatKind === 'sp')
    expect(record, '单位库应有 SP 算子').toBeDefined()
    const unit = toConsoleUnit({
      record: record!,
      instanceId: 'sp1',
      hex: { col: 36, row: 13 },
      side: 'axis',
    })
    unit.noncombatSp = 3
    const three = counterImageUrlOf(unit)
    unit.noncombatSp = 5
    const five = counterImageUrlOf(unit)

    expect(three).not.toBeNull()
    expect(five).not.toBeNull()
    // 点数不同 ⇒ 图不同（这正是"图随数值走"的判据）
    expect(three).not.toBe(five)
    expect(three).toContain('3')
    expect(five).toContain('5')
  })

  it('★ 编内卡车：面＝**装载**（满载 1 SP / 空载 0），与朝向无关（13.2f/h、13.0）', () => {
    const record = unitChoices('axis').find((item) => item.noncombatKind === 'organic_truck')
    expect(record, '单位库应有编内卡车').toBeDefined()
    const unit = toConsoleUnit({
      record: record!,
      instanceId: 't1',
      hex: { col: 36, row: 13 },
      side: 'axis',
    })
    unit.loadedSpT = 0
    const empty = counterImageUrlOf(unit)
    unit.loadedSpT = 1
    const full = counterImageUrlOf(unit)

    expect(empty).not.toBeNull()
    expect(full).not.toBeNull()
    expect(empty).not.toBe(full)
  })

  it('空军基地：图随**当前等级**走（15.4 缩减后会降级，图不能停在旧等级）', () => {
    const record = unitChoices('axis').find((item) => item.noncombatKind === 'air_base')
    expect(record, '单位库应有空军基地').toBeDefined()
    const unit = toConsoleUnit({
      record: record!,
      instanceId: 'b1',
      hex: { col: 36, row: 13 },
      side: 'axis',
    })
    unit.noncombatLevel = 1
    const level1 = counterImageUrlOf(unit)
    unit.noncombatLevel = 3
    const level3 = counterImageUrlOf(unit)

    expect(level1).not.toBeNull()
    expect(level3).not.toBeNull()
    expect(level1).not.toBe(level3)
  })

  it('死亡堆与地面共用 ⇒ 候选里可以有空军条目，取图不炸（13.5）', () => {
    for (const side of ['axis', 'soviet'] as const) {
      for (const unit of workbench.rebuildCandidates) {
        // 不抛错即可；取不到图返回 null（界面退回只写名字）
        const url = counterImageUrlOf(unit)
        expect(url === null || url.startsWith('/')).toBe(true)
      }
      void side
    }
  })
})

describe('B13：增援面板的替换（源码守卫）', () => {
  const panel = readFileSync('src/components/reinforcement/ReinforcementPanel.vue', 'utf8')

  it('待重建单位改走 `CounterPicker`，且**旧的文字下拉已删**（不留两套控件）', () => {
    expect(panel).toContain('<CounterPicker')
    expect(panel).toContain('counterImageUrlOf')
    // 那一处 select 必须是**没了**（`rebuildUnitId` 现在只由阵列点击写入）
    expect(panel).not.toContain('<select v-model="rebuildUnitId"')
    expect(panel).toContain('@pick="rebuildUnitId = $event"')
  })

  it('悬停同步地图高亮：走既有的 `setHoverHex`（不另立通道）', () => {
    expect(panel).toContain('workbench.setHoverHex')
    expect(panel).toContain('@hover=')
  })

  it('算子图上不叠文字：`CounterPicker` 里没有把名字画进模板的标（名字只进 title/aria-label）', () => {
    const picker = readFileSync('src/components/game/CounterPicker.vue', 'utf8')
    expect(picker).toContain(':title=')
    expect(picker).toContain(':aria-label=')
    // 模板里唯一允许的文字是「环节提示 / 分组下拉 / 拒绝原因」三类
    const textSlots = [...picker.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map((match) =>
      match[1]!.trim(),
    )
    for (const slot of textSlots) {
      const allowed =
        slot === 'props.title' ||
        slot === 'group.label' ||
        slot === 'refusal' ||
        slot === 'props.hint' ||
        slot === 'item.badge' ||
        slot === 'refusal === null'
      expect(allowed, `模板里出现了计划外的文字：{{ ${slot} }}`).toBe(true)
    }
  })
})
