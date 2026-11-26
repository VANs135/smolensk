/**
 * 训练投影的版本与数据形状（TS ↔ Python 的训练交接面）
 *
 * 与 `src/ai/trace.ts` 的 `AI_IO_VERSION` 分开：
 * - `AI_IO_VERSION = 1` 仍描述现有运行时 trace（`AiSnapshot` / `AiStepRecord`）；
 * - `AI_TRAIN_VERSION = 2` 描述**训练专用**的稳定投影（实体 roster + 规范化观测 + canonical key）。
 *
 * 为什么不用同一个号：现有 trace 的生产者/消费者（界面、日志、既有测试）没有变化；
 * 训练投影是新增消费者。两个契约分开演进，避免为训练改坏运行时 trace。
 */

import type { AiHex, AiSide } from '../policy'

export const AI_TRAIN_VERSION = 2

/** 训练投影里的实体类别（只用于特征分组，不参与规则判定） */
export type TrainingEntityKind = 'ground' | 'air' | 'dump' | 'base'

/** 一局的实体快照：ID 已换成跨进程稳定的别名 */
export interface TrainingEntity {
  id: string
  kind: TrainingEntityKind
  side: AiSide
  /** 单位库主键 / 机型键 / 基地格键；dump 无此字段 */
  libraryId?: string
  label: string
  hex: AiHex
  /** 地面/飞机的军力步数；dump 无 */
  steps?: number
  /** 地面单位的模式；飞机/基地/dump 无 */
  mode?: string
  /** 地面单位的 RE；其它无 */
  re?: number
  /** 飞机状态（active/inactive） */
  airStatus?: string
  /** 补给站持有量 */
  sp?: number
  t?: number
  /** 空军基地等级 / 简易机场 */
  level?: number
  isAirstrip?: boolean
}

/**
 * 训练观测
 *
 * `state` 是 `AiSnapshot` 的稳定 ID 投影（保留规则投影的可解释性）；
 * `entities` 是给模型做实体特征/图结构用的紧凑 roster。
 * 两者都来自同一次 `snapshotOf`，不能由训练侧另拼。
 */
export interface TrainingObservation {
  version: number
  scenarioId: string
  turn: number
  phase: string
  segment: string
  segmentStepIndex: number
  activeSide: AiSide
  defenderSide: AiSide
  terminated: boolean
  locked: boolean
  state: Record<string, unknown>
  entities: TrainingEntity[]
}
