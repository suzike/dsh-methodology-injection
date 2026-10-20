/**
 * Host wire contract of dsh-methodology-injection, client side.
 *
 * The shapes here are frozen by agreement with the Host half (T2). Every field
 * the UI reads is listed; fields the Host may add later are ignored, never
 * rejected. All calls are same-origin `fetch` with credentials, exactly like the
 * shipped `@deepseek-ai/dsh-client-ui-deliverables` client bundle talks to its
 * own `/api/changes.*` routes.
 *
 * Failures surface as {@link ApiError}; a 404 on the trace route is a normal
 * "this Turn used no method" answer and is folded into `null` by the caller.
 *
 * @module dsh-methodology-injection/client/api
 */

/** One selectable methodology as the picker renders it. */
export interface MethodCard {
  /** Stable catalogue id (the value sent back in `arm`). */
  readonly id: string
  /** Display name (zh). */
  readonly name: string
  /** One-line promise shown under the name. */
  readonly tagline?: string
  /** Category label used as the list group header. */
  readonly badge?: string
  /** Free-form tags; only used for search matching. */
  readonly tags?: readonly string[]
  /** Full contract text kept for display (the Host also injects it). */
  readonly contract?: string
  /** Methods this one cannot be stacked with (Host-owned; shown as a hint). */
  readonly conflicts?: readonly string[]
}

/** One optional clause that can be appended to the armed contract. */
export interface AssistCard {
  /** Stable id (`counterexample`, `evidence`, `uncertainty`, `next-step`). */
  readonly id: string
  /** Display name (zh). */
  readonly name: string
  /** The sentence the Host appends. */
  readonly clause?: string
}

/** The catalogue payload carried inside every state snapshot. */
export interface Catalog {
  readonly methods: readonly MethodCard[]
  readonly assists: readonly AssistCard[]
}

/** One method currently armed on the session. */
export interface Armed {
  readonly methodId: string
  readonly name: string
  /** Selected assist ids; empty when the user took the bare method. */
  readonly assists: readonly string[]
  /** Turn the arm was created in, when the Host knows it. */
  readonly sinceTurn?: number
  /** `turn` (one Turn), `pinned` (sticky), or `stack`. */
  readonly mode?: string
  /** Extra methods when the Host armed a stack. */
  readonly stack?: readonly { readonly methodId: string; readonly name: string }[]
}

/** Trace row for the recall hint and the picker's "used before" marks. */
export interface TurnTrace {
  readonly turn: number
  readonly methodId: string
  readonly name: string
  readonly contractHash: string
  /** Epoch milliseconds. */
  readonly ts: number
}

/** The whole per-session state: one round trip, one atomic update. */
export interface SessionSnapshot {
  readonly sessionId: string
  readonly armed: Armed | null
  /** Newest first, at most five. */
  readonly recent: readonly TurnTrace[]
  readonly catalog: Catalog
  /** Host diagnostic channel name, when it exposes one. */
  readonly channel?: string
  readonly lastInjection?: { readonly turn?: number; readonly tokens?: number } | null
}

/** Contract of one Turn, fetched lazily by the trace badge. */
export interface TurnContract {
  readonly turn: number
  readonly methodId: string
  readonly name: string
  readonly contract: string
  readonly contractHash: string
  readonly assists?: readonly string[]
  readonly ts: number
}

/** A refused Host call, carrying the Host's own error dictionary. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/** Route table — one place to change if the Host ever renames a path. */
export const ROUTES = {
  state: '/api/methodology.state',
  arm: '/api/methodology.arm',
  release: '/api/methodology.release',
  trace: '/api/methodology.trace',
  diagnostics: '/api/methodology.diagnostics',
} as const

/** Codes the UI reacts to beyond showing `message`. */
export const CODES = {
  traceMissing: 'trace-not-found',
  budget: 'budget-exceeded',
  conflict: 'conflict',
  forbidden: 'method-not-allowed',
  unavailable: 'catalog-unavailable',
} as const

/** Read one JSON response, translating a refused call into {@link ApiError}. */
async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text.length === 0 ? null : JSON.parse(text)
  } catch {
    parsed = null
  }
  if (response.ok) return parsed as T
  const error = (parsed as { error?: { code?: unknown; message?: unknown } } | null)?.error
  const code = typeof error?.code === 'string' ? error.code : `http-${response.status}`
  const message = typeof error?.message === 'string' && error.message.length > 0
    ? error.message
    : `Host 拒绝了这个请求（HTTP ${response.status}）`
  throw new ApiError(response.status, code, message)
}

/** Issue one same-origin call and decode it, honouring the caller's abort signal. */
async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  })
  return readJson<T>(response)
}

/** Read the whole session state (armed method, recent turns, catalogue). */
export function fetchState(sessionId: string, signal?: AbortSignal): Promise<SessionSnapshot> {
  return call<SessionSnapshot>(`${ROUTES.state}?sessionId=${encodeURIComponent(sessionId)}`, { signal: signal ?? null })
}

/** Arm one method (plus optional assists) and receive the updated state. */
export function armMethod(
  sessionId: string,
  methodId: string,
  assists: readonly string[],
  signal?: AbortSignal,
): Promise<SessionSnapshot> {
  return call<SessionSnapshot>(ROUTES.arm, {
    method: 'POST',
    body: JSON.stringify({ sessionId, methodId, assists: [...assists] }),
    signal: signal ?? null,
  })
}

/** Drop the armed method and receive the updated state. */
export function releaseMethod(sessionId: string, signal?: AbortSignal): Promise<SessionSnapshot> {
  return call<SessionSnapshot>(ROUTES.release, {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
    signal: signal ?? null,
  })
}

/**
 * Read the contract a past Turn ran under.
 * @returns the contract, or `null` when that Turn carried no method.
 */
export async function fetchTrace(
  sessionId: string,
  turn: number,
  signal?: AbortSignal,
): Promise<TurnContract | null> {
  try {
    return await call<TurnContract>(
      `${ROUTES.trace}?sessionId=${encodeURIComponent(sessionId)}&turn=${String(turn)}`,
      { signal: signal ?? null },
    )
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.code === CODES.traceMissing)) return null
    throw error
  }
}

/** Trim a contract down to what a reader wants: the injection marker is noise. */
export function readableContract(contract: string): string {
  return contract
    .split('\n')
    .filter((line) => !/^\s*\[\[METHOD:[^\]]*\]\]\s*$/.test(line))
    .join('\n')
    .trim()
}
