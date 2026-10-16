import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
// @ts-expect-error script .mjs sem tipos
import { checkI18n, flattenKeys } from '../../scripts/i18n-check.mjs'
import { LOCALES, MESSAGES, translate } from './core'

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'i18n-check.mjs')

describe('i18n do shell (AC-T23-07)', () => {
  it('as três línguas têm as mesmas chaves e os textos mudam', () => {
    for (const l of LOCALES) expect(MESSAGES[l]?.shell).toBeTruthy()
    expect(checkI18n(join(import.meta.dirname))).toEqual([])
    expect(translate('pt-BR', 'nav.items.chats')).toBe('Chats ao vivo')
    expect(translate('en', 'nav.items.chats')).toBe('Live chats')
    expect(translate('es', 'shell:nav.items.chats')).toBe('Chats en vivo')
    expect(translate('en', 'login.subtitle', { appName: 'CRM' })).toBe('Access your CRM account')
    expect(translate('en', 'nao.existe')).toBe('nao.existe')
  })

  it('i18n:check acusa chave faltante em en/es (diretório temporário)', () => {
    const dir = mkdtempSync(join(tmpdir(), 't23-i18n-'))
    try {
      for (const l of ['pt-BR', 'en', 'es']) mkdirSync(join(dir, l))
      writeFileSync(join(dir, 'pt-BR', 'probe.json'), JSON.stringify({ menu: { open: 'Abrir', close: 'Fechar' } }))
      writeFileSync(join(dir, 'en', 'probe.json'), JSON.stringify({ menu: { open: 'Open' } }))
      writeFileSync(join(dir, 'es', 'probe.json'), JSON.stringify({ menu: { open: 'Abrir', close: 'Cerrar' } }))
      expect(checkI18n(dir)).toEqual(['en/probe.json: menu.close'])
      const run = spawnSync(process.execPath, [SCRIPT, '--dir', dir], { encoding: 'utf8' })
      expect(run.status).toBe(1)
      expect(run.stderr).toContain('en/probe.json: menu.close')
      writeFileSync(join(dir, 'en', 'probe.json'), JSON.stringify({ menu: { open: 'Open', close: 'Close' } }))
      expect(spawnSync(process.execPath, [SCRIPT, '--dir', dir]).status).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(flattenKeys({ a: { b: 1, c: { d: 2 } } })).toEqual(['a.b', 'a.c.d'])
  })
})
