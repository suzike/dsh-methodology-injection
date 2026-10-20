/** Conservative token estimate, identical to `scripts/validate-catalog.mjs`. */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    const isWide =
      (cp >= 0x3000 && cp <= 0x303f) || // CJK punctuation
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) || // Han
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xff00 && cp <= 0xffef) || // full width
      (cp >= 0x2000 && cp <= 0x206f) // general punctuation (… — etc.)
    if (isWide) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

/** Visible length in code points, used for diagnostics only. */
export function charLength(text: string): number {
  let n = 0
  for (const _ of text) n += 1
  return n
}
