import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * ⑧ 对局记录（用户回报 BUG 用）— 2026-11-09
 *
 * **只记事实**：每一步的回合/阶段/环节/行动方 + 玩家动作/拒绝原因/warning + 关键结算提交。
 * 不做规则判断、不改对局行为、不写存档、不发网络请求。
 *
 * 设计要点：
 * - `active` 是唯一响应式开关；事件缓冲放在**普通数组**里，避免 1 万多条记录全进 Vue 响应式系统；
 * - `note()` 全程 try/catch —— **记录失败绝不阻断游戏**；
 * - 导出为 JSONL（首行 header、其后一行一条事件），不压缩、不上传。
 */

export interface RecorderMeta {
  /** 应用版本（package.json version） */
  appVersion: string
  /** 构建期注入的提交号；无 git 时为 'unknown' */
  appCommit: string
  scenarioId: string
  scenarioName: string
  /** 对局组织方式：solo / pvp / pve；未设置为 null */
  mode: string | null
  aiSide: string | null
  /** 开局种子（取会话 RNG 的 seed；读档后仍是原种子） */
  seed: number | null
  turn: number
  phase: string
}

export interface RecorderEventInput {
  turn: number
  phase: string
  side: string
  /** 当前环节 id（如 `movement.modeAndMovement`）；无环节为 null */
  step: string | null
  /** 事件类别：log / settle / state */
  kind: string
  /** 日志级别（log 事件才有） */
  level?: string
  text?: string
  rule?: string | null
  detail?: unknown
}

interface RecorderEntry extends RecorderEventInput {
  seq: number
  at: string
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '"detail(unserializable)"'
  }
}

/** 单条事件 → JSON 行；`detail` 单独序列化，坏字段只丢自己，不丢整条事件 */
function eventJson(entry: RecorderEntry): string {
  const { detail, ...rest } = entry
  const head = safeJson(rest)
  if (detail === undefined) return head
  return `${head.slice(0, -1)},"detail":${safeJson(detail)}}`
}

function stampOf(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export const useRecorderStore = defineStore('recorder', () => {
  const active = ref(false)
  const count = ref(0)
  const startedAt = ref<string | null>(null)

  let meta: RecorderMeta | null = null
  let entries: RecorderEntry[] = []
  let seq = 0

  function start(next: RecorderMeta): void {
    /*
     * 同日二次开启 = **续写同一会话**（用户 2026-11-09）：
     * 关闭记录只是停止写入、不生成新文件；再次开启沿用同一 header（开始的回合/阶段/时间）
     * 与既有事件，最终导出的仍是一份完整日志。只有剧本/模式/种子变了才开新会话。
     */
    const sameSession =
      meta !== null &&
      meta.scenarioId === next.scenarioId &&
      meta.mode === next.mode &&
      meta.seed === next.seed
    if (!sameSession) {
      entries = []
      seq = 0
      count.value = 0
      startedAt.value = new Date().toISOString()
    }
    meta = { ...next }
    active.value = true
    if (sameSession && entries.length > 0) {
      // 留一条"续写"标记，方便交回日志时看清中间停过一段
      try {
        entries.push({
          seq: seq + 1,
          at: new Date().toISOString(),
          turn: next.turn,
          phase: next.phase,
          side: 'system',
          step: null,
          kind: 'marker',
          text: '记录继续（同一会话）',
        })
        seq += 1
        count.value = entries.length
      } catch {
        // 记录失败不阻断游戏
      }
    }
  }

  /** 记一条事实；未开启记录时静默跳过，任何异常都吞掉（不得影响对局） */
  function note(input: RecorderEventInput): void {
    if (!active.value || meta === null) return
    try {
      entries.push({ seq: seq + 1, at: new Date().toISOString(), ...input })
      seq += 1
      count.value = entries.length
    } catch {
      // 记录失败不阻断游戏
    }
  }

  /**
   * 停止记录并返回可保存的文本；未开启时返回 null（调用方不做任何弹窗）。
   *
   * 停止只"暂停写入"：**不生成新文件、不清空会话**（再次 `start()` 续写同一份），
   * 因此关闭后再点导出不会凭空多出一份；
   * 真要丢弃整个会话用 `cancel()`。
   */
  function stop(): { filename: string; text: string } | null {
    if (!active.value || meta === null) return null
    const now = new Date()
    const header = {
      type: 'header',
      appVersion: meta.appVersion,
      appCommit: meta.appCommit,
      scenarioId: meta.scenarioId,
      scenarioName: meta.scenarioName,
      mode: meta.mode,
      aiSide: meta.aiSide,
      seed: meta.seed,
      startedTurn: meta.turn,
      startedPhase: meta.phase,
      startedAt: startedAt.value,
      endedAt: now.toISOString(),
      entries: entries.length,
    }
    const lines = [safeJson(header), ...entries.map((entry) => eventJson(entry))]
    const safeMode = (meta.mode ?? 'unset').replace(/[^a-z0-9-]/gi, '')
    const filename = `smolensk-log-${safeMode}-${meta.scenarioId}-${stampOf(now)}.jsonl`
    const text = `${lines.join('\n')}\n`
    active.value = false
    count.value = entries.length
    return { filename, text }
  }

  /** 放弃本次记录（不生成文件） */
  function cancel(): void {
    active.value = false
    count.value = 0
    startedAt.value = null
    meta = null
    entries = []
    seq = 0
  }

  return { active, count, startedAt, start, note, stop, cancel }
})
