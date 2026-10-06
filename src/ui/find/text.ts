// Find in page, panel side: wording (pure, unit-tested).
import type { FindResult } from '../../shared/find-protocol';
import type { FindSnapshot } from './controller';

/** Display state of a value's locate icon. */
export type FindIconState = 'visible' | 'attr' | 'hidden' | 'common';

export function findIconState(r: FindResult): FindIconState {
  if (r.common) return 'common';
  if (r.visible === 0) return 'hidden';
  return r.attrOnly ? 'attr' : 'visible';
}

function times(r: FindResult): string {
  return `${r.total.toLocaleString('en-US')}${r.more ? '+' : ''}×`;
}

/** Tooltip of a locate icon: "Found 3× on the page (2 visible)", "Only found in a link / image URL"… */
export function findTooltip(r: FindResult): string {
  if (r.common) return `Found ${times(r)} on the page — too common to show one`;
  if (r.attrOnly) {
    return r.visible > 0
      ? `Only found in a link / image URL (${times(r)}) — click to show it`
      : `Only found in a link / image URL (${times(r)}), not visible right now`;
  }
  const as = r.confidence < 3 && r.as ? ` as “${r.as}”` : '';
  if (r.visible === 0) return `Found ${times(r)} on the page${as}, none visible right now`;
  return `Found ${times(r)} on the page (${r.visible} visible)${as} — click to show it`;
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

/** Status line of the JSON viewer's toolbar: "Find in page: 12 values found". */
export function findStatusText(s: FindSnapshot, enabled: boolean): string {
  if (!enabled) return 'Find in page: off';
  if (s.phase === 'error') return 'Find in page: unavailable';
  if (s.phase === 'idle') return 'Find in page';
  if (s.phase === 'scanning' && s.found === 0) return 'Find in page: scanning…';
  return `Find in page: ${s.found === 0 ? 'no values found' : `${plural(s.found, 'value')} found`}`;
}

/** Tooltip of the status line: what was searched and how. */
export function findStatusTitle(s: FindSnapshot, enabled: boolean): string {
  if (!enabled) return 'Find in page is off: turn it on to see which response values the page shows';
  if (s.phase === 'error') return s.error ?? 'Find in page is not available on this page';
  const lines = [`Looks for the ${plural(s.searched, 'distinct value')} of this response on the page (text, form values, link and image URLs).`];
  if (s.dropped > 0) lines.push(`${plural(s.dropped, 'more value')} not searched (only the first ${s.searched.toLocaleString('en-US')}: strings, then numbers, then dates).`);
  if (s.stats) {
    if (s.stats.locales.length) lines.push(`Numbers and dates formatted as in ${s.stats.locales.join(', ')}.`);
    if (s.stats.truncated) lines.push('The page has a lot of text: only the first 5 MB were searched.');
  }
  lines.push('Updates while the page changes.');
  return lines.join('\n');
}
