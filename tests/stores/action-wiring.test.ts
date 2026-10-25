import { readFileSync } from 'node:fs'
import { globSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { UNGATED_ACTIONS, type UngatedKind } from '@/stores/action-wiring'

/**
 * ★ 用户 2026-10-25「补约 48 个缺口」⇒ 交出的不是"48 处改动"，而是**一张不许漂移的账**：
 *
 *   每个「界面能点到、并且**写盘面**」的 store 入口，必须落在下面两类之一 ——
 *     ① **有环节闸**：函数体里出现 `requireAction('<key>')`（判据的唯一实现在 `ACTION_GATES`）；
 *     ② **已登记归类**：`UNGATED_ACTIONS` 里一格一条，`kind` 说明它为什么**不该**有环节闸
 *        （裁判工具 / 状态机 / 草稿 / 原文没给时机 / 选格态 / 初设）。
 *
 * 为什么需要这条：此前"有没有闸门"只能靠人肉比对（缺口清单里那 48 条就是这么数出来的），
 * 新增一个写盘面却不分类的入口没有任何东西会拦。现在它会红。
 *
 * 判据是**源码级别**的（仓库没有组件挂载测试）：扫 `.vue` 里 `workbench.X(` / `containers.X(` /
 * `setup.X(` 的调用名，再扫 `src/stores/*.ts` 的函数体。
 */

const STORE_FILES = [
  'src/stores/workbench.ts',
  'src/stores/containers.ts',
  'src/stores/setup.ts',
  'src/stores/map-view.ts',
]

/** 取函数体（按花括号配对；只看顶层 `function X(` 的定义） */
function bodiesOf(text: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /\n {2}(?:async )?function ([a-zA-Z0-9_]+)\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const brace = text.indexOf('{', m.index + m[0].length)
    if (brace < 0) continue
    let depth = 1
    let i = brace + 1
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth += 1
      else if (text[i] === '}') depth -= 1
      i += 1
    }
    if (!out.has(m[1]!)) out.set(m[1]!, text.slice(brace, i))
  }
  return out
}

/** 组件里点得到的 store 动作名 */
function uiReachedNames(): Set<string> {
  const names = new Set<string>()
  const files = globSync('src/components/**/*.vue')
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const re = /(?:workbench|containers|setup)\.([a-zA-Z0-9_]+)\(/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) names.add(m[1]!)
  }
  return names
}

/** 判"写盘面"：改 `.value` / 动算子账（`units` / `deadPile`）/ push / splice */
function writesBoard(body: string): boolean {
  return /\.value\s*=|units\.value|deadPile\.value|\.push\(|\.splice\(/.test(body)
}

function gatedKeys(body: string): string[] {
  return [...body.matchAll(/requireAction\('([a-zA-Z.]+)'/g)].map((m) => m[1]!)
}

describe('动作接线账：每个写盘面入口要么有环节闸、要么登记了"为什么不该有"', () => {
  const bodies = new Map<string, string>()
  for (const file of STORE_FILES) {
    for (const [name, body] of bodiesOf(readFileSync(file, 'utf8'))) {
      if (!bodies.has(name)) bodies.set(name, body)
    }
  }
  const reached = uiReachedNames()

  it('★ 覆盖：所有"界面能点到 + 写盘面"的入口都已分类（新增一个不分类就红）', () => {
    const unclassified: string[] = []
    for (const name of [...reached].sort()) {
      const body = bodies.get(name)
      if (body === undefined) continue // 不是 store 函数（投影/常量）
      if (!writesBoard(body)) continue
      if (gatedKeys(body).length > 0) continue
      if (name in UNGATED_ACTIONS) continue
      unclassified.push(name)
    }
    expect(
      unclassified,
      `这些入口写盘面、却既没有 requireAction 也没登记归类：\n${unclassified.join('\n')}`,
    ).toEqual([])
  })

  it('★ 登记表里的 `gated` 条目确实带了那道闸（防止"标了已加闸、其实没加"）', () => {
    const wrong: string[] = []
    for (const [name, entry] of Object.entries(UNGATED_ACTIONS)) {
      const body = bodies.get(name)
      expect(body, `${name} 不是 store 里的函数（登记表与实现脱节）`).toBeDefined()
      if (entry.kind !== 'gated') continue
      expect(entry.key, `${name} 标了 gated 却没写 key`).toBeDefined()
      if (!gatedKeys(body!).includes(entry.key!)) wrong.push(`${name} → 缺 ${entry.key}`)
    }
    expect(wrong, `标了"已加闸"但函数体里没有那道闸：\n${wrong.join('\n')}`).toEqual([])
  })

  it('★ 非 `gated` 的条目**不该**带闸（带了说明分类与实现不符）', () => {
    const wrong: string[] = []
    for (const [name, entry] of Object.entries(UNGATED_ACTIONS)) {
      if (entry.kind === 'gated') continue
      const keys = gatedKeys(bodies.get(name) ?? '')
      if (keys.length > 0) wrong.push(`${name}（${entry.kind}）却有闸 ${keys.join(',')}`)
    }
    expect(wrong, `登记为"不该有环节闸"却加了闸：\n${wrong.join('\n')}`).toEqual([])
  })

  it('每条登记都必须写清理由（`why` 非空）', () => {
    const empty = Object.entries(UNGATED_ACTIONS)
      .filter(([, entry]) => entry.why.trim().length < 6)
      .map(([name]) => name)
    expect(empty).toEqual([])
  })

  it('分类词表不许出现"其他/待定"这类兜底（否则等于没分类）', () => {
    const kinds = new Set<UngatedKind>(Object.values(UNGATED_ACTIONS).map((entry) => entry.kind))
    const allowed: readonly UngatedKind[] = [
      'gated',
      'referee',
      /*
       * ★ 2026-10-25：新增的一类 —— 玩家本环节要做的事（掷表触发 / 落位选择 / 记忆标记）。
       * 它们不属 `ACTION_GATES` 那套"宣布类动作"，但**对局台必须留着**；
       * 与 `referee`（对局台按 `showsReferee` 不铺）是**相反**的两类，混在一起就会锁死流程。
       */
      'playerStep',
      'flowState',
      'noTiming',
      'pickMode',
      'draft',
      'pregame',
    ]
    for (const kind of kinds) expect(allowed).toContain(kind)
    // 六种"不加闸"的理由都必须真的用上（用不上说明分类过粗）
    for (const kind of allowed) {
      if (kind === 'gated') continue
      expect([...kinds], `没有任何条目用 ${kind}`).toContain(kind)
    }
  })
})
