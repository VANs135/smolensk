/**
 * 9.10a / 9.12：选项点数的合法切分（「退 k 格 + 吃 N-k 点」）候选表
 *
 * 规则原文（9.10a）：选项**总数必须完全被满足**；9.12 末段括注「有时这会限制可选为撤退的
 * 选项数量」——即撤退格数受**可撤退性**限制。故每个候选都是 `retreatHexes + lossPoints = options`，
 * 且损失点不超过该方当前可用军力（9.11）。
 *
 * 本模块只排**候选顺序**，不判合法性：
 * - 下落点事实（哪些格可退、是否必被消灭）一律来自 `planRetreatDestinations` 的成品阶梯；
 * - 是否真的能提交仍由 `resolveOptions`（引擎）在唯一判据处裁决。
 *
 * 顺序（AI 与「提交兜底」共用同一份）：
 * 1. **全员都有不会被消灭的落点**：k 从大到小（退得越多、吃得越少）；
 * 2. 全部吃成损失（9.10a 的另一种合法解）——排在「必死撤退」之前：把单位白送掉不如吃军力；
 * 3. 全员至少有落点但**都可能必被消灭**（9.12 兜底）：只在损失吃不动时才当最后手段。
 */

/** 该方某一枚单位在「退 distance 格」时的落点性质 */
export type OptionLanding = 'safe' | 'doomed' | 'none'

/** 「退 distance 格」的整侧预演 */
export interface OptionLadderStep {
  distance: number
  units: readonly { unitId: string; landing: OptionLanding }[]
  /** 每枚单位都存在**不会被消灭**的落点（含受敌方 ZOC 影响但不会被消灭） */
  allSafe: boolean
  /** 每枚单位都存在落点（可能全部必被消灭 ⇒ 9.12 的兜底消灭） */
  allHaveLanding: boolean
}

export type OptionRetreatLadder = readonly OptionLadderStep[]

/** 选项切分：撤退格数 + 损失点数（两者之和恒等于选项总数） */
export interface OptionSplit {
  retreatHexes: number
  lossPoints: number
}

/**
 * 候选切分（按偏好排序，已去重）
 *
 * `capacity`＝该结算方**当前**可用军力总量（9.11：任何单位承受的损失不得超过其可用的军力总量，
 * 选项损失同属战斗结果中的军力损失）。
 */
export function planOptionSplits(input: {
  options: number
  capacity: number
  ladder: OptionRetreatLadder
}): OptionSplit[] {
  const { options, capacity, ladder } = input
  if (options <= 0) return [{ retreatHexes: 0, lossPoints: 0 }]
  const out: OptionSplit[] = []
  const push = (retreatHexes: number, lossPoints: number): void => {
    if (retreatHexes + lossPoints !== options) return
    if (retreatHexes < 0 || lossPoints < 0) return
    if (lossPoints > capacity) return
    if (out.some((item) => item.retreatHexes === retreatHexes)) return
    out.push({ retreatHexes, lossPoints })
  }
  // ① 全员安全：k 从大到小
  for (const step of [...ladder].reverse()) {
    if (step.distance <= 0 || !step.allSafe) continue
    push(step.distance, options - step.distance)
  }
  // ② 全部吃成损失（比「必死撤退」优先：白送单位不如吃军力）
  push(0, options)
  // ③ 至少有落点但都可能必被消灭：只在损失吃不动时才用
  for (const step of [...ladder].reverse()) {
    if (step.distance <= 0 || !step.allHaveLanding) continue
    push(step.distance, options - step.distance)
  }
  return out
}

/** 首选切分；一条候选都没有时退回「全吃损失」，由引擎在确认处给出真实拒绝原因 */
export function chooseOptionSplit(input: {
  options: number
  capacity: number
  ladder: OptionRetreatLadder
}): OptionSplit {
  const splits = planOptionSplits(input)
  return splits[0] ?? { retreatHexes: 0, lossPoints: Math.max(0, input.options) }
}
