/**
 * 批 6：字号、数字、图标、设置分组、空态（源码守卫）
 *
 * 用户口径（2026-11-15）：
 *   ① RE / SP / T / MP / 回合 / 掷骰 / 格号走等宽数字，表格数值列右对齐；
 *   ② 清掉 9px / 11px 硬编码字号，落到既定档位；
 *   ③ 图标统一用同一套线性图标（BaseIcon），不再混 ▸ × + − ↗；
 *   ④ 设置抽屉按「视图 / 对局控制 / 记录器」分组，记录器说明进 `?`；
 *   ⑤ 空态能不给字就不给字（「—」或计数 0）。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = 'src'
const read = (path: string): string => readFileSync(path, 'utf8')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (path.endsWith('.vue') || path.endsWith('.css')) out.push(path)
  }
  return out
}

describe('批 6：字号 / 数字 / 图标 / 设置分组 / 空态', () => {
  it('不再有 9px / 11px 硬编码字号', () => {
    const offenders: string[] = []
    for (const file of walk(root)) {
      const text = read(file)
      text.split('\n').forEach((line, index) => {
        if (/font-size:\s*(9|11)px/.test(line)) offenders.push(`${file}:${index + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('数字列统一等宽并右对齐（表格 td/th）', () => {
    const css = read('src/styles/base.css')
    expect(css).toContain('td.num')
    expect(css).toContain('text-align: right')
  })

  it('图标统一到 BaseIcon，不再用散装字形', () => {
    expect(read('src/components/base/index.ts')).toContain(
      "default as BaseIcon } from './BaseIcon.vue'",
    )
    const icon = read('src/components/base/BaseIcon.vue')
    for (const name of ['chevron-right', 'chevron-down', 'close', 'plus', 'minus', 'external']) {
      expect(icon).toContain(name)
    }
    // 关闭 / 折叠 / 缩放 / 外链 都走图标（2026-11-26：左栏图标改手绘 svg，托盘已删）
    expect(read('src/components/map/MapDock.vue')).toContain('<BaseIcon name="close"')
    expect(read('src/views/GameTableView.vue')).toContain('<svg viewBox="0 0 24 24"')
    expect(read('src/components/game/BoxCard.vue')).toContain('<BaseIcon')
    expect(read('src/components/game/DecisionQueue.vue')).toContain('<BaseIcon')
    expect(read('src/components/game/MapActionPopover.vue')).toContain('<BaseIcon')
    expect(read('src/components/map/MapCanvas.vue')).toContain('<BaseIcon name="minus"')
    // 2026-11-25：开始台的「读取存档」入口随存档两入口收敛一并删掉，
    // 全仓已无外链入口 ⇒ 改为钉「不得再出现散装 ↗ 字形」。
    for (const file of [
      'src/views/HomeView.vue',
      'src/views/GameTableView.vue',
      'src/components/game/ChartTableDrawer.vue',
    ]) {
      expect(read(file), `${file} 仍有散装外链字形`).not.toContain('↗')
    }
  })

  it('设置抽屉分「视图 / 对局控制 / 记录器」三组，记录器说明进 ?', () => {
    const view = read('src/views/GameTableView.vue')
    expect(view).toContain('<h2>视图</h2>')
    expect(view).toContain('<h2>对局控制</h2>')
    expect(view).toContain('<h2>记录器</h2>')
    expect(view).not.toContain('gt__recorder-hint')
    expect(view).toContain('<RuleTip rule="记录器">')
  })

  it('空态不铺解释句，用「—」', () => {
    // 2026-11-26：底部托盘已删，不再列入清单
    for (const file of [
      'src/components/breakout/BreakoutPanel.vue',
      'src/components/game/CounterPicker.vue',
      'src/components/ops/OpsLossPicker.vue',
      'src/components/session/SettlementLogPanel.vue',
    ]) {
      const text = read(file)
      expect(text, `${file} 仍有解释性空态`).not.toMatch(/暂无|无可|没有可选|没有可承受/)
      expect(text, `${file} 空态未用破折号`).toContain('—')
    }
  })
})
