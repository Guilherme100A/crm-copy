import { z } from 'zod'
import { checkUniqueIds, handleId } from './common'

// Distribuidor: ≥ 2 saídas, cada uma vira o handle `output:<id>`.
export const distributeContactsConfig = z
  .object({
    outputs: z
      .array(
        z.object({
          id: handleId,
          name: z.string().optional(),
          quantity: z.number().int().min(0).optional(),
        }),
      )
      .min(2),
    distribute_always_next: z.boolean().optional(),
    prevent_repetition: z.boolean().optional(),
  })
  .superRefine((c, ctx) => checkUniqueIds(ctx, c.outputs, 'outputs'))
