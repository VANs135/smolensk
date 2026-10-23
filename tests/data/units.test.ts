import { describe, expect, it } from 'vitest'

import { aircraft, unitsAxis, unitsSoviet } from '@/data'
import {
  GUDERIAN_FORMATIONS,
  HOTH_FORMATIONS,
  inferNoncombatKind,
  isArtillery,
  normalizeNoncombatType,
  panzerGroupOf,
  toFactorSet,
  toUnitRecord,
} from '../../scripts/sync-units.mjs'
import type { UnitRaw } from '../../scripts/sync-units.d.mts'

/** A5 战斗单位数值库加载冒烟 + 同步脚本转换函数（数据源 OCR/目检落值，2026-09-11） */

const allUnits = [...unitsAxis.units, ...unitsSoviet.units]

describe('units 数值库：规模与分类', () => {
  it('运行时库仅含 valued+verified（契约：引擎只加载 valued 以上），两侧合计一致', () => {
    expect(unitsAxis.units.length).toBeGreaterThanOrEqual(100)
    expect(unitsSoviet.units.length).toBeGreaterThanOrEqual(100)
    expect(allUnits.length).toBe(unitsAxis.units.length + unitsSoviet.units.length)
    for (const u of allUnits) {
      expect(['valued', 'verified']).toContain(u.status)
    }
  })

  it('战斗/非战斗分类：战斗为主且非战斗带 noncombatKind、无战斗数值', () => {
    const combat = allUnits.filter((u) => u.unitFamily === 'ground_combat')
    const nonCombat = allUnits.filter((u) => u.unitFamily === 'ground_noncombat')
    expect(combat.length).toBeGreaterThan(250)
    expect(nonCombat.length).toBeGreaterThan(30)
    for (const u of nonCombat) {
      expect(u.isCombat).toBe(false)
      expect(u.attackCapable).toBe(false)
    }
  })

  it('数值与能力分字段：capabilities/specialAbilities 只装规则能力，不做数值', () => {
    for (const u of allUnits) {
      if (u.capabilities) {
        expect(Array.isArray(u.capabilities)).toBe(true)
      }
      if (u.specialAbilities) {
        expect(Array.isArray(u.specialAbilities)).toBe(true)
      }
    }
    const breakdown = allUnits.find((u) => u.id.includes('breakdown'))
    expect(breakdown?.capabilities).toBeDefined()
  })

  it('noncombatKind 七类合法：含 organic_truck / supply_extender 运输点细分', () => {
    const LEGAL = [
      'sp',
      'supply_point',
      'transport_point',
      'organic_truck',
      'supply_extender',
      'air_base',
      'hedgehog',
      'port',
    ]
    for (const u of allUnits) {
      if (u.unitFamily === 'ground_noncombat' && u.noncombatKind) {
        expect(LEGAL).toContain(u.noncombatKind)
      }
    }
  })

  it('side=both 中立单位两边各一份（SP/air_base/hedgehog）', () => {
    const axisBoth = unitsAxis.units.filter((u) => u.side === 'both')
    const sovietBoth = unitsSoviet.units.filter((u) => u.side === 'both')
    expect(axisBoth.length).toBeGreaterThan(0)
    expect(axisBoth).toHaveLength(sovietBoth.length)
    const spBoth = axisBoth.filter((u) => u.noncombatKind === 'sp')
    const airbaseBoth = axisBoth.filter((u) => u.noncombatKind === 'air_base')
    const hedgehogBoth = axisBoth.filter((u) => u.noncombatKind === 'hedgehog')
    expect(spBoth.length).toBeGreaterThanOrEqual(3) // SP 1/2/3 双面算子
    expect(airbaseBoth.length).toBeGreaterThanOrEqual(1)
    expect(hedgehogBoth.length).toBeGreaterThanOrEqual(1)
  })

  it('HQ 投递距离（通规 13.1b：战斗面与移动面不同）', () => {
    const hq = allUnits.find((u) => (u.specialized ?? []).includes('hq'))
    expect(hq?.throwRange).toBeDefined()
    expect(hq?.throwRange?.combatFace).toBeGreaterThan(0)
    expect(hq?.throwRange?.moveFace).toBeGreaterThan(0)
    expect(hq?.specialRule).toBeDefined()
    expect(hq?.specialRule).toMatch(/13\./) // HQ 规则号以 13 开头
  })
})

describe('units 数值库：值与能力样例', () => {
  it('战斗单位双面数值（3-3-3 拆分团：战斗 3-3-3 / 移动 2-3-5）', () => {
    const unit = unitsSoviet.units.find((u) => u.id === 'su-breakdown-russian-3-3-3-breakdown')!
    expect(unit.factors!.combat).toMatchObject({ attack: 3, ar: 3, ma: 3 })
    expect(unit.factors!.move).toMatchObject({ attack: 2, ar: 3, ma: 5 })
    expect(unit.reSize).toBe(1)
    expect(unit.classes!.combatClass).toBe('other')
  })

  it('炮兵：轰炸值与射程按面落值（射程印于行动值下方）', () => {
    const arty = unitsSoviet.units.find((u) => u.id === 'su-artillery-ru-arty-bde')!
    expect(arty.specialized).toContain('artillery')
    expect(arty.factors!.combat).toMatchObject({ attack: 1, ar: 1, ma: 1, barrage: 26, range: 3 })
    expect(arty.factors!.move?.barrage).toBe(6)
    expect(arty.factors!.move?.range).toBe(3)
  })

  it('非战斗单位有 noncombatDetails：supply_point 带 spValue，transport 带 transport', () => {
    const sp = allUnits.find((u) => u.noncombatKind === 'sp' && u.id.includes('sp-1'))!
    expect(sp.noncombatDetails?.spValue).toBe(1)
    const truck = allUnits.find((u) => u.noncombatKind === 'transport_point')!
    expect(truck.noncombatDetails?.transport).toBeDefined()
  })

  it('specialized 规则化分类：炮兵/hq/补员/拆分各有标签', () => {
    const arty = allUnits.find((u) => u.id.includes('arty'))!
    expect(arty.specialized).toContain('artillery')
    const rep = allUnits.find((u) => u.id.includes('pax-repl') || u.id.includes('eq-repl'))!
    expect(rep.specialized).toContain('replacement')
  })

  it('攻击能力由印刷战斗值+括号判定（4.4），与能力字段分离', () => {
    for (const u of allUnits) {
      if (u.isCombat && u.factors?.combat?.attack != null) {
        expect(typeof u.attackCapable).toBe('boolean')
      }
    }
  })
})

describe('units 数值库：跨文件主键（运行实例 id 的唯一性来源）', () => {
  it('两文件重名的单位只能是 side=both 的中立算子，且两份记录逐字段相同', () => {
    const axisById = new Map(unitsAxis.units.map((u) => [u.id, u]))
    const collisions = unitsSoviet.units.filter((u) => axisById.has(u.id))
    expect(collisions.length).toBeGreaterThan(0)
    for (const soviet of collisions) {
      const axis = axisById.get(soviet.id)!
      // 中立算子（SP / 空军基地 / 工事）双方通用，故两边各存一份
      expect(axis.side).toBe('both')
      expect(soviet.side).toBe('both')
      expect(soviet).toEqual(axis)
    }
  })

  it('单位 id 与空军 aircraftId 不相交（同一实例表内主键唯一）', () => {
    const aircraftIds = new Set(aircraft.aircraft.map((a) => a.aircraftId))
    expect(allUnits.filter((u) => aircraftIds.has(u.id))).toEqual([])
  })
})

describe('units 数值库：装甲集群归属（专规 3.4，由素材编队目录派生）', () => {
  it('编队码清单：Hoth = 3rd Panzer Group 目录；其余编队目录 ⇒ Guderian', () => {
    expect(HOTH_FORMATIONS).toEqual([
      '7_Pz',
      '12_Pz',
      '19_Pz',
      '20_Pz',
      '14_Mtr',
      '18_Mtr',
      '20_Mtr',
    ])
    expect(GUDERIAN_FORMATIONS).toContain('SS-R')
    expect(GUDERIAN_FORMATIONS).toContain('1_Cav')
    expect(GUDERIAN_FORMATIONS).toContain('3_Pz')
  })

  it('panzerGroupOf：按算子图文件名前缀判；`18_Pz`（Guderian）不得被 `18_Mtr`（Hoth）误配', () => {
    expect(
      panzerGroupOf({ unit_id: 'x', side: 'axis', images: { front: 'Ge_7_Pz_I-25_Pz_BN_F.png' } }),
    ).toBe('hoth')
    expect(
      panzerGroupOf({
        unit_id: 'x',
        side: 'axis',
        images: { front: 'Ge_18_Mtr_51_Inf_RGT_F.png' },
      }),
    ).toBe('hoth')
    expect(
      panzerGroupOf({
        unit_id: 'x',
        side: 'axis',
        images: { front: 'Ge_18_Pz_101_Inf_RGT_F.png' },
      }),
    ).toBe('guderian')
    expect(
      panzerGroupOf({ unit_id: 'x', side: 'axis', images: { front: 'Ge_SS-R_R_Arty_F.png' } }),
    ).toBe('guderian')
    // 步兵师 / 独立单位 / 中立算子 ⇒ 不属任何装甲集群
    expect(
      panzerGroupOf({ unit_id: 'x', side: 'axis', images: { front: 'Ge_7_Inf_Div_F.png' } }),
    ).toBeNull()
    expect(
      panzerGroupOf({ unit_id: 'x', side: 'both', images: { front: 'Neutral_SP_3_F.png' } }),
    ).toBeNull()
    expect(panzerGroupOf({ unit_id: 'x', side: 'axis' })).toBeNull()
  })

  it('运行时库：轴方编队算子带 panzerGroup，步兵师与苏方不带', () => {
    const tagged = unitsAxis.units.filter((unit) => unit.panzerGroup != null)
    expect(tagged.length).toBeGreaterThan(50)
    expect(tagged.every((unit) => ['guderian', 'hoth'].includes(unit.panzerGroup as string))).toBe(
      true,
    )
    // 两侧都要有（Hoth 的 7.Pz 与 Guderian 的 3.Pz 都在轴方库里）
    expect(tagged.some((unit) => unit.panzerGroup === 'hoth')).toBe(true)
    expect(tagged.some((unit) => unit.panzerGroup === 'guderian')).toBe(true)
    // 苏方不受 3.4 约束 ⇒ 一条也不带
    expect(unitsSoviet.units.every((unit) => unit.panzerGroup == null)).toBe(true)
  })
})

describe('aircraft 空军专表', () => {
  it('22 型，机种徽记合法（F/T/S/Tpt/comb），数值完整', () => {
    expect(aircraft.aircraft).toHaveLength(22)
    for (const a of aircraft.aircraft) {
      expect(['F', 'T', 'S', 'Tpt', 'comb']).toContain(a.aircraftType)
      expect(a.rangeHexes).toBeGreaterThan(0)
      expect(a.steps).toBeGreaterThan(0)
    }
  })

  it('阵营分布：苏 12 / 轴 10，战斗机为唯一可拦截类型', () => {
    expect(aircraft.aircraft.filter((a) => a.side === 'soviet')).toHaveLength(12)
    expect(aircraft.aircraft.filter((a) => a.side === 'axis')).toHaveLength(10)
    expect(aircraft.aircraft.some((a) => a.aircraftType === 'F')).toBe(true)
  })

  it('空军能力布尔表：苏军禁 hip shoot / 禁反应进击出击', () => {
    const sovFtr = aircraft.aircraft.find((a) => a.side === 'soviet' && a.aircraftType === 'F')!
    expect(sovFtr.airAbilities?.canHipShoot).toBe(false)
    expect(sovFtr.airAbilities?.missionInReactionPhase).toBe(false)
    expect(sovFtr.airAbilities?.missionInExploitationPhase).toBe(false)
    expect(sovFtr.specialAbilities).toContain('no_hip_shoots')
    const axisFtr = aircraft.aircraft.find((a) => a.side === 'axis' && a.aircraftType === 'F')!
    expect(axisFtr.airAbilities?.canHipShoot).toBe(true)
    expect(axisFtr.airAbilities?.missionInReactionPhase).toBe(true)
  })

  it('14.9 / 14.10：能运货的机型印值带单位（"1T" / "1/2T"），必须解析成吨数', () => {
    // 本作只有 3 型带印刷运力（组合类型 TB.3 / He.111 + 运输机 Ju.52），其余机型无运力
    const withCapacity = aircraft.aircraft.filter((a) => a.transportCapacity !== null)
    expect(withCapacity.map((a) => a.aircraftId).sort()).toEqual([
      'ax-aircraft-ge-he-111',
      'ax-aircraft-ge-ju-52',
      'su-aircraft-ru-tb-3',
    ])
    const ju52 = aircraft.aircraft.find((a) => a.aircraftId === 'ax-aircraft-ge-ju-52')
    expect(ju52?.transportCapacity).toBe(1)
    const he111 = aircraft.aircraft.find((a) => a.aircraftId === 'ax-aircraft-ge-he-111')
    expect(he111?.transportCapacity).toBe(0.5)
  })
})

describe('12.7a：通用运输点数是具象化点数（面额 1–5，可任意拆分）', () => {
  it('两方的运输点算子面额齐全为 1..5，且都带类型（truck / wagon）', () => {
    for (const units of [unitsAxis.units, unitsSoviet.units]) {
      const points = units.filter((u) => u.noncombatKind === 'transport_point')
      expect(points.length).toBeGreaterThan(0)
      const faces = [...new Set(points.map((u) => u.noncombatDetails?.transport ?? -1))].sort(
        (a, b) => a - b,
      )
      expect(faces).toEqual([1, 2, 3, 4, 5])
      for (const unit of points) {
        expect(['truck', 'wagon']).toContain(unit.noncombatDetails?.transportKind)
      }
    }
  })

  it('5.7f：编内卡车是另一类（不进运输点数、不参与 5 点凑数）', () => {
    const organic = unitsAxis.units.filter((u) => u.noncombatKind === 'organic_truck')
    expect(organic.length).toBeGreaterThan(0)
    // 编内卡车没有 transportKind ⇒ 无法被当成通用运输点数
    for (const unit of organic) {
      expect(unit.noncombatDetails?.transportKind ?? null).toBeNull()
    }
  })
})

describe('sync-units 转换函数（脚本级）', () => {
  it('toFactorSet：标准面与炮兵面（无 A → 战斗值恒 1）', () => {
    expect(toFactorSet({ A: 20, AR: 4, MA: 3 })).toEqual({ attack: 20, ar: 4, ma: 3 })
    expect(toFactorSet({ barrage: 26, AR: 1, range: 3, MA: 1 }, true)).toEqual({
      attack: 1,
      ar: 1,
      ma: 1,
      barrage: 26,
      range: 3,
    })
    expect(toFactorSet(null)).toBeNull()
  })

  it('isArtillery：specialized 或 arm 判定', () => {
    expect(
      isArtillery({ unit_id: 'x', vassal_name: 'y', side: 'soviet', specialized: ['artillery'] }),
    ).toBe(true)
    expect(isArtillery({ unit_id: 'x', vassal_name: 'y', side: 'soviet', arm: 'artillery' })).toBe(
      true,
    )
    expect(isArtillery({ unit_id: 'x', vassal_name: 'y', side: 'soviet' })).toBe(false)
  })

  it('normalizeNoncombatType：直接用库值做口径归一化', () => {
    expect(normalizeNoncombatType({ non_combat_type: 'supply_point' })).toBe('sp')
    expect(normalizeNoncombatType({ non_combat_type: 'transport_point' })).toBe('transport_point')
    expect(normalizeNoncombatType({ non_combat_type: 'organic_truck' })).toBe('organic_truck')
    expect(normalizeNoncombatType({ non_combat_type: 'air_base' })).toBe('air_base')
    expect(normalizeNoncombatType({})).toBeNull()
    expect(normalizeNoncombatType({ non_combat_type: null })).toBeNull()
  })

  it('inferNoncombatKind：委托 normalizeNoncombatType（保持兼容）', () => {
    expect(inferNoncombatKind({ non_combat_type: 'supply_point' })).toBe('sp')
    expect(inferNoncombatKind({ non_combat_type: 'transport_point' })).toBe('transport_point')
    expect(inferNoncombatKind({})).toBeNull()
  })

  it('toUnitRecord：裁剪无值字段，聚合面数值，含新字段', () => {
    const raw: UnitRaw = {
      unit_id: 'ax-inf-268',
      vassal_name: 'Ge 268 Inf',
      side: 'axis',
      arm: 'infantry',
      echelon: 'div',
      unit_kind: 'combat',
      combat_category: 'other',
      mobility_type: 'leg',
      steps_total: 4,
      RE: 1,
      attack_capable: true,
      A_parenthesized: false,
      rebuildable: true,
      fill_stage: 'verified',
      special_rule: '4.4',
      special_abilities: ['barrage'],
      printed_values: {
        front: { A: 20, AR: 4, MA: 3 },
        back: { A: 10, AR: 4, MA: 5 },
      },
    }
    const record = toUnitRecord(raw) as {
      factors: { combat: Record<string, number>; move: Record<string, number> }
      specialRule?: string
      specialAbilities?: string[]
    }
    expect(record.factors.combat).toEqual({ attack: 20, ar: 4, ma: 3 })
    expect(record.factors.move).toEqual({ attack: 10, ar: 4, ma: 5 })
    expect('noncombatKind' in record).toBe(true) // 战斗单位为 null（但字段存在）
    expect(record.specialRule).toBe('4.4')
    expect(record.specialAbilities).toContain('barrage')
  })

  it('toUnitRecord：HQ 自动生成 throwRange', () => {
    const hq: UnitRaw = {
      unit_id: 'su-hq-test',
      vassal_name: 'Ru Test HQ',
      side: 'soviet',
      arm: 'hq',
      specialized: ['hq'],
      unit_kind: 'combat',
      attack_capable: false,
      A_parenthesized: true,
      rebuildable: true,
      fill_stage: 'verified',
      special_rule: '13.1b',
      printed_values: {
        front: { A: 5, AR: 0, MA: 0, throw_range: 10 },
        back: { A: 1, AR: 0, MA: 10, throw_range: 7 },
      },
    }
    const record = toUnitRecord(hq) as {
      throwRange?: { combatFace?: number; moveFace?: number }
    }
    expect(record.throwRange).toBeDefined()
    expect(record.throwRange?.combatFace).toBe(10)
    expect(record.throwRange?.moveFace).toBe(7)
  })

  it('toUnitRecord：side 直接保留原值（含 both）', () => {
    const neutral: UnitRaw = {
      unit_id: 'neutral-supply-sp-1',
      vassal_name: 'SP 1',
      side: 'both',
      non_combat_type: 'supply_point',
      unit_kind: 'non_combat',
      attack_capable: false,
      rebuildable: true,
      fill_stage: 'verified',
      printed_values: {
        front: { sp: '1' },
      },
    }
    const record = toUnitRecord(neutral) as { side: string }
    expect(record.side).toBe('both')
  })
})

describe('铁路修理单位（13.3f / 13.3g 的载体）', () => {
  /** 2026-09-15 用户裁定印值：苏 (1)-0-3 / (0)-0-9 轮式；德两支均为 (1)-2-5 / (0)-2-9 轮式 */
  const RR = [
    { id: 'su-engineer-west-rr-rgt', side: 'soviet', combat: [1, 0, 3], move: [0, 0, 9] },
    { id: 'ax-engineer-ge-i-2-rr-bn', side: 'axis', combat: [1, 2, 5], move: [0, 2, 9] },
    { id: 'ax-engineer-ge-ii-2-rr-bn', side: 'axis', combat: [1, 2, 5], move: [0, 2, 9] },
  ]

  it('三支单位都在运行时库里，且带 specialized: rail_repair（引擎 isRailRepairUnit 的唯一判据）', () => {
    for (const entry of RR) {
      const unit = allUnits.find((u) => u.id === entry.id)
      expect(unit, `${entry.id} 未入库`).toBeDefined()
      expect(unit!.side).toBe(entry.side)
      expect(unit!.specialized).toContain('rail_repair')
      expect(unit!.status).toBe('valued')
    }
  })

  it('印值与用户 2026-09-15 裁定一致（战斗面 A-AR-MA / 移动面 A-AR-MA）', () => {
    for (const entry of RR) {
      const unit = allUnits.find((u) => u.id === entry.id)!
      const [ca, car, cma] = entry.combat
      const [ma, mar, mma] = entry.move
      expect(unit.factors!.combat).toEqual({ attack: ca, ar: car, ma: cma })
      expect(unit.factors!.move).toEqual({ attack: ma, ar: mar, ma: mma })
      // ★ 记录级机动类型取自**战斗面**（徒步）；移动面是轮式 —— 通规 3.1a 允许两面颜色不同，
      //   逐面机动类型尚未建模（本作 101/435 条记录两面不同），故此处如实钉住现状
      expect(unit.classes!.movementClass).toBe('leg')
    }
  })

  it('11.0：铁路修理单位不可发起攻击（印值带括号），但仍是战斗单位（可做 4.5b 抵消）', () => {
    for (const entry of RR) {
      const unit = allUnits.find((u) => u.id === entry.id)!
      expect(unit.attackCapable).toBe(false)
      expect(unit.isCombat).toBe(true)
      expect(unit.attackValueBracketed).toBe(true)
    }
  })
})

describe('3.1a 逐面机动类型（mobilityByFace）', () => {
  it('每条记录都带逐面值，且至少一面有值（两面皆缺 = 0 条）', () => {
    for (const unit of allUnits) {
      const faces = unit.mobilityByFace
      expect(faces, `${unit.id} 无 mobilityByFace`).toBeDefined()
      expect(faces!.combat ?? faces!.move, `${unit.id} 两面都没有值`).toBeDefined()
      for (const value of [faces!.combat, faces!.move])
        if (value !== undefined) expect(['leg', 'truck', 'tracked']).toContain(value)
    }
  })

  it('两面不同的记录：轴 57 条、苏 11 条（**一律** leg→truck；修前一律按记录级判 ⇒ 判反）', () => {
    const tally = (side: 'axis' | 'soviet') => {
      const list = side === 'axis' ? unitsAxis.units : unitsSoviet.units
      const swapped = list.filter(
        (u) =>
          u.mobilityByFace?.combat !== undefined &&
          u.mobilityByFace?.move !== undefined &&
          u.mobilityByFace.combat !== u.mobilityByFace.move,
      )
      const kinds: Record<string, number> = {}
      for (const u of swapped) {
        const key = `${u.mobilityByFace!.combat}→${u.mobilityByFace!.move}`
        kinds[key] = (kinds[key] ?? 0) + 1
      }
      return { total: swapped.length, kinds }
    }
    // 2026-09-15 库从 333 条扩到 420 条（87 条 classified 推进 valued）⇒ 逐面不同的条数同步上升
    // 同日又按素材目录叶统一机动类型：19 条苏军步兵/民兵师改为两面皆 leg（叶内一致），苏方 44 → 25
    // 2026-09-17 复核：用户裁定 26/38 坦克师（坦克打光后的步兵单位，图档在「步兵师」）两面皆 leg，
    //   另按同型群体一致性改 3 条步枪师（81 枚中其余 78 枚两面皆 leg）⇒ **苏方 25 → 20**
    // 2026-09-17 二轮裁定（骑兵全徒步 / 筑垒全徒步 / 摩托化＝战斗面徒步·移动面轮式）后：
    //   苏方 20 → **11**、轴方 57 → **57**（truck→leg 的 14 条全部消失；编内卡车两枚回两面轮式），
    //   且**全库只剩 leg→truck 一个方向**（见回执 §17.67）—— 这也是下面 `per-face-mobility-flow`
    //   组里反向样本改用构造记录的原因。
    expect(tally('axis')).toEqual({ total: 57, kinds: { 'leg→truck': 57 } })
    expect(tally('soviet')).toEqual({ total: 11, kinds: { 'leg→truck': 11 } })
  })

  it('缺面时只留一面（供消费侧回退记录级），且记录级必等于其中一面', () => {
    for (const unit of allUnits) {
      const faces = unit.mobilityByFace!
      const record = unit.classes?.movementClass
      if (record === undefined) continue
      // 记录级只可能等于战斗面或移动面（源库两处口径一致）
      expect([faces.combat, faces.move]).toContain(record)
    }
  })

  it('编内卡车：两面都是轮式、且是**运输单位**（13.0 只有移动模式；两面＝空载/满载，非战斗/移动）', () => {
    // 2026-09-15 起逐条回正；2026-09-17 用户补充口径：「编内卡车只有移动模式，两面是空载和满载」
    // ⇒ 面由**装载**（`loadedSpT`）决定、与朝向无关（选图在 `render/token-images`），
    // 机动类型两面都是 truck。这里把**全库**编内卡车一并钉住，防止取色再读成 leg。
    const trucks = allUnits.filter((u) => u.noncombatKind === 'organic_truck')
    expect(trucks.length).toBe(15)
    for (const unit of trucks) {
      expect(unit.mobilityByFace, unit.id).toEqual({ combat: 'truck', move: 'truck' })
      expect(unit.classes?.movementClass ?? 'truck', unit.id).toBe('truck')
      // 3.3 / 13.0：非战斗单位，不会进入"战斗模式"
      expect(unit.isCombat, unit.id).toBe(false)
    }
    // 马车延补队（MA 10，12.7b：马车＝徒步 10）的正面曾被读成 truck
    for (const id of ['su-extender-wagon', 'ax-extender-wagon']) {
      const unit = allUnits.find((u) => u.id === id)!
      expect(unit.classes!.movementClass).toBe('leg')
      expect(unit.mobilityByFace?.combat).toBe('leg')
    }
  })

  it('2026-09-17 裁定：轴方 aufk/krd 两面履带；苏军 1.Mtr 93 Recon 两面轮式（编队单位目录不能一概而论）', () => {
    /* 用户原话：「编队单位里的和我给你的目录不一样，不能一概而论，轴心的 aufk 和 krd 两面都是履带，
     * 苏军的 Ru_1_Mtr_93_Recon_BN 两面都是轮式」。⇒ 这两组**不套**摩托化的"正面徒步/背面轮式"口径。 */
    const AXIS_TRACKED = [
      // krd（Kradschützen，摩托车营）
      'ax-motorized-ge-10-mtr-40-mc',
      'ax-motorized-ge-14-mtr-54-mc',
      'ax-motorized-ge-18-mtr-38-mc',
      'ax-motorized-ge-20-mtr-30-mc',
      'ax-motorized-ge-29-mtr-29-mc',
      'ax-motorcycle-ge-ss-r-r-mc',
      // aufk（Aufklärungs，装甲侦察营）
      'ax-arm_rec-ge-10-mtr-10-arm-rec',
      'ax-arm_rec-ge-14-mtr-14-arm-rec',
      'ax-arm_rec-ge-18-mtr-18-arm-rec',
      'ax-arm_rec-ge-20-mtr-20-arm-rec',
      'ax-arm_rec-ge-29-mtr-29-arm-rec',
      'ax-arm_rec-ge-ss-r-r-arm-rec',
      'ax-arm_rec-ge-lehr-aufk-bn',
    ]
    for (const id of AXIS_TRACKED) {
      const unit = allUnits.find((u) => u.id === id)
      expect(unit, `库里没有 ${id}`).not.toBeUndefined()
      expect(unit!.mobilityByFace, id).toEqual({ combat: 'tracked', move: 'tracked' })
    }
    // 苏军的装甲侦察营与摩托车团一律两面轮式（摩托车团那 5 条在「摩托化侦察」目录内）
    for (const id of [
      'su-arm_rec-ru-1-mot-93-recon',
      'su-motorcycle-ru-9-mc-rgt',
      'su-motorcycle-ru-12-mc-rgt',
      'su-motorcycle-ru-20-mc-rgt',
      'su-motorcycle-ru-27-mc-rgt',
      'su-motorcycle-ru-31-mc-rgt',
    ]) {
      const unit = allUnits.find((u) => u.id === id)
      expect(unit, `库里没有 ${id}`).not.toBeUndefined()
      expect(unit!.mobilityByFace, id).toEqual({ combat: 'truck', move: 'truck' })
    }
  })

  it('2026-09-17 二轮裁定：骑兵与筑垒一律两面徒步；摩托化＝正面徒步·背面轮式（例外目录两面轮式）', () => {
    /* 用户原话：「骑兵全徒步、筑垒全徒步，除了『摩托化步兵师』与『摩托化侦察』里的独立单位
     * 是两面轮式、其它摩托化单位全是正面徒步背面轮式」。判据取 arm 而不是图档路径（数据层没有
     * 路径字段），例外目录用点名的那 4 条摩托化师 + 5 条摩托车团代表。 */
    const twoFacesOf = (id: string) => allUnits.find((u) => u.id === id)!.mobilityByFace
    // 骑兵（含德军第 1 骑兵师各营与 1 自行车营）：17 条**全部**两面 leg
    const cavalry = allUnits.filter((u) => /cavalry|cav-/.test(u.id))
    expect(cavalry.length).toBe(17)
    expect(new Set(cavalry.map((u) => JSON.stringify(u.mobilityByFace)))).toEqual(
      new Set([JSON.stringify({ combat: 'leg', move: 'leg' })]),
    )
    for (const id of [
      'su-cavalry-ru-21-mtn-cav-div',
      'su-cavalry-ru-45-cav-div',
      'su-cavalry-ru-53-cav-div',
      'ax-cavalry-ge-1-cav-i-1-cav',
      'ax-cavalry-ge-1-cav-1-bikes',
      'ax-cavalry-ge-1-cav-1-arty',
    ]) {
      expect(twoFacesOf(id), id).toEqual({ combat: 'leg', move: 'leg' })
    }
    // 筑垒（坚固地域旅）：8 条**全部**两面 leg
    const urBde = allUnits.filter((u) => u.id.startsWith('su-fortified_region-'))
    expect(urBde.length).toBe(8)
    expect(new Set(urBde.map((u) => JSON.stringify(u.mobilityByFace)))).toEqual(
      new Set([JSON.stringify({ combat: 'leg', move: 'leg' })]),
    )
    // 其它摩托化：正面 leg / 背面 truck（苏 1.Mot 与各轴方摩托化师团、SS 帝国师炮兵）
    for (const id of [
      'su-motorized-ru-1-mot-20-mot-inf',
      'su-motorized-ru-1-mot-13-arty',
      'su-motorized-ru-1-nkvd-mot-inf-rgt',
      'ax-motorized-ge-18-mtr-30-mot-inf',
      'ax-motorized-ge-18-mtr-18-arty',
      'ax-motorized-ge-29-mtr-71-mot-inf',
      'ax-motorized-ge-ss-r-deutschland-mot-inf',
      'ax-artillery-ge-ss-r-r-arty',
    ]) {
      expect(twoFacesOf(id), id).toEqual({ combat: 'leg', move: 'truck' })
    }
    // 例外目录：摩托化步兵师 4 条 + 摩托化侦察/摩托车团 5 条 ⇒ 两面 truck
    for (const id of [
      'su-motorized-ru-69-mot-div',
      'su-motorized-ru-103-mot-div',
      'su-motorized-ru-106-mot-div',
      'su-motorized-ru-107-mot-div',
      'su-motorcycle-ru-9-mc-rgt',
      'su-motorcycle-ru-12-mc-rgt',
      'su-motorcycle-ru-20-mc-rgt',
      'su-motorcycle-ru-27-mc-rgt',
      'su-motorcycle-ru-31-mc-rgt',
    ]) {
      expect(twoFacesOf(id), id).toEqual({ combat: 'truck', move: 'truck' })
    }
  })

  it('抽查：26 坦克师两面皆 leg（用户 2026-09-17 裁定）/ 4.Pz 摩托化步兵团移动面 truck', () => {
    // 用户 2026-09-17：「26-tk-div 是坦克打光后的步兵单位，在步兵文件夹，两面都是徒步」。
    // 取色曾把正面读成 truck（MA 1 判黑），与图档所在目录（步兵师）及同型群体相反 ⇒ 已改判。
    const tank = allUnits.find((u) => u.id === 'su-armor_tk-ru-26-tk-div')!
    expect(tank.classes!.movementClass).toBe('leg')
    expect(tank.mobilityByFace).toEqual({ combat: 'leg', move: 'leg' })
    // 移动面印值 2 → 3：2026-09-15 按素材目录叶「1RE\1AR」统一（该叶三条一律 4-1-1 / 2-1-3，图证）
    expect(tank.factors!.move!.ma).toBe(3)
    // 38 坦克师与 26 同叶同型（图档 Ru_38_Tk_Inf_Div_F.png 与 Ru_26_Tk_Inf_Div_F.png 同目录）⇒ 一并改判
    const siblingTank = allUnits.find((u) => u.id === 'su-armor_tk-ru-38-tk-div')!
    expect(siblingTank.mobilityByFace).toEqual({ combat: 'leg', move: 'leg' })

    const motInf = allUnits.find((u) => u.id === 'ax-armor_pz-ge-4-pz-12-mot-inf')!
    expect(motInf.classes!.movementClass).toBe('leg')
    expect(motInf.mobilityByFace).toEqual({ combat: 'leg', move: 'truck' })
    // 移动面印值 6 → 16：2026-09-15 素材图重读改正（4.Pz 12 与 4.Pz 33 的移动面印的是同一套值 4-4-16）
    expect(motInf.factors!.move!.ma).toBe(16)
    const sibling = allUnits.find((u) => u.id === 'ax-armor_pz-ge-4-pz-33-mot-inf')!
    expect(sibling.factors!.move!.ma).toBe(16)
  })

  it('2026-09-15 按素材目录叶分类统一苏军步兵师：每个叶内的单位印值必须完全一致', () => {
    // 叶名与目标背面印值取自 `图片素材库\苏联单位\步兵师\**` 的最下级目录（用户口径：
    // 「同最下级目录的单位数值应完全一致」）。正面各叶本就一致，此处把**背面**（A-AR-MA）钉住。
    const RIFLE = (numbers: readonly number[]) =>
      numbers.map((n) => `su-infantry-ru-${n}-rifle-div`)
    const MILITIA = (numbers: readonly number[]) =>
      numbers.map((n) => `su-militia-ru-${n}-militia-div`)
    const LEAVES: readonly {
      leaf: string
      back: readonly [number, number, number]
      ids: readonly string[]
    }[] = [
      {
        leaf: '1RE\\0AR',
        back: [5, 0, 3],
        ids: RIFLE([103, 145]),
      },
      {
        leaf: '1RE\\1AR',
        back: [2, 1, 3],
        ids: [...RIFLE([210]), 'su-armor_tk-ru-26-tk-div', 'su-armor_tk-ru-38-tk-div'],
      },
      {
        leaf: '1RE2AR不可重建',
        back: [3, 2, 5],
        ids: RIFLE([109, 219]),
      },
      {
        leaf: '2RE\\0AR',
        back: [5, 0, 3],
        ids: RIFLE([134, 149, 162, 242]),
      },
      {
        leaf: '2RE\\1AR',
        back: [5, 1, 3],
        ids: RIFLE([
          18, 38, 46, 64, 121, 126, 132, 133, 143, 155, 166, 178, 187, 214, 217, 233, 243, 244, 252,
          280, 282, 303, 309,
        ]),
      },
      {
        leaf: '2RE\\2AR',
        back: [6, 2, 4],
        ids: RIFLE([
          6, 17, 19, 24, 42, 49, 50, 53, 55, 61, 73, 89, 91, 102, 107, 108, 110, 117, 119, 129, 137,
          144, 148, 151, 152, 153, 154, 158, 160, 161, 167, 172, 186, 211, 220, 222, 229, 246, 247,
          248, 249, 250, 251, 269, 278, 279,
        ]),
      },
      { leaf: '2RE民兵\\0AR', back: [5, 0, 3], ids: MILITIA([9, 13, 21]) },
      { leaf: '2RE民兵\\1AR', back: [5, 1, 3], ids: MILITIA([2, 4, 5, 6, 8, 18]) },
      { leaf: '2RE民兵\\2AR', back: [6, 2, 4], ids: MILITIA([1, 7, 17]) },
      { leaf: '3RE', back: [6, 3, 5], ids: RIFLE([100, 120, 127]) },
    ]

    let checked = 0
    for (const { leaf, back, ids } of LEAVES) {
      const [attack, ar, ma] = back
      for (const id of ids) {
        const unit = allUnits.find((u) => u.id === id)
        expect(unit, `${leaf} 里没有 ${id}`).not.toBeUndefined()
        expect(
          unit!.factors!.move,
          `${leaf} 的 ${id} 背面应统一为 ${attack}-${ar}-${ma}`,
        ).toMatchObject({ attack, ar, ma })
        checked += 1
      }
    }
    expect(checked).toBe(95)
  })

  it('2026-09-15 按素材目录叶统一**机动类型**：三叶 19 条两道面皆 leg（图证：MA 白填充＝徒步）', () => {
    // 用户口径：每个叶里地面战斗单位的正面/背面「数值与机动类型」都必须一致。
    // 图证见 backup/2026-09-15-mobility/crops/mobility.png：这 19 条的 MA 均为白填充（徒步），
    // 参照行是德军摩托化团的实心黑 16（轮式）。改前它们分别错标 front 或 back = truck。
    const FIXED = [
      // 2RE\1AR：正面 truck→leg（顶层同步）
      'su-infantry-ru-18-rifle-div',
      'su-infantry-ru-121-rifle-div',
      'su-infantry-ru-126-rifle-div',
      'su-infantry-ru-178-rifle-div',
      'su-infantry-ru-187-rifle-div',
      'su-infantry-ru-214-rifle-div',
      'su-infantry-ru-233-rifle-div',
      'su-infantry-ru-252-rifle-div',
      'su-infantry-ru-280-rifle-div',
      'su-infantry-ru-282-rifle-div',
      // 2RE民兵\1AR：正面 truck→leg
      'su-militia-ru-2-militia-div',
      'su-militia-ru-4-militia-div',
      'su-militia-ru-5-militia-div',
      'su-militia-ru-6-militia-div',
      // 2RE\1AR / 2RE\2AR：背面 truck→leg
      'su-infantry-ru-119-rifle-div',
      'su-infantry-ru-132-rifle-div',
      'su-infantry-ru-133-rifle-div',
      'su-infantry-ru-152-rifle-div',
      'su-infantry-ru-153-rifle-div',
    ]
    for (const id of FIXED) {
      const unit = allUnits.find((u) => u.id === id)
      expect(unit, `没有 ${id}`).not.toBeUndefined()
      expect(unit!.mobilityByFace, `${id} 两道面都应是徒步`).toEqual({ combat: 'leg', move: 'leg' })
      expect(unit!.classes!.movementClass, `${id} 记录级同步为 leg`).toBe('leg')
    }
    expect(FIXED.length).toBe(19)
  })
})
