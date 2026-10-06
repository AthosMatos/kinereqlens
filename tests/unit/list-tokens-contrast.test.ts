// Informational text (query preview, host, durations, sizes, counts) uses --rl-text-faint / --rl-text-muted at
// 11-12px: both must reach WCAG AA (4.5:1) on every surface the list, the rail, the header and the editor use, in both
// themes. The avatar-style tints of method badges and status pills, accent text and the filled buttons must too.
import { describe, expect, it } from 'vitest';

// node:fs is typed locally and imported through a non-literal specifier (the unit tsconfig has no Node types;
// vitest's CSS handling would turn a direct stylesheet import into an empty string).
type FsModule = { readFileSync(path: URL, encoding: 'utf8'): string };
const fsSpecifier = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ fsSpecifier)) as FsModule;
const css = readFileSync(new URL('../../src/ui/styles/tokens.css', import.meta.url), 'utf8');

function themeTokens(theme: 'light' | 'dark'): Record<string, string> {
  const block = new RegExp(`\\.rl-root\\[data-theme='${theme}'\\]\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  const tokens: Record<string, string> = {};
  for (const m of block.matchAll(/--(rl-[\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)) tokens[m[1]!] = m[2]!;
  return tokens;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

/** Every `[text, surface]` pair reaches `min`. */
function expectPairs(theme: 'light' | 'dark', pairs: ReadonlyArray<readonly [string, string]>, min = 4.5): void {
  const t = themeTokens(theme);
  for (const [text, surface] of pairs) {
    expect(t[text] && t[surface], `${theme}: ${text} / ${surface} defined as #rrggbb`).toBeTruthy();
    expect(contrast(t[text]!, t[surface]!), `${theme} ${text} on ${surface}`).toBeGreaterThanOrEqual(min);
  }
}

const SURFACES = ['rl-bg', 'rl-bg-elev', 'rl-bg-sunken', 'rl-bg-hover', 'rl-header-bg', 'rl-rail-bg', 'rl-sidebar-bg', 'rl-list-hover', 'rl-list-sel'];
const TINTS = ['green', 'blue', 'purple', 'red', 'amber', 'neutral'];

describe('text tokens contrast', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`${theme}: faint and muted text reach 4.5:1 on every base, rail, header and list surface`, () => {
      expectPairs(
        theme,
        ['rl-text-faint', 'rl-text-muted', 'rl-text'].flatMap((text) => SURFACES.map((surface) => [text, surface] as const)),
      );
    });

    it(`${theme}: method badges and status pills (avatar tints) keep their text at 4.5:1`, () => {
      expectPairs(
        theme,
        TINTS.map((tint) => [`rl-tint-${tint}-fg`, `rl-tint-${tint}-bg`] as const),
      );
    });

    it(`${theme}: accent and status text, filled buttons and accent chips reach 4.5:1`, () => {
      expectPairs(theme, [
        ...['rl-bg', 'rl-bg-elev', 'rl-sidebar-bg', 'rl-list-sel', 'rl-accent-soft', 'rl-rail-active'].map((s) => ['rl-accent', s] as const),
        ['rl-accent-fill-text', 'rl-accent-fill'],
        ['rl-accent-contrast', 'rl-accent'],
        ...['rl-ok', 'rl-warn', 'rl-danger'].flatMap((text) => ['rl-bg', 'rl-bg-elev', 'rl-sidebar-bg', 'rl-list-sel'].map((s) => [text, s] as const)),
        ...['rl-m-get', 'rl-m-post', 'rl-m-put', 'rl-m-patch', 'rl-m-delete', 'rl-m-other'].map((text) => [text, 'rl-bg'] as const),
      ]);
    });
  }
});
