/**
 * Recall strip: `conversation.input.overlay`, shown just above the chip.
 *
 * The one thing a user cannot know before sending is what the *previous* round
 * ran under — so the last recorded method is offered back as a single tap:
 * `上一轮：第一性原理 · 复用`. It hides while the picker is open, while a method
 * is already armed, and permanently once dismissed for that session.
 *
 * @module dsh-methodology-injection/client/recall
 */

import * as React from 'react'
import { catalogOf, dismissKbdNotice, dismissRecall, reuse } from './store'
import { T, cx } from './styles'
import { Btn, Star, useView } from './ui'

/**
 * The recall hint.
 * @param props.sessionId - session reported by the slot.
 * @returns the strip, or null when there is nothing to recall.
 */
export function Recall({ sessionId }: { sessionId: string }): React.ReactElement | null {
  const view = useView(sessionId)
  const recent = view.snapshot?.recent[0] ?? null
  const armed = view.snapshot?.armed ?? null
  const known = recent === null
    ? null
    : catalogOf(view).methods.find((method) => method.id === recent.methodId) ?? null

  const [bottom, setBottom] = React.useState(96)
  React.useLayoutEffect(() => {
    const measure = (): void => {
      const chip = document.querySelector<HTMLElement>(`[data-dmi-chip="${sessionId}"]`)
      if (chip === null) return
      setBottom(window.innerHeight - chip.getBoundingClientRect().top + 8)
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [sessionId])

  // The shortcut fallback owns this strip when it has something to say: it is
  // the one place a user can learn which key actually opens the picker.
  if (view.kbdNotice !== null) {
    return React.createElement(
      'div',
      {
        role: 'status',
        style: {
          position: 'fixed',
          left: 16,
          bottom,
          zIndex: 991,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 26,
          padding: '0 4px 0 9px',
          borderRadius: 999,
          border: `1px solid ${T.borderL2}`,
          background: T.warnBg,
          boxShadow: T.elevation,
          color: T.warn,
          fontFamily: T.font,
          fontSize: 11,
          lineHeight: 1,
          maxWidth: 420,
        },
      },
      React.createElement(Star, { size: 9, color: T.warn }),
      React.createElement(
        'span',
        { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        view.kbdNotice,
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          className: cx('dmi-btn'),
          'aria-label': '知道了',
          title: '知道了',
          onClick: () => {
            dismissKbdNotice(sessionId)
          },
          style: {
            width: 18,
            height: 18,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px solid transparent',
            borderRadius: T.radiusSm,
            background: 'transparent',
            color: T.warn,
            fontSize: 10,
            lineHeight: 1,
            cursor: 'pointer',
            flex: '0 0 auto',
          },
        },
        '✕',
      ),
    )
  }

  if (recent === null || known === null || armed !== null || view.panel || view.recallDismissed) return null

  return React.createElement(
    'div',
    {
      className: cx('dmi-pulse-once'),
      style: {
        position: 'fixed',
        left: 16,
        bottom,
        zIndex: 990,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        height: 26,
        padding: '0 4px 0 9px',
        borderRadius: 999,
        border: `1px solid ${T.borderL2}`,
        background: T.bgOverlay,
        boxShadow: T.elevation,
        color: T.label2,
        fontFamily: T.font,
        fontSize: 11,
        lineHeight: 1,
        maxWidth: 360,
      },
    },
    React.createElement(Star, { size: 9, color: T.brand }),
    React.createElement(
      'span',
      { style: { marginLeft: 4, color: T.label3, flex: '0 0 auto' } },
      '上一轮',
    ),
    React.createElement(
      'span',
      {
        style: {
          marginLeft: 4,
          color: T.label1,
          fontWeight: 600,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: 180,
        },
      },
      known.name,
    ),
    React.createElement(
      'span',
      { style: { margin: '0 2px', color: T.borderL3, flex: '0 0 auto' } },
      '·',
    ),
    React.createElement(Btn, {
      tone: 'quiet',
      title: `复用「${known.name}」注入下一轮`,
      children: '复用',
      onClick: () => {
        void reuse(sessionId, known.id)
      },
    }),
    React.createElement(
      'button',
      {
        type: 'button',
        className: cx('dmi-btn'),
        'aria-label': '不再提示上一轮的方法',
        title: '不再提示',
        onClick: () => {
          dismissRecall(sessionId)
        },
        style: {
          width: 18,
          height: 18,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '1px solid transparent',
          borderRadius: T.radiusSm,
          background: 'transparent',
          color: T.label3,
          fontSize: 10,
          lineHeight: 1,
          cursor: 'pointer',
          flex: '0 0 auto',
        },
      },
      '✕',
    ),
  )
}
