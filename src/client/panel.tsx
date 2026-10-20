/**
 * The picker: `conversation.input.overlay`, anchored above the chip.
 *
 * Behaviour pinned by the brief:
 *  - Enter takes the highlighted row, and only falls back to the first match
 *    when nothing is highlighted;
 *  - a single select closes the panel 120ms later (the chip pulses to confirm),
 *    while toggling an assist never closes it;
 *  - Escape closes only the topmost layer: full-window → anchored → gone.
 *
 * The card is positioned `fixed` from the chip's own rect rather than from the
 * overlay box: the overlay slot is a floating layer whose own positioning is a
 * shell implementation detail, and the chip is guaranteed to be right there.
 *
 * @module dsh-methodology-injection/client/panel
 */

import * as React from 'react'
import { readableContract, type AssistCard, type MethodCard } from './api'
import {
  MAX_ASSISTS,
  arm,
  beginAssist,
  catalogOf,
  clearPendingActive,
  closePanel,
  ensureLoaded,
  get,
  kbdLabel,
  release,
  setActive,
  setExpanded,
  setQuery,
  toggleAssist,
} from './store'
import { T, cx } from './styles'
import { Btn, Count, IconBtn, Kbd, Mark, Star, useView } from './ui'

/** Panel width, and the margin kept from the viewport edge. */
const WIDTH = 440
const EDGE = 12
/** How long the armed state flashes before the card leaves. */
const CLOSE_DELAY_MS = 120

/** One rendered line of the list. */
type Row =
  | { readonly kind: 'group'; readonly key: string; readonly label: string }
  | { readonly kind: 'method'; readonly key: string; readonly method: MethodCard }
  | { readonly kind: 'assist'; readonly key: string; readonly assist: AssistCard }

/** Anchored geometry, measured from the chip. */
interface Box {
  readonly left: number
  readonly bottom: number
  readonly width: number
  readonly maxHeight: number
}

/** Case-insensitive containment over the fields a user would search by. */
function matches(method: MethodCard, needle: string): boolean {
  if (needle.length === 0) return true
  const haystack = [method.name, method.tagline ?? '', method.badge ?? '', ...(method.tags ?? [])]
    .join('\u0000')
    .toLowerCase()
  return haystack.includes(needle) || (method.id.toLowerCase().includes(needle))
}

/**
 * The picker surface.
 * @param props.sessionId - session reported by the slot.
 * @returns the card, or null while it is closed.
 */
export function Panel({ sessionId }: { sessionId: string }): React.ReactElement | null {
  const view = useView(sessionId)
  const catalog = catalogOf(view)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const listRef = React.useRef<HTMLDivElement | null>(null)
  const [box, setBox] = React.useState<Box>(() => ({
    left: EDGE,
    bottom: 96,
    width: WIDTH,
    maxHeight: 460,
  }))

  const open = view.panel
  const armed = view.snapshot?.armed ?? null
  const assistsFor = view.assistFor === null
    ? null
    : catalog.methods.find((method) => method.id === view.assistFor) ?? null

  // Measure the chip on open, and keep the card glued to it across resize and
  // any scroll (the composer can sit in a scrolled transcript).
  React.useLayoutEffect(() => {
    if (!open || view.expanded) return
    const measure = (): void => {
      const chip = document.querySelector<HTMLElement>(`[data-dmi-chip="${sessionId}"]`)
      const width = Math.min(WIDTH, Math.max(280, window.innerWidth - EDGE * 2))
      const height = Math.min(520, Math.max(260, window.innerHeight * 0.62))
      if (chip === null) {
        setBox({ left: EDGE, bottom: 96, width, maxHeight: height })
        return
      }
      const rect = chip.getBoundingClientRect()
      const left = Math.min(Math.max(rect.left, EDGE), Math.max(EDGE, window.innerWidth - width - EDGE))
      setBox({ left, bottom: window.innerHeight - rect.top + 10, width, maxHeight: height })
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [open, view.expanded, sessionId])

  // Focus the field on open so ⌘K → type → Enter is a single uninterrupted run.
  React.useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [open, view.expanded])

  // Outside click / window blur closes; the chip's own click is excluded so the
  // toggle stays a toggle.
  React.useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent | PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('[data-dmi-panel]') !== null) return
      if (target.closest('[data-dmi-chip]') !== null) return
      closePanel(sessionId)
    }
    document.addEventListener('mousedown', onPointerDown, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
    }
  }, [open, sessionId])

  const needle = view.query.trim().toLowerCase()

  const rows = React.useMemo<Row[]>(() => {
    const listed = catalog.methods.filter((method) => matches(method, needle))
    const grouped = new Map<string, MethodCard[]>()
    for (const method of listed) {
      const key = needle.length > 0 ? '搜索结果' : method.badge ?? '方法论'
      const bucket = grouped.get(key)
      if (bucket === undefined) grouped.set(key, [method])
      else bucket.push(method)
    }
    const next: Row[] = []
    for (const [group, methods] of grouped) {
      next.push({ kind: 'group', key: `g:${group}`, label: group })
      for (const method of methods) next.push({ kind: 'method', key: `m:${method.id}`, method })
    }
    // The assist cascade only opens for a chosen method — never a permanent
    // second list competing with the first.
    if (view.assistFor !== null) {
      const target = assistsFor
      if (target !== null) {
        next.push({ kind: 'group', key: 'g:assist', label: `辅助 · ${target.name}` })
        for (const assist of catalog.assists) {
          next.push({ kind: 'assist', key: `a:${assist.id}`, assist })
        }
      }
    }
    if (next.length === 0) {
      // Distinguish "the catalogue is still arriving" from "your search is
      // empty": the first is not a failure and must not look like one.
      const label = view.status === 'error'
        ? view.error ?? '方法论目录加载失败'
        : view.status === 'ready'
          ? '没有匹配的方法'
          : '载入方法论目录…'
      next.push({ kind: 'group', key: 'g:empty', label })
    }
    return next
  }, [catalog, needle, view.assistFor, assistsFor, view.status, view.error])

  const selectable = React.useMemo(
    () => rows.map((row, index) => ({ row, index })).filter((entry) => entry.row.kind !== 'group'),
    [rows],
  )

  const activeIndex = view.active !== null && view.active < selectable.length ? view.active : null
  const activeRow = activeIndex === null ? null : selectable[activeIndex]?.row ?? null

  // Reveal the method the badge's 换一个 asked for, once per open.
  React.useEffect(() => {
    if (!open || view.pendingActiveId === null) return
    const at = selectable.findIndex((entry) => entry.row.kind === 'method' && entry.row.method.id === view.pendingActiveId)
    if (at < 0) return
    setActive(sessionId, at)
    clearPendingActive(sessionId)
  }, [open, view.pendingActiveId, selectable, sessionId])

  // Keep the highlighted row in view.
  React.useEffect(() => {
    if (activeIndex === null) return
    const row = selectable[activeIndex]
    if (row === undefined) return
    const node = listRef.current?.querySelector<HTMLElement>(`[data-dmi-row="${String(row.index)}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, selectable])

  React.useEffect(() => {
    if (open) ensureLoaded(sessionId)
  }, [open, sessionId])

  const close = React.useCallback(() => {
    closePanel(sessionId)
    const chip = document.querySelector<HTMLElement>(`[data-dmi-chip="${sessionId}"]`)
    chip?.focus()
  }, [sessionId])

  const pick = React.useCallback(
    (row: Row | null) => {
      if (row === null) return
      if (row.kind === 'assist') {
        if (view.assistFor === null) return
        toggleAssist(sessionId, view.assistFor, row.assist.id)
        return
      }
      if (row.kind !== 'method' || view.busy) return
      const assists = view.assistFor === row.method.id ? view.assistIds : []
      // Close only after the Host accepted the arm: a refusal must leave the
      // card open with its message, not vanish and hide the failure.
      void arm(sessionId, row.method.id, assists).then(() => {
        if (get(sessionId).error !== null) return
        // The 120ms beat: long enough for the chip's pulse to start, short
        // enough that a second keypress cannot land on a stale list.
        setTimeout(() => {
          closePanel(sessionId)
        }, CLOSE_DELAY_MS)
      })
    },
    [sessionId, view.assistFor, view.assistIds, view.busy],
  )

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      const last = selectable.length - 1
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (last < 0) return
        const step = event.key === 'ArrowDown' ? 1 : -1
        const from = activeIndex ?? (step === 1 ? -1 : 0)
        const next = from + step
        const wrapped = next < 0 ? last : next > last ? 0 : next
        setActive(sessionId, wrapped)
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        // Highlighted row wins; the first match is only the fallback.
        const target = activeRow ?? selectable[0]?.row ?? null
        if (target === null) return
        pick(target)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (view.expanded) setExpanded(sessionId, false)
        else close()
        return
      }
      if (event.key === 'Tab' && view.expanded) {
        // In the full-window surface the list is the primary region; keep the
        // field's own tab order working rather than trapping focus.
        return
      }
    },
    [activeIndex, activeRow, pick, selectable, sessionId, view.expanded, close],
  )

  if (!open) return null

  const header = React.createElement(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 10px 8px 12px',
        flex: '0 0 auto',
      },
    },
    React.createElement(Star, { size: 12, color: T.brand }),
    React.createElement(
      'span',
      { style: { fontSize: 12.5, fontWeight: 600, color: T.label1, letterSpacing: '.01em' } },
      '方法论',
    ),
    React.createElement(Count, { value: catalog.methods.length }),
    React.createElement('span', { style: { flex: 1 } }),
    React.createElement(Kbd, { text: kbdLabel(view), muted: true }),
    React.createElement(IconBtn, {
      glyph: view.expanded ? '⤡' : '⤢',
      label: view.expanded ? '退出全屏' : '展开为全屏',
      expanded: view.expanded,
      onClick: () => {
        setExpanded(sessionId, !view.expanded)
      },
    }),
    React.createElement(IconBtn, { glyph: '✕', label: '关闭', onClick: close }),
  )

  const search = React.createElement(
    'div',
    { style: { padding: '0 10px 8px', flex: '0 0 auto' } },
    React.createElement('input', {
      ref: inputRef,
      value: view.query,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
        setQuery(sessionId, event.target.value)
      },
      onKeyDown,
      placeholder: '搜索方法、标签…',
      role: 'combobox',
      'aria-expanded': true,
      'aria-controls': `${sessionId}-list`,
      'aria-activedescendant': activeIndex === null ? undefined : `${sessionId}-opt-${String(activeIndex)}`,
      'aria-autocomplete': 'list',
      spellCheck: false,
      style: {
        width: '100%',
        boxSizing: 'border-box',
        height: 32,
        padding: '0 10px',
        borderRadius: T.radiusMd,
        border: `1px solid ${T.borderL2}`,
        background: T.bgLayer1,
        color: T.label1,
        fontFamily: T.font,
        fontSize: 12.5,
        outline: 'none',
      },
    }),
  )

  const list = React.createElement(
    'div',
    {
      id: `${sessionId}-list`,
      ref: listRef,
      role: 'listbox',
      'aria-label': '方法论',
      className: cx('dmi-scroll'),
      style: {
        flex: '1 1 auto',
        overflowY: 'auto',
        padding: '0 6px 6px',
        minHeight: 0,
        scrollbarGutter: 'stable',
      },
    },
    ...rows.map((row, index) => {
      if (row.kind === 'group') {
        return React.createElement(
          'div',
          {
            key: row.key,
            style: {
              position: 'sticky',
              top: 0,
              zIndex: 1,
              padding: '8px 6px 4px',
              background: T.bgOverlay,
              color: T.label3,
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: '.06em',
              textTransform: 'uppercase',
              backdropFilter: 'blur(2px)',
            },
          },
          row.label,
        )
      }
      if (row.kind === 'assist') {
        const selected = view.assistIds.includes(row.assist.id)
        const slot = selectable.findIndex((entry) => entry.index === index)
        return React.createElement(
          'div',
          {
            key: row.key,
            'data-dmi-row': String(index),
            role: 'option',
            id: `${sessionId}-opt-${String(slot)}`,
            'aria-selected': slot >= 0 && slot === activeIndex,
            className: cx('dmi-row'),
            onMouseEnter: () => {
              if (slot >= 0) setActive(sessionId, slot)
            },
            onClick: () => {
              pick(row)
            },
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '7px 8px 7px 22px',
              borderRadius: T.radiusSm,
              cursor: 'pointer',
              background: slot >= 0 && slot === activeIndex ? T.hover : 'transparent',
              boxShadow: slot >= 0 && slot === activeIndex ? `inset 2px 0 0 ${T.brand}` : 'none',
            },
          },
          React.createElement(Box, { on: selected }),
          React.createElement(
            'span',
            { style: { fontSize: 12, color: selected ? T.label1 : T.label2, flex: '1 1 auto', minWidth: 0 } },
            React.createElement(Mark, { text: row.assist.name, query: view.query }),
          ),
          React.createElement(
            'span',
            {
              style: {
                fontSize: 10.5,
                color: T.label3,
                maxWidth: 190,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: '0 0 auto',
              },
            },
            row.assist.clause ?? '',
          ),
        )
      }

      const slot = selectable.findIndex((entry) => entry.index === index)
      const isActive = slot >= 0 && slot === activeIndex
      const isArmed = armed?.methodId === row.method.id
      const usedBefore = view.snapshot?.recent.some((trace) => trace.methodId === row.method.id) ?? false
      return React.createElement(
        'div',
        {
          key: row.key,
          'data-dmi-row': String(index),
          role: 'option',
          id: `${sessionId}-opt-${String(slot)}`,
          'aria-selected': isActive,
          className: cx('dmi-row'),
          onMouseEnter: () => {
            if (slot >= 0) setActive(sessionId, slot)
          },
          onClick: () => {
            pick(row)
          },
          style: {
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            padding: '7px 8px',
            borderRadius: T.radiusSm,
            cursor: 'pointer',
            background: isActive ? T.hover : 'transparent',
            boxShadow: isActive ? `inset 2px 0 0 ${T.brand}` : 'none',
          },
        },
        React.createElement(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
            React.createElement(
              'span',
              {
                style: {
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: T.label1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              React.createElement(Mark, { text: row.method.name, query: view.query }),
            ),
            isArmed
              ? React.createElement(
                'span',
                {
                  style: {
                    fontSize: 10,
                    fontWeight: 600,
                    color: T.brandText,
                    background: T.ghostFill,
                    borderRadius: 999,
                    padding: '1px 6px',
                    flex: '0 0 auto',
                  },
                },
                '已选',
              )
              : null,
            usedBefore && !isArmed
              ? React.createElement(
                'span',
                { style: { fontSize: 10, color: T.label3, flex: '0 0 auto' } },
                '上次用过',
              )
              : null,
          ),
          row.method.tagline === undefined
            ? null
            : React.createElement(
              'span',
              {
                style: {
                  fontSize: 11.5,
                  color: T.label2,
                  lineHeight: 1.35,
                  overflow: 'hidden',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                },
              },
              row.method.tagline,
            ),
        ),
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 4, flex: '0 0 auto' } },
          React.createElement(
            'button',
            {
              type: 'button',
              className: cx('dmi-btn'),
              title: '添加辅助条款（不关闭面板）',
              onMouseDown: (event: React.MouseEvent) => {
                event.preventDefault()
                event.stopPropagation()
              },
              onClick: (event: React.MouseEvent) => {
                event.stopPropagation()
                if (view.assistFor === row.method.id) {
                  setActive(sessionId, slot)
                  return
                }
                beginAssist(sessionId, row.method.id)
                setActive(sessionId, slot)
              },
              style: {
                height: 22,
                padding: '0 7px',
                borderRadius: T.radiusSm,
                border: `1px dashed ${view.assistFor === row.method.id ? T.ghostBorder : T.borderL2}`,
                background: view.assistFor === row.method.id ? T.ghostFill : 'transparent',
                color: view.assistFor === row.method.id ? T.brandText : T.label3,
                fontFamily: T.font,
                fontSize: 10.5,
                fontWeight: 500,
                lineHeight: 1,
                cursor: 'pointer',
              },
            },
            view.assistFor === row.method.id ? '− 辅助' : '+ 辅助',
          ),
        ),
      )
    }),
  )

  const footer = React.createElement(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 10px',
        borderTop: `1px solid ${T.borderL1}`,
        flex: '0 0 auto',
      },
    },
    React.createElement(
      'span',
      {
        style: {
          fontSize: 11,
          color: view.error === null ? T.label3 : T.error,
          flex: '1 1 auto',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        },
      },
      view.flash ?? view.error ?? (armed === null
        ? '选中即注入本轮'
        : `本轮：${armed.name}${armed.assists.length > 0 ? ` + ${String(armed.assists.length)} 辅助` : ''}`),
    ),
    view.assistFor === null
      ? null
      : React.createElement(
        'span',
        { style: { fontSize: 10.5, color: T.label3, flex: '0 0 auto' } },
        `${String(view.assistIds.length)}/${String(MAX_ASSISTS)}`,
      ),
    armed === null
      ? null
      : React.createElement(
        Btn,
        {
          tone: 'quiet',
          title: '取消本轮的方法论',
          children: '取消',
          disabled: view.busy,
          onClick: () => {
            void release(sessionId)
          },
        },
      ),
    React.createElement(
      'span',
      { style: { display: 'inline-flex', alignItems: 'center', gap: 4, flex: '0 0 auto' } },
      React.createElement(Kbd, { text: '↑↓', muted: true }),
      React.createElement(Kbd, { text: '↵', muted: true }),
      React.createElement(Kbd, { text: 'esc', muted: true }),
    ),
  )

  const notice = view.kbdNotice === null
    ? null
    : React.createElement(
      'div',
      {
        style: {
          padding: '6px 12px',
          fontSize: 10.5,
          lineHeight: 1.4,
          color: T.warn,
          background: T.warnBg,
          borderTop: `1px solid ${T.borderL1}`,
          flex: '0 0 auto',
        },
      },
      view.kbdNotice,
    )

  if (view.expanded) {
    // One card on a phone, two panes where there is room for the contract to sit
    // beside the list instead of below it.
    const narrow = typeof window !== 'undefined' && window.innerWidth < 760
    const preview = activeRow !== null && activeRow.kind === 'method' ? activeRow.method : null
    return React.createElement(
      'div',
      {
        'data-dmi-panel': sessionId,
        className: 'dmi-full',
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 1200,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: T.bgMask,
        },
        onMouseDown: (event: React.MouseEvent) => {
          if (event.target === event.currentTarget) close()
        },
      },
      React.createElement(
        'div',
        {
          role: 'dialog',
          'aria-modal': true,
          'aria-label': '方法论',
          style: {
            display: 'grid',
            gridTemplateColumns: narrow ? '1fr' : 'minmax(320px, 1.05fr) minmax(320px, 1fr)',
            gridTemplateRows: narrow ? 'minmax(0, 1fr) auto' : undefined,
            width: narrow ? 'min(520px, 96vw)' : 'min(920px, 94vw)',
            maxHeight: narrow ? '92vh' : '86vh',
            background: T.bgOverlay,
            border: `1px solid ${T.elevationStroke}`,
            borderRadius: T.radiusXl,
            boxShadow: T.elevation,
            overflow: 'hidden',
          },
        },
        React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              ...(narrow ? {} : { borderRight: `1px solid ${T.borderL1}` }),
            },
          },
          header,
          search,
          list,
          notice,
          footer,
        ),
        React.createElement(
          'div',
          { style: {
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            background: T.bgLayer1,
            ...(narrow ? { borderTop: `1px solid ${T.borderL1}`, maxHeight: '46vh' } : {}),
          } },
          React.createElement(
            'div',
            { style: { padding: '12px 16px 8px', display: 'flex', flexDirection: 'column', gap: 4 } },
            React.createElement(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              React.createElement(Star, { size: 12, color: T.brand }),
              React.createElement(
                'span',
                { style: { fontSize: 13, fontWeight: 600, color: T.label1 } },
                preview?.name ?? '选一个方法看契约',
              ),
              React.createElement('span', { style: { flex: 1 } }),
              React.createElement(Btn, {
                tone: 'primary',
                disabled: view.busy || preview === null,
                children: '应用并关闭',
                onClick: () => {
                  if (preview === null) return
                  pick({
                    kind: 'method',
                    key: `m:${preview.id}`,
                    method: preview,
                  })
                },
              }),
            ),
            React.createElement(
              'span',
              { style: { fontSize: 11, color: T.label3 } },
              preview === null ? '方法论会作为系统提示追加进本轮对话' : preview.tagline ?? '',
            ),
          ),
          React.createElement(
            'div',
            {
              className: cx('dmi-scroll'),
              style: {
                flex: '1 1 auto',
                minHeight: 0,
                overflowY: 'auto',
                padding: '4px 16px 16px',
                fontSize: 12,
                lineHeight: 1.65,
                color: T.label2,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              },
            },
            preview?.contract === undefined
              ? '该方法没有附带可直接展示的契约文本；Host 会在本轮注入时生成。'
              : readableContract(preview.contract),
          ),
        ),
      ),
    )
  }

  return React.createElement(
    'div',
    {
      'data-dmi-panel': sessionId,
      className: 'dmi-panel',
      role: 'dialog',
      'aria-label': '方法论',
      style: {
        position: 'fixed',
        left: box.left,
        bottom: box.bottom,
        width: box.width,
        maxHeight: box.maxHeight,
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        background: T.bgOverlay,
        border: `1px solid ${T.elevationStroke}`,
        borderRadius: T.radiusLg,
        boxShadow: T.elevationPanel,
        overflow: 'hidden',
        transformOrigin: 'bottom left',
      },
    },
    header,
    search,
    list,
    notice,
    footer,
  )
}

/** A 14px checkbox square drawn from tokens. */
function Box({ on }: { on: boolean }): React.ReactElement {
  return React.createElement(
    'span',
    {
      'aria-hidden': true,
      style: {
        width: 14,
        height: 14,
        borderRadius: 4,
        border: `1px solid ${on ? 'transparent' : T.borderL2}`,
        background: on ? T.brand : 'transparent',
        color: T.onPrimary,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 9,
        lineHeight: 1,
        flex: '0 0 auto',
      },
    },
    on ? '✓' : '',
  )
}
