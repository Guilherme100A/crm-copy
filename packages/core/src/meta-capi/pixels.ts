// Configurações de pixel (T104; 11 §3.3, §5.4): CRUD por empresa com o token CAPI cifrado. A listagem e o GET
// devolvem só os campos mascarados; o token em claro só sai com `include_access_token=true` (a rota exige
// `facebook.pixel`).
// Revisão 3 (paridade com o Leona): `page_id` e `whatsapp_business_account_id` opcionais (modo "mensagem de anúncio",
// `action_source: business_messaging`), `test_event_code` por pixel, país padrão e Lead automático de anúncio.
// Doc: https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging
import { randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { pixelConfigs, type Database } from '@crm/db'
import { getCredentialsCipher, parseEncrypted, serializeEncrypted, type CredentialCipher } from '@crm/node-kit'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const tokenAad = (id: string) => `pixel_config/${id}/token`

export class PixelConfigError extends Error {
  constructor(
    readonly code: 'not_found' | 'validation',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'PixelConfigError'
  }
}

export interface PixelConfigInput {
  name?: string | null
  pixel_id?: string | number | null
  access_token?: string | null
  platform?: string | null
  auto_send_sales?: boolean
  page_id?: string | number | null
  whatsapp_business_account_id?: string | number | null
  test_event_code?: string | null
  default_country?: string | null
  auto_lead_on_ad?: boolean
}

export interface PixelConfigDto {
  id: string
  name: string
  platform: string
  masked_pixel_id: string
  masked_access_token: string
  auto_send_sales: boolean
  page_id: string | null
  whatsapp_business_account_id: string | null
  test_event_code: string | null
  default_country: string
  auto_lead_on_ad: boolean
  /** Último resultado do modo business_messaging (null = nunca tentado). */
  business_messaging: { status: 'accepted' | 'rejected'; checked_at: string; error: string | null } | null
  created_at: string
  updated_at: string
  /** Só com `includeAccessToken`. */
  pixel_id?: string
  access_token?: string
}

type Row = typeof pixelConfigs.$inferSelect
interface Validated {
  name?: string
  pixelId?: string
  token?: string
  pageId?: string | null
  wabaId?: string | null
  testEventCode?: string | null
  defaultCountry?: string
}

/** `123456789012345` → `***********2345` (4 últimos dígitos). */
export function maskPixelId(pixelId: string): string {
  return pixelId.length <= 4 ? '*'.repeat(pixelId.length) : `${'*'.repeat(pixelId.length - 4)}${pixelId.slice(-4)}`
}

/** `EAABsbCS1iHgBA…xyz9` → `EAAB***xyz9`; curto ou ausente → `***`. */
export function maskToken(token: string | null | undefined): string {
  if (!token || token.length < 12) return '***'
  return `${token.slice(0, 4)}***${token.slice(-4)}`
}

export class PixelConfigService {
  constructor(private readonly opts: { db: Database; cipher?: Pick<CredentialCipher, 'encrypt' | 'decrypt'>; now?: () => Date }) {}

  private cipher() {
    return this.opts.cipher ?? getCredentialsCipher()
  }

  private now() {
    return this.opts.now?.() ?? new Date()
  }

  async list(companyId: string): Promise<PixelConfigDto[]> {
    const rows = await this.opts.db.select().from(pixelConfigs).where(eq(pixelConfigs.companyId, companyId)).orderBy(asc(pixelConfigs.name), asc(pixelConfigs.createdAt))
    return rows.map((r) => this.dto(r, false))
  }

  async get(companyId: string, id: string, opts: { includeAccessToken?: boolean } = {}): Promise<PixelConfigDto> {
    return this.dto(await this.row(companyId, id), opts.includeAccessToken ?? false)
  }

  async create(companyId: string, input: PixelConfigInput): Promise<PixelConfigDto> {
    const v = this.validate(input, true)
    const id = randomUUID()
    const [row] = await this.opts.db
      .insert(pixelConfigs)
      .values({
        id,
        companyId,
        name: v.name!,
        platform: 'facebook',
        pixelId: v.pixelId!,
        accessTokenEnc: serializeEncrypted(this.cipher().encrypt(v.token!, tokenAad(id))),
        autoSendSales: input.auto_send_sales ?? false,
        pageId: v.pageId ?? null,
        whatsappBusinessAccountId: v.wabaId ?? null,
        testEventCode: v.testEventCode ?? null,
        defaultCountry: v.defaultCountry ?? 'br',
        autoLeadOnAd: input.auto_lead_on_ad ?? false,
      })
      .returning()
    return this.dto(row!, false)
  }

  /** Token vazio/ausente na edição = manter o atual. */
  async update(companyId: string, id: string, input: PixelConfigInput): Promise<PixelConfigDto> {
    const cur = await this.row(companyId, id)
    const v = this.validate(input, false)
    const [row] = await this.opts.db
      .update(pixelConfigs)
      .set({
        ...(v.name !== undefined ? { name: v.name! } : {}),
        ...(v.pixelId !== undefined ? { pixelId: v.pixelId! } : {}),
        ...(v.token ? { accessTokenEnc: serializeEncrypted(this.cipher().encrypt(v.token, tokenAad(cur.id))) } : {}),
        ...(input.auto_send_sales !== undefined ? { autoSendSales: input.auto_send_sales } : {}),
        ...(v.pageId !== undefined ? { pageId: v.pageId } : {}),
        ...(v.wabaId !== undefined ? { whatsappBusinessAccountId: v.wabaId } : {}),
        // Trocar Página/WABA: o modo business_messaging volta a ser testado.
        ...((v.pageId !== undefined && v.pageId !== cur.pageId) || (v.wabaId !== undefined && v.wabaId !== cur.whatsappBusinessAccountId) ? { bmStatus: null, bmCheckedAt: null, bmError: null } : {}),
        ...(v.testEventCode !== undefined ? { testEventCode: v.testEventCode } : {}),
        ...(v.defaultCountry !== undefined ? { defaultCountry: v.defaultCountry } : {}),
        ...(input.auto_lead_on_ad !== undefined ? { autoLeadOnAd: input.auto_lead_on_ad } : {}),
        updatedAt: this.now(),
      })
      .where(eq(pixelConfigs.id, cur.id))
      .returning()
    return this.dto(row!, false)
  }

  async remove(companyId: string, id: string): Promise<void> {
    const cur = await this.row(companyId, id)
    await this.opts.db.delete(pixelConfigs).where(eq(pixelConfigs.id, cur.id))
  }

  /** Token decifrado (uso interno do CapiService). */
  accessToken(row: Pick<Row, 'id' | 'accessTokenEnc'>): string {
    return this.cipher().decrypt<string>(parseEncrypted<string>(row.accessTokenEnc), tokenAad(row.id))
  }

  private async row(companyId: string, id: string): Promise<Row> {
    if (!UUID_RE.test(id)) throw new PixelConfigError('not_found', 'Pixel não encontrado')
    const [row] = await this.opts.db.select().from(pixelConfigs).where(and(eq(pixelConfigs.companyId, companyId), eq(pixelConfigs.id, id))).limit(1)
    if (!row) throw new PixelConfigError('not_found', 'Pixel não encontrado')
    return row
  }

  private validate(input: PixelConfigInput, creating: boolean): Validated {
    const fields: { path: string; message: string }[] = []
    const out: Validated = {}
    if (creating || input.name !== undefined) {
      const name = (input.name ?? '').trim()
      if (name.length < 2 || name.length > 255) fields.push({ path: 'name', message: 'O nome deve ter de 2 a 255 caracteres' })
      out.name = name
    }
    if (creating || input.pixel_id !== undefined) {
      // O front remove o que não é dígito; aqui o valor precisa ser só dígitos.
      const pixelId = String(input.pixel_id ?? '').trim()
      if (!/^\d+$/.test(pixelId)) fields.push({ path: 'pixel_id', message: 'O Pixel ID deve ter só números' })
      out.pixelId = pixelId
    }
    const token = typeof input.access_token === 'string' ? input.access_token.trim() : ''
    if (creating && !token) fields.push({ path: 'access_token', message: 'Informe o token da Conversions API' })
    if (token) out.token = token
    // Opcionais numéricos: vazio/null = limpar.
    const optionalDigits = (raw: string | number | null | undefined, path: string, label: string): string | null | undefined => {
      if (raw === undefined) return undefined
      const v = String(raw ?? '').trim()
      if (!v) return null
      if (!/^\d{3,32}$/.test(v)) fields.push({ path, message: `${label} deve ter só números` })
      return v
    }
    out.pageId = optionalDigits(input.page_id, 'page_id', 'O ID da Página')
    out.wabaId = optionalDigits(input.whatsapp_business_account_id, 'whatsapp_business_account_id', 'O ID da conta do WhatsApp Business')
    if (input.test_event_code !== undefined) {
      const code = (input.test_event_code ?? '').trim()
      if (code && !/^[A-Za-z0-9_-]{2,64}$/.test(code)) fields.push({ path: 'test_event_code', message: 'Código de teste inválido (ex.: TEST12345)' })
      out.testEventCode = code || null
    }
    if (input.default_country !== undefined && input.default_country !== null) {
      const c = input.default_country.trim().toLowerCase()
      if (!/^[a-z]{2}$/.test(c)) fields.push({ path: 'default_country', message: 'País padrão: código ISO de 2 letras (ex.: br)' })
      out.defaultCountry = c
    }
    if (input.platform && input.platform !== 'facebook') fields.push({ path: 'platform', message: 'Plataforma suportada: facebook' })
    if (fields.length) throw new PixelConfigError('validation', fields[0]!.message, { fields })
    return out
  }

  private dto(r: Row, includeToken: boolean): PixelConfigDto {
    const token = this.accessToken(r)
    return {
      id: r.id,
      name: r.name,
      platform: r.platform,
      masked_pixel_id: maskPixelId(r.pixelId),
      masked_access_token: maskToken(token),
      auto_send_sales: r.autoSendSales,
      page_id: r.pageId,
      whatsapp_business_account_id: r.whatsappBusinessAccountId,
      test_event_code: r.testEventCode,
      default_country: r.defaultCountry,
      auto_lead_on_ad: r.autoLeadOnAd,
      business_messaging: r.bmStatus && r.bmCheckedAt ? { status: r.bmStatus, checked_at: r.bmCheckedAt.toISOString(), error: r.bmError } : null,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
      ...(includeToken ? { pixel_id: r.pixelId, access_token: token } : {}),
    }
  }
}
