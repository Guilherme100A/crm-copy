// T128: hash das migrações e nome do banco-modelo (sem banco).
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MIGRATION_SETS } from '../client'
import { migrationsHash, templateDatabaseName, templatesEnabled } from './template'

const scriptUrl = new URL('../../../../scripts/e2e/template-db.mjs', import.meta.url).href
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** Cópia da pasta `crm` num diretório temporário. */
function copyCrm(): string {
  const dir = mkdtempSync(join(tmpdir(), 't128-crm-'))
  dirs.push(dir)
  cpSync(MIGRATION_SETS.crm.folder, dir, { recursive: true })
  return dir
}
const lastSql = (dir: string) =>
  join(
    dir,
    readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .at(-1)!,
  )

describe('templateDatabaseName', () => {
  it('crm_tpl_<set>_<12 hex>, um por conjunto; estável entre chamadas', () => {
    for (const set of ['all', 'wa', 'crm'] as const) {
      expect(templateDatabaseName(set)).toMatch(new RegExp(`^crm_tpl_${set}_[0-9a-f]{12}$`))
      expect(templateDatabaseName(set)).toBe(templateDatabaseName(set))
    }
    expect(new Set(['all', 'wa', 'crm'].map((s) => templateDatabaseName(s as 'all')))).toHaveProperty('size', 3)
    expect(migrationsHash('all')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('mudar o conteúdo de uma migração ou o journal muda o hash; CRLF × LF não muda', () => {
    const base = templateDatabaseName('all')
    const same = copyCrm()
    expect(templateDatabaseName('all', { crm: same })).toBe(base)

    const crlf = copyCrm()
    const f = lastSql(crlf)
    writeFileSync(f, readFileSync(f, 'utf8').replace(/\r?\n/g, '\r\n'))
    expect(templateDatabaseName('all', { crm: crlf })).toBe(base)

    const changed = copyCrm()
    writeFileSync(lastSql(changed), `${readFileSync(lastSql(changed), 'utf8')}\n-- t128\n`)
    expect(templateDatabaseName('all', { crm: changed })).not.toBe(base)
    expect(templateDatabaseName('crm', { crm: changed })).not.toBe(templateDatabaseName('crm'))
    // o conjunto `wa` não cobre a pasta `crm`
    expect(templateDatabaseName('wa', { crm: changed })).toBe(templateDatabaseName('wa'))

    const journal = copyCrm()
    const j = join(journal, 'meta', '_journal.json')
    writeFileSync(j, readFileSync(j, 'utf8').replace('"version": "7"', '"version":  "7"'))
    expect(templateDatabaseName('all', { crm: journal })).not.toBe(base)
  })

  it('a cópia em JS (scripts/e2e/template-db.mjs) calcula os mesmos nomes', async () => {
    const js = (await import(scriptUrl)) as {
      templateDatabaseName(set: string, folders?: Record<string, string>): string
      currentTemplateNames(): string[]
      migrationFolders(): Record<string, string>
    }
    expect(js.currentTemplateNames()).toEqual(['all', 'wa', 'crm'].map((s) => templateDatabaseName(s as 'all')))
    const changed = copyCrm()
    writeFileSync(lastSql(changed), `${readFileSync(lastSql(changed), 'utf8')}\n-- t128 js\n`)
    const folders = { ...js.migrationFolders(), crm: changed }
    expect(js.templateDatabaseName('all', folders)).toBe(templateDatabaseName('all', { crm: changed }))
  })

  it('CRM_TEST_TEMPLATE=0 desliga o modelo', () => {
    expect(templatesEnabled({})).toBe(true)
    expect(templatesEnabled({ CRM_TEST_TEMPLATE: '1' })).toBe(true)
    expect(templatesEnabled({ CRM_TEST_TEMPLATE: '0' })).toBe(false)
  })
})
