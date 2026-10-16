// Conversões transporte → WaEvent v1 (`@crm/wa-port`, snake_case no fio). Funções puras.
import { WA_EVENT_VERSION, type IncomingMessage as WaIncomingMessage, type MediaHandle, type WaEvent } from '@crm/wa-port'
import type { IncomingMessage, PresenceUpdate } from '../transport'

/** Mensagem do transporte → `IncomingMessage` da porta (sem a `key` crua e sem campos que a porta não tem). */
export function toWaMessage(msg: IncomingMessage, media?: MediaHandle): WaIncomingMessage {
  const out: WaIncomingMessage = { id: msg.id, from: msg.from, from_me: msg.from_me, timestamp: msg.timestamp, type: msg.type }
  if (msg.alt_jid) out.alt_jid = msg.alt_jid
  if (msg.participant) out.participant = msg.participant
  if (msg.push_name) out.push_name = msg.push_name
  if (msg.text !== undefined) out.text = msg.text
  if (media) out.media = media
  if (msg.quoted_id) out.quoted_id = msg.quoted_id
  if (msg.ad) out.ad = msg.ad
  if (msg.historical) out.historical = true
  return out
}

export function inboundEvent(sessionId: string, at: string, msg: IncomingMessage, media?: MediaHandle): WaEvent {
  return { v: WA_EVENT_VERSION, type: 'message.inbound', session_id: sessionId, at, message: toWaMessage(msg, media) }
}

export function presenceEvent(sessionId: string, at: string, update: PresenceUpdate): WaEvent {
  const event: WaEvent = { v: WA_EVENT_VERSION, type: 'presence.update', session_id: sessionId, at, jid: update.jid, presence: update.presence }
  if (update.participant) event.participant = update.participant
  if (update.last_seen !== undefined) event.last_seen = update.last_seen
  return event
}
