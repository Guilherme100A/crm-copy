// Janela de envio dos disparos (T74; 10 §3.1): dias da semana (0 = domingo) e horário `HH:MM`–`HH:MM` no fuso do
// disparo. Funções puras sobre `Intl` (sem lib de datas): hora local de um instante e instante de uma hora local.

export interface SendWindow {
  weekdays: readonly number[]
  windowStart: string
  windowEnd: string
  timeZone: string
}

interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: number
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    })
    formatters.set(timeZone, f)
  }
  return f
}

/** Data/hora local do instante no fuso. */
export function localParts(at: Date, timeZone: string): LocalParts {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(at).map((p) => [p.type, p.value]))
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY[parts.weekday!] ?? 0,
  }
}

/** Instante UTC da hora local (`y-m-d h:mi`) no fuso (ajusta o deslocamento duas vezes, por causa do horário de verão). */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const wanted = Date.UTC(year, month - 1, day, hour, minute)
  let guess = wanted
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess), timeZone)
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
    guess += wanted - seen
  }
  return new Date(guess)
}

const hm = (s: string) => {
  const [h, m] = s.split(':').map(Number)
  return { h: h!, m: m! }
}

/** Meia-noite local do dia do instante. */
export function zonedDayStart(at: Date, timeZone: string): Date {
  const p = localParts(at, timeZone)
  return zonedTime(p.year, p.month, p.day, 0, 0, timeZone)
}

/** O instante está num dia permitido e dentro de `[início, fim)` da janela? */
export function isWithinWindow(at: Date, w: SendWindow): boolean {
  const p = localParts(at, w.timeZone)
  if (!w.weekdays.includes(p.weekday)) return false
  const minutes = p.hour * 60 + p.minute
  const s = hm(w.windowStart)
  const e = hm(w.windowEnd)
  return minutes >= s.h * 60 + s.m && minutes < e.h * 60 + e.m
}

/** Início da janela de um dia local (deslocado `offsetDays` a partir do dia do instante). */
function windowStartOn(at: Date, offsetDays: number, w: SendWindow): { start: Date; weekday: number } {
  const p = localParts(at, w.timeZone)
  const s = hm(w.windowStart)
  // Meio-dia evita cair em outro dia por causa do horário de verão ao somar dias.
  const noon = zonedTime(p.year, p.month, p.day, 12, 0, w.timeZone)
  const target = new Date(noon.getTime() + offsetDays * 86_400_000)
  const q = localParts(target, w.timeZone)
  return { start: zonedTime(q.year, q.month, q.day, s.h, s.m, w.timeZone), weekday: q.weekday }
}

/** O próprio instante, se estiver na janela; senão o próximo início de janela num dia permitido. */
export function nextAllowedTime(at: Date, w: SendWindow): Date {
  if (isWithinWindow(at, w)) return at
  for (let offset = 0; offset <= 7; offset++) {
    const { start, weekday } = windowStartOn(at, offset, w)
    if (w.weekdays.includes(weekday) && start.getTime() > at.getTime()) return start
  }
  // Sem dia permitido (não acontece: a T60 exige ≥ 1 dia): uma semana depois.
  return new Date(at.getTime() + 7 * 86_400_000)
}

/** Início da janela do PRÓXIMO dia permitido (depois do dia local do instante): retomada do limite diário. */
export function nextDayWindowStart(at: Date, w: SendWindow): Date {
  for (let offset = 1; offset <= 8; offset++) {
    const { start, weekday } = windowStartOn(at, offset, w)
    if (w.weekdays.includes(weekday)) return start
  }
  return new Date(at.getTime() + 7 * 86_400_000)
}
