// AC-T86-01/02 — "Novo contato" em /customers: busca prévia de duplicados (≥ 2 caracteres, debounce 450 ms) antes do
// formulário; formulário com país + E.164, UF → cidade (limpa ao trocar a UF), CEP com máscara, etiquetas e campos
// personalizados; "Salvar e abrir conversa" leva a /chats/<id> (1 conexão: direto; várias: escolher no modal).
// Contrato de testids em spec/reports/T86-entrega.md; massa pela API (T26, etiquetas, conexões T40).
import { expect, test, type Page, type Request } from '@playwright/test'
import { loginAs, resetSeed } from '../helpers/e2e'
import { createConnection, newPhone, XRW } from '../helpers/chats-e2e'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
/** Celular BR nacional (DDD + 9 + 8 dígitos) único por execução. */
const brPhone = (ddd: string) => `${ddd}9${String(Date.now()).slice(-8)}`

async function api(page: Page, method: 'get' | 'post', path: string, data?: unknown) {
  const res = method === 'get' ? await page.request.get(path) : await page.request.post(path, { data: data ?? {}, headers: XRW })
  expect(res.status(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBeLessThan(300)
  return res.json()
}

const createContact = async (page: Page, name: string, phone = `+${newPhone()}`) =>
  (await api(page, 'post', '/api/contacts', { name, phone })).contact as { id: string; name: string; phone_e164: string }

const getContact = async (page: Page, id: string) => (await api(page, 'get', `/api/contacts/${id}`)).contact as Any

/** Contato criado pela UI: procura pelo nome único na API. */
async function contactByName(page: Page, name: string) {
  let found: Any
  await expect
    .poll(async () => {
      const body = await api(page, 'get', `/api/contacts?search=${encodeURIComponent(name)}&limit=5`)
      found = (body.items ?? []).find((c: Any) => c.name === name)
      return !!found
    })
    .toBe(true)
  return getContact(page, found.id)
}

const isSearch = (r: Request) =>
  r.method() === 'GET' && new URL(r.url()).pathname === '/api/contacts' && new URL(r.url()).searchParams.has('search')
const termOf = (r: Request) => new URL(r.url()).searchParams.get('search')

async function openContacts(page: Page) {
  await page.goto('/customers')
  await expect(page.getByTestId('page-contacts')).toBeVisible()
}

async function openNew(page: Page) {
  await page.getByTestId('contacts-new').click()
  await expect(page.getByTestId('contact-dialog')).toHaveAttribute('data-step', 'search')
}

/** Passa pela busca prévia com um termo sem duplicados e chega ao formulário de criação. */
async function toCreateForm(page: Page, name: string) {
  await openNew(page)
  await page.getByTestId('contact-search').fill(name)
  await expect(page.getByTestId('contact-search-results')).toHaveAttribute('data-state', 'empty')
  await page.getByTestId('contact-search-create').click()
  await expect(page.getByTestId('contact-dialog')).toHaveAttribute('data-step', 'create')
  await expect(page.getByTestId('contact-form')).toHaveAttribute('data-mode', 'create')
  await page.getByTestId('contact-form-name').fill(name)
}

test.describe('T86 — busca prévia do "Novo contato"', () => {
  test('AC-T86-01 menos de 2 caracteres não busca; o formulário só vem depois da busca', async ({ page }) => {
    await loginAs(page, 'owner')
    await openContacts(page)
    const terms: string[] = []
    page.on('request', (r) => {
      if (isSearch(r)) terms.push(termOf(r) ?? '')
    })
    await openNew(page)
    // passo de busca: nenhum formulário ainda
    await expect(page.getByTestId('contact-form')).toHaveCount(0)
    await expect(page.getByTestId('contact-search-results')).toHaveAttribute('data-state', 'hint')
    await page.getByTestId('contact-search').pressSequentially('A')
    await page.waitForTimeout(1_000)
    await expect(page.getByTestId('contact-search-results')).toHaveAttribute('data-state', 'hint')
    expect(terms, 'buscou com 1 caractere').toEqual([])
    await expect(page.getByTestId('contact-form')).toHaveCount(0)
  })

  test('AC-T86-01 debounce de 450 ms: uma só busca com o termo final, e os duplicados aparecem', async ({ page }) => {
    await loginAs(page, 'owner')
    const prefix = `Dup${uniq()}`
    const a = await createContact(page, `${prefix} Ana`)
    const b = await createContact(page, `${prefix} Bia`)
    const outro = await createContact(page, `Outro ${uniq()}`)
    await openContacts(page)
    await openNew(page)

    const searches: Array<{ term: string; at: number }> = []
    page.on('request', (r) => {
      if (isSearch(r)) searches.push({ term: termOf(r) ?? '', at: Date.now() })
    })
    await page.getByTestId('contact-search').pressSequentially(prefix, { delay: 80 })
    const typedAt = Date.now()
    await expect.poll(() => searches.length, { timeout: 5_000 }).toBeGreaterThan(0)
    await page.waitForTimeout(900)
    // nenhum termo parcial foi buscado (80 ms entre teclas < 450 ms); o final saiu ~450 ms depois da última tecla
    expect(searches.map((s) => s.term)).toEqual([prefix])
    expect(searches[0]!.at - typedAt).toBeGreaterThanOrEqual(350)

    await expect(page.getByTestId('contact-search-results')).toHaveAttribute('data-state', 'results')
    await expect(page.getByTestId(`contact-search-item-${a.id}`)).toBeVisible()
    await expect(page.getByTestId(`contact-search-item-${b.id}`)).toBeVisible()
    await expect(page.getByTestId(`contact-search-item-${outro.id}`)).toHaveCount(0)
    await expect(page.getByTestId(`contact-search-item-${a.id}`)).toContainText(`${prefix} Ana`)
    // o formulário ainda não abriu: os duplicados vêm antes
    await expect(page.getByTestId('contact-form')).toHaveCount(0)
  })

  test('AC-T86-01 duplicado encontrado → "Editar" abre o existente; sem duplicado → "Criar"', async ({ page }) => {
    await loginAs(page, 'owner')
    const name = `Exist${uniq()} Carla`
    const ex = await createContact(page, name, '+5511987650001')
    await openContacts(page)
    await openNew(page)
    await page.getByTestId('contact-search').fill(name)
    await expect(page.getByTestId(`contact-search-item-${ex.id}`)).toBeVisible()
    await page.getByTestId(`contact-search-edit-${ex.id}`).click()
    await expect(page.getByTestId('contact-dialog')).toHaveAttribute('data-step', 'edit')
    await expect(page.getByTestId('contact-form')).toHaveAttribute('data-mode', 'edit')
    await expect(page.getByTestId('contact-form-name')).toHaveValue(name)
    await expect(page.getByTestId('contact-form-phone')).toHaveValue(/987650001/)
    await expect(page.getByTestId('contact-form-save-open-chat')).toHaveCount(0)

    // volta para a busca e procura um nome inexistente → vazio → criar
    await page.getByTestId('contact-dialog-back').click()
    await expect(page.getByTestId('contact-dialog')).toHaveAttribute('data-step', 'search')
    const novo = `Ninguem${uniq()}`
    await page.getByTestId('contact-search').fill(novo)
    await expect(page.getByTestId('contact-search-results')).toHaveAttribute('data-state', 'empty')
    await expect(page.getByTestId('contact-search-empty')).toBeVisible()
    await page.getByTestId('contact-search-create').click()
    await expect(page.getByTestId('contact-form')).toHaveAttribute('data-mode', 'create')
  })
})

test.describe('T86 — formulário do contato', () => {
  test('AC-T86-02 telefone: validação E.164 bloqueia o salvar; seletor de país aplica o DDI', async ({ page }) => {
    await loginAs(page, 'owner')
    await openContacts(page)
    const name = `Portugal${uniq()}`
    await toCreateForm(page, name)

    // curto demais → erro no campo e salvar desabilitado
    await page.getByTestId('contact-form-phone').fill('1234')
    await expect(page.getByTestId('contact-form-phone-error')).toBeVisible()
    await expect(page.getByTestId('contact-form-save')).toBeDisabled()

    // Portugal (+351) + número nacional → salva em E.164 com o DDI do país
    await page.getByTestId('contact-form-country').selectOption('PT')
    await page.getByTestId('contact-form-phone').fill('912345678')
    await expect(page.getByTestId('contact-form-phone-error')).toHaveCount(0)
    await expect(page.getByTestId('contact-form-save')).toBeEnabled()
    const post = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/contacts')
    await page.getByTestId('contact-form-save').click()
    expect((await post).status()).toBe(201)
    await expect(page.getByTestId('contact-dialog')).toBeHidden()
    expect((await contactByName(page, name)).phone_e164).toBe('+351912345678')
  })

  test('AC-T86-02 Brasil: número nacional vira +55 e o editar mostra o país detectado', async ({ page }) => {
    await loginAs(page, 'owner')
    await openContacts(page)
    const name = `Brasil${uniq()}`
    await toCreateForm(page, name)
    await expect(page.getByTestId('contact-form-country')).toHaveValue('BR')
    await page.getByTestId('contact-form-phone').fill('(11) 98765-4321')
    await page.getByTestId('contact-form-save').click()
    await expect(page.getByTestId('contact-dialog')).toBeHidden()
    const c = await contactByName(page, name)
    expect(c.phone_e164).toBe('+5511987654321')

    // editar pela linha: país BR e o número nacional
    await page.getByTestId('contacts-search').fill(name)
    await page.getByTestId(`contacts-row-edit-${c.id}`).filter({ visible: true }).first().click()
    await expect(page.getByTestId('contact-form')).toHaveAttribute('data-mode', 'edit')
    await expect(page.getByTestId('contact-form-country')).toHaveValue('BR')
    await expect(page.getByTestId('contact-form-phone')).toHaveValue(/98765.?4321/)
  })

  test('AC-T86-02 UF → cidade: cidade desabilitada sem UF e limpa ao trocar a UF; CEP com máscara', async ({ page }) => {
    await loginAs(page, 'owner')
    await openContacts(page)
    const name = `Endereco${uniq()}`
    await toCreateForm(page, name)
    await page.getByTestId('contact-form-phone').fill(brPhone('11'))

    await expect(page.getByTestId('contact-form-city')).toBeDisabled()
    await page.getByTestId('contact-form-state').selectOption('SP')
    await expect(page.getByTestId('contact-form-city')).toBeEnabled()
    await page.getByTestId('contact-form-city').fill('Campinas')
    await page.getByTestId('contact-form-state').selectOption('RJ')
    await expect(page.getByTestId('contact-form-city')).toHaveValue('')
    await page.getByTestId('contact-form-city').fill('Niterói')

    // máscara do CEP: 8 dígitos → 00000-000 (e não aceita mais que 8)
    await page.getByTestId('contact-form-zip').fill('')
    await page.getByTestId('contact-form-zip').pressSequentially('243600009')
    await expect(page.getByTestId('contact-form-zip')).toHaveValue('24360-000')

    await page.getByTestId('contact-form-save').click()
    await expect(page.getByTestId('contact-dialog')).toBeHidden()
    const c = await contactByName(page, name)
    expect(c.state).toBe('RJ')
    expect(c.city).toBe('Niterói')
    expect(String(c.zip).replace(/\D/g, '')).toBe('24360000')
  })

  test('AC-T86-02 etiquetas e campos personalizados são salvos com o contato', async ({ page }) => {
    await loginAs(page, 'owner')
    const lb = (await api(page, 'post', '/api/labels', { name: `VIP ${uniq()}`, color: '#22c55e' })).label as { id: string; name: string }
    const outra = (await api(page, 'post', '/api/labels', { name: `Frio ${uniq()}`, color: '#3b82f6' })).label as { id: string }
    await api(page, 'post', '/api/custom-fields', { key: 'origem' })
    await openContacts(page)
    const name = `Etiquetado${uniq()}`
    await toCreateForm(page, name)
    await page.getByTestId('contact-form-phone').fill(brPhone('21'))

    const chip = page.getByTestId(`contact-form-label-${lb.id}`)
    await expect(chip).toHaveAttribute('aria-pressed', 'false')
    await chip.click()
    await expect(chip).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId(`contact-form-label-${outra.id}`)).toHaveAttribute('aria-pressed', 'false')

    await page.getByTestId('contact-form-cf-add').click()
    await page.getByTestId('contact-form-cf-0-key').fill('origem')
    await page.getByTestId('contact-form-cf-0-value').fill('site')
    await page.getByTestId('contact-form-cf-add').click()
    await page.getByTestId('contact-form-cf-1-key').fill('plano')
    await page.getByTestId('contact-form-cf-1-value').fill('ouro')
    await page.getByTestId('contact-form-cf-1-remove').click()
    await expect(page.getByTestId('contact-form-cf-1')).toHaveCount(0)

    await page.getByTestId('contact-form-save').click()
    await expect(page.getByTestId('contact-dialog')).toBeHidden()
    const c = await contactByName(page, name)
    expect(c.labels.map((l: Any) => l.id)).toEqual([lb.id])
    expect(c.custom_fields).toEqual({ origem: 'site' })
  })

  test('AC-T86-02 "Salvar e abrir conversa" com 1 conexão cria o contato e leva direto ao chat', async ({ page }) => {
    await loginAs(page, 'owner')
    await createConnection(page, `Loja ${uniq()}`)
    await openContacts(page)
    const name = `Conversa${uniq()}`
    await toCreateForm(page, name)
    await page.getByTestId('contact-form-phone').fill(brPhone('31'))
    const chatPost = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/chats')
    await page.getByTestId('contact-form-save-open-chat').click()
    const res = await chatPost
    expect(res.status()).toBeLessThan(300)
    const { chat } = await res.json()
    await expect(page).toHaveURL(new RegExp(`/chats/${chat.id}$`))
    await expect(page.getByTestId('contact-open-chat-dialog')).toHaveCount(0)
    const c = await contactByName(page, name)
    expect(chat.contact_id ?? chat.contact?.id).toBe(c.id)
  })

  test('AC-T86-02 "Salvar e abrir conversa" com várias conexões pede a conexão e abre o chat nela', async ({ page }) => {
    await loginAs(page, 'owner')
    const c1 = await createConnection(page, `Matriz ${uniq()}`)
    const c2 = await createConnection(page, `Filial ${uniq()}`)
    await openContacts(page)
    const name = `Escolha${uniq()}`
    await toCreateForm(page, name)
    await page.getByTestId('contact-form-phone').fill(brPhone('41'))
    await page.getByTestId('contact-form-save-open-chat').click()

    const dialog = page.getByTestId('contact-open-chat-dialog')
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId(`contact-open-chat-connection-${c1.id}`)).toBeVisible()
    await expect(page.getByTestId(`contact-open-chat-connection-${c2.id}`)).toBeVisible()
    await page.getByTestId(`contact-open-chat-connection-${c2.id}`).click()
    await expect(page.getByTestId(`contact-open-chat-connection-${c2.id}`)).toHaveAttribute('aria-selected', 'true')
    const chatPost = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/chats')
    await page.getByTestId('contact-open-chat-confirm').click()
    const req = await chatPost
    expect(req.postDataJSON().connection_id).toBe(c2.id)
    const { chat } = await (await req.response())!.json()
    await expect(page).toHaveURL(new RegExp(`/chats/${chat.id}$`))
    const c = await contactByName(page, name)
    expect(req.postDataJSON().contact_id).toBe(c.id)
  })
})
