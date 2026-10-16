// AC-T62-01..05: menu numerado e reconhecimento da resposta, save_user_data, buffer do wait_response, carrossel e
// ausência de conteúdo nativo (botões/listas).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { action, customFields, def, edge, marker, node, session, startEnv, type Env } from './support'

let env: Env
beforeAll(async () => {
  env = await startEnv()
})
afterAll(async () => {
  await env?.close()
})

const OPTIONS = [
  { id: 'vendas', title: 'Vendas' },
  { id: 'suporte', title: 'Suporte Técnico', description: 'dúvidas de uso' },
  { id: 'financeiro', title: 'Financeiro' },
]

/** start → M (menu) ─option:<id>→ marcador / ─other→ O / ─timeout→ T */
function menuDef(type: 'interactive_menu' | 'menu' = 'interactive_menu', extra: Record<string, unknown> = {}, save?: string) {
  const act = type === 'menu' ? 'send_option_list' : 'send_interactive_menu'
  const actions = [action('M-a', act, { menuType: 'list', buttonLabel: 'Ver opções', message: 'Olá {first_name}, escolha:', options: OPTIONS, footerText: 'Equipe', ...extra })]
  if (save) actions.push(action('M-s', 'save_user_data', { field_name: save }, 1))
  return def(
    [node('M', type, actions), marker('V'), marker('S'), marker('Fi'), marker('O'), marker('T')],
    [
      edge('start', 'source', 'M'),
      edge('M', 'option:vendas', 'V'),
      edge('M', 'option:suporte', 'S'),
      edge('M', 'option:financeiro', 'Fi'),
      edge('M', 'other', 'O'),
      edge('M', 'timeout', 'T'),
    ],
  )
}

const kinds = (contents: any[]) => contents.map((c) => Object.keys(c).sort().join('+'))

describe('AC-T62-01 menu numerado em texto', () => {
  it('AC-T62-01 o menu é enviado como texto numerado ("1 - Vendas") com variáveis e rodapé', async () => {
    const s = await session(env, menuDef())
    expect(s.visited).toEqual([])
    expect((await s.run()).status).toBe('waiting')
    const sent = s.sent()
    expect(sent).toHaveLength(1)
    const text: string = sent[0].text
    expect(text.startsWith('Olá Maria, escolha:')).toBe(true)
    expect(text).toMatch(/^1 - Vendas$/m)
    expect(text).toMatch(/^2 - Suporte Técnico — dúvidas de uso$/m)
    expect(text).toMatch(/^3 - Financeiro$/m)
    expect(text.trim().endsWith('Equipe')).toBe(true)
    expect(s.wa.sent[0]).toMatchObject({ phone: s.phone })
    expect(env.core.menuText('Escolha:', [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }])).toContain('1 - A\n2 - B')
  })

  it('AC-T62-01 resposta "2", título exato ou título sem caixa/acentos seguem option:<id>', async () => {
    for (const [answer, expected] of [
      ['2', 'S'],
      ['2.', 'S'],
      ['Vendas', 'V'],
      ['VENDAS', 'V'],
      ['vendás!', 'V'],
      ['  suporte tecnico ', 'S'],
      ['3', 'Fi'],
    ] as const) {
      const s = await session(env, menuDef())
      const res = await s.reply(answer)
      expect(res.advanced, `${answer}: ${JSON.stringify(res)}`).toBe(true)
      expect(s.visited, answer).toEqual([expected])
    }
    // função pura
    expect(env.core.normalizeAnswer('  Vendás! ')).toBe(env.core.normalizeAnswer('vendas'))
  })

  it('AC-T62-01 texto não reconhecido segue other; sem resposta no prazo segue timeout', async () => {
    const other = await session(env, menuDef())
    await other.reply('quero falar com alguém')
    expect(other.visited).toEqual(['O'])
    const outOfRange = await session(env, menuDef())
    await outOfRange.reply('7')
    expect(outOfRange.visited).toEqual(['O'])

    const t = await session(env, menuDef('interactive_menu', { timeout_value: 30, timeout_unit: 'minutes' }))
    expect(t.timers.at(-1)!.delayMs).toBe(30 * 60_000)
    await t.fireLastTimer()
    expect(t.visited).toEqual(['T'])
    // prazo 0 = 2 dias
    const two = await session(env, menuDef('interactive_menu', { timeout_value: 0 }))
    expect(two.timers.at(-1)!.delayMs).toBe(2 * 86_400_000)
  })

  it('AC-T62-01 o nó legado "menu" (send_option_list) segue as mesmas regras', async () => {
    const s = await session(env, menuDef('menu'))
    expect(s.sent()[0].text).toMatch(/^1 - Vendas$/m)
    await s.reply('financeiro')
    expect(s.visited).toEqual(['Fi'])
  })
})

describe('AC-T62-02 save_user_data', () => {
  it('AC-T62-02 grava o título da opção escolhida na variável e no campo do contato', async () => {
    const s = await session(env, menuDef('interactive_menu', {}, 'setor'))
    await s.reply('2')
    expect(s.visited).toEqual(['S'])
    expect((await s.run()).vars.setor).toBe('Suporte Técnico')
    expect((await customFields(env, s.contactId)).setor).toBe('Suporte Técnico')
  })

  it('AC-T62-02 em other grava o texto da resposta; no wait_response grava o texto recebido', async () => {
    const s = await session(env, menuDef('interactive_menu', {}, 'setor'))
    await s.reply('outra coisa')
    expect(s.visited).toEqual(['O'])
    expect((await customFields(env, s.contactId)).setor).toBe('outra coisa')

    const w = await session(
      env,
      def(
        [
          node('W', 'wait_response', [
            action('W-m', 'send_message', { message_text: 'Qual o seu e-mail?' }, 0),
            action('W-w', 'wait_for_response', { wait_indefinitely: false, timeout_value: 1, timeout_unit: 'hours' }, 1),
            action('W-s', 'save_user_data', { field_name: 'email_informado' }, 2),
          ]),
          marker('N'),
          marker('T'),
        ],
        [edge('start', 'source', 'W'), edge('W', 'source', 'N'), edge('W', 'timeout', 'T')],
      ),
    )
    expect(w.sent()[0]).toEqual({ text: 'Qual o seu e-mail?' })
    await w.reply('maria@example.test')
    expect(w.visited).toEqual(['N'])
    expect((await w.run()).vars.email_informado).toBe('maria@example.test')
    expect((await customFields(env, w.contactId)).email_informado).toBe('maria@example.test')
  })
})

describe('AC-T62-03 buffer do wait_response', () => {
  const bufferDef = (n: number) =>
    def(
      [
        node('W', 'wait_response', [
          action('W-w', 'wait_for_response', { wait_indefinitely: false, timeout_value: 1, timeout_unit: 'hours', buffer_enabled: true, buffer_value: n }, 0),
          action('W-s', 'save_user_data', { field_name: 'pedido' }, 1),
        ]),
        marker('N'),
        marker('T'),
      ],
      [edge('start', 'source', 'W'), edge('W', 'source', 'N'), edge('W', 'timeout', 'T')],
    )

  it('AC-T62-03 mensagens recebidas dentro dos N s viram uma só variável antes de seguir', async () => {
    const s = await session(env, bufferDef(10))
    await s.reply('quero')
    expect(s.visited).toEqual([]) // a janela do buffer está aberta
    s.clock.t += 3_000
    await s.reply('duas pizzas')
    s.clock.t += 4_000
    await s.reply('de calabresa')
    expect(s.visited).toEqual([])
    const run = await s.run()
    expect(run.status).toBe('waiting')
    // a janela vence 10 s depois da 1ª resposta
    const window = s.timers.at(-1)!
    expect(Date.parse(run.wait.deadline_at) - Date.parse('2026-10-19T13:00:00Z')).toBe(10_000)
    expect(window.delayMs).toBeLessThanOrEqual(10_000)
    s.clock.t = Date.parse('2026-10-19T13:00:10Z')
    await s.fireLastTimer()
    expect(s.visited).toEqual(['N']) // segue source, não timeout
    const after = await s.run()
    expect(after.vars.last_user_message).toBe('quero\nduas pizzas\nde calabresa')
    expect(after.vars.pedido).toBe('quero\nduas pizzas\nde calabresa')
    expect((await customFields(env, s.contactId)).pedido).toBe('quero\nduas pizzas\nde calabresa')
  })

  it('AC-T62-03 sem buffer a 1ª resposta segue na hora; sem resposta nenhuma vale o prazo geral (timeout)', async () => {
    const plain = await session(
      env,
      def(
        [node('W', 'wait_response', [action('W-w', 'wait_for_response', { wait_indefinitely: false, timeout_value: 1, timeout_unit: 'hours' })]), marker('N'), marker('T')],
        [edge('start', 'source', 'W'), edge('W', 'source', 'N'), edge('W', 'timeout', 'T')],
      ),
    )
    await plain.reply('oi')
    expect(plain.visited).toEqual(['N'])
    expect((await plain.run()).vars.last_user_message).toBe('oi')

    const silent = await session(env, bufferDef(10))
    expect(silent.timers.at(-1)!.delayMs).toBe(3_600_000)
    await silent.fireLastTimer()
    expect(silent.visited).toEqual(['T'])
  })
})

describe('AC-T62-04 carrossel', () => {
  const carouselDef = () =>
    def(
      [
        node('C', 'carousel', [
          action('C-a', 'send_carousel', {
            text: 'Escolha um plano:',
            carousel: [
              { text: 'Plano Básico', image: 'https://example.test/basico.png', buttons: [{ id: 'basico', text: 'Quero o básico', type: 'REPLY' }, { id: 'site', text: 'Ver site', type: 'URL', payload: 'https://example.test/b' }] },
              { text: 'Plano Pro', image: 'https://example.test/pro.png', buttons: [{ id: 'pro', text: 'Quero o pro', type: 'REPLY' }] },
            ],
            gatilho: { timeout_value: 2, timeout_unit: 'hours' },
          }),
        ]),
        marker('B'),
        marker('P'),
        marker('O'),
        marker('T'),
      ],
      [edge('start', 'source', 'C'), edge('C', 'option:basico', 'B'), edge('C', 'option:pro', 'P'), edge('C', 'other', 'O'), edge('C', 'timeout', 'T')],
    )

  it('AC-T62-04 envia as imagens com legenda e depois a lista numerada das opções', async () => {
    const s = await session(env, carouselDef())
    const sent = s.sent()
    expect(sent).toHaveLength(3)
    expect(sent[0]).toMatchObject({ image: { url: 'https://example.test/basico.png' } })
    expect(sent[0].caption).toContain('Plano Básico')
    expect(sent[0].caption).toContain('Ver site: https://example.test/b')
    expect(sent[1]).toMatchObject({ image: { url: 'https://example.test/pro.png' } })
    expect(sent[1].caption).toContain('Plano Pro')
    const list: string = sent[2].text
    expect(list.startsWith('Escolha um plano:')).toBe(true)
    expect(list).toMatch(/^1 - Quero o básico$/m)
    expect(list).toMatch(/^2 - Quero o pro$/m)
    expect(list).not.toMatch(/Ver site$/m) // URL não entra na lista numerada
    expect(s.timers.at(-1)!.delayMs).toBe(2 * 3_600_000)
  })

  it('AC-T62-04 os handles das opções continuam válidos (número, título) e other/timeout', async () => {
    const byNumber = await session(env, carouselDef())
    await byNumber.reply('2')
    expect(byNumber.visited).toEqual(['P'])
    const byTitle = await session(env, carouselDef())
    await byTitle.reply('quero o basico')
    expect(byTitle.visited).toEqual(['B'])
    const other = await session(env, carouselDef())
    await other.reply('nenhum')
    expect(other.visited).toEqual(['O'])
    const timeout = await session(env, carouselDef())
    await timeout.fireLastTimer()
    expect(timeout.visited).toEqual(['T'])
  })
})

describe('AC-T62-05 nada nativo', () => {
  it('AC-T62-05 com nativeButtons=false (padrão) só saem conteúdos de texto e imagem — nenhum buttonsMessage/listMessage', async () => {
    const menu = await session(env, menuDef('interactive_menu', { menuType: 'button', imageButtonEnabled: true, imageButton: 'https://example.test/banner.png' }))
    const carousel = await session(
      env,
      def(
        [node('C', 'carousel', [action('C-a', 'send_carousel', { text: 'Opções', carousel: [{ text: 'Card', image: 'https://example.test/c.png', buttons: [{ id: 'x', text: 'X', type: 'REPLY' }] }] })]), marker('X')],
        [edge('start', 'source', 'C'), edge('C', 'option:x', 'X')],
      ),
    )
    expect(menu.wa.capabilities?.nativeButtons ?? false).toBe(false)
    expect(menu.sent()[0]).toEqual({ image: { url: 'https://example.test/banner.png' } }) // imagem do botão vai antes, sem legenda
    for (const s of [menu, carousel]) {
      for (const k of kinds(s.sent())) expect(['text', 'image', 'caption+image'], k).toContain(k)
      const raw = JSON.stringify(s.wa.sent)
      expect(raw).not.toMatch(/buttonsMessage|listMessage|buttons"|sections"/)
    }
  })
})
