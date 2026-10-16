// Cliente do `POST /internal/rpc { target, method, args }` (padrão do ai-manager apps/api/src/bridge/client.ts):
// Bearer INTERNAL_TOKEN, timeout por chamada (AbortSignal), `{ result }` no sucesso e `{ error }` re-hidratado.
import { reviveError, WorkerUnavailableError, type RemoteErrorPayload } from './errors'

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>

export interface RpcClientOptions {
  /** Base do wa-worker, ex.: `http://127.0.0.1:3100` (`WA_RPC_URL`). */
  url: string
  /** `INTERNAL_TOKEN`. */
  token: string
  /** Timeout padrão de cada chamada (ms). */
  timeoutMs: number
  /** Nome do perfil (só para as mensagens de erro). */
  profile: string
  fetch?: FetchLike
}

export interface RpcCallOptions {
  timeoutMs?: number
}

export interface RpcClient {
  call<T = unknown>(target: string, method: string, args: unknown[], opts?: RpcCallOptions): Promise<T>
}

const isTimeout = (err: unknown) => err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function createRpcClient(opts: RpcClientOptions): RpcClient {
  const endpoint = `${opts.url.replace(/\/+$/, '')}/internal/rpc`
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init))

  return {
    async call<T>(target: string, method: string, args: unknown[], callOpts: RpcCallOptions = {}): Promise<T> {
      const rpc = `${target}.${method}`
      const timeoutMs = callOpts.timeoutMs ?? opts.timeoutMs
      const signal = AbortSignal.timeout(timeoutMs)
      let res: Awaited<ReturnType<FetchLike>>
      let payload: { result?: unknown; error?: RemoteErrorPayload }
      try {
        res = await doFetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.token}` },
          body: JSON.stringify({ target, method, args }),
          signal,
        })
      } catch (err) {
        if (isTimeout(err) || signal.aborted) throw new WorkerUnavailableError(`wa-worker não respondeu ${rpc} em ${timeoutMs} ms`, 'timeout', { cause: err })
        throw new WorkerUnavailableError(`wa-worker inacessível (${rpc}): ${messageOf(err)}`, 'unreachable', { cause: err })
      }
      try {
        payload = (await res.json()) as typeof payload
      } catch (err) {
        if (isTimeout(err) || signal.aborted) throw new WorkerUnavailableError(`wa-worker não respondeu ${rpc} em ${timeoutMs} ms`, 'timeout', { cause: err })
        throw new WorkerUnavailableError(`resposta inválida do wa-worker (${rpc}, HTTP ${res.status})`, 'invalid_response', { cause: err })
      }
      if (!payload || typeof payload !== 'object') throw new WorkerUnavailableError(`resposta inválida do wa-worker (${rpc}, HTTP ${res.status})`, 'invalid_response')
      if (payload.error && typeof payload.error === 'object') {
        // 401 do middleware (token) ≠ SendRejectedError UNAUTHORIZED (gate auth, sem actor), que é erro de domínio.
        if (res.status === 401 && payload.error.name !== 'SendRejectedError') throw new WorkerUnavailableError('o wa-worker recusou o INTERNAL_TOKEN', 'unauthorized')
        throw reviveError(payload.error, res.status, { rpc, profile: opts.profile })
      }
      if (res.status >= 400 || !('result' in payload)) throw new WorkerUnavailableError(`resposta inválida do wa-worker (${rpc}, HTTP ${res.status})`, 'invalid_response')
      return payload.result as T
    },
  }
}
