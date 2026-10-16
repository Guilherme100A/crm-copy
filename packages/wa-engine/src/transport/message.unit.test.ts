import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { browserForSession } from './fingerprint'
import { normalizeJid, phoneFromUserJid, toIncomingMessage, toWaContact } from './message'
import { createProxyAgent, redactProxyUrl } from './proxy-agent'

describe('toIncomingMessage', () => {
  it('desembrulha temporária/visualização única e descreve a mídia', () => {
    const m = toIncomingMessage({
      key: { id: 'V', remoteJid: 'g@g.us', participant: '1@lid', participantAlt: '5511@s.whatsapp.net' },
      message: { ephemeralMessage: { message: { viewOnceMessageV2: { message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 4, fileLength: { toNumber: () => 900 }, fileSha256: Buffer.from([1, 2]).toString('base64') } } } } } },
    })
    expect(m).toMatchObject({ type: 'audioMessage', participant: '1@lid', participant_alt: '5511@s.whatsapp.net', media: { kind: 'audio', ptt: true, seconds: 4, size: 900, sha256: '0102' } })
  })

  it('documento com legenda e sem conteúdo', () => {
    expect(toIncomingMessage({ key: { id: 'D', remoteJid: 'a@s.whatsapp.net' }, message: { documentWithCaptionMessage: { message: { documentMessage: { caption: 'nota', fileName: 'n.pdf', mimetype: 'application/pdf' } } } } })).toMatchObject({
      text: 'nota',
      media: { kind: 'document', file_name: 'n.pdf', mime: 'application/pdf' },
    })
    expect(toIncomingMessage({ key: { id: 'E', remoteJid: 'a@s.whatsapp.net' }, message: { messageContextInfo: {} } })).toBeUndefined()
    expect(toIncomingMessage({ key: { id: 'E' }, message: { conversation: 'x' } })).toBeUndefined()
  })
})

describe('utilitários', () => {
  it('JIDs, contatos, fingerprint e proxy', () => {
    expect(normalizeJid('5511:12@s.whatsapp.net')).toBe('5511@s.whatsapp.net')
    expect(phoneFromUserJid('123@lid')).toBeUndefined()
    expect(toWaContact({ id: '5511988887777@s.whatsapp.net', notify: 'Zé' })).toEqual({ jid: '5511988887777@s.whatsapp.net', phone: '+5511988887777', lid: null, push_name: 'Zé' })
    expect(browserForSession('a')).toEqual(browserForSession('a'))
    expect(redactProxyUrl('http://u:p@h:1')).not.toContain('p@')
    expect(() => createProxyAgent('ftp://h')).toThrow(/não suportado/)
    expect(createProxyAgent('socks5://h:1080')).toBeTruthy()
  })
})

describe('fronteira do Baileys (AC-T07-06)', () => {
  it('só transport, antiban, auth-state e media do engine importam o Baileys', () => {
    const root = join(import.meta.dirname, '..', '..', '..', '..')
    const allowed = ['packages/wa-engine/src/transport/', 'packages/wa-engine/src/antiban/', 'packages/wa-engine/src/auth-state/', 'packages/wa-engine/src/media/']
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'dist', '.git', 'spec', 'tests'].includes(e.name)) continue
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|tsx|mts)$/.test(e.name) && !e.name.includes('.test.')) {
          const rel = relative(root, p).replaceAll('\\', '/')
          if (/from\s+['"]@whiskeysockets\/baileys['"]|import\(\s*['"]@whiskeysockets\/baileys['"]\s*\)/.test(readFileSync(p, 'utf8')) && !allowed.some((a) => rel.startsWith(a))) offenders.push(rel)
        }
      }
    }
    for (const d of ['apps', 'packages']) walk(join(root, d))
    expect(offenders).toEqual([])
  })
})
