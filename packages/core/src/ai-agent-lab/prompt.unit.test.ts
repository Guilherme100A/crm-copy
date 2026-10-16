import { describe, expect, it } from 'vitest'
import { generatePrompt, parseLockedBlocks, type PromptFields } from './prompt'

const fields: PromptFields = {
  name: 'Lia',
  role: 'consultora',
  primary_goal: 'sell',
  purpose: 'Vende cursos de inglês online.',
  audience: 'Adultos que trabalham.',
  personality: 'consultative',
  example_messages: 'Oi! Tudo bem?',
  business_rules: 'Parcelamos em 12x.',
  never_talk_about: 'política',
  use_emojis: false,
}

describe('AC-T79-03 generatePrompt', () => {
  it('monta os blocos a partir dos campos, na ordem, omitindo vazios', () => {
    const { prompt, blocks } = generatePrompt(fields)
    expect(blocks.map((b) => b.key)).toEqual(['identity', 'goal', 'purpose', 'audience', 'personality', 'examples', 'rules', 'never', 'style'])
    expect(blocks.every((b) => !b.locked)).toBe(true)
    expect(prompt).toContain('Você é Lia, consultora')
    expect(prompt).toContain('Parcelamos em 12x.')
    expect(prompt).toContain('Nunca fale sobre: política')
    expect(prompt).toContain('Não use emojis.')
    const empty = generatePrompt({ ...fields, purpose: '  ', audience: '', business_rules: '' })
    expect(empty.blocks.map((b) => b.key)).not.toContain('purpose')
    expect(empty.blocks.map((b) => b.key)).not.toContain('rules')
  })

  it('blocos travados entram verbatim: substituem o de mesmo key ou vão ao final', () => {
    const lockedText = '  REGRA FIXA:\n- nunca peça senha.\t\n'
    const locked = [
      { key: 'rules', title: 'Regras', text: lockedText },
      { key: 'safety', text: 'Não prometa resultados.' },
      { key: 'vazio', text: '' },
      'lixo',
    ]
    const { prompt, blocks } = generatePrompt(fields, locked)
    expect(blocks.find((b) => b.key === 'rules')).toEqual({ key: 'rules', title: 'Regras', locked: true, text: lockedText })
    expect(blocks.at(-1)).toMatchObject({ key: 'safety', locked: true, title: 'safety' })
    expect(prompt).toContain(lockedText)
    expect(prompt).not.toContain('Parcelamos em 12x.')
    expect(prompt.endsWith('Não prometa resultados.')).toBe(true)
    // mudar os campos não altera o texto travado
    expect(generatePrompt({ ...fields, business_rules: 'Outra regra' }, locked).prompt).toContain(lockedText)
  })

  it('parseLockedBlocks aceita `content` e gera key quando falta', () => {
    expect(parseLockedBlocks([{ content: 'A' }, { key: ' k ', text: 'B' }, null, 3])).toEqual([
      { key: 'locked_1', title: 'locked_1', text: 'A' },
      { key: 'k', title: 'k', text: 'B' },
    ])
    expect(parseLockedBlocks('x')).toEqual([])
  })
})
