/**
 * Seam for reading the composer draft — deliberately **not implemented** in T2.
 *
 * Why it exists now: `/recommend` (suggest a method for what the user is typing) and
 * `polish` (rewrite the draft) both need the current draft text, but the Host cannot
 * read the composer from the server side. The client half owns `props.useInput`, so a
 * future client build is expected to push the draft (or answer a Host pull).
 *
 * Shape chosen so nothing here leaks into the T2 injection path:
 *  - optional: the plugin must work with no draft source at all;
 *  - read-only: the Host never writes the draft (T3 confirmed `useInput` is read-only);
 *  - failure-tolerant: a throwing source must never break a request.
 *
 * `null` means "no source wired yet", which is the shipped state. Any consumer must
 * treat `canReadDraft() === false` as "recommend/polish unavailable", not as an error.
 */
export interface DraftSource {
  /** Current draft text for one session, or `undefined` when it is unavailable. */
  read(sessionId: string): string | undefined
}

let source: DraftSource | undefined

/** Wire (or clear) the draft source. Called by whichever half can supply it. */
export function setDraftSource(next: DraftSource | undefined): void {
  source = next
}

/** Whether a draft source is wired. Consumers must check this before offering UI. */
export function canReadDraft(): boolean {
  return source !== undefined
}

/** Read the draft, swallowing source failures. Not used by any T2 route. */
export function readDraft(sessionId: string): string | undefined {
  if (source === undefined) return undefined
  try {
    return source.read(sessionId)
  } catch {
    return undefined
  }
}
