// QR do WhatsApp como data URL (image/png) para a API/UI (ai-manager apps/worker/src/sessions/qr.ts).
import QRCode from 'qrcode'

export function toQrDataUrl(qr: string): Promise<string> {
  return QRCode.toDataURL(qr, { errorCorrectionLevel: 'M', margin: 2, width: 300 })
}
