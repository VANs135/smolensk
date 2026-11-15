import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import { createMemoryStorage, type KeyValueStorage } from '@/shared'
import { scenarios } from '@/data'
import { canHipShoot } from '@/engine/rules'
import { useGameSessionStore, useWorkbenchStore } from '@/stores'

/**
 * 开局天气可选（只给教学剧本 Intro: Vitebsk，用户 2026-11-15 口径）
 *
 * 用途：用户自己切天气做测试。两档＝「按剧本原值」（Limited Flight，默认）与 Normal；
 * 选定后**开局即冻结**（写进会话记录，随存档保持），读档后不能再改；
 * `scenarios.json` 的 `firstWeather` 仍是默认值，不改数据。
 */

function boot(scenarioId = 'Intro', storage: KeyValueStorage = createMemoryStorage()) {
  setActivePinia(createPinia())
  const game = useGameSessionStore()
  game.setSaveStorage(storage)
  // 工作台持有空军输入与存档盘面编解码器；先建好才能验证 weatherNormal 的同步
  const board = useWorkbenchStore()
  expect(game.setScenarioId(scenarioId)).toBe(true)
  return { game, board, storage }
}

const weatherOf = (id: string): 'restricted' | 'normal' =>
  scenarios.scenarios.find((item) => item.id === id)?.firstWeather ?? 'normal'

/** 剧本契约值 → 会话记录里的运行时值（`restricted` 在记录轨里记作 `limited`） */
const airOf = (id: string): 'limited' | 'normal' =>
  weatherOf(id) === 'restricted' ? 'limited' : 'normal'

describe('开局天气可选（只教学剧本）', () => {
  it('默认＝按剧本原值：Intro 仍是 Limited Flight，低空扫射入口关闭', async () => {
    const { game, board } = boot()
    expect(game.firstWeatherChoice).toBe('scenario')
    expect(game.startGame()).toBe(true)
    // 空军输入由 `records.weather` 同步（Vue watch 在微任务里刷新）
    await nextTick()
    expect(game.records?.weather.air).toBe(airOf('Intro'))
    expect(weatherOf('Intro')).toBe('restricted')
    expect(board.airInputs.weatherNormal).toBe(false)
    expect(canHipShoot('axis', board.airInputs.weatherNormal)).toBe(false)
  })

  it('选 Normal：开局天气记 normal，airInputs.weatherNormal 为真，低空扫射入口放行', async () => {
    const { game, board } = boot()
    expect(game.setFirstWeatherChoice('normal')).toBe(true)
    expect(game.startGame()).toBe(true)
    await nextTick()
    expect(game.records?.weather.air).toBe('normal')
    expect(board.airInputs.weatherNormal).toBe(true)
    // `hipShootEntryEligible` 的第一道门就是 canHipShoot(方, weatherNormal)
    expect(canHipShoot('axis', board.airInputs.weatherNormal)).toBe(true)
  })

  it('剧本页先选 Intro 再点天气（尚未进初设）：选择落在 Intro 上，开局即 normal', async () => {
    // 实测路径：剧本页的卡片选中只是界面本地状态，会话 store 还停在别的剧本；
    // 天气单选就在这一步被点。判据必须看「正在配置的剧本」，不是会话里那条旧剧本。
    const { game, board } = boot('1')
    expect(game.setFirstWeatherChoice('normal', 'Intro')).toBe(true)
    expect(game.setScenarioId('Intro')).toBe(true)
    expect(game.startGame()).toBe(true)
    await nextTick()
    expect(game.records?.weather.air).toBe('normal')
    expect(board.airInputs.weatherNormal).toBe(true)
  })

  it('其他剧本不出现该入口：设置被拒，开局仍取剧本原值', () => {
    const { game } = boot('1')
    expect(game.setFirstWeatherChoice('normal')).toBe(false)
    expect(game.firstWeatherChoice).toBe('scenario')
    expect(game.startGame()).toBe(true)
    expect(game.records?.weather.air).toBe(airOf('1'))
  })

  it('读档后保持所选，且不能再改', async () => {
    const storage = createMemoryStorage()
    const first = boot('Intro', storage)
    expect(first.game.setFirstWeatherChoice('normal')).toBe(true)
    expect(first.game.startGame()).toBe(true)
    expect(first.game.saveNow()).toBe(true)

    const second = boot('Intro', storage)
    expect(second.game.loadNow()).toBe(true)
    await nextTick()
    expect(second.game.records?.weather.air).toBe('normal')
    // 读档后空军输入随记录恢复（不是靠开局默认值凑巧为真）
    expect(second.board.airInputs.weatherNormal).toBe(true)
    expect(second.game.setFirstWeatherChoice('scenario')).toBe(false)
    expect(second.game.records?.weather.air).toBe('normal')
  })
})
