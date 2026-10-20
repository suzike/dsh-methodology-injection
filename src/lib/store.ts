/**
 * Session state machine + durable, content-free trace.
 *
 * Invariants:
 * - State is keyed by SessionId, which is exactly `agent.id` (PROBE §1.1).
 * - An arm becomes active on `lastTurn + 1`: arming before sending applies to the
 *   very next turn, arming mid-turn applies to the following one.
 * - `turn` arms are consumed at `turn/end`; `pinned` and `stack` stay until released.
 * - Nothing user-authored is ever stored: history keeps only methodId, contract hash,
 *   sessionId, turn and timestamp.
 */

import { existsSync, renameSync, statSync } from 'node:fs'
import { asRecord, asString, ensureDirectory, readJsonFile, stateFilePath, writeJsonAtomic } from './util.js'
import type {
  ArmedEntry,
  CatalogView,
  InjectionMode,
  InjectionStage,
  LastInjection,
  PersistedState,
  SessionState,
  TraceEntry,
} from './types.js'

const STATE_VERSION = 1
/** Validate one trace row came back from disk; drop anything malformed. */
function normaliseTrace(value: unknown): TraceEntry | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const methodId = asString(record.methodId)
  const sessionId = asString(record.sessionId)
  if (methodId === undefined || sessionId === undefined) return undefined
  return {
    methodId,
    contractHash: asString(record.contractHash) ?? '',
    sessionId,
    turn: Number(record.turn) || 0,
    ts: asString(record.ts) ?? new Date(0).toISOString(),
  }
}

const DEFAULT_HISTORY_LIMIT = 300
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface ArmRequest {
  sessionId: string
  methodId: string
  mode: InjectionMode
  assists: readonly string[]
  /** Contract rendered by the caller, used for budget validation and diagnostics. */
  tokens: number
  contractHash: string
  budget: number
}

export type ArmFailure =
  | 'unknown-method'
  | 'conflict'
  | 'budget-exceeded'
  | 'bad-mode'

export interface ArmConflict {
  withMethodId: string
  rule: string
  preferred: string | null
  preferWhen: string | null
}

export type ArmResult =
  | { ok: true; state: SessionState; replaced: string | null; unchanged: boolean }
  | { ok: false; code: ArmFailure; message: string; conflicts?: ArmConflict[] }

export interface StoreOptions {
  file?: string
  historyLimit?: number
  now?: () => Date
}

function isMode(value: unknown): value is InjectionMode {
  return value === 'turn' || value === 'pinned' || value === 'stack'
}

function isPrimaryMode(mode: InjectionMode): boolean {
  return mode === 'turn' || mode === 'pinned'
}

function emptyChannel(): SessionState['channel'] {
  return { verified: false, degraded: false, pendingTurn: null }
}

function emptySession(sessionId: string, now: string): SessionState {
  return {
    sessionId,
    lastTurn: 0,
    turnOpen: false,
    lastSeen: now,
    entries: [],
    channel: emptyChannel(),
  }
}

/**
 * The turn a contract may be injected for.
 *
 * During a turn the loop has already appended `turn/start`, so `lastTurn` is current.
 * Between turns (title generation, a client polling for the next turn) the next turn is
 * the one an arm would land in — mirrors `armedForTurn = lastTurn + 1` at arm time.
 */
export function currentTurn(state: SessionState): number {
  return state.turnOpen ? state.lastTurn : state.lastTurn + 1
}

/**
 * One turn's worth of active entries.
 *
 * Turn-scoped arms use `<=`, not `===`: the turn recorded at arm time is only a guess
 * (`lastTurn + 1`), and a session the store has never seen a turn for — plugin enabled
 * mid-session, arm made from a restored client, state file written by an older build —
 * guesses too low. With `===` such an arm silently never fires; with `<=` it fires on the
 * next turn to arrive and `turnEnd` still consumes it after that one turn.
 */
export function activeEntries(state: SessionState, turn: number): ArmedEntry[] {
  return state.entries.filter((entry) => entry.armedForTurn <= turn)
}

export class MethodologyStore {
  private readonly file: string
  private readonly historyLimit: number
  private readonly now: () => Date
  private readonly sessions = new Map<string, SessionState>()
  private history: TraceEntry[] = []
  private lastInjection: LastInjection | null = null
  private dirty = false

  constructor(options: StoreOptions = {}) {
    this.file = options.file ?? stateFilePath()
    this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT
    this.now = options.now ?? (() => new Date())
    this.load()
  }

  // ---------------------------------------------------------------- persistence

  private load(): void {
    if (!existsSync(this.file)) return
    let parsed: unknown
    try {
      parsed = readJsonFile(this.file)
    } catch {
      // A corrupt state file must never break the host: quarantine and start clean.
      try {
        renameSync(this.file, `${this.file}.corrupt-${this.now().getTime()}`)
      } catch {
        // ignore: we simply start from an empty state
      }
      return
    }
    const record = asRecord(parsed)
    if (!record || record.version !== STATE_VERSION) return
    const sessions = asRecord(record.sessions)
    if (sessions) {
      for (const [sessionId, value] of Object.entries(sessions)) {
        const normalised = this.normaliseSession(sessionId, value)
        if (normalised !== undefined) this.sessions.set(sessionId, normalised)
      }
    }
    if (Array.isArray(record.history)) {
      this.history = record.history
        .map(normaliseTrace)
        .filter((entry): entry is TraceEntry => entry !== undefined)
        .slice(-this.historyLimit)
    }
    this.prune()
  }

  private normaliseSession(sessionId: string, value: unknown): SessionState | undefined {
    const record = asRecord(value)
    if (!record) return undefined
    const entries: ArmedEntry[] = []
    if (Array.isArray(record.entries)) {
      for (const item of record.entries) {
        const entry = asRecord(item)
        const methodId = asString(entry?.methodId)
        const mode = entry?.mode
        if (!entry || methodId === undefined || !isMode(mode)) continue
        const armedForTurn = Number(entry.armedForTurn)
        entries.push({
          methodId,
          mode,
          assists: Array.isArray(entry.assists)
            ? entry.assists.filter((id): id is string => typeof id === 'string')
            : [],
          armedAt: asString(entry.armedAt) ?? this.now().toISOString(),
          armedForTurn: Number.isFinite(armedForTurn) ? armedForTurn : 0,
          appliedTurns: Array.isArray(entry.appliedTurns)
            ? entry.appliedTurns.filter((turn): turn is number => typeof turn === 'number')
            : [],
        })
      }
    }
    const channelRecord = asRecord(record.channel)
    const verifiedAt = asString(channelRecord?.verifiedAt)
    const base = emptySession(sessionId, asString(record.lastSeen) ?? this.now().toISOString())
    const session: SessionState = {
      ...base,
      lastTurn: Number.isFinite(Number(record.lastTurn)) ? Number(record.lastTurn) : 0,
      turnOpen: record.turnOpen === true,
      entries,
      channel: {
        verified: channelRecord?.verified === true,
        degraded: channelRecord?.degraded === true,
        pendingTurn: channelRecord?.pendingTurn === null || channelRecord?.pendingTurn === undefined
          ? null
          : Number(channelRecord.pendingTurn),
        ...(verifiedAt === undefined ? {} : { verifiedAt }),
      },
    }
    const lastInjection = asRecord(record.lastInjection)
    if (lastInjection) {
      const stage = asString(lastInjection.stage)
      const note = asString(lastInjection.note)
      session.lastInjection = {
        sessionId,
        turn: Number(lastInjection.turn) || 0,
        step: Number(lastInjection.step) || 0,
        ts: asString(lastInjection.ts) ?? this.now().toISOString(),
        methodIds: Array.isArray(lastInjection.methodIds)
          ? lastInjection.methodIds.filter((id): id is string => typeof id === 'string')
          : [],
        channel: lastInjection.channel === 'context' || lastInjection.channel === 'pre-step'
          ? lastInjection.channel
          : 'none',
        landed: lastInjection.landed === true,
        tokenEstimate: Number(lastInjection.tokenEstimate) || 0,
        contractHash: asString(lastInjection.contractHash) ?? '',
        stage: (stage as InjectionStage | undefined) ?? 'error',
        ...(note === undefined ? {} : { note }),
      }
      if (this.lastInjection === null && session.lastInjection !== undefined) {
        this.lastInjection = session.lastInjection
      }
    }
    return session
  }

  private prune(): void {
    const cutoff = this.now().getTime() - SESSION_TTL_MS
    for (const [sessionId, session] of this.sessions) {
      const seen = Date.parse(session.lastSeen)
      const stale = Number.isFinite(seen) && seen < cutoff
      if (stale && session.entries.length === 0) this.sessions.delete(sessionId)
    }
  }

  /** Persist now. Cheap enough to run on turn boundaries and mutations. */
  flush(): void {
    if (!this.dirty) return
    const payload: PersistedState = {
      version: STATE_VERSION,
      updatedAt: this.now().toISOString(),
      sessions: Object.fromEntries(this.sessions),
      history: this.history.slice(-this.historyLimit),
    }
    try {
      ensureDirectory(this.file.replace(/[\\/][^\\/]+$/u, ''))
      writeJsonAtomic(this.file, payload)
      this.dirty = false
    } catch {
      // Never let a disk problem break a turn; diagnostics will show stale data.
    }
  }

  // -------------------------------------------------------------------- sessions

  peek(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId)
  }

  ensure(sessionId: string): SessionState {
    let session = this.sessions.get(sessionId)
    if (session === undefined) {
      session = emptySession(sessionId, this.now().toISOString())
      this.sessions.set(sessionId, session)
    }
    session.lastSeen = this.now().toISOString()
    return session
  }

  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session !== undefined) session.lastSeen = this.now().toISOString()
  }

  /** Drop an armed session once its agent is gone; history stays. */
  dispose(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    if (session.entries.length === 0) this.sessions.delete(sessionId)
    else {
      session.turnOpen = false
      this.dirty = true
    }
  }

  // ------------------------------------------------------------------------ arm

  arm(request: ArmRequest, catalog: CatalogView): ArmResult {
    if (!isMode(request.mode)) {
      return { ok: false, code: 'bad-mode', message: `未知的注入模式：${String(request.mode)}` }
    }
    if (!catalog.has(request.methodId)) {
      return { ok: false, code: 'unknown-method', message: `目录中没有方法：${request.methodId}` }
    }
    if (request.tokens > request.budget) {
      return {
        ok: false,
        code: 'budget-exceeded',
        message: `契约估算 ${request.tokens} token，超过硬上限 ${request.budget}；请减少辅助条款或改用更长的方法。`,
      }
    }

    const session = this.ensure(request.sessionId)
    const conflicts: ArmConflict[] = []
    for (const entry of session.entries) {
      if (entry.methodId === request.methodId) continue
      if (entry.mode === request.mode && isPrimaryMode(request.mode)) continue
      const rule = catalog.conflict(request.methodId, entry.methodId)
      if (rule !== undefined) {
        conflicts.push({
          withMethodId: entry.methodId,
          rule: rule.rule,
          preferred: rule.preferred,
          preferWhen: rule.preferWhen,
        })
      }
    }
    if (conflicts.length > 0) {
      return {
        ok: false,
        code: 'conflict',
        message: `与已启用的「${conflicts.map((item) => item.withMethodId).join('、')}」互斥。`,
        conflicts,
      }
    }

    const duplicate = session.entries.find(
      (entry) => entry.methodId === request.methodId && entry.mode === request.mode,
    )
    if (duplicate !== undefined) {
      const sameAssists =
        duplicate.assists.length === request.assists.length &&
        duplicate.assists.every((id, index) => id === request.assists[index])
      if (sameAssists) {
        this.touch(request.sessionId)
        return { ok: true, state: session, replaced: null, unchanged: true }
      }
    }

    const armedForTurn = session.lastTurn + 1
    const entry: ArmedEntry = {
      methodId: request.methodId,
      mode: request.mode,
      assists: [...request.assists],
      armedAt: this.now().toISOString(),
      armedForTurn,
      appliedTurns: [],
    }

    let replaced: string | null = null
    if (isPrimaryMode(request.mode)) {
      const previous = session.entries.find((item) => isPrimaryMode(item.mode))
      replaced = previous?.methodId ?? null
      session.entries = session.entries.filter((item) => !isPrimaryMode(item.mode))
    } else {
      session.entries = session.entries.filter(
        (item) => !(item.methodId === request.methodId && item.mode === 'stack'),
      )
    }
    session.entries.push(entry)
    session.lastInjection = {
      sessionId: request.sessionId,
      turn: armedForTurn,
      step: 0,
      ts: this.now().toISOString(),
      methodIds: [request.methodId],
      channel: 'none',
      landed: false,
      tokenEstimate: request.tokens,
      contractHash: request.contractHash,
      stage: 'armed',
      note: `mode=${request.mode}`,
    }
    this.lastInjection = session.lastInjection
    this.dirty = true
    this.flush()
    return { ok: true, state: session, replaced, unchanged: false }
  }

  /** Release one method, or every arm when `methodId` is omitted. */
  release(sessionId: string, methodId?: string): { removed: string[]; state: SessionState } {
    const session = this.ensure(sessionId)
    const removed: string[] = []
    session.entries = session.entries.filter((entry) => {
      if (methodId !== undefined && entry.methodId !== methodId) return true
      removed.push(entry.methodId)
      return false
    })
    if (removed.length > 0) {
      session.lastInjection = {
        sessionId,
        turn: session.lastTurn,
        step: 0,
        ts: this.now().toISOString(),
        methodIds: removed,
        channel: 'none',
        landed: false,
        tokenEstimate: 0,
        contractHash: '',
        stage: 'armed',
        note: 'released',
      }
      this.lastInjection = session.lastInjection
      this.dirty = true
      this.flush()
    }
    return { removed, state: session }
  }

  // ----------------------------------------------------------------------- turns

  turnStart(sessionId: string, turn: number): void {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    session.lastTurn = Math.max(session.lastTurn, turn)
    session.turnOpen = true
    session.lastSeen = this.now().toISOString()
    // No pruning here on purpose. A turn-scoped arm recorded with an underestimated turn
    // (see `activeEntries`) must survive until it actually gets its turn; `turnEnd` is the
    // single consumer that retires it, so an arm can never leak into a second turn.
    this.dirty = true
  }

  turnEnd(sessionId: string, turn: number): void {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    session.lastTurn = Math.max(session.lastTurn, turn)
    session.turnOpen = false
    const before = session.entries.length
    session.entries = session.entries.filter(
      (entry) => !(entry.mode === 'turn' && entry.armedForTurn <= turn),
    )
    if (session.entries.length !== before) this.dirty = true
    this.flush()
  }

  /** Entries active for the given turn; empty before the first turn. */
  activeAt(sessionId: string, turn: number): ArmedEntry[] {
    const session = this.sessions.get(sessionId)
    if (session === undefined || turn <= 0) return []
    return activeEntries(session, turn)
  }

  markApplied(sessionId: string, turn: number, methodIds: readonly string[]): void {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    for (const entry of session.entries) {
      if (!methodIds.includes(entry.methodId)) continue
      if (!entry.appliedTurns.includes(turn)) entry.appliedTurns.push(turn)
    }
    this.dirty = true
  }

  // ------------------------------------------------------------------ injection

  /** The runtime-context assembly produced non-empty text for this turn. */
  noteAssembled(
    sessionId: string,
    detail: { turn: number; step: number; methodIds: string[]; tokens: number; hash: string },
  ): void {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    session.channel.pendingTurn = detail.turn
    session.lastInjection = {
      sessionId,
      turn: detail.turn,
      step: detail.step,
      ts: this.now().toISOString(),
      methodIds: detail.methodIds,
      channel: 'context',
      landed: false,
      tokenEstimate: detail.tokens,
      contractHash: detail.hash,
      stage: 'assembled',
    }
    this.lastInjection = session.lastInjection
  }

  /** The contract was observed in the step messages: the context channel works. */
  noteLanded(
    sessionId: string,
    detail: {
      turn: number
      step: number
      methodIds: string[]
      tokens: number
      hash: string
      channel: 'context' | 'pre-step'
      stage?: InjectionStage
      note?: string
    },
  ): void {
    const session = this.ensure(sessionId)
    session.channel.pendingTurn = null
    if (detail.channel === 'context') {
      session.channel.verified = true
      session.channel.verifiedAt = this.now().toISOString()
    } else {
      session.channel.degraded = true
    }
    session.lastInjection = {
      sessionId,
      turn: detail.turn,
      step: detail.step,
      ts: this.now().toISOString(),
      methodIds: detail.methodIds,
      channel: detail.channel,
      landed: true,
      tokenEstimate: detail.tokens,
      contractHash: detail.hash,
      stage: detail.stage ?? 'landed',
      ...(detail.note === undefined ? {} : { note: detail.note }),
    }
    this.lastInjection = session.lastInjection
    this.dirty = true
    this.flush()
  }

  /** Record a failure stage so /diagnostics can point at the broken step. */
  noteFailure(sessionId: string, detail: { turn: number; step: number; stage: InjectionStage; note?: string }): void {
    const session = this.ensure(sessionId)
    const previous = session.lastInjection
    session.lastInjection = {
      sessionId,
      turn: detail.turn,
      step: detail.step,
      ts: this.now().toISOString(),
      methodIds: previous?.methodIds ?? [],
      channel: 'none',
      landed: false,
      tokenEstimate: previous?.tokenEstimate ?? 0,
      contractHash: previous?.contractHash ?? '',
      stage: detail.stage,
      ...(detail.note === undefined ? {} : { note: detail.note }),
    }
    this.lastInjection = session.lastInjection
    this.dirty = true
  }

  // ---------------------------------------------------------------------- trace

  /** Append one content-free trace row (deduplicated per session/turn/method/hash). */
  recordTrace(entry: TraceEntry): boolean {
    const exists = this.history.some(
      (item) =>
        item.sessionId === entry.sessionId &&
        item.turn === entry.turn &&
        item.methodId === entry.methodId &&
        item.contractHash === entry.contractHash,
    )
    if (exists) return false
    this.history.push(entry)
    if (this.history.length > this.historyLimit) {
      this.history = this.history.slice(-this.historyLimit)
    }
    this.dirty = true
    this.flush()
    return true
  }

  historyFor(sessionId: string, limit = 5): TraceEntry[] {
    return this.history
      .filter((entry) => entry.sessionId === sessionId)
      .slice()
      .sort((a, b) => b.turn - a.turn || Date.parse(b.ts) - Date.parse(a.ts))
      .slice(0, limit)
  }

  traceForTurn(sessionId: string, turn: number): TraceEntry | undefined {
    return this.history.find((entry) => entry.sessionId === sessionId && entry.turn === turn)
  }

  allHistory(): readonly TraceEntry[] {
    return this.history
  }

  // ---------------------------------------------------------------- diagnostics

  sessionsList(): SessionState[] {
    return [...this.sessions.values()].sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen))
  }

  last(): LastInjection | null {
    return this.lastInjection
  }

  armedSessionCount(): number {
    return [...this.sessions.values()].filter((session) => session.entries.length > 0).length
  }

  /** Size of the on-disk state file, for diagnostics. */
  fileSize(): number {
    try {
      return statSync(this.file).size
    } catch {
      return 0
    }
  }

  path(): string {
    return this.file
  }
}
