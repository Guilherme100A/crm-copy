// Apoio dos E2E da T57 (editores de nó de lógica, CRM e externos): fluxo criado pela API com UM nó do tipo pedido
// ligado ao início, abertura do editor (`/flows/<id>/edit` → clicar o nó → `flow-node-editor`) e releitura da definição
// pelo `editor-bundle` (padrão de tests/acceptance/T45/editor.e2e.ts; contrato em spec/reports/T57-entrega.md).
import { expect, type Locator, type Page } from '@playwright/test'
import { XRW } from '../helpers/chats-e2e'

export const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

export async function api(page: Page, method: 'get' | 'post' | 'put' | 'patch', path: string, data?: unknown) {
  const res = method === 'get' ? await page.request.get(path) : await page.request[method](path, { data: data ?? {}, headers: XRW })
  expect(res.status(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBeLessThan(300)
  return res.json()
}

export const bundle = async (page: Page, flowId: string) => (await api(page, 'get', `/api/flows/${flowId}/editor-bundle`)).definition

export async function newFlow(page: Page, name = `Fluxo ${uniq()}`) {
  const body = await api(page, 'post', '/api/flows', { name })
  const id = (body.flow ?? body).id as string
  const def = await bundle(page, id)
  const start = def.nodes.find((n: any) => n.type === 'start')
  return { id, name, start }
}

/** Fluxo com o nó `nodeId` do `type` (ações dadas; `[]` = recém-saído da paleta) ligado ao início. */
export async function flowWithNode(page: Page, type: string, actions: unknown[] = [], nodeId = 'n1', extra: { nodes?: any[]; edges?: any[] } = {}) {
  const f = await newFlow(page)
  await api(page, 'put', `/api/flows/${f.id}/definition`, {
    schema: 'crm.flow/v1',
    entry: f.start.id,
    nodes: [f.start, { id: nodeId, type, name: `Nó ${type}`, position: { x: 320, y: 0 }, actions }, ...(extra.nodes ?? [])],
    edges: [{ id: 'e1', from: f.start.id, handle: 'source', to: nodeId }, ...(extra.edges ?? [])],
    variables: [],
    refs: {},
  })
  return f
}

/** Abre o editor do fluxo, seleciona o nó e devolve o painel `flow-node-editor`. */
export async function openNode(page: Page, flowId: string, nodeId = 'n1'): Promise<Locator> {
  await page.goto(`/flows/${flowId}/edit`)
  await expect(page.getByTestId('flow-editor')).toBeVisible()
  const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`)
  await expect(node).toBeVisible()
  await node.click()
  const panel = page.getByTestId('flow-node-editor').filter({ visible: true })
  await expect(panel).toBeVisible()
  return panel
}

export async function waitSaved(page: Page) {
  await expect(page.getByTestId('flow-save-status')).toHaveAttribute('data-state', 'saved', { timeout: 15_000 })
}

/** Config da 1ª ação (do tipo, se dado) do nó salvo, relida do servidor quando o autosave terminar. */
export async function savedNode(page: Page, flowId: string, nodeId = 'n1') {
  await waitSaved(page)
  return (await bundle(page, flowId)).nodes.find((n: any) => n.id === nodeId)
}

export function pollConfig(page: Page, flowId: string, actionType: string, nodeId = 'n1') {
  return expect.poll(async () => {
    const node = (await bundle(page, flowId)).nodes.find((n: any) => n.id === nodeId)
    return node?.actions?.find((a: any) => a.type === actionType)?.config ?? null
  }, { timeout: 15_000 })
}

/** Valores das opções de um `<select>` (sem a opção vazia do placeholder). */
export const optionValues = (select: Locator) =>
  select.locator('option').evaluateAll((els) => (els as HTMLOptionElement[]).map((o) => o.value).filter((v) => v !== ''))

export const enabledOptionValues = (select: Locator) =>
  select.locator('option').evaluateAll((els) => (els as HTMLOptionElement[]).filter((o) => !o.disabled).map((o) => o.value).filter((v) => v !== ''))

export async function expectStatus(panel: Locator, state: 'saved' | 'blocked') {
  await expect(panel.getByTestId('ne-status')).toHaveAttribute('data-state', state)
}

/** Operadores oferecidos (opções `ne-cond-<i>-operator-<op>`; um valor salvo fora da lista aparece sem testid). */
export const offeredOperators = (select: Locator) =>
  select.locator('option[data-testid]').evaluateAll((els) => (els as HTMLOptionElement[]).map((o) => o.value))
