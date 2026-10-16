// Regras puras do agendamento (T64; 03-chats F50): janela de 31 dias e próxima ocorrência da recorrência no fuso
// da empresa (mesma hora local; +1 dia, +7 dias ou +1 mês com o dia limitado ao fim do mês).
import type { ScheduleRecurrence } from '@crm/db'
import { localParts, zonedTime } from '../mass-dispatch-runner/window'

export const SCHEDULE_MAX_DAYS = 31
export const SCHEDULE_MAX_MS = SCHEDULE_MAX_DAYS * 24 * 60 * 60 * 1000
export const SCHEDULES_QUEUE = 'schedules'

/** Job da fila `schedules`: o agendamento e o `run_at` que ele deve ter (um job antigo vira `stale`). */
export interface ScheduleJobData {
  scheduleId: string
  runAt: string
}

/** `jobId` determinístico (sem `:`, que o BullMQ recusa). */
export const scheduleJobId = (job: ScheduleJobData) => `schedule-${job.scheduleId}-${Date.parse(job.runAt)}`

/** `null` se o horário vale; senão o motivo (passado ou além de 31 dias). */
export function runAtProblem(runAt: Date, now: Date): 'past' | 'too_far' | null {
  if (runAt.getTime() <= now.getTime()) return 'past'
  if (runAt.getTime() - now.getTime() > SCHEDULE_MAX_MS) return 'too_far'
  return null
}

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()

/** Próxima ocorrência depois de `from` (uma vez); `null` para `one_off`. */
export function nextOccurrence(from: Date, recurrence: ScheduleRecurrence, timeZone: string): Date | null {
  if (recurrence === 'one_off') return null
  const p = localParts(from, timeZone)
  const subMinute = from.getTime() % 60_000
  let { year, month, day } = p
  if (recurrence === 'daily' || recurrence === 'weekly') {
    const d = new Date(Date.UTC(year, month - 1, day + (recurrence === 'daily' ? 1 : 7)))
    year = d.getUTCFullYear()
    month = d.getUTCMonth() + 1
    day = d.getUTCDate()
  } else {
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
    day = Math.min(day, daysInMonth(year, month))
  }
  return new Date(zonedTime(year, month, day, p.hour, p.minute, timeZone).getTime() + subMinute)
}

/** Próxima ocorrência estritamente depois de `now` (pula as que o atraso do worker já passou). */
export function nextOccurrenceAfter(from: Date, recurrence: ScheduleRecurrence, timeZone: string, now: Date): Date | null {
  let next = nextOccurrence(from, recurrence, timeZone)
  for (let i = 0; next && next.getTime() <= now.getTime() && i < 400; i++) next = nextOccurrence(next, recurrence, timeZone)
  return next
}
