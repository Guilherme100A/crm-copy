import { describe, expect, it } from 'vitest'
import { HttpError } from '@/lib/http'
import { isFieldError, serverMessage, totalPages } from './kit'
import {
  draftFromDto,
  draftIssue,
  emptyConfig,
  MAX_ACTIONS,
  mediaTypeOf,
  moveItem,
  normalizeShortcut,
  toInput,
  type DraftAction,
} from './rules'

const msg = (text: string, key = text): DraftAction => ({ key, type: 'send_message', config: { message_text: text } })

describe('AC-T58-01 respostas rápidas — regras do editor', () => {
  it('normaliza o atalho como o servidor', () => {
    expect(normalizeShortcut('  Olá  Mundo!! 2_x-y ')).toBe('ol mundo 2_x-y')
    expect(normalizeShortcut('###')).toBe('')
  })

  it('reordena as ações e a ordem enviada segue a posição', () => {
    const list = [msg('a'), msg('b'), msg('c')]
    const moved = moveItem(list, 2, 0)
    expect(moved.map((a) => a.config.message_text)).toEqual(['c', 'a', 'b'])
    expect(moveItem(list, 0, 9)).toEqual(list)
    expect(toInput('oi', moved).actions.map((a) => [a.order, a.config.message_text])).toEqual([
      [0, 'c'],
      [1, 'a'],
      [2, 'b'],
    ])
  })

  it('corpo do POST só leva os campos do tipo (mídia sem legenda vazia, contato aparado)', () => {
    const input = toInput(' Boas Vindas ', [
      { key: '1', type: 'send_multi_media', config: { media_type: 'video', media_id: 'm1', caption: '  ', extra: 1 } },
      { key: '2', type: 'send_contact', config: { contact_name: ' Ana ', contact_phone: ' +5511 ' } },
      { key: '3', type: 'send_sticker', config: { sticker_id: 's1' } },
    ])
    expect(input).toEqual({
      shortcut: 'boas vindas',
      actions: [
        { type: 'send_multi_media', order: 0, config: { media_type: 'video', media_id: 'm1' } },
        { type: 'send_contact', order: 1, config: { contact_name: 'Ana', contact_phone: '+5511' } },
        { type: 'send_sticker', order: 2, config: { sticker_id: 's1' } },
      ],
    })
  })

  it('aponta a primeira pendência antes de enviar', () => {
    expect(draftIssue('', [msg('a')])).toBe('shortcut')
    expect(draftIssue('oi', [])).toBe('no_actions')
    expect(
      draftIssue(
        'oi',
        Array.from({ length: MAX_ACTIONS + 1 }, (_, i) => msg(`m${i}`)),
      ),
    ).toBe('too_many')
    expect(
      draftIssue('oi', [msg('a'), { key: 'x', type: 'send_multi_media', config: emptyConfig('send_multi_media') }]),
    ).toEqual({ index: 1, field: 'media_id' })
    expect(
      draftIssue('oi', [{ key: 'x', type: 'send_contact', config: { contact_name: 'Ana', contact_phone: ' ' } }]),
    ).toEqual({ index: 0, field: 'contact_phone' })
    expect(draftIssue('oi', [msg('a')])).toBeNull()
  })

  it('carrega as ações do DTO na ordem e infere o tipo de mídia pelo MIME', () => {
    const drafts = draftFromDto([
      { id: 'b', type: 'send_message', order: 1, config: { message_text: 'dois' } },
      { id: 'a', type: 'send_message', order: 0, config: { message_text: 'um' } },
    ])
    expect(drafts.map((d) => d.key)).toEqual(['a', 'b'])
    expect([
      mediaTypeOf('image/png'),
      mediaTypeOf('VIDEO/mp4'),
      mediaTypeOf('audio/ogg'),
      mediaTypeOf('application/pdf'),
    ]).toEqual(['image', 'video', 'audio', 'document'])
  })

  it('atalho duplicado: a mensagem do servidor vai para o campo', () => {
    const err = new HttpError(409, 'CONFLICT', 'Atalho já existe', {
      error_code: 'shortcut_taken',
      fields: [{ path: 'shortcut', message: 'Já existe uma resposta rápida com esse atalho' }],
    })
    expect(isFieldError(err, 'shortcut')).toBe(true)
    expect(serverMessage(err, 'shortcut')).toBe('Já existe uma resposta rápida com esse atalho')
    expect(serverMessage(err)).toBe('Atalho já existe')
    expect(isFieldError(new HttpError(409, 'CONFLICT', 'x', { field: 'name' }), 'name')).toBe(true)
    expect(serverMessage(new Error('x'))).toBeNull()
  })

  it('paginação: total de páginas pela contagem ou por has_more', () => {
    expect(totalPages({ page: 1, limit: 20, total_count: 41, has_more: true })).toBe(3)
    expect(totalPages({ page: 2, limit: 20, total_count: null, has_more: true })).toBe(3)
    expect(totalPages({ page: 1, limit: 20, total_count: 0, has_more: false })).toBe(1)
    expect(totalPages(undefined)).toBe(1)
  })
})
