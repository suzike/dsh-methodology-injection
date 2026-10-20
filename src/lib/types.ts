/**
 * Shared types for the Host half of dsh-methodology-injection.
 *
 * Vocabulary:
 * - A **method** is one entry of `catalog/methods.json` (written by the catalog author).
 * - An **arm** is a user decision that a session should answer with one or more methods.
 * - A **contract** is the compact text block injected for an armed method. It always
 *   starts with `[[METHOD:<id>]]` so the trace can be rebuilt by parsing the session log.
 */

/** How long an arm stays active. */
export type InjectionMode =
  /** Consumed by exactly one turn, then cleared. */
  | 'turn'
  /** Stays active until explicitly released. */
  | 'pinned'
  /** Stacks next to the primary arm (and other stacks) until released. */
  | 'stack'

/** One armed method inside a session. */
export interface ArmedEntry {
  readonly methodId: string
  readonly mode: InjectionMode
  /** Optional assist clauses appended to the contract body. */
  readonly assists: readonly string[]
  /** ISO timestamp of the arm call. */
  readonly armedAt: string
  /** 1-based turn number this entry becomes active on. */
  readonly armedForTurn: number
  /** Turns in which the contract actually reached the model. */
  readonly appliedTurns: number[]
}

/** Per-session health of the two injection channels. */
export interface ChannelState {
  /** The runtime-context channel demonstrably delivered a contract at least once. */
  verified: boolean
  /** A pre-step fallback append was necessary at least once. */
  degraded: boolean
  /** Whether an assembly for `pendingTurn` has been observed but not yet confirmed. */
  pendingTurn: number | null
  verifiedAt?: string
}

/** Truth about the most recent injection attempt for one session. */
export interface LastInjection {
  sessionId: string
  turn: number
  step: number
  ts: string
  methodIds: string[]
  /** Where the contract entered the conversation. */
  channel: 'context' | 'pre-step' | 'none'
  landed: boolean
  tokenEstimate: number
  contractHash: string
  /**
   * Last pipeline stage reached, so a failure is attributable:
   * `armed` -> `assembled` -> `landed`, or one of the failure stages below.
   */
  stage: InjectionStage
  note?: string
}

export type InjectionStage =
  | 'armed'
  | 'assembled'
  | 'landed'
  | 'unknown-method'
  | 'budget-exceeded'
  | 'catalog-error'
  | 'context-miss'
  | 'fallback-failed'
  | 'error'

/** Durable, content-free trace of one landed contract. */
export interface TraceEntry {
  methodId: string
  contractHash: string
  sessionId: string
  turn: number
  ts: string
}

/** In-memory + persisted state of one session. */
export interface SessionState {
  sessionId: string
  /** Highest turn number observed for this session (0 before the first turn). */
  lastTurn: number
  turnOpen: boolean
  lastSeen: string
  entries: ArmedEntry[]
  channel: ChannelState
  lastInjection?: LastInjection
}

export interface PersistedState {
  version: 1
  updatedAt: string
  sessions: Record<string, SessionState>
  history: TraceEntry[]
}

/** Catalog shapes, mirroring `catalog/methods.json` schemaVersion 1. */
export interface CatalogInject {
  positioning: string
  constraints: string[]
  skeleton: string
  lengthDiscipline: string
}

export interface CatalogDisplay {
  what: string
  whenToUse: string
  misuse: string
  source: string
}

export interface CatalogMethod {
  id: string
  zh: string
  en: string
  category: string
  aliases: string[]
  oneliner: string
  inject: CatalogInject
  display: CatalogDisplay
  conflicts?: string[]
}

export interface CatalogCategory {
  id: string
  zh: string
  en: string
  intent: string
}

export interface ConflictRule {
  pair: string[]
  rule: string
  preferred: string | null
  preferWhen: string | null
}

/** Read-only catalog surface the store needs, so state logic stays testable. */
export interface CatalogView {
  has(methodId: string): boolean
  conflict(a: string, b: string): ConflictRule | undefined
}

/**
 * One optional extra clause the user can append to a contract ("+ 辅助").
 * Provisional: the catalog schema has no assists field yet, so the Host owns
 * this small registry. Ids are stable; names are display-only.
 */
export interface AssistClause {
  id: string
  name: string
  clause: string
}

/** A rendered, budget-checked contract block. */
export interface RenderedContract {
  methodId: string
  /** Full injected text, starting with the `[[METHOD:<id>]]` marker. */
  text: string
  /** Tokens of the catalog body only (positioning/constraints/skeleton/length). */
  bodyTokens: number
  /** Tokens of the complete block, marker and envelope included. */
  tokens: number
  hash: string
  overBudget: boolean
}
