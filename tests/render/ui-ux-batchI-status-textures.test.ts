import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { MARKER_TEXTURES, markerTextureUrl, stepLossTextureUrl } from '@/render/token-images'
import { STATUS_TEXTURE_SIZE_RATIO, statusTextureSlots, TOKEN_SIZE_PX } from '@/render/token-layer'

/**
 * 批 I 返修（用户 2026-11-16）：**扣兵力 / DG 是单位自身状态，贴在各自算子身上**
 *
 * 口径：
 *   · 锚点＝该算子自己的绘制框（center/size），不是格子角位；同格多枚各贴各的；
 *   · 扣兵力按 1/2/3 档取 `misc_Nsteploss.png`；DG 取 `misc_DG.png`；
 *   · 图走既有 `markers/` 管线（`markerTextureUrl`），不另起路径；
 *   · 没有状态不占位；格级设施仍在格子左下角，两套互不相干。
 */

function slotsAt(
  centerX: number,
  centerY: number,
  size: number,
  over: { dg?: boolean; stepsLost?: number } = {},
) {
  return statusTextureSlots({
    centerX,
    centerY,
    size,
    dg: over.dg ?? false,
    stepsLost: over.stepsLost ?? 0,
  })
}

describe('批 I：状态贴图锚定在算子自身', () => {
  it('★ 同格两枚：一枚有损、一枚 DG ⇒ 各贴各的（锚点跟着各自算子中心走）', () => {
    const size = TOKEN_SIZE_PX
    const lossToken = { x: 100, y: 200 }
    const dgToken = { x: 300, y: 400 }
    const lossSlot = slotsAt(lossToken.x, lossToken.y, size, { stepsLost: 2 })[0]!
    const dgSlot = slotsAt(dgToken.x, dgToken.y, size, { dg: true })[0]!
    expect(lossSlot.kind).toBe('stepsLost')
    expect(dgSlot.kind).toBe('dg')
    // 各自贴在自己算子框内左右侧边（离自己的中心 < 半个算子）
    expect(Math.abs(lossSlot.centerX - lossToken.x)).toBeLessThan(size / 2)
    expect(Math.abs(lossSlot.centerY - lossToken.y)).toBeLessThan(size / 2)
    expect(Math.abs(dgSlot.centerX - dgToken.x)).toBeLessThan(size / 2)
    expect(Math.abs(dgSlot.centerY - dgToken.y)).toBeLessThan(size / 2)
    // 不会跑回"格子角位"：两枚的贴图各随各的中心平移
    expect(dgSlot.centerX - lossSlot.centerX).toBeCloseTo(dgToken.x - lossToken.x + size * 0.66, 6)
    expect(dgSlot.centerY - lossSlot.centerY).toBeCloseTo(dgToken.y - lossToken.y, 6)
  })

  it('★ HQ 混乱就贴在 HQ 那一枚上（同一函数，传入 HQ 的绘制框）', () => {
    const hq = { x: 640, y: 480, size: TOKEN_SIZE_PX }
    const [slot] = slotsAt(hq.x, hq.y, hq.size, { dg: true })
    expect(slot?.kind).toBe('dg')
    const dx = slot!.centerX - hq.x
    const dy = slot!.centerY - hq.y
    expect(dx).toBeCloseTo(hq.size * 0.33, 6)
    expect(dy).toBe(0)
    expect(Math.abs(dx) + slot!.size / 2).toBeLessThanOrEqual(hq.size / 2)
  })

  it('★ 无状态不占位；尺寸随算子等比缩放', () => {
    expect(slotsAt(0, 0, TOKEN_SIZE_PX)).toEqual([])
    const big = slotsAt(0, 0, TOKEN_SIZE_PX, { dg: true, stepsLost: 1 })
    const small = slotsAt(0, 0, TOKEN_SIZE_PX * 0.6, { dg: true, stepsLost: 1 })
    for (const [index, slot] of big.entries()) {
      expect(slot.size).toBeCloseTo(TOKEN_SIZE_PX * STATUS_TEXTURE_SIZE_RATIO, 6)
      expect(small[index]!.size).toBeCloseTo(TOKEN_SIZE_PX * 0.6 * STATUS_TEXTURE_SIZE_RATIO, 6)
    }
  })

  it('★ 贴图只占左右侧边中段：不压顶部名称、也不压底部印值', () => {
    const size = TOKEN_SIZE_PX
    const slots = slotsAt(0, 0, size, { dg: true, stepsLost: 3 })
    for (const slot of slots) {
      const top = slot.centerY - slot.size / 2
      const bottom = slot.centerY + slot.size / 2
      expect(top).toBeGreaterThan(-size * 0.25)
      expect(bottom).toBeLessThan(size * 0.25)
    }
  })
})

describe('批 I：四张官方图怎么接进管线', () => {
  it('★ 扣 1/2/3 分别取到 misc_1/2/3steploss；0 不画，超过 3 按 3 档', () => {
    expect(stepLossTextureUrl(1)).toBe('/counters/markers/misc_1steploss.png')
    expect(stepLossTextureUrl(2)).toBe('/counters/markers/misc_2steploss.png')
    expect(stepLossTextureUrl(3)).toBe('/counters/markers/misc_3steploss.png')
    expect(stepLossTextureUrl(0)).toBeNull()
    expect(stepLossTextureUrl(4)).toBe('/counters/markers/misc_3steploss.png')
  })

  it('★ DG 取 misc_DG；四张图都已同步进 public/counters/markers（打包随 public 直出）', () => {
    expect(markerTextureUrl(MARKER_TEXTURES.dg)).toBe('/counters/markers/misc_DG.png')
    for (const file of [
      'misc_1steploss.png',
      'misc_2steploss.png',
      'misc_3steploss.png',
      'misc_DG.png',
    ]) {
      expect(existsSync(`public/counters/markers/${file}`), file).toBe(true)
    }
    const sync = readFileSync('scripts/sync-counters.mjs', 'utf8')
    expect(sync).toContain('OFFICIAL_MARKER_DIR_NAME')
  })

  it('★ 源码守卫：贴图在 drawToken 内按本枚算子绘制框落位，不再有格角位/让位逻辑', () => {
    const layer = readFileSync('src/render/token-layer.ts', 'utf8')
    expect(layer).toContain('function drawStatusTexture')
    expect(layer).toContain('stepLossTextureUrl(slot.stepsLost')
    expect(layer).toContain('MARKER_TEXTURES.dg')
    expect(layer).toContain('statusTextureSlots({')
    // 旧版的格角让位（hqInHex / YIELD）已删
    expect(layer).not.toContain('hqInHex')
    expect(layer).not.toContain('STATUS_TEXTURE_YIELD_SIZE_RATIO')
    // 设施仍独立走左下角
    expect(layer).toContain('facilityTokenViews')
  })
})
