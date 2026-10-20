/**
 * The global keyboard layer: one document listener pair for ⌘K / ⌘⇧M and the
 * Escape cascade.
 *
 * ⌘K is claimed only if nobody else handled the keystroke. The first press is a
 * probe: it is allowed to dispatch untouched, and `defaultPrevented` is read one
 * macrotask later — after every later-phase listener in the shell has run. A hit
 * means DSH already owns ⌘K, so the picker moves to ⌘⇧M for good (persisted) and
 * the hint bar explains why; a miss claims ⌘K from then on.
 *
 * Escape is handled in the capture phase and only while the picker is open, so
 * the topmost layer is the only thing close: full-window → anchored → gone.
 * Our handler stops propagation, because a layer above the composer must not
 * also let the composer's Escape run.
 *
 * @module dsh-methodology-injection/client/shortcuts
 */

import {
  closePanel,
  focused,
  get,
  noteKbdConflict,
  openPanel,
  setExpanded,
  sinceClosed,
} from './store'

/** A close followed by a stray key event inside this window is ignored. */
const REOPEN_GUARD_MS = 180

/** Module-level guard so a second `apply` cannot double-bind the document. */
let installed = false

/** Whether ⌘K has been proven free and is now claimed by this plugin. */
let claimed = false

/** True for `Mod+<key>` with no Alt, the shape DSH itself uses. */
function isMod(event: KeyboardEvent, key: string): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === key
}

/**
 * Bind the layer.
 * @returns a disposer that unbinds it (plugin unload).
 */
export function installShortcuts(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (installed) return () => {}
  installed = true

  /** The ⌘K keystroke currently awaiting its post-dispatch verdict. */
  let probe: KeyboardEvent | null = null

  const openFor = (sessionId: string): void => {
    const view = get(sessionId)
    if (view.panel) return
    if (sinceClosed() < REOPEN_GUARD_MS) return
    openPanel(sessionId)
  }

  const onKeyDownCapture = (event: KeyboardEvent): void => {
    // An IME owns Escape while composing; never steal it.
    if (event.isComposing || event.keyCode === 229) return
    const sessionId = focused()
    if (sessionId === null) return
    const view = get(sessionId)

    if (event.key === 'Escape' && view.panel) {
      event.preventDefault()
      event.stopPropagation()
      if (view.expanded) setExpanded(sessionId, false)
      else closePanel(sessionId)
      return
    }

    if (isMod(event, 'm') && event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
      if (view.panel) closePanel(sessionId)
      else openFor(sessionId)
      return
    }

    if (!isMod(event, 'k') || event.shiftKey) return
    if (view.kbd === 'meta+shift+m') {
      // We already lost ⌘K to DSH: leave the keystroke alone.
      return
    }
    if (claimed) {
      event.preventDefault()
      event.stopPropagation()
      openFor(sessionId)
      return
    }
    probe = event
  }

  const onKeyDownBubble = (): void => {
    const event = probe
    probe = null
    if (event === null) return
    const sessionId = focused()
    if (sessionId === null) return
    // Wait for the whole dispatch (window-phase listeners included) to finish.
    setTimeout(() => {
      if (event.defaultPrevented) {
        noteKbdConflict(sessionId, '⌘K 已被 DSH 的快捷键占用，方法论改用 ⌘⇧M（点击提示条可关闭）')
        return
      }
      claimed = true
      openFor(sessionId)
    }, 0)
  }

  document.addEventListener('keydown', onKeyDownCapture, true)
  document.addEventListener('keydown', onKeyDownBubble)

  return () => {
    installed = false
    claimed = false
    document.removeEventListener('keydown', onKeyDownCapture, true)
    document.removeEventListener('keydown', onKeyDownBubble)
  }
}
