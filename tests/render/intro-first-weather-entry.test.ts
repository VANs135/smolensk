import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * 开局天气入口的界面守卫（用户 2026-11-15 口径）
 *
 * 一个入口、极简、不写说明文字；只在教学剧本出现（`isTeachingScenario`），
 * 其余剧本仍显示剧本原值文本。
 */
describe('开局天气入口（只教学剧本，一处）', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'views', 'ScenarioSetupView.vue'), 'utf8')

  it('天气行按教学剧本分流：教学剧本出单选，其他剧本仍显示原值', () => {
    expect(source).toContain('isTeachingScenario(selected.id)')
    expect(source).toContain('gameSession.setFirstWeatherChoice')
    expect(source).toContain('name="first-weather"')
  })

  it('只有一处天气选择入口（不出现第二组单选）', () => {
    expect(source.match(/name="first-weather"/g) ?? []).toHaveLength(2)
  })
})
