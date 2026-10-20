/**
 * Visual system of the methodology surfaces.
 *
 * Two rules, both from the probe:
 *  1. every colour comes from a `--dsw-alias-*` / `--dsw-elevation-*` token, so
 *     light and dark themes follow without a second stylesheet;
 *  2. layout, type and geometry live in inline styles at the call site.
 *
 * What cannot be inline — `@keyframes`, `:hover`, `:focus-visible`, scrollbars,
 * and the `prefers-reduced-motion` opt-out — is the small stylesheet below,
 * injected once and removed with the plugin. It is NOT a `.module.css`: class
 * names are literal, hashing-free and namespaced under `dmi-`.
 *
 * @module dsh-methodology-injection/client/styles
 */

/** Design tokens, spelled once so no component reaches into CSS by hand. */
export const T = {
  label1: 'var(--dsw-alias-label-primary)',
  label2: 'var(--dsw-alias-label-secondary)',
  label3: 'var(--dsw-alias-label-tertiary)',
  caption: 'var(--dsw-alias-label-caption)',
  onPrimary: 'var(--dsw-alias-label-primary-foreground)',
  bgOverlay: 'var(--dsw-alias-bg-overlay)',
  bgLayer1: 'var(--dsw-alias-bg-layer-1)',
  bgLayer2: 'var(--dsw-alias-bg-layer-2)',
  bgLayer3: 'var(--dsw-alias-bg-layer-3)',
  bgMask: 'var(--dsw-alias-bg-mask-2)',
  borderL1: 'var(--dsw-alias-border-l1)',
  borderL2: 'var(--dsw-alias-border-l2)',
  borderL3: 'var(--dsw-alias-border-l3)',
  brand: 'var(--dsw-alias-brand-primary)',
  brandText: 'var(--dsw-alias-brand-text)',
  ghostFill: 'var(--dsw-alias-button-ghost-active-fill)',
  ghostBorder: 'var(--dsw-alias-button-ghost-active-border)',
  primaryFill: 'var(--dsw-alias-button-primary-fill)',
  primaryHover: 'var(--dsw-alias-button-primary-hover)',
  hover: 'var(--dsw-alias-interactive-bg-hover)',
  activeBg: 'var(--dsw-alias-interactive-bg-active)',
  error: 'var(--dsw-alias-state-error-primary)',
  warn: 'var(--dsw-alias-state-warn-label)',
  warnBg: 'var(--dsw-alias-state-warn-tertiary, var(--dsw-alias-bg-layer-3))',
  ok: 'var(--dsw-alias-state-success-primary)',
  elevation: 'var(--dsw-elevation-prominent)',
  elevationPanel: 'var(--dsw-elevation-panel)',
  elevationStroke: 'var(--dsw-elevation-stroke-color, var(--dsw-alias-border-l1))',
  radiusSm: 'var(--dsw-radius-sm)',
  radiusMd: 'var(--dsw-radius-md)',
  radiusLg: 'var(--dsw-radius-lg)',
  radiusXl: 'var(--dsw-radius-xl)',
  focusRing: 'var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary))',
  font: 'var(--dsw-font-family)',
} as const

/** The injected stylesheet id; the loader removes plugin-owned tags on unload. */
const STYLE_ID = 'dsh-methodology-injection'

/** Rules that cannot be expressed with a `style` attribute. */
const SHEET = `
.dmi-chip{transition:background-color .16s ease,border-color .16s ease,color .16s ease,transform .16s ease}
.dmi-chip:hover{background:${T.hover}}
.dmi-chip:active{background:${T.activeBg}}
.dmi-chip:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid ${T.focusRing};outline-offset:2px}
.dmi-chip[data-pulse]{animation:dmi-pulse .52s cubic-bezier(.2,.9,.2,1) 1}
.dmi-chip[data-armed]{border-color:transparent}
.dmi-btn{transition:background-color .14s ease,color .14s ease,border-color .14s ease,opacity .14s ease}
.dmi-btn:hover{background:${T.hover}}
.dmi-btn:active{background:${T.activeBg}}
.dmi-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid ${T.focusRing};outline-offset:2px}
.dmi-btn[data-tone="primary"]:hover{background:${T.primaryHover}}
.dmi-row{transition:background-color .1s linear}
.dmi-row:hover{background:${T.hover}}
.dmi-row:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid ${T.focusRing};outline-offset:-2px}
.dmi-panel{animation:dmi-rise .16s cubic-bezier(.22,.8,.24,1) 1}
.dmi-full{animation:dmi-fade .18s ease 1}
.dmi-mark{background:${T.ghostFill};color:${T.brandText};border-radius:3px;padding:0 1px}
.dmi-scroll{scrollbar-width:thin}
.dmi-scroll::-webkit-scrollbar{width:8px;height:8px}
.dmi-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border-radius:999px}
.dmi-scroll::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2)}
.dmi-scroll::-webkit-scrollbar-track{background:transparent}
@keyframes dmi-rise{from{opacity:0;transform:translateY(6px) scale(.995)}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes dmi-fade{from{opacity:0}to{opacity:1}}
@keyframes dmi-pulse{0%{transform:scale(1)}38%{transform:scale(1.075)}100%{transform:scale(1)}}
@keyframes dmi-sweep{0%{background-position:0% 50%}100%{background-position:200% 50%}}
@media (prefers-reduced-motion: reduce){
  .dmi-panel,.dmi-full,.dmi-chip[data-pulse]{animation:none}
  .dmi-chip,.dmi-btn,.dmi-row{transition:none}
}
`

/** Inject the sheet once, and hand back the remover. */
export function injectStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.querySelector(`style[data-dsh-plugin-css="${STYLE_ID}"]`)
  if (existing !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.dshPluginCss = STYLE_ID
  style.textContent = SHEET
  document.head.appendChild(style)
  return () => {
    style.remove()
  }
}

/** Join class names, dropping empty ones. */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter((name): name is string => typeof name === 'string' && name.length > 0).join(' ')
}

/** A hairline that stays crisp on every display density. */
export const HAIRLINE = '1px solid'

/** Shorthand for the elevation shadow used by floating cards. */
export const FLOAT_SHADOW = T.elevation
