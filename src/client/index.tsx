/**
 * The client half's entry: it owns no state of its own, it only seats four
 * components into the shell's slots and binds the keyboard layer.
 *
 * Seats (all `scope: 'session'`, so every prop we need is already there and no
 * request is spent guessing the session):
 *  - `conversation.input.left`   `methodology-chip`     order 1  → the ✦ chip
 *  - `conversation.input.overlay` `methodology-panel`   order 90 → the picker
 *  - `conversation.input.overlay` `methodology-recall`  order 10 → recall/notice
 *  - `conversation.chat.turnTail` `methodology-badge`   order 30 → §trace badge
 *
 * Registration is deliberately defensive: a slot that the running shell does not
 * declare must cost that one surface, never the plugin.
 *
 * @module dsh-methodology-injection/client
 */

import * as React from 'react'
import { Badge } from './badge'
import { Chip } from './chip'
import { Panel } from './panel'
import { Recall } from './recall'
import { installShortcuts } from './shortcuts'
import { injectStyles } from './styles'

/** Plugin id as the loader knows it. */
export const name = 'dsh-methodology-injection'

/** Props a slot entry receives: owner props plus the standard session props. */
export type SlotProps = Readonly<Record<string, unknown>>

/** The one register option shape every list slot documents. */
export interface SlotOptions {
  readonly name: string
  readonly id: string
  readonly order?: number
  readonly label?: string
}

/** The subset of the client `slots` service this plugin uses. */
export interface SlotsService {
  inject(host: string, factory: () => unknown): unknown
  register(
    options: SlotOptions,
    component: (props: SlotProps) => React.ReactElement | null,
  ): () => void
}

/** The client context handed to `apply`. */
export interface ClientContext {
  readonly slots?: SlotsService
  effect?(run: () => void | (() => void), label?: string): unknown
}

/** Guard so a re-`apply` (HMR, double mount) cannot seat the same slot twice. */
let wired = false

/** Read the session out of the standard props, refusing anything unusable. */
function sessionOf(props: SlotProps): string | null {
  const value = props.sessionId
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Which conversation the shortcut layer should act on: the last chip drawn. */
function sessionEntry(): (props: SlotProps) => React.ReactElement | null {
  return (props) => {
    const sessionId = sessionOf(props)
    return sessionId === null ? null : React.createElement(Chip, { sessionId })
  }
}

/** The picker, seated in the composer's own popover layer. */
function panelEntry(): (props: SlotProps) => React.ReactElement | null {
  return (props) => {
    const sessionId = sessionOf(props)
    return sessionId === null ? null : React.createElement(Panel, { sessionId })
  }
}

/** The recall / shortcut-notice strip. */
function recallEntry(): (props: SlotProps) => React.ReactElement | null {
  return (props) => {
    const sessionId = sessionOf(props)
    return sessionId === null ? null : React.createElement(Recall, { sessionId })
  }
}

/** The per-Turn trace badge; `turn` is a `TurnLocation`, passed through whole. */
function badgeEntry(): (props: SlotProps) => React.ReactElement | null {
  return (props) => {
    const sessionId = sessionOf(props)
    if (sessionId === null) return null
    return React.createElement(Badge, { sessionId, turn: props.turn })
  }
}

/** Seat one entry, tolerating a slot the shell does not declare. */
function seat(
  slots: SlotsService,
  host: string,
  id: string,
  order: number,
  component: (props: SlotProps) => React.ReactElement | null,
): void {
  try {
    slots.inject(host, () =>
      slots.register({ name: host, id, order }, component),
    )
  } catch (error) {
    console.warn(`[dsh-methodology-injection] slot "${host}" unavailable`, error)
  }
}

/**
 * Client entry point.
 * @param ctx - client plugin context, with the `slots` service injected.
 */
export function apply(ctx: ClientContext): void {
  if (wired) return
  wired = true

  // Styles are idempotent (one tagged <style>), the shortcut layer self-guards.
  const stopStyles = injectStyles()
  const stopKeys = installShortcuts()
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      stopStyles()
      stopKeys()
      wired = false
    }, 'methodology:bindings')
  }

  const slots = ctx.slots
  if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
    return
  }

  seat(slots, 'conversation.input.left', 'methodology-chip', 1, sessionEntry())
  seat(slots, 'conversation.input.overlay', 'methodology-recall', 10, recallEntry())
  seat(slots, 'conversation.input.overlay', 'methodology-panel', 90, panelEntry())
  seat(slots, 'conversation.chat.turnTail', 'methodology-badge', 30, badgeEntry())
}
