// Relatório da importação (T67; 05 §3.6): erros por linha ("Linha N: erro") agrupados por mensagem com exemplos de
// linhas (até 8 grupos) e avisos agrupados ("{msg} ({n}x)").
export const MAX_ERROR_GROUPS = 8
export const MAX_GROUP_LINES = 10
export const MAX_ERROR_LINES = 200

export interface ErrorGroup {
  message: string
  count: number
  lines: number[]
}

export interface WarningGroup {
  message: string
  count: number
}

export interface ImportCounters {
  created: number
  updated: number
  skipped: number
  errors: number
  labels_created: string[]
  error_groups: ErrorGroup[]
  errors_report: string[]
  warning_groups: WarningGroup[]
  warnings_report: string[]
  [key: string]: unknown
}

export class ImportReport {
  created = 0
  updated = 0
  skipped = 0
  private errorCount = 0
  readonly labelsCreated: string[] = []
  private readonly errors = new Map<string, ErrorGroup>()
  private readonly errorLines: string[] = []
  private readonly warnings = new Map<string, number>()

  error(line: number, message: string): void {
    this.errorCount++
    const g = this.errors.get(message) ?? { message, count: 0, lines: [] }
    g.count++
    if (g.lines.length < MAX_GROUP_LINES) g.lines.push(line)
    this.errors.set(message, g)
    if (this.errorLines.length < MAX_ERROR_LINES) this.errorLines.push(`Linha ${line}: ${message}`)
  }

  warn(message: string): void {
    this.warnings.set(message, (this.warnings.get(message) ?? 0) + 1)
  }

  get errorTotal(): number {
    return this.errorCount
  }

  counters(): ImportCounters {
    const groups = [...this.errors.values()].sort((a, b) => b.count - a.count).slice(0, MAX_ERROR_GROUPS)
    const warnings = [...this.warnings.entries()].map(([message, count]) => ({ message, count })).sort((a, b) => b.count - a.count)
    return {
      created: this.created,
      updated: this.updated,
      skipped: this.skipped,
      errors: this.errorCount,
      labels_created: [...this.labelsCreated],
      error_groups: groups.map((g) => ({ ...g, lines: [...g.lines] })),
      errors_report: [...this.errorLines],
      warning_groups: warnings,
      warnings_report: warnings.map((w) => `${w.message} (${w.count}x)`),
    }
  }
}
