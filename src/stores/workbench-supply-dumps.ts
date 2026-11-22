/**
 * workbench-supply-dumps.ts —— C8 的 SP 账本（12.1a / 12.1b / 专规 3.4b / 12.6a / 9.14b）
 *
 * B3-2b11（2026-11-21）：`addSpAtHex`（SP 落账**唯一入口**，手工新增与空运卸载共用）及其余
 * 9 个账本动作整块搬出 facade（265 行）。函数体只改写 2 行（见下）。
 *
 * ## 装配位置为什么在 C8 段开头（而不是惯常的 7xxx 建域区）
 *   `addSpAtHex` 是 air 域的端口（被 `const airDomain = createAirDomain` 的装配段收走），
 *   `setSpDumpHoldings` 也被紧随其后的一个域收走 ⇒ 本域**必须先于 air 域装配**。端口里除
 *   `panzerGroupRulesOn`（晚声明 computed）外都能按值传；那三个晚声明只读/写穿状态用下面三种招法：
 *
 *   1. `panzerGroupRulesOn`（facade 专规 3.4b 段的 computed）：给 getter，切片内就地
 *      `computed(() => deps.panzerGroupRulesOn())` ⇒ 函数体继续按 `.value` 读；
 *   2. `spDumpPanzerGroups`（专规 3.4b 段的 `ref`，本块只**整体重置**）：给回调
 *      `resetSpDumpPanzerGroups()`，切片里写 `spDumpPanzerGroups.value = {}` → 改调它；
 *   3. `pendingSpGroupAssignment`（同段的 `ref`，同样只整体重置）：同上。
 *
 *   这两处 `ref` 是**写穿**用法（不是只读），getter + `computed` 包装解决不了赋值，故改用回调 ——
 *   回调在装配处创建、在函数被调用时才执行，因此晚声明不构成 TDZ。
 */
import { computed } from 'vue'
import type { ComputedRef, Ref } from 'vue'

import { holdingsToT, planSpMerge, planSpSplit, tToHoldings } from '@/engine/rules'
import type { PanzerGroup, Side } from '@/engine/rules'
import type { HexRef } from '@/data'
import { sameHex } from '@/engine/hex-geometry'
import { createId } from '@/shared'
import type { RuleOutcome } from '@/engine/result-types'
import type { Derivation } from '@/engine/derivation'
import type { SpDump } from './supply-types'
import type { SpHoldings } from '@/engine/rules'
import { hexLabel, parseHexPath } from './workbench-model'
import type { ConsoleUnit, WorkbenchLogEntry } from './workbench-model'

/** C8 SP 账本域的端口（12 项，2026-11-21 实测）。 */
export interface SupplyDumpsDeps {
  /** 12.1b：账本本体（唯一记账处） */
  spDumps: Ref<SpDump[]>
  /** C8：新增账本条目的界面输入 */
  spDumpDraft: Ref<{
    hexText: string
    sp: number
    t: number
    panzerGroup?: PanzerGroup | null
  }>
  activeSide: ComputedRef<Side>
  units: Ref<ConsoleUnit[]>
  pushLog: (
    kind: WorkbenchLogEntry['kind'],
    text: string,
    rule?: string,
    derivation?: Derivation,
  ) => void
  /** 补给引擎结论收口（失败即写 `supplyError` 并记日志） */
  acceptSupply: <T>(outcome: RuleOutcome<T>, action: string) => T | null
  /** 12.2b：持仓减少 ⇒ 释放本阶段接力锁 */
  releaseSpRelayLocks: (hex: HexRef, side: Side, t: number) => void
  /** 专规 3.4b：该站归属的集群（未登记 ⇒ null） */
  panzerGroupOfDump: (dumpId: string | null) => PanzerGroup | null
  /** 专规 3.4b：声明/撤销归属 */
  setDumpPanzerGroupNow: (dumpId: string, group: PanzerGroup | null) => void
  /** facade 21625 的 computed ⇒ getter */
  panzerGroupRulesOn: () => boolean
  /** 21602 的 `ref`：本块只整体重置 ⇒ 写穿回调 */
  resetSpDumpPanzerGroups: () => void
  /** 21635 的 `ref`：本块只整体重置 ⇒ 写穿回调 */
  resetPendingSpGroupAssignment: () => void
}

export function createSupplyDumpsDomain(deps: SupplyDumpsDeps) {
  const {
    spDumps,
    spDumpDraft,
    activeSide,
    units,
    pushLog,
    acceptSupply,
    releaseSpRelayLocks,
    panzerGroupOfDump,
    setDumpPanzerGroupNow,
    resetSpDumpPanzerGroups,
    resetPendingSpGroupAssignment,
  } = deps

  /** 专规 3.4b 是否生效（facade 21625 的 computed，晚声明 ⇒ 就地包一层保住 `.value`） */
  const panzerGroupRulesOn = computed(() => deps.panzerGroupRulesOn())

  /**
   * 12.1b：在指定格落一条 SP 账本条目（**唯一入口**——手工添加与空运卸载共用同一套簿记）
   *
   * 「任何含有 SP 的位置……都被称为补给站」⇒ 无论 SP 是玩家手工摆的，还是空运卸下来的，
   * 落盘形态与 专规 3.4b 的装甲集群待办都要一致（否则同一批 SP 因来源不同而待遇不同）。
   */
  function addSpAtHex(input: {
    hex: HexRef
    side: Side
    sp: number
    t: number
    /** 日志里说明来源（如「14.9f 空运卸载」）；缺省按手工新增 */
    source?: string
    /** 专规 3.4b：到货/初设时由玩家选定的装甲集群；带上即立刻归属，不再进待办 */
    panzerGroup?: PanzerGroup
  }): string | null {
    const sp = Math.max(0, Math.trunc(input.sp))
    const t = Math.max(0, Math.trunc(input.t))
    if (sp === 0 && t === 0) return null
    /*
     * 12.1b / §5-C：**同格同方只有一条账本**（补给站是"位置"，不是"条目"）
     *
     * 修前这里无条件 `createId('sp')` 再 push：同一格再落一次就多出**第二条**账本，
     * 而付款路径全是 `find(dump => dump.side===.. && sameHex(..))` 只取**第一条** ⇒
     * 第二条的 SP 变成"看得见、付不出"的死额（装载/整备/轰炸会误报"SP 不足"），
     * 且 专规 3.4b 的待归属与装甲集群归属挂在 id 上，同格两 id 会各记一半。
     * 并入既有条（**沿用原 id**）可同时消掉这两件事：既有引用（`spDumpPanzerGroups` /
     * `pendingSpGroupAssignment` / `barrageSupplyDumpId`）不会悬空。
     *
     * 专规 3.4b（用户裁定）：**同格两集群的 SP 是两本账**——Guderian 与 Hoth 不能并成一条，
     * 否则两集群的余额会被合成一个数，之后既选不了、也扣不对。故并入条件还要加"集群相同"；
     * 未声明归属的站与"未带集群"的落账仍并入（12.1b：同格同方只有一条账本）。
     *
     * 2026-11-09 补充：同格已有 G/H **两本账**时，未带集群的落账不再并进任何一本
     * （否则等于静默把漏选归属的 SP 算给某个集群）⇒ 另立第三本账并在日志告警。
     * 同格只有**一个**集群（或只有未归属站）时无歧义，仍按 12.1a 并入。
     */
    const axisGated = panzerGroupRulesOn.value && input.side === 'axis'
    const inputGroup = axisGated ? input.panzerGroup : undefined
    const sameHexDumps = spDumps.value.filter(
      (dump) => dump.side === input.side && sameHex(dump.hex, input.hex),
    )
    /*
     * 专规 3.4b（用户 2026-11-11）：**同格只有一个集群时也不自动继承**，仍须本次指定。
     * ⇒ 轴方带 SP 的落账只并入「集群相同」的那一本；没带选择时下面直接拒绝，不再从同格既有站继承归属。
     */
    const existing =
      axisGated && sp > 0
        ? inputGroup === undefined
          ? undefined
          : sameHexDumps.find((dump) => panzerGroupOfDump(dump.id) === inputGroup)
        : sameHexDumps[0]
    /*
     * 专规 3.4b（用户 2026-11-11 口径）：**解除日之前，任何德军 SP 到场都必须由玩家指定集群**——
     * 不提供「不属任何集群」这个选项，也不从同格既有站自动继承。初设 / 增援 / 补给列车 /
     * 可变增援 / 手工新增共用本入口，判据只写在这一处：`sp > 0` 的轴方落账没带
     * `panzerGroup` ⇒ 整笔拒绝，不落盘、不建待办。解除日（19 August）之后闸门自动失效。
     */
    if (axisGated && sp > 0 && inputGroup === undefined) {
      pushLog(
        'warning',
        `德军 SP（${hexLabel(input.hex)}，${String(sp)} SP）未指定装甲集群 ⇒ 不落账；` +
          `3.4b 要求新到的轴方 SP 立即归属 Guderian / Hoth（同格既有归属也不自动继承）`,
        '3.4b',
      )
      return null
    }
    if (existing !== undefined) {
      // 12.1a：并入后仍保持「尽可能并为 SP」的规范形（2T + 2T ⇒ 1 SP + 0 T，而不是留成 4T）
      const merged = tToHoldings(holdingsToT({ sp: existing.sp + sp, t: existing.t + t }))
      spDumps.value = spDumps.value.map((dump) =>
        dump.id === existing.id ? { ...dump, sp: merged.sp, t: merged.t } : dump,
      )
      pushLog(
        'info',
        `并入既有补给站 ${hexLabel(existing.hex)}：+${String(sp)} SP +${String(t)} T ⇒ ${String(merged.sp)} SP + ${String(merged.t)} T（12.1a）`,
        '12.1a',
      )
      /*
       * 专规 3.4b：并进去之后这笔新到 SP 的归属，跟随该站已有的归属；
       * 未归属的站只可能走「本次带了玩家选择」这一支（无选择已在上面被闸拒绝）⇒ 立即补写。
       */
      if (axisGated && panzerGroupOfDump(existing.id) === null && input.panzerGroup !== undefined) {
        setDumpPanzerGroupNow(existing.id, input.panzerGroup)
      }
      return existing.id
    }
    const id = createId('sp')
    spDumps.value = [...spDumps.value, { id, hex: input.hex, side: input.side, sp, t }]
    /*
     * 专规 3.4b：新落的轴方 SP 必须立即归属某一装甲集群。
     * 无选择已被上面的闸拒绝 ⇒ 走到这里时 `panzerGroup` 必有值，直接写归属、不进待办。
     * （B50：专规 3.4b 未启用时 `axisGated` 为假，不写归属。）
     */
    if (axisGated && input.panzerGroup !== undefined) {
      setDumpPanzerGroupNow(id, input.panzerGroup)
    }
    pushLog(
      'info',
      `新增补给站 ${hexLabel(input.hex)}：${String(sp)} SP + ${String(t)} T（${input.source ?? '12.1b'}）`,
      '12.1b',
    )
    return id
  }

  /** C8：新增一条 SP 账本条目（12.1b：任何含 SP 的位置都是补给站） */
  function addSpDump(): boolean {
    const draft = spDumpDraft.value
    const hex = parseHexPath(draft.hexText)[0] ?? null
    if (hex === null) {
      pushLog('warning', `补给站格号应为「列.行」（如 36.13），收到「${draft.hexText}」`, '12.1b')
      return false
    }
    const sp = Math.max(0, Math.trunc(draft.sp))
    const t = Math.max(0, Math.trunc(draft.t))
    if (sp === 0 && t === 0) {
      pushLog('warning', 'SP 与 T 不能同时为 0（12.1a：1 SP = 4 T）', '12.1a')
      return false
    }
    return (
      addSpAtHex({
        hex,
        side: activeSide.value,
        sp,
        t,
        panzerGroup: draft.panzerGroup ?? undefined,
      }) !== null
    )
  }

  /** 专规 3.4b：手工新增 SP 时选定装甲集群（无「不属任何集群」选项） */
  function setSpDumpDraftGroup(group: PanzerGroup | null): void {
    spDumpDraft.value = { ...spDumpDraft.value, panzerGroup: group }
  }

  /** C8：移除一条 SP 账本条目 */
  function removeSpDump(id: string): void {
    const found = spDumps.value.find((dump) => dump.id === id)
    spDumps.value = spDumps.value.filter((dump) => dump.id !== id)
    if (found !== undefined) {
      pushLog('info', `移除补给站 ${hexLabel(found.hex)}（${found.sp} SP + ${found.t} T）`, '12.1b')
      // 12.6a：补给站不是追溯补给的来源 ⇒ 不重判断补标记（12.8a）
    }
  }

  /**
   * C8：初设的 SP **整批落账**（12.1b / 12.1c / 12.1d）
   *
   * ## 为什么需要这个入口（修的是什么）
   *   初设阶段把剧本页的 SP 落成**盘面算子**（`stores/setup.ts` 的 `countersFor`），并记在
   *   **setup store 自己的台账**里；而「付款/拖取/追溯」这些**用账之处**读的是本 store 的
   *   `spDumps` 账本（本店的设计口径：账本＝唯一记账处）。两者不通 ⇒ 初设摆在地图上的 SP
   *   **不被认作补给站**，表现为整备付款「可付款补给站：0 处」（15.1B）、战斗补给与 12.3a
   *   拖取也看不到它。本动作把 setup 的台账整批写进账本，把这条路接通。
   *
   * ## 口径
   *   · 12.1b：**任何含 SP 的位置**（无论是否装载）都是补给站 ⇒ 初设的 SP 位置一律落账；
   *   · 12.1a：1 SP = 4 T ⇒ 只记整 SP 数，`t` 置 0（拆分/找零由账本动作负责）；
   *   · **整批替换**而非追加：setup 的台账是该时刻盘面 SP 的全集，重复落账会导致翻倍；
   *   · **此处不做全场追溯重判**：初设期全场重判很贵（逐单位算覆盖集），而追溯结论的判定时点是
   *     进入补给阶段/移动阶段（见 `refreshTraceSupply` 的触发时点）与玩家手动 `evaluateTraceSupplyNow`；
   *     本动作只负责把「账本」与「初设台账」对齐，让付款/拖取的候选项看得见这些 SP。
   */
  function landSetupSpDumps(
    dumps: readonly { id: string; hex: HexRef; side: Side; points: number }[],
  ): void {
    spDumps.value = dumps.map((dump) => ({
      id: dump.id,
      hex: { ...dump.hex },
      side: dump.side,
      sp: Math.max(0, Math.trunc(dump.points)),
      t: 0,
    }))
    if (dumps.length === 0) return
    pushLog('info', `初设 SP 落账：${dumps.length} 处补给站（12.1b / 12.1c / 12.1d）`, '12.1b')
  }

  /** C8：清空 SP 账本（初设重置用；同上不在初设期做全场重判） */
  function clearSpDumps(reason = '账本清空'): void {
    resetSpDumpPanzerGroups()
    resetPendingSpGroupAssignment()
    if (spDumps.value.length === 0) return
    spDumps.value = []
    pushLog('info', `SP 账本清空（${reason}）`, '12.1b')
  }

  /** C8：直接改写某条 SP 账本（界面手填 SP/T；只是收玩家输入，不做规则运算） */
  function setSpDumpHoldings(id: string, holdings: SpHoldings): void {
    /*
     * B32 步骤 5（12.1b / 13.2f）：来源可以是**装载在运输点数上的 SP**（id 前缀 "unit:"）⇒
     * 写回那枚算子的 loadedSpT（12.1a 的 SP↔T 换算由 holdingsToT 兜住）。
     * 所有付款路径共用本函数，故一处分流即全覆盖。
     */
    if (id.startsWith('unit:')) {
      const target = units.value.find((unit) => 'unit:' + unit.instanceId === id)
      if (target === undefined) return
      target.loadedSpT = holdingsToT({ sp: holdings.sp, t: holdings.t })
      // 12.8a：装载中的 SP 用尽不重判断补标记；12.3b 的投递资格按付款时点的实时持仓判
      return
    }
    const prev = spDumps.value.find((dump) => dump.id === id)
    if (prev !== undefined) {
      const beforeT = holdingsToT({ sp: prev.sp, t: prev.t })
      const afterT = holdingsToT(holdings)
      // 12.2b：卸下后立即消耗掉的 SP 不再算接力 ⇒ 按持仓减少释放本阶段锁
      if (beforeT > afterT) releaseSpRelayLocks(prev.hex, prev.side, beforeT - afterT)
    }
    spDumps.value = spDumps.value.map((dump) =>
      dump.id === id ? { ...dump, sp: holdings.sp, t: holdings.t } : dump,
    )
    /*
     * 12.1b / 12.8a（用户 2026-11-13 口径）：补给站用尽**不**重判断补标记。
     * 追溯判定的持仓口径锁定在补给阶段入口的快照；此时刻的持仓变化只影响
     * 付款时点的可达性（`drawableDumpsFor` / `deliverableDumpsFor` 本就实时算）。
     */
  }

  /** C8 12.1a：**加总**（T 满 4 并为等额 SP，减少堆叠） */
  function mergeSpDumpHoldings(id: string): boolean {
    const dump = spDumps.value.find((item) => item.id === id)
    if (dump === undefined) return false
    const data = acceptSupply(planSpMerge({ holdings: { sp: dump.sp, t: dump.t } }), '加总 SP')
    if (data === null) return false
    setSpDumpHoldings(id, data.holdings)
    pushLog('success', `${hexLabel(dump.hex)} ${data.detail}`, '12.1a')
    return true
  }

  /**
   * 9.14b：把**夺取到的 T** 记到某格某方的账本上（该格该方无账本则新建）
   *
   * 9.14b：被夺取的部分「归敌方玩家」，未被夺取的部分**被摧毁**——故夺取额是**新账本**
   * （与原账本无关，原账本随后整条删除）。落盘后再按 12.1a 加总（T 满 4 并为等额 SP）。
   */
  function grantSpDumpT(hex: HexRef, side: Side, t: number): void {
    const amount = Math.max(0, Math.trunc(t))
    if (amount === 0) return
    const existing = spDumps.value.find((item) => item.side === side && sameHex(item.hex, hex))
    if (existing === undefined) {
      spDumps.value = [
        ...spDumps.value,
        { id: createId('sp'), hex: { col: hex.col, row: hex.row }, side, sp: 0, t: amount },
      ]
    } else {
      spDumps.value = spDumps.value.map((item) =>
        item.id === existing.id ? { ...item, t: item.t + amount } : item,
      )
    }
    const target = spDumps.value.find((item) => item.side === side && sameHex(item.hex, hex))
    if (target !== undefined) mergeSpDumpHoldings(target.id)
  }

  /** C8 12.1a：**拆分**（把整 SP 找零为 T，总额不变；可支付零钱） */
  function splitSpDumpHoldings(id: string, spToSplit: number): boolean {
    const dump = spDumps.value.find((item) => item.id === id)
    if (dump === undefined) return false
    const data = acceptSupply(
      planSpSplit({ holdings: { sp: dump.sp, t: dump.t }, spToSplit: Math.trunc(spToSplit) }),
      '拆分 SP',
    )
    if (data === null) return false
    setSpDumpHoldings(id, data.holdings)
    pushLog('success', `${hexLabel(dump.hex)} ${data.detail}`, '12.1a')
    return true
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
    addSpDump,
    setSpDumpDraftGroup,
    removeSpDump,
    landSetupSpDumps,
    clearSpDumps,
    setSpDumpHoldings,
    mergeSpDumpHoldings,
    splitSpDumpHoldings,
  }
  return {
    publicSurface,
    addSpAtHex,
    addSpDump,
    setSpDumpDraftGroup,
    removeSpDump,
    landSetupSpDumps,
    clearSpDumps,
    setSpDumpHoldings,
    mergeSpDumpHoldings,
    grantSpDumpT,
    splitSpDumpHoldings,
  }
}
