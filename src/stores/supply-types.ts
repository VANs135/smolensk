import type { HexRef, Side } from '@/data'

export interface SpDump {
  id: string
  hex: HexRef
  side: Side
  /** 整 SP 数 */
  sp: number
  /** 补给指示物数（T） */
  t: number
  /**
   * B32 步骤 5（12.1b / 13.2f）：该来源是**装载在某枚运输算子上**的 SP ⇒ 这里放那枚算子的实例 id
   *
   * 它的 id 形如 "unit:<实例id>"；扣款走 setSpDumpHoldings 的分流（写回该算子的 loadedSpT），
   * 不在 SP 账本里另立条目。
   */
  carriedBy?: string
  /**
   * 13.2g-B：承运算子是不是**编内卡车**（编内卡车 ⇒ 只许**同一多单位编队**内的单位拖取）
   *
   * 判据只有一处：引擎 `canDrawFromCarrier`。常规运输点数不带此项（照 13.2f/12.1b 照常可拖）。
   */
  carrierIsOrganicTruck?: boolean
  /** 13.2g-B：承运算子的编队番号（3.1c；`null` ＝ 无编队 ⇒ 它的 SP 谁都拖不走） */
  carrierFormation?: string | null
}
