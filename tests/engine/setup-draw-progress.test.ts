import { describe, expect, it } from 'vitest'
import { scenarioSetup } from '@/data'
import {
  axisDrawPool,
  deriveDrawComposition,
  planScenarioDraw,
  scenarioDrawBoxView,
  setupSourceOf,
} from '@/engine/rules'

describe('ch10/ch11：剧本抽取的初设来源与侦察营角色', () => {
  it.each([
    ['2', '1'],
    ['4', '3'],
    ['6', '5'],
  ])('剧本%s与初设源%s共用抽取池和名额', (id, source) => {
    expect(axisDrawPool(id!)).toEqual(axisDrawPool(source!))
    const box = scenarioDrawBoxView(id!)
    expect(box.pool.length).toBe(box.poolSize)
    expect(box.groups).toEqual(scenarioDrawBoxView(source!).groups)
  })

  it.each(['1', '2', '3', '4', '5', '6'])(
    '剧本%s：逐一核对池中每个编队的全部抽签角色，处置对象来自正确位置',
    (id) => {
      const box = scenarioDrawBoxView(id)
      const rows = scenarioSetup.entries.filter(
        (row) => row.scenarioId === setupSourceOf(id).source,
      )
      for (const group of box.groups) {
        if (group.kind === 'shiftWest') continue
        for (const member of box.pool) {
          const result = deriveDrawComposition({
            rows,
            formationId: member.formationId,
            aufkLocation: group.kind === 'deadPileAufk' ? 'hex' : 'dead_pile',
          })
          expect(result.ok).toBe(true)
          if (!result.ok) continue
          const facts = result.data
          const plan = planScenarioDraw({
            scenarioId: id,
            group: { ...group, count: 1 },
            drawnFormationIds: [member.formationId],
            facts: {
              [member.formationId]: {
                mtrRegimentUnitId: facts.mtrRegimentUnitId ?? undefined,
                aufkBattalionUnitId: facts.aufkBattalionUnitId ?? undefined,
                krdBattalionUnitId: facts.krdBattalionUnitId ?? undefined,
                combatUnitIds: facts.onMapUnitIds,
              },
            },
          })
          expect(plan.ok, `${id} ${group.kind} ${member.formationId}`).toBe(true)
          if (!plan.ok) continue
          for (const patch of plan.data.deposits) expect(facts.onMapUnitIds).toContain(patch.unitId)
          for (const patch of plan.data.returns)
            expect(facts.deadPileUnitIds).toContain(patch.unitId)
        }
      }
    },
  )
})
