/**
 * Shared client primitives: the session hook, the few atoms every surface
 * reuses, and the small amount of defensive reading the Slot contracts need.
 *
 * @module dsh-methodology-injection/client/ui
 */

import * as React from 'react'
import { T, cx } from './styles'
import { get, subscribe, type ViewState } from './store'

/**
 * Subscribe one surface to one session's view.
 * @param sessionId - session the host passed into the slot.
 * @returns the current immutable snapshot.
 */
export function useView(sessionId: string): ViewState {
  return React.useSyncExternalStore(
    React.useCallback((notify: () => void) => subscribe(sessionId, notify), [sessionId]),
    React.useCallback(() => get(sessionId), [sessionId]),
    React.useCallback(() => get(sessionId), [sessionId]),
  )
}

/** Run a side effect exactly once after mount, and clean it up on unmount. */
export function useOnce(effect: () => void | (() => void)): void {
  const seen = React.useRef(false)
  React.useEffect(() => {
    if (seen.current) return
    seen.current = true
    return effect()
    // Deliberately mount-only: the effect closes over stable module state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

/**
 * Highlight every case-insensitive occurrence of a query inside a label.
 *
 * Rendered with `<mark>` so the browser owns the selection colour; the class
 * only supplies the token-based tint.
 * @param props.text - full label.
 * @param props.query - what the user typed.
 * @returns the label with matches marked.
 */
export function Mark({ text, query }: { text: string; query: string }): React.ReactElement {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return React.createElement(React.Fragment, null, text)
  const haystack = text.toLowerCase()
  const parts: React.ReactNode[] = []
  let cursor = 0
  let hits = 0
  for (let at = haystack.indexOf(needle); at !== -1 && hits < 80; at = haystack.indexOf(needle, cursor)) {
    if (at > cursor) parts.push(text.slice(cursor, at))
    parts.push(
      React.createElement('mark', { key: `m${String(at)}`, className: 'dmi-mark' }, text.slice(at, at + needle.length)),
    )
    cursor = at + needle.length
    hits += 1
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return React.createElement(React.Fragment, null, ...parts)
}

/**
 * A keyboard cap, matching the size the command palette uses.
 * @param props.text - the key combination, already formatted for the platform.
 * @param props.muted - dim it inside a hint line.
 * @returns one inline-flex cap.
 */
export function Kbd({ text, muted = false }: { text: string; muted?: boolean }): React.ReactElement {
  return React.createElement(
    'kbd',
    {
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        height: 18,
        padding: '0 5px',
        borderRadius: T.radiusSm,
        border: `1px solid ${T.borderL2}`,
        background: T.bgLayer1,
        color: muted ? T.label3 : T.label2,
        fontFamily: T.font,
        fontSize: 10.5,
        fontWeight: 500,
        letterSpacing: '.02em',
        lineHeight: 1,
        whiteSpace: 'nowrap',
      },
    },
    text,
  )
}

/**
 * The method glyph. A single precomposed star, sized to the type it sits beside.
 * @param props.size - pixel size.
 * @param props.color - token colour.
 * @returns the glyph span.
 */
export function Star({ size = 12, color = T.brand }: { size?: number; color?: string }): React.ReactElement {
  return React.createElement(
    'span',
    {
      'aria-hidden': true,
      style: { fontSize: size, lineHeight: 1, color, display: 'inline-block', flex: '0 0 auto' },
    },
    '✦',
  )
}

/**
 * A one-line button used in headers and footers.
 * @param props - label, handler and tone.
 * @returns the button element.
 */
export function Btn({
  children,
  onClick,
  title,
  tone = 'ghost',
  disabled = false,
  active = false,
}: {
  children: React.ReactNode
  onClick: () => void
  title?: string
  tone?: 'ghost' | 'primary' | 'quiet'
  disabled?: boolean
  active?: boolean
}): React.ReactElement {
  const primary = tone === 'primary'
  return React.createElement(
    'button',
    {
      type: 'button',
      className: 'dmi-btn',
      title,
      'aria-disabled': disabled || undefined,
      disabled,
      onClick,
      'data-tone': primary ? 'primary' : undefined,
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        height: 26,
        padding: tone === 'quiet' ? '0 6px' : '0 10px',
        borderRadius: T.radiusSm,
        border: primary ? '1px solid transparent' : `1px solid ${active ? T.ghostBorder : 'transparent'}`,
        background: primary ? T.primaryFill : active ? T.ghostFill : 'transparent',
        color: primary ? T.onPrimary : active ? T.brandText : T.label2,
        fontFamily: T.font,
        fontSize: 12,
        fontWeight: primary ? 600 : 500,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        lineHeight: 1,
        flex: '0 0 auto',
        whiteSpace: 'nowrap',
      },
    },
    children,
  )
}

/**
 * A square icon button for a header (expand, close).
 * @param props - glyph, accessible label, handler.
 * @returns the button element.
 */
export function IconBtn({
  glyph,
  label,
  onClick,
  expanded = false,
}: {
  glyph: string
  label: string
  onClick: () => void
  expanded?: boolean
}): React.ReactElement {
  return React.createElement(
    'button',
    {
      type: 'button',
      className: cx('dmi-btn'),
      'aria-label': label,
      title: label,
      'aria-expanded': expanded || undefined,
      onClick,
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 24,
        height: 24,
        padding: 0,
        borderRadius: T.radiusSm,
        border: '1px solid transparent',
        background: 'transparent',
        color: T.label3,
        fontSize: 13,
        lineHeight: 1,
        cursor: 'pointer',
        flex: '0 0 auto',
      },
    },
    glyph,
  )
}

/** A count pill, e.g. how many methods the catalogue holds. */
export function Count({ value }: { value: number }): React.ReactElement {
  return React.createElement(
    'span',
    {
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        height: 16,
        padding: '0 5px',
        borderRadius: 999,
        background: T.ghostFill,
        color: T.label3,
        fontSize: 10,
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
        lineHeight: 1,
      },
    },
    String(value),
  )
}

/**
 * Read a Turn number out of the owner props.
 *
 * `conversation.chat.turnTail` hands its entries a `TurnLocation`, not a number,
 * and the runtime shape is only pinned by the bundled chat package. Rather than
 * trusting one field name, resolve the first numeric candidate; the badge
 * degrades to "newest recorded Turn" when none matches.
 * @param turn - whatever the slot passed.
 * @returns the Turn number, or null.
 */
export function turnNumberOf(turn: unknown): number | null {
  if (typeof turn === 'number' && Number.isFinite(turn)) return turn
  if (turn === null || typeof turn !== 'object') return null
  const record = turn as Record<string, unknown>
  for (const key of ['turn', 'number', 'index', 'id']) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}
