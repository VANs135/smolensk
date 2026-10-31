import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { markers } from '@/data'
import { boxArtwork } from '@/engine/rules'

/**
 * 盒的美工接口（W7 C12 / 问题总清单 C-4）
 *
 * 口径：**盒面直接用素材库的辅助卡图**（用户 2026-09-16 裁定 E-4）。
 * 数据在 `markers.json` 的 `containers.artwork`（键＝盒 id，见 `markers.schema.ts` 的
 * `BoxArtworkSchema`）；界面 `ContainersPanel` 见到 `imageKey` 就直接当 `<img src>` 用 ⇒
 * 这里必须保证：① 键是引擎真会产出的盒 id；② 图档真的在 `public/` 下（否则界面上是个碎图）。
 */
const ARTWORK = markers.containers.artwork ?? {}

/** 引擎产出的盒 id 形态（见 `engine/rules/containers.ts` 的 boxId 构造） */
const BOX_ID_PATTERNS: readonly RegExp[] = [
  /^dead-pile-(axis|soviet)$/,
  /^(axis|soviet)-air-box$/,
  /^edge-(northeast|southeast)$/,
  /^breakdown-(axis|soviet)$/,
  /^special-repl-(axis|soviet)$/,
  /^formation-.+$/,
  /^scenario-draw-.+$/,
]

describe('盒图（containers.artwork）：键与图档都要真的存在', () => {
  it('每个键都是引擎会产出的盒 id（拼错就等于没接）', () => {
    const bad = Object.keys(ARTWORK).filter(
      (id) => !BOX_ID_PATTERNS.some((pattern) => pattern.test(id)),
    )
    expect(bad).toEqual([])
  })

  it('每张图的 imageKey 都指向 public/ 下真实存在的文件', () => {
    const missing = Object.entries(ARTWORK)
      .filter(([, entry]) => entry.imageKey !== null)
      .map(([id, entry]) => {
        const url = entry.imageKey as string
        // imageKey 是给 `<img src>` 用的 URL 路径 ⇒ 解码后对到 public/ 下的文件
        const path = join('public', decodeURIComponent(url.replace(/^\//, '')))
        return existsSync(path) ? null : `${id} → ${url}`
      })
      .filter((item): item is string => item !== null)
    expect(missing).toEqual([])
  })

  it('核心六盒都有盒图（死亡堆 ×2 / 图外空军盒 ×2 / 边缘盒 ×2）', () => {
    for (const id of [
      'dead-pile-axis',
      'dead-pile-soviet',
      'axis-air-box',
      'soviet-air-box',
      'edge-northeast',
      'edge-southeast',
    ])
      expect(boxArtwork(id)?.imageKey, id).toBeTruthy()
  })

  it('空军盒按印卡的 Active / Inactive 两栏登记 columns = 2（专规 1.4a）', () => {
    expect(boxArtwork('axis-air-box')?.columns).toBe(2)
    expect(boxArtwork('soviet-air-box')?.columns).toBe(2)
  })

  it('没登记的盒照旧返回 null（界面退化纯文字盒，不报错）', () => {
    expect(boxArtwork('formation-10 Mtr Div')).toBeNull()
    expect(boxArtwork('special-repl-soviet')).toBeNull()
  })
})
