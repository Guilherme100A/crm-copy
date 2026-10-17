// Search params das sub-rotas do Facebook (contrato com o Tester). Prefixo `fb_` porque os search params do TanStack
// são um tipo unido entre rotas (`?status=` já é do `/chats`; docs/licoes.md).
import { z } from 'zod'
import { PERIODS } from './rules'

export const campaignsSearchSchema = z.object({
  fb_level: z.enum(['campaign', 'adset', 'ad']).optional().catch(undefined),
  /** `active` (padrão) | `all` | código de status da Meta (ex.: `PAUSED`). */
  fb_status: z.string().max(40).optional().catch(undefined),
  fb_q: z.string().max(200).optional().catch(undefined),
  fb_period: z.enum(PERIODS).optional().catch(undefined),
  fb_since: z.string().max(10).optional().catch(undefined),
  fb_until: z.string().max(10).optional().catch(undefined),
})

/** Retorno do callback OAuth (T99): `?meta_oauth=success|error&meta_message=`. */
export const profilesSearchSchema = z.object({
  meta_oauth: z.string().max(20).optional().catch(undefined),
  meta_message: z.string().max(500).optional().catch(undefined),
})
