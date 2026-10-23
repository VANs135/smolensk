/**
 * 架构扫描（M10①）：把三类「眼睛看不见的退化」变成红灯，外加零调用导出白名单
 *
 * ## 为什么需要
 *   本工程不是 git 仓库、也没有组件测试基建，下面三类问题**编译得过、测试也不红**，
 *   只能靠人眼在整个仓里翻：
 *     (a) **组件里出现规则字面量**——把规则判断写进了视图层（本该在 `engine/`），
 *         一旦规则号或口径变了就没人知道；
 *     (b) **用了不存在的 CSS 变量**——`var(--color-border)` 这类打字错误浏览器**静默忽略**
 *         （实测三处面板 + 一处地图坞：边框/底色根本没生效，肉眼几乎看不出）；
 *     (c) **零调用导出**——「已实现但没人调用」的假象（本清单的符号级扫描每次都得人工重做）。
 *
 * ## 口径（都写成纯函数，便于单测与复用）
 *   · 只扫**声明为值**的导出（`export function|const|let|class`），类型导出不算；
 *   · 零调用＝符号名在**全树**（src+tests+scripts）只出现 1 次（即声明行本身）；
 *   · 白名单里的旧账不红，**新增**的零调用导出才红（`ZERO_CALL_WHITELIST`）。
 *
 * ## 用法
 *   命令行：`node scripts/check-arch.mjs`（`npm run check` 的第五关）
 *   单测：`tests/scripts/arch-scan.test.ts`
 */

/** 规则号字面量（`6.1` / `9.5a` / `13.2f` / `专规 2.4`） */
export const RULE_LITERAL_SOURCE = '(?:专规\\s*)?\\d+\\.\\d+[a-z]?(?:-[A-Z])?'

/**
 * 组件里「规则判断」的两种可判定形态
 *
 *   ① **比较/分支**：`=== '9.5a'`、`case '6.1':`、`includes('13.2f')` …；
 *   ② **成组出现**：`['6.1', '9.5a'].includes(rule)`、`const RULES = ['6.1']` ——
 *      视图里出现**规则号清单**必然是判据（展示用的单条规则号是 `rule: '13.3f'` 这种属性写法，不在此列）。
 */
export const RULE_COMPARISON_SOURCE = `(?:===|!==|==|!=|case\\s+|includes\\(|startsWith\\(|endsWith\\()\\s*['"]${RULE_LITERAL_SOURCE}['"]|(?:\\[|,)\\s*['"]${RULE_LITERAL_SOURCE}['"]`

/** 单条扫描结论 */
export function issue(file, line, kind, detail) {
  return { file, line, kind, detail }
}

/** 取 `<script>` 段（`<script setup lang="ts">` 等变体都算） */
export function scriptSectionOf(text) {
  const start = text.search(/<script\b[^>]*>/)
  if (start < 0) return ''
  const open = text.indexOf('>', start) + 1
  const end = text.indexOf('</script>', open)
  return end < 0 ? text.slice(open) : text.slice(open, end)
}

/** 行号（1 基） */
function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1
  return line
}

/**
 * (a) 组件/视图里比较规则字面量
 *
 * @param {{ sources: Map<string, string> }} input `sources` 为 `文件 → 文本`（只应传 .vue）
 * @returns {ReturnType<typeof issue>[]}
 */
export function scanRuleLiterals(input) {
  const out = []
  const pattern = new RegExp(RULE_COMPARISON_SOURCE, 'g')
  for (const [file, text] of input.sources) {
    const script = scriptSectionOf(text)
    const offset = text.indexOf(script)
    for (const match of script.matchAll(pattern)) {
      out.push(
        issue(
          file,
          lineOf(text, offset + (match.index ?? 0)),
          'ruleLiteral',
          `组件里比较规则号 ${match[0]}——规则判断应在 engine/，视图只负责显示`,
        ),
      )
    }
  }
  return out
}

/** 从 CSS 文本里取定义的变量名（`--name:` 声明） */
export function cssTokensOf(text) {
  const out = new Set()
  for (const match of text.matchAll(/(--[\w-]+)\s*:/g)) out.add(match[1])
  return out
}

/**
 * (b) 用了未定义的 CSS 变量
 *
 * @param {{ sources: Map<string, string>, defined: Set<string> }} input `sources` 传 .vue/.css
 */
export function scanCssVariables(input) {
  const out = []
  for (const [file, text] of input.sources) {
    for (const match of text.matchAll(/var\((--[\w-]+)/g)) {
      const name = match[1]
      if (input.defined.has(name)) continue
      out.push(
        issue(file, lineOf(text, match.index ?? 0), 'cssVariable', `未定义的 CSS 变量 ${name}`),
      )
    }
  }
  return out
}

/** 声明为值的导出（`export function|const|let|class`） */
export function exportedValuesOf(text) {
  const out = []
  const pattern = /^export (?:async )?(?:function|const|let|class) ([A-Za-z_$][\w$]*)/gm
  for (const match of text.matchAll(pattern)) out.push({ name: match[1], index: match.index ?? 0 })
  return out
}

/** 白名单键（稳定、可 grep：`文件<TAB>符号`） */
export function whitelistKeyOf(file, name) {
  return `${file}\t${name}`
}

/**
 * (c) 零调用导出（白名单外的新账）
 *
 * @param {{ sources: Map<string, string>, whitelist: readonly string[] }} input
 *   `sources` 传**全树**文本（声明文件自己也算一份）；`whitelist` 是 `文件\t符号`
 */
export function scanZeroCallExports(input) {
  const out = []
  const allowed = new Set(input.whitelist)
  for (const [file, text] of input.sources) {
    if (!/^src\/(engine|stores|render|data)\//.test(file)) continue
    for (const declared of exportedValuesOf(text)) {
      const name = declared.name
      if (allowed.has(whitelistKeyOf(file, name))) continue
      const pattern = new RegExp(`\\b${name}\\b`, 'g')
      let total = 0
      for (const other of input.sources.values()) {
        total += [...other.matchAll(pattern)].length
      }
      if (total > 1) continue
      out.push(
        issue(
          file,
          lineOf(text, declared.index),
          'zeroCallExport',
          `${name} 导出后全树无人引用（要么接线，要么从白名单里增补理由）`,
        ),
      )
    }
  }
  return out
}

/**
 * 白名单：2026-09-15 冻结的旧账（随接线**只减不增**；B45 起由 `scanStaleWhitelist` 自动报出该删的行）
 *
 * 逐条都是「实现了但没有任何调用者」。分两类，都保留原状而不是删掉：
 *   · **规则数值常量**（`RAIL_CAP_BEFORE` / `AIR_COMBAT_DEFENDER_ABORT_MIN_DICE` …）：是条文取值的
 *     单一出处，删掉会让文档与代码脱钩，留着等接线时用；
 *   · **待接线的辅助谓词**（`classifyForMode` / `unitMoveBudget` / `extenderBridgesRailLines` …）：
 *     属 M9/M10 的接线清单，接线后应从本表删除（删净即「零调用导出」这一关的自然收敛）。
 *
 * ★ 纪律：**只允许删，不允许加**。要加一条，必须在本注释里写清「为什么它不是缺陷」。
 */
export const ZERO_CALL_WHITELIST = [
  'src/engine/rules/air-interaction.ts\tresolveAirCargoStep',
  'src/engine/rules/air-interaction.ts\tAIR_INTERACTION_SEQUENCE',
  'src/engine/rules/air.ts\tAIRCRAFT_STEPS',
  'src/engine/rules/air.ts\tAIR_COMBAT_LOSS_STEP_LOSS_MIN_DICE',
  'src/engine/rules/air.ts\tAIR_SPECIAL_NO_HIP_SHOOT',
  'src/engine/rules/air.ts\tAIR_SPECIAL_NO_REACTION_EXPLOIT_MISSION',
  'src/engine/rules/air.ts\tAIR_SPECIAL_NO_PLANNED_AIRDROP',
  'src/engine/rules/combat-interaction.ts\tresultTextOf',
  'src/engine/rules/combat-interaction.ts\tparseResultCell',
  'src/engine/rules/consolidation.ts\tCONSOLIDATION_PHASE_KINDS',
  'src/engine/rules/fog.ts\tSECRET_ROLL_RULE',
  'src/engine/rules/movement.ts\tRE_SCALE_BATTALION',
  'src/engine/rules/movement.ts\tRE_SCALE_REPLACEMENT',
  'src/engine/rules/panzer-groups.ts\tODD_SP_TO_GUDERIAN',
  'src/engine/rules/rail-cap.ts\tRAIL_CAP_AFTER',
  'src/engine/rules/terrain.ts\tRIVER_FEATURES',
  'src/engine/rules/terrain.ts\tmovementMpValue',
  'src/engine/rules/timing.ts\tEDGE_BOX_TRACE_SUPPLY',
  'src/engine/rules/timing.ts\tWEATHER_GROUND_ALWAYS_GOOD',
  'src/engine/rules/timing.ts\tisBefore',
  'src/engine/rules/timing.ts\tisAfter',
  'src/engine/rules/victory.ts\tVICTORY_RULE',
  'src/engine/rules/victory.ts\tCONTROL_RULE',
  'src/render/map-layout.ts\tBOARD_EXTENT',
  'src/render/map-layout.ts\thexPolygonPoints',
  'src/render/token-layer.ts\tOVERLAY_HEX_RADIUS_PX',
  'src/stores/workbench-model.ts\tformatHexPath',
  'src/stores/workbench-model.ts\tMAP_META',
]

/**
 * (e) **白名单陈旧检查**：白名单里列了、但其实**已经不再零调用**（或该导出已不存在）的条目
 *
 * 为什么需要它：`ZERO_CALL_WHITELIST` 的纪律是「只允许删，不允许加」——但只靠人自觉，接线之后那一行
 * 很容易被忘记删除，白名单于是越滚越长（§17.73 的 `bridgedCrossing`、§17.71 的卸载常量、§17.79 的
 * 逐机飞法都是接线后才该从那 34 条里消失的）。把"陈旧"也报出来，白名单才会随接线自然收敛。
 *
 * @param {{ sources: Map<string, string>, whitelist: readonly string[] }} input
 * 语义：键为 `文件\t名字`；若该文件里已找不到这个导出 ⇒ 报"条目已失效"；
 *       若它在全树出现 ≥2 次（＝有调用者）⇒ 报"已接线，请从白名单删除"。
 */
export function scanStaleWhitelist(input) {
  const out = []
  const byFile = new Map()
  for (const [file, text] of input.sources) byFile.set(file, text)
  for (const key of input.whitelist) {
    const [file, name] = key.split('\t')
    if (file === undefined || name === undefined) {
      out.push(
        issue(
          file ?? '（未知文件）',
          1,
          'staleWhitelist',
          `白名单条目格式应为「文件\\t名字」：${key}`,
        ),
      )
      continue
    }
    const text = byFile.get(file)
    if (text === undefined) {
      out.push(issue(file, 1, 'staleWhitelist', `${name}：白名单指向的文件已不存在`))
      continue
    }
    const declared = [
      ...text.matchAll(/^export (?:async )?(?:function|const) ([A-Za-z_][A-Za-z0-9_]*)/gm),
    ].some((match) => match[1] === name)
    if (!declared) {
      out.push(
        issue(file, 1, 'staleWhitelist', `${name}：该文件里已找不到这个导出（条目已失效，请删除）`),
      )
      continue
    }
    let total = 0
    for (const other of input.sources.values()) {
      total += [...other.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length
    }
    if (total > 1) {
      out.push(
        issue(
          file,
          lineOf(text, text.search(new RegExp(`export (?:async )?(?:function|const) ${name}\\b`))),
          'staleWhitelist',
          `${name} 已被引用（零调用白名单里的这一行应删除）`,
        ),
      )
    }
  }
  return out
}
