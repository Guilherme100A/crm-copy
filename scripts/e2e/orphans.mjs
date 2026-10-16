// Limpeza de bancos de teste órfãos (T124): execuções mortas (harness, vitest, aceitação) deixavam `crm_e2e_*`,
// `crm_test_*` e `crm_acc_*` no Postgres compartilhado até ele cair por memória. Só esses prefixos são candidatos,
// e só caem os SEM conexão ativa, mais antigos que N minutos e fora da lista protegida (bancos de harnesses vivos).
// O DROP é simples (sem FORCE): se alguém conectar no meio, falha e o banco fica.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const pg = createRequire(join(ROOT, 'packages', 'db', 'package.json'))('pg')

export const ORPHAN_PREFIXES = ['crm_e2e_', 'crm_test_', 'crm_acc_']
export const DEFAULT_ORPHAN_MIN_AGE_MIN = 30

/** Banco de teste do projeto (nunca `crm`, `postgres`, `template*`, `wsm*` ou outro nome). */
export function isOrphanCandidate(name) {
  return typeof name === 'string' && /^[a-z0-9_]+$/.test(name) && ORPHAN_PREFIXES.some((p) => name.startsWith(p) && name.length > p.length)
}

/** Idade mínima em ms a partir do env (`E2E_ORPHAN_MIN_AGE_MIN`, padrão 30; aceita 0). */
export function orphanMinAgeMs(env = process.env) {
  const raw = env.E2E_ORPHAN_MIN_AGE_MIN
  const n = raw === undefined || String(raw).trim() === '' ? DEFAULT_ORPHAN_MIN_AGE_MIN : Number(raw)
  if (!Number.isFinite(n) || n < 0) throw new Error(`E2E_ORPHAN_MIN_AGE_MIN inválido: ${raw}`)
  return Math.round(n * 60_000)
}

const quoteIdent = (name) => `"${name.replace(/"/g, '""')}"`

/**
 * Apaga os bancos de teste órfãos. `protect`: nomes que nunca caem (harnesses vivos). Devolve os apagados e os mantidos
 * (com o motivo). Bancos fora dos prefixos de teste não aparecem. `match` restringe ainda mais os candidatos (testes).
 */
export async function cleanupOrphanDatabases({ baseUrl, minAgeMs = DEFAULT_ORPHAN_MIN_AGE_MIN * 60_000, now = new Date(), protect = [], dryRun = false, match = null } = {}) {
  if (!baseUrl) throw new Error('baseUrl obrigatório')
  const keepSet = new Set(protect)
  const c = new pg.Client({ connectionString: baseUrl })
  await c.connect()
  const dropped = []
  const kept = []
  try {
    const { rows } = await c.query(
      `select d.datname as name,
              (select count(*)::int from pg_stat_activity a where a.datname = d.datname) as connections
       from pg_database d
       where not d.datistemplate and (${ORPHAN_PREFIXES.map((_, i) => `d.datname like $${i + 1}`).join(' or ')})
       order by d.datname`,
      ORPHAN_PREFIXES.map((p) => `${p.replace(/_/g, '\\_')}%`),
    )
    for (const row of rows) {
      const name = row.name
      if (!isOrphanCandidate(name)) continue
      if (match && !match.test(name)) continue
      if (keepSet.has(name)) {
        kept.push({ name, reason: 'protected' })
        continue
      }
      if (row.connections > 0) {
        kept.push({ name, reason: 'active' })
        continue
      }
      let createdAt = null
      try {
        const r = await c.query(`select (pg_stat_file('base/' || oid || '/PG_VERSION')).modification as at from pg_database where datname = $1`, [name])
        createdAt = r.rows[0]?.at ? new Date(r.rows[0].at) : null
      } catch {
        createdAt = null
      }
      if (!createdAt || Number.isNaN(createdAt.getTime())) {
        kept.push({ name, reason: 'age_unknown' })
        continue
      }
      if (now.getTime() - createdAt.getTime() < minAgeMs) {
        kept.push({ name, reason: 'recent' })
        continue
      }
      if (dryRun) {
        dropped.push(name)
        continue
      }
      try {
        await c.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`)
        dropped.push(name)
      } catch {
        // Alguém conectou depois da checagem: fica.
        kept.push({ name, reason: 'in_use' })
      }
    }
  } finally {
    await c.end()
  }
  return { dropped, kept }
}
