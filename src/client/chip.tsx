/**
 * The composer entry point: `conversation.input.left`, order 1 — one step right
 * of the shipped `agency-agents` chip, so the two read as sibling tools.
 *
 * Two states, one control: idle it is a quiet `✦ 方法` pill that opens the
 * picker; armed it carries the method name inside a brand gradient edge and
 * pulses once on every successful arm (the confirmation the panel's 120ms close
 * would otherwise swallow).
 *
 * @module dsh-methodology-injection/client/chip
 */

import * as React from 'react'
import { T, cx } from './styles'
import { focus, kbdLabel, togglePanel } from './store'
import { Star, useView } from './ui'

/**
 * The chip itself.
 * @param props.sessionId - session reported by the slot.
 * @returns the composer chip.
 */
export function Chip({ sessionId }: { sessionId: string }): React.ReactElement {
  const view = useView(sessionId)
  const armed = view.snapshot?.armed ?? null
  const label = armed?.name ?? '方法'
  const shortcut = kbdLabel(view)
  // A refused arm must leave a visible trace on the control that started it,
  // since the panel closes on its own beat.
  const failed = view.error !== null && armed === null

  // Announce this composer to the shortcut layer: whichever chip last mounted
  // owns ⌘K, which is exactly "the conversation the user is looking at".
  React.useEffect(() => {
    focus(sessionId)
  }, [sessionId])

  // Restart the pulse animation on every arm, without remounting the button.
  const [pulsing, setPulsing] = React.useState(false)
  React.useEffect(() => {
    if (view.pulse === 0) return
    setPulsing(true)
    const timer = setTimeout(() => {
      setPulsing(false)
    }, 560)
    return () => {
      clearTimeout(timer)
    }
  }, [view.pulse])

  const onClick = React.useCallback(() => {
    focus(sessionId)
    togglePanel(sessionId)
  }, [sessionId])

  return React.createElement(
    'button',
    {
      type: 'button',
      // A stable hook for the panel to anchor against (the overlay slot may be
      // positioned differently in future shells; the chip is always here).
      'data-dmi-chip': sessionId,
      className: cx('dmi-chip'),
      'data-pulse': pulsing ? '' : undefined,
      'data-armed': armed === null ? undefined : '',
      'aria-haspopup': 'dialog',
      'aria-expanded': view.panel,
      'aria-label': armed === null
        ? `选择方法论（${shortcut}）${failed ? `，上次失败：${view.error ?? ''}` : ''}`
        : `当前方法论：${armed.name}（点击更换）`,
      title: armed !== null
        ? `${armed.name} · 点击更换`
        : failed
          ? `方法论 · ${view.error ?? '操作失败'} · ${shortcut}`
          : `方法论 · ${shortcut}`,
      onClick,
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 28,
        maxWidth: 210,
        padding: '0 10px',
        borderRadius: 999,
        // Gradient edge, zero hard-coded colour: two background layers, the
        // inner one clipped to the padding box, the outer one to the border box.
        border: '1px solid transparent',
        backgroundImage: armed === null
          ? 'none'
          : `linear-gradient(${T.bgOverlay}, ${T.bgOverlay}), linear-gradient(135deg, ${T.brand}, ${T.brandText})`,
        backgroundOrigin: 'border-box',
        backgroundClip: armed === null ? 'border-box' : 'padding-box, border-box',
        backgroundColor: armed === null ? 'transparent' : T.bgOverlay,
        boxShadow: armed === null ? `inset 0 0 0 1px ${failed ? T.error : T.borderL2}` : 'none',
        color: armed === null ? T.label2 : T.label1,
        fontFamily: T.font,
        fontSize: 12,
        fontWeight: armed === null ? 500 : 600,
        lineHeight: 1,
        letterSpacing: '.01em',
        cursor: 'pointer',
        flex: '0 0 auto',
        overflow: 'hidden',
      },
    },
    React.createElement(Star, {
      size: 12,
      color: armed !== null ? T.brand : failed ? T.error : T.label3,
    }),
    React.createElement(
      'span',
      {
        style: {
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
        },
      },
      label,
    ),
    armed === null
      ? null
      : React.createElement(
        'span',
        {
          'aria-hidden': true,
          style: { fontSize: 9, color: T.label3, lineHeight: 1, flex: '0 0 auto' },
        },
        '▾',
      ),
  )
}
