/**
 * **战报动作键 → 中文名**（UI-4 修正，2026-11-25）
 *
 * ## 为什么要这一层
 *   战报面板直接渲染 `entry.action`（引擎的英文键，如 `combatDice` / `eatOffTheMap`），
 *   玩家看到的是内部标识；66 个键里还有 `skip+default` 这种拼出来的复合键。
 *   ⇒ 展示一律走本表；**不认识的键统一写「未分类」**（不猜、不退回英文）。
 *
 * ## 口径
 *   · 键只来自引擎与界面的既有调用（`action: '...'`），本表不含任何编造的动作；
 *   · 同一动作的「声明 / 掷骰 / 结果」分步各自成键，分别给名，不合并；
 *   · `skip+default` 是流程跳过 + 采用缺省的一步，读作「跳过（采用缺省）」。
 */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  // 初设与流程
  place: '落子',
  remove: '撤回算子',
  skip: '跳过',
  'skip+default': '跳过（采用缺省）',
  answer: '应答',
  cancel: '放弃选择',
  cleanUp: '清理',
  consolidate: '整补',
  reserveRelease: '预备队放行',
  securityNeeds: '警戒需求',
  slowMobilizationUnlock: '缓动解禁',
  frontalReserves: '正面预备队',
  variableExit: '变量撤离',
  variableRepl: '变量补员',
  attritionRoll: '损耗掷骰',
  manualRoll: '手动掷骰',

  // 地面移动与运输
  move: '移动',
  railMove: '铁路运输',
  breakdown: '拆解',
  rebuild: '重建',
  engineer: '工兵作业',
  fuel: '加油',
  transportLoad: '装运',
  transportUnload: '卸载',
  airUnitLoad: '装飞机',
  airCargo: '空运装载',
  airCargoReturn: '空运归还',
  airCargoLoss: '空运损失',
  airSupplyLoad: '空中补给装载',
  airSupplyReturn: '空中补给归还',
  airTransfer: '转场',

  // 战斗与炮击
  attack: '攻击',
  overrun: '强袭',
  combatSupply: '攻击补给判定',
  combatOptions: '战斗选项',
  combatSurprise: '突袭判定',
  combatTerrain: '地形修正',
  combatAr: '战力比',
  combatDice: '战斗掷骰',
  combatLosses: '战斗损失',
  combatRetreat: '战斗撤退',
  combatAdvance: '战后推进',
  specialCombat: '特殊战斗',
  barrageDeclare: '炮击声明',
  barrageShifts: '炮击修正',
  barrageSupply: '炮击补给判定',
  barrageDice: '炮击掷骰',
  barrageOutcome: '炮击结果',

  // 空军
  airMission: '空中任务',
  airMissionResolve: '空中任务结算',
  airIntercept: '拦截',
  airInterceptCombat: '拦截战斗',
  airCombat: '空战',
  airFlak: '对空火力',
  airReturn: '返航',
  airRefit: '飞机整备',
  airBaseCapture: '机场占领',
  airBaseReduce: '机场降级',

  // 补给
  supplyTrace: '补给线判定',
  supplyPickup: '取补给',
  supplyCache: '补给堆放',
  supplyOos: '断补判定',
  acceptOutOfSupply: '接受断补',
  offMapSupplyDeposit: '地图外补给入库',
  supplyTrain: '补给列车',
  supplyArrival: '补给抵达',
  arrival: '抵达',
  arrivalRail: '铁路抵达',
  eatOffTheMap: '地图外吃补',
  rebuildPlace: '重建落位',

  // 盒与增援
  breakoutAttempt: '突围尝试',
  panzerObligationDg: '装甲义务（DG）',
  specialRepl: '特殊补员',
}

/**
 * 取动作的中文名。
 *
 * @param action 引擎记录的动作键（英文）；空串或未知键 → 「未分类」
 */
export function actionLabel(action: string): string {
  const key = action.trim()
  if (key === '') return '未分类'
  return ACTION_LABELS[key] ?? '未分类'
}
