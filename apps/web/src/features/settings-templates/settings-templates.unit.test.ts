import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { insertAt, templateIssue, templateText, toTemplateInput } from './rules'

describe('AC-T58-02 modelos de mensagem — regras do editor', () => {
  it('monta o texto como o servidor: cabeçalho, corpo, menu numerado, links e rodapé', () => {
    const text = templateText({
      header: { type: 'text', text: ' Oi {first_name} ' },
      body: 'Seu pedido saiu.',
      footer: ' Equipe ',
      buttons: [
        { type: 'reply', text: 'Sim' },
        { type: 'url', text: 'Rastrear', url: 'https://x.y' },
        { type: 'reply', text: 'Não' },
        { type: 'phone', text: 'Ligar', phone: '+5511' },
      ],
    })
    expect(text).toBe(
      'Oi {first_name}\n\nSeu pedido saiu.\n\n1 - Sim\n2 - Não\n\nRastrear: https://x.y\nLigar: +5511\n\nEquipe',
    )
    expect(templateText({ header: { type: 'image', media_id: 'm' }, body: 'só corpo', buttons: [] })).toBe('só corpo')
  })

  it('insere a variável no cursor', () => {
    expect(insertAt('Olá !', '{first_name}', 4)).toEqual({ text: 'Olá {first_name}!', cursor: 16 })
    expect(insertAt('abc', '{x}', 1, 3)).toEqual({ text: 'a{x}', cursor: 4 })
    expect(insertAt('abc', '{x}', 99)).toEqual({ text: 'abc{x}', cursor: 6 })
  })

  it('valida antes de enviar e normaliza o corpo do POST', () => {
    const base = { name: 'Boas vindas', header: { type: 'none' as const }, body: 'Oi', footer: '', buttons: [] }
    expect(templateIssue({ ...base, name: ' ' })).toBe('name')
    expect(templateIssue({ ...base, header: { type: 'text', text: '' } })).toBe('header_text')
    expect(templateIssue({ ...base, header: { type: 'video' } })).toBe('header_media')
    expect(templateIssue({ ...base, body: '  ' })).toBe('body')
    expect(templateIssue({ ...base, buttons: [{ type: 'url', text: 'Site', url: '' }] })).toEqual({
      button: 0,
      field: 'url',
    })
    expect(templateIssue(base)).toBeNull()
    expect(
      toTemplateInput({
        ...base,
        name: ' X ',
        header: { type: 'image', text: 'lixo', media_id: 'm1' },
        footer: '  ',
        buttons: [{ type: 'reply', text: ' A ', url: 'z' }],
      }),
    ).toEqual({
      name: 'X',
      header: { type: 'image', media_id: 'm1' },
      body: 'Oi',
      footer: null,
      buttons: [{ type: 'reply', text: 'A' }],
    })
  })

  it('nenhum texto da aba menciona provedor oficial ou aprovação', () => {
    const dir = fileURLToPath(new URL('../../i18n', import.meta.url))
    for (const locale of readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)) {
      const raw = readFileSync(join(dir, locale, 'settings-templates.json'), 'utf8')
      expect(raw).not.toMatch(/meta|waba|aprova|approv|aprob/i)
    }
  })
})
