<script setup lang="ts">
import { computed } from 'vue'

import { BaseButton, BasePanel, BaseTag, RuleNote } from '@/components/base'
import { CounterPicker, type CounterPickerItem } from '@/components/game'
import UiField from '@/components/UiField.vue'
import { useUiMode } from '@/components/ui-mode'
import {
  aircraftRecordImageUrlOf,
  counterImageUrlOf,
  hexLabel,
  isFighterAircraft,
  spDumpImageUrlOf,
  useWorkbenchStore,
} from '@/stores'

/**
 * 空军面板（C9：OCS 14.0 / 15.0 章）
 *
 * 走 `engine/rules/air-interaction.ts` 的 **14.2f 七步流程**（A 宣布 → B 移动 → C 空战 → D 拦截 →
 * E 防空 → F 结算 → G 返航），并按用户要求覆盖四条交互链：
 *   ① **任务分配**：选任务类型与任务格、点名参战机（14.2a 合计 ≤4 架、14.2e 本阶段一次、14.2d 航程）；
 *   ② **整备额度**：逐基地整备（15.1：1T、容量＝等级×2、每基地每整备阶段一次、ZOC 内不可）；
 *   ③ **拦截与防空应答**：对手的拦截资格与候选（14.5）、防空修正与任务损失表（14.4e/f）；
 *   ④ **基地转移与缩减**：14.11 转移（距离可加倍、战斗机在正常距离内保持激活）与 15.4 缩减。
 *
 * ★ **基地归属权**：面板只列**本方**基地可操作（14.1a/14.1c/15.1/15.4），一切归属判定在引擎；
 *   对手的巡逻区（14.4c）画在地图上（红框），本方画蓝框，便于判断拦截与防空强度。
 *
 * 分层纪律（CODE_SPEC）：本组件**不做任何规则计算** —— 步骤、可用性、距离、修正、战果全部来自
 * store 对引擎的调用；这里只画图、收点击、把输入写进 `airInputs`。
 */

const workbench = useWorkbenchStore()

/** 条 24 / §5-F：正式界面把「手输」收敛为只读（验证页仍可手输） */
const uiMode = useUiMode()

/** 条 24：装货 SP 改**步进**（点选，不手输）；值仍写回 store，引擎照常判 14.9/14.10 */
function adjustCargoSp(delta: number): void {
  const next = Math.max(0, Math.trunc(workbench.airInputs.cargoSpT) + delta)
  workbench.airInputs.cargoSpT = next
}

/** 条 24：空投回合改**步进**（点选，不手输）；14.10b 的"计划早于执行 ≥2"仍由引擎判 */
function adjustAirNum(key: 'airdropPlannedTurn' | 'airdropScheduledTurn', delta: number): void {
  const next = Math.max(0, Math.trunc(workbench.airInputs[key]) + delta)
  workbench.airInputs[key] = next
}

/** 步骤清单（14.2f A–G） */
const checklist = computed(() => workbench.airChecklist)
/** 对手的拦截资格（14.5） */
const interception = computed(() => workbench.airInterceptionResponse)
/** 任务格内的敌方空中/基地事实（14.3，由盘面推出） */
const enemyAtTarget = computed(() => workbench.airEnemyAtTarget)

/** 14.2e：可在「任务分配」里宣布的任务类型（拦截与基地转移不在其中） */
const MISSION_KINDS = [
  { key: 'barrage', label: '空军轰炸（14.7b）' },
  { key: 'hip_shoot', label: '低空扫射（14.7d）' },
  { key: 'trainbusting', label: '运输破坏（14.8）' },
  { key: 'air_transport', label: '空运（14.9）' },
  { key: 'air_drop', label: '空投（14.10）' },
  { key: 'fighter_sweep', label: '战机扫荡（14.6）' },
] as const

/** 14.2e：任务所属**环节**的中文名（`missionSegmentOf` 的三个取值） */
function segmentLabel(kind: string): string {
  const segment = workbench.missionSegmentOf(kind as typeof workbench.airMissionKind)
  if (segment === 'movementSegment') return '移动环节'
  if (segment === 'barrageSegment') return '轰炸环节'
  return '拦截步（插在敌方任务的 D 步）'
}

/** 14.1b：军力点（每机 2 点） */
function stepText(steps: number): string {
  return `${steps} 点军力`
}

/* ─────────────────── 算子图阵列（B14；用户口径⑪） ───────────────────
 *
 * 「把当前可选的**算子图片**紧凑排出来；算子上信息已经够了，除了环节提示这种外不需要显示额外的文字」。
 * 故以下四处「选算子」的位置全部改用 `CounterPicker`：数字与名称只进 `title`（悬停可见），
 * 屏幕上只有算子图 + 金框（选中）。**本组件不做任何规则判断**：可选性与原因都由 store 给。
 */

/** 悬停某一枚 ⇒ 同步地图高亮它所在的格 */
function hoverAir(id: string | null): void {
  const air =
    id === null ? null : (workbench.airUnits.find((item) => item.instanceId === id) ?? null)
  workbench.setHoverHex(air?.hex ?? null)
}

/** 悬停某一枚地面算子 ⇒ 同步地图高亮 */
function hoverUnit(id: string | null): void {
  const unit = id === null ? null : (workbench.units.find((item) => item.instanceId === id) ?? null)
  workbench.setHoverHex(unit?.hex ?? null)
}

/** 摆放飞机（14.1a）：机型库记录 → 算子图阵列（`airUnitChoices` 手上是库记录、不是实例） */
const aircraftItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.airUnitChoices.map((item) => ({
    id: item.aircraftId,
    imageUrl: aircraftRecordImageUrlOf(item, workbench.activeSide),
    name:
      `${item.name ?? item.aircraftId}（${item.aircraftType ?? '?'}｜ACV ${item.airCombatRating ?? 0}` +
      `｜轰炸 ${item.barrageStrength ?? 0}｜航程 ${item.rangeHexes ?? 0}）`,
    selected: workbench.airPlacement.aircraftId === item.aircraftId,
  })),
)

/** 参战机（14.2a/14.2e/14.2f）：可选性与原因由 store 逐机算好（`airMissionJoinChoices`） */
const missionJoinItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.airMissionJoinChoices.map((choice) => {
    const air = choice.air
    return {
      id: air.instanceId,
      imageUrl: counterImageUrlOf(air),
      name:
        `${air.name}（${air.aircraftType}｜ACV ${air.airCombatRating}` +
        `${air.canInitiateAirCombat ? '' : '，括号值：不能发起空战 14.3a'}｜轰炸 ${air.barrageStrength}` +
        `｜航程 ${air.rangeHexes}｜@ ${hexLabel(air.hex)}）`,
      selected: choice.selected,
      disabledReason: choice.disabledReason,
      hex: air.hex,
    }
  }),
)

/** 14.9 / 14.10：本任务是不是带货的那两类（只有它们才有载货区） */
const isCargoMission = computed(
  () => workbench.airMissionKind === 'air_transport' || workbench.airMissionKind === 'air_drop',
)

/** 14.10a：单位货物的候选阵列（候选由 store 给，组件不自己筛单位） */
const cargoUnitItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.airCargoUnitChoices.map((unit) => ({
    id: unit.instanceId,
    imageUrl: counterImageUrlOf(unit),
    name: `${unit.name} @ ${hexLabel(unit.hex)}`,
    selected: workbench.airInputs.cargoUnitIds.includes(unit.instanceId),
    hex: unit.hex,
  })),
)

/** 14.4g：任务货物清单里的一件货怎么念（SP 报 T 数、单位报名字）—— 只做展示，不改任何账本 */
function cargoLabel(item: { id: string; kind: 'sp' | 'unit'; t?: number | undefined }): string {
  if (item.kind === 'sp') return `${item.id}（${String(item.t ?? 0)} T SP）`
  const unit = workbench.units.find((entry) => item.id === `unit:${entry.instanceId}`)
  return unit === undefined ? item.id : unit.name
}

/*
 * 14.3e-B：**逐轮点名**（攻方非括号机 / 守方任选）
 *
 * 原文 B：「攻击方选择他的一个**非括号**的空军单位，然后防御方选择**任意一个**他的空军单位；
 * 这些就是**当前战斗轮**中使用的飞机」+ D：「**为每对进行一轮战斗**」⇒ 点名逐轮进行。
 * 阵列由 store 的投影给（`airCombatAttackerPlanes` / `airCombatDefenderPlanes`），
 * 本组件只画与收点击；**不点即交给引擎自动取 ACV 最高**（缺省口径在引擎里）。
 */
const attackerPickItems = computed(
  () =>
    (roundIndex: number): readonly CounterPickerItem[] =>
      workbench.airCombatAttackerPlanes.map((air) => ({
        id: air.instanceId,
        imageUrl: counterImageUrlOf(air),
        name: `${air.name}（ACV ${air.airCombatRating}）`,
        selected:
          workbench.airInputs.airCombatPicks[roundIndex]?.attackerAircraftId === air.instanceId,
        // 14.3a / 14.3e-B：括号值的飞机不能被攻方点名（引擎也会拒）
        disabledReason: air.canInitiateAirCombat ? null : '括号值：不能发起空战（14.3a）',
        hex: air.hex,
      })),
)

const defenderPickItems = computed(
  () =>
    (roundIndex: number): readonly CounterPickerItem[] =>
      workbench.airCombatDefenderPlanes.map((air) => ({
        id: air.instanceId,
        imageUrl: counterImageUrlOf(air),
        name: `${air.name}（ACV ${air.airCombatRating}）`,
        selected:
          workbench.airInputs.airCombatPicks[roundIndex]?.defenderAircraftId === air.instanceId,
        hex: air.hex,
      })),
)

/** 14.3e-B：把某一轮的点名写回 store（按轮下标自动补行） */
function setAirCombatPick(
  roundIndex: number,
  field: 'attackerAircraftId' | 'defenderAircraftId',
  id: string,
): void {
  const rows = [...workbench.airInputs.airCombatPicks]
  while (rows.length <= roundIndex)
    rows.push({ attackerAircraftId: null, defenderAircraftId: null })
  rows[roundIndex] = { ...rows[roundIndex]!, [field]: id }
  workbench.airInputs.airCombatPicks = rows
}

/** 拦截机（14.5：一次一架）：候选由引擎的资格判定给（`eligibleFighterIds`） */
const interceptorItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.airInterceptorCandidates.map((air) => ({
    id: air.instanceId,
    imageUrl: counterImageUrlOf(air),
    name: `${air.name}（ACV ${air.airCombatRating}）@ ${hexLabel(air.hex)}`,
    selected: workbench.airInputs.interceptorId === air.instanceId,
    hex: air.hex,
  })),
)

/**
 * B29a：**迎战机**（14.3e-B）——任务方从参战飞机中指定一架
 *
 * 候选＝本次任务的参战机（`airMissionAirUnits`）；不点任何一架即"未点名"，
 * 由引擎按 ACV 最高自动取（`resolveAirCombatRounds` 的缺省）。
 */
const namedDefenderItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.airMissionAirUnits.map((air) => ({
    id: air.instanceId,
    imageUrl: counterImageUrlOf(air),
    name: `${air.name}（ACV ${air.airCombatRating}）@ ${hexLabel(air.hex)}`,
    selected: workbench.airInputs.namedDefenderId === air.instanceId,
    hex: air.hex,
  })),
)

/** 施工工程兵（13.8d）：候选由引擎的工程能力判定给（`engineerChoices`） */
const engineerItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.engineerChoices.map((unit) => ({
    id: unit.instanceId,
    imageUrl: counterImageUrlOf(unit),
    name: `${unit.name}（RE ${unit.re}）@ ${hexLabel(unit.hex)}`,
    selected: workbench.constructionInputs.engineerId === unit.instanceId,
    hex: unit.hex,
  })),
)

/** 15.4 的「被指定单位」：逐基地列出，点一枚即指定/取消（`toggleAirReductionUnit`） */
function reductionItems(baseId: string): readonly CounterPickerItem[] {
  return workbench.airReductionCandidates(baseId).map((unit) => ({
    id: unit.instanceId,
    imageUrl: counterImageUrlOf(unit),
    name: `${unit.name}（RE ${unit.re}${unit.engineerCapable ? '｜具工程能力' : ''}）@ ${hexLabel(unit.hex)}`,
    selected: workbench.airInputs.reductionUnitIds.includes(unit.instanceId),
    hex: unit.hex,
  }))
}

/** 付款补给站（12.1b 账本）：图用**当前点数的 SP 算子图**（点数不同图不同） */
const dumpItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.spDumpsOfSide.map((dump) => ({
    id: dump.id,
    imageUrl: spDumpImageUrlOf(dump),
    name: `${hexLabel(dump.hex)}（${dump.sp} SP + ${dump.t} T）`,
    selected: workbench.constructionInputs.payDumpId === dump.id,
    hex: dump.hex,
  })),
)

/** 悬停某一座补给站 ⇒ 同步地图高亮它的格 */
function hoverDump(id: string | null): void {
  const dump = id === null ? null : (workbench.spDumpsOfSide.find((item) => item.id === id) ?? null)
  workbench.setHoverHex(dump?.hex ?? null)
}

/**
 * B15d：**只渲染哪一段**（默认全渲染，引擎验证页照旧）
 *
 * 为什么需要它：方案 §4.3 要求「**动作类**才进会话框」，而空军面板里混着两类东西——
 * ① **任务链**（14.2f 的宣布与七步：空战 / 拦截 / 防空 / 结算 / 返航、主动返航、放弃本次任务）；
 * ② **事务性动作**（14.1a 摆放飞机、15.1 整备、15.3 修建、15.4 缩减、9.14f 夺取）——
 * 后者不是"某一次行动的收束"，放在会话框里会随任务开合而忽隐忽现（那些入口就**不可达**了）。
 * 故地图会话挂 `only="mission"`、侧栏挂 `only="admin"`；不传则两段都render（旧页面不变）。
 */
const props = withDefaults(
  defineProps<{ only?: 'mission' | 'admin' | null; stepwise?: boolean }>(),
  {
    only: null,
    /**
     * ★ 批 C 切片 1（方案 §3 批 C 步骤 2 的后半）：**逐步复核**的手动按钮只在**验证页**渲染。
     *
     * 正式对局台（`GameTableView` 的会话框）不传 ⇒ 各环节的手动"结算/掷骰"按钮一律不出现
     * （那些步骤已经被"执行任务"自动连跑；重复入口会让人以为是两条路）。
     * 验证页（`WorkbenchView`）传 `stepwise` ⇒ 原样保留，供逐步核对与复现。
     */
    stepwise: false,
  },
)

/** 本实例是否要画"任务链"那一段 */
const showsMission = computed(() => props.only === null || props.only === 'mission')
/** 本实例是否要画"事务性动作"那一段 */
const showsAdmin = computed(() => props.only === null || props.only === 'admin')
</script>

<template>
  <BasePanel title="空军（C9：OCS 14.0 / 15.0）">
    <div class="row">
      <BaseButton
        variant="secondary"
        size="sm"
        @click="workbench.setAirActive(!workbench.airActive)"
      >
        {{ workbench.airActive ? '关闭空军工具' : '开启空军工具' }}
      </BaseButton>
    </div>

    <p v-if="!workbench.airActive" class="muted">
      开启后按 14.2f 的七步流程结算任务（宣布 → 空战 → 拦截 → 防空 → 结算 → 返航）， 并按 15.1
      整备、14.11 转移、15.4 缩减基地。地图会画出双方巡逻区（14.4c）。
    </p>

    <template v-else>
      <!-- ══ 事务性动作（14.1a 摆放 / 15.1 整备 / 15.3 修建 / 15.4 缩减 / 9.14f 夺取）══
           B15d：这一段留在**侧栏**（地图会话挂 `only="mission"` ⇒ 这里不画） -->
      <template v-if="showsAdmin">
        <!-- ── 摆放飞机（14.1a：飞机算子停在其**空军基地格**） ── -->
        <p class="muted">
          摆放飞机（14.1a：飞机停在**空军基地格**，该格即其起飞与返航基地；新到飞机为非激活，须整备
          15.1 后出击）：
        </p>
        <div class="row">
          <!-- B14：机型＝**算子图阵列**（原来是一个纯文字下拉） -->
          <CounterPicker
            title="机型（A5 空军专表）"
            hint="14.1a 摆放：飞机停在空军基地格，该格即其起飞与返航基地；新到飞机非激活，须整备 15.1 后出击"
            :items="aircraftItems"
            :size="40"
            @pick="workbench.airPlacement.aircraftId = $event"
            @hover="workbench.setHoverHex(null)"
          />
          <label class="field">
            基地格
            <UiField v-model="workbench.airPlacement.hexText" class="input" placeholder="36.13" />
            <BaseButton
              variant="secondary"
              size="sm"
              @click="workbench.beginAirPlacementHexPickNow()"
            >
              点地图选基地格
            </BaseButton>
          </label>
          <BaseButton
            variant="secondary"
            size="sm"
            @click="
              workbench.addAirUnit(
                workbench.airPlacement.aircraftId,
                workbench.airPlacement.hexText,
              )
            "
          >
            摆放（14.1a）
          </BaseButton>
        </div>

        <!-- ── 飞机清单（14.1a / 14.2e / 14.11） ── -->
        <p class="muted">
          当前方飞机（点「状态」切换激活/非激活；转移 14.11 填目的地后点「转移」）：
        </p>
        <div class="row">
          <label class="field">
            转移目的地
            <UiField
              v-model="workbench.airInputs.transferToHexText"
              class="input"
              placeholder="列.行"
            />
            <BaseButton
              variant="secondary"
              size="sm"
              @click="workbench.beginAirTransferHexPickNow()"
            >
              点地图选格
            </BaseButton>
          </label>
        </div>
        <p v-for="air in workbench.ownAirUnits" :key="air.instanceId" class="num air-row">
          <img
            class="air-row__thumb"
            :src="counterImageUrlOf(air) ?? undefined"
            :alt="air.name"
            loading="lazy"
          />
          <BaseButton
            variant="ghost"
            size="sm"
            @click="workbench.toggleAirUnitStatus(air.instanceId)"
          >
            {{ air.airStatus === 'active' ? '激活' : '非激活' }}
          </BaseButton>
          {{ air.name }}（{{ air.aircraftType }}）@ {{ hexLabel(air.hex) }} ｜ACV
          {{ air.airCombatRating
          }}{{ air.canInitiateAirCombat ? '' : '（括号值：不能发起空战 14.3a）' }} ｜轰炸
          {{ air.barrageStrength }}｜航程 {{ air.rangeHexes }} ｜{{ stepText(air.steps) }}
          <template v-if="air.transportCapacity > 0">｜运力 {{ air.transportCapacity }} T</template>
          <template v-if="!air.canBarrage">｜不可轰炸</template>
          <template v-if="isFighterAircraft(air.aircraftType)">｜战斗机</template>
          <BaseButton
            variant="ghost"
            size="sm"
            @click="workbench.transferAircraftNow(air.instanceId)"
          >
            转移（14.11）
          </BaseButton>
          <BaseButton variant="ghost" size="sm" @click="workbench.removeAirUnit(air.instanceId)">
            卸下
          </BaseButton>
        </p>
        <p v-if="workbench.ownAirUnits.length === 0" class="muted">当前方还没有飞机。</p>

        <!-- ── ① 任务分配（14.2f-A/B） ── -->
      </template>
      <!-- ══ 任务链（14.2f 的宣布与七步）══  B15d：这一段进**地图会话框** -->
      <template v-if="showsMission">
        <hr />
        <p class="muted">
          任务分配（14.2f-A/B）：选类型与任务格、勾选参战机（14.2a 合计 ≤4 架；14.2e
          每机每阶段一次； 起飞机必须停在**本方**空军基地格内，14.1a）。
        </p>
        <div class="row">
          <label class="field">
            任务类型（14.2e）
            <!--
              ★ 批 C 切片 1（用户口径 9.16 #3「点机场选机 → 点目标格 → 选任务类型 → **自动结算**」）：
                选任务类型是**最后一步玩家输入** ⇒ 这一下即「宣布 + 自动结算到停返航」（`runAirMissionWithKind`）。
                条件不足（没点名参战机 / 没选任务格）时**如实说缺什么**，不静默。
            -->
            <select
              class="select"
              :value="workbench.airMissionKind"
              @change="
                workbench.runAirMissionWithKind(
                  ($event.target as HTMLSelectElement).value as typeof workbench.airMissionKind,
                )
              "
            >
              <option v-for="item in MISSION_KINDS" :key="item.key" :value="item.key">
                {{ item.label }}（{{ segmentLabel(item.key) }}）
              </option>
            </select>
          </label>
          <span class="num">
            本环节：{{ segmentLabel(workbench.airMissionKind) }}（14.2e）；还可加
            {{ workbench.airJoinRemaining }} 架（14.2a 上限 4）
          </span>
          <label class="field">
            任务格（列.行）
            <input
              v-if="uiMode === 'verify'"
              class="input"
              :value="workbench.airInputs.targetHexText"
              placeholder="36.13"
              @change="workbench.setAirTargetFromText(($event.target as HTMLInputElement).value)"
            />
            <span v-else class="ui-field-readonly">{{
              workbench.airInputs.targetHexText || '—'
            }}</span>
          </label>
          <!-- B29a：任务格改成**点地图选**（14.2f-B；文本框留着作退路） -->
          <BaseButton variant="secondary" size="sm" @click="workbench.beginAirTargetHexPickNow()">
            点地图选任务格
          </BaseButton>
          <label class="field">
            <input v-model="workbench.airInputs.flyingAllowed" type="checkbox" />
            天气允许飞行（14.1f）
          </label>
          <label class="field">
            <input v-model="workbench.airInputs.weatherNormal" type="checkbox" />
            天气正常（14.7d/专规 3.2a）
          </label>
        </div>
        <p class="num">
          当前方空军基地：
          <template v-if="workbench.ownAirBases.length === 0">（无）</template>
          <template v-for="base in workbench.ownAirBases" :key="base.id">
            <BaseTag :kind="base.isAirstrip === true ? 'warning' : 'info'">
              {{ hexLabel(base.hex) }}
              {{ base.isAirstrip === true ? '简易机场（15.2）' : `${base.level} 级（15.0）` }}
            </BaseTag>
          </template>
        </p>
        <!-- B14：参战机＝**算子图阵列**（原来是一排"名字 + ✓"的文字按钮） -->
        <CounterPicker
          title="参战机（点一枚加入 / 再点一枚退出）"
          :hint="`14.1a 只有「激活」的飞机能执行任务（非激活需先在整备阶段 15.1 整备）；14.2a 一次任务合计上限 4 架（还可加 ${workbench.airJoinRemaining} 架）；14.2e 每机每阶段一次；14.2f 过移动步后不能再加`"
          :items="missionJoinItems"
          :size="40"
          @pick="workbench.toggleAirMissionUnit($event)"
          @hover="hoverAir"
        />
        <!--
          14.9 / 14.10：**载货**（只在空运 / 空投任务上）
          14.9a 运力取机型印值；14.10a 空投战斗单位须 Para 资格（本作库未印 ⇒ 玩家声明）；
          14.10b 空投单位属"需计划"的任务（计划回合须比执行回合早 ≥2）。
        -->
        <template v-if="isCargoMission">
          <div class="row">
            <label class="field">
              装载 SP（T）
              <span class="row">
                <BaseButton
                  size="sm"
                  variant="secondary"
                  :disabled="workbench.airInputs.cargoSpT <= 0"
                  @click="adjustCargoSp(-1)"
                >
                  －
                </BaseButton>
                <span class="num cargo-sp">{{ workbench.airInputs.cargoSpT }}</span>
                <BaseButton size="sm" variant="secondary" @click="adjustCargoSp(1)">＋</BaseButton>
              </span>
            </label>
            <label class="field">
              <input v-model="workbench.airInputs.cargoUnitsParaCapable" type="checkbox" />
              所载单位标有 Para / 空降资格（14.10a；本作库未印该标识）
            </label>
            <!--
              14.9f：卸载限额的例外 —— 「如果超出部分对应的运输机在**目的地格变为非激活状态**，
              则可以卸载超额部分的货物」（14.9e-A 的双程飞法即在目的地变非激活）。
            -->
            <label class="field" title="14.9f：超出部分由在目的地格变非激活的运输机承运">
              <input v-model="workbench.airInputs.unloadOverLimitInactive" type="checkbox" />
              超额部分由「在目的地变非激活」的运输机承运（14.9e-A / 14.9f）
            </label>
            <label class="field">
              计划回合（14.10b）
              <span class="row">
                <BaseButton
                  size="sm"
                  variant="secondary"
                  :disabled="workbench.airInputs.airdropPlannedTurn <= 0"
                  @click="adjustAirNum('airdropPlannedTurn', -1)"
                >
                  －
                </BaseButton>
                <span class="num cargo-sp">{{ workbench.airInputs.airdropPlannedTurn }}</span>
                <BaseButton
                  size="sm"
                  variant="secondary"
                  @click="adjustAirNum('airdropPlannedTurn', 1)"
                >
                  ＋
                </BaseButton>
              </span>
            </label>
            <label class="field">
              执行回合
              <span class="row">
                <BaseButton
                  size="sm"
                  variant="secondary"
                  :disabled="workbench.airInputs.airdropScheduledTurn <= 0"
                  @click="adjustAirNum('airdropScheduledTurn', -1)"
                >
                  －
                </BaseButton>
                <span class="num cargo-sp">{{ workbench.airInputs.airdropScheduledTurn }}</span>
                <BaseButton
                  size="sm"
                  variant="secondary"
                  @click="adjustAirNum('airdropScheduledTurn', 1)"
                >
                  ＋
                </BaseButton>
              </span>
            </label>
          </div>
          <!-- 14.10a：单位货物＝算子图阵列（点一枚加入 / 再点一枚移出） -->
          <CounterPicker
            title="单位货物（14.10a：空投的战斗单位）"
            hint="候选＝图上本方地面战斗单位；资格由上面的开关声明（本作库未印 Para 标识）"
            :items="cargoUnitItems"
            :size="32"
            @pick="workbench.toggleAirCargoUnit($event)"
            @hover="hoverUnit"
          />
          <p class="num">
            本次货物：{{ workbench.airInputs.cargoSpT }} T SP ＋
            {{ workbench.airInputs.cargoUnitIds.length }} 个单位（14.10d 逐件 2 骰检定）
          </p>
        </template>

        <!-- 14.3d：主动返航（空战前须至少留 1 架；空战中禁止；空战后自由） -->
        <div class="row">
          <span class="muted">
            主动返航（14.3d）：勾选哪几架就返航哪几架 —— 空战**前**须至少留 1 架继续战斗，
            空战**中**任何一方都不能返航，空战完全结束后自由返航（返航即转非激活）。
          </span>
          <BaseButton
            variant="secondary"
            size="sm"
            :disabled="workbench.airMissionAirIds.length === 0"
            @click="workbench.voluntaryReturnNow([...workbench.airMissionAirIds])"
          >
            让所选飞机主动返航（14.3d）
          </BaseButton>
        </div>
        <div class="row">
          <BaseButton variant="primary" size="sm" @click="workbench.runAirMissionNow()">
            执行任务（14.2f：宣布 → 自动结算到停返航）
          </BaseButton>
          <span class="muted">选了任务类型就会自己跑；这里给"先选任务格、后定类型"的顺序用。</span>
        </div>

        <!-- ── 步骤清单 ── -->
        <p v-if="checklist.length > 0" class="num">
          <BaseTag
            v-for="item in checklist"
            :key="item.step"
            :kind="item.done ? 'success' : 'neutral'"
          >
            {{ item.label }}{{ item.done ? ' ✓' : '' }}
          </BaseTag>
        </p>

        <template v-if="workbench.airState !== null">
          <p v-if="workbench.airState.assignment.aircraftIds.length > 0" class="num">
            参战 {{ workbench.airState.assignment.aircraftIds.length }} 架｜最远
            {{ workbench.airState.assignment.maxDistanceHexes }} 格{{
              workbench.airState.assignment.allWithinShortRange ? '（14.7c 短程修正）' : ''
            }}
            <template v-if="workbench.airState.assignment.cargoCapacity > 0">
              ｜总运力 {{ workbench.airState.assignment.cargoCapacity }} T（14.9a）
            </template>
            <template
              v-if="
                workbench.airMissionCargoCapacityNow !== workbench.airState.assignment.cargoCapacity
              "
            >
              ｜防空后重算 {{ workbench.airMissionCargoCapacityNow }} T
            </template>
          </p>

          <!-- ── 14.4g：防空致容量变化后的**货物损失**（由玩家选摧毁哪几件） ── -->
          <div v-if="workbench.airCargoLossPending !== null" class="block">
            <h4 class="block__title">14.4g 货物损失（容量因防空变小）</h4>
            <p class="warn num">
              {{ workbench.airCargoLossPending.detail }}；摧毁哪些由您选（摧毁量须 ≥ 超出部分）
            </p>
            <ul class="list">
              <li v-for="item in workbench.airState.assignment.cargo" :key="item.id" class="num">
                {{ cargoLabel(item) }}
                <BaseButton
                  variant="ghost"
                  size="sm"
                  @click="workbench.toggleAirCargoLossPick(item.id)"
                >
                  {{
                    workbench.airCargoLossPicked.includes(item.id) ? '移出摧毁清单' : '加入摧毁清单'
                  }}
                </BaseButton>
              </li>
            </ul>
            <div class="row">
              <BaseButton variant="primary" size="sm" @click="workbench.confirmAirCargoLossNow()">
                摧毁所选（14.4g）
              </BaseButton>
              <span class="muted">已选 {{ workbench.airCargoLossPicked.length }} 件</span>
            </div>
          </div>

          <!--
        B29a（用户口径 #3）：宣布之后**一次结算到返航**。
        空战 → 拦截（含拦截空战）→ 防空 → 任务结算四步是骰子与查表 ⇒ 自动连跑；
        需要玩家表态的地方（拦截方是否宣布、14.3e-B 点名谁迎战）仍由下面的输入决定。
        ★ 批 C 切片 1：正式界面**只剩「执行任务」这一个入口**（宣布与自动结算已合成一次动作，
          修前要点两次）；下面各环节的手动按钮是**逐步复核**路径，只在验证页（`stepwise`）渲染。
      -->
          <p
            v-if="workbench.airState.step !== 'returnToBase' && workbench.airState.step !== 'done'"
            class="muted"
          >
            任务进行中：骰子与查表会自己跑完，停在**返航**步；需要玩家表态的地方（14.5 拦截宣布、
            14.3e-B 点名迎战机）用下面的选机阵列。（各环节的手动按钮只在引擎验证页出现。）
          </p>

          <!-- ── ② 空战环节（14.2f-C / 14.3） ── -->
          <template v-if="workbench.airState.step === 'airCombat'">
            <p class="num">
              空战前提（14.3，由盘面推出）：任务格内
              <BaseTag :kind="enemyAtTarget.hasAirBase ? 'warning' : 'neutral'">
                {{ enemyAtTarget.hasAirBase ? '有' : '没有' }}敌方空军基地
              </BaseTag>
              ｜敌方激活机 {{ enemyAtTarget.activeAircraft }} 架（其中可发起空战
              {{ enemyAtTarget.canInitiate ? '有' : '无' }}）；
              只有**有敌方基地且双方都有激活机**才发生空战（14.3），否则直接进入拦截环节。
            </p>
            <!-- 14.3e-B：任务方**点名**迎战的那一架（缺省＝ACV 最高，由引擎取） -->
            <CounterPicker
              title="迎战机（14.3e-B：任务方从参战机中指定一架；不点即由引擎取 ACV 最高）"
              hint="14.3e-B：防守方（任务方）从参战机中指定一架迎战"
              :items="namedDefenderItems"
              :size="32"
              @pick="workbench.airInputs.namedDefenderId = $event"
            />
            <!-- 14.3e-B：逐轮点名（每轮各点一架；不点即由引擎取 ACV 最高） -->
            <div v-for="round in workbench.airCombatRoundBudget" :key="round" class="row">
              <span class="muted">第 {{ round }} 轮</span>
              <CounterPicker
                :title="`攻方点名（第 ${round} 轮：只可点非括号机）`"
                :items="attackerPickItems(round - 1)"
                :size="28"
                :max-rows="2"
                @pick="setAirCombatPick(round - 1, 'attackerAircraftId', $event)"
              />
              <CounterPicker
                :title="`守方点名（第 ${round} 轮：任选一架）`"
                :items="defenderPickItems(round - 1)"
                :size="28"
                :max-rows="2"
                @pick="setAirCombatPick(round - 1, 'defenderAircraftId', $event)"
              />
            </div>
            <div v-if="props.stepwise" class="row">
              <BaseButton variant="secondary" size="sm" @click="workbench.confirmAirCombatNow()">
                ② 结算空战环节（14.2f-C，逐步复核）
              </BaseButton>
            </div>
          </template>

          <!-- ── ②b F 步的空军轰炸（10.2 / 14.7b）：任务为"空军轰炸"时进轰炸链 ── -->
          <template v-if="workbench.airState.step === 'resolveMission'">
            <p v-if="workbench.airState.kind === 'barrage'" class="num">
              空军轰炸（10.2a / 14.7b）：在轰炸环节对目标结算 —— 与炮兵**同一条**轰炸链 （加总轰炸值
              → 定纵列 → 横移 → 2 骰 → 战果），10.2c：**空军轰炸没有补给消耗**。
            </p>
            <div v-if="workbench.airState.kind === 'barrage'" class="row">
              <BaseButton variant="primary" size="sm" @click="workbench.beginAirBarrageNow()">
                结算空军轰炸（10.2 / 14.7b）
              </BaseButton>
              <span class="muted">结算完再回来「结算任务」（14.2f-F）。</span>
            </div>
          </template>

          <!-- ── ③ 拦截应答（14.2f-D / 14.5） ── -->
          <template v-if="workbench.airState.step === 'interception'">
            <p class="num">
              对手拦截资格（14.5）：{{ interception === null ? '任务格未定' : interception.detail }}
              <template v-if="workbench.airTargetInEnemyPatrolZone">
                ｜任务格在对手巡逻区内（14.4c）
              </template>
            </p>
            <div class="row">
              <label class="field">
                <input v-model="workbench.airInputs.interceptDeclared" type="checkbox" />
                拦截方宣布拦截（14.5：不强制）
              </label>
            </div>
            <!-- B14：拦截机＝**算子图阵列**（候选由引擎的资格判定给） -->
            <CounterPicker
              v-if="workbench.airInputs.interceptDeclared"
              title="拦截机（14.5：一次一架）"
              hint="14.5 拦截资格由引擎按 14.4c 的巡逻区判定；一次只能派一架"
              :items="interceptorItems"
              :size="32"
              @pick="workbench.airInputs.interceptorId = $event"
              @hover="hoverAir"
            />
            <div class="row">
              <BaseButton variant="primary" size="sm" @click="workbench.declareInterceptionNow()">
                ③ 记录拦截应答（14.2f-D）
              </BaseButton>
            </div>
          </template>

          <!-- ── 拦截空战结算（14.5 + 14.3e） ── -->
          <template
            v-if="workbench.airState.step === 'flak' && workbench.airState.interception?.declared"
          >
            <p class="num">
              拦截空战（14.5 按空战结算）：修 2 骰 + 拦截机 ACV − 迎战机 ACV； 胜 ⇒
              拦截机保持激活（不算执行过任务），败/双方返航 ⇒ 非激活。
            </p>
            <div class="row">
              <BaseButton
                variant="secondary"
                size="sm"
                @click="workbench.resolveInterceptionCombatNow()"
              >
                结算拦截空战（14.5）
              </BaseButton>
            </div>
            <p v-if="workbench.airState.interception.combat !== null" class="ok">
              <BaseTag kind="success">{{ workbench.airState.interception.combat.rule }}</BaseTag>
              {{ workbench.airState.interception.combat.detail }}
            </p>
          </template>

          <!-- ── ④ 防空应答（14.2f-E / 14.4） ── -->
          <template v-if="workbench.airState.step === 'flak'">
            <p class="num">
              防空（14.4e 表 17-3）：任务 ≥3 机 +1；目标格 HQ +1、基地等级每级 +1、印刷防空值
              +value；
              <template v-if="workbench.airTargetInEnemyPatrolZone">
                任务格在对手巡逻区内 ⇒ 任务编有战斗机 +1 / 无战斗机 +2（本任务{{
                  workbench.airMissionHasFighter ? '有' : '无'
                }}战斗机）
              </template>
              <template v-else>任务格不在对手巡逻区内 ⇒ 该组修正不适用</template>
              ｜修正后 ≥11 命中，用任务损失表（14.4f）定承受者。
            </p>
            <div class="row">
              <label class="field">
                目标格有 HQ（+1）
                <input v-model="workbench.airInputs.targetHasHQ" type="checkbox" />
              </label>
              <label class="field">
                印刷防空值
                <UiField
                  v-model="workbench.airInputs.printedFlakValue"
                  class="input num"
                  type="number"
                  min="0"
                />
              </label>
              <label class="field"> 目标基地等级（自动 {{ workbench.airTargetBaseLevel }}） </label>
            </div>
            <div class="row">
              <BaseButton variant="primary" size="sm" @click="workbench.resolveFlakNow()">
                ④ 结算防空（14.2f-E）
              </BaseButton>
            </div>
            <p v-if="workbench.airState.flak !== null" class="num">
              <BaseTag :kind="workbench.airState.flak.hit ? 'warning' : 'success'">
                {{ workbench.airState.flak.rule }}
              </BaseTag>
              {{ workbench.airState.flak.detail }}
            </p>
          </template>

          <!-- ── ⑤ 任务结算（14.2f-F） ── -->
          <template v-if="workbench.airState.step === 'resolveMission'">
            <div class="row">
              <label class="field">
                任务结果（如 C7 的轰炸结论）
                <UiField v-model="workbench.airInputs.missionNote" class="input" />
              </label>
              <BaseButton variant="primary" size="sm" @click="workbench.confirmAirMissionNow()">
                ⑤ 记录任务结算（14.2f-F）
              </BaseButton>
            </div>
          </template>

          <!-- ── ⑥ 返航（14.2f-G / 14.1c） ── -->
          <template v-if="workbench.airState.step === 'returnToBase'">
            <p class="muted">
              返航（14.1c）：必须回**距离内的本方**空军基地；常规任务返航一律变为非激活。
              留空即回原起飞基地。
            </p>
            <div class="row">
              <label
                v-for="origin in workbench.airState.assignment.origins"
                :key="origin.aircraftId"
                class="field"
              >
                {{ origin.aircraftId }} → 基地格
                <input
                  v-if="uiMode === 'verify'"
                  class="input"
                  :placeholder="hexLabel(origin.baseHex)"
                  :value="workbench.airInputs.returnHexText[origin.aircraftId] ?? ''"
                  @change="
                    workbench.airInputs.returnHexText = {
                      ...workbench.airInputs.returnHexText,
                      [origin.aircraftId]: ($event.target as HTMLInputElement).value,
                    }
                  "
                />
                <span v-else class="ui-field-readonly">{{
                  workbench.airInputs.returnHexText[origin.aircraftId] || hexLabel(origin.baseHex)
                }}</span>
                <!-- B27：返航基地格改成**点地图**（留空仍＝回原起飞基地） -->
                <BaseButton
                  variant="secondary"
                  size="sm"
                  @click="workbench.beginAirReturnHexPickNow(origin.aircraftId)"
                >
                  点地图选格
                </BaseButton>
              </label>
            </div>
            <div class="row">
              <BaseButton variant="primary" size="sm" @click="workbench.completeAirReturnNow()">
                ⑥ 返航（14.2f-G）
              </BaseButton>
            </div>
          </template>
        </template>

        <!-- ── ② 整备额度（15.1） ── -->
      </template>
      <template v-if="showsAdmin">
        <hr />
        <!-- 批 C 切片 2（用户口径 #18「有标题即可」）：成段规则文字收成标题 + 折叠 -->
        <RuleNote
          title="整备：点地图上的机场格 ⇒ 小窗「整备（15.1）」⇒ 勾飞机 ⇒ 点金黄补给站付 1T"
          rule="15.1"
        >
          <p class="muted">
            整备（15.1）：只在**飞机整备阶段**（A 段）进行；每基地每阶段一次；费用
            1T；容量＝基地等级×2 （简易机场 1 架）；未抵消的敌方 ZOC
            内不可整备；天气从不禁止（15.1D）。 **在盘面上做**：点地图上的机场格 ⇒
            小窗里点「整备（15.1）」⇒ 勾选要整备的飞机 ⇒ 点地图上金黄高亮的补给站付
            1T（与其它补给消耗同一方式）。
          </p>
        </RuleNote>
        <p v-if="workbench.ownAirBases.length === 0" class="muted">当前方没有空军基地（15.0）。</p>
        <div v-for="base in workbench.ownAirBases" :key="base.id" class="row">
          <BaseTag :kind="base.isAirstrip === true ? 'warning' : 'info'">
            {{ hexLabel(base.hex) }}
            {{ base.isAirstrip === true ? '简易机场' : `${base.level} 级` }}
          </BaseTag>
          <span class="num">
            非激活 {{ workbench.airInactiveAtBase(base.id).length }} 架｜整备容量
            {{ base.isAirstrip === true ? 1 : base.level * 2 }}
            <template v-if="workbench.refitDoneBases.some((item) => item.id === base.id)">
              ｜本阶段已整备（15.1A）
            </template>
          </span>
          <BaseButton
            variant="primary"
            size="sm"
            :disabled="
              workbench.refitDoneBases.some((item) => item.id === base.id) ||
              workbench.airInactiveAtBase(base.id).length === 0
            "
            @click="workbench.beginRefitNow(base.id)"
          >
            在地图上整备（15.1）
          </BaseButton>
          <BaseButton variant="ghost" size="sm" @click="workbench.toggleAirstripBase(base.id)">
            {{ base.isAirstrip === true ? '改回空军基地' : '声明为简易机场（15.2）' }}
          </BaseButton>
        </div>
        <p v-if="workbench.lastRefit !== null" class="ok">
          <BaseTag kind="success">{{ workbench.lastRefit.rule }}</BaseTag>
          {{ workbench.lastRefit.detail }}
        </p>

        <!-- ── ②b 基地修建 / 简易机场（15.3 / 15.2A，走 13.8d 的工程兵施工） ── -->
        <hr />
        <RuleNote
          title="修建空军基地 / 简易机场：选格 + 选工程兵 + 选付款站，一格一任务"
          rule="15.3 / 13.8d"
        >
          <p class="muted">
            修建（15.3）：**只能在移动阶段**，且**只能由具工程能力的单位**执行（13.8d：战斗模式或 DG
            朝战斗面、本阶段未移动、半径 2 格**步行 MP**内、**一格一任务**）。空军基地 **1 SP/级**、
            每回合 +1 级、上限 3 级。简易机场按 15.2A：**修建 1 T**、**升格为一级基地 3 T**；
            每格至多一个空中设施（4.8）。简易机场**永不缩减降级**（15.2E）。
          </p>
        </RuleNote>
        <div class="row">
          <label class="field">
            目标格
            <UiField
              v-model="workbench.constructionInputs.hexText"
              class="input"
              placeholder="36.13"
            />
            <BaseButton variant="secondary" size="sm" @click="workbench.beginAirBaseHexPickNow()">
              点地图选格
            </BaseButton>
          </label>
          <label class="field"> 付款补给站（建造耗 SP/T；缩减免费） </label>
        </div>
        <!-- B14：施工工程兵与付款补给站＝**算子图阵列**（原来是两个纯文字下拉） -->
        <CounterPicker
          title="施工工程兵（13.8d）"
          hint="13.8d：须具工程能力、处于战斗模式（或 DG 朝战斗面）、本阶段未移动、在目标格 2 格步行 MP 内"
          :items="engineerItems"
          :size="40"
          @pick="workbench.constructionInputs.engineerId = $event"
          @hover="hoverUnit"
        />
        <CounterPicker
          title="付款补给站（建造耗 SP/T；缩减免费）"
          hint="12.1b：从哪个补给站扣这次建造的 SP / T"
          :items="dumpItems"
          :size="32"
          @pick="workbench.constructionInputs.payDumpId = $event"
          @hover="hoverDump"
        />
        <div class="row">
          <BaseButton variant="primary" size="sm" @click="workbench.buildAirBaseNow()">
            修建/改进空军基地 +1 级（15.3：{{ workbench.airBaseBuildCostSpPerLevel }} SP/级）
          </BaseButton>
          <BaseButton variant="secondary" size="sm" @click="workbench.buildAirstripNow()">
            修建简易机场（15.2A：1 T）
          </BaseButton>
          <span class="num">
            本阶段已施工：{{ workbench.constructionPhaseLedger.hexes.join('、') || '无' }}｜任务
            {{ workbench.constructionPhaseLedger.task ?? '无' }}（13.8d：一格一任务）
          </span>
        </div>
        <p v-if="workbench.engineerChoices.length === 0" class="muted">
          当前方没有可施工的工程单位（13.8a/5.5b：须有工程能力且处于战斗模式，或 DG 朝战斗面）。
        </p>
        <p v-if="workbench.constructionError !== null" class="bad">
          <BaseTag kind="danger">{{ workbench.constructionError.rule }}</BaseTag>
          {{ workbench.constructionError.reason }}
        </p>
        <div
          v-for="base in workbench.ownAirBases.filter((item) => item.isAirstrip === true)"
          :key="`upgrade-${base.id}`"
          class="row"
        >
          <BaseTag kind="warning">{{ hexLabel(base.hex) }} 简易机场</BaseTag>
          <BaseButton variant="primary" size="sm" @click="workbench.upgradeAirstripNow(base.id)">
            升格为一级空军基地（15.2A：3 T）
          </BaseButton>
        </div>

        <!-- ── ③ 基地缩减（15.4） ── -->
        <hr />
        <RuleNote
          title="缩减基地：选格内被指定单位 ⇒ 点「缩减一级」；每基地每阶段一次、不耗 SP"
          rule="15.4"
        >
          <p class="muted">
            基地缩减（15.4）：只在**移动阶段**；由格内**被指定**的单位执行（RE 合计 ≥1
            或具工程能力， 逐员战斗模式且本阶段未移动）；每基地每阶段一次；永不降到 1
            级以下（15.0c）；不耗 SP。
            **15.2E：简易机场在任何情况下都不可缩减降级**（伤害或自愿都不行；上表已把简易机场列出，
            点它的「缩减一级」会被引擎按 15.2E 直接拒绝）。
          </p>
        </RuleNote>
        <div v-for="base in workbench.ownAirBases" :key="`reduce-${base.id}`" class="row">
          <BaseTag kind="neutral">{{ hexLabel(base.hex) }}（{{ base.level }} 级）</BaseTag>
          <BaseButton
            variant="secondary"
            size="sm"
            @click="
              workbench.airInputs.reductionUnitIds = workbench
                .airReductionCandidates(base.id)
                .map((unit) => unit.instanceId)
            "
          >
            取全部候选
          </BaseButton>
          <BaseButton variant="primary" size="sm" @click="workbench.reduceBaseNow(base.id)">
            缩减一级（15.4）
          </BaseButton>
          <!-- B14：被指定单位＝**算子图阵列**（点一枚即指定 / 再点取消；原来只是一行名字） -->
          <CounterPicker
            v-if="workbench.airReductionCandidates(base.id).length > 0"
            title="被指定单位（15.4）"
            hint="15.4：缩减由格内被指定的单位执行 —— RE 合计 ≥1 或具工程能力，逐员战斗模式且本阶段未移动"
            :items="reductionItems(base.id)"
            :size="32"
            @pick="workbench.toggleAirReductionUnit($event)"
            @hover="hoverUnit"
          />
        </div>
        <p v-if="workbench.lastReduction !== null" class="ok">
          <BaseTag kind="success">{{ workbench.lastReduction.rule }}</BaseTag>
          {{ workbench.lastReduction.detail }}
        </p>

        <!-- ── ④ 基地夺取（9.14f，表 17-6） ── -->
        <hr />
        <RuleNote title="夺取敌方基地：进入基地格即夺取，逐机掷夺取表（表 17-6）" rule="9.14f">
          <p class="muted">
            基地夺取（9.14f）：移动/进击阶段有**可攻击单位进入敌方基地格** ⇒
            基地被夺取并**立即归夺取方使用**
            （算子翻面）；无论天气都要为格内**每架**飞机掷夺取表（表 17-6）：+2 该机激活、+2
            由**战后推进** 夺取；幸存者必须转移到**距离 2
            倍内**的任意**友方**基地并转非激活，无处可转则摧毁。
          </p>
        </RuleNote>
        <div class="row">
          <label class="field">
            <input v-model="workbench.airInputs.baseCaptureByAdvance" type="checkbox" />
            由**战后推进**夺取（+2，9.14f）
          </label>
        </div>
        <p v-if="workbench.capturableEnemyAirBases.length === 0" class="muted">
          盘面上没有对手的空军基地。
        </p>
        <div
          v-for="base in workbench.capturableEnemyAirBases"
          :key="`capture-${base.id}`"
          class="row"
        >
          <BaseTag kind="warning">
            {{ hexLabel(base.hex) }}
            {{ base.isAirstrip === true ? '简易机场（15.2）' : `${base.level} 级` }}
          </BaseTag>
          <span class="num"
            >格内飞机 {{ workbench.airUnitsAt(base.hex, base.side).length }} 架</span
          >
          <BaseButton variant="danger" size="sm" @click="workbench.captureAirBaseNow(base.id)">
            夺取（9.14f）
          </BaseButton>
        </div>

        <p v-if="workbench.airError !== null" class="warn">
          <BaseTag kind="danger">{{ workbench.airError.rule }}</BaseTag>
          {{ workbench.airError.reason }}
        </p>

        <div class="row">
          <BaseButton variant="secondary" size="sm" @click="workbench.cancelAir()">
            放弃本次任务
          </BaseButton>
        </div>
      </template>
    </template>
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

.field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-muted);
}

.input {
  width: 88px;
  padding: 3px var(--space-2);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.select {
  padding: 3px var(--space-2);
  font-size: var(--text-xs);
}

.num {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.muted {
  color: var(--color-muted);
  font-size: var(--text-sm);
  margin: var(--space-1) 0;
}

.ok {
  color: var(--color-accent-2);
  font-size: var(--text-sm);
  margin: var(--space-1) 0;
}

.warn {
  color: var(--color-accent);
  font-size: var(--text-sm);
  margin: var(--space-1) 0;
}

hr {
  border: none;
  border-top: 1px solid var(--color-rule);
  margin: var(--space-3) 0;
}
/* 条 24「单位信息改图」：飞机清单每行带算子缩略图（文本仍保留，便于核对数值） */
.air-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

.air-row__thumb {
  width: 28px;
  height: 28px;
  object-fit: contain;
  vertical-align: middle;
  flex: 0 0 auto;
}

/* 条 24：步进控件里的数值显示（等宽、居中，避免加减按钮跳动） */
.cargo-sp {
  display: inline-block;
  min-width: 2.5ch;
  text-align: center;
}
</style>
