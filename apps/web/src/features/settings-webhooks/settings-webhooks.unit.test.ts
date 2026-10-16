import { describe, expect, it } from 'vitest'
import type { WebhookDto, WebhookRequestDto } from './api'
import { filterRequests } from './history-tab'
import { filterWebhooks } from './list-page'
import {
  addCustomField,
  appendSegment,
  childPath,
  configWithMapping,
  identityWarning,
  mappingFromConfig,
  parseBody,
  prettyBody,
  readPath,
  removeSegment,
  resolveSegments,
  segmentsFor,
} from './mapping'
import { dispatchSample, onSample, secondsLeft } from './realtime'

const body = { nome: 'Ana', contato: { fone: '11999990000' }, itens: [{ sku: 'A1' }] }

describe('mapeamento (AC-T89-03)', () => {
  it('caminhos em notação de ponto, como no processador da T81', () => {
    expect(readPath(body, 'contato.fone')).toBe('11999990000')
    expect(readPath(body, 'itens.0.sku')).toBe('A1')
    expect(readPath(body, 'body.nome')).toBe('Ana')
    expect(readPath(body, '__proto__.x')).toBeUndefined()
    expect(childPath('', 'nome')).toBe('nome')
    expect(childPath('itens', 0)).toBe('itens.0')
  })

  it('literais concatenam com caminhos; caminho ausente vira vazio', () => {
    const segs = [
      { kind: 'literal' as const, value: '+55' },
      { kind: 'path' as const, value: 'contato.fone' },
    ]
    expect(resolveSegments(body, segs)).toBe('+5511999990000')
    expect(resolveSegments({}, segs)).toBe('+55')
  })

  it('aviso de identidade: literal sem caminho garantido na amostra', () => {
    const lit = { kind: 'literal' as const, value: '+55' }
    const path = { kind: 'path' as const, value: 'contato.fone' }
    expect(identityWarning([lit], body)).toBe(true)
    expect(identityWarning([lit, path], body)).toBe(false)
    expect(identityWarning([lit, path], { contato: {} })).toBe(true)
    expect(identityWarning([lit, path], undefined)).toBe(true)
    expect(identityWarning([path], undefined)).toBe(false)
    expect(identityWarning([], body)).toBe(false)
  })

  it('editor: anexar, remover, campo personalizado e config salvo sem perder o resto', () => {
    let m = mappingFromConfig({ field_paths: { full_name: [{ kind: 'path', value: 'nome' }] }, add_tags: ['lead'] })
    m = appendSegment(m, 'phone', { kind: 'literal', value: '+55' })
    m = appendSegment(m, 'phone', { kind: 'path', value: 'contato.fone' })
    m = addCustomField(m, 'origem')
    m = appendSegment(m, 'custom:origem', { kind: 'literal', value: 'site' })
    expect(segmentsFor(m, 'phone')).toHaveLength(2)
    const cfg = configWithMapping({ add_tags: ['lead'], field_paths: { email: [{ kind: 'path', value: 'x' }] } }, removeSegment(m, 'full_name', 0))
    expect(cfg).toEqual({
      add_tags: ['lead'],
      field_paths: {
        phone: [
          { kind: 'literal', value: '+55' },
          { kind: 'path', value: 'contato.fone' },
        ],
      },
      custom_field_mappings: [{ field_key: 'origem', segments: [{ kind: 'literal', value: 'site' }] }],
    })
    expect(mappingFromConfig({ field_paths: { phone: [{ kind: 'x', value: 1 }] } })).toEqual({ field_paths: {}, custom: [] })
  })

  it('corpo cru: JSON formatado ou texto como veio', () => {
    expect(parseBody('{"a":1}')).toEqual({ a: 1 })
    expect(parseBody('a=1')).toBeUndefined()
    expect(prettyBody('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(prettyBody('a=1')).toBe('a=1')
  })
})

describe('escuta de exemplo (AC-T89-02)', () => {
  it('contagem pelo relógio do navegador e amostra só para quem ouve o webhook', () => {
    expect(secondsLeft('2026-01-01T00:01:30.000Z', Date.parse('2026-01-01T00:00:00.000Z'))).toBe(90)
    expect(secondsLeft('2026-01-01T00:01:30.000Z', Date.parse('2026-01-01T00:02:00.000Z'))).toBe(0)
    const got: string[] = []
    const off = onSample('w1', (ev) => got.push(ev.request.raw_body))
    dispatchSample({ webhook_id: 'w1', request_id: 'r1', request: { raw_body: '{"a":1}', raw_body_truncated: false } })
    dispatchSample({ webhook_id: 'w2', request_id: 'r2', request: { raw_body: 'x', raw_body_truncated: false } })
    dispatchSample({ webhook_id: 'w1' })
    off()
    dispatchSample({ webhook_id: 'w1', request_id: 'r3', request: { raw_body: 'depois', raw_body_truncated: false } })
    expect(got).toEqual(['{"a":1}'])
  })
})

describe('lista e histórico (AC-T89-01/04)', () => {
  it('busca local por nome sem acento/caixa; filtro de status local', () => {
    const hooks = [{ name: 'Formulário Site' }, { name: 'Hotmart' }] as WebhookDto[]
    expect(filterWebhooks(hooks, 'formulario').map((h) => h.name)).toEqual(['Formulário Site'])
    expect(filterWebhooks(hooks, '')).toHaveLength(2)
    const reqs = [{ processing_status: 'processed' }, { processing_status: 'failed' }] as WebhookRequestDto[]
    expect(filterRequests(reqs, 'failed')).toHaveLength(1)
    expect(filterRequests(reqs, '')).toHaveLength(2)
  })
})
