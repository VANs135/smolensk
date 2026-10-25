import { describe, expect, it } from 'vitest'

import {
  actsShown,
  infoShown,
  sectionShown,
  type ExclusiveOnly,
  type ExclusiveSectionScope,
} from '@/components/exclusive/section-scope'

/**
 * ★ 2026-10-25 实测踩过的回归：给专规面板加"单段模式"时，把
 *   `<details>` 的 `v-if` 判据写成"只有 actions / 自己那一段" ⇒
 *   **右栏（`only="info"`）里五节整块消失**，连「逐城治安明细 / 工事等级与上限 /
 *   建造标记余量 / 缓存持仓」这些**只读信息**也一起没了。
 *
 * 本文件把这张"哪种 `only` 下出现什么"的表钉死（纯函数，不依赖组件挂载）。
 */

const SECTIONS: readonly ExclusiveSectionScope[] = [
  'panzer',
  'security',
  'hedgehog',
  'marker',
  'cache',
]

describe('专规面板的分段可见性（纯函数）', () => {
  it('null（验证页）：五节本体全显、动作全可写、只读信息也显', () => {
    for (const section of SECTIONS) {
      expect(sectionShown(null, section)).toBe(true)
      expect(actsShown(null, section)).toBe(true)
    }
    expect(infoShown(null)).toBe(true)
  })

  it('actions（会话全动作）：五节本体全显、动作全可写；只读信息段不显', () => {
    for (const section of SECTIONS) {
      expect(sectionShown('actions', section)).toBe(true)
      expect(actsShown('actions', section)).toBe(true)
    }
    expect(infoShown('actions')).toBe(false)
  })

  it('★ info（右栏只读）：**五节本体全显**，但一个动作也不可写', () => {
    for (const section of SECTIONS) {
      expect(sectionShown('info', section), `info 模式下 ${section} 这一节不该消失`).toBe(true)
      expect(actsShown('info', section), `info 模式下 ${section} 的动作不该可写`).toBe(false)
    }
    expect(infoShown('info')).toBe(true)
  })

  it('单段模式（点什么单位 → 只出哪一段）：只显自己，动作只放自己', () => {
    for (const own of SECTIONS) {
      const only: ExclusiveOnly = own
      for (const section of SECTIONS) {
        const same = section === own
        expect(sectionShown(only, section), `${only} 模式下 ${section}`).toBe(same)
        expect(actsShown(only, section), `${only} 模式下 ${section} 的动作`).toBe(same)
      }
      // 单段模式**不**附带"只读信息段"（那些是时点/容量，与该操作无关）
      expect(infoShown(own)).toBe(false)
    }
  })

  it('不变式：动作可写 ⇒ 本节必然出现（不允许"动作在、节不在"）', () => {
    const all: readonly ExclusiveOnly[] = [null, 'info', 'actions', ...SECTIONS]
    for (const only of all) {
      for (const section of SECTIONS) {
        if (actsShown(only, section)) {
          expect(sectionShown(only, section), `${String(only)} / ${section}`).toBe(true)
        }
      }
    }
  })
})
