import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { useSetupStore } from '@/stores'

import { CORE_HEX, groundRecord, newConsole, placeGround } from '../flows/sop-harness'

/**
 * E2（用户 2026-11-17 实走）：**原地结束不进制「上一步结论」**
 *
 * 实走复现：走一步后点「结束移动 / Enter 收束」，会话框的「上一步结论」会多出一行
 * 绿色成功行 `6.1 13.29 → 13.29｜`（`from === to`、无单位名、无 MP）——那是
 * `endMoveEarly` 返回的 `kind: 'end'` 原地记录被 `snapshotOf` 当成了「一步」。
 *
 * 口径：结束不是一步；结束后面板给中性提示（「已结束本次移动」），不得出现伪步。
 */

describe('E2：结束移动不产生伪步', () => {
  function started() {
    const wb = newConsole()
    useSetupStore().finished = true
    wb.setActiveSide('axis')
    wb.setPhase('movement')
    const unit = placeGround(
      wb,
      groundRecord(
        'axis',
        (record) => record.isCombat === true && record.classes?.movementClass === 'leg',
      ),
      CORE_HEX,
      'axis',
      'e2-a',
    )
    wb.clickHex(CORE_HEX)
    expect(wb.confirmMovePick()).toBe(true)
    const node = wb.groupReachable.hexes.find((item) => item.path.length === 2)
    if (node === undefined) throw new Error('可到达范围里没有一步可达的格')
    wb.clickHex(node.hex)
    return { wb, unit, node }
  }

  it('走一步后有「上一步结论」；结束移动后必须清空，不得留下 from→to 伪步', () => {
    const { wb } = started()
    expect(wb.lastStep).not.toBeNull()

    wb.finishMove()

    expect(wb.moveInteraction!.finished).toBe(true)
    expect(wb.lastStep).toBeNull()
    expect(wb.moveLinger).toBe(true)
  })

  it('面板在结束态给中性提示「已结束本次移动」', () => {
    const src = readFileSync('src/components/move/MovePanel.vue', 'utf8')
    expect(src).toContain('已结束本次移动')
  })
})
