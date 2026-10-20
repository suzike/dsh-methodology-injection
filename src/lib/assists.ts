/**
 * Optional contract add-ons ("+ 辅助").
 *
 * The catalog schema (schemaVersion 1) has no assists field, so the Host owns this
 * provisional registry. Selecting an assist appends one line per clause after the
 * method body; it never rewrites the body. Budget is still hard: base + marker +
 * assists must fit `injectionBudget.maxTokens`, otherwise arming fails visibly.
 */

import type { AssistClause } from './types.js'

export const ASSISTS: readonly AssistClause[] = [
  {
    id: 'counterexample',
    name: '反例',
    clause: '每个关键结论后附一个反例或失效条件。',
  },
  {
    id: 'evidence',
    name: '证据',
    clause: '给可验证证据：数据、来源或可复现步骤。',
  },
  {
    id: 'uncertainty',
    name: '不确定性',
    clause: '标注置信度与信息缺口，不确定处明说。',
  },
  {
    id: 'next-step',
    name: '下一步',
    clause: '结尾给出可执行的下一步与优先级。',
  },
]

/** Maximum assists per arm, so the budget stays reachable. */
export const MAX_ASSISTS = 2

const byId = new Map(ASSISTS.map((assist) => [assist.id, assist]))

/** Resolve assist ids, preserving caller order and rejecting unknown ids. */
export function resolveAssists(ids: readonly string[]): AssistClause[] | undefined {
  const resolved: AssistClause[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) continue
    const assist = byId.get(id)
    if (assist === undefined) return undefined
    seen.add(id)
    resolved.push(assist)
  }
  return resolved
}

export function assistIds(): string[] {
  return ASSISTS.map((assist) => assist.id)
}

export function assistCards(): Array<{ id: string; name: string; clause: string }> {
  return ASSISTS.map((assist) => ({ id: assist.id, name: assist.name, clause: assist.clause }))
}
