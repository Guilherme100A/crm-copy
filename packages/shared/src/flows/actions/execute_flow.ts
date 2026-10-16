import { z } from 'zod'
import { requiredText } from './common'

// Conexão de Fluxo: encerra este fluxo e inicia o destino.
export const executeFlowConfig = z.object({
  target_flow_id: requiredText,
  target_flow_name: z.string().optional(),
})
