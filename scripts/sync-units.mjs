/**
 * 单位数值库同步脚本（A5 产出 units-axis.json / units-soviet.json / aircraft.json）
 *
 * ★权威数据源（只读，禁止改动）：
 *   D:\OCS\OCS斯摩棱斯克素材\斯摩棱斯克工程数据库\
 *     ├── units.json      435 条地面单位（combat 382 / non_combat 53）
 *     └── aircraft.json    22 型空军
 *
 * 字段映射原则：
 *   - 库中 non_combat_type 已全部落值（6 类），不再推断；仅做口径归一化
 *   - side=both 的中立单位（SP/air_base/hedgehog）两边都放
 *   - 数值与能力分字段；HQ 投递距离 / 炮兵射程 / 非战斗点数 各归各位
 *   - 引擎不需要的元字段（review/renamed_from/vassal_formation_tag 等）不输出
 *
 * 运行：node scripts/sync-units.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { format, resolveConfig } from 'prettier'

/** 与数据管线 DATA_VERSION 保持一致的产物版本 */
export const UNITS_VERSION = '0.4.0'

/**
 * 装甲集群归属（Smolensk 专规 3.4：Guderian = 2nd Panzer Group / Hoth = 3rd Panzer Group）
 *
 * ★ 用户口径：「霍特或古德里安的编队不用玩家设置」——归属已在**素材库的编队目录**里分好：
 *   `…\轴心单位\编队单位\3rd_Panzer_Group\**`        ⇒ Hoth（3rd Panzer Group）
 *   `…\轴心单位\编队单位\<其它目录>\**`              ⇒ Guderian（2nd Panzer Group）
 * 本脚本按**目录清单**落成数据（算子图文件名前缀 `Ge_<编队码>_…`，编队码＝素材目录名），
 * 运行时只读 `record.panzerGroup`，玩家不必（也不该）再逐个声明；剧本书另有要求时以剧本数据为准。
 */
export const HOTH_FORMATIONS = ['7_Pz', '12_Pz', '19_Pz', '20_Pz', '14_Mtr', '18_Mtr', '20_Mtr']
export const GUDERIAN_FORMATIONS = [
  '3_Pz',
  '4_Pz',
  '10_Pz',
  '17_Pz',
  '18_Pz',
  '29_Mtr',
  '10_Mtr',
  '1_Cav',
  'SS-R',
]

/** 编队码 → 装甲集群 */
const PANZER_GROUP_BY_FORMATION = new Map([
  ...HOTH_FORMATIONS.map((code) => [code, 'hoth']),
  ...GUDERIAN_FORMATIONS.map((code) => [code, 'guderian']),
])

/** 编队码按长度降序（先匹配长的，避免 `1_Cav` 被更短的码误配） */
const FORMATION_CODES = [...PANZER_GROUP_BY_FORMATION.keys()].sort((a, b) => b.length - a.length)

/** 由算子图文件名派生装甲集群归属（非装甲集群单位 ⇒ null） */
export function panzerGroupOf(item) {
  const file = item.images?.front ?? item.images?.back ?? ''
  if (typeof file !== 'string' || file === '') return null
  const code = FORMATION_CODES.find((candidate) => file.startsWith(`Ge_${candidate}_`))
  return code === undefined ? null : (PANZER_GROUP_BY_FORMATION.get(code) ?? null)
}

/**
 * 非战斗单位种类归一化（units.json 的 non_combat_type 已全部落值，此处仅做口径统一）
 * 枚举：supply_point → sp（运行时口径）、其余保持原名
 */
export function normalizeNoncombatType(item) {
  const raw = item.non_combat_type
  if (!raw) return null
  const map = {
    supply_point: 'sp',
    transport_point: 'transport_point',
    organic_truck: 'organic_truck',
    supply_extender: 'supply_extender',
    air_base: 'air_base',
    hedgehog: 'hedgehog',
    port: 'port',
  }
  return map[raw] ?? null
}

/** @deprecated 已由 normalizeNoncombatType 取代；保留供旧测试引用 */
export function inferNoncombatKind(item) {
  return normalizeNoncombatType(item)
}

/**
 * OCR 数值强转：数字直用；数字串 → number；"1/2" → 0.5；空/非法 → undefined（不造数）
 *
 * 印值里带单位的情况先剥单位再解析：空军运力印的是 `"1T"` / `"1/2T"`（吨），
 * 不剥的话整批运力会退化成 null（这就是此前「22 型运力全为 null」的成因）。
 */
export function coerceNumber(value) {
  if (value === null || value === undefined || value === '') return undefined
  if (typeof value === 'number') return value
  const s = String(value)
    .trim()
    .replace(/[Tt吨]\s*$/, '')
    .trim()
  if (/^\d+$/.test(s)) return Number(s)
  const fraction = s.match(/^(\d+)\/(\d+)$/)
  if (fraction) return Number(fraction[1]) / Number(fraction[2])
  return undefined
}

/** 把数值面转成 factors 子对象（炮兵：artillery_values，无 A → 战斗值恒 1，附轰炸值与射程） */
export function toFactorSet(face, artillery = false) {
  if (face === null || face === undefined) return null
  const attack = coerceNumber(face.A)
  const ar = coerceNumber(face.AR)
  const ma = coerceNumber(face.MA)
  const barrage = coerceNumber(face.barrage)
  const range = coerceNumber(face.range)
  const entry = {}
  if (attack !== undefined) entry.attack = attack
  else if (artillery) entry.attack = 1 // 炮兵：A 恒为 1（special_note，装填即攻击能力）
  if (ar !== undefined) entry.ar = ar
  if (ma !== undefined) entry.ma = ma
  if (barrage !== undefined) entry.barrage = barrage
  if (range !== undefined) entry.range = range
  return Object.keys(entry).length > 0 ? entry : null
}

/** 是否为炮兵（走 artillery_values 版式：左黄框炮击值、AR 下方射程，A 恒 1） */
export function isArtillery(item) {
  return (item.specialized ?? []).includes('artillery') || item.arm === 'artillery'
}

/**
 * 构造非战斗单位专用详情对象（引擎按 noncombatKind 路由到对应判定）
 * supply_point → { spValue, splittable, faces? }
 * transport_point/organic_truck/supply_extender → { transport, transportKind, splittable }
 * air_base → { level }
 * hedgehog → { level }
 */
function buildNoncombatDetails(item) {
  const nct = item.non_combat_type
  if (!nct) return undefined
  const front = item.printed_values?.front ?? {}
  switch (nct) {
    case 'supply_point':
      return {
        spValue: coerceNumber(front.sp),
        splittable: item.splittable,
        faces:
          Array.isArray(item.faces) && item.faces.length > 0
            ? item.faces.map((f) => ({ face: f.face, kind: f.kind, value: coerceNumber(f.value) }))
            : undefined,
      }
    case 'transport_point':
    case 'organic_truck':
    case 'supply_extender':
      return {
        transport: coerceNumber(front.transport),
        transportKind: item.transport_kind ?? (item.side === 'soviet' ? undefined : undefined),
        splittable: item.splittable,
      }
    case 'air_base':
      return {
        level: coerceNumber(front.level),
      }
    case 'hedgehog':
      return {
        level: coerceNumber(front.level),
      }
    default:
      return undefined
  }
}

/**
 * 构造逐面机动类型（通规 3.1a：颜色表示移动类型，**两面可能不同**）
 *
 * 战斗面 ← 正面印值的 `mobility_type`、移动面 ← 背面；只导出**取值合法**的面，
 * 缺面即留空（由 `mobilityOf` 回退记录级 `classes.movementClass`，不臆造）。
 *
 * ★ 来源固定取 **`printed_values`**：`mobility_type` 是「印刷 MA 的取色判定」这一列，
 *   **只有** `printed_values` 携带（`artillery_values` 只有轰炸值/射程，实测 333 条全无该列）。
 *   故这里与炮兵 factors 的来源（`artillery_values` 优先）**刻意不同**：数值与机动类型各有其表。
 */
function mobilityByFaceOf(printed) {
  const VALID = ['leg', 'truck', 'tracked']
  const pick = (face) => (VALID.includes(face?.mobility_type) ? face.mobility_type : undefined)
  const pair = { combat: pick(printed?.front), move: pick(printed?.back) }
  return Object.values(pair).some((value) => value !== undefined) ? pair : undefined
}

/**
 * 构造 HQ 投递距离（通规 13.1b：底部左＝投递距离，右＝MA；两面不同）
 * 仅 specialized 包含 'hq' 的单位有此字段
 */
function buildThrowRange(item) {
  const isHQ = (item.specialized ?? []).includes('hq')
  if (!isHQ) return undefined
  const front = item.printed_values?.front
  const back = item.printed_values?.back
  return {
    combatFace: coerceNumber(front?.throw_range),
    moveFace: coerceNumber(back?.throw_range),
  }
}

/** 地面单位记录 → 运行时 UnitRecord（映射 + 空值裁剪 + 无值不造数） */
export function toUnitRecord(item) {
  const printed = item.printed_values ?? {}
  const artillery = isArtillery(item)
  // 炮兵走 artillery_values（含轰炸值/射程）；其余走 printed_values
  const front = artillery
    ? (item.artillery_values?.front ?? printed.front ?? null)
    : (printed.front ?? item.artillery_values?.front ?? null)
  const back = artillery
    ? (item.artillery_values?.back ?? printed.back ?? null)
    : (printed.back ?? item.artillery_values?.back ?? null)
  const isCombat = item.unit_kind === 'combat'
  const unitFamily = isCombat ? 'ground_combat' : 'ground_noncombat'

  const factors = {}
  const combat = toFactorSet(front, artillery)
  if (combat) factors.combat = combat
  const move = toFactorSet(back, artillery)
  if (move) factors.move = move // 缺面（单面/炮兵无背面值）省略，不存 null

  const record = {
    // ── 分类与身份 ──
    id: item.unit_id,
    vassalName: item.vassal_name,
    // ── 算子图档（渲染按朝向取 front/back；文件名即素材库原名） ──
    images:
      item.images === undefined
        ? undefined
        : { front: item.images.front ?? null, back: item.images.back ?? null },
    side: item.side, // 保留 'both'（中立），引擎按 initial_owner 决定归属
    unitFamily,
    isCombat,
    unitKind: item.unit_kind,
    specialized: (item.specialized ?? []).length > 0 ? item.specialized : undefined,
    noncombatKind: isCombat ? null : normalizeNoncombatType(item),
    branch: item.arm ?? undefined,
    echelon: item.echelon ?? undefined,
    echelonStatus: item.echelon_status ?? undefined,
    // ── 能力与规则 ──
    specialRule: item.special_rule ?? undefined,
    specialAbilities:
      Array.isArray(item.special_abilities) && item.special_abilities.length > 0
        ? item.special_abilities
        : undefined,
    capabilities:
      Array.isArray(item.special_abilities) && item.special_abilities.length > 0
        ? item.special_abilities
        : undefined,
    attackCapable: item.attack_capable ?? (isCombat ? undefined : false),
    attackValueBracketed: item.A_parenthesized ?? undefined,
    combatValuePrinted: item.combat_value_printed ?? undefined,
    rebuildable: item.rebuildable ?? undefined,
    /*
     * 专规 2.3a：警戒（Alarm）单位的**混编上限**（3 个 2-1-3 坦克营 / 5 个 3-1-1 民兵团 /
     * 7 个 (2)-2-2 反坦克团 —— 按算子类型计，同型可同时在场多枚）。
     * 只有这三种算子带该字段；引擎据此判定「本项抽取是否还有余量」。
     */
    alarmLimit: item.alarm_limit ?? undefined,
    // ── 类型资格（3.1a / 3.2a） ──
    classes: {
      combatClass: item.combat_category ?? undefined,
      movementClass: item.mobility_type ?? undefined,
    },
    // ── 3.1a 逐面机动类型（战斗面 ← 正面、移动面 ← 背面；来自算子图的像素取色） ──
    // 「算子一面和另一面的颜色可能不同」，故两面分别导出；缺失一面时保留 undefined（由消费侧回退记录级）
    mobilityByFace: mobilityByFaceOf(printed),
    // ── 按面数值 ──
    factors,
    // ── 军力与团当量 ──
    steps:
      item.steps_total !== null && item.steps_total !== undefined
        ? { total: item.steps_total }
        : undefined,
    reSize: item.RE ?? undefined,
    // ── 规则化投递距离（仅 HQ） ──
    throwRange: buildThrowRange(item),
    // ── 非战斗单位详情 ──
    noncombatDetails: isCombat ? undefined : buildNoncombatDetails(item),
    // ── 数据质量 ──
    status: item.fill_stage ?? 'classified',
    // ── 装甲集群归属（3.4；由素材库编队目录派生，玩家不用设置） ──
    panzerGroup: panzerGroupOf(item) ?? undefined,
  }
  // 裁剪 undefined，避免 schema 未定义键
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined))
}

/** 空军记录 → 运行时机场记录（aircraft.schema.ts；数值一律 coerceNumber，字符串串入不放过） */
export function toAircraftRecord(item) {
  const printed = item.printed_values?.front ?? {}
  const ab = item.air_abilities ?? {}
  const record = {
    aircraftId: item.unit_id,
    name: item.vassal_name ?? item.aircraft_model ?? item.unit_id,
    // ── 算子图档（与地面算子同口径：文件名即素材库原名） ──
    images:
      item.images === undefined
        ? undefined
        : { front: item.images.front ?? null, back: item.images.back ?? null },
    side: item.side, // 保留原值（soviet/axis），不存在 both
    aircraftType: item.type_badge ?? null,
    airCombatRating: coerceNumber(printed.air_combat) ?? null,
    barrageStrength: coerceNumber(printed.barrage) ?? null,
    rangeHexes: coerceNumber(printed.range) ?? null,
    transportCapacity: coerceNumber(printed.transport_capacity) ?? null,
    // 14.4f/14.4g：减损面的运输容量（工程库 printed_values.back.transport_capacity）
    transportCapacityBack:
      coerceNumber((item.printed_values?.back ?? {}).transport_capacity) ?? null,
    steps: coerceNumber(ab.steps) ?? 2,
    // ── 能力（专规例外：苏军禁 hip shoot / 禁反应进击出击 等） ──
    specialAbilities:
      Array.isArray(item.special_abilities) && item.special_abilities.length > 0
        ? item.special_abilities
        : undefined,
    airAbilities: {
      canHipShoot: ab.can_hip_shoot ?? undefined,
      missionInReactionPhase: ab.mission_in_reaction_phase ?? undefined,
      missionInExploitationPhase: ab.mission_in_exploitation_phase ?? undefined,
      canInitiateAirCombat: ab.can_initiate_air_combat ?? undefined,
      canBarrage: ab.can_barrage ?? undefined,
      canEscort: ab.can_escort ?? undefined,
      canPatrolZone: ab.can_patrol_zone ?? undefined,
      canAirDrop: ab.can_air_drop ?? undefined,
    },
    status: item.fill_stage ?? 'classified',
  }
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined))
}

/** 组装一侧地面单位文件（仅含引擎可加载的 valued+verified 记录） */
export function buildSideFile(side, items) {
  return {
    meta: {
      version: UNITS_VERSION,
      description: `地面单位数值库（A5）：${side === 'axis' ? '轴心（德）' : '苏联'}战斗单位与非战斗单位；仅含 valued+verified 记录（classified 待 OCR 增补）；数值按面存 factors.{combat,move}，能力在 capabilities`,
      source: ['units.json（OCR/目检落值，2026-09-11）'],
    },
    units: items,
  }
}

/* ── 主流程（仅直接运行本脚本时执行） ── */
async function main() {
  const DB_DIR = 'D:\\OCS\\OCS斯摩棱斯克素材\\斯摩棱斯克工程数据库'
  const cwd = dirname(fileURLToPath(import.meta.url))
  const OUT_DIR = join(cwd, '..', 'src', 'data')
  const read = (name) => JSON.parse(readFileSync(join(DB_DIR, name), 'utf8'))

  const units = read('units.json')
  const aircraft = read('aircraft.json')

  // 契约：引擎只加载 valued 以上（unit_db_schema v2 / CODE_SPEC）；classified 待 OCR 增补，不进入运行时
  const loadable = units.items.filter(
    (u) => u.fill_stage === 'valued' || u.fill_stage === 'verified',
  )
  // side=both 的中立单位（SP/air_base/hedgehog）两边都放
  const axis = loadable.filter((u) => u.side === 'axis' || u.side === 'both').map(toUnitRecord)
  const soviet = loadable.filter((u) => u.side === 'soviet' || u.side === 'both').map(toUnitRecord)
  const neutralCount = loadable.filter((u) => u.side === 'both').length
  const aircraftRecords = aircraft.items
    .filter((a) => a.fill_stage === 'valued' || a.fill_stage === 'verified')
    .map(toAircraftRecord)

  const files = [
    ['units-axis.json', buildSideFile('axis', axis)],
    ['units-soviet.json', buildSideFile('soviet', soviet)],
    [
      'aircraft.json',
      {
        meta: {
          version: UNITS_VERSION,
          description:
            '空军专表（A5）：22 型，含类型/空战值/轰炸值/射程/运量/军力；能力（hip shoot 限制等）另行消费',
          source: ['aircraft.json（印值目检落库，2026-09-11）'],
        },
        aircraft: aircraftRecords,
      },
    ],
  ]

  for (const [name, content] of files) {
    const out = join(OUT_DIR, name)
    const text = JSON.stringify(content, null, 2) + '\n'
    const config = await resolveConfig(out)
    const formatted = await format(text, { ...config, parser: 'json' })
    writeFileSync(out, formatted, 'utf8')
    const count =
      'aircraft' in content ? `${content.aircraft.length} 型` : `${content.units.length} 条`
    console.log(`written ${name}（${count}）`)
  }

  const valued = units.items.filter(
    (u) => u.fill_stage === 'valued' || u.fill_stage === 'verified',
  ).length
  console.log(
    `written ${axis.length + soviet.length - neutralCount} unique ground records (${neutralCount} shared on both sides); axis=${axis.length} soviet=${soviet.length}`,
  )
  console.log(`written ${aircraftRecords.length} aircraft records`)
  console.log(
    `地面单位合计 ${units.items.length}（战斗 ${units.items.filter((u) => u.unit_kind === 'combat').length} / 非战斗 ${units.items.filter((u) => u.unit_kind === 'non_combat').length}）；已落值 ${valued}（${Math.round((valued / units.items.length) * 100)}%）；中立单位 ${neutralCount} 两边各一份`,
  )
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) void main()
