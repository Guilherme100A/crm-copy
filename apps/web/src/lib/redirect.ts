// Redirect pós-login seguro (spec 18 §2.2): só caminhos relativos da própria SPA. Começa com `/` e não pode começar
// com `//` nem conter `://` ou `\` (evita open redirect).

export function isSafeRedirect(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false
  if (!value.startsWith('/') || value.startsWith('//')) return false
  if (value.includes('://') || value.includes('\\')) return false
  // Caracteres de controle (ex.: `/\t/evil.com`) também são recusados.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

/** O redirect se for seguro; senão o fallback (a home do usuário). */
export function safeRedirect(value: unknown, fallback: string): string {
  return isSafeRedirect(value) ? value : fallback
}

/** `/login?redirect=<caminho+query>` para o caminho atual (o login é público). */
export function loginPath(current: string): string {
  return isSafeRedirect(current) && !current.startsWith('/login') ? `/login?redirect=${encodeURIComponent(current)}` : '/login'
}
