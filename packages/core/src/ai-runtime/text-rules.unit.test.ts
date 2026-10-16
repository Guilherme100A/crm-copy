import { describe, expect, it } from 'vitest'
import { audioBlockReason, canSpeak, splitReply } from './text-rules'

describe('audioBlockReason', () => {
  it.each([
    ['Acesse https://loja.com/plano', 'link'],
    ['veja em www.exemplo.com.br', 'link'],
    ['O plano custa R$ 99,90', 'price'],
    ['são 150 reais por mês', 'price'],
    ['pode pagar no pix', 'pix'],
    ['use o cupom LEO10', 'code'],
    ['seu protocolo é 9876543', 'code'],
    ['Rua das Flores 10', 'address'],
    ['- item um\n- item dois', 'list'],
  ])('%s → %s', (text, reason) => {
    expect(audioBlockReason(text)).toBe(reason)
    expect(canSpeak(text)).toBe(false)
  })

  it('texto conversacional pode virar áudio', () => {
    expect(canSpeak('Claro, posso te ajudar com isso agora mesmo.')).toBe(true)
  })
})

describe('splitReply', () => {
  it('divide por parágrafo', () => {
    expect(splitReply('Oi!\n\nTudo bem?')).toEqual(['Oi!', 'Tudo bem?'])
  })

  it('vazio → nenhuma mensagem', () => {
    expect(splitReply('   ')).toEqual([])
  })

  it('parágrafo longo vira frases agrupadas', () => {
    const long = Array.from({ length: 12 }, (_, i) => `Esta é a frase número ${i} da resposta.`).join(' ')
    const parts = splitReply(long)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((p) => p.length <= 220)).toBe(true)
    expect(parts.join(' ')).toBe(long)
  })

  it('sobra vai junto na última mensagem', () => {
    expect(splitReply('a\n\nb\n\nc\n\nd\n\ne', 3)).toEqual(['a', 'b', 'c\n\nd\n\ne'])
  })
})
