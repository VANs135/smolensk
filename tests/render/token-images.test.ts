import { describe, expect, it } from 'vitest'

import {
  MARKER_TEXTURES,
  airbaseImageUrl,
  allMarkerTextureUrls,
  counterDirOfSide,
  counterImageUrl,
  counterImageUrlForFace,
  createImageCache,
  exploitTextureUrl,
  hedgehogCounterImageUrl,
  hedgehogTextureUrl,
  markerTextureUrl,
  spCounterImageUrl,
  tokenImageUrl,
} from '@/render/token-images'

/**
 * 算子图 / 贴图的 URL 与缓存（渲染层，只读）
 *
 * Node 测试环境**没有 DOM、没有 Image**：`counterImages.get()` 永远返回 null ⇒
 * `token-layer` 走矢量回退。这正是「图未就绪也能画盘」的保证，故这里专门钉住这一行为。
 */

describe('算子图 URL 与朝向选择', () => {
  it('阵营 → 目录；中立算子走 markers', () => {
    expect(counterDirOfSide('axis')).toBe('axis')
    expect(counterDirOfSide('soviet')).toBe('soviet')
    expect(counterDirOfSide('both')).toBe('markers')
  })

  it('文件名含空格 / 中文时 URL 会被编码（贴图名里带空格）', () => {
    expect(counterImageUrl('markers', 'misc_Explt-2 small.png')).toBe(
      '/counters/markers/misc_Explt-2%20small.png',
    )
  })

  it('5.4a：图随朝向那一面 —— 战斗面取 front、移动面取 back', () => {
    const images = { front: 'Ru_A_F.png', back: 'Ru_A_B.png' }
    expect(counterImageUrlForFace('soviet', 'combat', images)).toBe('/counters/soviet/Ru_A_F.png')
    expect(counterImageUrlForFace('soviet', 'move', images)).toBe('/counters/soviet/Ru_A_B.png')
  })

  it('单面算子（back 为空）两面都用正面；无图记录返回 null', () => {
    const single = { front: 'Neutral_Airbase_1.png', back: null }
    expect(counterImageUrlForFace('markers', 'move', single)).toBe(
      '/counters/markers/Neutral_Airbase_1.png',
    )
    expect(counterImageUrlForFace('axis', 'combat', null)).toBeNull()
    expect(counterImageUrlForFace('axis', 'combat', { front: null, back: null })).toBeNull()
    expect(counterImageUrlForFace('axis', 'combat', undefined)).toBeNull()
  })
})

describe('计数类非战斗算子：图随**当前数值**走（不是记录里那枚静态图）', () => {
  it('12.1a：SP 按点数取图 —— 1/2/3 双面（SP 面 / T 面），4/5/10/15 单面', () => {
    expect(spCounterImageUrl(1, 'combat')).toBe('/counters/markers/Neutral_SP_1_F.png')
    expect(spCounterImageUrl(1, 'move')).toBe('/counters/markers/Neutral_SP_1_B.png')
    expect(spCounterImageUrl(3, 'combat')).toBe('/counters/markers/Neutral_SP_3_F.png')
    expect(spCounterImageUrl(4, 'combat')).toBe('/counters/markers/Neutral_SP_4.png')
    expect(spCounterImageUrl(10, 'move')).toBe('/counters/markers/Neutral_SP_10.png')
    expect(spCounterImageUrl(15, 'combat')).toBe('/counters/markers/Neutral_SP_15.png')
    expect(spCounterImageUrl(0, 'combat')).toBeNull()
  })

  it('15.4：空军基地按等级取图（1–3 级）；等级越界返回 null', () => {
    expect(airbaseImageUrl(1)).toBe('/counters/markers/Neutral_Airbase_1.png')
    expect(airbaseImageUrl(3)).toBe('/counters/markers/Neutral_Airbase_3.png')
    expect(airbaseImageUrl(0)).toBeNull()
    expect(airbaseImageUrl(4)).toBeNull()
  })

  it('16.0：环形工事算子按等级取图（1–4 级），与地图印刷工事的贴图分开', () => {
    expect(hedgehogCounterImageUrl(2)).toBe('/counters/markers/Neutral_Hedgehog_2.png')
    expect(hedgehogCounterImageUrl(5)).toBeNull()
    expect(hedgehogCounterImageUrl(2)).not.toBe(hedgehogTextureUrl(2))
  })

  it('tokenImageUrl：计数类按数值、其余按记录的两面图', () => {
    // SP：即便记录里带 1 点的图，也按**当前点数**取（拆并补给台后点数会变）
    expect(
      tokenImageUrl({
        side: 'both',
        noncombatKind: 'sp',
        spPoints: 5,
        images: { front: 'Neutral_SP_1_F.png', back: 'Neutral_SP_1_B.png' },
      }),
    ).toBe('/counters/markers/Neutral_SP_5.png')
    // 空军基地按等级
    expect(tokenImageUrl({ side: 'both', noncombatKind: 'air_base', noncombatLevel: 2 })).toBe(
      '/counters/markers/Neutral_Airbase_2.png',
    )
    // 战斗单位按记录 + 朝向
    expect(
      tokenImageUrl({
        side: 'soviet',
        face: 'move',
        noncombatKind: null,
        images: { front: 'Ru_A_F.png', back: 'Ru_A_B.png' },
      }),
    ).toBe('/counters/soviet/Ru_A_B.png')
    // 无图记录 ⇒ null（调用方回退矢量画法）
    expect(tokenImageUrl({ side: 'axis', noncombatKind: null, images: null })).toBeNull()
  })
})

describe('各种贴图（模式标记 / 工事等级）', () => {
  it('进击标记按单位 id 稳定取变体（同一单位每次重绘同一张，不闪）', () => {
    const first = exploitTextureUrl('u-1')
    expect(exploitTextureUrl('u-1')).toBe(first)
    expect(MARKER_TEXTURES.exploit.map((file) => markerTextureUrl(file))).toContain(first)
  })

  it('环形工事等级 1–4 映射到对应贴图；越界返回 null（调用方回退矢量）', () => {
    expect(hedgehogTextureUrl(1)).toBe(markerTextureUrl(MARKER_TEXTURES.hedgehog[0]!))
    expect(hedgehogTextureUrl(4)).toBe(markerTextureUrl(MARKER_TEXTURES.hedgehog[3]!))
    expect(hedgehogTextureUrl(0)).toBeNull()
    expect(hedgehogTextureUrl(5)).toBeNull()
    expect(hedgehogTextureUrl(2.5)).toBeNull()
  })

  it('预载清单覆盖全部 9 张贴图（3 进击 + 战略 + 断补 + 4 工事）', () => {
    const urls = allMarkerTextureUrls()
    expect(urls).toHaveLength(9)
    expect(new Set(urls).size).toBe(9)
    expect(urls.every((url) => url.startsWith('/counters/markers/'))).toBe(true)
  })
})

describe('图片缓存：无 DOM 时永久回退（不抛错、不阻塞绘制）', () => {
  it('get 在未加载时返回 null；preload 在无 Image 环境直接 resolve', async () => {
    const cache = createImageCache()
    expect(cache.get('/counters/axis/x.png')).toBeNull()
    await expect(cache.preload(['/counters/axis/x.png'])).resolves.toBeUndefined()
    expect(cache.get('/counters/axis/x.png')).toBeNull()
    expect(cache.readyCount()).toBe(0)
  })
})
