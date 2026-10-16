// Contratos de T07 (AI-MANAGER-MAP §2 + contrato combinado com o Operário) usados pelos testes.
// Os testes falam só com o export público do transporte (`@crm/wa-engine/transport`), com um
// socket fake no formato `BaileysSocketLike`: nunca abrem rede nem carregam o Baileys real.
import { EventEmitter } from 'node:events'
import * as transport from '@crm/wa-engine/transport'

export const mod = transport as unknown as Record<string, any>

export function exp(name: string): any {
  const v = mod[name]
  if (v === undefined) throw new Error(`@crm/wa-engine/transport não exporta ${name} (exports: ${Object.keys(mod).join(', ') || '—'})`)
  return v
}

export interface SentCall {
  jid: string
  content: Record<string, any>
  options?: Record<string, any>
}

/** Socket fake: EventEmitter em `ev`, envios registrados em `sentCalls`. */
export function mockSocket() {
  const ev = new EventEmitter()
  const sentCalls: SentCall[] = []
  let seq = 0
  const sock = {
    ev,
    sentCalls,
    readCalls: [] as unknown[],
    presenceCalls: [] as unknown[],
    ended: 0,
    async sendMessage(jid: string, content: Record<string, any>, options?: Record<string, any>) {
      sentCalls.push({ jid, content, options })
      return { key: { id: `WAMID-${++seq}`, remoteJid: jid, fromMe: true } }
    },
    async readMessages(keys: unknown[]) {
      sock.readCalls.push(keys)
    },
    async sendPresenceUpdate(type: string, jid?: string) {
      sock.presenceCalls.push({ type, jid })
    },
    async groupFetchAllParticipating() {
      return {}
    },
    async requestPairingCode() {
      return 'PAIR1234'
    },
    async logout() {},
    end() {
      sock.ended++
    },
    user: { id: '5511900000000:1@s.whatsapp.net', lid: '111111111111111:1@lid' },
  }
  return sock
}
export type MockSocket = ReturnType<typeof mockSocket>

export const AUTH = { creds: { registered: true, me: { id: '5511900000000:1@s.whatsapp.net' } }, keys: { get: async () => ({}), set: async () => {} } }

/** BaileysTransport com factory de socket injetada; cada `connect` cria um socket novo. */
export function setup() {
  const BaileysTransport = exp('BaileysTransport')
  const sockets: MockSocket[] = []
  const configs: any[] = []
  const t = new BaileysTransport({
    makeSocket: (config: any) => {
      configs.push(config)
      const s = mockSocket()
      sockets.push(s)
      return s
    },
  })
  const events: Array<{ event: string; payload: any }> = []
  for (const event of ['message', 'connection', 'receipt', 'history', 'qr', 'pairing-code', 'contact', 'lid-mapping', 'presence']) {
    t.on(event, (payload: any) => events.push({ event, payload }))
  }
  const of = (event: string) => events.filter((e) => e.event === event).map((e) => e.payload)
  return { t, sockets, configs, events, of }
}

export const flush = async (n = 3) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}

export const boom = (statusCode: number) => Object.assign(new Error(`closed ${statusCode}`), { output: { statusCode } })

export const LID = '123456789012345@lid'
export const PN = '5511999998888@s.whatsapp.net'

export function rawMessage(id: string, message: Record<string, unknown> = { conversation: 'oi' }, key: Record<string, unknown> = {}) {
  return {
    key: { id, remoteJid: LID, remoteJidAlt: PN, fromMe: false, ...key },
    message,
    messageTimestamp: 1_760_486_400,
    pushName: 'Maria',
  }
}
