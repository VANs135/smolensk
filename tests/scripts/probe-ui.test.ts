import { describe, expect, it } from 'vitest'

import {
  HELP_TEXT,
  PROBE_DEFAULT_OUT,
  PROBE_DEFAULT_PORT,
  PROBE_DEFAULT_SCENARIO,
  assertDistReady,
  parseArgs,
} from '../../scripts/probe-ui.mjs'

/**
 * UI 探针的参数面（`scripts/probe-ui.mjs`）
 *
 * 探针本身要真浏览器才有意义，故这里只钉**纯函数与报错面**（可在 Node 里跑）：
 *   ① 默认值就是文档写的那几个（端口避开 5174、输出名固定）；
 *   ② 每个开关只吃自己的值，缺值/超范围/未知参数一律抛错（不静默降级）；
 *   ③ `assertDistReady` 在没 build 过时明确报「先 build」，不替人 build。
 */
describe('UI 探针：参数解析与前置检查', () => {
  it('★ 默认值：dist / 端口 / 输出名 / 剧本留空 / 教学模式', () => {
    const options = parseArgs([])
    expect(options.dist).toBe('dist')
    expect(options.out).toBe(PROBE_DEFAULT_OUT)
    expect(options.port).toBe(PROBE_DEFAULT_PORT)
    expect(options.port).not.toBe(5173)
    expect(options.port).not.toBe(5174)
    expect(options.scenario).toBe(PROBE_DEFAULT_SCENARIO)
    expect(options.mode).toBe(2)
    expect(options.preset).toBe(false)
    expect(options.zoom).toBe(0)
    expect(options.focus).toBeNull()
    expect(options.steps).toBeNull()
    expect(options.keepOpen).toBe(false)
  })

  it('★ 全量开关各就各位（含 --focus 的 "x,y" 与 --zoom 次数）', () => {
    const options = parseArgs([
      '--dist',
      'E:/tmp/dist-x',
      '--out',
      'E:/tmp/shot.png',
      '--scenario',
      'Short Campaign',
      '--mode',
      '1',
      '--preset',
      '--zoom',
      '6',
      '--focus',
      '820,520',
      '--steps',
      'E:/tmp/steps.mjs',
      '--port',
      '5199',
      '--keep-open',
    ])
    expect(options.dist).toBe('E:/tmp/dist-x')
    expect(options.out).toBe('E:/tmp/shot.png')
    expect(options.scenario).toBe('Short Campaign')
    expect(options.mode).toBe(1)
    expect(options.preset).toBe(true)
    expect(options.zoom).toBe(6)
    expect(options.focus).toEqual({ x: 820, y: 520 })
    expect(options.steps).toBe('E:/tmp/steps.mjs')
    expect(options.port).toBe(5199)
    expect(options.keepOpen).toBe(true)
  })

  it('★ 错参不静默：未知参数 / 缺值 / 模式越界 / focus 少一个数 都抛错', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/未知参数/)
    expect(() => parseArgs(['--out'])).toThrow(/需要一个值/)
    expect(() => parseArgs(['--out', '--preset'])).toThrow(/需要一个值/)
    expect(() => parseArgs(['--mode', '9'])).toThrow(/1–4/)
    expect(() => parseArgs(['--focus', '820'])).toThrow(/x,y/)
    expect(() => parseArgs(['--zoom', '-1'])).toThrow(/非负整数/)
  })

  it('★ --help 只置标志，不触发解析报错', () => {
    expect(parseArgs(['--help']).help).toBe(true)
    expect(HELP_TEXT).toContain('--steps')
    expect(HELP_TEXT).toContain('--preset')
  })

  it('★ 没 build 过就报「先 build」，不替人 build', () => {
    expect(() => assertDistReady('E:/tmp/__probe-ui-no-dist__')).toThrow(/先跑 npx vite build/)
  })
})
