import { z } from 'zod'

// Agente de IA: `activate` (Entregar ao agente) exige o agente; `deactivate` (Remover) não.
export const controlAiAgentConfig = z
  .object({
    mode: z.enum(['activate', 'deactivate']),
    agent_id: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.mode === 'activate' && !c.agent_id?.trim()) ctx.addIssue({ code: 'custom', message: 'agente obrigatório', path: ['agent_id'] })
  })
