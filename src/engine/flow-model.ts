import type { SopStep } from '@/engine/session-flow'

/**
 * 流程条**只读投影**（UI2）
 *
 * ## 纪律
 *   - 本模块不判断规则，只把 store / 引擎已经给出的**事实**整理成一份展示模型：
 *     行动方、操作者、阻断、下一步按钮文案与可用态。
 *   - 组件不得再各算一份；`FlowStrip` 的 bar 与 panel 两种形态都读同一份 `FlowGuide`。
 *   - 所有输入均为既有事实（`gameSession.guidance`、`workbench.segmentStep`、
 *     `workbench.actionRefusal`、`setup.applied/finished` 等），这里没有新的判定。
 */

export type FlowForm = 'none' | 'created' | 'advancing' | 'awaiting' | 'terminated'

export interface FlowGuideInput {
  sessionExists: boolean
  form: FlowForm
  terminated: boolean
  awaiting: boolean
  questionRule: string | null
  /** 当前 SOP 步（`SOP_STEPS[guidance.index]`）；未开局 / 无法确定时为 null */
  currentStep: SopStep | null
  currentIndex: number | null
  sopLength: number
  firstPlayer: string | null
  /** 段名（已由调用方按会话优先/本地兜底折算好） */
  phaseLabel: string
  /** 本段环节；无环节时为 null */
  segmentStep: { label: string; rule: string } | null
  /** 段内环节位置；Pre-Turn 这类「只有子步、不分环」的情形为 null */
  segmentPosition: { index: number; total: number } | null
  segmentStepsCount: number
  participatingUnitCount: number
  refusal: { rule: string; reason: string } | null
  actionHint: string
  /** 最近一次连跑去向（B5） */
  advanceOutcome: {
    steps: number
    stoppedBy: 'question' | 'terminated' | 'refused' | 'limit' | 'player'
  } | null
  setupApplied: boolean
  setupFinished: boolean
  agreedRecorded: boolean
  saveError: { rule: string; reason: string } | null
}

export interface FlowBlocker {
  kind: 'warning' | 'danger'
  rule: string | null
  text: string
}

export interface FlowGuide {
  formLabel: string
  phaseLabel: string
  segmentLabel: string
  todoLabel: string
  /** 行动方：先手方 / 后手方 / 回合级（来自 SOP 步的 role，不改规则） */
  actingSideLabel: string
  /** 操作者：玩家操作 / 待答 / 自动推进 / 初设 / 已终止 */
  decisionRoleLabel: string
  canAdvance: boolean
  nextActionLabel: string
  nextActionTarget: 'advance' | 'setup' | 'scenario'
  stageIndex: number | null
  stageTotal: number
  advanceLabel: string
  /** 本环节可参与数（只复制事实，不重算谓词） */
  todoCount: number
  blockers: FlowBlocker[]
  /** 地图上方那一条只留一句「现在该做什么」 */
  hint: string
}

function formText(form: FlowForm): string {
  switch (form) {
    case 'created':
      return '未开局'
    case 'advancing':
      return '进行中'
    case 'awaiting':
      return '待答（须作答）'
    case 'terminated':
      return '已终止'
    default:
      return '未建会话'
  }
}

/** 去掉标签里的括号注记（显示层口径；结构化信息仍在数据侧） */
function bare(text: string): string {
  return text.replace(/（[^）]*）/gu, '').trim()
}

function actingSide(step: SopStep | null, firstPlayer: string | null): string {
  if (step === null) return '—'
  if (step.role === 'first') return `先手方${firstPlayer === null ? '' : ` ${firstPlayer}`}`
  if (step.role === 'second') return '后手方'
  return '回合级'
}

function decisionRole(input: FlowGuideInput): string {
  if (!input.sessionExists) return '初设（未开局）'
  if (input.terminated) return '已终止'
  if (input.awaiting) return '待答（须作答）'
  if (input.currentStep?.driver === 'automatic') return '自动推进'
  return '玩家操作'
}

function startHint(input: FlowGuideInput): string {
  return input.setupApplied && !input.setupFinished
    ? '去初设队列（完成初设即开局）'
    : '去选剧本 / 共识'
}

function advanceLabel(input: FlowGuideInput): string {
  const outcome = input.advanceOutcome
  if (outcome === null) return '—'
  if (outcome.steps === 0) {
    return outcome.stoppedBy === 'question' ? '停下待答（等作答）' : '未推进'
  }
  const where =
    outcome.stoppedBy === 'question'
      ? '待答'
      : outcome.stoppedBy === 'terminated'
        ? '本局终止'
        : outcome.stoppedBy === 'refused'
          ? '被内核拒绝'
          : outcome.stoppedBy === 'limit'
            ? '连跑上限'
            : (input.currentStep?.label ?? '玩家环节')
  return `自动段 ${outcome.steps} 步 → ${where}`
}

function buildBlockers(input: FlowGuideInput): FlowBlocker[] {
  const blockers: FlowBlocker[] = []
  if (input.awaiting) {
    blockers.push({
      kind: 'warning',
      rule: input.questionRule,
      text: '停下待答：在待答面板作答后，再点「进入下一环节」。',
    })
  }
  if (input.refusal !== null) {
    blockers.push({
      kind: 'warning',
      rule: input.refusal.rule,
      text: `这一步本环节不能做：${input.refusal.reason}`,
    })
  }
  if (input.sessionExists && !input.agreedRecorded) {
    blockers.push({
      kind: 'warning',
      rule: '4.0',
      text: '开局共识结论尚未写入日志；点「进入下一环节」会按当前勾选（默认一条都不用）写入。',
    })
  }
  if (input.saveError !== null) {
    blockers.push({
      kind: 'danger',
      rule: input.saveError.rule,
      text: `存档被拒：${input.saveError.reason}（详见顶栏「存档 / 读档」对话框）`,
    })
  }
  return blockers
}

export function buildFlowGuide(input: FlowGuideInput): FlowGuide {
  const canAdvance =
    !input.terminated &&
    !input.awaiting &&
    (!input.sessionExists || input.form === 'created' || input.form === 'advancing')

  const nextActionTarget: FlowGuide['nextActionTarget'] = !input.sessionExists
    ? input.setupApplied && !input.setupFinished
      ? 'setup'
      : 'scenario'
    : 'advance'

  const segmentLabel = (() => {
    if (input.segmentStep === null) {
      return input.segmentStepsCount === 0 ? '（本段无环节）' : '（本段无玩家环节）'
    }
    const position = input.segmentPosition
    if (position === null) return `${input.segmentStep.label}（${input.segmentStep.rule}）`
    return `${input.segmentStep.label}（${input.segmentStep.rule}）· 第 ${position.index + 1}/${position.total} 环`
  })()

  return {
    formLabel: formText(input.form),
    phaseLabel: bare(input.phaseLabel),
    segmentLabel,
    todoLabel: input.segmentStep === null ? '—' : `本环节可参与 ${input.participatingUnitCount} 枚`,
    actingSideLabel: actingSide(input.currentStep, input.firstPlayer),
    decisionRoleLabel: decisionRole(input),
    canAdvance,
    nextActionLabel: input.sessionExists ? '进入下一环节' : startHint(input),
    nextActionTarget,
    stageIndex: input.currentIndex,
    stageTotal: input.sopLength,
    advanceLabel: advanceLabel(input),
    todoCount: input.participatingUnitCount,
    blockers: buildBlockers(input),
    hint: input.actionHint,
  }
}
