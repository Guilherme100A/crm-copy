// Handlers dos nós interativos (T62): menu (`interactive_menu`/`menu`), carrossel e Aguarda Resposta. Tudo sai como
// TEXTO/imagem (SPEC 3.8/8.3; sem conteúdo nativo de botões/listas). A espera usa `waitForReply` com `reentry`
// (T30): a resposta volta a este nó, que reconhece a opção (`option:<id>` / `other`) ou junta as mensagens do buffer.
import { sql } from 'drizzle-orm'
import type { Database } from '@crm/db'
import type { FlowAction } from '@crm/shared'
import type { NodeContext, NodeHandler, NodeOutcome } from '../../engine/context'
import { waitForReply } from '../../engine/waits'
import { runMessageAction, type MessagingDeps } from '../messaging/handlers'
import { matchOption, menuText, type MenuOption } from './menu'

export interface InteractiveDeps extends MessagingDeps {
  now?: () => Date
}

/** Prazo padrão do menu/carrossel sem `timeout_value` (ou 0): 2 dias (06 §3.6). */
export const DEFAULT_MENU_TIMEOUT_MS = 2 * 86_400_000
const UNIT_MS: Record<string, number> = { seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 }

type Config = Record<string, unknown>
const actionOf = (ctx: NodeContext, ...types: string[]): FlowAction | undefined => ctx.node.actions.find((a) => types.includes(a.type))
const configOf = (a: FlowAction | undefined): Config => (a?.config ?? {}) as Config

/** Marca da espera deste nó em `vars.__await` (para distinguir a reexecução pela resposta da 1ª execução). */
interface AwaitMark {
  node: string
  seq: number
  buffer_until?: string | null
}

function timeoutMs(value: unknown, unit: unknown, fallback: number | null): number | null {
  const v = typeof value === 'number' && value > 0 ? value : 0
  if (!v) return fallback
  return v * (UNIT_MS[typeof unit === 'string' ? unit : 'minutes'] ?? UNIT_MS.minutes!)
}

/** Respostas recebidas desde a espera deste nó (só na reexecução pela resposta). */
function repliesFor(ctx: NodeContext): Array<{ text?: string | null; type?: string | null }> | null {
  const mark = ctx.vars.__await as AwaitMark | undefined
  if (!mark || mark.node !== ctx.node.id || ctx.seq <= mark.seq) return null
  const replies = ctx.vars.__replies
  return Array.isArray(replies) && replies.length ? (replies as Array<{ text?: string | null }>) : null
}

function wait(ctx: NodeContext, opts: { delayMs: number | null; deadlineAt?: string | null; timeoutHandle?: string }, mark: Partial<AwaitMark> = {}, now?: () => Date): NodeOutcome {
  ctx.setVar('__await', { node: ctx.node.id, seq: ctx.seq, ...mark } satisfies AwaitMark)
  if (!mark.buffer_until) ctx.setVar('__replies', [])
  const w = waitForReply({
    ...(opts.deadlineAt ? { deadlineAt: opts.deadlineAt } : opts.delayMs !== null ? { delayMs: opts.delayMs } : {}),
    reply: 'source',
    timeout: opts.timeoutHandle ?? 'timeout',
    ...(now ? { now } : {}),
  })
  return { wait: { ...w, reentry: true } as unknown as Record<string, unknown> }
}

function done(ctx: NodeContext, next: string): NodeOutcome {
  ctx.setVar('__await', null)
  ctx.setVar('__replies', [])
  return { next }
}

/** `save_user_data`: variável do run e campo personalizado do contato (vazio só com `save_empty`). */
async function saveUserData(ctx: NodeContext, value: string): Promise<void> {
  const c = configOf(actionOf(ctx, 'save_user_data'))
  const field = typeof c.field_name === 'string' ? c.field_name.trim() : ''
  if (!field) return
  if (!value.trim() && c.save_empty !== true) return
  ctx.setVar(field, value)
  const db = (ctx.repo.db as Database | null) ?? null
  if (db && ctx.contactId)
    await db.execute(sql`
      update crm.contacts set custom_fields = coalesce(custom_fields, '{}'::jsonb) || jsonb_build_object(${field}::text, ${value}::text), updated_at = now()
      where id = ${ctx.contactId} and company_id = ${ctx.companyId}`)
}

const sendText = (ctx: NodeContext, id: string, text: string, deps: InteractiveDeps) =>
  runMessageAction(ctx, { id, type: 'send_message', order: 0, config: { message_text: text } }, deps)
const sendImage = (ctx: NodeContext, id: string, url: string, caption: string | undefined, deps: InteractiveDeps) =>
  runMessageAction(ctx, { id, type: 'send_multi_media', order: 0, config: { media_type: 'image', media_source: 'url', messages: [{ url, ...(caption ? { caption } : {}) }] } }, deps)

/** Reexecução de menu/carrossel: opção reconhecida → `option:<id>`; senão `other`. */
async function answer(ctx: NodeContext, options: MenuOption[]): Promise<NodeOutcome> {
  const replies = repliesFor(ctx)!
  const text = String(replies.at(-1)?.text ?? '')
  const chosen = matchOption(text, options)
  await saveUserData(ctx, chosen ? chosen.title : text)
  return done(ctx, chosen?.id ? `option:${chosen.id}` : 'other')
}

export function interactiveHandlers(deps: InteractiveDeps = {}): Record<'interactive_menu' | 'menu' | 'carousel' | 'wait_response', NodeHandler> {
  const menu: NodeHandler = {
    async execute(ctx) {
      const action = actionOf(ctx, 'send_interactive_menu', 'send_option_list')
      const c = configOf(action)
      const options = (Array.isArray(c.options) ? c.options : []) as MenuOption[]
      if (repliesFor(ctx)) return answer(ctx, options)
      const id = action?.id ?? ctx.node.id
      if (c.imageButtonEnabled === true && typeof c.imageButton === 'string' && c.imageButton.trim()) await sendImage(ctx, `${id}:image`, c.imageButton.trim(), undefined, deps)
      await sendText(ctx, id, menuText(String(c.message ?? ''), options, typeof c.footerText === 'string' ? c.footerText : null), deps)
      return wait(ctx, { delayMs: timeoutMs(c.timeout_value, c.timeout_unit, DEFAULT_MENU_TIMEOUT_MS) }, {}, deps.now)
    },
  }

  return {
    interactive_menu: menu,
    menu,

    carousel: {
      async execute(ctx) {
        const action = actionOf(ctx, 'send_carousel')
        const c = configOf(action)
        const cards = (Array.isArray(c.carousel) ? c.carousel : []) as Array<{ text?: string; image?: string; buttons?: Array<{ id: string; text: string; type: string; payload?: string }> }>
        const options: MenuOption[] = cards.flatMap((k) => (k.buttons ?? []).filter((b) => b.type === 'REPLY').map((b) => ({ id: b.id, title: b.text })))
        if (repliesFor(ctx)) return answer(ctx, options)
        const id = action?.id ?? ctx.node.id
        for (const [i, card] of cards.entries()) {
          const links = (card.buttons ?? []).filter((b) => b.type !== 'REPLY').map((b) => `${b.text}: ${b.payload ?? ''}`.trim())
          const caption = [card.text?.trim(), ...links].filter(Boolean).join('\n')
          if (card.image?.trim()) await sendImage(ctx, `${id}:card${i}`, card.image.trim(), caption || undefined, deps)
        }
        await sendText(ctx, id, menuText(String(c.text ?? ''), options), deps)
        const g = (c.gatilho ?? {}) as Config
        return wait(ctx, { delayMs: timeoutMs(g.timeout_value, g.timeout_unit, DEFAULT_MENU_TIMEOUT_MS) }, {}, deps.now)
      },
    },

    wait_response: {
      async execute(ctx) {
        const c = configOf(actionOf(ctx, 'wait_for_response'))
        const replies = repliesFor(ctx)
        if (!replies) {
          const message = actionOf(ctx, 'send_message')
          if (message) await runMessageAction(ctx, message, deps)
          const delayMs = c.wait_indefinitely === true ? null : timeoutMs(c.timeout_value, c.timeout_unit, null)
          return wait(ctx, { delayMs }, {}, deps.now)
        }
        const joined = replies.map((r) => String(r.text ?? '')).filter((t) => t.length > 0).join('\n')
        ctx.setVar('last_user_message', joined)
        ctx.setVar('response', joined)
        await saveUserData(ctx, joined)
        const bufferS = c.buffer_enabled === true && typeof c.buffer_value === 'number' && c.buffer_value > 0 ? c.buffer_value : 0
        if (!bufferS) return done(ctx, 'source')
        // Buffer: a 1ª resposta abre a janela; as seguintes, dentro dela, reentram e se juntam. Ao vencer, segue `source`.
        const mark = ctx.vars.__await as AwaitMark
        const until = mark.buffer_until ?? new Date((deps.now ? deps.now() : new Date()).getTime() + bufferS * 1000).toISOString()
        if (new Date(until).getTime() <= (deps.now ? deps.now() : new Date()).getTime()) return done(ctx, 'source')
        return wait(ctx, { delayMs: null, deadlineAt: until, timeoutHandle: 'source' }, { buffer_until: until }, deps.now)
      },
    },
  }
}
