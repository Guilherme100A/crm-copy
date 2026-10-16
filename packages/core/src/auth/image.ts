// Detecção do tipo de imagem pelos magic bytes (o Content-Type declarado pelo cliente não é confiável).

export const AVATAR_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export type AvatarMime = (typeof AVATAR_MIME_TYPES)[number]
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024

const startsWith = (b: Uint8Array, sig: readonly number[], offset = 0) => sig.every((v, i) => b[offset + i] === v)
const ascii = (s: string) => [...s].map((ch) => ch.charCodeAt(0))

/** Mime detectado (`image/jpeg|png|webp|gif`) ou `null` se desconhecido. */
export function detectImageMime(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp'
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif'
  return null
}

export function isAvatarMime(mime: string | null): mime is AvatarMime {
  return mime !== null && (AVATAR_MIME_TYPES as readonly string[]).includes(mime)
}
