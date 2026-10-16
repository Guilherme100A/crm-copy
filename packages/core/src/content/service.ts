// Conteúdo reutilizável (T35): respostas rápidas, modelos internos, variáveis globais e figurinhas, mais a prévia
// com as variáveis do contato e as globais (T11). Tudo por empresa; recurso de outra empresa = não encontrado.
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import {
  companies,
  contacts,
  globalVariables,
  messageTemplates,
  QUICK_REPLY_ACTION_TYPES,
  quickReplies,
  quickReplyActions,
  stickerFavorites,
  stickers,
  type Database,
  type QuickReplyActionType,
} from '@crm/db'
import { buildPageMeta, pageOffset, type PageMeta } from '@crm/shared'
import { isUniqueViolation } from '../auth/errors'
import { baseMime, type MediaService } from '../media/service'
import { render, type TemplateContact } from '../templating/render'
import {
  ContentError,
  SHORTCUT_MAX,
  TEMPLATE_BUTTON_TYPES,
  TEMPLATE_HEADER_TYPES,
  assertGlobalValue,
  contentInvalid,
  contentNotFound,
  globalVariableName,
  globalVariableType,
  normalizeShortcut,
  renderTemplateContent,
  type TemplateButton,
  type TemplateContent,
  type TemplateHeader,
} from './rules'

export const STICKER_MIME = 'image/webp'
/** 100 KB (17 §3A: sticker image/webp até 100 KB). */
export const STICKER_MAX_BYTES = 100 * 1024
const MAX_ACTIONS = 20
const MAX_BUTTONS = 10
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)
const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
type Page = { page?: number; limit?: number }
const pageOf = (p: Page) => ({ page: p.page ?? 1, limit: p.limit ?? 20 })

export interface ActionInput {
  type: string
  order?: number
  config: Record<string, unknown>
}

export interface QuickReplyDto {
  id: string
  shortcut: string
  actions: { id: string; type: QuickReplyActionType; order: number; config: Record<string, unknown> }[]
  preview: string
  created_at: string
  updated_at: string
}

export interface TemplateDto extends TemplateContent {
  id: string
  name: string
  created_at: string
  updated_at: string
}

export interface GlobalVariableDto {
  id: string
  name: string
  description: string | null
  type: 'text' | 'number'
  value: string | null
  created_at: string
  updated_at: string
}

export interface StickerDto {
  id: string
  name: string
  media_id: string
  url: string
  mime: string
  size: number
  favorite: boolean
  created_at: string
}

export interface ContentServiceOptions {
  db: Database
  media: MediaService
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

export class ContentService {
  private readonly db: Database
  private readonly media: MediaService

  constructor(opts: ContentServiceOptions) {
    this.db = opts.db
    this.media = opts.media
  }

  // ---------------------------------------------------------------- respostas rápidas

  async listQuickReplies(companyId: string, q: Page & { search?: string; type?: string }): Promise<{ items: QuickReplyDto[]; page: PageMeta }> {
    const conds = [eq(quickReplies.companyId, companyId)]
    const term = q.search?.trim()
    if (term)
      conds.push(
        or(
          ilike(quickReplies.shortcut, like(term.toLowerCase())),
          sql`exists (select 1 from ${quickReplyActions} where ${quickReplyActions.quickReplyId} = ${quickReplies.id} and ${quickReplyActions.config} ->> 'message_text' ilike ${like(term)})`,
        )!,
      )
    if (q.type) conds.push(sql`exists (select 1 from ${quickReplyActions} where ${quickReplyActions.quickReplyId} = ${quickReplies.id} and ${quickReplyActions.type} = ${q.type})`)
    const page = pageOf(q)
    const [total] = await this.db.select({ n: count() }).from(quickReplies).where(and(...conds))
    const rows = await this.db
      .select()
      .from(quickReplies)
      .where(and(...conds))
      .orderBy(asc(quickReplies.shortcut))
      .limit(page.limit)
      .offset(pageOffset(page))
    return { items: await this.quickReplyDtos(rows), page: buildPageMeta(page, { total: Number(total?.n ?? 0) }) }
  }

  async getQuickReply(companyId: string, id: string): Promise<QuickReplyDto> {
    return (await this.quickReplyDtos([await this.quickReplyRow(companyId, id)]))[0]!
  }

  async createQuickReply(companyId: string, userId: string | null, input: { shortcut: string; actions: ActionInput[] }): Promise<QuickReplyDto> {
    const shortcut = this.shortcut(input.shortcut)
    const actions = await this.validateActions(companyId, input.actions)
    const id = await this.uniqueShortcut(async () =>
      this.db.transaction(async (tx) => {
        const [row] = await tx.insert(quickReplies).values({ companyId, shortcut, createdByUserId: userId }).returning({ id: quickReplies.id })
        await tx.insert(quickReplyActions).values(actions.map((a) => ({ companyId, quickReplyId: row!.id, ...a })))
        return row!.id
      }),
    )
    return this.getQuickReply(companyId, id)
  }

  /** `actions` substitui a lista inteira (na ordem enviada). */
  async updateQuickReply(companyId: string, id: string, input: { shortcut?: string; actions?: ActionInput[] }): Promise<QuickReplyDto> {
    const row = await this.quickReplyRow(companyId, id)
    const shortcut = input.shortcut === undefined ? undefined : this.shortcut(input.shortcut)
    const actions = input.actions === undefined ? undefined : await this.validateActions(companyId, input.actions)
    await this.uniqueShortcut(() =>
      this.db.transaction(async (tx) => {
        await tx
          .update(quickReplies)
          .set({ ...(shortcut !== undefined ? { shortcut } : {}), updatedAt: new Date() })
          .where(eq(quickReplies.id, row.id))
        if (actions) {
          await tx.delete(quickReplyActions).where(eq(quickReplyActions.quickReplyId, row.id))
          await tx.insert(quickReplyActions).values(actions.map((a) => ({ companyId, quickReplyId: row.id, ...a })))
        }
      }),
    )
    return this.getQuickReply(companyId, row.id)
  }

  async deleteQuickReply(companyId: string, id: string): Promise<void> {
    const row = await this.quickReplyRow(companyId, id)
    await this.db.delete(quickReplies).where(eq(quickReplies.id, row.id))
  }

  // ---------------------------------------------------------------- modelos

  async listTemplates(companyId: string, q: Page & { search?: string }): Promise<{ items: TemplateDto[]; page: PageMeta }> {
    const conds = [eq(messageTemplates.companyId, companyId)]
    if (q.search?.trim()) conds.push(or(ilike(messageTemplates.name, like(q.search.trim())), ilike(messageTemplates.body, like(q.search.trim())))!)
    const page = pageOf(q)
    const [total] = await this.db.select({ n: count() }).from(messageTemplates).where(and(...conds))
    const rows = await this.db
      .select()
      .from(messageTemplates)
      .where(and(...conds))
      .orderBy(asc(messageTemplates.name))
      .limit(page.limit)
      .offset(pageOffset(page))
    return { items: rows.map(toTemplate), page: buildPageMeta(page, { total: Number(total?.n ?? 0) }) }
  }

  async getTemplate(companyId: string, id: string): Promise<TemplateDto> {
    return toTemplate(await this.templateRow(companyId, id))
  }

  async createTemplate(companyId: string, userId: string | null, input: { name: string } & Partial<TemplateContent>): Promise<TemplateDto> {
    const name = input.name?.trim()
    if (!name) throw contentInvalid('name', 'Nome obrigatório')
    const content = await this.validateTemplate(companyId, { header: input.header ?? { type: 'none' }, body: input.body ?? '', footer: input.footer ?? null, buttons: input.buttons ?? [] })
    const row = await this.uniqueName('message_templates_company_name_uq', () =>
      this.db
        .insert(messageTemplates)
        .values({ companyId, name, header: content.header as unknown as Record<string, unknown>, body: content.body, footer: content.footer ?? null, buttons: content.buttons as unknown as Record<string, unknown>[], createdByUserId: userId })
        .returning(),
    )
    return toTemplate(row[0]!)
  }

  async updateTemplate(companyId: string, id: string, input: { name?: string } & Partial<TemplateContent>): Promise<TemplateDto> {
    const current = toTemplate(await this.templateRow(companyId, id))
    const name = input.name === undefined ? undefined : input.name.trim()
    if (name === '') throw contentInvalid('name', 'Nome obrigatório')
    const content = await this.validateTemplate(companyId, {
      header: input.header ?? current.header,
      body: input.body ?? current.body,
      footer: input.footer !== undefined ? input.footer : current.footer,
      buttons: input.buttons ?? current.buttons,
    })
    const row = await this.uniqueName('message_templates_company_name_uq', () =>
      this.db
        .update(messageTemplates)
        .set({
          ...(name !== undefined ? { name } : {}),
          header: content.header as unknown as Record<string, unknown>,
          body: content.body,
          footer: content.footer ?? null,
          buttons: content.buttons as unknown as Record<string, unknown>[],
          updatedAt: new Date(),
        })
        .where(eq(messageTemplates.id, current.id))
        .returning(),
    )
    return toTemplate(row[0]!)
  }

  async deleteTemplate(companyId: string, id: string): Promise<void> {
    const row = await this.templateRow(companyId, id)
    await this.db.delete(messageTemplates).where(eq(messageTemplates.id, row.id))
  }

  // ---------------------------------------------------------------- variáveis globais

  async listGlobals(companyId: string, q: Page & { search?: string }): Promise<{ items: GlobalVariableDto[]; page: PageMeta }> {
    const conds = [eq(globalVariables.companyId, companyId)]
    if (q.search?.trim()) conds.push(or(ilike(globalVariables.name, like(q.search.trim())), ilike(globalVariables.description, like(q.search.trim())))!)
    const page = pageOf(q)
    const [total] = await this.db.select({ n: count() }).from(globalVariables).where(and(...conds))
    const rows = await this.db
      .select()
      .from(globalVariables)
      .where(and(...conds))
      .orderBy(asc(globalVariables.name))
      .limit(page.limit)
      .offset(pageOffset(page))
    return { items: rows.map(toGlobal), page: buildPageMeta(page, { total: Number(total?.n ?? 0) }) }
  }

  async getGlobal(companyId: string, id: string): Promise<GlobalVariableDto> {
    return toGlobal(await this.globalRow(companyId, id))
  }

  async createGlobal(companyId: string, input: { name: string; description?: string | null; type?: string; value?: string | number | null }): Promise<GlobalVariableDto> {
    const name = globalVariableName(input.name)
    const type = globalVariableType(input.type) ?? 'text'
    const value = input.value === undefined || input.value === null ? null : String(input.value)
    assertGlobalValue(type, value)
    const row = await this.uniqueName('global_variables_company_name_uq', () =>
      this.db
        .insert(globalVariables)
        .values({ companyId, name, description: input.description?.trim() || null, type, value: value === null ? null : value.trim() || null })
        .returning(),
    )
    return toGlobal(row[0]!)
  }

  /** Nome imutável (o fluxo referencia `{g_…}`); mudar para número exige valor numérico. */
  async updateGlobal(companyId: string, id: string, input: { name?: unknown; description?: string | null; type?: string; value?: string | number | null }): Promise<GlobalVariableDto> {
    const current = await this.globalRow(companyId, id)
    if (input.name !== undefined && input.name !== current.name) throw contentInvalid('name', 'O nome da variável não pode ser alterado', 'name_immutable')
    const type = globalVariableType(input.type) ?? current.type
    const value = input.value === undefined ? current.value : input.value === null ? null : String(input.value).trim() || null
    assertGlobalValue(type, value)
    const [row] = await this.db
      .update(globalVariables)
      .set({ ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}), type, value, updatedAt: new Date() })
      .where(eq(globalVariables.id, current.id))
      .returning()
    return toGlobal(row!)
  }

  async deleteGlobal(companyId: string, id: string): Promise<void> {
    const row = await this.globalRow(companyId, id)
    await this.db.delete(globalVariables).where(eq(globalVariables.id, row.id))
  }

  /** Mapa `g_nome → valor` para o templating (número vira number). */
  async globalsMap(companyId: string): Promise<Record<string, unknown>> {
    const rows = await this.db.select().from(globalVariables).where(eq(globalVariables.companyId, companyId))
    return Object.fromEntries(rows.map((r) => [r.name, r.type === 'number' && r.value !== null ? Number(r.value) : (r.value ?? '')]))
  }

  // ---------------------------------------------------------------- figurinhas

  async listStickers(companyId: string, userId: string | null, q: { favorites?: boolean } = {}): Promise<StickerDto[]> {
    const favs = userId
      ? new Set(
          (await this.db.select({ id: stickerFavorites.stickerId }).from(stickerFavorites).where(and(eq(stickerFavorites.companyId, companyId), eq(stickerFavorites.userId, userId)))).map(
            (r) => r.id,
          ),
        )
      : new Set<string>()
    if (q.favorites && favs.size === 0) return []
    const rows = await this.db
      .select()
      .from(stickers)
      .where(and(eq(stickers.companyId, companyId), q.favorites ? inArray(stickers.id, [...favs]) : undefined))
      .orderBy(desc(stickers.createdAt), asc(stickers.id))
    return rows.map((r) => toSticker(r, favs.has(r.id)))
  }

  /** Só `image/webp` (415) até 100 KB (413). Sem conversão (decisão em docs/content.md). */
  async uploadSticker(companyId: string, userId: string | null, input: { data: Uint8Array; mime: string; name?: string | null; fileName?: string | null }): Promise<StickerDto> {
    if (baseMime(input.mime) !== STICKER_MIME) throw new ContentError('unsupported_media', 'Figurinha deve ser image/webp', 'sticker_not_webp', { mime: input.mime })
    if (input.data.byteLength > STICKER_MAX_BYTES)
      throw new ContentError('payload_too_large', 'Figurinha acima de 100 KB', 'sticker_too_large', { limit: STICKER_MAX_BYTES, size: input.data.byteLength })
    if (input.data.byteLength === 0) throw contentInvalid('file', 'Arquivo vazio')
    const info = await this.media.store(companyId, input.data, STICKER_MIME, input.fileName ?? null)
    const name = input.name?.trim() || input.fileName?.replace(/\.[^.]+$/, '') || 'sticker'
    const [row] = await this.db.insert(stickers).values({ companyId, name, mediaId: info.id, mime: STICKER_MIME, size: info.size, createdByUserId: userId }).returning()
    return toSticker(row!, false)
  }

  async deleteSticker(companyId: string, id: string): Promise<void> {
    const row = await this.stickerRow(companyId, id)
    await this.db.delete(stickers).where(eq(stickers.id, row.id))
  }

  /** Favorita/desfavorita para o usuário (idempotente). */
  async setFavorite(companyId: string, userId: string, id: string, favorite: boolean): Promise<StickerDto> {
    const row = await this.stickerRow(companyId, id)
    if (favorite) await this.db.insert(stickerFavorites).values({ companyId, stickerId: row.id, userId }).onConflictDoNothing()
    else await this.db.delete(stickerFavorites).where(and(eq(stickerFavorites.stickerId, row.id), eq(stickerFavorites.userId, userId)))
    return toSticker(row, favorite)
  }

  // ---------------------------------------------------------------- prévia

  /**
   * Prévia com as variáveis do contato (T11) e as globais da empresa: texto livre, um modelo (texto montado + mídia
   * do cabeçalho) ou uma resposta rápida (textos das ações interpolados).
   */
  async preview(
    companyId: string,
    input: { template?: string; templateId?: string; quickReplyId?: string; contactId?: string | null },
  ): Promise<{ text: string; media: { type: string; media_id: string } | null; actions?: QuickReplyDto['actions'] }> {
    const contact = input.contactId ? await this.contact(companyId, input.contactId) : null
    const [company] = await this.db.select({ tz: companies.timeZone }).from(companies).where(eq(companies.id, companyId))
    const globals = await this.globalsMap(companyId)
    const interpolate = (s: string) => render(s, { contact, globals }, { timeZone: company?.tz })
    if (input.templateId) {
      const t = await this.getTemplate(companyId, input.templateId)
      return renderTemplateContent(t, interpolate)
    }
    if (input.quickReplyId) {
      const qr = await this.getQuickReply(companyId, input.quickReplyId)
      const actions = qr.actions.map((a) => ({
        ...a,
        config: {
          ...a.config,
          ...(typeof a.config.message_text === 'string' ? { message_text: interpolate(a.config.message_text) } : {}),
          ...(typeof a.config.caption === 'string' ? { caption: interpolate(a.config.caption) } : {}),
        },
      }))
      const firstText = actions.find((a) => a.type === 'send_message')?.config.message_text
      return { text: typeof firstText === 'string' ? firstText : '', media: null, actions }
    }
    if (typeof input.template !== 'string') throw contentInvalid('template', 'Informe template, template_id ou quick_reply_id')
    return { text: interpolate(input.template), media: null }
  }

  // ---------------------------------------------------------------- internos

  private shortcut(raw: string): string {
    const s = normalizeShortcut(raw ?? '')
    if (!s) throw contentInvalid('shortcut', 'Use apenas letras minúsculas, números, hífens, underscores e espaços')
    if (s.length > SHORTCUT_MAX) throw contentInvalid('shortcut', `Atalho com no máximo ${SHORTCUT_MAX} caracteres`)
    return s
  }

  private async uniqueShortcut<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (isUniqueViolation(err, 'quick_replies_company_shortcut_uq'))
        throw new ContentError('conflict', 'Já existe uma resposta rápida com este atalho', 'shortcut_taken', { fields: [{ path: 'shortcut', message: 'atalho já usado' }] })
      throw err
    }
  }

  private async uniqueName<T>(constraint: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (isUniqueViolation(err, constraint)) throw new ContentError('conflict', 'Nome já usado nesta empresa', 'name_taken', { fields: [{ path: 'name', message: 'nome já usado' }] })
      throw err
    }
  }

  /** ≥ 1 ação; cada tipo com a sua config; mídia e figurinha precisam ser da empresa. Ordem final 0..n−1. */
  private async validateActions(companyId: string, input: ActionInput[]) {
    if (!Array.isArray(input) || input.length === 0) throw contentInvalid('actions', 'Adicione pelo menos uma ação de conteúdo válida.')
    if (input.length > MAX_ACTIONS) throw contentInvalid('actions', `No máximo ${MAX_ACTIONS} ações`)
    const out: { type: QuickReplyActionType; order: number; config: Record<string, unknown> }[] = []
    const sorted = input.map((a, i) => ({ a, i })).sort((x, y) => (x.a.order ?? x.i) - (y.a.order ?? y.i))
    for (const [order, { a, i }] of sorted.entries()) {
      const path = `actions.${i}`
      if (!(QUICK_REPLY_ACTION_TYPES as readonly string[]).includes(a.type)) throw contentInvalid(`${path}.type`, 'Tipo de ação inválido')
      const c = a.config ?? {}
      const type = a.type as QuickReplyActionType
      let config: Record<string, unknown>
      if (type === 'send_message') {
        if (!str(c.message_text).trim()) throw contentInvalid(`${path}.config.message_text`, 'Texto obrigatório')
        config = { message_text: str(c.message_text) }
      } else if (type === 'send_multi_media') {
        const mediaType = str(c.media_type)
        if (!['image', 'video', 'audio', 'document'].includes(mediaType)) throw contentInvalid(`${path}.config.media_type`, 'Tipo de mídia inválido')
        const info = await this.media.info(companyId, str(c.media_id)).catch(() => null)
        if (!info) throw contentInvalid(`${path}.config.media_id`, 'Mídia não encontrada')
        if (info.kind !== mediaType) throw contentInvalid(`${path}.config.media_type`, `A mídia enviada é ${info.kind}`)
        config = { media_type: mediaType, media_id: str(c.media_id), ...(str(c.caption) ? { caption: str(c.caption) } : {}) }
      } else if (type === 'send_sticker') {
        if (!isUuid(c.sticker_id)) throw contentInvalid(`${path}.config.sticker_id`, 'Figurinha inválida')
        const [s] = await this.db.select({ id: stickers.id }).from(stickers).where(and(eq(stickers.id, c.sticker_id), eq(stickers.companyId, companyId)))
        if (!s) throw contentInvalid(`${path}.config.sticker_id`, 'Figurinha não encontrada')
        config = { sticker_id: s.id }
      } else {
        if (!str(c.contact_name).trim()) throw contentInvalid(`${path}.config.contact_name`, 'Nome do contato obrigatório')
        if (!str(c.contact_phone).trim()) throw contentInvalid(`${path}.config.contact_phone`, 'Telefone obrigatório')
        config = { contact_name: str(c.contact_name).trim(), contact_phone: str(c.contact_phone).trim() }
      }
      out.push({ type, order, config })
    }
    return out
  }

  private async validateTemplate(companyId: string, t: TemplateContent): Promise<TemplateContent> {
    const header = (t.header ?? { type: 'none' }) as TemplateHeader
    if (!(TEMPLATE_HEADER_TYPES as readonly string[]).includes(header.type)) throw contentInvalid('header.type', 'Tipo de cabeçalho inválido')
    let h: TemplateHeader = { type: header.type }
    if (header.type === 'text') {
      if (!str(header.text).trim()) throw contentInvalid('header.text', 'Texto do cabeçalho obrigatório')
      if (str(header.text).length > 60) throw contentInvalid('header.text', 'Cabeçalho com no máximo 60 caracteres')
      h = { type: 'text', text: str(header.text) }
    } else if (header.type !== 'none') {
      const info = await this.media.info(companyId, str(header.media_id)).catch(() => null)
      if (!info) throw contentInvalid('header.media_id', 'Mídia não encontrada')
      if (info.kind !== header.type) throw contentInvalid('header.type', `A mídia enviada é ${info.kind}`)
      h = { type: header.type, media_id: str(header.media_id) }
    }
    if (!str(t.body).trim()) throw contentInvalid('body', 'Corpo obrigatório')
    if (str(t.body).length > 4096) throw contentInvalid('body', 'Corpo com no máximo 4096 caracteres')
    if (t.footer && str(t.footer).length > 60) throw contentInvalid('footer', 'Rodapé com no máximo 60 caracteres')
    const buttons = Array.isArray(t.buttons) ? t.buttons : []
    if (buttons.length > MAX_BUTTONS) throw contentInvalid('buttons', `No máximo ${MAX_BUTTONS} botões`)
    const out: TemplateButton[] = buttons.map((b, i) => {
      if (!(TEMPLATE_BUTTON_TYPES as readonly string[]).includes(b?.type)) throw contentInvalid(`buttons.${i}.type`, 'Tipo de botão inválido')
      if (!str(b.text).trim()) throw contentInvalid(`buttons.${i}.text`, 'Texto do botão obrigatório')
      if (b.type === 'url' && !/^https?:\/\/\S+$/i.test(str(b.url))) throw contentInvalid(`buttons.${i}.url`, 'URL inválida (http/https)')
      if (b.type === 'phone' && !/^\+?\d{8,15}$/.test(str(b.phone).replace(/[\s()-]/g, ''))) throw contentInvalid(`buttons.${i}.phone`, 'Telefone inválido (com DDI)')
      return { type: b.type, text: str(b.text).trim(), ...(b.type === 'url' ? { url: str(b.url) } : {}), ...(b.type === 'phone' ? { phone: str(b.phone) } : {}) }
    })
    return { header: h, body: str(t.body), footer: t.footer ? str(t.footer) : null, buttons: out }
  }

  private async contact(companyId: string, id: string): Promise<TemplateContact> {
    if (!isUuid(id)) throw contentNotFound('Contato')
    const [c] = await this.db
      .select({ name: contacts.name, phone: contacts.phoneE164, email: contacts.email, createdAt: contacts.createdAt, customFields: contacts.customFields })
      .from(contacts)
      .where(and(eq(contacts.id, id), eq(contacts.companyId, companyId)))
    if (!c) throw contentNotFound('Contato')
    return { full_name: c.name, phone_number: c.phone ? c.phone.replace(/^\+/, '') : null, email: c.email, created_at: c.createdAt, custom_fields: c.customFields }
  }

  private async quickReplyRow(companyId: string, id: string) {
    if (!isUuid(id)) throw contentNotFound('Resposta rápida')
    const [row] = await this.db.select().from(quickReplies).where(and(eq(quickReplies.id, id), eq(quickReplies.companyId, companyId)))
    if (!row) throw contentNotFound('Resposta rápida')
    return row
  }

  private async templateRow(companyId: string, id: string) {
    if (!isUuid(id)) throw contentNotFound('Modelo')
    const [row] = await this.db.select().from(messageTemplates).where(and(eq(messageTemplates.id, id), eq(messageTemplates.companyId, companyId)))
    if (!row) throw contentNotFound('Modelo')
    return row
  }

  private async globalRow(companyId: string, id: string) {
    if (!isUuid(id)) throw contentNotFound('Variável')
    const [row] = await this.db.select().from(globalVariables).where(and(eq(globalVariables.id, id), eq(globalVariables.companyId, companyId)))
    if (!row) throw contentNotFound('Variável')
    return row
  }

  private async stickerRow(companyId: string, id: string) {
    if (!isUuid(id)) throw contentNotFound('Figurinha')
    const [row] = await this.db.select().from(stickers).where(and(eq(stickers.id, id), eq(stickers.companyId, companyId)))
    if (!row) throw contentNotFound('Figurinha')
    return row
  }

  private async quickReplyDtos(rows: (typeof quickReplies.$inferSelect)[]): Promise<QuickReplyDto[]> {
    if (!rows.length) return []
    const actions = await this.db
      .select()
      .from(quickReplyActions)
      .where(inArray(quickReplyActions.quickReplyId, rows.map((r) => r.id)))
      .orderBy(asc(quickReplyActions.order))
    return rows.map((r) => {
      const mine = actions.filter((a) => a.quickReplyId === r.id)
      const first = mine[0]
      const head = first ? (first.type === 'send_message' ? str(first.config.message_text) : `[${first.type}]`) : ''
      return {
        id: r.id,
        shortcut: r.shortcut,
        actions: mine.map((a) => ({ id: a.id, type: a.type, order: a.order, config: a.config })),
        preview: mine.length > 1 ? `${head.slice(0, 120)} (+${mine.length - 1} ações)` : head.slice(0, 120),
        created_at: r.createdAt.toISOString(),
        updated_at: r.updatedAt.toISOString(),
      }
    })
  }
}

function toTemplate(r: typeof messageTemplates.$inferSelect): TemplateDto {
  return {
    id: r.id,
    name: r.name,
    header: r.header as unknown as TemplateHeader,
    body: r.body,
    footer: r.footer,
    buttons: r.buttons as unknown as TemplateButton[],
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  }
}

function toGlobal(r: typeof globalVariables.$inferSelect): GlobalVariableDto {
  return { id: r.id, name: r.name, description: r.description, type: r.type, value: r.value, created_at: r.createdAt.toISOString(), updated_at: r.updatedAt.toISOString() }
}

function toSticker(r: typeof stickers.$inferSelect, favorite: boolean): StickerDto {
  return { id: r.id, name: r.name, media_id: r.mediaId, url: `/api/media/${r.mediaId}`, mime: r.mime, size: r.size, favorite, created_at: r.createdAt.toISOString() }
}
