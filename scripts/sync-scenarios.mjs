/**
 * 剧本数据同步脚本（A8 产出 scenarios.json）
 *
 * 数据源（斯摩棱斯克工程数据库）：
 *   - scenarios.json：7 个剧本（1–7，入门剧本 Vitebsk 按裁定推迟不计入）
 *     · rules_scenarios：起止日期 / 回合数 / 首次行动方 / 布设顺序 / 初设数值与选项
 *     · victory：胜利条件（5.0a / 5.0b / 剧本 2·4 变体 / 通用格清单）
 *     · items[].supply_sources：该剧本按首回合日期算出的生效补给源
 *   - rules.json exclusive_rules_smolensk：
 *     · agreed_options（共识开关，须双方一致同意）
 *     · optional_rules（可选规则 / 房规 4.1a–4.3）
 *
 * 产物仅含剧本级旋钮与初设数值；**单位位置**在 scenario-setup.json，**到达表**在 arrivals-*.json。
 *
 * 运行：node scripts/sync-scenarios.mjs
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { format, resolveConfig } from 'prettier'

import { decideOverwrite, mergeKeepingOrder, refusalLines } from './overwrite-guard.mjs'

/** 与数据管线 DATA_VERSION 保持一致的产物版本 */
export const SCENARIOS_VERSION = '0.4.0'

/** 天气原文 → 契约枚举 */
export function toFirstWeather(label) {
  if (label === 'Normal Flight') return 'normal'
  if (label === 'Limited Flight') return 'restricted'
  throw new Error(`无法解析首回合天气：${label}`)
}

/** '每方各 2 枚' → 2 */
export function parseCount(text) {
  const match = String(text).match(/\d+/)
  if (!match) throw new Error(`无法从文本解析数量：${text}`)
  return Number(match[0])
}

/**
 * 卡车满载方式原文 → 结构化
 *   '德军全部满载'            → all_loaded
 *   '德军全部空载'            → all_unloaded
 *   '德军自选 4 辆满载，其余空载' → choose_loaded(4)
 */
export function parseOrganicTrucks(raw) {
  if (/全部满载/.test(raw)) return { mode: 'all_loaded', raw }
  if (/全部空载/.test(raw)) return { mode: 'all_unloaded', raw }
  const choose = raw.match(/自选\s*(\d+)\s*辆满载/)
  if (choose) return { mode: 'choose_loaded', count: Number(choose[1]), raw }
  throw new Error(`无法解析卡车满载方式：${raw}`)
}

/** rules_scenarios 单条 → ScenarioSchema 记录 */
export function toScenario(record, item) {
  const numbers = record.setup_numbers ?? {}
  const choices = record.setup_choices ?? {}

  // 继承：初设与特殊规则同剧本 X（1-2 / 3-4 / 5-6 共用）
  const sameAs = choices.same_as

  // 初设选项：剔除已结构化的键，其余原文保留
  const structuredChoiceKeys = new Set(['same_as', 'formation_draw', 'organic_trucks'])
  const options = {}
  for (const [key, value] of Object.entries(choices)) {
    if (!structuredChoiceKeys.has(key)) options[key] = value
  }

  const supplyCache =
    typeof choices.supply_cache === 'number'
      ? choices.supply_cache
      : parseCount(numbers.supply_cache)

  const variableExitRequired =
    numbers.variable_exit === '须掷' || /须掷可变撤离/.test(String(choices.note ?? ''))

  const scenario = {
    id: String(record.id),
    name: record.name,
    firstTurn: record.first_turn,
    lastTurn: record.last_turn,
    turns: record.turns,
    firstPlayer: record.first_player,
    setupFirst: record.setup_first,
    firstWeather: toFirstWeather(record.weather_start),
    setup: {
      railCap: numbers.rail_cap,
      reserveMarkers: numbers.reserve_markers,
      supplyCache,
      constructionMarkers: numbers.construction_markers,
      organicTrucks: parseOrganicTrucks(numbers.organic_trucks),
      weatherFirstTurnRaw: numbers.weather_first_turn,
      ...(choices.formation_draw ? { formationDrawRaw: choices.formation_draw } : {}),
      ...(Object.keys(options).length > 0 ? { options } : {}),
      ...(numbers.source ? { source: [numbers.source] } : {}),
    },
  }

  if (sameAs !== undefined) scenario.inherits = String(sameAs)
  if (item?.shared_setup_with?.length) scenario.sharedSetupWith = item.shared_setup_with.map(String)
  if (item?.has_setup != null) scenario.hasSetup = item.has_setup
  if (item?.setup_info) scenario.setupInfo = item.setup_info
  if (record.dagger_rule) scenario.daggerRule = record.dagger_rule
  if (record.soviet_first_turn_half_ma)
    scenario.sovietFirstTurnHalfMa = record.soviet_first_turn_half_ma
  if (variableExitRequired) scenario.variableExitRequired = true
  if (item?.counts) scenario.counts = item.counts
  if (item?.supply_sources) scenario.supplySources = toSupplySources(item.supply_sources)

  return scenario
}

/**
 * 关闭补给源条目：格号字符串原样；对象记录（含关闭日期与依据）转 camelCase
 */
export function toClosedSource(entry) {
  if (typeof entry === 'string') return entry
  const out = { hexId: entry.hex_id }
  if (entry.hex_id_user != null) out.hexIdUser = entry.hex_id_user
  if (entry.date != null) out.date = entry.date
  if (entry.rule != null) out.rule = entry.rule
  return out
}

/** supply_sources（snake）→ camelCase */
export function toSupplySources(src) {
  const out = {
    rule: src.rule,
    firstTurn: src.first_turn,
    sovietLive: src.soviet_live ?? [],
    sovietClosed: (src.soviet_closed ?? []).map(toClosedSource),
    axisLive: src.axis_live ?? [],
    axisClosed: (src.axis_closed ?? []).map(toClosedSource),
  }
  if (src.entering_loaded) out.enteringLoaded = src.entering_loaded
  if (src.placement) out.placement = src.placement
  if (src.entrain_off_map) out.entrainOffMap = src.entrain_off_map
  if (src.free_rail_cap) out.freeRailCap = src.free_rail_cap
  if (src.source) out.source = src.source
  return out
}

/** 胜利条件：snake → camelCase（final 内层键亦归一） */
export function toVictory(src) {
  const out = {}
  if (src.final) {
    out.final = {
      sovietWin: src.final.soviet_win,
      axisWin: src.final.axis_win,
      else: src.final.else,
      rule: src.final.rule,
    }
  }
  if (src.decisive) out.decisive = src.decisive
  if (src.scenarios_2_and_4) out.scenarios2And4 = src.scenarios_2_and_4
  if (src.control) out.control = src.control
  out.listedHexes = src.listed_hexes ?? []
  out.scenario2HexList = src.scenario_2_hex_list ?? []
  return out
}

/** 组装运行时 scenarios.json（纯函数，供单测） */
export function buildScenarios({ scenariosDb, rulesDb }) {
  const smolensk = rulesDb.exclusive_rules_smolensk

  // 入门剧本（Vitebsk，turns = 0）按裁定推迟，不计入（turns 只在 rules_scenarios 上）
  const records = scenariosDb.rules_scenarios.filter((record) => record.turns > 0)

  // items（初设计数与补给源）按 scenario_id 索引；items 仅覆盖启用剧本
  const byId = new Map(scenariosDb.items.map((item) => [String(item.scenario_id), item]))

  return {
    meta: {
      version: SCENARIOS_VERSION,
      description:
        '剧本库（A8）：7 个剧本的起止日期/回合数/首次行动方/布设顺序/初设数值与选项（含继承）、生效补给源、胜利条件、共识开关与可选规则',
      source: [
        'scenarios.json（rules_scenarios / victory / items[].supply_sources）',
        'rules.json exclusive_rules_smolensk（agreed_options / optional_rules）',
      ],
    },
    agreedOptions: {
      note: smolensk.agreed_options.note,
      items: smolensk.agreed_options.items,
    },
    optionalRules: smolensk.optional_rules,
    /** 初设期须遵守的专属规则注记（SP 归属按 Setup Note F） */
    setupNotes: {
      spOwnership: smolensk.axis_special.guderian_hoth.initial_sp_ownership,
      newSpAssignment: smolensk.axis_special.guderian_hoth.new_sp_assignment,
    },
    victory: toVictory(scenariosDb.victory),
    scenarios: records.map((record) => toScenario(record, byId.get(String(record.id)))),
  }
}

/* ── 手写块保留（门禁加固 B0①） ── */

/**
 * `setup` 里**脚本无法从权威库再生**的手写块
 *
 * 它们的消费方：`setup.formationDraw` → `rules/containers.ts` / `rules/setup.ts` /
 * `stores/setup.ts` / `components/setup/SetupPanel.vue`；
 * `setup.airSetup` → `rules/setup.ts`（初设激活政策）；
 * `setup.printedHedgehogOwners` → `stores/workbench.ts`（印刷工事归属）；
 * `setup.convertedAxisRails` → `stores/workbench.ts`（专规 1.2 初设换轨；逐格清单由引擎推导）。
 * 缺失时引擎会退化为"未登记 ⇒ 视为无"，且 schema 是 optional 故校验不报错。
 */
export const HAND_WRITTEN_SETUP_KEYS = [
  'formationDraw',
  'airSetup',
  'printedHedgehogOwners',
  'convertedAxisRails',
]

/**
 * 把既有产物里的手写块合并回新产物（按剧本 id 对齐，按既有键序保持幂等）
 *
 * @param {Record<string, unknown>} next 脚本新生成的产物
 * @param {Record<string, unknown> | null} existing 既有产物（null = 首次生成）
 */
export function mergeHandWrittenSetup(next, existing) {
  if (existing === null || existing === undefined) return next
  const previousById = new Map(
    (existing.scenarios ?? []).map((scenario) => [String(scenario.id), scenario]),
  )
  return {
    ...next,
    scenarios: next.scenarios.map((scenario) => {
      const previous = previousById.get(String(scenario.id))
      if (previous === undefined || previous.setup === undefined) return scenario
      const setup = mergeKeepingOrder(previous.setup, scenario.setup)
      return { ...scenario, setup }
    }),
  }
}

/* ── 主流程（仅直接运行本脚本时执行） ── */
async function main() {
  const DB_DIR = 'D:\\OCS\\OCS斯摩棱斯克素材\\斯摩棱斯克工程数据库'
  const cwd = dirname(fileURLToPath(import.meta.url))
  const OUT_FILE = join(cwd, '..', 'src', 'data', 'scenarios.json')
  const read = (name) => JSON.parse(readFileSync(join(DB_DIR, name), 'utf8'))

  const existingText = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf8') : null
  const existing = existingText === null ? null : JSON.parse(existingText)

  const built = buildScenarios({ scenariosDb: read('scenarios.json'), rulesDb: read('rules.json') })
  const next = mergeHandWrittenSetup(built, existing)

  const text = JSON.stringify(next, null, 2) + '\n'
  const config = await resolveConfig(OUT_FILE)
  const formatted = await format(text, { ...config, parser: 'json' })

  const decision = decideOverwrite({
    nextText: formatted,
    existingText,
    force: process.argv.includes('--force'),
  })
  if (!decision.ok) {
    for (const line of refusalLines({ outFile: OUT_FILE, preserved: HAND_WRITTEN_SETUP_KEYS }))
      console.error(line)
    process.exit(1)
  }

  writeFileSync(OUT_FILE, formatted, 'utf8')
  console.log(
    `written scenarios.json（剧本 ${next.scenarios.length} · 可选规则 ${Object.keys(next.optionalRules).length} · 共识开关 ${next.agreedOptions.items.length} · ${decision.reason}）`,
  )
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) void main()
