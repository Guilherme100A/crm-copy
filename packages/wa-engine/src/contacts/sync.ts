// ContactSync (T21, AI-MANAGER-MAP §13.5 A5): contatos (`contacts.upsert/update`) e mapeamentos LID↔PN
// (`lid-mapping.update`) do transporte viram WaEvents `contact.upsert` e `contact.lid_mapping`. O CRM guarda a
// identidade (phone_e164 / wa_lid) e faz o merge; `public.contacts` não muda.
import { WA_EVENT_VERSION, type WaContact, type WaEvent } from '@crm/wa-port'
import type { LidMapping, WaTransport } from '../transport'

export function contactEvent(sessionId: string, at: string, contact: WaContact): WaEvent {
  const c: WaContact = { jid: contact.jid, phone: contact.phone ?? null }
  if (contact.lid !== undefined) c.lid = contact.lid
  if (contact.name !== undefined) c.name = contact.name
  if (contact.push_name !== undefined) c.push_name = contact.push_name
  return { v: WA_EVENT_VERSION, type: 'contact.upsert', session_id: sessionId, at, contact: c }
}

/** `pn` no fio é o telefone E.164 quando conhecido (porta: `pn` = telefone); senão o JID PN. */
export function lidMappingEvent(sessionId: string, at: string, mapping: LidMapping): WaEvent {
  return { v: WA_EVENT_VERSION, type: 'contact.lid_mapping', session_id: sessionId, at, lid: mapping.lid, pn: mapping.phone ?? mapping.pn }
}

export type ContactPublish = (sessionId: string, build: (at: string) => WaEvent) => void

export class ContactSync {
  constructor(private readonly publish: ContactPublish) {}

  /** Liga `contact` e `lid-mapping` do transporte; devolve a função que desliga. */
  attach(sessionId: string, transport: Pick<WaTransport, 'on' | 'off'>): () => void {
    const onContact = (contact: WaContact) => this.publish(sessionId, (at) => contactEvent(sessionId, at, contact))
    const onMapping = (mapping: LidMapping) => this.publish(sessionId, (at) => lidMappingEvent(sessionId, at, mapping))
    transport.on('contact', onContact)
    transport.on('lid-mapping', onMapping)
    return () => {
      transport.off('contact', onContact)
      transport.off('lid-mapping', onMapping)
    }
  }

  /** Contatos e mapeamentos que chegaram num lote de histórico. */
  publishBatch(sessionId: string, contacts: WaContact[], mappings: LidMapping[]): void {
    for (const c of contacts) this.publish(sessionId, (at) => contactEvent(sessionId, at, c))
    for (const m of mappings) this.publish(sessionId, (at) => lidMappingEvent(sessionId, at, m))
  }
}
