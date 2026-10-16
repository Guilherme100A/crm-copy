import { z } from 'zod'
import { MAX_WAIT_SECONDS, toSeconds } from './common'
import { WEEKDAYS } from './evaluate_condition'

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const day = z.object({ enabled: z.boolean(), start_time: z.string().regex(HHMM), end_time: z.string().regex(HHMM) })

// Intervalo Inteligente: por tempo, data marcada ou faixas semanais (06 §3.6).
// "Data não pode estar no passado" depende do relógio e é conferida na execução, não aqui.
export const smartIntervalConfig = z
  .object({
    schedule_type: z.enum(['time', 'date', 'weekly']),
    interval_value: z.number().int().positive().optional(),
    interval_unit: z.enum(['minutes', 'hours', 'days']).optional(),
    scheduled_date: z.string().optional(),
    weekly_schedule: z.partialRecord(z.enum(WEEKDAYS), day).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.schedule_type === 'time') {
      if (c.interval_value === undefined) ctx.addIssue({ code: 'custom', message: 'intervalo obrigatório', path: ['interval_value'] })
      else if (toSeconds(c.interval_value, c.interval_unit ?? 'minutes') > MAX_WAIT_SECONDS)
        ctx.addIssue({ code: 'custom', message: 'prazo máximo é 31 dias', path: ['interval_value'] })
    }
    if (c.schedule_type === 'date' && !c.scheduled_date?.trim()) ctx.addIssue({ code: 'custom', message: 'data obrigatória', path: ['scheduled_date'] })
    if (c.schedule_type === 'weekly') {
      const days = Object.entries(c.weekly_schedule ?? {})
      if (!days.some(([, d]) => d?.enabled)) ctx.addIssue({ code: 'custom', message: 'ative ao menos um dia', path: ['weekly_schedule'] })
      for (const [name, d] of days) {
        if (d?.enabled && d.end_time <= d.start_time) ctx.addIssue({ code: 'custom', message: 'fim deve ser depois do início', path: ['weekly_schedule', name] })
      }
    }
  })
