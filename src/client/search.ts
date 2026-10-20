/**
 * Search semantics for the methodology picker.
 *
 * The rule the interaction contract asks for: a highlight wins when one exists,
 * and the first match is only the fallback. That means filtering must be
 * deterministic and stable — the list the UI paints is the list Enter indexes.
 *
 * Ranking is deliberately simple and explainable: name prefix, then name
 * substring, then tagline/tag/category hits, each group keeping catalogue order.
 *
 * @module dsh-methodology-injection/client/search
 */

import type { MethodCard } from './api'

/** One visible row of the picker. */
export interface MethodRow {
  readonly method: MethodCard
  /** Inclusive character ranges of `method.name` that matched the query. */
  readonly nameHits: readonly (readonly [number, number])[]
}

/** Case-fold and collapse whitespace so `第一 性` still finds `第一性原理`. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, '')
}

/** Collect every occurrence of `needle` inside `haystack`, for match emphasis. */
function hitsOf(haystack: string, needle: string): (readonly [number, number])[] {
  if (needle.length === 0) return []
  const hay = haystack.toLowerCase()
  const hits: (readonly [number, number])[] = []
  let at = hay.indexOf(needle)
  while (at !== -1) {
    hits.push([at, at + needle.length] as const)
    at = hay.indexOf(needle, at + needle.length)
  }
  return hits
}

/** Everything a query is compared against, most specific first. */
function haystackOf(method: MethodCard): string {
  return [method.name, method.tagline ?? '', ...(method.tags ?? []), method.badge ?? ''].map(normalize).join('\u0000')
}

/** Rank one method against a normalized query; `undefined` means "no match". */
function rankOf(method: MethodCard, query: string): number | undefined {
  if (query.length === 0) return 0
  const name = normalize(method.name)
  if (name.startsWith(query)) return 0
  if (name.includes(query)) return 1
  const tagline = normalize(method.tagline ?? '')
  if (tagline.includes(query)) return 2
  const rest = (method.tags ?? []).map(normalize).join('\u0000') + '\u0000' + normalize(method.badge ?? '')
  if (rest.includes(query)) return 3
  // Multi-token queries: every token must appear somewhere in the haystack.
  const tokens = query.split(' ')
  if (tokens.length > 1 && tokens.every((token) => haystackOf(method).includes(token))) return 4
  return undefined
}

/**
 * Filter and rank the catalogue for one query.
 * @param methods - catalogue order, preserved inside every rank group.
 * @param query - raw user input.
 * @returns the rows to render, already in display order.
 */
export function filterMethods(methods: readonly MethodCard[], query: string): MethodRow[] {
  const needle = normalize(query)
  const ranked: { row: MethodRow; rank: number; order: number }[] = []
  methods.forEach((method, order) => {
    const rank = rankOf(method, needle)
    if (rank === undefined) return
    ranked.push({ row: { method, nameHits: hitsOf(method.name, needle) }, rank, order })
  })
  ranked.sort((a, b) => (a.rank === b.rank ? a.order - b.order : a.rank - b.rank))
  return ranked.map((entry) => entry.row)
}

/**
 * Group rows by their category badge, preserving row order.
 * @param rows - filtered rows.
 * @returns consecutive groups, in first-appearance order.
 */
export function groupRows(rows: readonly MethodRow[]): { badge: string | undefined; rows: MethodRow[] }[] {
  const groups: { badge: string | undefined; rows: MethodRow[] }[] = []
  for (const row of rows) {
    const badge = row.method.badge
    const last = groups[groups.length - 1]
    if (last !== undefined && last.badge === badge) last.rows.push(row)
    else groups.push({ badge, rows: [row] })
  }
  return groups
}
