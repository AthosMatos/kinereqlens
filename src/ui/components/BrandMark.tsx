// kineReqLens brand mark (same design as the extension icon: scripts/gen-icons.mjs) and wordmark.
// Kinebot palette: blue square, white lens ring, the green dot-and-line of the "o" in "kinebot" and the amber
// stroke + dot of its "k" as the lens handle. Fixed brand colours (not currentColor) on purpose.

export function BrandMark({ size = 16, class: className }: { size?: number; class?: string }) {
  return (
    <svg
      class={className ? `rl-brand-mark ${className}` : 'rl-brand-mark'}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="rl-brand-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#2a4de0" />
          <stop offset="1" stop-color="#122cb0" />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="31" height="31" rx="7" fill="url(#rl-brand-bg)" />
      <circle cx="14" cy="14" r="8" fill="rgba(255,255,255,0.14)" stroke="#fff" stroke-width="2.6" />
      <path d="M14 14h7" stroke="#1bb852" stroke-width="1.8" stroke-linecap="round" />
      <circle cx="14" cy="14" r="3" fill="#1bb852" />
      <path d="M19.9 19.9 24.3 24.3" stroke="#f2ae1f" stroke-width="3.6" stroke-linecap="round" />
      <circle cx="24.3" cy="24.3" r="3.1" fill="#f2ae1f" />
    </svg>
  );
}

/** "kine" in graphite + "ReqLens" in Kinebot blue (theme-aware via tokens). */
export function BrandWordmark({ class: className }: { class?: string }) {
  return (
    <span class={className ? `rl-wordmark ${className}` : 'rl-wordmark'} aria-label="kineReqLens">
      <span class="rl-wordmark__kine" aria-hidden="true">kine</span>
      <span class="rl-wordmark__name" aria-hidden="true">ReqLens</span>
    </span>
  );
}
