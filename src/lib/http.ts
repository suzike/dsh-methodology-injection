/**
 * HTTP surface of the plugin.
 *
 * The wire contract is frozen by the client half (T3). Every route returns the *whole*
 * snapshot rather than an ack, so the chip, the panel and the turn-tail badge all read
 * from one source of truth and never disagree:
 *
 *   GET  /api/methodology.state?sessionId=<id>
 *   POST /api/methodology.arm      { sessionId, methodId, assists?, mode? }
 *   POST /api/methodology.release  { sessionId, methodId? }
 *   GET  /api/methodology.trace?sessionId=<id>&turn=<n>
 *   GET  /api/methodology.diagnostics
 *
 * Errors are always `{ error: { code, message } }`, and nothing is cached.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { assistCards, MAX_ASSISTS, resolveAssists } from './assists.js'
import type { MethodologyCatalog } from './catalog.js'
import { activeEntries, currentTurn } from './store.js'
import type { MethodologyStore } from './store.js'
import type { ArmedEntry, InjectionMode, SessionState, TraceEntry } from './types.js'

/** Largest JSON body we accept; the arm payload is a handful of fields. */
const BODY_LIMIT = 64 * 1024

export class HttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export interface HttpRuntime {
  store: MethodologyStore
  /** Resolved catalog, or `undefined` when the catalog could not be loaded. */
  catalog(): MethodologyCatalog | undefined
  /** Why the catalog is missing, for diagnostics. */
  catalogFailure(): string | undefined
  catalogLocation(): string
  version: string
  contextOrder: number
}

/** One exact webServer route. */
export interface Route {
  path: string
  methods: readonly string[]
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'content-length': String(Buffer.byteLength(payload)),
  })
  res.end(payload)
}

function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: { code: error.code, message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  sendJson(res, 500, { error: { code: 'internal-error', message } })
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.byteLength
    if (size > BODY_LIMIT) {
      throw new HttpError(413, 'payload-too-large', `请求体超过 ${BODY_LIMIT} 字节`)
    }
    chunks.push(buffer)
  }
  if (size === 0) throw new HttpError(400, 'bad-json', '请求体为空')
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'bad-json', '请求体不是合法 JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'bad-request', '请求体必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

function query(req: IncomingMessage): URLSearchParams {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  return url.searchParams
}

function requireSessionId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'bad-request', 'sessionId 必须是非空字符串')
  }
  return value
}

function categoryLabel(catalog: MethodologyCatalog, categoryId: string): string {
  const found = catalog.categories.find((category) => category.id === categoryId)
  return found?.zh ?? categoryId
}

function methodCards(catalog: MethodologyCatalog): Record<string, unknown>[] {
  return catalog.methods.map((method) => {
    const rendered = catalog.render(method.id)
    const label = categoryLabel(catalog, method.category)
    return {
      id: method.id,
      name: method.zh,
      tagline: method.oneliner,
      badge: label,
      tags: [label, ...method.aliases.slice(0, 3)],
      contract: rendered?.text ?? '',
      // Additive fields (client may ignore them).
      en: method.en,
      category: method.category,
      categoryLabel: label,
      tokens: rendered?.tokens ?? 0,
      bodyTokens: rendered?.bodyTokens ?? 0,
      contractHash: rendered?.hash ?? '',
      display: method.display,
      conflicts: method.conflicts ?? [],
    }
  })
}

function aimOf(catalog: MethodologyCatalog, entry: ArmedEntry): Record<string, unknown> {
  const method = catalog.get(entry.methodId)
  return {
    methodId: entry.methodId,
    name: method?.zh ?? entry.methodId,
    assists: [...entry.assists],
    sinceTurn: entry.armedForTurn,
    mode: entry.mode,
  }
}

function recentOf(catalog: MethodologyCatalog, store: MethodologyStore, sessionId: string): Record<string, unknown>[] {
  // One row per turn. A stacked turn writes one trace per method in bundle order, so the
  // earliest timestamp of that turn is the primary arm — that is what the badge shows.
  const seen = new Map<number, TraceEntry>()
  const history = store.historyFor(sessionId, 24).slice().reverse()
  for (const entry of history) if (!seen.has(entry.turn)) seen.set(entry.turn, entry)
  return [...seen.values()]
    .sort((a, b) => b.turn - a.turn)
    .slice(0, 5)
    .map((entry) => ({
      turn: entry.turn,
      methodId: entry.methodId,
      name: catalog.get(entry.methodId)?.zh ?? entry.methodId,
      contractHash: entry.contractHash,
      ts: Date.parse(entry.ts) || 0,
    }))
}

function channelOf(session: SessionState | undefined): Record<string, unknown> {
  if (session === undefined) return { verified: false, degraded: false, pendingTurn: null }
  return { ...session.channel }
}

/**
 * The one snapshot every mutating and reading route returns.
 * A session the Host has never seen is not an error: the client asks for state the
 * moment the input box mounts, long before anything is armed.
 */
export function snapshot(runtime: HttpRuntime, sessionId: string): Record<string, unknown> {
  const catalog = runtime.catalog()
  if (catalog === undefined) {
    throw new HttpError(503, 'catalog-unavailable', runtime.catalogFailure() ?? '方法论目录不可用')
  }
  const store = runtime.store
  const session = store.peek(sessionId)
  const entries = session?.entries ?? []
  const primary = entries.find((entry) => entry.mode === 'turn' || entry.mode === 'pinned')
  const stacks = entries.filter((entry) => entry.mode === 'stack')
  const anchor = primary ?? stacks[0]
  const turn = session === undefined ? 0 : currentTurn(session)
  return {
    sessionId,
    armed: anchor === undefined ? null : aimOf(catalog, anchor),
    recent: recentOf(catalog, store, sessionId),
    catalog: { methods: methodCards(catalog), assists: assistCards() },
    // Additive fields.
    stack: stacks.map((entry) => aimOf(catalog, entry)),
    activeNow:
      session === undefined ? [] : activeEntries(session, turn).map((entry) => aimOf(catalog, entry)),
    channel: channelOf(session),
    lastInjection: session?.lastInjection ?? null,
    turn,
    budget: catalog.budget,
    maxAssists: MAX_ASSISTS,
  }
}

function parseMode(value: unknown): InjectionMode {
  if (value === undefined || value === null) return 'turn'
  if (value === 'turn' || value === 'pinned' || value === 'stack') return value
  throw new HttpError(400, 'bad-request', `mode 必须是 turn / pinned / stack，收到 ${String(value)}`)
}

function parseAssists(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new HttpError(400, 'bad-request', 'assists 必须是字符串数组')
  const ids: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') throw new HttpError(400, 'bad-request', 'assists 必须是字符串数组')
    if (!ids.includes(item)) ids.push(item)
  }
  if (ids.length > MAX_ASSISTS) {
    throw new HttpError(400, 'bad-request', `一次最多选择 ${MAX_ASSISTS} 个辅助项`)
  }
  if (resolveAssists(ids) === undefined) {
    throw new HttpError(400, 'bad-request', `未知辅助项：${ids.join(', ')}`)
  }
  return ids
}

function handleArm(runtime: HttpRuntime, body: Record<string, unknown>): Record<string, unknown> {
  const catalog = runtime.catalog()
  if (catalog === undefined) {
    throw new HttpError(503, 'catalog-unavailable', runtime.catalogFailure() ?? '方法论目录不可用')
  }
  const sessionId = requireSessionId(body.sessionId)
  if (typeof body.methodId !== 'string' || body.methodId.trim() === '') {
    throw new HttpError(400, 'bad-request', 'methodId 必须是非空字符串')
  }
  const mode = parseMode(body.mode)
  const assists = parseAssists(body.assists)
  const method = catalog.resolve(body.methodId)
  if (method === undefined) {
    throw new HttpError(404, 'unknown-method', `未知方法论：${body.methodId}`)
  }
  const contract = catalog.render(method.id)
  if (contract === undefined) {
    throw new HttpError(404, 'unknown-method', `无法渲染方法论：${method.id}`)
  }
  const budget = catalog.budget
  if (contract.overBudget) {
    throw new HttpError(
      400,
      'budget-exceeded',
      `${method.id} 注入层约 ${contract.tokens} token，超过上限 ${budget}；不做截断，请改目录内容`,
    )
  }
  const store = runtime.store
  const result = store.arm(
    {
      sessionId,
      methodId: method.id,
      mode,
      assists,
      tokens: contract.tokens,
      contractHash: contract.hash,
      budget,
    },
    catalog,
  )
  if (!result.ok) {
    if (result.code === 'unknown-method') throw new HttpError(404, 'unknown-method', result.message)
    if (result.code === 'budget-exceeded') throw new HttpError(400, 'budget-exceeded', result.message)
    if (result.code === 'bad-mode') throw new HttpError(400, 'bad-request', result.message)
    const detail = (result.conflicts ?? []).map((item) => `${item.withMethodId}: ${item.rule}`).join('；')
    throw new HttpError(409, 'conflict', `${result.message}${detail === '' ? '' : `（${detail}）`}`)
  }
  return snapshot(runtime, sessionId)
}

function handleRelease(runtime: HttpRuntime, body: Record<string, unknown>): Record<string, unknown> {
  const sessionId = requireSessionId(body.sessionId)
  let methodId: string | undefined
  if (body.methodId !== undefined && body.methodId !== null) {
    if (typeof body.methodId !== 'string') throw new HttpError(400, 'bad-request', 'methodId 必须是字符串')
    methodId = body.methodId
  }
  runtime.store.release(sessionId, methodId)
  return snapshot(runtime, sessionId)
}

function handleTrace(runtime: HttpRuntime, sessionId: string, turn: number): Record<string, unknown> {
  const catalog = runtime.catalog()
  if (catalog === undefined) {
    throw new HttpError(503, 'catalog-unavailable', runtime.catalogFailure() ?? '方法论目录不可用')
  }
  const store = runtime.store
  const entry = store.traceForTurn(sessionId, turn)
  if (entry === undefined) {
    throw new HttpError(404, 'trace-not-found', `第 ${turn} 轮没有方法论留痕`)
  }
  const session = store.peek(sessionId)
  const armed = session?.entries.find((item) => item.methodId === entry.methodId)
  const rendered = catalog.render(entry.methodId)
  return {
    turn: entry.turn,
    methodId: entry.methodId,
    name: catalog.get(entry.methodId)?.zh ?? entry.methodId,
    contract: rendered?.text ?? '',
    contractHash: entry.contractHash,
    assists: armed === undefined ? [] : [...armed.assists],
    ts: Date.parse(entry.ts) || 0,
  }
}

function handleDiagnostics(runtime: HttpRuntime): Record<string, unknown> {
  const store = runtime.store
  const catalog = runtime.catalog()
  const catalogFailure = runtime.catalogFailure()
  const sessions = store
    .sessionsList()
    .map((session) => ({
      sessionId: session.sessionId,
      turn: session.lastTurn,
      armed: session.entries.map((entry) => `${entry.methodId}:${entry.mode}`),
      activeNow: activeEntries(session, session.lastTurn).map((entry) => entry.methodId),
      channel: session.channel,
      lastInjection: session.lastInjection ?? null,
    }))
    .sort((a, b) => (a.lastInjection?.ts ?? '') < (b.lastInjection?.ts ?? '') ? 1 : -1)
    .slice(0, 20)
  const last = store.last()
  const ok = catalog !== undefined && catalogFailure === undefined && (last?.stage !== 'error')
  return {
    // Frozen client contract.
    ok,
    armedSessions: store.armedSessionCount(),
    catalogSize: catalog?.methods.length ?? 0,
    ...(catalogFailure === undefined && last?.note === undefined ? {} : {
      lastError: catalogFailure ?? (last?.stage === 'landed' || last?.stage === 'armed' || last?.stage === 'assembled'
        ? undefined
        : `${last?.stage ?? 'unknown'}: ${last?.note ?? ''}`.trim()),
    }),
    version: runtime.version,
    // Additive diagnostics: the truth of the most recent injection attempt.
    contractRegistered: true,
    contextOrder: runtime.contextOrder,
    catalogPath: runtime.catalogLocation(),
    statePath: store.path(),
    stateBytes: store.fileSize(),
    historySize: store.allHistory().length,
    lastInjection: last,
    sessions,
  }
}

/** Build the exact routes registered with `webServer`. */
export function buildRoutes(runtime: HttpRuntime): Route[] {
  return [
    {
      path: '/api/methodology.state',
      methods: ['GET'],
      handler: (req, res) => {
        try {
          sendJson(res, 200, snapshot(runtime, requireSessionId(query(req).get('sessionId'))))
        } catch (error) {
          sendError(res, error)
        }
      },
    },
    {
      path: '/api/methodology.arm',
      methods: ['POST'],
      handler: async (req, res) => {
        try {
          sendJson(res, 200, handleArm(runtime, await readJsonBody(req)))
        } catch (error) {
          sendError(res, error)
        }
      },
    },
    {
      path: '/api/methodology.release',
      methods: ['POST'],
      handler: async (req, res) => {
        try {
          sendJson(res, 200, handleRelease(runtime, await readJsonBody(req)))
        } catch (error) {
          sendError(res, error)
        }
      },
    },
    {
      path: '/api/methodology.trace',
      methods: ['GET'],
      handler: (req, res) => {
        try {
          const params = query(req)
          const sessionId = requireSessionId(params.get('sessionId'))
          const turn = Number(params.get('turn'))
          if (!Number.isInteger(turn) || turn < 0) {
            throw new HttpError(400, 'bad-request', 'turn 必须是非负整数')
          }
          sendJson(res, 200, handleTrace(runtime, sessionId, turn))
        } catch (error) {
          sendError(res, error)
        }
      },
    },
    {
      path: '/api/methodology.diagnostics',
      methods: ['GET'],
      handler: (_req, res) => {
        try {
          sendJson(res, 200, handleDiagnostics(runtime))
        } catch (error) {
          sendError(res, error)
        }
      },
    },
  ]
}

/** Method-not-allowed guard shared by all routes. */
export function methodAllowed(route: Route, req: IncomingMessage): boolean {
  return route.methods.includes(req.method ?? 'GET')
}
