import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { DB_DIR, countersDirOfSide, selectCounterAssets } from '../../scripts/sync-counters.mjs'

/** 仓库根（本文件在 tests/scripts/ 下） */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 算子图档同步的**纯函数**部分（`scripts/sync-counters.mjs`）
 *
 * 只测「选哪些图、放到哪个目录」——真正的拷贝是 I/O，由脚本运行时完成（与其余 sync 脚本同一分工）。
 */

describe('sync-counters：图档落点与挑选', () => {
  it('阵营 → 子目录：轴心 / 苏联 / 中立（both）', () => {
    expect(countersDirOfSide('axis')).toBe('axis')
    expect(countersDirOfSide('soviet')).toBe('soviet')
    expect(countersDirOfSide('both')).toBe('markers')
    expect(countersDirOfSide('unknown')).toBe('markers')
  })

  it('只有 valued / verified 的算子会要图（classified 不进运行期）', () => {
    const assets = selectCounterAssets(
      [
        { fill_stage: 'valued', side: 'axis', images: { front: 'a_F.png', back: 'a_B.png' } },
        { fill_stage: 'classified', side: 'axis', images: { front: 'b_F.png', back: null } },
        { fill_stage: 'verified', side: 'soviet', images: { front: 'c_F.png', back: null } },
      ],
      [],
    )
    expect(assets.map((asset) => asset.file)).toEqual(['a_B.png', 'a_F.png', 'c_F.png'])
    expect(assets.find((asset) => asset.file === 'c_F.png')?.dir).toBe('soviet')
  })

  it('中立非战斗算子（SP / 空军基地 / 环形工事）归入 markers', () => {
    const assets = selectCounterAssets(
      [
        {
          fill_stage: 'valued',
          side: 'both',
          images: { front: 'Neutral_SP_1_F.png', back: 'Neutral_SP_1_B.png' },
        },
        {
          fill_stage: 'valued',
          side: 'both',
          images: { front: 'Neutral_Airbase_1.png', back: null },
        },
      ],
      [],
    )
    expect(assets).toHaveLength(3)
    expect(assets.every((asset) => asset.dir === 'markers')).toBe(true)
  })

  it('飞机图也一并纳入（kind=air）；单面算子只为正面要图', () => {
    const assets = selectCounterAssets(
      [],
      [
        {
          fill_stage: 'valued',
          side: 'axis',
          images: { front: 'Ge_Ju.52_F.png', back: 'Ge_Ju.52_B.png' },
        },
      ],
    )
    expect(assets.map((asset) => asset.kind)).toEqual(['air', 'air'])
  })

  it('同名图只拷一次（两方共用的中立算子）', () => {
    const images = { front: 'Neutral_Turn_F.png', back: null }
    const assets = selectCounterAssets(
      [
        { fill_stage: 'valued', side: 'both', images },
        { fill_stage: 'valued', side: 'both', images },
      ],
      [],
    )
    expect(assets).toHaveLength(1)
  })

  it('无 images / 空文件名的记录被跳过（不造不存在的路径）', () => {
    const assets = selectCounterAssets(
      [
        { fill_stage: 'valued', side: 'axis' },
        { fill_stage: 'valued', side: 'axis', images: { front: '', back: null } },
        { fill_stage: 'valued', side: 'axis', images: null },
      ],
      [],
    )
    expect(assets).toEqual([])
  })

  /**
   * ★ M10①（c）资产闸门：**库里引用的图必须真的在 `public/counters/` 下**
   *
   * 这类缺口肉眼看不见（数据是好的、类型也对），只有渲染时才发现「算子没图」：
   * 实测 2026-09-15 —— 三支铁路修理单位推进到 `valued` 后忘跑 `sync-counters`，
   * `Ge_I-2_RR_Bn_F.png` / `Ru_West_RR_Rgt_F.png` 等 6 个文件根本不在盘上
   * （本用例即那次缺口的回归锚点：改数据不重跑同步脚本 ⇒ 这里先红）。
   */
  it('产物一致性：源库里每个可加载记录的图都在 public/counters 下', () => {
    const groundItems = JSON.parse(readFileSync(join(DB_DIR, 'units.json'), 'utf8')).items
    const aircraftItems = JSON.parse(readFileSync(join(DB_DIR, 'aircraft.json'), 'utf8')).items
    const assets = selectCounterAssets(groundItems, aircraftItems)
    expect(assets.length).toBeGreaterThan(600)
    const missing = assets.filter(
      (asset) => !existsSync(join(REPO_ROOT, 'public', 'counters', asset.dir, asset.file)),
    )
    expect(missing.map((asset) => `${asset.dir}/${asset.file}`)).toEqual([])
  })

  /**
   * ★ B19 控制标记：**规则标记**（不是算子）也要进 `markers/`
   *
   * 这类图**不被任何单位记录引用**（控制标记、回合标记、天气标记…），所以"按库记录拷图"
   * 永远不会带上它们；而渲染层照样会按文件名去取（`controlMarkerImageUrl`）。
   * 修前 `官方标记/` 目录整个没被同步 ⇒ 5.0c 的控制标记取不到图。
   */
  it('★ 官方标记（控制标记 / 回合标记 / 天气标记）也在盘上（它们不被任何记录引用）', () => {
    for (const file of [
      'Neutral_Control_Marker_F.png',
      'Neutral_Control_Marker_B.png',
      'Neutral_Turn_F.png',
      'Neutral_Flight.png',
    ]) {
      expect(
        existsSync(join(REPO_ROOT, 'public', 'counters', 'markers', file)),
        `缺 ${file}：请跑 node scripts/sync-counters.mjs`,
      ).toBe(true)
    }
  })
})
