// Leitura limitada do corpo e config zod (sem banco).
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { inboundWebhookConfigSchema } from './config'
import { INBOUND_WEBHOOK_BODY_LIMIT, readInboundBody } from './service'

const streamOf = (...chunks: (string | Uint8Array)[]) =>
  new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(typeof c === 'string' ? new TextEncoder().encode(c) : c)
      ctrl.close()
    },
  })
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

describe('readInboundBody', () => {
  it('corpo pequeno: texto, tamanho e hash; sem corpo vira vazio', async () => {
    const r = await readInboundBody(streamOf('{"a":', '1}'), { contentType: 'application/json' })
    expect(r).toEqual({ text: '{"a":1}', truncated: false, size: 7, hash: sha('{"a":1}'), contentType: 'application/json' })
    expect(await readInboundBody(null)).toMatchObject({ text: '', truncated: false, size: 0, hash: sha('') })
  })

  it('exatamente no limite não trunca; 1 byte acima trunca, guarda o limite e mede/hasheia tudo', async () => {
    const exact = 'x'.repeat(INBOUND_WEBHOOK_BODY_LIMIT)
    expect((await readInboundBody(streamOf(exact))).truncated).toBe(false)
    const over = `${exact}yz`
    const r = await readInboundBody(streamOf(over.slice(0, 1000), over.slice(1000)))
    expect(r.truncated).toBe(true)
    expect(r.text.length).toBe(INBOUND_WEBHOOK_BODY_LIMIT)
    expect(r.size).toBe(over.length)
    expect(r.hash).toBe(sha(over))
  })

  it('acima do limite de leitura para de ler; NUL some do texto', async () => {
    const r = await readInboundBody(streamOf('a'.repeat(50), 'b'.repeat(100)), { storeLimit: 10, readLimit: 60 })
    expect(r).toMatchObject({ truncated: true, size: 60, text: 'a'.repeat(10) })
    expect((await readInboundBody(streamOf('a\0b'))).text).toBe('ab')
  })
})

describe('inboundWebhookConfigSchema', () => {
  it('aceita {} e o config completo de 09 §3.2', () => {
    expect(inboundWebhookConfigSchema.parse({})).toEqual({})
    const full = {
      field_paths: { full_name: [{ kind: 'path', value: 'body.nome' }], phone: [{ kind: 'literal', value: '+55' }, { kind: 'path', value: 'body.tel' }] },
      custom_field_mappings: [{ field_key: 'cpf', segments: [{ kind: 'path', value: 'body.cpf' }] }],
      add_tags: ['Lead'],
      remove_tags: ['Frio'],
      kanban_actions: [
        { action: 'create_kanban_card', crm_id: crypto.randomUUID(), crm_column_id: crypto.randomUUID(), value: '{body.valor}' },
        { action: 'remove_kanban_card', crm_id: crypto.randomUUID() },
      ],
      trigger_flow: true,
      flow_id: crypto.randomUUID(),
      connection_value: '{body.instancia}',
      trigger_conditions: {
        ruleType: 'any',
        conditions: [
          { category: 'system', systemSubtype: 'tag', systemOperator: 'different', tagName: 'Cliente' },
          { category: 'field', fieldName: 'email', fieldOperator: 'has_value' },
          { category: 'custom_field', fieldName: 'cpf', fieldOperator: 'starts_with', fieldValue: '1' },
        ],
      },
    }
    expect(inboundWebhookConfigSchema.safeParse(full).success).toBe(true)
  })

  it('trigger_flow exige fluxo e número; create_kanban_card exige etapa; segmento inválido falha', () => {
    const paths = (v: unknown) => (inboundWebhookConfigSchema.safeParse(v).error?.issues ?? []).map((i) => i.path.join('.')).sort()
    expect(paths({ trigger_flow: true })).toEqual(['connection_value', 'flow_id'])
    expect(paths({ trigger_flow: true, flow_id: crypto.randomUUID(), connection_source: 'payload', connection_path: 'body.n' })).toEqual([])
    expect(paths({ kanban_actions: [{ action: 'create_kanban_card', crm_id: crypto.randomUUID() }] })).toEqual(['kanban_actions.0.crm_column_id'])
    expect(paths({ field_paths: { phone: [{ kind: 'regex', value: 'x' }] } })).toEqual(['field_paths.phone.0.kind'])
  })
})
