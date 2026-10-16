// AC-T23-07 — `pnpm --filter @crm/web i18n:check -- --dir <tmp>` falha quando falta chave em en ou es (diretório temporário fora de apps/).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { exec, readJson, tail } from '../helpers/exec'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function locales(files: Record<'pt-BR' | 'en' | 'es', Record<string, unknown>>) {
  const dir = mkdtempSync(join(tmpdir(), 'crm-t23-i18n-'))
  dirs.push(dir)
  for (const [lang, content] of Object.entries(files)) {
    mkdirSync(join(dir, lang), { recursive: true })
    writeFileSync(join(dir, lang, 'probe.json'), JSON.stringify(content, null, 2))
  }
  return dir
}

/** Roda o script e garante que ele existe: sem o script, `pnpm --filter` sai com 0 sem rodar nada. */
function run(cmd: string) {
  expect(readJson('apps/web/package.json').scripts?.['i18n:check'], 'apps/web/package.json sem o script i18n:check').toBeTruthy()
  const r = exec(cmd, { timeoutMs: 180_000 })
  expect(r.output, tail(r)).not.toMatch(/None of the selected packages has a/i)
  return r
}
const check = (dir: string) => run(`pnpm --filter @crm/web i18n:check -- --dir "${dir}"`)

const PT = { title: 'Título', menu: { open: 'Abrir', close: 'Fechar' } }

describe('T23 — i18n:check', () => {
  it('AC-T23-07 i18n:check passa quando as três línguas têm as mesmas chaves', () => {
    const r = check(locales({ 'pt-BR': PT, en: { title: 'Title', menu: { open: 'Open', close: 'Close' } }, es: { title: 'Título', menu: { open: 'Abrir', close: 'Cerrar' } } }))
    expect(r.code, tail(r)).toBe(0)
  })

  it('AC-T23-07 i18n:check falha quando uma chave existe em pt-BR e falta em en', () => {
    const r = check(locales({ 'pt-BR': PT, en: { title: 'Title', menu: { open: 'Open' } }, es: { title: 'Título', menu: { open: 'Abrir', close: 'Cerrar' } } }))
    expect(r.code, tail(r)).not.toBe(0)
    expect(r.output).toMatch(/en[\\/]probe\.json/)
    expect(r.output).toContain('menu.close')
  })

  it('AC-T23-07 i18n:check falha quando uma chave existe em pt-BR e falta em es', () => {
    const r = check(locales({ 'pt-BR': PT, en: { title: 'Title', menu: { open: 'Open', close: 'Close' } }, es: { menu: { open: 'Abrir', close: 'Cerrar' } } }))
    expect(r.code, tail(r)).not.toBe(0)
    expect(r.output).toMatch(/es[\\/]probe\.json/)
    expect(r.output).toContain('title')
  })

  it('AC-T23-07 i18n:check do repositório (sem --dir) passa: o shell entrega as três línguas', () => {
    const r = run('pnpm --filter @crm/web i18n:check')
    expect(r.code, tail(r)).toBe(0)
  })
})
