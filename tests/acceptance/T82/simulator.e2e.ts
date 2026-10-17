// AC-T82-04 — painel do simulador no editor: conversa em formato de chat (balões do bot, da resposta escolhida, avisos e
// fim) e botões das respostas possíveis da espera atual; desktop e mobile (390 px, sem rolagem horizontal).
// AC-T82-01/02/03 pela UI: o rascunho roda sem chamar ninguém de fora (servidor local de "terceiros" sem nenhuma
// requisição; o navegador só fala com o próprio app), a escolha segue o handle e o loop é interrompido e marcado.
// Cenário pela API (padrão T45/T57): POST /api/flows → editor-bundle → PUT definition → /flows/<id>/edit → flow-simulate.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test, type Page } from '@playwright/test'
import { loginAs, resetSeed } from '../helpers/e2e'
import { api, newFlow } from '../T57/support'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

let hookServer: Server
let hookHits = 0
let hookUrl = ''

test.beforeAll(async () => {
  hookServer = createServer((_req, res) => {
    hookHits++
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
  })
  await new Promise<void>((r) => hookServer.listen(0, '127.0.0.1', r))
  hookUrl = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}/hook`
})
test.afterAll(async () => {
  await new Promise((r) => hookServer.close(r))
})

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

const node = (id: string, type: string, actions: Array<{ type: string; config: Record<string, unknown> }> = [], i = 1) => ({
  id,
  type,
  name: `Bloco ${id}`,
  position: { x: 260 * i, y: 0 },
  actions: actions.map((a, k) => ({ id: `${id}-a${k}`, order: k, ...a })),
})
const msg = (id: string, text: string, i = 1) => node(id, 'message', [{ type: 'send_message', config: { message_text: text } }], i)
const edge = (from: string, handle: string, to: string) => ({ id: `e-${from}-${handle}-${to}`.replace(/:/g, '_'), from, handle, to })

async function flowWith(page: Page, build: (startId: string) => { nodes: Any[]; edges: Any[] }) {
  const f = await newFlow(page)
  const { nodes, edges } = build(f.start.id)
  await api(page, 'put', `/api/flows/${f.id}/definition`, { schema: 'crm.flow/v1', entry: f.start.id, nodes: [f.start, ...nodes], edges, variables: [], refs: {} })
  return f
}

/** start → hello → notificação → etiquetas (não simulado) → menu (Vendas → v1 → v2 → v1 … loop; Suporte sem aresta). */
const menuLoopFlow = (page: Page) =>
  flowWith(page, (s) => ({
    nodes: [
      msg('hello', 'Olá! Bem-vindo à loja.', 1),
      node('notify', 'notification', [{ type: 'send_notification', config: { phone: '11999990000', message: 'Novo lead chegou' } }], 2),
      node('tags', 'tags', [{ type: 'add_tags', config: { tags: ['lead'] } }], 3),
      node('menu', 'interactive_menu', [
        { type: 'send_interactive_menu', config: { message: 'Com quem quer falar?', options: [{ id: 'o1', title: 'Vendas' }, { id: 'o2', title: 'Suporte' }] } },
      ], 4),
      msg('loop1', 'Volta um', 5),
      msg('loop2', 'Volta dois', 6),
      msg('late', 'Você demorou', 5),
    ],
    edges: [
      edge(s, 'source', 'hello'),
      edge('hello', 'source', 'notify'),
      edge('notify', 'source', 'tags'),
      edge('tags', 'source', 'menu'),
      edge('menu', 'option:o1', 'loop1'),
      edge('menu', 'timeout', 'late'),
      edge('loop1', 'source', 'loop2'),
      edge('loop2', 'source', 'loop1'),
    ],
  }))

/** Abre o editor e o simulador; registra toda requisição do navegador para fora do próprio app. */
async function openSimulator(page: Page, flowId: string) {
  const external: string[] = []
  const origin = new URL(page.url() === 'about:blank' ? test.info().project.use.baseURL! : page.url()).origin
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (!['data:', 'blob:'].includes(u.protocol) && u.origin !== origin) external.push(r.url())
  })
  await page.goto(`/flows/${flowId}/edit`)
  await expect(page.getByTestId('flow-editor')).toBeVisible()
  const button = page.getByTestId('flow-simulate')
  await expect(button).toBeVisible()
  await expect(button).toHaveAttribute('aria-expanded', 'false')
  await button.click()
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  const panel = page.getByTestId('flow-simulator')
  await expect(panel).toBeVisible()
  return { panel, external }
}

async function expectNoHorizontalScroll(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
  expect(scroll, 'rolagem horizontal da página').toBeLessThanOrEqual(client + 1)
}

async function expectInsideViewport(page: Page, testId: string) {
  const box = await page.getByTestId(testId).boundingBox()
  const vw = page.viewportSize()!.width
  expect(box, testId).not.toBeNull()
  expect(box!.x, `${testId} começa dentro da tela`).toBeGreaterThanOrEqual(-1)
  expect(box!.x + box!.width, `${testId} cabe na largura`).toBeLessThanOrEqual(vw + 1)
}

test.describe('T82 — simulador no editor', () => {
  test('AC-T82-04 conversa em chat com os botões das respostas; escolha segue o handle; loop é interrompido (desktop e mobile)', async ({ page }) => {
    await loginAs(page, 'owner')
    const f = await menuLoopFlow(page)
    const runsBefore = await page.request.get(`/api/flows/${f.id}`).then((r) => r.json())
    const { panel, external } = await openSimulator(page, f.id)
    const isMobile = page.viewportSize()!.width < 1024

    await expect(panel).toHaveAttribute('data-state', 'waiting')
    const messages = panel.getByTestId('flow-simulator-messages')
    const bots = messages.getByTestId('flow-simulator-bot')
    // balões do bot, na ordem da conversa, com o nó de origem
    await expect(bots).toHaveCount(3)
    await expect(bots.nth(0)).toHaveAttribute('data-node', 'hello')
    await expect(bots.nth(0)).toContainText('Olá! Bem-vindo à loja.')
    await expect(bots.nth(0)).toHaveAttribute('data-to', 'contact')
    await expect(bots.nth(1)).toHaveAttribute('data-node', 'notify')
    await expect(bots.nth(1)).toHaveAttribute('data-to', 'internal')
    await expect(bots.nth(1)).toContainText('Notificação para outro número')
    await expect(bots.nth(1)).toContainText('Novo lead chegou')
    await expect(bots.nth(2)).toHaveAttribute('data-node', 'menu')
    await expect(bots.nth(2)).toContainText('Com quem quer falar?')
    // aviso do nó não simulado
    const notice = messages.getByTestId('flow-simulator-notice')
    await expect(notice).toHaveCount(1)
    await expect(notice).toHaveAttribute('data-code', 'not_simulated')
    await expect(notice).toHaveAttribute('data-node', 'tags')
    await expect(notice).toContainText('ainda não é simulado. Seguindo.')

    // rodapé: tipo de espera + botões das respostas possíveis
    await expect(panel.getByTestId('flow-simulator-wait')).toHaveAttribute('data-kind', 'menu')
    const choices = panel.getByTestId('flow-simulator-choices')
    await expect(choices.getByRole('button')).toHaveCount(4)
    await expect(panel.getByTestId('flow-simulator-choice-option:o1')).toHaveText('Vendas')
    await expect(panel.getByTestId('flow-simulator-choice-option:o1')).toHaveAttribute('data-connected', 'true')
    await expect(panel.getByTestId('flow-simulator-choice-option:o2')).toHaveText('Suporte')
    await expect(panel.getByTestId('flow-simulator-choice-option:o2')).toHaveAttribute('data-connected', 'false')
    await expect(panel.getByTestId('flow-simulator-choice-other')).toHaveText('Outra resposta')
    await expect(panel.getByTestId('flow-simulator-choice-other')).toHaveAttribute('data-connected', 'false')
    await expect(panel.getByTestId('flow-simulator-choice-timeout')).toHaveText('Simular timeout')

    if (isMobile) {
      await expectNoHorizontalScroll(page)
      await expectInsideViewport(page, 'flow-simulator')
      await expectInsideViewport(page, 'flow-simulator-choices')
      await expect(panel.getByTestId('flow-simulator-choice-option:o1')).toBeInViewport()
    } else {
      // desktop: painel lateral à direita, sem cobrir o canvas inteiro
      const box = (await panel.boundingBox())!
      expect(box.width).toBeLessThan(page.viewportSize()!.width / 2)
      expect(box.x).toBeGreaterThan(page.viewportSize()!.width / 2)
      await expect(page.getByTestId('flow-canvas')).toBeVisible()
    }

    // escolher "Vendas": balão da resposta, o caminho segue a aresta option:o1 e cai no loop → interrompido
    await panel.getByTestId('flow-simulator-choice-option:o1').click()
    const user = messages.getByTestId('flow-simulator-user')
    await expect(user).toHaveCount(1)
    await expect(user).toHaveAttribute('data-handle', 'option:o1')
    await expect(user).toHaveText('Vendas')
    const interrupted = panel.getByTestId('flow-simulator-interrupted')
    await expect(interrupted).toBeVisible()
    await expect(interrupted).toHaveAttribute('data-reason', 'loop_guard')
    await expect(interrupted).toHaveAttribute('data-node', /^loop[12]$/)
    await expect(interrupted).toContainText('50 passos')
    await expect(panel).toHaveAttribute('data-state', 'finished')
    await expect(messages.locator('[data-testid="flow-simulator-bot"][data-node="loop1"]').first()).toContainText('Volta um')
    await expect(messages.locator('[data-testid="flow-simulator-bot"][data-node="menu"]')).toHaveCount(1) // o menu não reexecuta
    await expect(panel.getByTestId('flow-simulator-choices')).toHaveCount(0)
    if (isMobile) await expectNoHorizontalScroll(page)

    // reiniciar volta para a espera do menu, com a conversa nova
    await panel.getByTestId('flow-simulator-restart').click()
    await expect(panel).toHaveAttribute('data-state', 'waiting')
    await expect(messages.getByTestId('flow-simulator-user')).toHaveCount(0)
    await expect(panel.getByTestId('flow-simulator-interrupted')).toHaveCount(0)
    await expect(panel.getByTestId('flow-simulator-choice-timeout')).toBeVisible()

    // "Simular timeout" segue o handle timeout
    await panel.getByTestId('flow-simulator-choice-timeout').click()
    await expect(messages.getByTestId('flow-simulator-user')).toHaveAttribute('data-handle', 'timeout')
    await expect(messages.locator('[data-testid="flow-simulator-bot"][data-node="late"]')).toContainText('Você demorou')
    await expect(panel.getByTestId('flow-simulator-end')).toHaveAttribute('data-reason', 'no_next')

    // fechar remove o painel; nada do fluxo mudou e o navegador não falou com ninguém de fora
    await panel.getByTestId('flow-simulator-close').click()
    await expect(page.getByTestId('flow-simulator')).toHaveCount(0)
    await expect(page.getByTestId('flow-simulate')).toHaveAttribute('aria-expanded', 'false')
    const after = await page.request.get(`/api/flows/${f.id}`).then((r) => r.json())
    expect(after.flow.status).toBe(runsBefore.flow.status)
    expect(external, 'requisições do navegador para fora do app').toEqual([])
  })

  test('AC-T82-04 aguardar resposta: campo de texto vira o balão do contato e a resposta segue no fluxo (desktop e mobile)', async ({ page }) => {
    await loginAs(page, 'owner')
    const f = await flowWith(page, (s) => ({
      nodes: [
        msg('ask', 'Qual é o seu nome?', 1),
        node('w', 'wait_response', [{ type: 'wait_for_response', config: { timeout_value: 10, timeout_unit: 'minutes' } }], 2),
        msg('echo', 'Prazer, {response}!', 3),
      ],
      edges: [edge(s, 'source', 'ask'), edge('ask', 'source', 'w'), edge('w', 'source', 'echo')],
    }))
    const { panel } = await openSimulator(page, f.id)
    await expect(panel).toHaveAttribute('data-state', 'waiting')
    await expect(panel.getByTestId('flow-simulator-wait')).toHaveAttribute('data-kind', 'wait_response')
    await expect(panel.getByTestId('flow-simulator-choice-timeout')).toHaveText('Simular timeout')
    await expect(panel.getByTestId('flow-simulator-choice-timeout')).toHaveAttribute('data-connected', 'false')
    const input = panel.getByTestId('flow-simulator-input')
    await expect(input).toBeVisible()
    await expect(panel.getByTestId('flow-simulator-send')).toBeDisabled()
    if (page.viewportSize()!.width < 1024) {
      await expectNoHorizontalScroll(page)
      await expectInsideViewport(page, 'flow-simulator-input')
    }
    await input.fill('Bruna')
    await panel.getByTestId('flow-simulator-send').click()
    const messages = panel.getByTestId('flow-simulator-messages')
    await expect(messages.getByTestId('flow-simulator-user')).toHaveText('Bruna')
    await expect(messages.getByTestId('flow-simulator-user')).toHaveAttribute('data-handle', 'source')
    await expect(messages.locator('[data-testid="flow-simulator-bot"][data-node="echo"]')).toContainText('Prazer, Bruna!')
    await expect(panel).toHaveAttribute('data-state', 'finished')
    await expect(panel.getByTestId('flow-simulator-end')).toHaveAttribute('data-reason', 'no_next')
  })

  test('AC-T82-02 condição, integração e IA viram botões Sucesso/Falha/saídas; nenhuma chamada externa sai', async ({ page }) => {
    await loginAs(page, 'owner')
    hookHits = 0
    const f = await flowWith(page, (s) => ({
      nodes: [
        node('cond', 'condition', [{ type: 'evaluate_condition', config: { ruleType: 'all', conditions: [] } }], 1),
        node('http', 'integration', [{ type: 'make_http_request', config: { request_method: 'POST', request_url: hookUrl, request_body: '{"a":1}' } }], 2),
        node('ai', 'ai', [{ type: 'ai_call', config: { user_message: 'oi', output_conditions: [{ output_key: 'compra', prompt: 'Quer comprar' }] } }], 3),
        msg('buy', 'Vamos fechar!', 4),
        msg('fail', 'Deu ruim', 4),
      ],
      edges: [
        edge(s, 'source', 'cond'),
        edge('cond', 'success', 'http'),
        edge('cond', 'failure', 'fail'),
        edge('http', 'success', 'ai'),
        edge('http', 'failure', 'fail'),
        edge('ai', 'output:compra', 'buy'),
      ],
    }))
    const { panel, external } = await openSimulator(page, f.id)
    const wait = panel.getByTestId('flow-simulator-wait')
    await expect(wait).toHaveAttribute('data-kind', 'condition_choice')
    await expect(panel.getByTestId('flow-simulator-choice-success')).toHaveText('Sucesso')
    await expect(panel.getByTestId('flow-simulator-choice-failure')).toHaveText('Falha')
    await panel.getByTestId('flow-simulator-choice-success').click()

    await expect(wait).toHaveAttribute('data-kind', 'integration_choice')
    await panel.getByTestId('flow-simulator-choice-success').click()

    await expect(wait).toHaveAttribute('data-kind', 'ai_choice')
    await expect(panel.getByTestId('flow-simulator-choice-output:compra')).toContainText('Quer comprar')
    await expect(panel.getByTestId('flow-simulator-choice-failure')).toHaveAttribute('data-connected', 'false')
    await panel.getByTestId('flow-simulator-choice-output:compra').click()

    const messages = panel.getByTestId('flow-simulator-messages')
    await expect(messages.locator('[data-testid="flow-simulator-bot"][data-node="buy"]')).toContainText('Vamos fechar!')
    await expect(messages.getByTestId('flow-simulator-user')).toHaveCount(3)
    await expect(messages.locator('[data-testid="flow-simulator-user"]').nth(0)).toHaveAttribute('data-handle', 'success')
    await expect(messages.locator('[data-testid="flow-simulator-user"]').nth(2)).toHaveAttribute('data-handle', 'output:compra')
    await expect(panel).toHaveAttribute('data-state', 'finished')

    // reiniciar e seguir pela falha da condição
    await panel.getByTestId('flow-simulator-restart').click()
    await expect(wait).toHaveAttribute('data-kind', 'condition_choice')
    await panel.getByTestId('flow-simulator-choice-failure').click()
    await expect(messages.locator('[data-testid="flow-simulator-bot"][data-node="fail"]')).toContainText('Deu ruim')

    expect(hookHits, 'o nó Integração não pode fazer o HTTP real').toBe(0)
    expect(external, 'requisições do navegador para fora do app').toEqual([])
    const runs = await page.request.get(`/api/flows/${f.id}/runs`)
    if (runs.ok()) {
      const body = await runs.json()
      expect((body.items ?? body.runs ?? []).length, 'simular não grava runs').toBe(0)
    }
  })

  test('AC-T82-03 caminho acima de 50 passos aparece interrompido no painel com o bloco onde parou', async ({ page }) => {
    await loginAs(page, 'owner')
    const f = await flowWith(page, (s) => {
      const nodes = Array.from({ length: 55 }, (_, i) => msg(`m${i}`, `Passo ${i}`, i + 1))
      return { nodes, edges: [edge(s, 'source', 'm0'), ...nodes.slice(1).map((_, i) => edge(`m${i}`, 'source', `m${i + 1}`))] }
    })
    const { panel } = await openSimulator(page, f.id)
    const interrupted = panel.getByTestId('flow-simulator-interrupted')
    await expect(interrupted).toBeVisible()
    await expect(interrupted).toHaveAttribute('data-reason', 'loop_guard')
    await expect(interrupted).toHaveAttribute('data-node', /^m\d+$/)
    await expect(panel).toHaveAttribute('data-state', 'finished')
    const bots = await panel.getByTestId('flow-simulator-bot').count()
    expect(bots).toBeGreaterThan(40)
    expect(bots).toBeLessThan(55)
    await expect(panel.getByTestId('flow-simulator-end')).toHaveCount(0)
  })
})
