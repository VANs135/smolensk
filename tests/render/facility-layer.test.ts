import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { isFacilityToken, topTokenOf, type UnitToken } from '@/render/token-layer'
import { visibleUnitIds } from '@/engine/rules/fog'

/**
 * B31b：**设施单独一层**（渲染）＋ **战雾放行中立设施**（引擎）—— 用户口径 2026-09-16 #20 / #7
 *
 * #20：「剧本 1 苏联机场没有正确显示，飞机是可以正常部署到机场格，但没有机场贴图」。
 * #7（复答）：「**非战斗单位可以和战斗单位不同层**，但是**机场是容纳飞机的，点击机场后展开里面飞机**」。
 *
 * 两条病根：① 渲染层"一格一枚"（`topTokenOf`）把机场压掉了；② 战雾只放行战斗单位与飞机，
 * 对手看不到你的机场。本批分别修：设施不参与顶牌竞争（被顶掉的在设施层补画）、
 * 战雾对设施放行（只看"这格有设施"，不透露枚数）；点击仍按格命中 ⇒ 点机场即摊开该格、里面有飞机。
 */

const token = (over: Partial<UnitToken> & { id: string }): UnitToken =>
  ({ hex: { col: 1, row: 1 }, side: 'soviet', ...over }) as UnitToken

describe('B31b：设施单独一层（渲染）', () => {
  it('★ 判定：机场 / SP / 工事是设施，战斗单位与飞机不是', () => {
    expect(isFacilityToken(token({ id: 'base', noncombatKind: 'air_base' }))).toBe(true)
    expect(isFacilityToken(token({ id: 'sp', noncombatKind: 'sp' }))).toBe(true)
    expect(isFacilityToken(token({ id: 'hog', noncombatKind: 'hedgehog' }))).toBe(true)
    expect(isFacilityToken(token({ id: 'inf' }))).toBe(false)
    expect(isFacilityToken(token({ id: 'plane', air: true }))).toBe(false)
  })

  it('★ 顶牌策略不变（机场被压掉是**预期**的；补画由设施层负责，不改堆叠语义）', () => {
    const base = token({ id: 'base', noncombatKind: 'air_base' })
    const inf = token({ id: 'inf' })
    // 顶牌仍取"最后一枚"（不在本批改），设施层据此得知哪几枚需要补画
    expect(topTokenOf([base, inf]).id).toBe('inf')
    expect(topTokenOf([base, inf]).id).not.toBe(base.id)
  })

  it('★ 源码守卫：渲染层确有"设施层"（在算子层之后补画被顶掉的设施）', () => {
    const layer = readFileSync('src/render/token-layer.ts', 'utf8')
    expect(layer).toContain('export function isFacilityToken')
    expect(layer).toContain('export const FACILITY_TOKEN_RATIO')
    expect(layer).toContain('const facilities = group.filter')
    // 补画在状态贴图之前、算子层之后（否则会被顶牌盖住）
    const at = layer.indexOf('const facilities = group.filter')
    const status = layer.indexOf('drawTokenStatusTextures(ctx, drawn)')
    expect(at).toBeGreaterThan(0)
    expect(status).toBeGreaterThan(at)
  })
})

describe('B31b：战雾放行中立设施（引擎）', () => {
  const view = (
    over: Record<string, unknown>,
  ): Parameters<typeof visibleUnitIds>[0]['units'][number] =>
    ({
      id: 'x',
      side: 'soviet',
      kind: 'ground',
      isCombat: false,
      attackCapable: false,
      inCombatMode: false,
      projectsZoc: false,
      ...over,
    }) as Parameters<typeof visibleUnitIds>[0]['units'][number]

  it('★ 对手视角：可见该格的中立设施（机场 / SP / 工事）', () => {
    const ids = visibleUnitIds({
      viewer: 'axis',
      units: [
        view({ id: 'enemy-inf', isCombat: true, attackCapable: true, inCombatMode: true }),
        view({ id: 'enemy-base', isFacility: true }),
        view({ id: 'enemy-sp', isFacility: true }),
        view({ id: 'enemy-hog', isFacility: true }),
        view({ id: 'enemy-other-noncombat' }),
      ],
    })
    expect(ids).toContain('enemy-base')
    expect(ids).toContain('enemy-sp')
    expect(ids).toContain('enemy-hog')
    // 既有的两枚口径没变：最上方战斗单位在列；**非设施的非战斗单位仍不可见**
    expect(ids).toContain('enemy-inf')
    expect(ids).not.toContain('enemy-other-noncombat')
  })

  it('★ 己方格：全部可见（含设施）；没变化', () => {
    const ids = visibleUnitIds({
      viewer: 'soviet',
      units: [view({ id: 'own-inf', isCombat: true }), view({ id: 'own-base', isFacility: true })],
    })
    expect(ids).toEqual(['own-inf', 'own-base'])
  })

  it('★ 源码守卫：视图字段由调用方填（引擎只按布尔判，不引数据层词表）', () => {
    const fog = readFileSync('src/engine/rules/fog.ts', 'utf8')
    expect(fog).toContain('isFacility?: boolean')
    expect(fog).toContain('unit.isFacility === true')
    const hotseat = readFileSync('src/stores/hotseat.ts', 'utf8')
    expect(hotseat).toContain("unit.noncombatKind === 'air_base'")
  })
})
