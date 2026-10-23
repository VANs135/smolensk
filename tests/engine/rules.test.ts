import { describe, expect, it } from 'vitest'

import {
  AIR_BASE_COST_SP_PER_LEVEL,
  AIR_BASE_MAX_LEVEL,
  AIRSTRIP_BUILD_T,
  AIRSTRIP_UPGRADE_T,
  AXIS_AIR_BOX_RANGE_HEXES,
  BARRAGE_DENSITY_CAP_RE,
  BARRAGE_MAX_AIRCRAFT_PER_MISSION,
  BARRAGE_MIN_VALUE,
  BARRAGE_NO_SPOTTER_SHIFT_LEFT,
  BREAKOUT_FIRST_TURN_DRM,
  BREAKOUT_RANGE_HEXES,
  COMBAT_SUPPLY_ATTACKER_T_PER_STEP,
  COMBAT_SUPPLY_DEFENDER_T,
  DG_AR_MOD,
  DIRECT_DRAW_RANGE_MP,
  EARLY_DECISION_START,
  EDGE_BOX_ENTRY_MP,
  EXTENDER_REQUIRED_POINTS,
  FLAK_KILL_MIN_DICE,
  FRONTAL_RESERVES_SP,
  FUEL_FORMATION_SP,
  FUEL_SINGLE_UNIT_T,
  HEDGEHOG_COST_SP_PER_LEVEL,
  HEDGEHOG_MAX_LEVEL,
  LOADING_COST_FRACTION,
  MINIMUM_MOVE_HEXES,
  OVERRUN_MP_COST,
  PANZER_GROUP_CONSTRAINT_END,
  PATROL_ZONE_MAX_HEXES,
  PRINTED_HEDGEHOG_LEVEL,
  RAIL_CAP_BOOST_DATE,
  RAIL_CONVERSION_MAX_PER_PHASE,
  REFIT_AIRCRAFT_PER_LEVEL,
  REFIT_T_PER_BASE,
  RESERVE_MA_NORMAL_MULT,
  RETREAT_DG_MIN_HEXES,
  SOVIET_AIR_BOX_RANGE_HEXES,
  SP_TO_T,
  STACKING_LIMIT_RE,
  STRAT_MA_MULT,
  SUPPLY_CACHE_PER_SIDE,
  VARIABLE_EXIT_START,
  WEATHER_DICE_COUNT,
  WEATHER_LIMITED_FLIGHT_MAX_DICE,
  WEATHER_NORMAL_FLIGHT_MIN_DICE,
} from '@/engine/rules'

/**
 * 规则常量模块完整性测试
 *
 * A9 判据：engine/rules 提供可引用常量，数值与已核实的规则库一致；
 * 所有常量源于 data/rules-constants.json（冻结），业务代码不再出现数字字面量。
 */
describe('engine/rules 常量', () => {
  it('补给类：SP 换算与费用', () => {
    expect(SP_TO_T).toBe(4)
    expect(DIRECT_DRAW_RANGE_MP).toBe(5)
    expect(COMBAT_SUPPLY_ATTACKER_T_PER_STEP).toBe(1)
    expect(COMBAT_SUPPLY_DEFENDER_T).toBe(2)
    // 12.7a：5 点同型运输点换 1 支延补队 —— 该常量只有 `extender.ts` 一处（批 F 切片 4② 收敛）
    expect(EXTENDER_REQUIRED_POINTS).toBe(5)
    expect(BREAKOUT_RANGE_HEXES).toBe(15)
    expect(BREAKOUT_FIRST_TURN_DRM).toBe(1)
  })

  it('燃料类：编队/HQ/独立单位', () => {
    expect(FUEL_FORMATION_SP).toBe(1)
    expect(FUEL_SINGLE_UNIT_T).toBe(1)
  })

  it('模式类：DG 行动值修正与倍率', () => {
    expect(DG_AR_MOD).toBe(-1)
    expect(STRAT_MA_MULT).toBe(2)
    expect(RESERVE_MA_NORMAL_MULT).toBe(0.25)
  })

  it('移动类：堆叠/最小移动/装载/轨转', () => {
    expect(MINIMUM_MOVE_HEXES).toBe(1)
    expect(STACKING_LIMIT_RE).toBe(10)
    expect(LOADING_COST_FRACTION).toBe(0.1)
    expect(RAIL_CONVERSION_MAX_PER_PHASE).toBe(4)
    expect(EDGE_BOX_ENTRY_MP).toBe(1)
  })

  it('战斗类：突袭/撤退/基地夺取', () => {
    expect(OVERRUN_MP_COST).toBe(3)
    expect(RETREAT_DG_MIN_HEXES).toBe(2)
  })

  it('轰炸类：任务上限/最低值/无观察员', () => {
    expect(BARRAGE_MAX_AIRCRAFT_PER_MISSION).toBe(4)
    expect(BARRAGE_MIN_VALUE).toBe(1)
    expect(BARRAGE_NO_SPOTTER_SHIFT_LEFT).toBe(3)
    expect(BARRAGE_DENSITY_CAP_RE).toBe(3)
  })

  it('空军类：整备与射程', () => {
    expect(REFIT_T_PER_BASE).toBe(1)
    expect(REFIT_AIRCRAFT_PER_LEVEL).toBe(2)
    expect(PATROL_ZONE_MAX_HEXES).toBe(10)
    expect(FLAK_KILL_MIN_DICE).toBe(11)
  })

  it('建设类：工事与基地', () => {
    // 专规 1.3b：任何一方都不能把工事改进到 1 级以上（通规 16.0a 的刻度为 4）
    expect(HEDGEHOG_MAX_LEVEL).toBe(1)
    expect(HEDGEHOG_COST_SP_PER_LEVEL).toBe(2)
    expect(PRINTED_HEDGEHOG_LEVEL).toBe(1)
    expect(AIR_BASE_MAX_LEVEL).toBe(3)
    expect(AIR_BASE_COST_SP_PER_LEVEL).toBe(1)
    expect(AIRSTRIP_BUILD_T).toBe(1)
    expect(AIRSTRIP_UPGRADE_T).toBe(3)
  })

  it('专规类：空军盒射程/预备队/缓存', () => {
    expect(AXIS_AIR_BOX_RANGE_HEXES).toBe(30)
    expect(SOVIET_AIR_BOX_RANGE_HEXES).toBe(20)
    expect(FRONTAL_RESERVES_SP).toBe(2)
    expect(SUPPLY_CACHE_PER_SIDE).toBe(2)
  })

  it('专规时点：含 19 Aug 各机制开关', () => {
    expect(RAIL_CAP_BOOST_DATE).toBe('1941-07-19')
    expect(VARIABLE_EXIT_START).toBe('1941-08-19')
    expect(EARLY_DECISION_START).toBe('1941-08-19')
    expect(PANZER_GROUP_CONSTRAINT_END).toBe('1941-08-19')
  })

  it('天气：掷 1 骰，1 受限 / 2–6 正常（专规 1.5）', () => {
    expect(WEATHER_DICE_COUNT).toBe(1)
    expect(WEATHER_LIMITED_FLIGHT_MAX_DICE).toBe(1)
    expect(WEATHER_NORMAL_FLIGHT_MIN_DICE).toBe(2)
  })
})
