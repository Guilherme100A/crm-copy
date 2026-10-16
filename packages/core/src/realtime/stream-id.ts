// Ids de Redis Stream (`<ms>-<seq>`), usados também como `id:` do SSE e `Last-Event-ID`.

const STREAM_ID_RE = /^(\d{1,16})-(\d{1,16})$/

export function isStreamId(value: string | null | undefined): value is string {
  return !!value && STREAM_ID_RE.test(value)
}

/** Compara dois ids de stream (negativo se `a < b`). Ids de streams diferentes do mesmo Redis seguem o relógio. */
export function compareStreamIds(a: string, b: string): number {
  const [am = 0, as = 0] = a.split('-').map(Number)
  const [bm = 0, bs = 0] = b.split('-').map(Number)
  return am - bm || as - bs
}
