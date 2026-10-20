/**
 * Injection channels.
 *
 * Primary channel: `systemPrompt.context` — the framework turns registered context
 * entries into a `runtime-context` user message and appends it to the step messages
 * (PROBE §1.3). This is the official, log-visible path, so the contract shows up in
 * the session JSONL and gets compacted/superseded like every other runtime snapshot.
 *
 * Fallback channel: `agent/pre-step` — only when the runtime-context channel is
 * provably dead for this session. It appends one *plugin* notice message carrying the
 * same contract. We never use `kind:'runtime-context'` there: that source is owned by
 * the framework's projection, and reusing it would fight the snapshot dedupe.
 */

import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { hasMarker, parseMarkers, renderContract } from './catalog.js'
import type { MethodologyCatalog } from './catalog.js'
import { activeEntries, currentTurn } from './store.js'
import type { MethodologyStore } from './store.js'
import { resolveAssists } from './assists.js'
import type { ArmedEntry, AssistClause, InjectionStage, RenderedContract } from './types.js'

/** Registered name of the runtime-context entry. */
export const CONTEXT_NAME = 'methodology-contract'

/** Contract order: after WEB_SURFACE (210), clear of third-party entries at 50/250. */
export const CONTEXT_ORDER = 230

/** The text block for one method plus the Entry that produced it. */
export interface ContractBundle {
  entry: ArmedEntry
  contract: RenderedContract
}

/** Rendered contract text for a set of entries, or `undefined` when nothing applies. */
export function buildBundle(
  catalog: MethodologyCatalog,
  entries: readonly ArmedEntry[],
): { text: string; tokens: number; hash: string; methodIds: string[]; bundles: ContractBundle[] } | undefined {
  if (entries.length === 0) return undefined
  const bundles: ContractBundle[] = []
  for (const entry of entries) {
    const contract = renderContract(catalog.get(entry.methodId) ?? missingMethod(entry.methodId), catalog.budget, assistsOf(entry))
    bundles.push({ entry, contract })
  }
  const text = bundles.map((item) => item.contract.text).join('\n\n')
  const hash = createHash('sha256')
    .update(bundles.map((item) => `${item.contract.methodId}:${item.contract.hash}`).join('|'), 'utf8')
    .digest('hex')
    .slice(0, 16)
  return {
    text,
    tokens: bundles.reduce((sum, item) => sum + item.contract.tokens, 0),
    hash,
    methodIds: bundles.map((item) => item.contract.methodId),
    bundles,
  }
}

function assistsOf(entry: ArmedEntry): AssistClause[] {
  const resolved = resolveAssists(entry.assists)
  return resolved ?? []
}

/**
 * Defensive shim: an armed method that vanished from a reloaded catalog still injects
 * its marker so the trace stays honest, with a minimal body instead of nothing.
 */
function missingMethod(methodId: string) {
  return {
    id: methodId,
    zh: methodId,
    en: methodId,
    category: 'unknown',
    aliases: [],
    oneliner: '',
    inject: {
      positioning: `按 ${methodId} 方法论作答。`,
      constraints: [],
      skeleton: '',
      lengthDiscipline: '',
    },
    display: { what: '', whenToUse: '', misuse: '', source: '' },
    conflicts: [],
  }
}

/** Mode-aware helper exposed for diagnostics/tests. */
export function entriesForTurn(store: MethodologyStore, sessionId: string, turn: number): ArmedEntry[] {
  const session = store.peek(sessionId)
  return session === undefined ? [] : activeEntries(session, turn)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Visible text of a message, tolerating string or content-part shapes. */
export function messageText(message: unknown): string {
  if (!isRecord(message)) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (!isRecord(part)) continue
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join('\n')
}

/**
 * Create the fallback message. Prefers the real `createUserMessage` factory so the
 * message is branded and frozen exactly like a native one; falls back to a structural
 * clone when the package cannot be resolved at runtime.
 */
let factory: { createUserMessage?: (input: unknown) => unknown } | undefined
let factoryAttempted = false

async function factoryFor(): Promise<((input: unknown) => unknown) | undefined> {
  if (!factoryAttempted) {
    factoryAttempted = true
    try {
      const specifier = '@deepseek-ai/dsh-llm'
      factory = (await import(specifier)) as { createUserMessage?: (input: unknown) => unknown }
    } catch {
      factory = undefined
    }
  }
  if (factory?.createUserMessage !== undefined) return factory.createUserMessage
  return (input: unknown) => {
    const record = isRecord(input) ? input : {}
    return Object.freeze({ ...structuredClone(record), id: randomUUID(), role: 'user' })
  }
}

export async function createPluginNoticeMessage(text: string): Promise<unknown> {
  const create = await factoryFor()
  if (create === undefined) return undefined
  return create({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: 'dsh-methodology-injection',
      form: 'notice',
      summary: '方法论契约（Host 兜底注入）',
    },
  })
}

/** Hash of one block inside a message, used when the catalog no longer knows a method. */
export function blockHash(text: string, methodId: string): string {
  const marker = `[[METHOD:${methodId}]]`
  const start = text.indexOf(marker)
  if (start < 0) return ''
  const next = text.indexOf('[[METHOD:', start + marker.length)
  const block = (next < 0 ? text.slice(start) : text.slice(start, next)).trim()
  return createHash('sha256').update(block, 'utf8').digest('hex').slice(0, 16)
}

/** Minimal structural type for the harness context we touch. */
/** Cordis disposers are opaque; combine whatever the host hands back. */
type Disposer = (() => void) | undefined

function combine(...disposers: unknown[]): () => void {
  return () => {
    for (const disposer of disposers) {
      if (typeof disposer === 'function') (disposer as Disposer)?.()
    }
  }
}

interface HostCtx {
  on(event: string, listener: (...args: unknown[]) => unknown): unknown
  systemPrompt: {
    context(entry: {
      name: string
      order: number
      interpolate?: boolean
      text: (assembly: unknown) => string
    }): unknown
  }
}

export interface InjectionRuntime {
  store: MethodologyStore
  /** Catalog accessor; `undefined` while the catalog failed to load. */
  catalog(): MethodologyCatalog | undefined
  /** Record a pipeline failure without throwing into the harness. */
  fail(sessionId: string, turn: number, step: number, stage: InjectionStage, note: string): void
}

/** Extract the agent id from an assembly / pre-step payload. */
function sessionIdOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const agent = value.agent
  if (isRecord(agent) && typeof agent.id === 'string' && agent.id !== '') return agent.id
  return undefined
}

/** Register the primary runtime-context channel. */
export function registerContext(ctx: HostCtx, runtime: InjectionRuntime): () => void {
  const entry = ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: CONTEXT_ORDER,
    interpolate: false,
    text: (assembly: unknown) => {
      const sessionId = sessionIdOf(assembly)
      if (sessionId === undefined) return ''
      const store = runtime.store
      const session = store.peek(sessionId)
      if (session === undefined || session.entries.length === 0) return ''
      const catalog = runtime.catalog()
      if (catalog === undefined) {
        runtime.fail(sessionId, session.lastTurn, 0, 'catalog-error', '目录不可用，未注入契约')
        return ''
      }
      const turn = currentTurn(session)
      const entries = activeEntries(session, turn)
      if (entries.length === 0) return ''
      const bundle = buildBundle(catalog, entries)
      if (bundle === undefined) return ''
      for (const item of bundle.bundles) {
        if (!item.contract.overBudget) continue
        runtime.fail(
          sessionId,
          turn,
          0,
          'budget-exceeded',
          `${item.contract.methodId} 估算 ${item.contract.tokens} token > ${catalog.budget}`,
        )
        // Hard cap: refuse to inject rather than silently truncate.
        return ''
      }
      store.noteAssembled(sessionId, {
        turn,
        step: 0,
        methodIds: bundle.methodIds,
        tokens: bundle.tokens,
        hash: primaryHash(bundle),
      })
      return bundle.text
    },
  })
  return combine(entry)
}

/**
 * Diagnostics must report the same fingerprint the badge and /trace use.
 * For the common single-method case that is exactly the contract text hash; a stacked
 * bundle falls back to the aggregate hash because there is no single contract.
 */
function primaryHash(bundle: { hash: string; bundles: readonly ContractBundle[] }): string {
  return bundle.bundles.length === 1 ? bundle.bundles[0]?.contract.hash ?? bundle.hash : bundle.hash
}

/** Register the safety-net channel plus the trace listener. */
export function registerPreStep(ctx: HostCtx, runtime: InjectionRuntime): () => void {
  const preStep = ctx.on('agent/pre-step', async (payload: unknown, next: unknown) => {
    const proceed = next as () => Promise<unknown>
    const decision = await proceed()
    try {
      if (!isRecord(decision) || decision.kind !== 'enter') return decision
      const sessionId = sessionIdOf(payload)
      if (sessionId === undefined) return decision
      const store = runtime.store
      const session = store.peek(sessionId)
      if (session === undefined || session.entries.length === 0) return decision
      const turn = Number(isRecord(payload) ? payload.turn : 0) || session.lastTurn
      const step = Number(isRecord(payload) ? payload.step : 0) || 0
      const entries = activeEntries(session, turn)
      if (entries.length === 0) return decision
      const catalog = runtime.catalog()
      if (catalog === undefined) return decision
      const messages = Array.isArray(decision.messages) ? decision.messages : []
      const marked = messages.filter((message) => hasMarker(messageText(message)))
      if (marked.length > 0) {
        const methodIds = [
          ...new Set(marked.flatMap((message) => parseMarkers(messageText(message)).map((m) => m.methodId))),
        ]
        if (session.channel.pendingTurn === turn) {
          const bundle = buildBundle(catalog, entries)
          store.noteLanded(sessionId, {
            turn,
            step,
            methodIds: bundle?.methodIds ?? methodIds,
            tokens: bundle?.tokens ?? 0,
            hash: bundle === undefined ? '' : primaryHash(bundle),
            channel: 'context',
          })
        }
        store.markApplied(sessionId, turn, methodIds)
        return decision
      }
      // No marker in this step. Two legitimate reasons: the framework deduped an
      // unchanged snapshot (retained text), or the channel genuinely never rendered.
      if (session.channel.verified) return decision
      if (session.channel.pendingTurn !== turn) return decision
      if (step !== 1) return decision
      // Already delivered on an earlier pass of this same turn: never double-inject.
      if (entries.every((entry) => entry.appliedTurns.includes(turn))) return decision
      const bundle = buildBundle(catalog, entries)
      if (bundle === undefined) return decision
      if (bundle.bundles.some((item) => item.contract.overBudget)) return decision
      const message = await createPluginNoticeMessage(bundle.text)
      if (message === undefined) {
        runtime.fail(sessionId, turn, step, 'fallback-failed', '无法创建兜底消息')
        return decision
      }
      store.noteFailure(sessionId, {
        turn,
        step,
        stage: 'context-miss',
        note: '运行时上下文通道未产出快照，已切换 pre-step 兜底',
      })
      store.noteLanded(sessionId, {
        turn,
        step,
        methodIds: bundle.methodIds,
        tokens: bundle.tokens,
        hash: primaryHash(bundle),
        channel: 'pre-step',
        note: 'fallback',
      })
      store.markApplied(sessionId, turn, bundle.methodIds)
      return { ...decision, messages: [...messages, message] }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const sessionId = sessionIdOf(payload)
      if (sessionId !== undefined) runtime.fail(sessionId, 0, 0, 'error', `pre-step: ${message}`)
      return decision
    }
  })
  return combine(preStep)
}

/** Primary turn-boundary signal; `agent/inbox/claimed` fires exactly once per turn. */
export function registerTurnBoundary(ctx: HostCtx, runtime: InjectionRuntime): () => void {
  const claimed = ctx.on('agent/inbox/claimed', (payload: unknown) => {
    try {
      const sessionId = sessionIdOf(payload)
      if (sessionId === undefined) return
      if (runtime.store.peek(sessionId) === undefined) return
      const turn = Number(isRecord(payload) ? payload.turn : 0) || 0
      runtime.store.turnStart(sessionId, turn)
    } catch {
      // never break a turn over bookkeeping
    }
  })
  return combine(claimed)
}

/** Track turns and rebuild the content-free trace from the session log. */
export function registerSessionEvents(ctx: HostCtx, runtime: InjectionRuntime, now: () => Date = () => new Date()): () => void {
  const listener = ctx.on('session/event', (session: unknown, event: unknown) => {
    try {
      if (!isRecord(session) || typeof session.id !== 'string') return
      if (!isRecord(event)) return
      const sessionId = session.id
      const type = event.type
      const data = isRecord(event.data) ? event.data : {}
      if (type === 'turn/start') {
        const turn = Number(data.turn) || 0
        if (runtime.store.peek(sessionId) !== undefined) runtime.store.turnStart(sessionId, turn)
        return
      }
      if (type === 'turn/end') {
        const turn = Number(data.turn) || 0
        if (runtime.store.peek(sessionId) !== undefined) runtime.store.turnEnd(sessionId, turn)
        return
      }
      if (type !== 'user/message') return
      const text = messageText(data)
      if (!hasMarker(text)) return
      const catalog = runtime.catalog()
      const state = runtime.store.peek(sessionId)
      const turn = state?.lastTurn ?? 0
      for (const { methodId } of parseMarkers(text)) {
        const contractHash =
          catalog?.render(methodId)?.hash ?? blockHash(text, methodId)
        runtime.store.recordTrace({
          methodId,
          contractHash,
          sessionId,
          turn,
          ts: now().toISOString(),
        })
      }
    } catch {
      // Trace bookkeeping must never break a turn.
    }
  })
  return combine(listener)
}
