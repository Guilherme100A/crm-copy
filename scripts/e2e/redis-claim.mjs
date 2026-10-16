// Reserva do db do Redis do harness (T122): o serve.mjs grava no db escolhido a chave `e2e:harness:owner`
// (`SET NX EX`, renovada enquanto o harness vive, apagada ao sair) com o root e o pid. Se o db já tem dono de OUTRO
// worktree com o processo vivo, tenta o próximo. Cliente RESP mínimo sobre node:net: o serve.mjs roda com o node
// puro, sem as dependências dos pacotes.
import { connect } from 'node:net'
import { isPidAlive, normalizeRoot, redisDbCandidates, withRedisDb } from './ports.mjs'

export const OWNER_KEY = 'e2e:harness:owner'
export const OWNER_TTL_S = 30
export const OWNER_REFRESH_MS = 10_000

/** Codifica um comando RESP. */
export function encodeCommand(args) {
  let out = `*${args.length}\r\n`
  for (const a of args) {
    const s = String(a)
    out += `$${Buffer.byteLength(s)}\r\n${s}\r\n`
  }
  return out
}

/** Lê UMA resposta RESP de `buf` a partir de `pos`; `null` se ainda incompleta. */
export function parseReply(buf, pos = 0) {
  const eol = buf.indexOf('\r\n', pos)
  if (eol < 0) return null
  const type = String.fromCharCode(buf[pos])
  const line = buf.toString('utf8', pos + 1, eol)
  const next = eol + 2
  if (type === '+') return { value: line, end: next }
  if (type === '-') return { value: new Error(line), end: next }
  if (type === ':') return { value: Number(line), end: next }
  if (type === '$') {
    const len = Number(line)
    if (len < 0) return { value: null, end: next }
    if (buf.length < next + len + 2) return null
    return { value: buf.toString('utf8', next, next + len), end: next + len + 2 }
  }
  if (type === '*') {
    const n = Number(line)
    const items = []
    let at = next
    for (let i = 0; i < n; i++) {
      const r = parseReply(buf, at)
      if (!r) return null
      items.push(r.value)
      at = r.end
    }
    return { value: n < 0 ? null : items, end: at }
  }
  throw new Error(`resposta RESP inválida: ${type}`)
}

/** Conexão simples: `send(...args)` em série; AUTH e SELECT a partir da URL. */
export async function openRedis(url, { timeoutMs = 3000 } = {}) {
  const u = new URL(url)
  const socket = connect({ host: u.hostname || '127.0.0.1', port: Number(u.port || 6379) })
  socket.setTimeout(timeoutMs)
  let buf = Buffer.alloc(0)
  const waiters = []
  const fail = (err) => {
    while (waiters.length) waiters.shift().reject(err)
  }
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      if (!waiters.length) break
      const r = parseReply(buf)
      if (!r) break
      buf = buf.subarray(r.end)
      const w = waiters.shift()
      if (r.value instanceof Error) w.reject(r.value)
      else w.resolve(r.value)
    }
  })
  socket.on('error', fail)
  socket.on('timeout', () => {
    fail(new Error('Redis não respondeu'))
    socket.destroy()
  })
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const send = (...args) =>
    new Promise((resolve, reject) => {
      waiters.push({ resolve, reject })
      socket.write(encodeCommand(args))
    })
  const password = u.password ? decodeURIComponent(u.password) : ''
  if (password) await (u.username ? send('AUTH', decodeURIComponent(u.username), password) : send('AUTH', password))
  const db = Number(u.pathname.replace(/^\//, '') || '0')
  if (db) await send('SELECT', db)
  return {
    send,
    close: () =>
      new Promise((resolve) => {
        socket.end(() => resolve())
        setTimeout(resolve, 200).unref?.()
      }),
  }
}

/** Valor da reserva: worktree, pid e (T124) o banco Postgres do harness, protegido da limpeza de órfãos. */
const ownerValue = (root, pid, info = {}) => JSON.stringify({ root: normalizeRoot(root), pid, ...info })

/** Tenta reservar o db da URL; `true` se ficou com ele (novo ou já era deste root/pid). */
export async function tryClaim(url, root, pid = process.pid, key = OWNER_KEY, info = {}) {
  const r = await openRedis(url)
  try {
    const value = ownerValue(root, pid, info)
    if ((await r.send('SET', key, value, 'NX', 'EX', OWNER_TTL_S)) === 'OK') return true
    const current = await r.send('GET', key)
    let owner = null
    try {
      owner = current ? JSON.parse(current) : null
    } catch {
      owner = null
    }
    // Dono morto (processo encerrado sem limpar) ou do mesmo worktree com outro pid já encerrado: toma o db.
    if (!owner || (owner.pid !== pid && !isPidAlive(owner.pid)) || (owner.root === normalizeRoot(root) && owner.pid === pid)) {
      await r.send('SET', key, value, 'EX', OWNER_TTL_S)
      return true
    }
    return false
  } finally {
    await r.close()
  }
}

/**
 * Escolhe e reserva um db livre a partir do candidato (cíclico em 2..15). Devolve a URL efetiva e `release()`,
 * que para a renovação e apaga a chave (só se ainda for deste processo).
 */
export async function claimRedisDb(baseUrl, firstDb, root, pid = process.pid, key = OWNER_KEY, info = {}) {
  for (const db of redisDbCandidates(firstDb)) {
    const url = withRedisDb(baseUrl, db)
    if (!(await tryClaim(url, root, pid, key, info))) continue
    const value = ownerValue(root, pid, info)
    const timer = setInterval(() => {
      openRedis(url)
        .then(async (r) => {
          try {
            if ((await r.send('GET', key)) === value) await r.send('EXPIRE', key, OWNER_TTL_S)
          } finally {
            await r.close()
          }
        })
        .catch(() => undefined)
    }, OWNER_REFRESH_MS)
    timer.unref?.()
    return {
      url,
      db,
      release: async () => {
        clearInterval(timer)
        try {
          const r = await openRedis(url)
          try {
            if ((await r.send('GET', key)) === value) await r.send('DEL', key)
          } finally {
            await r.close()
          }
        } catch {
          // Redis fora: a chave expira sozinha
        }
      },
    }
  }
  throw new Error('nenhum db do Redis livre (2..15) para o harness E2E')
}

/**
 * Bancos Postgres de harnesses VIVOS (de qualquer worktree), lidos das reservas `e2e:harness:owner` nos dbs 2..15
 * (T124): ficam fora da limpeza de órfãos mesmo sem conexão no momento. Redis fora do ar → lista vazia.
 */
export async function liveHarnessDatabases(baseUrl, key = OWNER_KEY) {
  const out = []
  for (const db of redisDbCandidates(2)) {
    try {
      const r = await openRedis(withRedisDb(baseUrl, db))
      try {
        const raw = await r.send('GET', key)
        const owner = raw ? JSON.parse(raw) : null
        if (owner && typeof owner.database === 'string' && isPidAlive(owner.pid)) out.push(owner.database)
      } finally {
        await r.close()
      }
    } catch {
      // db sem reserva legível ou Redis fora: segue
    }
  }
  return out
}
