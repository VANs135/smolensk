/** 架构扫描（`scripts/arch-scan.mjs`）的类型声明 */

/** 单条扫描结论 */
export interface ArchIssue {
  file: string
  /** 行号（1 基） */
  line: number
  kind: 'ruleLiteral' | 'cssVariable' | 'zeroCallExport'
  detail: string
}

/** 规则号字面量的正则源（`6.1` / `9.5a` / `专规 2.4`） */
export declare const RULE_LITERAL_SOURCE: string
/** 比较语境下的规则字面量正则源 */
export declare const RULE_COMPARISON_SOURCE: string

export declare function issue(
  file: string,
  line: number,
  kind: ArchIssue['kind'],
  detail: string,
): ArchIssue

/** 取 `<script>` 段文本 */
export declare function scriptSectionOf(text: string): string

/** (a) 组件/视图里比较规则字面量 */
export declare function scanRuleLiterals(input: { sources: Map<string, string> }): ArchIssue[]

/** 从 CSS 文本里取定义的变量名 */
export declare function cssTokensOf(text: string): Set<string>

/** (b) 用了未定义的 CSS 变量 */
export declare function scanCssVariables(input: {
  sources: Map<string, string>
  defined: Set<string>
}): ArchIssue[]

/** 声明为值的导出（`export function|const|let|class`） */
export declare function exportedValuesOf(text: string): { name: string; index: number }[]

/** 白名单键（`文件<TAB>符号`） */
export declare function whitelistKeyOf(file: string, name: string): string

/** (c) 零调用导出（白名单外的新账） */
export declare function scanZeroCallExports(input: {
  sources: Map<string, string>
  whitelist: readonly string[]
}): ArchIssue[]

/**
 * (e) 白名单**陈旧项**：白名单里列了、但其实已有调用者（或该导出/文件已不存在）的条目
 *
 * B45 新增：白名单的纪律是「只允许删」，这一关就是逼着删的那只手（接线后忘删会红灯）。
 */
export declare function scanStaleWhitelist(input: {
  sources: Map<string, string>
  whitelist: readonly string[]
}): ArchIssue[]

/** 零调用导出的旧账白名单（只允许删，不允许加） */
export declare const ZERO_CALL_WHITELIST: readonly string[]
