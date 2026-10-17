import { describe, expect, it } from 'vitest'
import { ACTION_EXAMPLES, MAX_WAIT_SECONDS, nodeHandles, type FlowAction } from '@crm/shared/flows'
import { defaultConfig, moveItem, validateConfig } from '../messaging/rules'
import { carouselPreview, menuPreview, menuText, newHandleId, optionHandles } from './rules'

const menuNode = (options: Record<string, unknown>[]): { type: string; actions: FlowAction[] } => ({
  type: 'interactive_menu',
  actions: [{ id: 'a1', type: 'send_interactive_menu', order: 0, config: { menuType: 'list', message: 'Oi', buttonLabel: 'Ver', options } }],
})

describe('AC-T56-03 menu: opções com handles estáveis, aviso e prazo até 31 dias', () => {
  it('ids gerados uma vez, únicos e válidos para handle (sem `:` nem espaço)', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 200; i++) ids.add(newHandleId('option'))
    expect(ids.size).toBe(200)
    for (const id of ids) expect(id).toMatch(/^option_[a-z0-9]+$/)
    expect(newHandleId('btn', 0, () => 0)).toBe('btn_0aaaa')
    expect(newHandleId('card', 36, () => 0.99)).toBe('card_109999')
  })

  it('reordenar opções não muda o conjunto de handles; cada opção sai por `option:<id>`', () => {
    const options = [
      { id: 'option_a', title: 'Comprar' },
      { id: 'option_b', title: 'Suporte' },
      { id: 'option_c', title: 'Outro' },
    ]
    const before = nodeHandles(menuNode(options))
    const after = nodeHandles(menuNode(moveItem(options, 2, 0)))
    expect(before).toEqual(['option:option_a', 'option:option_b', 'option:option_c', 'other', 'timeout'])
    expect([...after].sort()).toEqual([...before].sort())
    expect(optionHandles(moveItem(options, 2, 0))).toEqual(['option:option_c', 'option:option_a', 'option:option_b'])
    expect(optionHandles([{ id: 'b1', type: 'REPLY' }, { id: 'b2', type: 'URL' }], true)).toEqual(['option:b1'])
  })

  it('config padrão do menu exige mensagem e título; prazo 0 = padrão; até 31 dias passa e 32 não', () => {
    const base = { ...defaultConfig('send_interactive_menu', { buttonLabel: 'Ver opções' }), options: [{ id: newHandleId('option'), title: '' }] }
    expect(validateConfig('send_interactive_menu', base)).toEqual({ message: { key: 'required' }, 'options.0.title': { key: 'required' } })
    const ok = { ...base, message: 'Escolha', options: [{ id: 'option_1', title: 'Sim' }] }
    expect(validateConfig('send_interactive_menu', ok)).toEqual({})
    expect(validateConfig('send_interactive_menu', { ...ok, timeout_value: 31, timeout_unit: 'days' })).toEqual({})
    expect(validateConfig('send_interactive_menu', { ...ok, timeout_value: 744, timeout_unit: 'hours' })).toEqual({})
    expect(validateConfig('send_interactive_menu', { ...ok, timeout_value: 32, timeout_unit: 'days' })).toEqual({ timeout_value: { key: 'maxWait' } })
    expect(validateConfig('send_interactive_menu', { ...ok, timeout_value: MAX_WAIT_SECONDS + 1, timeout_unit: 'seconds' })).toEqual({ timeout_value: { key: 'maxWait' } })
    expect(validateConfig('send_option_list', ok)).toEqual({})
  })

  it('id de opção com `:` é recusado pelo schema (o handle quebraria)', () => {
    expect(validateConfig('send_interactive_menu', { menuType: 'button', message: 'x', options: [{ id: 'a:b', title: 'A' }] })).toEqual({ 'options.0.id': { key: 'handle' } })
  })

  it('Aguardar resposta: padrão de 1 dia é válido; prazo acima de 31 dias não', () => {
    expect(validateConfig('wait_for_response', defaultConfig('wait_for_response'))).toEqual({})
    expect(validateConfig('wait_for_response', { timeout_value: 32, timeout_unit: 'days' })).toEqual({ timeout_value: { key: 'maxWait' } })
    expect(validateConfig('wait_for_response', { wait_indefinitely: true })).toEqual({})
    expect(validateConfig('save_user_data', { field_name: '' })).toEqual({ field_name: { key: 'required' } })
  })
})

describe('AC-T56-04 prévia em formato de chat (menu e carrossel)', () => {
  it('menuText replica o motor: mensagem, opções numeradas, links e rodapé', () => {
    const text = menuText(
      ' Como posso ajudar? ',
      [
        { id: 'o1', title: 'Comprar', description: 'ver planos' },
        { id: 'o2', title: 'Site', type: 'URL', description: 'https://x.test' },
        { id: 'o3', title: 'Suporte', type: 'REPLY' },
      ],
      'Responda com o número',
    )
    expect(text).toBe('Como posso ajudar?\n\n1 - Comprar — ver planos\n2 - Suporte\n\nSite: https://x.test\n\nResponda com o número')
  })

  it('menuPreview inclui a imagem do botão só quando ativa', () => {
    const c = { menuType: 'button', message: 'Oi', options: [{ id: 'o1', title: 'A' }], imageButtonEnabled: true, imageButton: 'blob:abc', imageButton_media_id: 'm1' }
    expect(menuPreview(c)).toEqual([
      { kind: 'image', text: '', image: '/api/media/m1' },
      { kind: 'text', text: 'Oi\n\n1 - A' },
    ])
    expect(menuPreview({ ...c, imageButtonEnabled: false })).toHaveLength(1)
  })

  it('carrossel: imagem com legenda (texto + links) por cartão e o menu dos botões de resposta no fim', () => {
    const c = {
      text: 'Escolha uma opção abaixo',
      carousel: [
        {
          card_id: 'card_1',
          text: 'Plano Básico',
          image: 'https://x.test/b.jpg',
          buttons: [
            { id: 'btn_1', text: 'Quero', type: 'REPLY' },
            { id: 'btn_2', text: 'Site', type: 'URL', payload: 'https://x.test' },
          ],
        },
        { card_id: 'card_2', text: 'Plano Pro', image: 'blob:ff', media_id: 'm2', buttons: [{ id: 'btn_3', text: 'Pro', type: 'REPLY' }] },
        { card_id: 'card_3', text: 'Sem imagem', buttons: [] },
      ],
    }
    expect(carouselPreview(c)).toEqual([
      { kind: 'image', text: 'Plano Básico\nSite: https://x.test', image: 'https://x.test/b.jpg' },
      { kind: 'image', text: 'Plano Pro', image: '/api/media/m2' },
      { kind: 'text', text: 'Escolha uma opção abaixo\n\n1 - Quero\n2 - Pro' },
    ])
  })

  it('o exemplo do T10 do carrossel passa no editor e o padrão pede imagem', () => {
    expect(validateConfig('send_carousel', ACTION_EXAMPLES.send_carousel)).toEqual({})
    const fresh = { ...defaultConfig('send_carousel', { carouselText: 'Escolha' }), carousel: [{ card_id: newHandleId('card'), text: 'A', media_kind: 'image', media_source: 'file', buttons: [] }] }
    expect(validateConfig('send_carousel', fresh)).toEqual({ 'carousel.0.image': { key: 'image' } })
    expect(validateConfig('send_carousel', { ...fresh, gatilho: { timeout_value: 32, timeout_unit: 'days' } })).toMatchObject({ gatilho: { key: 'maxWait' } })
  })
})
