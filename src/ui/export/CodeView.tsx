// OWNER: ui-export agent. Read-only code / text block with token colouring (from highlight.ts), an optional
// line-number gutter and progressive rendering for very long outputs. Text is rendered as text nodes only.
import type { ComponentChildren } from 'preact';
import { useMemo } from 'preact/hooks';
import { memo } from '../components/memo';
import { ShowMore, usePageLimit } from '../response/parts';
import type { Line } from './highlight';

/** Lines rendered per "Show more" step. */
export const CODE_PAGE_LINES = 3000;

export interface CodeViewProps {
  lines: Line[];
  /** Accessible name of the scroll region. */
  label: string;
  /** Test id of the <code> element (its textContent is the shown text). */
  testId: string;
  /** Line numbers (code); off for prose. */
  gutter?: boolean;
  /** Soft-wrap long lines (prose). */
  wrap?: boolean;
  /** Extra data attribute for tests / styling (e.g. the format). */
  kind?: string;
}

function renderLines(lines: Line[]): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) out.push('\n');
    for (const tok of lines[i]!) out.push(tok.k ? <span class={`rl-tok rl-tok--${tok.k}`}>{tok.t}</span> : tok.t);
  }
  return out;
}

function gutterText(count: number): string {
  let s = '1';
  for (let i = 2; i <= count; i++) s += `\n${i}`;
  return s;
}

/** Scrollable, keyboard-focusable code block. */
export const CodeView = memo(function CodeView({ lines, label, testId, gutter, wrap, kind }: CodeViewProps) {
  const [limit, setLimit] = usePageLimit(lines, CODE_PAGE_LINES);
  const shownCount = Math.min(lines.length, limit);
  const body = useMemo(() => renderLines(lines.length > limit ? lines.slice(0, limit) : lines), [lines, limit]);
  const numbers = useMemo(() => (gutter ? gutterText(shownCount) : ''), [gutter, shownCount]);
  return (
    <div class={`rl-code rl-scroll${wrap ? ' rl-code--wrap' : ''}`} role="region" aria-label={label} tabIndex={0}>
      <div class="rl-code__inner">
        {gutter ? (
          <div class="rl-code__gutter rl-mono" aria-hidden="true">
            {numbers}
          </div>
        ) : null}
        <pre class="rl-code__pre rl-mono">
          <code data-testid={testId} data-kind={kind}>
            {body}
          </code>
        </pre>
      </div>
      {lines.length > limit ? (
        <ShowMore
          status={`Showing ${limit.toLocaleString()} of ${lines.length.toLocaleString()} lines`}
          onMore={() => setLimit(limit + CODE_PAGE_LINES)}
          onAll={() => setLimit(Number.POSITIVE_INFINITY)}
        />
      ) : null}
    </div>
  );
});
