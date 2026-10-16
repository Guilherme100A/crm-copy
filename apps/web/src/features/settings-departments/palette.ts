// Cores de departamento (16 §3.2): paleta de 10 cores; fora dela a cor aparece como "personalizada".

/** Padrão do servidor (`DEFAULT_DEPARTMENT_COLOR`). */
export const DEFAULT_DEPARTMENT_COLOR = '#3B82F6'

/** Limite do servidor (`DEPARTMENT_NAME_MAX`). */
export const DEPARTMENT_NAME_MAX = 60

export const DEPARTMENT_PALETTE = [
  { id: 'blue', hex: '#3B82F6' },
  { id: 'red', hex: '#EF4444' },
  { id: 'green', hex: '#10B981' },
  { id: 'amber', hex: '#F59E0B' },
  { id: 'purple', hex: '#8B5CF6' },
  { id: 'orange', hex: '#F97316' },
  { id: 'cyan', hex: '#06B6D4' },
  { id: 'lime', hex: '#84CC16' },
  { id: 'pink', hex: '#EC4899' },
  { id: 'gray', hex: '#6B7280' },
] as const

/** `#rgb`/`rgb`/`#rrggbb` → `#RRGGBB`; `null` se não for uma cor hex. */
export function normalizeHex(v: string): string | null {
  let s = v.trim().replace(/^#/, '')
  if (/^[0-9a-f]{3}$/i.test(s)) s = s.replace(/./g, (c) => c + c)
  return /^[0-9a-f]{6}$/i.test(s) ? `#${s.toUpperCase()}` : null
}

/** Id da cor na paleta (`blue`…), ou `null` para cor personalizada. */
export function paletteId(color: string): string | null {
  const hex = normalizeHex(color)
  return DEPARTMENT_PALETTE.find((p) => p.hex === hex)?.id ?? null
}

export type DepartmentFormError = 'nameRequired' | 'nameTooLong' | 'colorInvalid'

export function departmentFormErrors(name: string, color: string): DepartmentFormError[] {
  const errors: DepartmentFormError[] = []
  const n = name.trim()
  if (!n) errors.push('nameRequired')
  else if (n.length > DEPARTMENT_NAME_MAX) errors.push('nameTooLong')
  if (!normalizeHex(color)) errors.push('colorInvalid')
  return errors
}
