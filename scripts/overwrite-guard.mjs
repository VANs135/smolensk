/**
 * 产物覆盖护栏（门禁加固 B0①）
 *
 * ## 为什么需要
 * 本工程**不是 git 仓库**（只有人工备份），而 `src/data/*.json` 里有几块
 * **脚本无法再生成的手写内容**：
 *   - `scenarios.json`：`setup.formationDraw` / `setup.airSetup` / `setup.printedHedgehogOwners`
 *     （引擎消费：`rules/containers.ts`、`rules/setup.ts`、`stores/workbench.ts`）
 *   - `charts-tables.json`：`surprise` / `attrition` 两张表（`tables/lookup.ts` 缺表直接抛错）
 *   - `map-layers.json`：人工改判删除的 36.18 印刷工事
 *
 * 因此同步脚本若"盲写覆盖"，重跑一次就会静默销毁上面这些内容——而 schema 里它们是
 * optional，**数据校验不会报错**，只有若干测试事后变红。
 *
 * ## 口径
 * 与 `sync-tec.mjs` 既有做法一致：落盘前与既有产物比对，不一致即拒绝写入（`--force` 可越过）。
 * 各脚本另须把手写块**显式合并保留**（read-modify-write），否则护栏会让脚本永远不可用，
 * 使用者就会绕过它——护栏必须让"正常重跑"是幂等的，才可能被长期遵守。
 */

/**
 * 是否允许落盘
 *
 * @param {{ nextText: string, existingText: string | null, force?: boolean }} input
 *   `existingText === null` 表示首次生成（产物不存在）
 * @returns {{ ok: true, reason: 'firstWrite' | 'unchanged' | 'forced' }
 *   | { ok: false, reason: 'outputWouldChange' }}
 */
export function decideOverwrite(input) {
  if (input.force === true) return { ok: true, reason: 'forced' }
  if (input.existingText === null) return { ok: true, reason: 'firstWrite' }
  if (input.existingText === input.nextText) return { ok: true, reason: 'unchanged' }
  return { ok: false, reason: 'outputWouldChange' }
}

/**
 * 拒绝覆盖时的诊断行（纯函数，便于单测）
 *
 * @param {{ outFile: string, preserved?: readonly string[] }} input
 * @returns {string[]}
 */
export function refusalLines(input) {
  const preserved = input.preserved ?? []
  return [
    `产物将发生变化，已拒绝写入：${input.outFile}`,
    ...(preserved.length === 0
      ? []
      : [
          '以下手写内容无法由本脚本再生，脚本已尽力合并；若仍不一致，说明脚本与产物已脱节：',
          ...preserved.map((note) => `  · ${note}`),
        ]),
    '确需覆盖：先手工备份 src/data，再加 --force 重跑。',
  ]
}

/**
 * 按**既有顺序**合并键（保证重跑幂等：键序不同会让护栏误判为"变化"）
 *
 * 规则：先按 `previous` 的键序取值（`next` 有则用 `next`，否则回退 `previous`），
 * 再把 `next` 里新增的键追加在后面。
 *
 * @param {Record<string, unknown>} previous
 * @param {Record<string, unknown>} next
 * @returns {Record<string, unknown>}
 */
export function mergeKeepingOrder(previous, next) {
  const out = {}
  for (const key of Object.keys(previous)) {
    out[key] = next[key] !== undefined ? next[key] : previous[key]
  }
  for (const [key, value] of Object.entries(next)) {
    if (!(key in out)) out[key] = value
  }
  return out
}
