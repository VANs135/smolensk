/**
 * 剧本级 AI 姿态（只影响 AI 的**选点偏好**，不参与任何规则判定）
 *
 * 用户 2026-11-23：「教学剧本苏军撤退方向优先守城」。
 *
 * Intro: Vitebsk 的城＝`19.27`（Minor City）与 `19.28`（Major City），两格在地图数据里都标
 * `role: major_city_victory_condition`（剧本卡：轴方夺取维捷布斯克两格 ⇒ 大胜）。
 * 因此该剧本的苏军守方撤退时**先靠拢这两格**，同档再看「离敌军最远」。
 */
export interface AiScenarioPosture {
  /** 撤退时优先靠拢的格（守城：城格本身即胜利条件所在） */
  readonly retreatAnchorHexes: readonly { readonly col: number; readonly row: number }[]
}

export const AI_SCENARIO_POSTURES: Readonly<Record<string, AiScenarioPosture>> = {
  Intro: {
    retreatAnchorHexes: [
      { col: 19, row: 27 },
      { col: 19, row: 28 },
    ],
  },
}

export function aiScenarioPostureOf(scenarioId: string): AiScenarioPosture | null {
  return AI_SCENARIO_POSTURES[scenarioId] ?? null
}

/**
 * AI 档位（用户 2026-11-23「先简化一下别的剧本AI逻辑，现在那些AI根本不堪使用，还卡」）
 *
 * - `Intro` ＝ `full`：教学/纯 PVE 剧本，只有反应式决策，保留完整动作链；
 * - 其余剧本 ＝ `baseline`：只做机械动作（作答 / 战斗结算 / 补给损耗 / 初设 / 推进），
 *   不再自己发起移动、突袭、铁路、建造、空袭、弹幕、重建 —— 目标是不卡、行为可预期。
 *
 * 该档位只影响 AI 自己的选点，不改任何规则判据；以后要给某个剧本放开某一类动作，
 * 在这里加一条即可（不要在策略层写 `if scenarioId === ...`）。
 */
export type AiProfile = 'full' | 'baseline'

export function aiProfileOf(scenarioId: string): AiProfile {
  return scenarioId === 'Intro' ? 'full' : 'baseline'
}
