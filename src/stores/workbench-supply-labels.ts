/**
 * workbench-supply-labels.ts —— C8 补给标签族（12.3 / 12.6 / 12.7 的界面文案）
 *
 * B3-2b18（2026-11-21）：搬出 6 个声明 / 64 行（两段不连续）：
 * `SUPPLY_STATUS_LABELS`（12.6 判定结论中文名）/ `affectsSupplyNet`（12.3b / 12.7 的源判定）/
 * `cancelSupply`（12.0 流程中止）/ `supplySourceKindLabel` / `supplySourceLabel` /
 * `supplyStatusLabel`。函数体**零改写**。
 *
 * ## 为什么能放任意装配点
 *   4 个依赖（`clearSupply` / `dumpById` / `pushLog` / `supplyStockLabelOf`）全是 `function` 声明（提升），
 *   6 处调用（`placeAt` / `removeAt` 的摆子钩子；`addSupplySource` / `beginSupplyCheckNow` /
 *   `chooseSupplySourceNow` / `pickSupplySourceAtHexNow` 的日志文案；store 返回）全在运行期，
 *   故本域**没有** TDZ 约束，装配点选在 airFacility 段之后只为就近读。
 *
 * ## 端口（9 项 = 4 依赖 + 5 返回）
 *   `affectsSupplyNet` 不在公开面（快照无此键），但 facade 的摆子钩子要用 ⇒ 仍需 return。
 */

import type { BaseSourceKind, SupplySourceKind, SupplySourceOption } from '@/engine/rules'
import type { Derivation } from '@/engine/derivation'
import {
  hexLabel,
  isExtenderUnit,
  type ConsoleUnit,
  type WorkbenchLogEntry,
} from './workbench-model'
import type { SpDump } from './supply-types'

/** C8 补给标签域的端口（9 项 = 4 依赖 + 5 返回，2026-11-21 实测）。 */
export interface SupplyLabelsDeps {
  clearSupply: () => void
  dumpById: (dumpId: string) => SpDump | undefined
  pushLog: (
    kind: WorkbenchLogEntry['kind'],
    text: string,
    rule?: string,
    derivation?: Derivation,
  ) => void
  supplyStockLabelOf: (dump: SpDump) => string
}

export function createSupplyLabelsDomain(deps: SupplyLabelsDeps) {
  const { clearSupply, dumpById, pushLog, supplyStockLabelOf } = deps

  /** C8：12.6 判定结论的中文名（供界面显示；键为引擎的 `status` 值） */
  const SUPPLY_STATUS_LABELS: Record<string, string> = {
    inSupply: '有追溯补给（12.6a）',
    canEatOffTheMap: '无追溯补给，可吃图上补给（12.6c）',
    outOfSupply: '断补（12.6d）',
    notRequired: '不需补给（12.0）',
  }

  /**
   * 补给网是否会被这个单位影响（12.3b 的投递 HQ、12.7 的延补队都是**源**）
   *
   * 只有这两类单位的摆上/移除/被摧毁才需要重判，避免每次摆子都白算一遍。
   */
  function affectsSupplyNet(unit: ConsoleUnit): boolean {
    return unit.specialized.includes('hq') || isExtenderUnit(unit)
  }

  /** C8：放弃本次补给检查（中止 12.0 流程；已落盘的结算不自动回滚） */
  function cancelSupply(): void {
    clearSupply()
    pushLog('info', '放弃本次补给检查（12.0 流程中止）', '12.0')
  }

  /** C8：来源类别名（12.3a/b、12.6a①②、12.7、12.6c） */
  function supplySourceKindLabel(kind: SupplySourceKind | BaseSourceKind): string {
    switch (kind) {
      case 'dump':
        return '补给站直接拖取（12.3a）'
      case 'hqThrow':
        return '指挥部投递（12.3b）'
      case 'baseSource':
        return '追溯补给源（12.6a）'
      case 'extender':
        return '延补队（12.7）'
      case 'eatOffTheMap':
        return '吃图上补给（12.6c）'
      case 'edgeRail':
        return '地图边缘铁路格（12.6a①）'
      case 'supplySourceHex':
        return '专规补给源格（12.6a①）'
      case 'detrainable':
        return '火车卸货格（12.6a②）'
    }
  }

  /** C8：来源条目文本（日志与界面；距离/「相邻即可」都是引擎给的结论） */
  function supplySourceLabel(source: SupplySourceOption): string {
    const where = source.hex === null ? '' : `${hexLabel(source.hex)} `
    const distance = source.distanceMp === null ? '' : `｜${source.distanceMp} MP`
    const via = source.viaAdjacency ? '｜相邻即可（12.3c）' : ''
    // 12.1b：同格可能有多份持仓（地面账本 / 装载在运输点数上）⇒ 点名本次取的是哪一处
    const stock = source.stockId === undefined ? undefined : dumpById(source.stockId)
    const stockText =
      source.stockLabel !== undefined
        ? `｜${source.stockLabel}`
        : stock === undefined
          ? ''
          : `｜${supplyStockLabelOf(stock)}`
    return `${where}${supplySourceKindLabel(source.kind)}${distance}${via}${stockText}`
  }

  /** C8：12.6 判定结论的中文名 */
  function supplyStatusLabel(status: string): string {
    return SUPPLY_STATUS_LABELS[status] ?? status
  }
  /**
   * 公开面清单（P2）：原 facade `workbench.ts` return 区属于本域的键，搬回域内。
   *
   * 为什么搬：这批键是对外承诺的接口，以前登记在 facade 的 1,005 键 return 表里，
   * 于是任何本域改动都要去共享文件登记一次 —— 两人并行改 store 必在 return 区冲突。
   * 搬到域内后，本域的改动人只改本文件；facade 只留一行 `...xxx.publicSurface`。
   *
   * 纪律：增删对外键时**同步改这里的清单**，否则公开面快照（1,013 键）会红。
   */
  const publicSurface = {
    cancelSupply,
    supplySourceKindLabel,
    supplySourceLabel,
    supplyStatusLabel,
  }
  return {
    publicSurface,
    affectsSupplyNet,
    cancelSupply,
    supplySourceKindLabel,
    supplySourceLabel,
    supplyStatusLabel,
  }
}
