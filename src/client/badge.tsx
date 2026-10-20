/**
 * The trace: `conversation.chat.turnTail`, one entry per completed Turn.
 *
 * A Turn that ran under a method keeps a small `✦ name` pill in its footer; the
 * pill opens the contract text that was actually injected (lazily fetched from
 * the Host, so a transcript of forty turns costs one request, not forty) and
 * offers 换一个 to arm a different method for the next round.
 *
 * @module dsh-methodology-injection/client/badge
 */

import * as React from 'react'
import { readableContract } from './api'
import { catalogOf, closePanel, ensureTrace, openPanel, toggleBadge } from './store'
import { T, cx } from './styles'
import { Btn, Star, turnNumberOf, useView } from './ui'

/**
 * The footer badge.
 * @param props.sessionId - session reported by the slot.
 * @param props.turn - `TurnLocation` handed to turn-tail entries.
 * @returns the pill and its contract card, or null for a Turn with no method.
 */
export function Badge({
  sessionId,
  turn,
}: {
  sessionId: string
  turn: unknown
}): React.ReactElement | null {
  const view = useView(sessionId)
  const turnNo = turnNumberOf(turn)
  const recent = view.snapshot?.recent ?? []
  // Prefer the exact Turn. Without a readable number, fall back to the newest
  // recorded Turn: at turn-tail time that IS the Turn that just closed.
  const trace = turnNo === null
    ? recent[0] ?? null
    : recent.find((entry) => entry.turn === turnNo) ?? null
  const open = view.badgeTurn !== null && trace !== null && view.badgeTurn === trace.turn

  React.useEffect(() => {
    if (open && trace !== null) ensureTrace(sessionId, trace.turn)
  }, [open, sessionId, trace])

  if (trace === null) return null

  const entry = view.traces[trace.turn]
  const contract = entry?.status === 'ready' ? entry.value : null

  return React.createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 } },
    React.createElement(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 6 } },
      React.createElement(
        'button',
        {
          type: 'button',
          className: cx('dmi-btn'),
          'aria-expanded': open,
          title: open ? '收起契约' : '查看本轮注入的方法论契约',
          onClick: () => {
            toggleBadge(sessionId, trace.turn)
          },
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            height: 22,
            padding: '0 8px',
            borderRadius: 999,
            border: `1px solid ${open ? T.ghostBorder : T.borderL2}`,
            background: open ? T.ghostFill : T.bgLayer1,
            color: open ? T.brandText : T.label2,
            fontFamily: T.font,
            fontSize: 11,
            fontWeight: 500,
            lineHeight: 1,
            cursor: 'pointer',
            maxWidth: 260,
          },
        },
        React.createElement(Star, { size: 10, color: T.brand }),
        React.createElement(
          'span',
          { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          trace.name,
        ),
        React.createElement(
          'span',
          { 'aria-hidden': true, style: { fontSize: 8, color: T.label3 } },
          open ? '▴' : '▾',
        ),
      ),
      React.createElement(
        'span',
        { style: { fontSize: 10.5, color: T.label3 } },
        `第 ${String(trace.turn)} 轮`,
      ),
    ),
    open
      ? React.createElement(
        'div',
        {
          className: 'dmi-panel',
          style: {
            border: `1px solid ${T.elevationStroke}`,
            borderRadius: T.radiusMd,
            background: T.bgOverlay,
            boxShadow: T.elevation,
            overflow: 'hidden',
            maxWidth: 640,
          },
        },
        React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '7px 10px',
              borderBottom: `1px solid ${T.borderL1}`,
              background: T.bgLayer1,
            },
          },
          React.createElement(Star, { size: 11, color: T.brand }),
          React.createElement(
            'span',
            { style: { fontSize: 11.5, fontWeight: 600, color: T.label1 } },
            '本轮契约',
          ),
          React.createElement(
            'span',
            {
              title: `契约指纹 ${trace.contractHash}`,
              style: {
                fontFamily: 'var(--dsw-font-family-mono, ui-monospace, monospace)',
                fontSize: 9.5,
                color: T.label3,
                background: T.bgLayer2,
                borderRadius: 4,
                padding: '1px 5px',
              },
            },
            trace.contractHash.slice(0, 8),
          ),
          React.createElement('span', { style: { flex: 1 } }),
          React.createElement(Btn, {
            tone: 'quiet',
            title: '为下一轮换一个方法',
            children: '换一个',
            onClick: () => {
              closePanel(sessionId)
              openPanel(sessionId, { activeId: trace.methodId })
            },
          }),
        ),
        React.createElement(
          'div',
          {
            className: cx('dmi-scroll'),
            style: {
              maxHeight: 260,
              overflowY: 'auto',
              padding: '8px 12px 10px',
              fontSize: 11.5,
              lineHeight: 1.65,
              color: T.label2,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            },
          },
          entry === undefined || entry.status === 'loading'
            ? '读取契约…'
            : entry.status === 'error'
              ? `契约读取失败：${entry.message}`
              : contract === null
                ? '这一轮没有记录契约。'
                : readableContract(contract.contract),
        ),
        contract !== null && (contract.assists ?? []).length > 0
          ? React.createElement(
            'div',
            {
              style: {
                padding: '6px 12px',
                borderTop: `1px solid ${T.borderL1}`,
                fontSize: 10.5,
                color: T.label3,
              },
            },
            `辅助条款：${(contract.assists ?? [])
              .map((id) => catalogOf(view).assists.find((assist) => assist.id === id)?.name ?? id)
              .join(' · ')}`,
          )
          : null,
      )
      : null,
  )
}
