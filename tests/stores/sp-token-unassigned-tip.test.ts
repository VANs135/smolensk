import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { PANZER_GROUP_OPTION_ITEM } from '@/engine/rules'
import { useGameSessionStore, useMapViewStore, useSetupStore, useWorkbenchStore } from '@/stores'

/**
 * 3.4b：拆分出的三枚 SP 的**全称**（用户 2026-11-09）
 *
 *   · 角标仍是 `G N SP` / `H N SP` / `? N SP`（令牌太小，全称会溢出）；
 *   · 悬停提示与「点开的信息」写全称：Guderian / Hoth / 未归属，共一套机制；
 *   · 未拆分时的普通 SP 不带全称。
 */

const HEX: HexRef = { col: 36, row: 13 }

function setup(turn = 12) {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const session = useGameSessionStore()
  const index = session.agreedOptionItems.indexOf(PANZER_GROUP_OPTION_ITEM)
  if (index < 0) throw new Error('开场共识清单里没有 3.4b 这一条')
  session.setAgreedCheck(index, true)
  const workbench = useWorkbenchStore()
  workbench.setTurn(turn)
  return { workbench, mapView: useMapViewStore() }
}

/** 旧档遗留的未归属站（2026-11-11 起新入口不再产生未归属站） */
function seedLegacyUnassigned(workbench: ReturnType<typeof setup>['workbench'], sp: number): void {
  workbench.spDumps.push({ id: 'sd-legacy', hex: { ...HEX }, side: 'axis', sp, t: 0 })
}

/** 3.4b 未生效（19 August 后）时走真实入口落普通 SP */
function addUnassigned(workbench: ReturnType<typeof setup>['workbench'], sp: number): void {
  workbench.spDumpDraft = { hexText: `${HEX.col}.${HEX.row}`, sp, t: 0 }
  expect(workbench.addSpDump()).toBe(true)
}

function seedGroups(workbench: ReturnType<typeof setup>['workbench']): void {
  workbench.spDumps.push({ id: 'sd-g', hex: { ...HEX }, side: 'axis', sp: 4, t: 0 })
  workbench.spDumps.push({ id: 'sd-h', hex: { ...HEX }, side: 'axis', sp: 3, t: 0 })
  workbench.setDumpPanzerGroupNow('sd-g', 'guderian')
  workbench.setDumpPanzerGroupNow('sd-h', 'hoth')
}

function spTokens(mapView: ReturnType<typeof setup>['mapView']) {
  return mapView.overlay.tokens.filter((token) => token.id.startsWith('sp:'))
}

describe('3.4b：未归属 SP 的全称（悬停提示 / 点开信息）', () => {
  let s: ReturnType<typeof setup>

  beforeEach(() => {
    s = setup()
    seedGroups(s.workbench)
    seedLegacyUnassigned(s.workbench, 2)
  })

  it('★ 三枚都带 tip 全称：G / H / 未归属（各自写清是哪一本账）', () => {
    const tokens = spTokens(s.mapView)
    const unassigned = tokens.find((token) => token.id === `sp:${HEX.col},${HEX.row}:-`)
    const guderian = tokens.find((token) => token.id === `sp:${HEX.col},${HEX.row}:guderian`)
    const hoth = tokens.find((token) => token.id === `sp:${HEX.col},${HEX.row}:hoth`)
    expect(unassigned?.label).toBe('? 2 SP')
    expect(unassigned?.tip).toBe('未归属（3.4b）')
    expect(guderian?.label).toBe('G 4 SP')
    expect(guderian?.tip).toBe('Guderian 装甲集群（3.4b）')
    expect(hoth?.label).toBe('H 3 SP')
    expect(hoth?.tip).toBe('Hoth 装甲集群（3.4b）')
    expect(tokens.filter((token) => token.tip !== undefined)).toHaveLength(3)
  })

  it('★ 点开补给站菜单：标题写全称（不再是笼统的「补给站」）', () => {
    s.workbench.setActiveSide('axis')
    s.workbench.setPhase('movement')
    const index = s.workbench.playerSegmentSteps.findIndex(
      (step) => step.id === 'movement.modeAndMovement',
    )
    expect(index).toBeGreaterThanOrEqual(0)
    expect(s.workbench.setSegmentStepIndex(index)).toBe(true)

    const id = `sp:${HEX.col},${HEX.row}:-`
    // 用户 2026-11-09：地图右键多枚 ⇒ 一份共用菜单；单枚标签走"该枚自己的菜单"
    expect(s.mapView.openUnitContext(HEX, id, { x: 0, y: 0 })).toBe(true)
    expect(s.mapView.contextOptions.find((item) => item.id === id)?.label).toBe('未归属（3.4b）')
  })

  it('★ 未拆分（8.19 后）：普通 SP 不带 tip', () => {
    const late = setup(13)
    addUnassigned(late.workbench, 4)
    const token = spTokens(late.mapView).find((item) => item.id.startsWith('sp:'))
    expect(token?.tip).toBeUndefined()
  })
})
