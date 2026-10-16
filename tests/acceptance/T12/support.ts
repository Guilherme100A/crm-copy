// Apoio da suíte T12 (não é arquivo de teste). Superfície pública de @crm/ai (combinada com o Operário):
// - '@crm/ai/aisdk': createAiSdkProvider({ resolveCredentials, fetch?, createModel?, generate?, factories?, openRouter? }),
//   OPENROUTER_PROVIDER_SETTINGS, OPENROUTER_MODEL_SETTINGS
// - '@crm/ai/elevenlabs': ElevenLabsTts   - '@crm/ai/groq': GroqStt   - '@crm/ai/audio': toPttOgg, AudioConversionError
// - '@crm/ai': LlmUpstreamError (porta T04)
// O SDK `ai` (MockLanguageModelV4, generateText) e o provider OpenRouter vêm das dependências do próprio @crm/ai
// (a raiz não depende deles). Nenhum teste faz rede real nem executa ffmpeg: fetch e runner são sempre injetados.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rootPath } from '../helpers/exec'

const AI_NM = rootPath('packages', 'ai', 'node_modules')

async function importFrom(rel: string): Promise<any> {
  const file = resolve(AI_NM, rel)
  if (!existsSync(file)) throw new Error(`dependência de @crm/ai não instalada: ${rel} (rode pnpm install)`)
  return import(pathToFileURL(file).href)
}

export const aiTest = () => importFrom('ai/dist/test/index.js')
export const aiCore = () => importFrom('ai/dist/index.js')
/** zod da dependência do @crm/ai (a raiz não tem zod). */
export const zodPkg = () => importFrom('zod/index.js')
export const openRouterPkg = () => importFrom('@openrouter/ai-sdk-provider/dist/index.mjs').catch(() => importFrom('@openrouter/ai-sdk-provider/dist/index.js'))

export const aisdk = (): Promise<any> => import('@crm/ai/aisdk')
export const eleven = (): Promise<any> => import('@crm/ai/elevenlabs')
export const groq = (): Promise<any> => import('@crm/ai/groq')
export const audio = (): Promise<any> => import('@crm/ai/audio')
export const port = (): Promise<any> => import('@crm/ai')

/** Uso no formato LanguageModelV4Usage (ai@7). */
export function v4Usage(o: { input: number; output: number; cacheRead?: number; cacheWrite?: number; reasoning?: number }) {
  return {
    inputTokens: { total: o.input, noCache: o.input - (o.cacheRead ?? 0), cacheRead: o.cacheRead ?? 0, cacheWrite: o.cacheWrite ?? 0 },
    outputTokens: { total: o.output, text: o.output - (o.reasoning ?? 0), reasoning: o.reasoning ?? 0 },
  }
}

export const finish = (unified: string) => ({ unified, raw: unified })

/** Pedido mínimo da porta LlmProvider. */
export function llmReq(extra: Record<string, unknown> = {}) {
  return {
    model: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    instructions: 'Você é um assistente de testes.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }],
    tenantId: 'company-A',
    agentId: 'agent-1',
    ...extra,
  }
}

export interface Captured {
  url: string
  method: string
  headers: Headers
  body: unknown
  raw: Request
}

/** fetch falso que registra as requisições (URL, headers, corpo JSON ou FormData) e responde com `reply`. */
export function fakeFetch(reply: (c: Captured) => Response | Promise<Response>) {
  const calls: Captured[] = []
  const fn = async (input: any, init?: any): Promise<Response> => {
    const req = new Request(input instanceof Request ? input : String(input), init)
    const ct = req.headers.get('content-type') ?? ''
    let body: unknown
    if (ct.includes('multipart/form-data')) body = await req.clone().formData()
    else {
      const text = await req.clone().text()
      try {
        body = text ? JSON.parse(text) : undefined
      } catch {
        body = text
      }
    }
    const c = { url: req.url, method: req.method, headers: req.headers, body, raw: req }
    calls.push(c)
    return reply(c)
  }
  return Object.assign(fn, { calls })
}

export const jsonResponse = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
