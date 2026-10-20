/**
 * Client state for one methodology session.
 *
 * Why a hand-rolled store instead of React context: three separate slots
 * (composer chip, composer overlay panel, chat turn-tail badge) and the global
 * shortcut layer must observe the same state, and they mount at different
 * times and in different subtrees. A module singleton keyed by session id gives
 * every one of them the same snapshot through `useSyncExternalStore`, with no
 * provider ordering to get wrong.
 *
 * Invariants:
 *  - snapshots are immutable; every mutation replaces the object, so identity
 *    comparison in `useSyncExternalStore` stays correct;
 *  - only one request per session is in flight (`busy`), and a late answer is
 *    dropped when a newer request superseded it;
 *  - nothing here throws into React: Host failures land in `error`/`flash`.
 *
 * @module dsh-methodology-injection/client/store
 */

import {
  ApiError,
  armMethod,
  fetchState,
  fetchTrace,
  releaseMethod,
  type Catalog,
  type SessionSnapshot,
  type TurnContract,
} from './api'

/** Terminal state of one lazily fetched Turn contract. */
export type TraceEntry =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: TurnContract | null }
  | { readonly status: 'error'; readonly message: string }

/** Everything the three slots paint for one session. */
export interface ViewState {
  readonly sessionId: string
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly snapshot: SessionSnapshot | null
  readonly error: string | null
  /** Transient one-line status ("已应用：第一性原理", budget refusals, …). */
  readonly flash: string | null
  readonly busy: boolean
  readonly panel: boolean
  readonly expanded: boolean
  readonly query: string
  readonly active: number | null
  /** Method the assist selection currently belongs to. */
  readonly assistFor: string | null
  readonly assistIds: readonly string[]
  /** Increments on every successful arm; the chip animates on a change. */
  readonly pulse: number
  readonly badgeTurn: number | null
  readonly traces: { readonly [turn: number]: TraceEntry }
  readonly recallDismissed: boolean
  readonly kbd: 'meta+k' | 'meta+shift+m'
  readonly kbdNotice: string | null
  /** Method to reveal once the panel paints (used by the badge's 换一个). */
  readonly pendingActiveId: string | null
}

/** Assist cap the Host enforces on the token budget; mirrored for instant feedback. */
export const MAX_ASSISTS = 2

const EMPTY_CATALOG: Catalog = { methods: [], assists: [] }

const views = new Map<string, ViewState>()
const listeners = new Map<string, Set<() => void>>()
const inflight = new Map<string, AbortController>()

/** Session the shortcut layer should act on (the most recently mounted chip). */
let focusedSession: string | null = null
/** Timestamp of the last panel close, so a closing click cannot reopen it. */
let closedAt = 0

const KBD_KEY = 'dsh.methodology.kbd'
const RECALL_KEY = 'dsh.methodology.recall'

/** Read one storage key without letting a hostile/absent store break the UI. */
function readStore(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

/** Write one storage key, best effort. */
function writeStore(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    /* A locked-down browser simply forgets the preference. */
  }
}

/** Read the shortcut the last run settled on. */
function storedKbd(): ViewState['kbd'] {
  return readStore(KBD_KEY) === 'meta+shift+m' ? 'meta+shift+m' : 'meta+k'
}

/** Dismissed-recall set for one session. */
function recallDismissedFor(sessionId: string): boolean {
  const raw = readStore(RECALL_KEY)
  if (raw === null) return false
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.includes(sessionId)
  } catch {
    return false
  }
}

/** Persist the dismissed-recall set for one session. */
function dismissRecallFor(sessionId: string): void {
  const raw = readStore(RECALL_KEY)
  let list: string[] = []
  try {
    const parsed: unknown = raw === null ? [] : JSON.parse(raw)
    if (Array.isArray(parsed)) list = parsed.filter((entry): entry is string => typeof entry === 'string')
  } catch {
    list = []
  }
  if (!list.includes(sessionId)) list.push(sessionId)
  writeStore(RECALL_KEY, JSON.stringify(list.slice(-50)))
}

/** The initial snapshot for a session that has never been loaded. */
function initial(sessionId: string): ViewState {
  return {
    sessionId,
    status: 'idle',
    snapshot: null,
    error: null,
    flash: null,
    busy: false,
    panel: false,
    expanded: false,
    query: '',
    active: null,
    assistFor: null,
    assistIds: [],
    pulse: 0,
    badgeTurn: null,
    traces: {},
    recallDismissed: recallDismissedFor(sessionId),
    kbd: storedKbd(),
    kbdNotice: null,
    pendingActiveId: null,
  }
}

/** Current immutable view for one session (creating the empty one on demand). */
export function get(sessionId: string): ViewState {
  const existing = views.get(sessionId)
  if (existing !== undefined) return existing
  const created = initial(sessionId)
  views.set(sessionId, created)
  return created
}

/** Replace one session's view and wake its subscribers. */
function patch(sessionId: string, mutate: (state: ViewState) => ViewState): void {
  const next = mutate(get(sessionId))
  if (next === views.get(sessionId)) return
  views.set(sessionId, next)
  const set = listeners.get(sessionId)
  if (set === undefined) return
  for (const listener of [...set]) listener()
}

/** Subscribe to one session's view. */
export function subscribe(sessionId: string, listener: () => void): () => void {
  let set = listeners.get(sessionId)
  if (set === undefined) {
    set = new Set()
    listeners.set(sessionId, set)
  }
  set.add(listener)
  return () => {
    set?.delete(listener)
  }
}

/** Tell the shortcut layer which session the composer is showing. */
export function focus(sessionId: string): void {
  focusedSession = sessionId
}

/** Session the shortcut layer should act on. */
export function focused(): string | null {
  return focusedSession
}

/** Milliseconds since the panel was last closed. */
export function sinceClosed(): number {
  return Date.now() - closedAt
}

/** Catalogue of the loaded snapshot, or an empty one before the first answer. */
export function catalogOf(state: ViewState): Catalog {
  return state.snapshot?.catalog ?? EMPTY_CATALOG
}

/** Abort whatever was in flight for one session (a newer action wins). */
function abort(sessionId: string): void {
  inflight.get(sessionId)?.abort()
  inflight.delete(sessionId)
}

/** Run one state-mutating request with the shared abort + busy discipline. */
async function transact(
  sessionId: string,
  run: (signal: AbortSignal) => Promise<SessionSnapshot>,
): Promise<void> {
  abort(sessionId)
  const controller = new AbortController()
  inflight.set(sessionId, controller)
  patch(sessionId, (state) => ({ ...state, busy: true, error: null }))
  try {
    const snapshot = await run(controller.signal)
    if (controller.signal.aborted) return
    patch(sessionId, (state) => ({
      ...state,
      busy: false,
      snapshot,
      status: 'ready',
      error: null,
      pulse: state.pulse + 1,
    }))
  } catch (error) {
    if (controller.signal.aborted) return
    const message = error instanceof Error ? error.message : String(error)
    patch(sessionId, (state) => ({
      ...state,
      busy: false,
      error: message,
      flash: message,
      status: state.snapshot === null ? 'error' : 'ready',
    }))
  } finally {
    if (inflight.get(sessionId) === controller) inflight.delete(sessionId)
  }
}

/** Load the session state once; safe to call from every mount. */
export function ensureLoaded(sessionId: string): void {
  const state = get(sessionId)
  if (state.status === 'loading' || state.status === 'ready' || state.busy) return
  void reload(sessionId)
}

/** Force a re-read of the session state. */
export async function reload(sessionId: string): Promise<void> {
  abort(sessionId)
  const controller = new AbortController()
  inflight.set(sessionId, controller)
  patch(sessionId, (state) => ({ ...state, status: 'loading', error: null }))
  try {
    const snapshot = await fetchState(sessionId, controller.signal)
    if (controller.signal.aborted) return
    patch(sessionId, (state) => ({
      ...state,
      status: 'ready',
      snapshot,
      error: null,
      // A reload must not re-run the chip's arm animation.
    }))
  } catch (error) {
    if (controller.signal.aborted) return
    patch(sessionId, (state) => ({
      ...state,
      status: state.snapshot === null ? 'error' : 'ready',
      error: error instanceof Error ? error.message : String(error),
    }))
  } finally {
    if (inflight.get(sessionId) === controller) inflight.delete(sessionId)
  }
}

/** Open the picker, optionally seeded with a method to reveal. */
export function openPanel(sessionId: string, seed?: { query?: string; activeId?: string }): void {
  patch(sessionId, (state) => ({
    ...state,
    panel: true,
    expanded: false,
    query: seed?.query ?? '',
    active: null,
    pendingActiveId: seed?.activeId ?? null,
    flash: null,
    error: null,
  }))
  ensureLoaded(sessionId)
}

/** Close the picker and remember when, so the chip's own click cannot reopen it. */
export function closePanel(sessionId: string): void {
  closedAt = Date.now()
  patch(sessionId, (state) => (state.panel ? { ...state, panel: false, expanded: false, pendingActiveId: null } : state))
}

/** Toggle the picker from the chip. */
export function togglePanel(sessionId: string): void {
  if (get(sessionId).panel) closePanel(sessionId)
  else openPanel(sessionId)
}

/** Switch between the anchored card and the full-window reading surface. */
export function setExpanded(sessionId: string, expanded: boolean): void {
  patch(sessionId, (state) => ({ ...state, expanded }))
}

/** Update the query and drop any stale highlight. */
export function setQuery(sessionId: string, query: string): void {
  patch(sessionId, (state) => ({ ...state, query, active: null }))
}

/** Move the highlight, or clear it with `null`. */
export function setActive(sessionId: string, active: number | null): void {
  patch(sessionId, (state) => (state.active === active ? state : { ...state, active }))
}

/** Consume the one-shot "reveal this method" seed once the list is painted. */
export function clearPendingActive(sessionId: string): void {
  patch(sessionId, (state) => (state.pendingActiveId === null ? state : { ...state, pendingActiveId: null }))
}

/** Open the assist cascade for a method without closing the panel. */
export function beginAssist(sessionId: string, methodId: string): void {
  patch(sessionId, (state) => (state.assistFor === methodId
    ? state
    : { ...state, assistFor: methodId, assistIds: [], flash: null }))
}

/** Add or remove one assist clause for the given method, capped by the Host budget. */
export function toggleAssist(sessionId: string, methodId: string, assistId: string): void {
  patch(sessionId, (state) => {
    const same = state.assistFor === methodId
    const current = same ? state.assistIds : []
    if (current.includes(assistId)) {
      return { ...state, assistFor: methodId, assistIds: current.filter((id) => id !== assistId) }
    }
    if (current.length >= MAX_ASSISTS) {
      return { ...state, assistFor: methodId, flash: `最多同时选 ${String(MAX_ASSISTS)} 条辅助（受 150 token 预算限制）` }
    }
    return { ...state, assistFor: methodId, assistIds: [...current, assistId], flash: null }
  })
}

/** Drop the assist draft (switching method starts clean). */
export function clearAssists(sessionId: string): void {
  patch(sessionId, (state) => (state.assistIds.length === 0 ? state : { ...state, assistIds: [], assistFor: null }))
}

/** Arm a method with the currently drafted assists. */
export async function arm(sessionId: string, methodId: string, assists: readonly string[]): Promise<void> {
  const name = catalogOf(get(sessionId)).methods.find((method) => method.id === methodId)?.name ?? methodId
  await transact(sessionId, (signal) => armMethod(sessionId, methodId, assists, signal))
  patch(sessionId, (state) => (state.error === null ? { ...state, flash: `已应用：${name}` } : state))
  setTimeout(() => {
    patch(sessionId, (state) => (state.flash === `已应用：${name}` ? { ...state, flash: null } : state))
  }, 2400)
}

/** Drop the armed method. */
export async function release(sessionId: string): Promise<void> {
  await transact(sessionId, (signal) => releaseMethod(sessionId, signal))
  patch(sessionId, (state) => (state.error === null ? { ...state, flash: '已取消方法论' } : state))
  setTimeout(() => {
    patch(sessionId, (state) => (state.flash === '已取消方法论' ? { ...state, flash: null } : state))
  }, 2000)
}

/** Re-apply what the previous Turn used — one click, no picker. */
export async function reuse(sessionId: string, methodId: string, assists: readonly string[] = []): Promise<void> {
  await arm(sessionId, methodId, assists)
  closePanel(sessionId)
}

/** Expand or collapse the contract echo under one Turn. */
export function toggleBadge(sessionId: string, turn: number): void {
  patch(sessionId, (state) => ({ ...state, badgeTurn: state.badgeTurn === turn ? null : turn }))
}

/** Fetch one Turn's contract once; repeated calls are cheap. */
export function ensureTrace(sessionId: string, turn: number): void {
  const entry = get(sessionId).traces[turn]
  if (entry !== undefined && entry.status !== 'error') return
  patch(sessionId, (state) => ({ ...state, traces: { ...state.traces, [turn]: { status: 'loading' } } }))
  void fetchTrace(sessionId, turn)
    .then((value) => {
      patch(sessionId, (state) => ({ ...state, traces: { ...state.traces, [turn]: { status: 'ready', value } } }))
    })
    .catch((error: unknown) => {
      const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error)
      patch(sessionId, (state) => ({ ...state, traces: { ...state.traces, [turn]: { status: 'error', message } } }))
    })
}

/** Hide the recall hint for this session. */
export function dismissRecall(sessionId: string): void {
  dismissRecallFor(sessionId)
  patch(sessionId, (state) => ({ ...state, recallDismissed: true }))
}

/**
 * Record that DSH already owns ⌘K, so the picker must live on ⌘⇧M instead.
 * @param sessionId - session whose hint bar should explain the change.
 * @param notice - one line naming the shortcut actually in effect.
 */
export function noteKbdConflict(sessionId: string, notice: string): void {
  writeStore(KBD_KEY, 'meta+shift+m')
  patch(sessionId, (state) => ({ ...state, kbd: 'meta+shift+m', kbdNotice: notice }))
}

/** Acknowledge the "⌘K is taken, use ⌘⇧M" notice. */
export function dismissKbdNotice(sessionId: string): void {
  patch(sessionId, (state) => (state.kbdNotice === null ? state : { ...state, kbdNotice: null }))
}

/** Transient one-line status, auto-cleared. */
export function flash(sessionId: string, message: string | null): void {
  patch(sessionId, (state) => ({ ...state, flash: message }))
}

/** Human label of the shortcut currently in effect. */
export function kbdLabel(state: ViewState): string {
  return state.kbd === 'meta+k' ? '⌘K' : '⌘⇧M'
}
