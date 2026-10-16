// AC-T67-01..06: relatório de erros por linha, upsert, etiquetas, Windows-1252, importação do WhatsApp e consentimento.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { uuid } from '../helpers/factories'
import {
  contactByPhone,
  countContacts,
  cp1252,
  importCsv,
  labelsOfContact,
  mobile,
  newConnection,
  newLabel,
  newMember,
  newOwner,
  postImport,
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

const local = (e164: string) => e164.replace(/^\+55/, '') // DDD + número, sem DDI

describe('AC-T67-01 relatório de linhas inválidas', () => {
  it('AC-T67-01 linha sem telefone válido vira "Linha N: telefone inválido", as demais entram, e erros iguais são agrupados', async () => {
    const owner = await newOwner(env)
    const [a, b] = [mobile(), mobile()]
    const csv = ['nome,telefone,email', `Ana,${a},ana@example.test`, 'Sem Telefone,,x@example.test', 'Curto,123', `Bia,${local(b)}`, 'Letras,abcdefgh', ''].join('\n')
    const imp = await importCsv(env, owner, csv)
    expect(imp).toMatchObject({ kind: 'contacts_import', type: 'import', status: 'completed' })
    expect(imp.counters).toMatchObject({ created: 2, updated: 0, errors: 3 })
    expect(imp.counters.errors_report).toEqual(['Linha 3: telefone inválido', 'Linha 4: telefone inválido', 'Linha 6: telefone inválido'])
    expect(imp.counters.error_groups).toEqual([{ message: 'telefone inválido', count: 3, lines: [3, 4, 6] }])
    expect(await countContacts(env, owner.companyId)).toBe(2)
    expect((await contactByPhone(env, owner.companyId, a)).name).toBe('Ana')
    // sem DDI vale o Brasil
    expect((await contactByPhone(env, owner.companyId, b)).name).toBe('Bia')
  })

  it('AC-T67-01 rota exige contacts.edit, modo inválido → 422; modelo CSV disponível; import de outra empresa → 404', async () => {
    const owner = await newOwner(env)
    const viewer = await newMember(env, owner.companyId, ['contacts.view'])
    expect((await postImport(env, viewer, `nome,telefone\nX,${mobile()}`)).status).toBe(403)
    const bad = await postImport(env, owner, `nome,telefone\nX,${mobile()}`, { mode: 'replace' })
    expect(bad.status, bad.text).toBe(422)

    const tpl = await env.app.request('/api/contacts/import-template.csv', { headers: { cookie: `crm_session=${viewer.token}`, 'x-company-id': owner.companyId } })
    expect(tpl.status).toBe(200)
    expect(tpl.headers.get('content-type')).toMatch(/^text\/csv/)
    expect(tpl.headers.get('content-disposition')).toContain('modelo_importacao_contatos.csv')
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await tpl.arrayBuffer())
    expect(text.charCodeAt(0)).toBe(0xfeff)
    expect(text.slice(1).split(/\r?\n/)[0]).toBe('nome;telefone;email;etiquetas;estado;cidade;cep;opt_out')

    const res = await postImport(env, owner, `nome,telefone\nX,${mobile()}`)
    const other = await newOwner(env)
    expectApiError(await other.c.get(`/api/contacts/imports/${res.body.job.id}`), 'NOT_FOUND', 404)
    expectApiError(await owner.c.get(`/api/contacts/imports/${uuid()}`), 'NOT_FOUND', 404)
  })
})

describe('AC-T67-02 reimportação faz upsert', () => {
  it('AC-T67-02 reimportar o mesmo arquivo conta updated e não duplica', async () => {
    const owner = await newOwner(env)
    const phones = [mobile(), mobile(), mobile()]
    const csv = ['nome,telefone,cidade', ...phones.map((p, i) => `Pessoa ${i},${p},Campinas`)].join('\n')
    const first = await importCsv(env, owner, csv)
    expect(first.counters).toMatchObject({ created: 3, updated: 0, errors: 0 })
    const second = await importCsv(env, owner, csv)
    expect(second.counters).toMatchObject({ created: 0, updated: 3, errors: 0 })
    expect(await countContacts(env, owner.companyId)).toBe(3)

    // dados novos atualizam; célula vazia não apaga
    const third = await importCsv(env, owner, ['nome,telefone,cidade', `Nome Novo,${phones[0]},`, `Pessoa 1,${phones[1]},Santos`].join('\n'))
    expect(third.counters).toMatchObject({ created: 0, updated: 2 })
    expect(await contactByPhone(env, owner.companyId, phones[0]!)).toMatchObject({ name: 'Nome Novo', city: 'Campinas' })
    expect((await contactByPhone(env, owner.companyId, phones[1]!)).city).toBe('Santos')
    expect(await countContacts(env, owner.companyId)).toBe(3)
  })

  it('AC-T67-02 mesmo telefone duas vezes no arquivo (com e sem DDI) cria um e atualiza o outro', async () => {
    const owner = await newOwner(env)
    const p = mobile()
    const imp = await importCsv(env, owner, ['nome,telefone', `Primeiro,${p}`, `Segundo,${local(p)}`].join('\n'))
    expect(imp.counters).toMatchObject({ created: 1, updated: 1 })
    expect(await countContacts(env, owner.companyId)).toBe(1)
    expect((await contactByPhone(env, owner.companyId, p)).name).toBe('Segundo')
  })
})

describe('AC-T67-03 etiquetas', () => {
  it('AC-T67-03 etiqueta inexistente só é criada com a opção ligada; com ela desligada vira aviso', async () => {
    const owner = await newOwner(env)
    await newLabel(env, owner.companyId, 'Cliente')
    const p1 = mobile()
    const off = await importCsv(env, owner, ['nome,telefone,etiquetas', `Ana,${p1},Cliente|Nova Etiqueta`].join('\n'), { create_missing_labels: 'false' })
    expect(off.counters.labels_created).toEqual([])
    expect(off.counters.warnings_report.join('\n')).toContain('etiqueta não encontrada: Nova Etiqueta')
    expect((await env.q(`SELECT count(*)::int AS n FROM crm.labels WHERE company_id = $1 AND name = 'Nova Etiqueta'`, [owner.companyId]))[0].n).toBe(0)
    const ana = await contactByPhone(env, owner.companyId, p1)
    expect(await labelsOfContact(env, ana.id)).toEqual(['Cliente'])

    const p2 = mobile()
    const on = await importCsv(env, owner, ['nome,telefone,etiquetas', `Bia,${p2},Nova Etiqueta;Cliente`].join('\n'), { create_missing_labels: 'true' })
    expect(on.counters.labels_created).toEqual(['Nova Etiqueta'])
    const bia = await contactByPhone(env, owner.companyId, p2)
    expect(await labelsOfContact(env, bia.id)).toEqual(['Cliente', 'Nova Etiqueta'])
    // sem a opção informada o padrão é ligado; e reimportar não recria
    const again = await importCsv(env, owner, ['nome,telefone,etiquetas', `Bia,${p2},Nova Etiqueta`].join('\n'))
    expect(again.counters.labels_created).toEqual([])
    expect((await env.q(`SELECT count(*)::int AS n FROM crm.labels WHERE company_id = $1 AND lower(name) = 'nova etiqueta'`, [owner.companyId]))[0].n).toBe(1)
  })

  it('AC-T67-03 etiquetas do CSV têm prioridade sobre as padrão; linhas sem etiqueta recebem as padrão; etiquetas só são acrescentadas', async () => {
    const owner = await newOwner(env)
    const padrao = await newLabel(env, owner.companyId, 'Padrão')
    await newLabel(env, owner.companyId, 'VIP')
    const [p1, p2, p3] = [mobile(), mobile(), mobile()]
    const imp = await importCsv(env, owner, ['nome,telefone,etiquetas', `Com,${p1},VIP`, `Sem,${p2},`].join('\n'), { 'default_label_ids[]': [padrao] })
    expect(imp.status).toBe('completed')
    expect(await labelsOfContact(env, (await contactByPhone(env, owner.companyId, p1)).id)).toEqual(['VIP'])
    expect(await labelsOfContact(env, (await contactByPhone(env, owner.companyId, p2)).id)).toEqual(['Padrão'])

    // default_label_ids_json também funciona; reimportar acrescenta sem remover
    await importCsv(env, owner, ['nome,telefone,etiquetas', `Com,${p1},`, `Ter,${p3},`].join('\n'), { default_label_ids_json: JSON.stringify([padrao]) })
    expect(await labelsOfContact(env, (await contactByPhone(env, owner.companyId, p1)).id)).toEqual(['Padrão', 'VIP'])
    expect(await labelsOfContact(env, (await contactByPhone(env, owner.companyId, p3)).id)).toEqual(['Padrão'])

    const other = await newOwner(env)
    const foreign = await newLabel(env, other.companyId, 'Alheia')
    expect((await postImport(env, owner, `nome,telefone\nX,${mobile()}`, { 'default_label_ids[]': [foreign] })).status).toBe(422)
  })
})

describe('AC-T67-04 Windows-1252 e delimitador', () => {
  it('AC-T67-04 CSV em Windows-1252 com ";" é lido com acentos corretos', async () => {
    const owner = await newOwner(env)
    const p = mobile()
    const bytes = cp1252(['Nome;Telefone;Cidade;Estado', `João Ação Pinhão;${p};São Paulo;SP`].join('\r\n'))
    expect(bytes.includes(0xe3)).toBe(true) // 'ã' em 1252 (não é UTF-8 válido)
    const imp = await importCsv(env, owner, bytes)
    expect(imp.counters).toMatchObject({ created: 1, errors: 0 })
    expect(await contactByPhone(env, owner.companyId, p)).toMatchObject({ name: 'João Ação Pinhão', city: 'São Paulo', state: 'SP' })
  })

  it('AC-T67-04 UTF-8 com BOM e ";" também; cabeçalhos com acento/maiúsculas e colunas desconhecidas viram aviso', async () => {
    const owner = await newOwner(env)
    const p = mobile()
    const csv = '﻿' + ['NOME;CELULAR;E-mail;Coluna Estranha', `Lúcia Müller;${p};lucia@example.test;qualquer`].join('\n')
    const imp = await importCsv(env, owner, csv)
    expect(imp.counters).toMatchObject({ created: 1, errors: 0 })
    expect(await contactByPhone(env, owner.companyId, p)).toMatchObject({ name: 'Lúcia Müller', email: 'lucia@example.test' })
    expect(imp.counters.warnings_report.join('\n').toLowerCase()).toContain('coluna ignorada')
  })
})

describe('AC-T67-05 importação do WhatsApp', () => {
  it('AC-T67-05 exige conexão conectada (senão 409); conexão de outra empresa → 404', async () => {
    const owner = await newOwner(env)
    const off = await newConnection(env, owner.companyId, 'DISCONNECTED')
    expectApiError(await owner.c.post('/api/contacts/import-from-whatsapp', { connection_id: off.id }), 'SESSION_NOT_CONNECTED', 409)
    const ghost = await newConnection(env, owner.companyId, null)
    expect((await owner.c.post('/api/contacts/import-from-whatsapp', { connection_id: ghost.id })).status).toBe(409)
    const other = await newOwner(env)
    const foreign = await newConnection(env, other.companyId)
    expectApiError(await owner.c.post('/api/contacts/import-from-whatsapp', { connection_id: foreign.id }), 'NOT_FOUND', 404)
    const viewer = await newMember(env, owner.companyId, ['contacts.view'])
    const on = await newConnection(env, owner.companyId)
    expectApiError(await viewer.c.post('/api/contacts/import-from-whatsapp', { connection_id: on.id }), 'FORBIDDEN', 403)
    expect(await countContacts(env, owner.companyId)).toBe(0)
  })

  it('AC-T67-05 importa com imported/updated/skipped; contato só com LID entra sem telefone', async () => {
    const owner = await newOwner(env)
    const conn = await newConnection(env, owner.companyId)
    const [pNew, pOld] = [mobile(), mobile()]
    const lid = `${Date.now()}${Math.floor(Math.random() * 1000)}@lid`
    await env.q(`INSERT INTO crm.contacts (company_id, name, phone_e164) VALUES ($1, 'Já Existia', $2)`, [owner.companyId, pOld])
    env.wa.setContacts(conn.sessionId, [
      { jid: `${pNew.slice(1)}@s.whatsapp.net`, phone: pNew, lid: null, name: 'Contato Novo', pushName: 'novo' },
      { jid: `${pOld.slice(1)}@s.whatsapp.net`, phone: pOld, lid: null, name: null, pushName: 'Antigo' },
      { jid: lid, phone: null, lid, name: null, pushName: 'Só LID' },
      { jid: '120363000000000000@g.us', phone: null, lid: null, name: 'Grupo', pushName: null },
      { jid: 'status@broadcast', phone: null, lid: null, name: null, pushName: null },
    ])
    const res = await owner.c.post('/api/contacts/import-from-whatsapp', { connection_id: conn.id })
    expect(res.status, res.text).toBe(200)
    expect(res.body).toMatchObject({ imported: 2, updated: 1, skipped: 2 })
    expect(Array.isArray(res.body.warnings)).toBe(true)

    expect((await contactByPhone(env, owner.companyId, pNew)).name).toBe('Contato Novo')
    const [onlyLid] = await env.q(`SELECT * FROM crm.contacts WHERE company_id = $1 AND wa_lid LIKE $2`, [owner.companyId, `${lid.split('@')[0]}%`])
    expect(onlyLid, 'contato só com LID não foi criado').toBeTruthy()
    expect(onlyLid.phone_e164).toBeNull()
    expect(onlyLid.name).toBe('Só LID')
    expect(await countContacts(env, owner.companyId)).toBe(3)

    // repetir: tudo vira updated (nada duplicado)
    const again = await owner.c.post('/api/contacts/import-from-whatsapp', { connection_id: conn.id })
    expect(again.body).toMatchObject({ imported: 0, updated: 3, skipped: 2 })
    expect(await countContacts(env, owner.companyId)).toBe(3)
  })
})

describe('AC-T67-06 consentimento e opt-out na importação', () => {
  it('AC-T67-06 contato importado do CSV recebe consent=true/import e o gateway recebe recordConsent(import)', async () => {
    const owner = await newOwner(env)
    const [p1, p2] = [mobile(), mobile()]
    await importCsv(env, owner, ['nome,telefone', `Ana,${p1}`, `Bia,${p2}`].join('\n'))
    for (const p of [p1, p2]) {
      expect(await contactByPhone(env, owner.companyId, p)).toMatchObject({ consent: true, consent_source: 'import', opt_out: false })
      expect(env.wa.consents.filter((c: any) => c.phone === p).map((c: any) => c.source)).toContain('import')
      expect(env.wa.hasConsent(p)).toBe(true)
    }
  })

  it('AC-T67-06 coluna opt_out verdadeira importa já com opt-out (optOut no gateway, sem consentimento); vazio não reverte opt-out', async () => {
    const owner = await newOwner(env)
    const [pYes, pX, pNo, pBlocked] = [mobile(), mobile(), mobile(), mobile()]
    await env.q(`INSERT INTO crm.contacts (company_id, name, phone_e164, opt_out) VALUES ($1, 'Bloqueado', $2, true)`, [owner.companyId, pBlocked])
    const imp = await importCsv(env, owner, ['nome,telefone,opt_out', `Sim,${pYes},sim`, `Xis,${pX},X`, `Nao,${pNo},não`, `Bloqueado,${pBlocked},`].join('\n'))
    expect(imp.counters).toMatchObject({ created: 3, updated: 1, errors: 0 })
    for (const p of [pYes, pX]) {
      expect(await contactByPhone(env, owner.companyId, p)).toMatchObject({ opt_out: true, consent: false })
      expect(env.wa.optOuts.map((o: any) => o.phone)).toContain(p)
      expect(env.wa.consents.some((c: any) => c.phone === p)).toBe(false)
    }
    expect(await contactByPhone(env, owner.companyId, pNo)).toMatchObject({ opt_out: false, consent: true, consent_source: 'import' })
    expect(await contactByPhone(env, owner.companyId, pBlocked)).toMatchObject({ opt_out: true })
    expect(env.wa.consents.some((c: any) => c.phone === pBlocked)).toBe(false)
  })

  it('AC-T67-06 contatos importados do WhatsApp também recebem consent import; só-LID não chama o gateway', async () => {
    const owner = await newOwner(env)
    const conn = await newConnection(env, owner.companyId)
    const p = mobile()
    const lid = `${Date.now()}9@lid`
    env.wa.setContacts(conn.sessionId, [
      { jid: `${p.slice(1)}@s.whatsapp.net`, phone: p, lid: null, name: 'Do Zap', pushName: null },
      { jid: lid, phone: null, lid, name: 'Lid Só', pushName: null },
    ])
    const before = env.wa.consents.length
    const res = await owner.c.post('/api/contacts/import-from-whatsapp', { connection_id: conn.id })
    expect(res.status, res.text).toBe(200)
    expect(await contactByPhone(env, owner.companyId, p)).toMatchObject({ consent: true, consent_source: 'import' })
    const fresh = env.wa.consents.slice(before)
    expect(fresh.map((c: any) => [c.phone, c.source])).toEqual([[p, 'import']])
  })
})
