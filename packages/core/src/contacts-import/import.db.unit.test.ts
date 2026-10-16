// Postgres real: job CSV (erros agrupados, upsert, etiquetas, Windows-1252, consentimento/opt-out) e WhatsApp.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { companies, connections, contactLabels, contacts, createDb, labels, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { FsExportFileStore } from '../exports/files'
import { runImportJob } from '../exports/runner'
import { ExportJobs, type JobActor } from '../exports/service'
import { ContactsImportService } from './service'

let tmp: TempDatabase
let db: Database
let dir: string
let files: FsExportFileStore
let wa: FakeWaGateway
let svc: ContactsImportService
let n = 0

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crm-t67-'))
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 4 })
  files = new FsExportFileStore({ dir })
  wa = new FakeWaGateway()
  svc = new ContactsImportService({ db, jobs: new ExportJobs({ db, files }), files, waGateway: wa })
}, 60_000)
afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
  rmSync(dir, { recursive: true, force: true })
}, 60_000)

async function actor(): Promise<JobActor> {
  n += 1
  const [c] = await db.insert(companies).values({ name: `C${n}`, slug: `c-t67-${n}-${Date.now()}` }).returning()
  const [u] = await db.insert(users).values({ email: `t67-${n}-${Date.now()}@x.test`, passwordHash: 'x', name: 'U' }).returning()
  return { companyId: c!.id, userId: u!.id, perms: new Set(['contacts.view', 'contacts.edit']) }
}

async function importCsv(a: JobActor, csv: Buffer | string, opts: { createMissingLabels?: boolean; defaultLabelIds?: string[] } = {}) {
  const job = await svc.createCsvImport(a, { data: typeof csv === 'string' ? Buffer.from(csv) : csv, ...opts })
  return (await runImportJob({ db, files }, job.id))!
}

const contactsOf = (companyId: string) => db.select().from(contacts).where(eq(contacts.companyId, companyId)).orderBy(contacts.phoneE164)
async function labelNames(contactId: string) {
  const rows = await db.select({ name: labels.name }).from(contactLabels).innerJoin(labels, eq(labels.id, contactLabels.labelId)).where(eq(contactLabels.contactId, contactId))
  return rows.map((r) => r.name).sort()
}

describe('CSV', () => {
  it('linha sem telefone válido vira erro agrupado; as outras entram com consentimento import', async () => {
    const a = await actor()
    wa.reset()
    const job = await importCsv(a, 'nome,telefone\nAna,11912345678\nBia,abc\nCaio,\nDani,+5521987654321\n')
    expect(job.status).toBe('completed')
    expect(job.counters).toMatchObject({ created: 2, updated: 0, errors: 2 })
    expect(job.counters.error_groups).toEqual([{ message: 'telefone inválido', count: 2, lines: [3, 4] }])
    expect(job.counters.errors_report).toEqual(['Linha 3: telefone inválido', 'Linha 4: telefone inválido'])
    const rows = await contactsOf(a.companyId)
    expect(rows.map((r) => [r.phoneE164, r.consent, r.consentSource, r.origin])).toEqual([
      ['+5511912345678', true, 'import', 'import'],
      ['+5521987654321', true, 'import', 'import'],
    ])
    expect(wa.consents.map((c) => [c.phone, c.source, c.actor])).toEqual([
      ['+5511912345678', 'import', `crm:${a.userId}`],
      ['+5521987654321', 'import', `crm:${a.userId}`],
    ])
  })

  it('reimportar atualiza em vez de duplicar', async () => {
    const a = await actor()
    await importCsv(a, 'nome;telefone\nAna;11912345678\n')
    const again = await importCsv(a, 'nome;telefone\nAna Souza;11912345678\n')
    expect(again.counters).toMatchObject({ created: 0, updated: 1 })
    const rows = await contactsOf(a.companyId)
    expect(rows.map((r) => r.name)).toEqual(['Ana Souza'])
  })

  it('etiquetas: cria só com a opção; as do CSV têm prioridade sobre as padrão', async () => {
    const a = await actor()
    const [def] = await db.insert(labels).values({ companyId: a.companyId, name: 'Padrão', color: '#000000' }).returning()
    const off = await importCsv(a, 'telefone,etiquetas\n11911111111,Nova\n11922222222,\n', { createMissingLabels: false, defaultLabelIds: [def!.id] })
    expect(off.counters.warnings_report).toEqual(['etiqueta não encontrada: Nova (1x)'])
    expect(await db.select().from(labels).where(and(eq(labels.companyId, a.companyId), eq(labels.name, 'Nova')))).toHaveLength(0)
    const on = await importCsv(a, 'telefone,etiquetas\n11933333333,Nova|padrão\n', { defaultLabelIds: [def!.id] })
    expect(on.counters.labels_created).toEqual(['Nova'])
    const rows = await contactsOf(a.companyId)
    expect(await labelNames(rows[0]!.id)).toEqual([]) // linha com etiqueta não encontrada: sem padrão
    expect(await labelNames(rows[1]!.id)).toEqual(['Padrão'])
    expect(await labelNames(rows[2]!.id)).toEqual(['Nova', 'Padrão'])
  })

  it('Windows-1252 com ; mantém os acentos', async () => {
    const a = await actor()
    await importCsv(a, Buffer.from('Nome;Telefone;Cidade\r\nJoão Conceição;11912345678;São Paulo\r\n', 'latin1'))
    const [row] = await contactsOf(a.companyId)
    expect([row!.name, row!.city]).toEqual(['João Conceição', 'São Paulo'])
  })

  it('opt_out verdadeiro importa com opt-out; falso não reverte opt-out existente', async () => {
    const a = await actor()
    wa.reset()
    const job = await importCsv(a, 'telefone,opt_out\n11912345678,sim\n11987654321,talvez\n')
    expect(job.counters.warnings_report).toEqual(['opt-out inválido: talvez (1x)'])
    let rows = await contactsOf(a.companyId)
    expect(rows.map((r) => [r.phoneE164, r.optOut, r.consent])).toEqual([
      ['+5511912345678', true, false],
      ['+5511987654321', false, true],
    ])
    expect(wa.optOuts.map((o) => [o.phone, o.reason])).toEqual([['+5511912345678', 'import']])
    expect(wa.consents.map((c) => c.phone)).toEqual(['+5511987654321'])
    await importCsv(a, 'telefone,opt_out\n11912345678,não\n')
    rows = await contactsOf(a.companyId)
    expect(rows[0]!.optOut).toBe(true)
  })

  it('sem coluna de telefone o job falha; modo e etiqueta padrão inválidos são recusados', async () => {
    const a = await actor()
    expect(await importCsv(a, 'nome\nAna\n')).toMatchObject({ status: 'failed', error: 'O arquivo não tem a coluna "telefone"' })
    await expect(svc.createCsvImport(a, { data: Buffer.from('telefone\n1'), mode: 'replace' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(svc.createCsvImport(a, { data: Buffer.from('telefone\n1'), defaultLabelIds: ['00000000-0000-0000-0000-000000000000'] })).rejects.toMatchObject({ code: 'invalid' })
  })
})

describe('WhatsApp', () => {
  it('exige conexão conectada e importa imported/updated/skipped, só-LID sem telefone', async () => {
    const a = await actor()
    const other = await actor()
    wa.reset()
    wa.addSession({ id: `s-off-${n}`, name: 'off', state: 'DISCONNECTED' })
    wa.addSession({ id: `s-on-${n}`, name: 'on', state: 'STABLE' })
    const [off] = await db.insert(connections).values({ companyId: a.companyId, sessionId: `s-off-${n}`, name: 'Off' }).returning()
    const [on] = await db.insert(connections).values({ companyId: a.companyId, sessionId: `s-on-${n}`, name: 'On' }).returning()
    await expect(svc.importFromWhatsApp(a, off!.id)).rejects.toMatchObject({ code: 'session_not_connected' })
    await expect(svc.importFromWhatsApp(other, on!.id)).rejects.toMatchObject({ code: 'not_found' })

    await importCsv(a, 'nome,telefone\nExistente,11912345678\n')
    wa.reset()
    wa.addSession({ id: `s-on-${n}`, name: 'on', state: 'STABLE' })
    wa.setContacts(`s-on-${n}`, [
      { jid: '5511912345678@s.whatsapp.net', phone: '+5511912345678', lid: null, name: null, pushName: 'Outro nome' },
      { jid: '5511955554444@s.whatsapp.net', phone: '+5511955554444', lid: null, name: 'Novo', pushName: null },
      { jid: '777777777@lid', phone: null, lid: '777777777@lid', name: null, pushName: 'Só LID' },
      { jid: '123@g.us', phone: null, lid: null, name: 'Grupo', pushName: null },
      { jid: 'x@s.whatsapp.net', phone: null, lid: null, name: null, pushName: null },
    ] as never)
    const res = await svc.importFromWhatsApp(a, on!.id)
    expect(res).toMatchObject({ imported: 2, updated: 1, skipped: 2 })
    const rows = await contactsOf(a.companyId)
    const lidOnly = rows.find((r) => r.waLid === '777777777@lid')!
    expect([lidOnly.phoneE164, lidOnly.name, lidOnly.consentSource]).toEqual([null, 'Só LID', 'import'])
    expect(rows.find((r) => r.phoneE164 === '+5511912345678')!.name).toBe('Existente')
    // Só quem tem telefone gera chamada ao gateway.
    expect(wa.consents.map((c) => c.phone).sort()).toEqual(['+5511912345678', '+5511955554444'])
  })
})
