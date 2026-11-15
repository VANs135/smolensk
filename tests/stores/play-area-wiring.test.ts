import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'

import { insidePlayArea } from '@/engine/rules'
import {
  buildMoveContext,
  createRetreatFacts,
  toConsoleUnit,
  type UnitRecordView,
} from '@/stores/workbench-model'

/**
 * 活动区的接线（剧本 → 移动上下文 → 撤退事实）
 *
 * 纪律：读数从剧本走，判据只有一处（`insidePlayArea`）；工作台不得另建一套判断，
 * 也不得在界面堆提示文字（范围外＝不可进入，按既有的「不可用项不出现」处理）。
 */

const RECORD: UnitRecordView = {
  id: 'play-area-rgt',
  nameZh: '活动区测试团',
  side: 'axis',
  isCombat: true,
  attackCapable: true,
  classes: { combatClass: 'armor', movementClass: 'tracked' },
  reSize: 3,
  specialized: [],
  status: 'valued',
  factors: {
    combat: { attack: 10, ar: 4, ma: 5 },
    move: { attack: 4, ar: 4, ma: 10 },
  },
}

const START: HexRef = { col: 13, row: 27 }
const INSIDE: HexRef = { col: 13, row: 26 }
const OUTSIDE: HexRef = { col: 13, row: 22 }

const unit = toConsoleUnit({ record: RECORD, instanceId: 'play-area-1', hex: START, side: 'axis' })
unit.fuelled = true

const context = buildMoveContext({
  units: [unit],
  activeSide: 'axis',
  phase: 'movement',
  playAreaHexes: [START, INSIDE],
})

describe('活动区接线（剧本读数一处，判据一处）', () => {
  it('活动区格集进入移动上下文（plain 快照）', () => {
    expect(context.playAreaHexes).toEqual([START, INSIDE])
    expect(insidePlayArea(context.playAreaHexes, INSIDE)).toBe(true)
    expect(insidePlayArea(context.playAreaHexes, OUTSIDE)).toBe(false)
  })

  it('撤退事实沿用同一份活动区（不另建判据）', () => {
    const facts = createRetreatFacts({
      units: [unit],
      context,
      retreatingUnitIds: [],
    })
    expect(facts.outsidePlayArea?.(INSIDE)).toBe(false)
    expect(facts.outsidePlayArea?.(OUTSIDE)).toBe(true)
  })

  it('工作台从剧本读活动区并注入移动上下文（源码守卫）', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'stores', 'workbench.ts'), 'utf8')
    expect(source).toContain('scenarioInfo?.playArea')
    expect(source).toContain('playAreaHexes')
  })
})
