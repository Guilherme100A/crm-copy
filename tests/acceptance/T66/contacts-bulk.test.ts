// AC-T66-01..04: filtros avançados da lista de contatos, skip_total, exportação all_except e exclusão em massa por lotes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { envelopeOf } from '../helpers/sse'
import {
  addCard,
  configureBulk,
  downloadCsv,
  labelChat,
  labelContact,
  listIds,
  mobile,
  newBoard,
  newChat,
  newContact,
  newLabel,
  newMember,
  newOwner,
  openEvents,
  parseCsv,
  postManifestFile,
  sleep,
  startEnv,
  type Env,
  type User,
} from './setup'

let env: Env
beforeAll(async () => {
  env = await startEnv()
})
afterAll(async () => {
  await env?.close()
})

const sorted = (xs: string[]) => [...xs].sort()

describe('AC-T66-01 filtros avançados', () => {
  it('AC-T66-01 busca ignora termo só numérico com menos de 4 dígitos; com 4+ casa o telefone; texto casa nome/e-mail', async () => {
    const o = await newOwner(env)
    const ana = await newContact(env, o.companyId, { name: 'Ana Lima', phone: '+5511987651234', email: 'ana@example.test' })
    const bruno = await newContact(env, o.companyId, { name: 'Bruno Costa', phone: '+5521976540000' })
    const prod = await newContact(env, o.companyId, { name: 'Lote 12a', phone: '+5531965430000' })
    const all = sorted([ana, bruno, prod])
    for (const term of ['12', '1 2', '(12)', '+1', '123']) expect(await listIds(o, `search=${encodeURIComponent(term)}`), `termo ${term}`).toEqual(all)
    expect(await listIds(o, 'search=1234')).toEqual([ana])
    expect(await listIds(o, `search=${encodeURIComponent('8765-1234')}`)).toEqual([ana])
    expect(await listIds(o, 'search=12a')).toEqual([prod])
    expect(await listIds(o, 'search=COSTA')).toEqual([bruno])
    expect(await listIds(o, 'search=ana%40example')).toEqual([ana])
  })

  it('AC-T66-01 etiqueta no contato OU num chat dele; várias etiquetas = qualquer uma', async () => {
    const o = await newOwner(env)
    const [L1, L2] = [await newLabel(env, o.companyId), await newLabel(env, o.companyId)]
    const onContact = await newContact(env, o.companyId, { name: 'No contato' })
    await labelContact(env, o.companyId, onContact, L1)
    const onChat = await newContact(env, o.companyId, { name: 'No chat' })
    await labelChat(env, o.companyId, await newChat(env, o.companyId, onChat), L1)
    const other = await newContact(env, o.companyId, { name: 'Outra etiqueta' })
    await labelContact(env, o.companyId, other, L2)
    const none = await newContact(env, o.companyId, { name: 'Sem etiqueta' })
    await newChat(env, o.companyId, none)

    expect(await listIds(o, `label_ids=${L1}`)).toEqual(sorted([onContact, onChat]))
    expect(await listIds(o, `label_ids[]=${L1}&label_ids[]=${L2}`)).toEqual(sorted([onContact, onChat, other]))
    expect(await listIds(o, `label_ids=${L1},${L2}`)).toEqual(sorted([onContact, onChat, other]))
    // contato com a etiqueta no contato e no chat não duplica
    await labelChat(env, o.companyId, await newChat(env, o.companyId, onContact), L1)
    const page = await o.c.get(`/api/contacts?label_ids=${L1}&limit=50`)
    expect(page.body.items.map((x: any) => x.id).sort()).toEqual(sorted([onContact, onChat]))
    expect(page.body.page.total_count).toBe(2)
  })

  it('AC-T66-01 filtro por etapa do kanban (card de algum chat do contato nas colunas)', async () => {
    const o = await newOwner(env)
    const board = await newBoard(o)
    const [c1, c2, c3] = board.columns
    const inC1 = await newContact(env, o.companyId, { name: 'Etapa 1' })
    const inC2 = await newContact(env, o.companyId, { name: 'Etapa 2' })
    const noCard = await newContact(env, o.companyId, { name: 'Sem card' })
    await addCard(o, board.id, await newChat(env, o.companyId, inC1), c1.id)
    await addCard(o, board.id, await newChat(env, o.companyId, inC2), c2.id)
    await newChat(env, o.companyId, noCard)
    expect(await listIds(o, `crm_column_ids=${c1.id}`)).toEqual([inC1])
    expect(await listIds(o, `crm_column_ids[]=${c1.id}&crm_column_ids[]=${c2.id}`)).toEqual(sorted([inC1, inC2]))
    expect(await listIds(o, `crm_column_ids=${c3.id}`)).toEqual([])
  })

  it('AC-T66-01 campo personalizado: tem a chave; com valor, contém sem diferenciar caixa; período de criação', async () => {
    const o = await newOwner(env)
    const premium = await newContact(env, o.companyId, { name: 'Premium', customFields: { plano: 'Plano Premium Anual' }, createdAt: '2026-03-10T12:00:00Z' })
    const basico = await newContact(env, o.companyId, { name: 'Básico', customFields: { plano: 'basico' }, createdAt: '2026-03-20T23:30:00Z' })
    const semPlano = await newContact(env, o.companyId, { name: 'Sem plano', customFields: { cidade_natal: 'premium' }, createdAt: '2026-04-01T00:00:00Z' })
    expect(await listIds(o, 'custom_field_key=plano')).toEqual(sorted([premium, basico]))
    expect(await listIds(o, 'custom_field_key=plano&custom_field_value=PREMIUM')).toEqual([premium])
    expect(await listIds(o, 'custom_field_key=plano&custom_field_value=asic')).toEqual([basico])
    expect(await listIds(o, 'custom_field_key=plano&custom_field_value=nada')).toEqual([])
    expect(await listIds(o, 'created_at_from=2026-03-15&created_at_to=2026-03-20')).toEqual([basico])
    expect(await listIds(o, 'created_at_from=2026-03-01&created_at_to=2026-03-31')).toEqual(sorted([premium, basico]))
    expect(semPlano).toBeTruthy()
    // filtros não vazam outra empresa
    const other = await newOwner(env)
    await newContact(env, other.companyId, { name: 'Alheio', customFields: { plano: 'premium' } })
    expect(await listIds(o, 'custom_field_key=plano&custom_field_value=premium')).toEqual([premium])
  })
})

describe('AC-T66-02 skip_total', () => {
  it('AC-T66-02 skip_total=1 devolve total_count null e mantém a paginação (has_more, sem repetir itens)', async () => {
    const o = await newOwner(env)
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push(await newContact(env, o.companyId, { name: `P${i}`, createdAt: `2026-05-0${i + 1}T10:00:00Z` }))
    const pages = []
    for (let p = 1; p <= 3; p++) {
      const res = await o.c.get(`/api/contacts?skip_total=1&limit=2&page=${p}`)
      expect(res.status, res.text).toBe(200)
      expect(res.body.page.total_count).toBeNull()
      expect(res.body.page).toMatchObject({ page: p, limit: 2 })
      pages.push(res.body)
    }
    expect(pages.map((p) => p.items.length)).toEqual([2, 2, 1])
    expect(pages.map((p) => p.page.has_more)).toEqual([true, true, false])
    const seen = pages.flatMap((p) => p.items.map((x: any) => x.id))
    expect(new Set(seen).size).toBe(5)
    expect(seen).toEqual([...ids].reverse()) // created_at desc

    const counted = await o.c.get('/api/contacts?limit=2&page=1')
    expect(counted.body.page).toMatchObject({ total_count: 5, total_pages: 3, has_more: true })
    const alias = await o.c.get('/api/contacts?skip_total_count=true&limit=2')
    expect(alias.body.page.total_count).toBeNull()
    expect(alias.body.page.has_more).toBe(true)
    // com filtro também
    const L = await newLabel(env, o.companyId)
    await labelContact(env, o.companyId, ids[0]!, L)
    const filtered = await o.c.get(`/api/contacts?skip_total=1&label_ids=${L}&limit=2`)
    expect(filtered.body).toMatchObject({ page: { total_count: null, has_more: false } })
    expect(filtered.body.items.map((x: any) => x.id)).toEqual([ids[0]])
  })
})

describe('AC-T66-03 exportação', () => {
  const exportNames = async (o: User, body: Record<string, unknown>) => {
    const res = await o.c.post('/api/contacts/exports', body)
    expect(res.status, res.text).toBe(201)
    const job = res.body.job
    expect(job.kind).toBe('contacts_export')
    expect(await env.processExport(job.id)).toBeNull()
    const file = await downloadCsv(env, o, job.id)
    expect(file.status).toBe(200)
    const rows = parseCsv(file.text)
    return { job, header: rows[0]!, rows: rows.slice(1), names: rows.slice(1).map((r) => r[0]!).sort() }
  }

  it('AC-T66-03 modo all_except exclui os ids e respeita os filtros; ids e filtered também', async () => {
    const o = await newOwner(env)
    const L = await newLabel(env, o.companyId, 'Quente')
    const ids: Record<string, string> = {}
    for (const n of ['Alfa', 'Beta', 'Gama', 'Delta']) {
      ids[n] = await newContact(env, o.companyId, { name: n })
      await labelContact(env, o.companyId, ids[n]!, L)
    }
    ids.Fora = await newContact(env, o.companyId, { name: 'Fora', optOut: true })

    const ex = await exportNames(o, { mode: 'all_except', filters: { label_ids: [L] }, except_ids: [ids.Beta] })
    expect(ex.names).toEqual(['Alfa', 'Delta', 'Gama'])
    expect(ex.header.slice(0, 9)).toEqual(['Nome', 'Telefone', 'E-mail', 'Etiquetas', 'Estado', 'Cidade', 'CEP', 'Opt-out', 'Criado em'])
    expect(ex.rows.find((r) => r[0] === 'Alfa')![3]).toBe('Quente')

    const allBut = await exportNames(o, { mode: 'all_except', except_ids: [ids.Alfa, ids.Gama] })
    expect(allBut.names).toEqual(['Beta', 'Delta', 'Fora'])
    expect(allBut.rows.find((r) => r[0] === 'Fora')![7]).toBe('sim')

    const byIds = await exportNames(o, { mode: 'ids', ids: [ids.Gama, ids.Fora], filters: { label_ids: [L] } })
    expect(byIds.names).toEqual(['Fora', 'Gama']) // ids ignora filtros
    const filtered = await exportNames(o, { mode: 'filtered', filters: { search: 'delta' } })
    expect(filtered.names).toEqual(['Delta'])

    // id de outra empresa não vaza
    const other = await newOwner(env)
    const foreign = await newContact(env, other.companyId, { name: 'Alheio' })
    expect((await exportNames(o, { mode: 'ids', ids: [foreign, ids.Alfa] })).names).toEqual(['Alfa'])
  })

  it('AC-T66-03 as 3 exportações mais recentes ficam listadas; status por id; permissão', async () => {
    const o = await newOwner(env)
    await newContact(env, o.companyId, { name: 'Único', customFields: { plano: 'x' } })
    const jobs: string[] = []
    for (let i = 0; i < 4; i++) {
      jobs.push((await o.c.post('/api/contacts/exports', { mode: 'filtered', filters: {} })).body.job.id)
      await sleep(15)
    }
    const recent = await o.c.get('/api/contacts/exports')
    expect(recent.status, recent.text).toBe(200)
    expect(recent.body.items.map((j: any) => j.id)).toEqual([jobs[3], jobs[2], jobs[1]])
    const one = await o.c.get(`/api/contacts/exports/${jobs[0]}`)
    expect(one.status, one.text).toBe(200)
    expect(one.body.export).toMatchObject({ id: jobs[0], kind: 'contacts_export' })

    const withCf = await o.c.post('/api/contacts/exports', { mode: 'filtered', include_custom_fields: true })
    await env.processExport(withCf.body.job.id)
    const rows = parseCsv((await downloadCsv(env, o, withCf.body.job.id)).text)
    expect(JSON.parse(rows[1]![9]!)).toEqual({ plano: 'x' })

    const other = await newOwner(env)
    expect((await other.c.get('/api/contacts/exports')).body.items).toEqual([])
    expectApiError(await other.c.get(`/api/contacts/exports/${jobs[0]}`), 'NOT_FOUND', 404)
    const noView = await newMember(env, o.companyId, ['chat.view'])
    expectApiError(await noView.c.post('/api/contacts/exports', { mode: 'filtered' }), 'FORBIDDEN', 403)
  })
})

describe('AC-T66-04 exclusão em massa', () => {
  async function seedTarget(o: User, name: string, opts: { card?: { crmId: string; columnId: string }; label?: string } = {}) {
    const phone = mobile()
    const id = await newContact(env, o.companyId, { name, phone })
    const chat = await newChat(env, o.companyId, id, 3)
    if (opts.label) await labelContact(env, o.companyId, id, opts.label)
    if (opts.card) await addCard(o, opts.card.crmId, chat, opts.card.columnId)
    return { id, chat, phone }
  }
  const count = async (sql: string, params: unknown[]) => Number((await env.q(sql, params))[0].n)
  const publicCounts = async () =>
    Object.fromEntries(
      await Promise.all(
        (await env.q(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).map(async (r: any) => [
          r.table_name,
          await count(`SELECT count(*)::int AS n FROM public."${r.table_name}"`, []),
        ]),
      ),
    )

  it('AC-T66-04 manifesto all_except apaga em lotes com progresso, levando chats/mensagens/cards, sem tocar outra empresa nem public.*', async () => {
    configureBulk(env, { batchSize: 2 })
    const o = await newOwner(env)
    const board = await newBoard(o)
    const L = await newLabel(env, o.companyId, 'Apagar')
    const targets = []
    for (let i = 0; i < 5; i++) targets.push(await seedTarget(o, `Alvo ${i}`, { label: L, card: { crmId: board.id, columnId: board.columns[i % 3].id } }))
    const kept = await seedTarget(o, 'Poupado', { label: L, card: { crmId: board.id, columnId: board.columns[0].id } })
    const unlabeled = await seedTarget(o, 'Sem etiqueta')
    // outra empresa: mesmo nome, mesma etiqueta por nome
    const other = await newOwner(env)
    const otherL = await newLabel(env, other.companyId, 'Apagar')
    const foreign = await newContact(env, other.companyId, { name: 'Alvo 0' })
    await labelContact(env, other.companyId, foreign, otherL)
    const foreignChat = await newChat(env, other.companyId, foreign, 2)
    // public.* (engine): um contato com o mesmo telefone de um alvo
    await env.q(`INSERT INTO public.contacts (phone, name, opt_out) VALUES ($1, 'engine', true)`, [targets[0]!.phone])
    const publicBefore = await publicCounts()

    const viewer = await newMember(env, o.companyId, ['contacts.view', 'contacts.edit'])
    expectApiError(await viewer.c.post('/api/contacts/bulk-deletes', { version: 1, mode: 'ids', ids: [kept.id] }), 'FORBIDDEN', 403)

    const events = await openEvents(env, o, o.companyId)
    try {
      const res = await postManifestFile(env, o, { version: 1, mode: 'all_except', filters: { label_ids: [L] }, except_ids: [kept.id] })
      expect(res.status, res.text).toBe(201)
      const job = res.body.job
      expect(job.kind).toBe('contacts_bulk_delete')
      expect(await env.processImport(job.id)).toBeNull()

      const st = await o.c.get(`/api/contacts/bulk-deletes/${job.id}`)
      expect(st.status, st.text).toBe(200)
      expect(st.body.bulk_delete).toMatchObject({ status: 'completed' })
      expect(st.body.bulk_delete.counters).toMatchObject({ deleted_count: 5, target_count: 5, chats_deleted: 5 })

      // progresso por lote (5 alvos, lote de 2 → 3 lotes) até o fim
      await events.waitFor((m) => m.event === 'job.progress' && envelopeOf(m).data?.job_id === job.id && envelopeOf(m).data?.status === 'completed', 15_000)
      const processed = events
        .events('job.progress')
        .map((m) => envelopeOf(m).data)
        .filter((d) => d.job_id === job.id)
        .map((d) => Number(d.progress?.processed ?? 0))
      const distinct = [...new Set(processed)]
      expect(distinct.filter((n) => n > 0 && n < 5).length, JSON.stringify(processed)).toBeGreaterThanOrEqual(2)
      expect(processed[processed.length - 1]).toBe(5)
    } finally {
      await events.close()
    }

    const targetIds = targets.map((t) => t.id)
    const chatIds = targets.map((t) => t.chat)
    expect(await count(`SELECT count(*)::int AS n FROM crm.contacts WHERE id = ANY($1)`, [targetIds])).toBe(0)
    expect(await count(`SELECT count(*)::int AS n FROM crm.chats WHERE id = ANY($1)`, [chatIds])).toBe(0)
    expect(await count(`SELECT count(*)::int AS n FROM crm.messages WHERE chat_id = ANY($1)`, [chatIds])).toBe(0)
    expect(await count(`SELECT count(*)::int AS n FROM crm.crm_cards WHERE chat_id = ANY($1)`, [chatIds])).toBe(0)
    expect(await count(`SELECT count(*)::int AS n FROM crm.contact_labels WHERE contact_id = ANY($1)`, [targetIds])).toBe(0)
    // poupados ficam com tudo
    for (const k of [kept, unlabeled]) {
      expect(await count(`SELECT count(*)::int AS n FROM crm.contacts WHERE id = $1`, [k.id])).toBe(1)
      expect(await count(`SELECT count(*)::int AS n FROM crm.messages WHERE chat_id = $1`, [k.chat])).toBe(3)
    }
    expect(await count(`SELECT count(*)::int AS n FROM crm.crm_cards WHERE chat_id = $1`, [kept.chat])).toBe(1)
    // outra empresa intacta
    expect(await count(`SELECT count(*)::int AS n FROM crm.contacts WHERE id = $1`, [foreign])).toBe(1)
    expect(await count(`SELECT count(*)::int AS n FROM crm.messages WHERE chat_id = $1`, [foreignChat])).toBe(2)
    // public.* intocado (incluindo o opt-out do engine)
    expect(await publicCounts()).toEqual(publicBefore)
    expect(await count(`SELECT count(*)::int AS n FROM public.contacts WHERE phone = $1 AND opt_out`, [targets[0]!.phone])).toBe(1)
    // a lista reflete
    expect(await listIds(o)).toEqual(sorted([kept.id, unlabeled.id]))
  })

  it('AC-T66-04 manifesto por ids (JSON) ignora ids de outra empresa; status de outra empresa → 404', async () => {
    configureBulk(env, { batchSize: 2 })
    const o = await newOwner(env)
    const a = await seedTarget(o, 'A')
    const b = await seedTarget(o, 'B')
    const c = await seedTarget(o, 'C')
    const other = await newOwner(env)
    const foreign = await newContact(env, other.companyId, { name: 'Alheio' })

    const res = await o.c.post('/api/contacts/bulk-deletes', { version: 1, mode: 'ids', ids: [a.id, c.id, foreign], filters: {} })
    expect(res.status, res.text).toBe(201)
    await env.processImport(res.body.job.id)
    const st = (await o.c.get(`/api/contacts/bulk-deletes/${res.body.job.id}`)).body.bulk_delete
    expect(st.status).toBe('completed')
    expect(st.counters).toMatchObject({ deleted_count: 2, target_count: 2 })
    expect(await listIds(o)).toEqual([b.id])
    expect(await count(`SELECT count(*)::int AS n FROM crm.contacts WHERE id = $1`, [foreign])).toBe(1)
    expectApiError(await other.c.get(`/api/contacts/bulk-deletes/${res.body.job.id}`), 'NOT_FOUND', 404)
  })
})
