import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * E5（批 F·F2）：流程条「阶段 / 环节」两行**来源一致**（初设与 Pre-Turn 不错配）
 *
 * 病状：①「阶段」只读 `gameSession.records?.phase` ⇒ 初设期会话未建，恒报 '—'，
 *       而「环节」读 `workbench` 的段/子步 ⇒ 一行空、一行有内容；
 *     ② Pre-Turn 时 `ConsolePhase` 没有 `preTurn` ⇒ `workbench.phase` 回退到
 *       `localPhase='movement'` ⇒ 阶段报「回合准备」、环节却报**移动**环节。
 *
 * 修法（均在 `FlowStrip.vue`，**不动 store 的回退口径**）：
 *   ① 未开局 ⇒ 阶段行与环节行同源（把 `workbench.phase` 翻成段名）；
 *   ② 会话已建且 Pre-Turn ⇒ 环节行改报会话自己的子步（`gameSession.guidance?.step`）。
 *
 * 本文件按仓库既有惯例做**源码守卫**（无组件挂载测试依赖），钉住这两条不再回退。
 */

const STRIP = readFileSync('src/components/session/FlowStrip.vue', 'utf8')

describe('E5（批 F·F2）：流程条「阶段 / 环节」两行来源一致', () => {
  it('① 未开局：阶段行**不再**静默报 — ⇒ 与环节行同源（翻 workbench.phase 的段名）', () => {
    // 修前是 `if (phase === undefined) return '—'`
    expect(STRIP).not.toMatch(/if \(phase === undefined\) return '—'/)
    // 现在：未开局时读 PHASE_LABELS 映射（与环节行同源），不再是硬编码的 '—'
    expect(STRIP).toContain(
      'if (phase === undefined) return workbench.PHASE_LABELS[workbench.phase]',
    )
  })

  it('② Pre-Turn：环节行改报**会话自己的子步**（不问 workbench）', () => {
    expect(STRIP).toContain("phase === 'preTurn' && gameSession.guidance !== null")
    expect(STRIP).toContain('gameSession.guidance.step')
  })

  it('③ 未开局（无会话）时环节行**仍走原路**（验证页依赖 workbench.segmentStep，不得被 E5 改掉）', () => {
    // guidance 为 null（无会话）时不进入会话子步分支 ⇒ 仍读 workbench.segmentStep
    expect(STRIP).toContain('const step = workbench.segmentStep')
    expect(STRIP).toContain('workbench.segmentStepPosition')
  })

  it('④ store 只**暴露**段名常量表，不改回退口径（PHASE_LABELS 可读、不含回退逻辑）', () => {
    const bench = readFileSync('src/stores/workbench.ts', 'utf8')
    // 常量表本身未变（仍是 8 个段 + 无 preTurn）
    expect(bench).toContain("movement: 'C 移动'")
    expect(bench).toContain("combat: 'F 战斗'")
    // 只读暴露（return 里有 PHASE_LABELS）
    expect(bench).toContain('PHASE_LABELS,')
    // 回退口径（localPhase 初值 movement）仍在，未被改
    expect(bench).toContain("const localPhase = ref<ConsolePhase>('movement')")
  })
})
