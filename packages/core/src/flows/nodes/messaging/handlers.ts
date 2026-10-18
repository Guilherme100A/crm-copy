// Handlers dos nós de mensagem (T51): `message` (ações em ordem), `notification` e `pix`. Todo envio passa por
// `ctx.wa.send(req, { actionId })` (idempotente no retry do passo) com `actor: flow:<runId>`; menus, botões e Pix
// saem como texto (SPEC 3.8). Antes de cada envio vai a presença (`composing`, ou `recording` para áudio).
import { MAX_MESSAGE_DELAY_SECONDS, type FlowAction } from '@crm/shared'
import type { MessageView, OutgoingContent, PresenceKind } from '@crm/wa-port'
import { renderTemplateContent, type TemplateContent } from '../../../content/rules'
import type { NodeContext, NodeHandler, NodeOutcome } from '../../engine/context'
import { defaultGlobals, defaultLoadTemplate, defaultResolveTarget, type SendTarget } from './data'
import { pixMessage, type PixKeyType } from './pix'

/** Mensagem enviada por um nó (entrada do ponto de extensão `record`). */
export interface SentMessage {
  target: SendTarget
  content: OutgoingContent
  viewOnce: boolean
  actionId: string
  view: MessageView
}

export interface MessagingDeps {
  /** RNG do atraso aleatório (`[0, 1)`). Padrão `Math.random`. */
  rng?: () => number
  /** Espera (atraso entre mensagens e "digitando"). Padrão `setTimeout`. */
  sleep?: (ms: number) => Promise<void>
  /** Destino do run. Padrão: chat → conexão → `session_id`, telefone do contato (`./data`). */
  resolveTarget?: (ctx: NodeContext) => Promise<SendTarget>
  /** Modelo interno (T35) por id. Padrão: `crm.message_templates` na transação do passo. */
  loadTemplate?: (ctx: NodeContext, id: string) => Promise<TemplateContent | null>
  /** Variáveis globais `g_*` da empresa. Padrão: `crm.global_variables`. */
  globals?: (ctx: NodeContext) => Promise<Record<string, unknown>>
  /** URL e mime de uma mídia da empresa (cabeçalho de mídia do modelo). Sem ela o cabeçalho de mídia é omitido. */
  mediaUrl?: (ctx: NodeContext, mediaId: string) => Promise<{ url: string; mime?: string } | null>
  /**
   * Ponto de extensão: gravar a mensagem enviada no chat (`crm.messages`, remetente fluxo) sem reenviar. Chamado
   * depois de cada envio aceito pelo gateway; falha aqui só gera log (o envio já aconteceu).
   */
  record?: (ctx: NodeContext, sent: SentMessage) => Promise<void>
}

interface Resolved {
  rng: () => number
  sleep: (ms: number) => Promise<void>
  resolveTarget: (ctx: NodeContext) => Promise<SendTarget>
  loadTemplate: (ctx: NodeContext, id: string) => Promise<TemplateContent | null>
  globals: (ctx: NodeContext) => Promise<Record<string, unknown>>
  mediaUrl?: MessagingDeps['mediaUrl']
  record?: MessagingDeps['record']
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function resolveDeps(deps: MessagingDeps = {}): Resolved {
  return {
    rng: deps.rng ?? Math.random,
    sleep: deps.sleep ?? defaultSleep,
    resolveTarget: deps.resolveTarget ?? defaultResolveTarget,
    loadTemplate: deps.loadTemplate ?? defaultLoadTemplate,
    globals: deps.globals ?? defaultGlobals,
    mediaUrl: deps.mediaUrl,
    record: deps.record,
  }
}

export class MessagingConfigError extends Error {
  constructor(
    readonly actionId: string,
    message: string,
  ) {
    super(message)
    this.name = 'MessagingConfigError'
  }
}

type Config = Record<string, unknown>
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined)
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : undefined)
const capDelay = (s: number) => Math.min(Math.max(0, s), MAX_MESSAGE_DELAY_SECONDS)

/** Segundos do `delay_between_messages`: fixo, ou inteiro aleatório em `[mín, máx]` com o RNG injetado (≤ 120 s). */
export function delaySeconds(config: Config, rng: () => number = Math.random): number {
  const fixed = int(config.delay_seconds)
  const min = int(config.delay_min_seconds)
  const max = int(config.delay_max_seconds)
  if (min === undefined && max === undefined) return capDelay(fixed ?? 0)
  const lo = capDelay(min ?? max ?? 0)
  const hi = capDelay(Math.max(max ?? lo, lo))
  const r = Math.min(Math.max(rng(), 0), 0.999999999)
  return lo + Math.floor(r * (hi - lo + 1))
}

const GLOBAL_TOKEN = /\{\{\s*global\.([A-Za-z0-9_]+)\s*\}\}|\{\s*(g_[A-Za-z0-9_]+)\s*\}/g

/** Troca `{g_nome}`/`{{global.nome}}` pelos valores das globais (o resto fica para o `ctx.render`). */
export function applyGlobals(template: string, globals: Record<string, unknown>): string {
  if (!template.includes('{')) return template
  return template.replace(GLOBAL_TOKEN, (token, dotted: string | undefined, prefixed: string | undefined) => {
    const name = prefixed ?? `g_${dotted}`
    const value = Object.hasOwn(globals, name) ? globals[name] : dotted && Object.hasOwn(globals, dotted) ? globals[dotted] : undefined
    return value === undefined || value === null ? token : String(value)
  })
}

const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv',
  zip: 'application/zip',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
}

/** Mime pela extensão do nome (ou da URL); `application/octet-stream` se desconhecida. */
export function mimeOf(name: string): string {
  const ext = /\.([A-Za-z0-9]{1,5})(?:$|[?#])/.exec(name.trim())?.[1]?.toLowerCase()
  return (ext && EXT_MIME[ext]) || 'application/octet-stream'
}

/** vCard 3.0 do cartão de contato (mesma forma do `vcardOf` da T49). */
export function contactVcard(name: string, phone: string): string {
  const digits = phone.replace(/\D/g, '')
  return ['BEGIN:VCARD', 'VERSION:3.0', `FN:${name}`, `TEL;type=CELL;type=VOICE;waid=${digits}:+${digits}`, 'END:VCARD'].join('\n')
}

/** Uma mensagem a enviar: conteúdo, presença antes, "digitando" (s) e visualização única. */
export interface Outgoing {
  actionId: string
  content: OutgoingContent
  presence: PresenceKind | null
  typingSeconds: number
  viewOnce?: boolean
}

/** Executor de um nó de mensagem: renderização (com globais) e envio pelo gateway do passo. */
class Sender {
  private target: SendTarget | null = null
  private globals: Record<string, unknown> | null = null

  constructor(
    readonly ctx: NodeContext,
    readonly deps: Resolved,
  ) {}

  async render(template: string): Promise<string> {
    if (/\{\{\s*global\.|\{\s*g_/.test(template)) {
      this.globals ??= await this.deps.globals(this.ctx)
      template = applyGlobals(template, this.globals)
    }
    return this.ctx.render(template)
  }

  async to(): Promise<SendTarget> {
    this.target ??= await this.deps.resolveTarget(this.ctx)
    return this.target
  }

  async send(out: Outgoing, target?: SendTarget): Promise<MessageView> {
    const dest = target ?? (await this.to())
    if (out.presence) await this.ctx.wa.presence(dest.sessionId, dest.phone, out.presence).catch(() => undefined)
    if (out.typingSeconds > 0) await this.deps.sleep(capDelay(out.typingSeconds) * 1000)
    const view = await this.ctx.wa.send(
      {
        sessionId: dest.sessionId,
        phone: dest.phone,
        content: out.content,
        actor: `flow:${this.ctx.runId}`,
        ...(out.viewOnce ? { viewOnce: true } : {}),
      },
      { actionId: out.actionId },
    )
    if (this.deps.record) {
      await this.deps
        .record(this.ctx, { target: dest, content: out.content, viewOnce: !!out.viewOnce, actionId: out.actionId, view })
        .catch((err: unknown) => this.ctx.log.warn({ err, run_id: this.ctx.runId, action_id: out.actionId }, 'falha ao registrar a mensagem do fluxo no chat'))
    }
    return view
  }
}

/** Mensagens de uma ação do nó `message` (vazio para `delay_between_messages`). */
async function outgoingOf(s: Sender, action: FlowAction): Promise<Outgoing[]> {
  const c = action.config as Config
  const typing = int(c.typing_delay_seconds) ?? 0
  switch (action.type) {
    case 'send_message': {
      const templateId = str(c.message_template_id)?.trim()
      if (templateId) {
        const template = await s.deps.loadTemplate(s.ctx, templateId)
        if (template) return templateOutgoing(s, action, template, typing)
        s.ctx.log.warn({ run_id: s.ctx.runId, template_id: templateId }, 'modelo de mensagem não encontrado: usando o texto da ação')
      }
      const text = await s.render(str(c.message_text) ?? '')
      if (!text.trim()) throw new MessagingConfigError(action.id, 'mensagem vazia')
      return [{ actionId: action.id, content: { text }, presence: 'composing', typingSeconds: typing }]
    }
    case 'send_multi_media': {
      const kind = str(c.media_type)
      if (c.media_source === 'ai') throw new MessagingConfigError(action.id, 'áudio gerado por IA não está disponível neste nó')
      const items = Array.isArray(c.messages) ? (c.messages as Config[]) : []
      const list = items.filter((m) => (str(m.url) ?? str(m.media_url))?.trim())
      // Itens com URL própria; senão a `media_url` única, com legenda/visualização única do 1º item (se houver).
      const sources = list.length ? list : str(c.media_url)?.trim() ? [{ ...(items[0] ?? {}), url: c.media_url } as Config] : []
      if (!sources.length) throw new MessagingConfigError(action.id, 'informe a mídia')
      const out: Outgoing[] = []
      for (const [i, m] of sources.entries()) {
        const url = await s.render((str(m.url) ?? str(m.media_url))!.trim())
        const caption = str(m.caption)?.trim() ? await s.render(str(m.caption)!) : undefined
        const actionId = sources.length > 1 ? `${action.id}:${i}` : action.id
        const viewOnce = m.view_once === true
        let content: OutgoingContent
        if (kind === 'image') content = { image: { url }, ...(caption ? { caption } : {}) }
        else if (kind === 'video') {
          // `ptv` (vídeo-nota redonda): o wa-port ainda não tem o campo; vai junto para o adapter que o suportar.
          content = { video: { url }, ...(caption ? { caption } : {}), ...(c.uazapi_video_type === 'ptv' ? { ptv: true } : {}) } as OutgoingContent
        } else if (kind === 'audio') content = { audio: { url }, ptt: c.audio_forward !== false }
        else throw new MessagingConfigError(action.id, `tipo de mídia inválido: ${String(kind)}`)
        out.push({ actionId, content, presence: kind === 'audio' ? 'recording' : 'composing', typingSeconds: i === 0 ? typing : 0, viewOnce })
      }
      return out
    }
    case 'send_file': {
      const url = str(c.file_url)?.trim()
      if (!url) throw new MessagingConfigError(action.id, 'arquivo sem URL')
      const fileName = await s.render(str(c.file_name) ?? 'arquivo')
      const rendered = await s.render(url)
      const mimetype = mimeOf(fileName) !== 'application/octet-stream' ? mimeOf(fileName) : mimeOf(rendered)
      return [{ actionId: action.id, content: { document: { url: rendered }, mimetype, fileName }, presence: 'composing', typingSeconds: typing }]
    }
    case 'send_sticker': {
      const url = str(c.sticker_url)?.trim()
      if (!url) throw new MessagingConfigError(action.id, 'figurinha sem URL')
      return [{ actionId: action.id, content: { sticker: { url: await s.render(url) } }, presence: 'composing', typingSeconds: typing }]
    }
    case 'send_contact': {
      const name = (await s.render(str(c.contact_name) ?? '')).trim()
      const phone = (await s.render(str(c.contact_phone) ?? '')).trim()
      if (!name || !phone.replace(/\D/g, '')) throw new MessagingConfigError(action.id, 'contato sem nome ou telefone')
      return [{ actionId: action.id, content: { contact: { displayName: name, vcard: contactVcard(name, phone) } }, presence: 'composing', typingSeconds: typing }]
    }
    default:
      return []
  }
}

/** Modelo interno → cabeçalho de mídia (se houver e a URL resolver) e o texto (corpo, menu numerado, links, rodapé). */
async function templateOutgoing(s: Sender, action: FlowAction, template: TemplateContent, typing: number): Promise<Outgoing[]> {
  // O render do modelo é síncrono: as globais são carregadas antes, uma vez, se alguma parte as usa.
  const needsGlobals = [template.header.text, template.body, template.footer, ...template.buttons.flatMap((b) => [b.text, b.url, b.phone])].some(
    (part) => typeof part === 'string' && /\{\{\s*global\.|\{\s*g_/.test(part),
  )
  const globals = needsGlobals ? await s.deps.globals(s.ctx) : {}
  const { text, media } = renderTemplateContent(template, (part) => s.ctx.render(applyGlobals(part, globals)))
  const out: Outgoing[] = []
  if (media && s.deps.mediaUrl) {
    const ref = await s.deps.mediaUrl(s.ctx, media.media_id)
    if (ref?.url) {
      const content: OutgoingContent =
        media.type === 'image'
          ? { image: { url: ref.url }, ...(ref.mime ? { mimetype: ref.mime } : {}) }
          : media.type === 'video'
            ? { video: { url: ref.url }, ...(ref.mime ? { mimetype: ref.mime } : {}) }
            : { document: { url: ref.url }, mimetype: ref.mime ?? mimeOf(ref.url) }
      out.push({ actionId: `${action.id}:header`, content, presence: 'composing', typingSeconds: typing })
    } else s.ctx.log.warn({ run_id: s.ctx.runId, media_id: media.media_id }, 'mídia do cabeçalho do modelo não encontrada')
  }
  if (!text.trim()) throw new MessagingConfigError(action.id, 'modelo sem conteúdo')
  out.push({ actionId: action.id, content: { text }, presence: 'composing', typingSeconds: out.length ? 0 : typing })
  return out
}

const byOrder = (actions: FlowAction[]) => [...actions].sort((a, b) => a.order - b.order)

/** Executa uma ação de envio (`send_message`, mídia, arquivo, figurinha, contato) ou o atraso entre mensagens. */
export async function runMessageAction(ctx: NodeContext, action: FlowAction, deps: MessagingDeps = {}): Promise<void> {
  await runActions(new Sender(ctx, resolveDeps(deps)), [action])
}

async function runActions(s: Sender, actions: FlowAction[]) {
  for (const action of actions) {
    if (action.type === 'delay_between_messages') {
      const secs = delaySeconds(action.config as Config, s.deps.rng)
      if (secs > 0) await s.deps.sleep(secs * 1000)
      continue
    }
    for (const out of await outgoingOf(s, action)) await s.send(out)
  }
}

const MESSAGE_ACTIONS = new Set(['send_message', 'send_multi_media', 'send_file', 'send_sticker', 'send_contact', 'delay_between_messages'])

export function messagingHandlers(deps: MessagingDeps = {}): Record<'message' | 'notification' | 'pix', NodeHandler> {
  const d = resolveDeps(deps)
  const next: NodeOutcome = { next: 'source' }
  return {
    message: {
      async execute(ctx) {
        await runActions(new Sender(ctx, d), byOrder(ctx.node.actions).filter((a) => MESSAGE_ACTIONS.has(a.type)))
        return next
      },
    },
    notification: {
      async execute(ctx) {
        const s = new Sender(ctx, d)
        for (const action of byOrder(ctx.node.actions).filter((a) => a.type === 'send_notification')) {
          const c = action.config as Config
          const digits = (str(c.phone) ?? '').replace(/\D/g, '')
          if (!digits) throw new MessagingConfigError(action.id, 'telefone da notificação inválido')
          const cc = (str(c.country_code) ?? '').replace(/\D/g, '') || '55'
          const text = await s.render(str(c.message) ?? '')
          if (!text.trim()) throw new MessagingConfigError(action.id, 'mensagem vazia')
          // Mesma conexão (sessão) do run, outro destinatário: o número interno configurado.
          const { sessionId } = await s.to()
          const phone = `+${cc}${digits}`
          // O número da equipe não é contato do CRM: sem consentimento, o gate `contactAllowed` do engine (ai-manager)
          // barra o envio. Quem configurou o número no fluxo foi a própria empresa → consentimento manual (opt-out vale).
          await ctx
            .once(`${action.id}:consent`, async () => (await ctx.wa.recordConsent({ phone, source: 'manual', name: str(c.name)?.trim() || null, actor: 'crm:flow-notification' }), true))
            .catch((err: unknown) => ctx.log.warn({ run_id: ctx.runId, err }, 'não foi possível registrar o consentimento do número da notificação'))
          await s.send({ actionId: action.id, content: { text }, presence: 'composing', typingSeconds: 0 }, { sessionId, phone })
        }
        return next
      },
    },
    pix: {
      async execute(ctx) {
        const s = new Sender(ctx, d)
        for (const action of byOrder(ctx.node.actions).filter((a) => a.type === 'send_pix_button')) {
          const c = action.config as Config
          const key = (await s.render(str(c.pix_key) ?? '')).trim()
          if (!key) throw new MessagingConfigError(action.id, 'chave Pix vazia')
          const amount = c.amount_reais === undefined || c.amount_reais === null ? null : typeof c.amount_reais === 'number' ? c.amount_reais : await s.render(String(c.amount_reais))
          const merchantName = str(c.merchant_name)?.trim() ? await s.render(str(c.merchant_name)!) : null
          const text = pixMessage({ key, type: (str(c.pix_type) as PixKeyType | undefined) ?? null, merchantName, amount })
          await s.send({ actionId: action.id, content: { text }, presence: 'composing', typingSeconds: 0 })
        }
        return next
      },
    },
  }
}
