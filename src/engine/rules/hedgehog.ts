import { mapLayers } from '@/data'

/**
 * 环形工事（OCS 16.0 / Smolensk 专规 1.3）—— 印刷工事读取 + 战斗/奇袭 DRM
 *
 * ## 本作数据事实（map-layers.json，已核对）
 *   58 个印刷工事，**全部**为 `level: 1`、`permanent: true`、`cannotReduce: true`
 *   ⇒ 专规 1.3a「地图上印刷有一些环形工事（OCS 16.0），它们**永久存在且不可降低**」全部成立。
 *
 * ## 战斗效果（16.0d / 16.0e）
 *   - 战斗掷骰修正 = **−等级**（「三级环形工事的掷骰修正为 −3」，见 `hedgehogCombatDrm`）；
 *   - 奇袭掷骰修正 = **−1**，**不随等级变化**（单一定义处为 `combat.ts#HEDGEHOG_SURPRISE_DRM`，取自
 *     rules-constants.json 的 combat.hedgehogSurpriseDrm，本模块**不再另立一份**）；
 *   - 环形工事给所在格战斗单位**重型反坦克效果**（16.0e）—— 由 `battle.ts` 的 AT 判定消费。
 *
 * 修建与缩减（16.0b/c）见 `construction.ts`（那里还有专规 1.3a/1.3b 的书面与上限约束）。
 */

/** 格坐标（col,row）→ 工事记录索引（键格式与 `hex-geometry` 的格号文本一致：`列.行`） */
const hedgehogIndex = new Map<string, (typeof mapLayers.printedHedgehogs)[number]>()

/** 一次性构建索引（模块首次加载时） */
function buildIndex(): void {
  if (hedgehogIndex.size > 0) return
  for (const h of mapLayers.printedHedgehogs) {
    hedgehogIndex.set(`${h.col}.${h.row}`, h)
  }
}
buildIndex()

/** 印刷工事记录（map-layers.json 的形状） */
export type PrintedHedgehog = (typeof mapLayers.printedHedgehogs)[number]

/** 取某格的印刷工事记录（无则 null） */
export function getPrintedHedgehog(col: number, row: number): PrintedHedgehog | null {
  return hedgehogIndex.get(`${col}.${row}`) ?? null
}

/** 查询某格是否有印刷永久工事（专规 1.3a） */
export function hasPermanentHedgehog(col: number, row: number): boolean {
  return hedgehogIndex.has(`${col}.${row}`)
}

/** 查询某格印刷永久工事等级（0=无，否则 1..N） */
export function getPermanentHedgehogLevel(col: number, row: number): number {
  return getPrintedHedgehog(col, row)?.level ?? 0
}

/**
 * 专规 1.3a：该格的印刷工事是否**永久且不可降低**
 *
 * 数据两个标志都要成立才算（`permanent` 与 `cannotReduce`）；本作 58 个印刷工事两者皆真。
 * `construction.ts#planHedgehogReduce` 以此拒绝任何缩减尝试。
 */
export function isPrintedHedgehogPermanent(col: number, row: number): boolean {
  const h = getPrintedHedgehog(col, row)
  if (h === null) return false
  return h.permanent === true && h.cannotReduce === true
}

/**
 * 16.0d：环形工事给**战斗掷骰**的修正 = **−等级**（对守方有利）
 *
 * 「环形工事对战斗中防御的掷骰修正等于其等级（因此三级环形工事的掷骰修正为 −3）。」
 * 注意与奇袭的 −1 区分：奇袭修正**不随等级变化**（16.0d 末句），单一定义见 `combat.ts`。
 */
export function hedgehogCombatDrm(level: number): number {
  // 显式避开 -0：无工事时返回 +0，免得把 -0 带进掷骰运算
  return level === 0 ? 0 : -level
}

/** 查询全部印刷工事（遍历用） */
export function getAllPermanentHedgehogs(): readonly PrintedHedgehog[] {
  return mapLayers.printedHedgehogs
}
