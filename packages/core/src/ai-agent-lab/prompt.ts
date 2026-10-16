// Geração do prompt do agente a partir do formulário (T79; 07 §3.1, §5 item 5). Determinística, sem LLM: cada campo
// preenchido vira um bloco; os `locked_blocks` (travados pela plataforma) entram VERBATIM, substituindo o bloco de
// mesmo `key` ou ao final, na ordem em que estão no agente.

export interface PromptFields {
  name: string
  role: string
  primary_goal: string
  purpose: string
  audience: string
  personality: string
  example_messages: string
  business_rules: string
  never_talk_about: string
  use_emojis: boolean
}

export interface PromptBlock {
  key: string
  title: string
  locked: boolean
  text: string
}

export const GOAL_TEXT: Readonly<Record<string, string>> = {
  sell: 'Seu objetivo principal é vender: conduza a conversa até o fechamento, sem pressionar.',
  schedule: 'Seu objetivo principal é agendar: leve o cliente a marcar um horário.',
  answer: 'Seu objetivo principal é tirar dúvidas com clareza e precisão.',
  qualify: 'Seu objetivo principal é qualificar o contato: descubra se ele tem perfil e interesse reais.',
}

export const PERSONALITY_TEXT: Readonly<Record<string, string>> = {
  seller: 'Tom de vendedor: animado, direto e persuasivo.',
  support: 'Tom de suporte: paciente, cuidadoso e didático.',
  consultative: 'Tom consultivo: faça perguntas, entenda o contexto e recomende.',
  casual: 'Tom descontraído: leve e próximo, como uma conversa entre conhecidos.',
}

const clean = (s: string | null | undefined) => (s ?? '').trim()

/** Lê `locked_blocks` do agente: `{ key, title?, text }` (texto não vazio); o resto é ignorado. */
export function parseLockedBlocks(raw: unknown): { key: string; title: string; text: string }[] {
  if (!Array.isArray(raw)) return []
  const out: { key: string; title: string; text: string }[] = []
  for (const b of raw) {
    if (!b || typeof b !== 'object') continue
    const o = b as Record<string, unknown>
    const text = typeof o.text === 'string' ? o.text : typeof o.content === 'string' ? o.content : null
    if (text === null || !text.length) continue
    const key = typeof o.key === 'string' && o.key.trim() ? o.key.trim() : `locked_${out.length + 1}`
    out.push({ key, title: typeof o.title === 'string' ? o.title : key, text })
  }
  return out
}

/** Blocos do prompt (campos + travados). */
export function promptBlocks(f: PromptFields, lockedRaw: unknown = []): PromptBlock[] {
  const blocks: PromptBlock[] = []
  const add = (key: string, title: string, text: string) => {
    if (text) blocks.push({ key, title, locked: false, text })
  }
  const name = clean(f.name)
  const role = clean(f.role)
  add('identity', 'Quem você é', name ? `Você é ${name}${role ? `, ${role}` : ''}, atendente virtual desta empresa no WhatsApp.` : '')
  add('goal', 'Objetivo', GOAL_TEXT[f.primary_goal] ?? '')
  add('purpose', 'O que você faz', clean(f.purpose))
  add('audience', 'Quem é o cliente', clean(f.audience))
  add('personality', 'Personalidade', PERSONALITY_TEXT[f.personality] ?? '')
  const examples = clean(f.example_messages)
  add('examples', 'Exemplos de como falar', examples ? `Escreva no mesmo estilo destes exemplos:\n${examples}` : '')
  add('rules', 'Regras do negócio', clean(f.business_rules))
  const never = clean(f.never_talk_about)
  add('never', 'Nunca fale sobre', never ? `Nunca fale sobre: ${never}` : '')
  add(
    'style',
    'Estilo',
    ['Responda em mensagens curtas, como numa conversa de WhatsApp.', f.use_emojis ? 'Use no máximo 1 emoji por mensagem.' : 'Não use emojis.'].join(' '),
  )
  for (const lb of parseLockedBlocks(lockedRaw)) {
    const locked: PromptBlock = { key: lb.key, title: lb.title, locked: true, text: lb.text }
    const at = blocks.findIndex((b) => b.key === lb.key)
    if (at >= 0) blocks[at] = locked
    else blocks.push(locked)
  }
  return blocks
}

/** Prompt final: blocos separados por linha em branco. Os travados entram exatamente como estão. */
export function renderPrompt(blocks: readonly PromptBlock[]): string {
  return blocks.map((b) => b.text).join('\n\n')
}

export function generatePrompt(f: PromptFields, lockedRaw: unknown = []): { prompt: string; blocks: PromptBlock[] } {
  const blocks = promptBlocks(f, lockedRaw)
  return { prompt: renderPrompt(blocks), blocks }
}
