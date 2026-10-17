// AC-T98-04: o guia de extensão existe e cita cada mudança aditiva (A1–A7, mais a A8 desta tarefa) com o arquivo de
// destino no ai-manager, as variáveis reais e a regra "um dono por socket".
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AI_MANAGER_ADDITIVE_ROUTES } from './profile'

const DOC = fileURLToPath(new URL('../../../../../docs/extension/ai-manager.md', import.meta.url))
const doc = existsSync(DOC) ? readFileSync(DOC, 'utf8') : ''

/** Linha da tabela do patch para a mudança `id`. */
const rowOf = (id: string) => doc.split(/\r?\n/).find((line) => line.startsWith(`| **${id}**`))

describe('docs/extension/ai-manager.md', () => {
  it('AC-T98-04: existe e cita A1–A7 (e A8), cada uma com arquivo de destino no ai-manager', () => {
    expect(existsSync(DOC)).toBe(true)
    for (const id of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8']) {
      const row = rowOf(id)
      expect(row, `linha da ${id}`).toBeDefined()
      expect(row, `arquivo de destino da ${id}`).toMatch(/`(apps|packages)\/[\w./-]+`/)
    }
    expect(rowOf('A1')).toContain('apps/worker/src/events/')
    expect(rowOf('A1')).toContain('apps/worker/src/boot/start.ts')
    expect(rowOf('A3')).toContain('apps/worker/src/boot/internal-server.ts')
    expect(rowOf('A7')).toContain('apps/worker/src/boot/bridge-targets.ts')
    expect(rowOf('A7')).toContain('apps/worker/src/boot/internal-server.ts')
    expect(rowOf('A6')).toContain('apps/api/src/routes/index.ts')
  })

  it('AC-T98-04: cada alvo RPC aditivo do perfil aparece no guia com a mudança de que depende', () => {
    for (const { rpc, change } of Object.values(AI_MANAGER_ADDITIVE_ROUTES)) {
      expect(doc).toContain(`\`${rpc}\``)
      expect(rowOf(change)).toContain(rpc)
    }
  })

  it('AC-T98-04: variáveis reais, só o conjunto crm, migração sem novo QR e um dono por socket', () => {
    for (const v of [
      'WA_GATEWAY=rpc',
      'WA_RPC_PROFILE=ai-manager',
      'WA_RPC_URL',
      'INTERNAL_TOKEN',
      'DATABASE_URL',
      'CREDENTIALS_KEY',
    ])
      expect(doc).toContain(v)
    expect(doc).toContain("set: 'crm'")
    for (const t of ['sessions', 'session_credentials', 'proxies', 'session_limits']) expect(doc).toContain(`\`${t}\``)
    expect(doc.toLowerCase()).toContain('um dono por socket')
    expect(doc).toContain('sessions.setProxy')
    // Marca neutra (F-NO-BRAND): o nome do produto de referência não aparece no guia.
    expect(doc.toLowerCase()).not.toContain(['le', 'ona'].join(''))
  })
})
