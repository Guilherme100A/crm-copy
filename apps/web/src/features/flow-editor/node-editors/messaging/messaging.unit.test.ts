import { describe, expect, it } from 'vitest'
import { ACTION_EXAMPLES, type FlowAction } from '@crm/shared/flows'
import { collectNodeEditors, getNodeEditor } from '../registry'
import {
  blobRef,
  crc16ccitt,
  defaultConfig,
  errorsUnder,
  hasErrors,
  insertVariable,
  intOf,
  issueError,
  isBlobRef,
  MESSAGE_ACTION_TYPES,
  mediaTypeOf,
  moveItem,
  newAction,
  pixAmount,
  pixEmv,
  pixPreview,
  previewUrl,
  setField,
  validateActions,
  validateConfig,
  variableGroups,
  withOrder,
} from './rules'
import { ensureAction, findAction } from './single'

const act = (id: string, type: string, config: Record<string, unknown>, order = 0): FlowAction => ({ id, type, order, config })

describe('registro dos editores (glob dos grupos)', () => {
  it('mensagem, Pix, notificação, menus, carrossel e Aguardar resposta têm editor', () => {
    for (const type of ['message', 'pix', 'notification', 'interactive_menu', 'menu', 'carousel', 'wait_response']) expect(getNodeEditor(type), type).not.toBeNull()
    // tipo ainda sem editor (payment fica com a T114); 'condition' passou a ter editor na T57
    expect(getNodeEditor('payment')).toBeNull()
  })

  it('collectNodeEditors junta os `nodeEditors` dos módulos (o último caminho vence) e ignora o resto', () => {
    const A = () => null
    const B = () => null
    const out = collectNodeEditors({ './b/index.ts': { nodeEditors: { message: B } }, './a/index.ts': { nodeEditors: { message: A, pix: A, bad: 1 } }, './c/index.ts': {} })
    expect(out).toEqual({ message: B, pix: A })
  })
})

describe('AC-T56-01 nó Mensagem: adicionar, reordenar, remover, mídia e variável', () => {
  it('oferece as 6 ações na ordem do T10 e cada uma nasce com config e id de ação', () => {
    expect(MESSAGE_ACTION_TYPES).toEqual(['send_message', 'send_multi_media', 'send_file', 'send_sticker', 'send_contact', 'delay_between_messages'])
    const seq = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.05]
    let i = 0
    const a = newAction('send_message', defaultConfig('send_message'), () => seq[i++ % seq.length]!)
    expect(a.id).toMatch(/^a_[a-z0-9]{10}$/)
    expect(a).toMatchObject({ type: 'send_message', config: { message_text: '' } })
    expect(defaultConfig('delay_between_messages')).toEqual({ delay_seconds: 3 })
    // O atraso padrão já é válido; texto/arquivo/figurinha/contato pedem preenchimento.
    expect(validateConfig('delay_between_messages', defaultConfig('delay_between_messages'))).toEqual({})
  })

  it('reordena (subir/descer/arrastar) e renumera `order` pela posição', () => {
    const list = [act('a1', 'send_message', {}), act('a2', 'send_file', {}), act('a3', 'send_contact', {})]
    const moved = moveItem(list, 2, 0)
    expect(moved.map((a) => a.id)).toEqual(['a3', 'a1', 'a2'])
    expect(withOrder(moved).map((a) => a.order)).toEqual([0, 1, 2])
    expect(moveItem(list, 0, 5)).toEqual(list)
    const removed = withOrder(list.filter((a) => a.id !== 'a2'))
    expect(removed.map((a) => [a.id, a.order])).toEqual([
      ['a1', 0],
      ['a3', 1],
    ])
  })

  it('mídia enviada vira `blob:<sha256>` e passa no schema do T10 (mídia, arquivo e figurinha)', () => {
    const ref = blobRef('ab'.repeat(32))
    expect(ref).toBe(`blob:${'ab'.repeat(32)}`)
    expect(isBlobRef(ref)).toBe(true)
    expect(validateConfig('send_multi_media', { media_type: 'image', media_source: 'file', media_url: ref, media_id: 'm1' })).toEqual({})
    expect(validateConfig('send_file', { media_source: 'file', file_url: ref, file_name: 'cat.pdf' })).toEqual({})
    expect(validateConfig('send_sticker', { media_source: 'file', sticker_url: ref, sticker_name: 'oi.webp' })).toEqual({})
    expect(mediaTypeOf('image/webp')).toBe('image')
    expect(mediaTypeOf('video/mp4')).toBe('video')
    expect(mediaTypeOf('audio/ogg; codecs=opus')).toBe('audio')
    expect(mediaTypeOf('application/pdf')).toBeNull()
    expect(previewUrl(ref, 'm 1')).toBe('/api/media/m%201')
    expect(previewUrl('https://x.test/a.png', undefined)).toBe('https://x.test/a.png')
    expect(previewUrl(ref, undefined)).toBeNull()
  })

  it('insere a variável no cursor (ou no lugar da seleção)', () => {
    expect(insertVariable('Olá !', 'first_name', 4)).toEqual({ value: 'Olá {first_name}!', caret: 16 })
    expect(insertVariable('Olá XX!', 'g_loja', 4, 6)).toEqual({ value: 'Olá {g_loja}!', caret: 12 })
    expect(insertVariable('fim', 'hora')).toEqual({ value: 'fim{hora}', caret: 9 })
  })

  it('seletor de variável: grupos sem nome repetido (campos do sistema vêm também da API) e sem grupo vazio', () => {
    const groups = variableGroups([
      { id: 'contact', names: ['first_name', 'email'] },
      { id: 'fields', names: ['first_name', 'cpf'] },
      { id: 'globals', names: [] },
    ])
    expect(groups).toEqual([
      { id: 'contact', names: ['first_name', 'email'] },
      { id: 'fields', names: ['cpf'] },
    ])
  })

  it('campo opcional vazio sai da config; número digitado vira inteiro', () => {
    expect(setField({ a: 1, b: 2 }, 'b', undefined)).toEqual({ a: 1 })
    expect(setField({ a: 1 }, 'b', 'x')).toEqual({ a: 1, b: 'x' })
    expect(intOf('')).toBeUndefined()
    expect(intOf('12')).toBe(12)
    expect(intOf('abc')).toBeUndefined()
  })
})

describe('AC-T56-02 erros do schema do T10 vão para o campo e bloqueiam salvar', () => {
  it('texto obrigatório, atraso acima de 120 s e mínimo > máximo', () => {
    expect(validateConfig('send_message', { message_text: '  ' })).toEqual({ message_text: { key: 'required' } })
    expect(validateConfig('delay_between_messages', { delay_seconds: 121 })).toEqual({ delay_seconds: { key: 'max', vars: { max: 120 } } })
    expect(validateConfig('delay_between_messages', { delay_min_seconds: 9, delay_max_seconds: 3 })).toEqual({ delay_min_seconds: { key: 'minMax' } })
    expect(validateConfig('send_multi_media', { media_type: 'image', media_source: 'url' })).toEqual({ media_url: { key: 'media' } })
    expect(validateConfig('send_contact', { contact_name: 'Ana', contact_phone: '' })).toEqual({ contact_phone: { key: 'required' } })
  })

  it('Pix confere o formato da chave pelo tipo (variável fica para o envio) e a notificação o telefone', () => {
    expect(validateConfig('send_pix_button', { pix_type: 'CPF', pix_key: '123' })).toEqual({ pix_key: { key: 'pixKey' } })
    expect(validateConfig('send_pix_button', { pix_type: 'CPF', pix_key: '{g_pix}' })).toEqual({})
    expect(validateConfig('send_pix_button', { pix_type: 'EMAIL', pix_key: 'a@b.co', amount_reais: '' })).toEqual({ amount_reais: { key: 'required' } })
    expect(validateConfig('send_notification', { name: 'Equipe', phone: '12', message: 'oi' })).toEqual({ phone: { key: 'phone' } })
  })

  it('caminhos aninhados chegam ao campo certo (opção do menu, imagem do cartão)', () => {
    const menu = validateConfig('send_interactive_menu', { menuType: 'list', message: 'Oi', buttonLabel: '', options: [{ id: 'o1', title: 'A' }, { id: 'o2', title: '' }] })
    expect(menu).toEqual({ buttonLabel: { key: 'required' }, 'options.1.title': { key: 'required' } })
    expect(errorsUnder(menu, 'options.1')).toEqual({ title: { key: 'required' } })
    const carousel = validateConfig('send_carousel', { text: 'Escolha', carousel: [{ text: 'Plano', buttons: [] }] })
    expect(carousel).toEqual({ 'carousel.0.image': { key: 'image' } })
    expect(validateConfig('send_carousel', { text: 'x', carousel: [] })).toEqual({ carousel: { key: 'minItems', vars: { min: 1 } } })
  })

  it('só as ações inválidas aparecem; com qualquer erro o rascunho não é salvo', () => {
    const ok = act('a1', 'send_message', { message_text: 'Oi' })
    const bad = act('a2', 'send_file', { file_name: '' })
    expect(validateActions([ok])).toEqual({})
    expect(hasErrors(validateActions([ok]))).toBe(false)
    const errs = validateActions([ok, bad])
    expect(Object.keys(errs)).toEqual(['a2'])
    expect(hasErrors(errs)).toBe(true)
    // Ação sem schema (de outro grupo) não bloqueia.
    expect(validateActions([act('x', 'algo_novo', {})])).toEqual({})
  })

  it('issueError traduz os códigos do zod', () => {
    expect(issueError({ code: 'too_small', origin: 'number', minimum: 1, path: [], message: '' })).toEqual({ key: 'min', vars: { min: 1 } })
    expect(issueError({ code: 'too_big', origin: 'array', maximum: 3, path: [], message: '' })).toEqual({ key: 'maxItems', vars: { max: 3 } })
    expect(issueError({ code: 'invalid_value', path: [], message: '' })).toEqual({ key: 'format' })
    expect(issueError({ code: 'custom', path: [], message: 'prazo máximo é 31 dias' })).toEqual({ key: 'maxWait' })
    expect(issueError({ code: 'custom', path: [], message: '???' })).toEqual({ key: 'invalid' })
  })

  it('todos os exemplos do T10 dos tipos da T56 passam no editor', () => {
    for (const type of ['send_message', 'send_multi_media', 'send_file', 'send_sticker', 'send_contact', 'delay_between_messages', 'send_pix_button', 'send_notification'] as const) {
      expect(validateConfig(type, ACTION_EXAMPLES[type]), type).toEqual({})
    }
  })
})

describe('nós de ação única (Pix, Notificação…)', () => {
  it('ensureAction completa o nó novo uma vez e preserva o que existe', () => {
    const created = ensureAction([], 'send_pix_button', () => defaultConfig('send_pix_button'))
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ type: 'send_pix_button', config: { pix_type: 'EVP', pix_key: '' } })
    expect(ensureAction(created, 'send_pix_button', () => ({}))).toBe(created)
    const withMsg = ensureAction([act('m', 'send_message', {})], 'wait_for_response', () => ({}), 'end')
    expect(withMsg.map((a) => a.type)).toEqual(['send_message', 'wait_for_response'])
    expect(findAction(withMsg, ['send_option_list', 'wait_for_response'])?.type).toBe('wait_for_response')
  })
})

describe('AC-T56-04 prévia do Pix (texto do motor)', () => {
  it('CRC16-CCITT-FALSE confere com o valor de verificação', () => {
    expect(crc16ccitt('123456789')).toBe('29B1')
  })

  it('valor em reais como o motor', () => {
    expect(pixAmount('1.234,56')).toBe('1234.56')
    expect(pixAmount('10.5')).toBe('10.50')
    expect(pixAmount(49.9)).toBe('49.90')
    expect(pixAmount('')).toBeNull()
    expect(pixAmount('0')).toBeNull()
  })

  it('chave, recebedor, valor e o copia e cola com CRC válido', () => {
    const p = pixPreview({ pix_type: 'EMAIL', pix_key: 'Contato@Example.com', merchant_name: 'Loja Ação', amount_reais: '49,90' })
    expect(p.text).toBe('Chave Pix: Contato@Example.com\nRecebedor: Loja Ação\nValor: R$ 49,90\n\nPix copia e cola:')
    const emv = p.emv!
    expect(emv).toBe(pixEmv({ key: 'Contato@Example.com', type: 'EMAIL', merchantName: 'Loja Ação', amount: '49,90' }))
    expect(emv).toContain('0014br.gov.bcb.pix0119contato@example.com')
    expect(emv).toContain('540549.90')
    expect(emv).toContain('5909Loja Acao')
    expect(emv.slice(-4)).toBe(crc16ccitt(emv.slice(0, -4)))
  })

  it('igual ao `pixMessage` do core (saídas reais de packages/core/.../pix.ts)', () => {
    const golden: Array<[Record<string, unknown>, string]> = [
      [
        { pix_type: 'EMAIL', pix_key: 'Contato@Example.com', merchant_name: 'Loja Ação', amount_reais: '49,90' },
        'Chave Pix: Contato@Example.com\nRecebedor: Loja Ação\nValor: R$ 49,90\n\nPix copia e cola:\n00020126410014br.gov.bcb.pix0119contato@example.com520400005303986540549.905802BR5909Loja Acao6006BRASIL62070503***6304BC42',
      ],
      [{ pix_type: 'CPF', pix_key: '123.456.789-09' }, 'Chave Pix: 123.456.789-09\n\nPix copia e cola:\n00020126330014br.gov.bcb.pix0111123456789095204000053039865802BR5903Pix6006BRASIL62070503***6304E105'],
      [
        { pix_type: 'PHONE', pix_key: '11999990000', merchant_name: 'Zé', amount_reais: '1.234,56' },
        'Chave Pix: 11999990000\nRecebedor: Zé\nValor: R$ 1234,56\n\nPix copia e cola:\n00020126360014br.gov.bcb.pix0114+551199999000052040000530398654071234.565802BR5902Ze6006BRASIL62070503***63043973',
      ],
      [
        { pix_key: '123e4567-e89b-12d3-a456-426614174000', amount_reais: 10 },
        'Chave Pix: 123e4567-e89b-12d3-a456-426614174000\nValor: R$ 10,00\n\nPix copia e cola:\n00020126580014br.gov.bcb.pix0136123e4567-e89b-12d3-a456-426614174000520400005303986540510.005802BR5903Pix6006BRASIL62070503***63047FBF',
      ],
    ]
    for (const [config, expected] of golden) {
      const p = pixPreview(config)
      expect(`${p.text}\n${p.emv}`).toBe(expected)
    }
  })

  it('CPF e telefone normalizados; variável na chave ou no valor = código gerado no envio', () => {
    expect(pixEmv({ key: '123.456.789-09', type: 'CPF' })).toContain('011112345678909')
    expect(pixEmv({ key: '11999990000', type: 'PHONE' })).toContain('0114+5511999990000')
    expect(pixPreview({ pix_key: '{g_pix}' })).toEqual({ text: 'Chave Pix: {g_pix}\n\nPix copia e cola:', emv: null })
    const dyn = pixPreview({ pix_type: 'EMAIL', pix_key: 'a@b.co', amount_reais: '{venda.valor}' })
    expect(dyn.emv).toBeNull()
    expect(dyn.text).toContain('Valor: R$ {venda.valor}')
  })
})
