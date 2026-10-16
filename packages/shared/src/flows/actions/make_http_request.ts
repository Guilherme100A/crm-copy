import { z } from 'zod'
import { requiredText } from './common'

// Integração HTTP: URL e corpo aceitam variáveis; mapeamento campo → caminho com ponto (`data.status`).
export const makeHttpRequestConfig = z.object({
  request_method: z.enum(['POST', 'PUT', 'GET']),
  request_url: requiredText,
  request_headers: z.record(z.string(), z.string()).optional(),
  request_body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  response_fields: z.array(z.string()).optional(),
  response_mapping: z.record(z.string(), z.string()).optional(),
})
