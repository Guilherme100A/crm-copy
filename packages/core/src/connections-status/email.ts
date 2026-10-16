// E-mail de desconexão (T47, AC-T47-04): para owner/admin da empresa, uma vez por queda, se a empresa não desligou
// `connection_status_emails_enabled`. Nome do produto só por `APP_NAME` (SPEC 1.4 nº 9).
import type { DisconnectKind } from '@crm/wa-port'

export interface DisconnectEmailInput {
  appName: string
  companyName: string
  connectionName: string
  phoneNumber: string | null
  reason: DisconnectKind | null
  disconnectedAt: Date
  /** Link para a tela de Conexões (`WEB_PUBLIC_URL`), quando houver. */
  connectionsUrl?: string | null
}

const REASONS: Record<DisconnectKind | 'unknown', string> = {
  transient: 'A conexão com o WhatsApp caiu. O sistema tenta reconectar sozinho; se não voltar, conecte de novo pela tela de Conexões.',
  loggedOut: 'A sessão foi encerrada no celular (aparelho desvinculado). Para voltar, conecte de novo lendo o QR Code ou com o código no telefone.',
  forbidden: 'O WhatsApp recusou a sessão deste número (erro 403). A conexão foi parada e não volta sozinha.',
  unknown: 'A conexão com o WhatsApp foi encerrada.',
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function disconnectEmail(i: DisconnectEmailInput): { subject: string; text: string; html: string } {
  const label = i.phoneNumber ? `${i.connectionName} (${i.phoneNumber})` : i.connectionName
  const why = REASONS[i.reason ?? 'unknown']
  const when = i.disconnectedAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  const subject = `${i.appName}: a conexão ${i.connectionName} foi desconectada`
  const lines = [
    `A conexão ${label} da empresa ${i.companyName} foi desconectada em ${when}.`,
    '',
    why,
    'Os fluxos que estavam aguardando resposta nessa conexão foram pausados e podem ser retomados quando ela voltar.',
    ...(i.connectionsUrl ? ['', `Conexões: ${i.connectionsUrl}`] : []),
    '',
    `Você recebe este aviso por ser proprietário ou administrador da empresa no ${i.appName}.`,
  ]
  const html = [
    `<p>A conexão <strong>${escapeHtml(label)}</strong> da empresa <strong>${escapeHtml(i.companyName)}</strong> foi desconectada em ${escapeHtml(when)}.</p>`,
    `<p>${escapeHtml(why)}</p>`,
    '<p>Os fluxos que estavam aguardando resposta nessa conexão foram pausados e podem ser retomados quando ela voltar.</p>',
    ...(i.connectionsUrl ? [`<p><a href="${escapeHtml(i.connectionsUrl)}">Abrir Conexões</a></p>`] : []),
    `<p>Você recebe este aviso por ser proprietário ou administrador da empresa no ${escapeHtml(i.appName)}.</p>`,
  ].join('\n')
  return { subject, text: lines.join('\n'), html }
}
