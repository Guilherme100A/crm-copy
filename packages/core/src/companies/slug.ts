// Slug da empresa a partir do nome (01 §3.2): minúsculas, sem acento, espaços → hífen, hífens colapsados.
export const SLUG_MAX = 63

export function slugify(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '')
  return base.length >= 2 ? base : `empresa${base ? `-${base}` : ''}`
}

/** `base`, `base-2`, `base-3`… respeitando o tamanho máximo. */
export function slugCandidate(base: string, n: number): string {
  if (n <= 1) return base
  const suffix = `-${n}`
  return `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/g, '')}${suffix}`
}
