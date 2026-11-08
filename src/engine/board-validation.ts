import { z } from 'zod'
import { SetupDrawSnapshotSchema } from './setup-draw-snapshot'

const amount = z.number().finite().nonnegative()
const hex = z.object({ col: z.number().int().nonnegative(), row: z.number().int().nonnegative() })
const entity = z.object({ instanceId: z.string().min(1), side: z.enum(['axis', 'soviet']), hex })
const ground = entity
  .extend({
    unitId: z.string().min(1),
    name: z.string(),
    steps: amount,
    re: amount,
    isCombat: z.boolean(),
    attackCapable: z.boolean(),
    raw: z
      .object({ attack: amount, ar: z.number().finite(), ma: amount, mobility: z.string() })
      .passthrough(),
    mode: z
      .object({ mode: z.string(), orientation: z.string(), dg: z.boolean(), exploit: z.boolean() })
      .passthrough(),
    fuelled: z.boolean(),
    airTransportThisPhase: z
      .object({
        kind: z.enum(['air_transport', 'air_drop']),
        phase: z.enum(['movement', 'reaction', 'exploitation']),
        releasedFromReserve: z.boolean(),
      })
      .nullable()
      .optional(),
    hasTraceSupply: z.boolean(),
    specialized: z.array(z.string()),
  })
  .passthrough()
const air = entity
  .extend({
    aircraftId: z.string().min(1),
    name: z.string(),
    steps: amount,
    airStatus: z.enum(['active', 'inactive']),
    aircraftType: z.string(),
    missionsFlownThisPhase: amount,
  })
  .passthrough()
const entities = z
  .object({
    units: z.array(ground),
    edgeBoxHoldings: z
      .object({ northeast: z.array(ground), southeast: z.array(ground) })
      .optional(),
    edgeBoxEnteredOn: z.record(z.number().int().positive()).optional(),
    airUnits: z.array(air),
    deadPile: z.array(z.union([ground, air])),
    spDumps: z.array(
      z
        .object({
          id: z.string().min(1),
          side: z.enum(['axis', 'soviet']),
          hex,
          sp: amount,
          t: amount,
        })
        .passthrough(),
    ),
  })
  .passthrough()

/** 存档不是可信输入：在触碰运行中对局前校验实体形态、数值与实例唯一性。 */
export function validBoardEntities(fields: Record<string, unknown>): boolean {
  const result = entities.safeParse(fields)
  if (!result.success) return false
  const held = [
    ...(result.data.edgeBoxHoldings?.northeast ?? []),
    ...(result.data.edgeBoxHoldings?.southeast ?? []),
  ]
  if (held.some((unit) => unit.side !== 'soviet')) return false
  const heldIds = new Set(held.map((unit) => unit.instanceId))
  if (Object.keys(result.data.edgeBoxEnteredOn ?? {}).some((id) => !heldIds.has(id))) return false
  const ids = [...result.data.units, ...result.data.airUnits, ...result.data.deadPile, ...held].map(
    (e) => e.instanceId,
  )
  if (new Set(ids).size !== ids.length) return false
  const dumpIds = result.data.spDumps.map((d) => d.id)
  return new Set(dumpIds).size === dumpIds.length
}

export const SetupSnapshotSchema = z.object({
  applied: z.boolean(),
  finished: z.boolean(),
  completed: z.record(z.boolean()),
  selfChoices: z.record(z.string()),
  truckFullIds: z.array(z.string()),
  spAssignments: z.record(z.enum(['hoth', 'guderian'])),
  spDumps: z.array(
    z
      .object({
        id: z.string(),
        points: z.number().nonnegative(),
        side: z.enum(['axis', 'soviet']),
        hex: z.object({ col: z.number().int(), row: z.number().int() }),
      })
      .passthrough(),
  ),
  airChoices: z.record(z.string()),
  placedSelfInstances: z.record(z.number().nonnegative()),
  placedAirInstances: z.record(z.number().nonnegative()),
  setupSideCursor: z.enum(['axis', 'soviet']).nullable(),
  setupSideConfirmed: z.record(z.boolean()),
  // 旧档缺省时保留“历史未记录”，由恢复层清空旧内存，不重新抽取。
  drawState: SetupDrawSnapshotSchema.optional(),
  notes: z.array(z.string()).default([]),
  defaultFilledIds: z.array(z.string()).default([]),
})
