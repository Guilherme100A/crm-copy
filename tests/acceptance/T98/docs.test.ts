// AC-T98-04: docs/extension/ai-manager.md existe e cita cada mudança aditiva (A1–A7) com o arquivo de destino no
// ai-manager. Os destinos esperados vêm do levantamento do brief (spec/briefs/T98.md). Também confere os demais
// entregáveis do guia (SPEC T98): variáveis, regra "um dono por socket", migração standalone → extensão.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const DOC = join(fileURLToPath(new URL('../../..', import.meta.url)), 'docs/extension/ai-manager.md')
const text = () => readFileSync(DOC, 'utf8')

/** Linha da tabela do patch que começa com o ID (`| **A1** | …`). */
function rowOf(id: string): string {
  const rows = text().split('\n').filter((l) => new RegExp(`^\\|\\s*\\**${id}\\**\\s*\\|`).test(l))
  expect(rows, `linha da tabela para ${id}`).toHaveLength(1)
  return rows[0]!
}

const DESTINATIONS: Record<string, string[]> = {
  A1: ['apps/worker/src/events/', 'apps/worker/src/boot/start.ts'],
  A2: ['packages/core/src/transport/types.ts', 'packages/core/src/transport/baileys.ts'],
  A3: ['apps/worker/src/boot/bridge-targets.ts', 'apps/worker/src/boot/internal-server.ts'],
  A4: ['packages/core/src/transport/baileys.ts'],
  A5: ['packages/core/src/transport/baileys.ts'],
  A6: ['apps/api/src/routes/index.ts'],
  A7: ['apps/worker/src/boot/bridge-targets.ts', 'apps/worker/src/boot/internal-server.ts', 'packages/core/src/contacts/service.ts'],
}

describe('AC-T98-04 guia de extensão docs/extension/ai-manager.md', () => {
  it('AC-T98-04 o arquivo existe e não altera o ai-manager (patch aditivo)', () => {
    expect(existsSync(DOC)).toBe(true)
    expect(text()).toMatch(/aditiv/i)
  })

  for (const [id, files] of Object.entries(DESTINATIONS)) {
    it(`AC-T98-04 ${id} citada com o arquivo de destino no ai-manager`, () => {
      const row = rowOf(id)
      for (const f of files) expect(row, `${id} sem ${f}`).toContain(f)
    })
  }

  it('AC-T98-04 variáveis do modo extensão e a diferença para o mapa', () => {
    const t = text()
    for (const v of ['WA_RPC_PROFILE=ai-manager', 'WA_GATEWAY=rpc', 'WA_RPC_URL', 'INTERNAL_TOKEN', 'DATABASE_URL']) expect(t).toContain(v)
  })

  it('AC-T98-04 regra "um dono por socket" e migração standalone → extensão sem novo QR', () => {
    const t = text()
    expect(t).toMatch(/um dono por socket/i)
    expect(t).toMatch(/standalone\s*→\s*extensão/i)
    expect(t).toContain('CREDENTIALS_KEY')
    for (const table of ['sessions', 'session_credentials', 'proxies', 'session_limits']) expect(t).toContain(table)
    expect(t).toMatch(/set: 'crm'/)
  })

  it('AC-T98-04 sem marca no guia', () => {
    expect(text()).not.toMatch(/leona/i)
  })
})
