// Configurações de pixel (T104; 11 §3.3, §5.4): CRUD por empresa com o token CAPI cifrado. A listagem e o GET
// devolvem só os campos mascarados; o token em claro só sai com `include_access_token=true` (a rota exige
// `facebook.pixel`).
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
}

export interface PixelConfigDto {
  id: string
  name: string
  platform: string
  masked_pixel_id: string
  masked_access_token: string
  auto_send_sales: boolean
  created_at: string
  updated_at: string
  /** Só com `includeAccessToken`. */
  pixel_id?: string
  access_token?: string
}

type Row = typeof pixelConfigs.$inferSelect

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

  private validate(input: PixelConfigInput, creating: boolean): { name?: string; pixelId?: string; token?: string } {
    const fields: { path: string; message: string }[] = []
    const out: { name?: string; pixelId?: string; token?: string } = {}
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
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
      ...(includeToken ? { pixel_id: r.pixelId, access_token: token } : {}),
    }
  }
}
