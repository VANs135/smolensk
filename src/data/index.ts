import aircraftRaw from './aircraft.json'
import arrivalsAxisRaw from './arrivals-axis.json'
import arrivalsSovietRaw from './arrivals-soviet.json'
import auxCardsRaw from './aux-cards.json'
import chartsCrtRaw from './charts-crt.json'
import chartsSupplyReplRaw from './charts-supply-repl.json'
import chartsTablesRaw from './charts-tables.json'
import chartsTecRaw from './charts-tec.json'
import formationsRaw from './formations.json'
import mapConfigRaw from './map-config.json'
import mapLayersRaw from './map-layers.json'
import markersRaw from './markers.json'
import panelScansRaw from './panel-scans.json'
import rulesConstantsRaw from './rules-constants.json'
import scenarioSetupRaw from './scenario-setup.json'
import scenariosRaw from './scenarios.json'
import unitsAxisRaw from './units-axis.json'
import unitsSovietRaw from './units-soviet.json'
import { bootstrapData } from './pipeline'
import {
  AircraftDataSchema,
  ArrivalsDataSchema,
  AuxCardsDataSchema,
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
} from './schema'

/**
 * 数据唯一加载入口
 *
 * 约定：新增数据文件三步接入——
 *   1. 在 schema/ 定义 Zod schema（或复用既有）；经 schema/index.ts 导出类型；
 *   2. `import raw from './x.json'`；
 *   3. `export const x = bootstrapData(raw, XSchema, 'x.json')`；
 * 管线自动完成 版本检查 → 校验 → 深度冻结。未加载的文件保持待接入状态。
 *
 * 当前已加载：rules-constants.json（A9 常量）、charts-crt.json / charts-tables.json /
 * charts-tec.json（A7.1 图表与地形效果表）。
 */

/** 规则常量（深度冻结只读；数值出处见 schema/rules-constants.schema.ts） */
export const rulesConstants = bootstrapData(
  rulesConstantsRaw,
  RulesConstantsSchema,
  'rules-constants.json',
)

/** CRT（9.9）：195 格矩阵（A7.1 取表 API 数据源） */
export const chartsCrt = bootstrapData(chartsCrtRaw, ChartsCrtSchema, 'charts-crt.json')

/** 判定表集：轰炸/对设施/夺取/防空任务损失（A7.1 取表 API 数据源） */
export const chartsTables = bootstrapData(chartsTablesRaw, ChartsTablesSchema, 'charts-tables.json')

/** TEC 地形效果表（6.2d / 9.3b / 9.4 的唯一数值来源） */
export const chartsTec = bootstrapData(chartsTecRaw, ChartsTecSchema, 'charts-tec.json')

/** 补给/补员/特殊补员/重建费用表（A7.3 取数 API 数据源） */
export const chartsSupplyRepl = bootstrapData(
  chartsSupplyReplRaw,
  ChartsSupplyReplSchema,
  'charts-supply-repl.json',
)

/** 标记与记录轨（A6）：47 标记 + 回合轨 + 铁路容量轨 + 容器初始 */
export const markers = bootstrapData(markersRaw, MarkersDataSchema, 'markers.json')

/** 网格标定（A3）：行列范围 / 格心公式 / 入口字母 A–L / 胜利格 / 分界线 */
export const mapConfig = bootstrapData(mapConfigRaw, MapConfigSchema, 'map-config.json')

/** 地图图层（A4）：逐格地形与城市 / 格边（河·路·铁·桥·轨距）/ 印刷永久工事 */
export const mapLayers = bootstrapData(mapLayersRaw, MapLayersDataSchema, 'map-layers.json')

/** 战斗单位数值库（A5）：轴心地面单位（含非战斗；引擎只加载 valued 以上） */
export const unitsAxis = bootstrapData(unitsAxisRaw, UnitsDataSchema, 'units-axis.json')

/** 战斗单位数值库（A5）：苏联地面单位 */
export const unitsSoviet = bootstrapData(unitsSovietRaw, UnitsDataSchema, 'units-soviet.json')

/** 空军专表（A5）：22 型 */
export const aircraft = bootstrapData(aircraftRaw, AircraftDataSchema, 'aircraft.json')

/**
 * 辅助卡分区（A10）：6 张卡的卡面尺寸与 15 个分区矩形（卡面像素坐标）
 *
 * 用途：把「盒」按真实卡面渲染，并把盒内算子摆进标定好的分区
 * （死人堆 / 标记存放 / 拆分单位 / 编队抽取 / 特补师池 / 警戒单位池 / 地图外东北·东南 / 空军激活·未激活）。
 */
export const auxCards = bootstrapData(auxCardsRaw, AuxCardsDataSchema, 'aux-cards.json')

/**
 * 印卡扫描图（A11）：表格屏直接显示**官方印刷卡面**（12 张：官方图表 v4.3 四页 / 补给与补员 /
 * 双方重建表 / TEC 与地形图例 / 回合天气与铁路容量轨 / 变量撤离与随机事件）
 *
 * 用途：用户口径「盒还有表格可以直接用素材库里辅助卡图片」——表格屏不必手画版式，
 * 原卡就是权威（比例、图例、脚注照原样）；引擎投影的"数据表"作为另一面视图并存。
 * 与 `auxCards` 的分工：那张是**分区标定**（能往盒里摆算子），这张是**整页查阅图**。
 */
export const panelScans = bootstrapData(panelScansRaw, PanelScansDataSchema, 'panel-scans.json')

/** 剧本库（A8）：7 个剧本的初设数值/选项/继承、生效补给源、胜利条件、共识开关与可选规则 */
export const scenarios = bootstrapData(scenariosRaw, ScenariosDataSchema, 'scenarios.json')

/** 初设索引（A8）：1155 条单位位置/减损/数量注记（scenario_id ∈ {1,3,5,7}） */
export const scenarioSetup = bootstrapData(
  scenarioSetupRaw,
  ScenarioSetupDataSchema,
  'scenario-setup.json',
)

/** 到达表（A8·轴心）：12 个日期块 + 可变撤离 / 随机事件表 */
export const arrivalsAxis = bootstrapData(arrivalsAxisRaw, ArrivalsDataSchema, 'arrivals-axis.json')

/** 到达表（A8·苏联）：14 个日期块 + 特殊补员表 */
export const arrivalsSoviet = bootstrapData(
  arrivalsSovietRaw,
  ArrivalsDataSchema,
  'arrivals-soviet.json',
)

/** 编队库（A8）：17 个多单位编队（13.7）的双方口径代号 / 组成 / 各剧本初设分布 */
export const formations = bootstrapData(formationsRaw, FormationsDataSchema, 'formations.json')

export type {
  AircraftData,
  AircraftRecord,
  AircraftType,
  ArrivalBlock,
  ArrivalsData,
  ChartsCrtData,
  ChartsSupplyReplData,
  ChartsTablesData,
  ChartsTecData,
  CrtData,
  DataFileMeta,
  DataStatus,
  DensityStep,
  EdgeLayer,
  FactorSet,
  Formation,
  FormationsData,
  GridTable,
  HexLayer,
  HexRef,
  IsoDate,
  MapConfigData,
  MapLayersData,
  MarkerRecord,
  MarkerSide,
  MarkersData,
  PrintedHedgehog,
  PrintedHedgehogOwners,
  PanelScan,
  PanelScanScreen,
  PanelScansData,
  RailGauge,
  RebuildEntry,
  RebuildItem,
  RebuildRow,
  ReplSideData,
  RulesConstantsData,
  Scenario,
  ScenarioAirSetup,
  ScenarioAirSetupPolicy,
  ScenarioSetup,
  ScenarioSetupData,
  ScenariosData,
  SetupEntry,
  SetupIndexNotes,
  SetupNotes,
  Side,
  SidePair,
  SpecialReplKind,
  SpecialReplRow,
  SupplySideData,
  TecAttackMod,
  TecData,
  TecFeature,
  TecMpValue,
  UnitFactorsRef,
  UnitRecord,
  UnitsData,
  UnitSide,
  VictoryData,
} from './schema'

export { DATA_VERSION } from './version'
export { DataError, formatIssuePath, formatIssues } from './errors'
export { bootstrapData, validateData } from './pipeline'
export { deepFreeze } from './freeze'
export type { DeepReadonly } from './freeze'
