// Telefone E.164 → JID individual do WhatsApp (o transporte recebe JIDs).

/** `+5511999999999` → `5511999999999@s.whatsapp.net`. Valores que já são JID passam direto. */
export function phoneToJid(phone: string): string {
  if (phone.includes('@')) return phone
  const digits = phone.replace(/\D/g, '')
  if (!digits) throw new Error(`invalid phone: ${phone}`)
  return `${digits}@s.whatsapp.net`
}
