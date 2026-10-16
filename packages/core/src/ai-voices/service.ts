// Vozes da conta (T80; 07 §3.7, §4): clonagem a partir de 1–3 áudios (MP3/WAV/OGG/M4A/AAC/WEBM/FLAC) na ElevenLabs
// com a chave BYOK da empresa ou a da plataforma (T38); `pending` até manter (`kept`) ou descartar (exclusão).
// A prévia sintetiza um texto curto pelo TTS medido (`feature = 'tts'`, T24). Excluir uma voz tira a voz dos agentes
// que a usam (`settings.audio_voice` volta para "" = voz padrão).
import { LlmQuotaExceededError, LlmUpstreamError, TTS_MIME } from '@crm/ai'
import { aiAgents, aiAgentSettings, aiVoices, type AiVoiceLanguage, type AiVoiceSample, type AiVoiceStatus, type Database } from '@crm/db'
import { and, asc, count, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { ProviderNotConfiguredError } from '../ai-keys/errors'
import { apiBaseUrl } from '../ai-keys/http'
import type { AiKeysService } from '../ai-keys/service'
import type { UsageGuard } from '../ai-metering/guard'
import { meterTts } from '../ai-metering/meter'
import { elevenLabsVoiceProvider, type VoiceProviderFactory, type VoiceSampleInput } from './provider'

export const AI_VOICE_LANGS: readonly AiVoiceLanguage[] = ['pt', 'en', 'es', 'hi']
export const VOICE_MIN_SAMPLES = 1
export const VOICE_MAX_SAMPLES = 3
export const VOICE_SAMPLE_MAX_BYTES = 10 * 1024 * 1024
export const VOICE_PREVIEW_MAX_CHARS = 300
export const VOICE_TTS_MODEL = 'eleven_flash_v2_5'
export const VOICE_TTS_FEATURE = 'tts'
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.webm', '.flac']
const AUDIO_MIME_RE = /^audio\/(mpeg|mp3|wav|x-wav|wave|vnd\.wave|ogg|opus|mp4|x-m4a|m4a|aac|x-aac|webm|flac|x-flac)$/i
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Frase da prévia quando o usuário não manda texto. */
export const VOICE_PREVIEW_TEXT: Readonly<Record<AiVoiceLanguage, string>> = {
  pt: 'Olá! Esta é uma prévia da minha voz. Como posso ajudar você hoje?',
  en: 'Hi! This is a preview of my voice. How can I help you today?',
  es: '¡Hola! Esta es una vista previa de mi voz. ¿Cómo puedo ayudarte hoy?',
  hi: 'नमस्ते! यह मेरी आवाज़ का पूर्वावलोकन है। मैं आज आपकी कैसे मदद कर सकता हूँ?',
}

export class AiVoicesError extends Error {
  constructor(
    readonly code: 'not_found' | 'validation' | 'payload_too_large' | 'quota' | 'upstream',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AiVoicesError'
  }
}

const invalid = (errorCode: string, path: string, message: string) => new AiVoicesError('validation', message, { error_code: errorCode, fields: [{ path, message }] })

export interface AiVoiceDto {
  id: string
  name: string
  language: AiVoiceLanguage
  status: AiVoiceStatus
  provider: string
  provider_voice_id: string
  samples_count: number
  samples: AiVoiceSample[]
  kept_at: string | null
  created_at: string
  updated_at: string
}

export interface CreateVoiceInput {
  name?: unknown
  language?: unknown
  audios: VoiceSampleInput[]
}

export interface RemoveVoiceResult {
  deleted: true
  removed_from_agents: { id: string; name: string }[]
  warning: string | null
  provider_deleted: boolean
}

export interface AiVoicesServiceOptions {
  db: Database
  keys: Pick<AiKeysService, 'resolveCredentials'>
  /** Medição do TTS da prévia (T24). Sem ele, a prévia não é medida (só testes). */
  guard?: UsageGuard
  /** Provedor por chave (testes). Default: ElevenLabs por HTTP (`fetch`, `ELEVENLABS_API_URL`). */
  provider?: VoiceProviderFactory
  fetch?: typeof globalThis.fetch
  /** Default `process.env` (lido a cada chamada). */
  env?: Record<string, string | undefined>
  logger?: { warn(obj: object, msg?: string): void }
  now?: () => Date
}

type Row = typeof aiVoices.$inferSelect

export class AiVoicesService {
  constructor(private readonly opts: AiVoicesServiceOptions) {}

  private get db() {
    return this.opts.db
  }

  private now() {
    return this.opts.now?.() ?? new Date()
  }

  /** Provedor com a chave efetiva (empresa → plataforma). Sem chave → `provider_not_configured`. */
  private async provider(companyId: string) {
    let apiKey: string
    try {
      ;({ apiKey } = await this.opts.keys.resolveCredentials(companyId, 'elevenlabs'))
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError || (err as { name?: unknown })?.name === 'ProviderNotConfiguredError')
        throw new AiVoicesError('validation', 'Configure uma chave ElevenLabs (empresa ou plataforma) para usar vozes', {
          error_code: 'provider_not_configured',
          provider: 'elevenlabs',
          fields: [{ path: 'provider', message: 'ElevenLabs sem chave configurada' }],
        })
      throw err
    }
    const factory = this.opts.provider ?? elevenLabsVoiceProvider({ ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}), baseUrl: apiBaseUrl('elevenlabs', this.opts.env ?? process.env) })
    return factory(apiKey)
  }

  // ------------------------------------------------------------------ leitura

  async list(companyId: string, opts: { page?: number; limit?: number } = {}): Promise<{ items: AiVoiceDto[]; page: number; limit: number; total: number }> {
    const page = Math.max(1, Math.floor(opts.page ?? 1))
    const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 10), 100))
    const where = eq(aiVoices.companyId, companyId)
    const [rows, [total]] = await Promise.all([
      this.db.select().from(aiVoices).where(where).orderBy(desc(aiVoices.createdAt), asc(aiVoices.id)).limit(limit).offset((page - 1) * limit),
      this.db.select({ n: count() }).from(aiVoices).where(where),
    ])
    return { items: rows.map(toVoiceDto), page, limit, total: total?.n ?? 0 }
  }

  async get(companyId: string, id: string): Promise<AiVoiceDto> {
    return toVoiceDto(await this.row(companyId, id))
  }

  // ------------------------------------------------------------------ escrita

  /** Clona a voz no provedor e grava `pending`. 0 ou mais de 3 áudios, formato fora da lista → validação. */
  async create(companyId: string, input: CreateVoiceInput, actorUserId: string | null = null): Promise<AiVoiceDto> {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name || name.length > 100) throw invalid('name_required', 'name', 'Dê um nome de 1 a 100 caracteres')
    const language = typeof input.language === 'string' && (AI_VOICE_LANGS as readonly string[]).includes(input.language) ? (input.language as AiVoiceLanguage) : null
    if (!language) throw invalid('language_invalid', 'language', 'Idioma deve ser pt, en, es ou hi')
    const audios = input.audios ?? []
    if (audios.length < VOICE_MIN_SAMPLES || audios.length > VOICE_MAX_SAMPLES) throw invalid('audios_count', 'audios', 'Envie de 1 a 3 áudios')
    for (const [i, a] of audios.entries()) {
      if (!a.data.byteLength) throw invalid('audio_empty', `audios.${i}`, 'Áudio vazio')
      if (a.data.byteLength > VOICE_SAMPLE_MAX_BYTES) throw new AiVoicesError('payload_too_large', 'Áudio acima de 10 MB', { error_code: 'too_large', max_bytes: VOICE_SAMPLE_MAX_BYTES })
      if (!isAudio(a.filename, a.mime)) throw invalid('unsupported_audio', `audios.${i}`, 'Formato não suportado (use MP3, WAV, OGG, M4A, AAC, WEBM ou FLAC)')
    }
    const provider = await this.provider(companyId)
    const { voiceId } = await upstream(() => provider.clone({ name, language, samples: audios }))
    const [row] = await this.db
      .insert(aiVoices)
      .values({
        companyId,
        name,
        language,
        status: 'pending',
        provider: 'elevenlabs',
        providerVoiceId: voiceId,
        samplesCount: audios.length,
        samples: audios.map((a) => ({ filename: a.filename.slice(0, 255), mime: baseMime(a.mime) || 'application/octet-stream', bytes: a.data.byteLength })),
        createdBy: actorUserId,
      })
      .returning()
    return toVoiceDto(row!)
  }

  /** Prévia: sintetiza um texto curto (medido, `feature = 'tts'`). */
  async preview(companyId: string, id: string, text?: unknown): Promise<{ audio: Uint8Array; mime: string; chars: number }> {
    const voice = await this.row(companyId, id)
    const raw = typeof text === 'string' ? text.trim() : ''
    if (raw.length > VOICE_PREVIEW_MAX_CHARS) throw invalid('text_too_long', 'text', `Texto da prévia com até ${VOICE_PREVIEW_MAX_CHARS} caracteres`)
    const phrase = raw || VOICE_PREVIEW_TEXT[voice.language]
    const provider = await this.provider(companyId)
    const tts = this.opts.guard ? meterTts(provider.tts, { guard: this.opts.guard, feature: VOICE_TTS_FEATURE, companyId, provider: 'elevenlabs', model: VOICE_TTS_MODEL }) : provider.tts
    const res = await upstream(() => tts.synthesize({ text: phrase, voiceId: voice.providerVoiceId, format: 'mp3', model: VOICE_TTS_MODEL }))
    return { audio: res.audio, mime: res.mime || TTS_MIME.mp3, chars: res.chars }
  }

  async keep(companyId: string, id: string): Promise<AiVoiceDto> {
    const cur = await this.row(companyId, id)
    if (cur.status === 'kept') return toVoiceDto(cur)
    const now = this.now()
    const [row] = await this.db.update(aiVoices).set({ status: 'kept', keptAt: now, updatedAt: now }).where(eq(aiVoices.id, cur.id)).returning()
    return toVoiceDto(row!)
  }

  /**
   * Descarta/exclui: tira a voz dos agentes da empresa (`settings.audio_voice` → "") e apaga no provedor (falha no
   * provedor não impede a exclusão local; vem em `provider_deleted: false`).
   */
  async remove(companyId: string, id: string): Promise<RemoveVoiceResult> {
    const cur = await this.row(companyId, id)
    const refs = [cur.providerVoiceId, cur.id]
    const agents = await this.db.transaction(async (tx) => {
      const using = or(...refs.map((r) => sql`${aiAgentSettings.settings} ->> 'audio_voice' = ${r}`))!
      const touched = await tx
        .update(aiAgentSettings)
        .set({ settings: sql`jsonb_set(${aiAgentSettings.settings}, '{audio_voice}', '""'::jsonb)`, updatedAt: this.now() })
        .where(and(eq(aiAgentSettings.companyId, companyId), using))
        .returning({ agentId: aiAgentSettings.agentId })
      await tx.delete(aiVoices).where(eq(aiVoices.id, cur.id))
      if (!touched.length) return []
      return tx
        .select({ id: aiAgents.id, name: aiAgents.name })
        .from(aiAgents)
        .where(and(eq(aiAgents.companyId, companyId), inArray(aiAgents.id, touched.map((t) => t.agentId))))
        .orderBy(asc(aiAgents.name))
    })
    let providerDeleted = false
    try {
      const provider = await this.provider(companyId)
      await provider.remove(cur.providerVoiceId)
      providerDeleted = true
    } catch (err) {
      this.opts.logger?.warn({ err, voiceId: cur.id }, 'não foi possível excluir a voz no provedor')
    }
    return {
      deleted: true,
      removed_from_agents: agents,
      warning: agents.length ? `A voz foi removida de ${agents.length} agente(s), que voltaram para a voz padrão.` : null,
      provider_deleted: providerDeleted,
    }
  }

  private async row(companyId: string, id: string): Promise<Row> {
    if (!UUID_RE.test(id)) throw new AiVoicesError('not_found', 'Voz não encontrada')
    const [row] = await this.db.select().from(aiVoices).where(and(eq(aiVoices.companyId, companyId), eq(aiVoices.id, id))).limit(1)
    if (!row) throw new AiVoicesError('not_found', 'Voz não encontrada')
    return row
  }
}

const baseMime = (mime: string) => mime.split(';')[0]!.trim().toLowerCase()

/** Áudio aceito pela extensão OU pelo mime (sem `;codecs`). */
export function isAudio(filename: string, mime: string): boolean {
  const ext = /\.[^.]+$/.exec(filename.toLowerCase())?.[0] ?? ''
  return AUDIO_EXTENSIONS.includes(ext) || AUDIO_MIME_RE.test(baseMime(mime))
}

/** Erros do provedor → domínio (sem saldo → `quota`; HTTP/rede → `upstream`). */
async function upstream<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof LlmQuotaExceededError) throw new AiVoicesError('quota', 'Sem saldo para ouvir essa voz')
    if (err instanceof LlmUpstreamError) throw new AiVoicesError('upstream', 'Não foi possível falar com a ElevenLabs', { provider: 'elevenlabs', reason: err.message })
    throw err
  }
}

export function toVoiceDto(r: Row): AiVoiceDto {
  return {
    id: r.id,
    name: r.name,
    language: r.language,
    status: r.status,
    provider: r.provider,
    provider_voice_id: r.providerVoiceId,
    samples_count: r.samplesCount,
    samples: r.samples,
    kept_at: r.keptAt?.toISOString() ?? null,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  }
}
