<script setup lang="ts">
import { computed, watch } from 'vue'

import { BaseButton, BaseDialog, BaseTag } from '@/components/base'
import { DATA_VERSION } from '@/data'
import { RNG_ALGORITHM } from '@/engine/rng'
import { SAVE_FILE_VERSION, classifySaveError } from '@/engine/save-file'
import { SESSION_SAVE_VERSION } from '@/engine/session'
import type { SessionForm } from '@/engine/session-types'
import { useGameSessionStore, useUiStore } from '@/stores'

/**
 * 存档 / 读档界面（W7 C15）
 *
 * ## 它是什么
 *   把 W6 D1 的存档数据层（`engine/save-file.ts` + `stores/session.ts`）摆成一个**独立入口**：
 *   顶栏「存档 / 读档」按钮打开本对话框 —— 与对局在哪一步无关（**任意环节都可存档**），
 *   会话的四种形态（未开局 / 可推进 / 待答 / 已终止）都能存、都能读回。
 *
 * ## 三件事说清楚（对应用户要求）
 *   ① **存档槽**：本作只有一个槽（`SAVE_SLOT_KEY`）——摘要给出剧本 / 回合阶段 / 形态 /
 *      写盘时间 / 种子与掷骰游标 / 日志条数 / 共识结论，以及四层版本号（存档格式 · 数据契约 ·
 *      会话容器 · 掷骰算法）；
 *   ② **进行中会话的恢复提示**：档里形态是 `awaiting` 时，读回后会**照旧停在待答**
 *      （连问题一起恢复：题号 / 类别 / 应答方 / 题面），不是「出错」；
 *   ③ **版本不匹配提示**：四层版本任一层不符即拒读 —— 归类与措辞由引擎的
 *      `classifySaveError` 给（本组件不解析原因字符串），并附「为什么拒」与「怎么办」。
 *
 * ## 分层纪律
 *   一切校验与摘要来自数据层（`describeSaveFile` 内部走完整读档校验）；本组件不碰 localStorage、
 *   不改存档内容，只调 store 的 `saveNow / loadNow / clearSlotNow / refreshSlotNow`。
 */

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const gameSession = useGameSessionStore()
const ui = useUiStore()

/** 会话形态的中文名（未开局 = null） */
const FORM_LABELS: Record<SessionForm, string> = {
  created: '未开局',
  advancing: '可推进',
  awaiting: '待答（须作答）',
  terminated: '已终止',
}

/** 当前会话形态名（null = 尚未建会话） */
const formLabel = computed(() =>
  gameSession.form === null ? '未建会话' : FORM_LABELS[gameSession.form],
)

/** 槽摘要（null = 无档 / 读不出） */
const slot = computed(() => gameSession.slot)

/** 存档错误归类（引擎给说明与建议；null = 无错） */
const errorInfo = computed(() =>
  gameSession.saveError === null ? null : classifySaveError(gameSession.saveError.reason),
)

/** 是否属于「版本不匹配」（要单独醒目提示的那一类） */
const versionMismatch = computed(() => errorInfo.value?.kind === 'versionMismatch')

/** 档里的进行中会话摘要（无待答为 null） */
const awaiting = computed(() => slot.value?.awaiting ?? null)

/** 关对话框 */
function close(): void {
  emit('update:open', false)
}

/** 槽摘要的一行话（用于通知） */
function slotLine(): string {
  const info = slot.value
  if (info === null) return '（无摘要）'
  return `剧本 ${info.scenarioId} · ${info.scenarioName}｜第 ${info.turn} 回合 · ${info.phase}｜形态 ${FORM_LABELS[info.form]}`
}

/** 保存到槽（四形态皆可） */
function saveNow(): void {
  const ok = gameSession.saveNow()
  if (ok) {
    ui.pushToast('success', `已保存到槽：${slotLine()}`)
    return
  }
  ui.pushToast(
    'danger',
    `保存失败：${errorInfo.value?.detail ?? gameSession.saveError?.reason ?? '未知原因'}`,
  )
}

/** 从槽读档 */
function loadNow(): void {
  const ok = gameSession.loadNow()
  if (ok) {
    const hint = awaiting.value === null ? '' : `（会停在待答：${awaiting.value.questionId}）`
    ui.pushToast('success', `已读档：${slotLine()}${hint}`)
    return
  }
  ui.pushToast(
    'danger',
    `读档被拒：${errorInfo.value?.detail ?? gameSession.saveError?.reason ?? '未知原因'}`,
  )
}

/** 清空槽（不影响当前会话） */
function clearNow(): void {
  const ok = gameSession.clearSlotNow()
  ui.pushToast(ok ? 'info' : 'danger', ok ? '存档槽已清空（当前会话未受影响）' : '清档失败')
}

/** 重新读槽摘要（判断「有没有档」「档还能不能读」） */
function refreshNow(): void {
  gameSession.refreshSlotNow()
  const info = slot.value
  ui.pushToast(
    info === null ? 'warning' : 'info',
    info === null
      ? `槽不可读：${errorInfo.value?.detail ?? '槽为空'}`
      : `槽摘要已刷新：${slotLine()}`,
  )
}

/** 打开时先刷一次摘要（保证显示的是「此刻」的槽内容，可能与上次打开时不同） */
watch(
  () => props.open,
  (open) => {
    if (open) gameSession.refreshSlotNow()
  },
)

/** 读档预检：槽摘要非空即说明这一档**通过了完整校验**（版本 / 剧本 / 容器 / 种子自洽） */
const slotUsable = computed(() => slot.value !== null)
</script>

<template>
  <BaseDialog
    :open="props.open"
    title="存档 / 读档（W7 C15）"
    width="640px"
    z-index="var(--z-dialog-top)"
    @update:open="emit('update:open', $event)"
  >
    <!-- ── ① 当前会话与动作 ── -->
    <p class="muted">
      本作**只有一个存档槽**（浏览器本地存储）。存档内容六项：状态 / 种子 / 日志游标 /
      进行中会话（含待答问题）/ 共识开关结论 / 剧本与数据版本；**任意环节都可存档** ——
      四种会话形态（未开局 · 可推进 · 待答 · 已终止）都能存、都能读回。
    </p>
    <p class="row">
      <BaseTag :kind="gameSession.session === null ? 'neutral' : 'info'">
        当前会话：{{ formLabel }}
      </BaseTag>
      <BaseTag :kind="gameSession.storage === null ? 'warning' : 'success'">
        {{ gameSession.storage === null ? '无存储介质（不落盘）' : '本地存储可用' }}
      </BaseTag>
      <BaseTag :kind="slotUsable ? 'success' : 'neutral'">
        {{ slotUsable ? '槽里有档' : '槽为空或不可读' }}
      </BaseTag>
    </p>

    <div class="row">
      <BaseButton
        variant="primary"
        size="sm"
        :disabled="gameSession.session === null"
        @click="saveNow()"
      >
        保存到槽
      </BaseButton>
      <BaseButton variant="secondary" size="sm" :disabled="!slotUsable" @click="loadNow()">
        从槽读档
      </BaseButton>
      <BaseButton variant="ghost" size="sm" @click="refreshNow()">刷新槽摘要</BaseButton>
      <BaseButton variant="ghost" size="sm" @click="clearNow()">清空槽</BaseButton>
    </div>

    <!-- ── ② 存档槽摘要 ── -->
    <hr />
    <p v-if="slot === null" class="muted">
      槽为空（或内容读不出）—— 有会话时点「保存到槽」即建立一档。
    </p>
    <template v-else>
      <p class="row">
        <BaseTag kind="info">{{ slot.scenarioId }} · {{ slot.scenarioName }}</BaseTag>
        <BaseTag kind="neutral">存档格式 v{{ slot.saveVersion }}</BaseTag>
        <BaseTag kind="neutral">数据契约 {{ slot.dataVersion }}</BaseTag>
        <span class="num muted">写盘 {{ slot.savedAt }}</span>
      </p>
      <table class="table">
        <tbody>
          <tr>
            <th>形态</th>
            <td>{{ FORM_LABELS[slot.form] }}</td>
            <th>回合 / 阶段</th>
            <td class="num">第 {{ slot.turn }} 回合 · {{ slot.phase }}</td>
          </tr>
          <tr>
            <th>种子</th>
            <td class="num">{{ slot.seed }}</td>
            <th>掷骰游标</th>
            <td class="num">已掷 {{ slot.drawCount }} 次</td>
          </tr>
          <tr>
            <th>日志条数</th>
            <td class="num">{{ slot.logEntries }}</td>
            <th>终止原因</th>
            <td>{{ slot.termination ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p class="num muted">
        共识开关（读档一并恢复）：
        {{
          slot.consensus
            .map(
              (entry) =>
                `${entry.item.slice(0, 8)}…=${entry.adopted === null ? '未答' : entry.adopted ? '采纳' : '不采纳'}`,
            )
            .join('｜') || '无'
        }}
      </p>

      <!-- ── ③ 进行中会话的恢复提示 ── -->
      <p v-if="awaiting !== null" class="notice notice--info num">
        <BaseTag kind="warning">进行中会话</BaseTag>
        这一档停在**待答**：读回后会照旧停下等作答，不会跳过这一步。<br />
        题号 <code>{{ awaiting.questionId }}</code
        >｜类别 {{ awaiting.kind }}｜应答方 {{ awaiting.responder === 'axis' ? '轴心国' : '苏联'
        }}<br />
        题面：{{ awaiting.prompt }}
      </p>
    </template>

    <!-- ── ④ 版本不匹配提示 ── -->
    <p v-if="errorInfo !== null && versionMismatch" class="notice notice--danger num">
      <BaseTag kind="danger">版本不匹配</BaseTag>
      涉及层：<strong>{{ errorInfo.layer ?? '（未能定位到具体层）' }}</strong>
      <template v-if="errorInfo.expected !== null || errorInfo.actual !== null">
        ｜期望 {{ errorInfo.expected ?? '—' }}，实际 {{ errorInfo.actual ?? '—' }}
      </template>
      <br />{{ errorInfo.detail }}<br />
      <span class="muted">怎么办：{{ errorInfo.hint }}</span>
    </p>

    <!-- ── ⑤ 其它存档错误（无档 / 无介质 / 损坏 / 不可复算…） ── -->
    <p v-else-if="errorInfo !== null" class="notice notice--warn num">
      <BaseTag kind="warning">{{ errorInfo.kind }}</BaseTag>
      {{ errorInfo.detail }}<br />
      <span class="muted">怎么办：{{ errorInfo.hint }}</span>
    </p>

    <!-- ── ⑥ 版本四层（口径说明） ── -->
    <hr />
    <details class="layers">
      <summary class="muted">四层版本（任一层不符即拒读；本作不做静默迁移）</summary>
      <p class="num muted">
        · 存档文件格式 v{{ SAVE_FILE_VERSION }}（外壳字段结构）<br />
        · 数据契约 {{ DATA_VERSION }}（单位库 / 图表 / 剧本等数据文件）<br />
        · 会话容器 v{{ SESSION_SAVE_VERSION }}（会话信封：状态 / 日志 / 待答问题）<br />
        · 掷骰算法 {{ RNG_ALGORITHM }}（换算法后旧档不可复算）<br />
        另有两项**内容校验**：剧本号须在剧本库内、文件头剧本须与会话状态剧本一致；
        并检查种子—游标—内部状态自洽（决定这一档还能不能重放复算）。
      </p>
    </details>

    <template #footer>
      <BaseButton variant="ghost" size="sm" @click="close()">关闭</BaseButton>
    </template>
  </BaseDialog>
</template>

<style scoped>
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-2) 0;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
  margin: var(--space-1) 0;
}

.table th,
.table td {
  border-bottom: 1px solid var(--color-rule);
  padding: 2px var(--space-1);
  text-align: left;
  vertical-align: top;
}

.table th {
  color: var(--color-muted);
  font-weight: 500;
  width: 22%;
}

.notice {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  border-left: 3px solid var(--color-accent);
  background: var(--color-bg-2);
  margin: var(--space-2) 0;
  line-height: 1.7;
}

.notice--info {
  border-left-color: var(--color-accent-2);
}

.notice--danger {
  border-left-color: var(--color-danger);
}

.notice--warn {
  border-left-color: var(--color-accent);
}

.layers {
  margin: var(--space-2) 0;
}

.muted {
  color: var(--color-muted);
  font-size: var(--text-sm);
}

.num {
  font-size: var(--text-sm);
}

hr {
  border: none;
  border-top: 1px solid var(--color-rule);
  margin: var(--space-3) 0;
}
</style>
