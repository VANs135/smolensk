import { z } from 'zod'

/** ch10/ch11：初设抽取记录须与盘面一起保存，读档不重新掷签补齐历史。 */
export const SetupDrawSnapshotSchema = z
  .object({
    scenarioId: z.string().min(1),
    drawResults: z.record(
      z.array(
        z.object({
          kind: z.string(),
          formationIds: z.array(z.string().min(1)),
          detail: z.string(),
        }),
      ),
    ),
    shiftHexes: z.record(z.string()),
    outcomes: z.array(
      z.object({
        groupKind: z.string(),
        groupLabel: z.string(),
        formationIds: z.array(z.string().min(1)),
        detail: z.string(),
        destinations: z.array(z.object({ formationId: z.string(), hexText: z.string() })),
      }),
    ),
  })
  .refine(
    (snapshot) => Object.keys(snapshot.drawResults).every((id) => id === snapshot.scenarioId),
    {
      message: '初设抽取记录混入其它剧本',
    },
  )

export type SetupDrawSnapshot = z.infer<typeof SetupDrawSnapshotSchema>
