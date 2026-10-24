<script setup lang="ts">
import { computed } from 'vue'

import { BaseButton, BasePanel, BaseTag } from '@/components/base'
import { CounterPicker, type CounterPickerItem } from '@/components/game'
import {
  counterImageUrlOf,
  fuelMethodLabelOf,
  hexLabel,
  isHqUnit,
  spDumpImageUrlOf,
  useWorkbenchStore,
} from '@/stores'

/**
 * **移动 / 突袭的操作链**（B15a；方案 §4.2「地图优先的操作链」）
 *
 * 为什么要有它：6.1 的「撤销一步 / 结束移动 / 放弃整次移动」原先只挂在 `WorkbenchView`
 * （引擎验证页）——对局台上**根本没有入口**，于是"能不能走完一局"这件事缺了一环
 * （用户四判据的「可玩通」）。本面板把这条链放进**唯一会话框**，与地图上的「就地摊开 + 选枚」配套。
 *
 * 分层纪律（CODE_SPEC）：本组件**不做任何规则计算** —— 移动中的单位、已耗 MP、上一步的结论、
 * ZOC 待决、放下/撤销/结束的合法性全部来自 store（store 转调引擎）；这里只画、只收点击。
 *
 * ## 操作链（与方案 §4.2 的图一致）
 *   地图点堆叠 ⇒ 就地摊开并默认全选 ⇒ **本面板就是那一步之后的动作集**：
 *   ① 改模式（5.4a：只在本方移动阶段、且在**开始移动时**；由 store 裁决）
 *   ② 走一步（地图上点高亮的邻格；本面板显示上一步结论与各单位的 MP 账）
 *   ③ 突袭（8.0/8.1a：地图上点高亮的**突袭目标格**；3 MP 在 9.2 的推进步记账）
 *   ④ 放下某一枚（6.1f：走不动的留在经过的格，其余继续）
 *   ⑤ 撤销一步（6.1）/ 结束移动（6.1 末句）/ 放弃整次移动（全部还原）
 *   ⑥ 4.5a-A 的 ZOC 待决：进入即就地停止，或留在原格
 */

const workbench = useWorkbenchStore()

/** 本次移动中的单位（含已被放下的，用于显示；`selected` 即"仍在动"那些） */
const movingUnits = computed(() => workbench.moveUnits)
/** 上一步的结论（costText / 掉队 / ZOC 停止 / 规则号） */
const lastStep = computed(() => workbench.lastStep)
/** 4.5a-A：进入未抵消 ZOC 的待决 */
const zocConfirm = computed(() => workbench.pendingZocConfirm)
/** 6.1a：MA 是**一阶段的总额度** ⇒ 账要按"已耗 / 可用"显示 */
const selected = computed(() => workbench.selectedUnit)
/** 条 9（M1）：改模式/开始移动的可用判据——有取子清单（选中集合）或单枚选中单位即可 */
const modeTargetReady = computed(() => workbench.movePick !== null || selected.value !== null)
/** 条 10（M1）：开拔前的取子勾选列表（界面用；`movePick` 为空时给空数组） */
const pickItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.movePickChoices.map((unit) => ({
    id: unit.instanceId,
    imageUrl: counterImageUrlOf(unit),
    name: `${unit.name} @ ${hexLabel(unit.hex)}`,
    selected: workbench.movePick?.ids.includes(unit.instanceId) ?? false,
    hex: unit.hex,
  })),
)
/** 条 10（M1）：是否处于"开拔前"状态（有待开拔清单、且尚未真正开始移动） */
const preBegin = computed(() => workbench.movePick !== null && workbench.moveInteraction === null)

/** 6.1f：本次移动中的单位阵列（已放下的灰显） */
const moveUnitItems = computed<readonly CounterPickerItem[]>(() =>
  movingUnits.value.map((unit) => ({
    id: unit.instanceId,
    imageUrl: counterImageUrlOf(unit),
    name:
      `${unit.name}（已耗 ${unit.mpSpent} MP @ ${hexLabel(unit.hex)}` +
      `${unit.movementEnded ? '｜本次移动已结束' : '｜仍在动'}）`,
    selected: !unit.movementEnded,
    disabledReason: unit.movementEnded ? '6.1f：该单位本次移动已结束（放下/走完）' : null,
    hex: unit.hex,
  })),
)

/** 悬停某一枚 ⇒ 同步地图高亮它所在的格 */
function hoverUnit(id: string | null): void {
  const unit = id === null ? null : (workbench.units.find((item) => item.instanceId === id) ?? null)
  workbench.setHoverHex(unit?.hex ?? null)
}

/* ─────────────────── 燃料（12.5；用户 2026-09-16 指正） ───────────────────
 *
 * 用户的指正：**燃料不是在补给阶段算的** —— 12.5c 明说「根据以下的方法，在发生燃料消耗的
 * **任何阶段**，单位都应在燃料消耗时支付对应的燃料补给」；12.5a 又说「即使就移动一格」也要先付。
 * 所以这一手必须能在**每一次开拔的当口**做（本面板就是那个当口），而不是躲在补给段某个面板里。
 *
 * 12.5b 的两半也一并说清（此前只写在引擎的表里，界面上看不到）：
 *   · **要燃料**：移动（耗 MP）、突袭（即使开始移动时就与防御方相邻）；
 *   · **不要燃料**：攻击、防御、轰炸、撤退、战后推进。
 */

/** 12.5c：三种支付方法（A 编队 / B 指挥部 / C 单独单位），代价与持续期各不相同 */
const FUEL_METHODS = [
  { key: 'singleUnit', label: '单独单位法（12.5c-C）：每枚 1T，只在本阶段有效' },
  { key: 'hq', label: '指挥部法（12.5c-B）：1SP，指挥部及其投递距离内的独立单位' },
  { key: 'formation', label: '编队法（12.5c-A）：1SP，整个多单位编队' },
] as const

/**
 * 12.5c（用户 2026-09-17）：**按可用性排的三种方法**（不可用的灰显并给原因）
 *
 * 用户原话：「需要加油的单位点击时未加油都可以点单独法，**编队单位**有额外的编队加油法，
 *   点击 **HQ** 时才能加 HQ 法」。可用性由 store（引擎判据）算好，本组件只做展示。
 */
const fuelMethodOptions = computed(() =>
  FUEL_METHODS.map((option) => {
    const availability = workbench.fuelMethodChoices.find((item) => item.method === option.key)
    return {
      method: option.key,
      label: option.label,
      available: availability?.available ?? false,
      reason: availability?.reason ?? null,
    }
  }),
)

/**
 * 12.5e：本次受益单位里的**指挥部**（界面据此显示"本阶段的投递基点"）
 *
 * 判据不做第二份：`isHqUnit` 是全域唯一谓词（与 store 的 `hqFuelCoverageSet` 同一处）。
 * 只在选中 HQ 法时显示 —— 单独单位法/编队法与 12.5e 的投递基点无关。
 */
const hqFuelThrowLines = computed(() => {
  if (workbench.fuelMethod !== 'hq') return []
  return workbench.fuelTargets
    .filter((unit) => isHqUnit(unit))
    .map((unit) => {
      const origin = workbench.hqFuelThrowOriginOf(unit.instanceId)
      return {
        instanceId: unit.instanceId,
        name: unit.name,
        originLabel: origin === null ? '（尚未投递）' : hexLabel(origin),
      }
    })
})

/** 本次加油的方法（默认单独单位法：它在任何阶段都可用，且不需要编队/HQ 台账） */ /* B32：方法选择改为 **store 字段**（候选集与校验都在 store，方法在组件里就没法按方法分派） */
/** 12.5c-A/B：是否所有受益单位共用同一来源（编队/HQ 法的前提） */

/**
 * I①（12.5c-A）：编队法的**覆盖预览**一行（来源 + 该编队的枚数）
 *
 * 判据全在 store（`fuelFormationCoverage`，与付款时同一处实现）——本组件只把结论拼成一句话。
 * 覆盖预览在"选了编队法 + 已选付款站"之前为空（那时还算不出来源）。
 */
const formationCoverageLine = computed<string | null>(() => {
  const coverage = workbench.fuelFormationCoverage
  if (coverage === null || workbench.fuelMethod !== 'formation') return null
  return `来源：${coverage.sourceLabel}｜编队 ${coverage.formation}`
})

/** I①：本阶段该编队是否已付过编队油（已付 ⇒ 其余成员只能走单独单位法） */
const formationPaidLine = computed<string | null>(() => {
  if (workbench.fuelMethod !== 'formation') return null
  const targets = workbench.fuelTargets
  const formation = targets[0]?.formation ?? null
  if (formation === null) return null
  const paid = workbench.formationFuelThrowOf(formation)
  return paid === null
    ? null
    : `${formation}（来源 ${paid.sourceLabel}，覆盖 ${paid.coveredIds.length} 枚）`
})

/**
 * 12.8e：**突围**已移进专属会话框（`BreakoutPanel`，见 `GameTableView` 的 `session.kind === 'breakout'`）。
 * 修前这一段挂在右栏 `MovePanel` 的 `v-else` 里、**正常突围段不可达**；条 6（R3）把它挪到会话框，
 * 并配合地图"可突围堆叠高亮 + 点单位即自动结算"。此处不再保留突围块。
 */

/** 12.5a：本次要动的单位里，谁耗油、谁已加注 */
const fuelTargetItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.fuelTargets.map((unit) => ({
    id: unit.instanceId,
    imageUrl: counterImageUrlOf(unit),
    name:
      `${unit.name}（${unit.side === workbench.activeSide ? '本方' : '对手'}` +
      `${unit.fuelled ? `｜已加注${fuelMethodLabelOf(unit.fuelMethod)}` : '｜未加注'}）@ ${hexLabel(unit.hex)}`,
    selected: unit.fuelled,
    disabledReason: unit.fuelled ? '12.5a：该单位已加注（同阶段内不必重复付）' : null,
    hex: unit.hex,
  })),
)

/** 12.3a：可作燃料来源的补给站（受益单位都拖得到的那些；图用当前点数的 SP 算子图） */
/**
 * 12.3a 的燃料来源阵列
 *
 * ★ B32 步骤 5：来源可能是**装载在运输点数上的 SP**（12.1b / 13.2f）——那一条的图取**承运算子**的
 * 算子图（与地图同一条选图实现），名称也标明"装载在 X 上"，免得被当成一座印着 SP 的补给站。
 */
const fuelDumpItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.fuelDumpChoices.map((dump) => {
    const carrier =
      dump.carriedBy === undefined
        ? undefined
        : workbench.units.find((unit) => unit.instanceId === dump.carriedBy)
    return {
      id: dump.id,
      imageUrl: carrier === undefined ? spDumpImageUrlOf(dump) : counterImageUrlOf(carrier),
      name:
        carrier === undefined
          ? `${hexLabel(dump.hex)}（${dump.sp} SP / ${dump.t} T）`
          : `${hexLabel(dump.hex)}｜装载在 ${carrier.name} 上（${dump.sp} SP / ${dump.t} T，12.1b）`,
      selected: workbench.fuelDumpId === dump.id,
      hex: dump.hex,
    }
  }),
)

/** 悬停某一座补给站 ⇒ 同步地图高亮 */
function hoverDump(id: string | null): void {
  const dump =
    id === null ? null : (workbench.fuelDumpChoices.find((item) => item.id === id) ?? null)
  workbench.setHoverHex(dump?.hex ?? null)
}
</script>

<template>
  <BasePanel title="移动 / 突袭（6.1 / 8.0）">
    <p v-if="selected !== null" class="num">
      当前选中：{{ selected.name }}（{{
        selected.mode.orientation === 'move' ? '移动面' : '战斗面'
      }}
      ｜已耗 {{ selected.mpSpent }} MP @ {{ hexLabel(selected.hex) }}）
    </p>
    <p v-else class="muted">地图上还没选中算子：点一格即可就地摊开堆叠并逐枚选择（6.1）。</p>

    <!-- 9.2 / 10.0：结算进行中 ⇒ 任何单位都不得移动 -->
    <div v-if="workbench.settlementInProgress !== null" class="block">
      <p class="num">
        <BaseTag kind="warning">{{ workbench.settlementInProgress.rule }}</BaseTag>
        {{ workbench.settlementInProgress.label }}正在结算：**任何单位都不能移动** ——
        先走完流程（或按 Esc 放弃），之后才能开始 / 继续移动。
      </p>
    </div>

    <!-- 条 10（M1）：开拔前的取子勾选（6.1f / 8.1h）——点地图也可勾选，这里给一个面板内入口 -->
    <div v-if="preBegin" class="block">
      <p class="num">勾选要一起开拔的单位（6.1；点地图也可勾选 / 取消）：</p>
      <CounterPicker
        title="待开拔单位（点一枚＝勾选 / 取消，6.1）"
        hint="6.1：未勾选者留在格内（8.1h 允许留驻）；勾选后改模式、付燃料、点「开始移动」"
        :items="pickItems"
        :size="40"
        @pick="workbench.toggleMovePick($event)"
        @hover="hoverUnit"
      />
      <div class="row">
        <BaseButton variant="secondary" size="sm" @click="workbench.setMovePickAll()">
          全选本格
        </BaseButton>
        <BaseButton variant="ghost" size="sm" @click="workbench.cancelMovePick()">
          取消取子
        </BaseButton>
      </div>
    </div>

    <!-- ① 统一操作条（条 9 / 条 10，M1）：模式批量切换 + 开始移动 -->
    <div class="row">
      <span class="muted"
        >改模式（5.4a：切换不耗 MP，只在本方移动阶段、开始移动前；按选中集合批量）</span
      >
      <BaseButton
        variant="secondary"
        size="sm"
        :disabled="!modeTargetReady"
        @click="workbench.switchUnitMode('combat')"
      >
        切到战斗面
      </BaseButton>
      <BaseButton
        variant="secondary"
        size="sm"
        :disabled="!modeTargetReady"
        @click="workbench.switchUnitMode('move')"
      >
        切到移动面
      </BaseButton>
      <BaseButton
        variant="secondary"
        size="sm"
        :disabled="!modeTargetReady"
        @click="workbench.switchUnitMode('reserve')"
      >
        转入预备
      </BaseButton>
      <BaseButton
        variant="secondary"
        size="sm"
        :disabled="!modeTargetReady"
        @click="workbench.switchUnitMode('strat')"
      >
        转入战略
      </BaseButton>
      <BaseButton
        variant="primary"
        size="sm"
        :disabled="workbench.movePick === null"
        @click="workbench.confirmMovePick()"
      >
        开始移动
      </BaseButton>
    </div>
    <p v-if="workbench.movePick !== null" class="num">
      已选 {{ workbench.movePick.ids.length }} 枚待开拔：在地图上点枚勾选 /
      取消，改完模式与（如需）付燃料后点「开始移动」。
    </p>

    <!--
      ①b 两条原先**只在引擎验证页有入口**的动作（B18 复核顺手接线，与燃料那处同类）：
        · 5.7b 释放预备：E/G 段把预备标记摘掉（反应段 MA×½、进击段 MA×1）；
        · 4.5b 垫人：以某单位许诺"本阶段不再消耗 MP" ⇒ 抵消它所在格的敌方 ZOC。
      判据都在 store（`releaseReserveNow` 转调引擎的 `canReleaseReserve`；`lockZocNegation` 只落盘），
      本面板只提供"在哪按"。
    -->
    <div class="row">
      <BaseButton
        variant="secondary"
        size="sm"
        :disabled="selected === null"
        @click="workbench.releaseReserveNow()"
      >
        释放预备（5.7b：仅反应 / 进击段）
      </BaseButton>
      <BaseButton
        variant="ghost"
        size="sm"
        :disabled="selected === null"
        @click="selected !== null && workbench.lockZocNegation(selected.instanceId)"
      >
        许诺不再耗 MP（垫人，4.5b：抵消该格敌方 ZOC）
      </BaseButton>
    </div>
    <RuleNote title="释放预备：本方反应阶段（MA ×½）或进击阶段（MA ×1）" rule="5.7b">
      <p class="muted">
        5.7b：预备单位在**本方反应阶段**（非阶段玩家，MA ×½）或**进击阶段**（阶段玩家，MA
        ×1）可被释放 ——摘掉预备标记即回到朝向面；4.5b：该格只要有一个处于「已承诺不再耗
        MP」的己方战斗单位， 敌方 ZOC 即被抵消（该单位本阶段就不能再消耗 MP）。
      </p>
    </RuleNote>

    <!-- ④ 本次移动中的单位（6.1f：点一枚即把它就地放下，其余继续走） -->
    <CounterPicker
      title="本次移动中的单位（点一枚＝就地放下它，6.1f）"
      hint="6.1f：离开堆叠即不得再移动 —— 走不动的留下、其余继续；点一枚即放下（灰掉的表示本次移动已结束）"
      :items="moveUnitItems"
      :size="40"
      @pick="workbench.dropUnitFromMove($event)"
      @hover="hoverUnit"
    />
    <p v-if="movingUnits.length === 0" class="muted">
      本次移动里还没有单位（先在地图上选定要动的算子）。
    </p>

    <!-- ② 上一步结论（6.1：MP 消耗 / 掉队 / ZOC 停止都由引擎给） -->
    <div v-if="lastStep !== null" class="num">
      <BaseTag kind="success">{{ lastStep.rules.join(' / ') }}</BaseTag>
      {{ hexLabel(lastStep.from) }} → {{ hexLabel(lastStep.to) }}｜{{ lastStep.costText }}
      <template v-if="lastStep.droppedNames.length > 0">
        ｜掉队：{{ lastStep.droppedNames.join('、') }}（6.1f）
      </template>
      <template v-if="lastStep.zocStoppedNames.length > 0">
        ｜进入 ZOC 就地停止：{{ lastStep.zocStoppedNames.join('、') }}（4.5a-A）
      </template>
    </div>

    <!-- ⑥ 4.5a-A：进入未抵消敌方 ZOC 的待决（必须收束，否则不许再走） -->
    <div v-if="zocConfirm !== null" class="block">
      <p class="num">
        <BaseTag kind="warning">4.5a-A</BaseTag>
        进入 {{ hexLabel(zocConfirm.to) }} 前须决定：该格在**未抵消的敌方 ZOC**
        内，进入后的单位须**就地停止**。
      </p>
      <div class="row">
        <BaseButton variant="primary" size="sm" @click="workbench.confirmZocEntry()">
          进入并停止（4.5a-A）
        </BaseButton>
        <BaseButton variant="secondary" size="sm" @click="workbench.dismissZocConfirm()">
          留在原格
        </BaseButton>
      </div>
      <!-- 4.5a-A 的后一支：进入后**立即突袭**（8.0） -->
      <template v-if="workbench.zocOverrunChoices.length > 0">
        <p class="muted num">或选「突袭」这一支（8.0）：进入后立刻打相邻的敌方格。</p>
        <div class="row">
          <BaseButton
            v-for="choice in workbench.zocOverrunChoices"
            :key="`${choice.hex.col}.${choice.hex.row}`"
            variant="primary"
            size="sm"
            @click="workbench.confirmZocEntryAndOverrun(choice.hex)"
          >
            进入并突袭 {{ hexLabel(choice.hex) }}（{{ choice.entryCost }}+{{ choice.mpCost }} MP）
          </BaseButton>
        </div>
      </template>
      <p v-else class="muted num">
        进入后没有可突袭目标（8.1a 的剩余 MP ≥ 3、8.1b 的进格 ≤ 3 MP）⇒ 只能就地停止。
      </p>
    </div>

    <!-- ⑦ 条 17（批 F·F2）：4.5a 约束 —— 突袭强行进入敌方 ZOC 后，该格单位"不得离开、须再突袭或停" -->
    <div v-if="workbench.overrunZocHeld !== null" class="block">
      <p class="num">
        <BaseTag kind="warning">4.5a</BaseTag>
        突袭进入 {{ hexLabel(workbench.overrunZocHeld) }}（敌方 ZOC）：该格单位**不得离开**，
        须**再突袭**（点相邻敌方格）或**停**在原格。
      </p>
    </div>

    <!-- ③ 突袭（8.0/8.1a）：目标格在地图上高亮，点它即发起 -->
    <p class="num">
      突袭（8.0）：把光标移到本方可攻击单位选定的格上时，可突袭的相邻格会高亮 ——
      **点那个高亮格**即发起 （8.1a：3 MP 记在 9.2 的推进步；8.0：进格会立刻展开战斗会话）。
      本面板**不替你选目标**：候选格由引擎按 8.1 的资格给出（`overrunTargets`）。突袭**需要燃料**
      （12.5b：即使堆叠开始移动时就与防御方相邻也要付）。
    </p>

    <!-- ── 燃料（12.5；用户 2026-09-16 指正：不是在补给阶段算，而是"消耗的那一刻"付） ── -->
    <hr />
    <p class="muted num">
      燃料（12.5）：12.5a「轮式/履带**战斗单位**要消耗 MP
      的话，玩家必须消耗燃料补给，否则不能消耗任何
      MP——**即使就移动一格**」；12.5c「在发生燃料消耗的**任何阶段**，单位都应在**燃料消耗时**支付」。
      故燃料不属补给段某一步，而是**每次开拔的当口**在这里付：付完即自动继续刚才被挡下的那次移动。
      12.5b 的另一半：**攻击 / 防御 / 轰炸 / 撤退 / 战后推进不需燃料**（只有移动与突袭需要）。
    </p>
    <div v-if="!workbench.fuelPaymentDue" class="ok">
      本次要动的单位**不需要燃料**（或都已加注）：步行单位、运输点数（卡车）与飞机永不需燃料（12.5a）。
    </div>
    <template v-else>
      <!-- 12.5a：谁耗油、谁已加注（已加注的灰显，免得重复付） -->
      <CounterPicker
        title="本次加油的受益单位（12.5c：谁付、付给谁）"
        hint="12.5a：轮式/履带战斗单位耗 MP 前必须已付；12.5c-C 的加注只在本阶段有效（12.5d 的清理阶段移除 A/B 标记）"
        :items="fuelTargetItems"
        :size="40"
        @pick="workbench.setUnitFuelled($event, false)"
        @hover="hoverUnit"
      />
      <!--
        12.5c（用户 2026-09-17）：**点谁决定能点哪一法** ——
          单独单位法对任何单位都成立；编队法要"一整个多单位编队"；HQ 法要选中里有指挥部
          （用户：「点击 HQ 时才能加 HQ 法，因为 HQ 要移动本身也要按自身属性和规则来判断」）。
        可用性判据在引擎（`fuelMethodAvailability`），本处只按结论灰显并附原因。
      -->
      <div class="row">
        <label
          v-for="option in fuelMethodOptions"
          :key="option.method"
          class="field"
          :title="option.reason ?? ''"
        >
          <input
            v-model="workbench.fuelMethod"
            type="radio"
            :value="option.method"
            :disabled="!option.available"
          />
          {{ option.label }}
          <span v-if="!option.available" class="muted">（{{ option.reason }}）</span>
        </label>
      </div>
      <!--
        ★ B32 步骤 4：**"来源共用"不再由玩家勾** —— 13.7a / 12.5c-A 要求按盘面事实算同源组；
        这一行如实显示算出来的划分（同源组走编队/HQ 法，其余按 13.7a 用单独单位法）。
      -->
      <p v-if="workbench.fuelMethod !== 'singleUnit'" class="num">
        来源划分（13.7a）：
        <template v-if="workbench.fuelSourcePartition.shared">
          同源 ⇒ {{ workbench.fuelSourcePartition.commonUnitIds.length }} 枚可走
          {{ workbench.fuelMethod === 'hq' ? 'HQ' : '编队' }}法
        </template>
        <template v-else>
          **不同源** ⇒ 能共用的 {{ workbench.fuelSourcePartition.commonUnitIds.length }} 枚走
          {{ workbench.fuelMethod === 'hq' ? 'HQ' : '编队' }}法，其余
          {{ workbench.fuelSourcePartition.singleUnitIds.length }} 枚须按 13.7a 用单独单位法
        </template>
      </p>
      <!--
        ★ 12.5e（批 B 切片 3）：**HQ 法的覆盖是"付了 1SP 就覆盖投递距离内的所有独立单位"**，且
          投递距离在付款那一刻**算定**、同一阶段**只能在一个位置**投递。这里如实显示本阶段的投递基点，
          免得玩家在 HQ 移动后又去点 HQ 法、却只得到一条 12.5e 拒绝（原因文字在日志/状态条里）。
      -->
      <p v-for="line in hqFuelThrowLines" :key="line.instanceId" class="num">
        12.5e：{{ line.name }} 本阶段已在 <b>{{ line.originLabel }}</b>
        投递（投递距离在付款时算定；每阶段只能在这一个位置投递）
      </p>
      <!--
        ★ I①（12.5c-A，用户 2026-09-18 第 7 条）：**编队法的覆盖预览** ——
          「为一整个多单位编队支付 1SP，便可为整个多单位编队提供燃料补给」⇒ 付款前先说清这一付会覆盖谁：
          同编队、能从本次来源取到的**全部**单位（含未被点选的、含徒步面的摩托化单位）；
          来源之外的同编队单位**不参与**（日后开拔走 12.5c-C 单独单位法）。
      -->
      <p v-if="formationCoverageLine !== null" class="num">
        12.5c-A：本次付 1SP 将覆盖
        <b>{{ workbench.fuelFormationCoverage?.coveredIds.length ?? 0 }}</b> 枚（{{
          formationCoverageLine
        }}）
        <template v-if="(workbench.fuelFormationCoverage?.leftOutIds.length ?? 0) > 0">
          ；另有
          {{ workbench.fuelFormationCoverage?.leftOutIds.length }} 枚同编队单位**不在本来源内** ⇒
          不参与本次编队加油，日后开拔须用单独单位法（12.5c-C，每枚 1T）
        </template>
      </p>
      <p v-if="formationPaidLine !== null" class="num">
        12.5c-A：编队 <b>{{ formationPaidLine }}</b> 本阶段已用编队法付过油 ⇒
        该编队其余成员请用单独单位法（12.5c-C，每枚 1T）
      </p>
      <!-- 12.3a：付款来源只能是受益单位拖得到的补给站（图用当前点数的 SP 算子图） -->
      <CounterPicker
        title="付款补给站（12.3a：受益单位须拖得到）"
        hint="12.3a：5 MP 直拖内或相邻（12.3c）；12.5c-A/B 要求整个编队/该指挥部共用同一来源"
        :items="fuelDumpItems"
        :size="32"
        @pick="workbench.pickFuelDump($event)"
        @hover="hoverDump"
      />
      <div class="row">
        <BaseButton variant="primary" size="sm" @click="workbench.payFuel()">
          支付燃料（12.5c）——未加注 {{ workbench.fuelPendingUnits.length }} 枚
        </BaseButton>
        <span class="num">
          获批来源：{{
            workbench.fuelDump === null ? '（未选）' : hexLabel(workbench.fuelDump.hex)
          }}
        </span>
      </div>
    </template>

    <!-- ⑤ 收束：撤销一步 / 结束移动 / 放弃整次移动 -->
    <div class="row">
      <BaseButton variant="secondary" size="sm" @click="workbench.undoLastStep()">
        撤销一步（6.1）
      </BaseButton>
      <BaseButton variant="primary" size="sm" @click="workbench.finishMove()">
        结束移动（6.1）
      </BaseButton>
      <BaseButton variant="ghost" size="sm" @click="workbench.abortMoveNow()">
        放弃本次移动（全部还原并退出）
      </BaseButton>
    </div>
    <p class="muted">
      6.1f 末句：走完可点「结束移动」；仍有单位在动时结束会让它们就地停下。已做的动作只能靠
      「撤销一步」回退（6.1h 只给一步）或「放弃本次移动」全部还原（还原后即可重新选子再走）。
    </p>
  </BasePanel>
</template>

<style scoped>
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.block {
  margin-bottom: var(--space-2);
}

.num {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  margin: var(--space-1) 0;
}

.muted {
  color: var(--color-muted);
  font-size: var(--text-sm);
  margin: var(--space-1) 0;
}
</style>
