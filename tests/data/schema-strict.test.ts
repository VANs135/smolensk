import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { setupFlowFor } from '@/engine/rules'
import {
  AircraftDataSchema,
  ChartsCrtSchema,
  ChartsSupplyReplSchema,
  ChartsTablesSchema,
  ChartsTecSchema,
  FormationsDataSchema,
  MapConfigSchema,
  MapLayersDataSchema,
  MarkersDataSchema,
  PanelScansDataSchema,
  RulesConstantsSchema,
  ScenarioSetupDataSchema,
  ScenariosDataSchema,
  UnitsDataSchema,
} from '@/data/schema'

/**
 * M10②：schema 收窄（`.passthrough()` → `.strict()`）的**验收**
 *
 * 修前 114 处都是 `.passthrough()` ⇒ 数据里多一个字段（含**字段名写错**）一律静默放过，
 * 于是「用了不存在的字段」只会在运行期表现为 `undefined`（本次收窄就抓到一个：
 * `setup-notes` 读的是 `scenario.weatherFirstTurnRaw`，而数据里该字段在 `scenario.setup` 下
 * ⇒ 界面上那行一直是「首回合天气 undefined」）。
 *
 * 本组钉两件事：
 *   ① **正确数据必须过**（收窄不能收出假阳性）；
 *   ② **注入一个未知字段必须被拒**（每个文件一条），这样下次写错字段名当场报错。
 */
const FILES: [string, unknown][] = [
  ['rules-constants.json', RulesConstantsSchema],
  ['charts-crt.json', ChartsCrtSchema],
  ['charts-tables.json', ChartsTablesSchema],
  ['charts-tec.json', ChartsTecSchema],
  ['charts-supply-repl.json', ChartsSupplyReplSchema],
  ['markers.json', MarkersDataSchema],
  ['panel-scans.json', PanelScansDataSchema],
  ['map-config.json', MapConfigSchema],
  ['map-layers.json', MapLayersDataSchema],
  ['units-axis.json', UnitsDataSchema],
  ['units-soviet.json', UnitsDataSchema],
  ['aircraft.json', AircraftDataSchema],
  ['scenarios.json', ScenariosDataSchema],
  ['scenario-setup.json', ScenarioSetupDataSchema],
  ['formations.json', FormationsDataSchema],
]

/** 每份产物数据的根对象上注一个未知字段 */
function withTypo(raw: Record<string, unknown>): Record<string, unknown> {
  return { ...raw, __typo_field__: 1 }
}

const readRaw = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`src/data/${file}`, 'utf8')) as Record<string, unknown>

describe('M10②：schema 收窄的验收（错误数据必须被拒）', () => {
  it.each(FILES)('%s：原样数据通过校验', (file, schema) => {
    const parsed = (schema as { safeParse: (v: unknown) => { success: boolean } }).safeParse(
      readRaw(file),
    )
    expect(parsed.success).toBe(true)
  })

  it.each(FILES)('%s：多一个未知字段 ⇒ 校验失败（字段名写错即当场红灯）', (file, schema) => {
    const parsed = (
      schema as {
        safeParse: (v: unknown) => { success: boolean; error?: { issues: { message: string }[] } }
      }
    ).safeParse(withTypo(readRaw(file)))
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues.some((issue) => issue.message.includes('Unrecognized key'))).toBe(
      true,
    )
  })
})

describe('M10②：收窄抓到的那处真实缺陷（已修）', () => {
  it('布设流程的「剧本选择」步要给出**首回合天气原文**，而不是 undefined', () => {
    const steps = setupFlowFor('1')
    const scenarioStep = steps.find((step) => step.id === 'scenario')
    expect(scenarioStep).toBeDefined()
    // 数据里首回合天气原文在 `setup.weatherFirstTurnRaw`（如 'Normal Flight on 8 July'）
    expect(scenarioStep!.detail).toContain('Normal Flight')
    expect(scenarioStep!.detail).not.toContain('undefined')
  })
})
