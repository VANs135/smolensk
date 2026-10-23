import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useContainersStore } from '@/stores'

/**
 * B31a：**盒内算子显示贴图**（用户口径 2026-09-16 #12）
 *
 * 「盒里的算子要**显示贴图**，算子紧密排列在 box 区域里，一排不够就多排，这样子方便检视」。
 *
    expect(card).not.toContain('_F.png')
 * 不是图档名 ⇒ 恒取不到图、只剩名字。修法：投影层（`stores/containers.ts#holdingImageUrlOf`）
 * 用 `counterImageUrlOf` 算好 `imageUrl`（与地图**同一条**选图实现，按阵营/朝向/点数/等级/装载选面）。
 *
 * 本文件钉：① 投影里每枚都带 `imageUrl` 且**只会**是 `/counters/...` 或 `null`（绝不臆造文件名）；
 * ② 组件不再自己拼文件名、不显名字、不截断。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return { containers: useContainersStore() }
}

describe('B31a：盒子项的贴图 URL', () => {
  it('★ 投影里每枚都带 `imageUrl`：要么是 /counters/ 下的真图，要么是 null（不臆造文件名）', () => {
    const { containers } = newStores()
    const all = containers.cardViews.flatMap((card) =>
      card.regions.flatMap((region) => region.units),
    )
    // 空盒也算有效场面；这里钉的是"字段存在且取值只可能有两种"
    for (const holding of all) {
      expect(holding.imageUrl === null || holding.imageUrl.startsWith('/counters/')).toBe(true)
    }
    // 卡面信息本身该有的还在（贴图是在它之上多出来的那一层）
    for (const card of containers.cardViews) {
      expect(card.image).not.toBe('')
      expect(card.imageSize.w).toBeGreaterThan(0)
    }
  })

  it('★ 源码守卫：组件不再拼文件名；不显名字、不截断（名字进 title）', () => {
    const card = readFileSync('src/components/game/BoxCard.vue', 'utf8')
    // 修前那种"实例 id + 后缀"的拼法必须绝迹（注释里提旧名不算）
    expect(card).not.toContain('_F.png')
    expect(card).not.toContain('unitImage(unit)')
    expect(card).not.toContain('slice(0, 12)')
    /*
     * B35 切片 C-2：**卡面**（图 + 分区 + 算子贴图）已抽成 `BoxCardFace.vue`
     * （托盘 320px 与浮窗共用同一份渲染）⇒ 那两条断言改看这一件；
     * "不拼文件名"仍然在 `BoxCard.vue` 上守着（两件都查，覆盖面只增不减）。
     */
    const face = readFileSync('src/components/game/BoxCardFace.vue', 'utf8')
    expect(face).not.toContain('_F.png')
    expect(face).not.toContain('slice(0, 12)')
    expect(face).toContain('unit.imageUrl')
    expect(face).toContain(':title="unit.name ?? unit.unitId"')

    const store = readFileSync('src/stores/containers.ts', 'utf8')
    expect(store).toContain('function holdingImageUrlOf')
    expect(store).toContain('counterImageUrlOf(ground)')
    expect(store).toContain('BoxHoldingView')
  })
})
