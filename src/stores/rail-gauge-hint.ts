import { railConversionLimit } from '@/engine/rules'
import type { ConsolePhase, ConsoleUnit, MapHint } from './workbench-model'

/**
 * 13.3g-D：选中铁路修理单位时的换轨额度提示
 *
 * 只在移动阶段生效；上限与引擎判定共用 `railConversionLimit`（`min(4, 当前 MA)`），
 * 不在界面另写一份 4/MA 口径。额度用完给 warning，仍有额度给 info；
 * 两者都走地图左下角同一个提示槽位（`mapHint`）。
 */
export function railGaugeHintOf(
  phase: ConsolePhase,
  unit: ConsoleUnit | null,
  conversions: readonly { instanceId: string; count: number }[],
): MapHint | null {
  if (phase !== 'movement' || unit === null || !unit.specialized.includes('rail_repair')) {
    return null
  }
  const used = conversions.find((item) => item.instanceId === unit.instanceId)?.count ?? 0
  const limit = railConversionLimit(unit.raw.ma)
  if (limit <= 0) return null
  return {
    text: `换轨额度 ${used}/${limit} 格`,
    rule: '13.3g',
    tone: used >= limit ? 'warning' : 'info',
  }
}
