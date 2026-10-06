// OWNER: ui-response agent. Read-only header table with copy actions.
import type { ComponentChildren } from 'preact';
import type { HeaderPair } from '../../shared/types';
import { copyText } from '../components/clipboard';
import { plural } from './body-model';
import { CopyButton, hasTextSelection } from './parts';

export interface HeadersTableProps {
  headers: HeaderPair[];
  /** Shown instead of the table when there are no headers. */
  emptyText?: string;
  /** Optional per-header tag (e.g. "not sent", "via DNR"); return null for none. */
  tagFor?(header: HeaderPair): { label: string; tone: 'warn' | 'info' } | null;
  /** Extra toolbar content. */
  toolbar?: ComponentChildren;
  testId?: string;
}

/** "Name: value" lines, as in a raw HTTP message. */
export function headersToText(headers: HeaderPair[]): string {
  return headers.map((h) => `${h.name}: ${h.value}`).join('\n');
}

/** Two-column table of headers (click a value to copy it) with a "Copy all" action. */
export function HeadersTable({ headers, emptyText = 'No headers.', tagFor, toolbar, testId }: HeadersTableProps) {
  if (headers.length === 0) {
    return (
      <div class="rl-resp-headers" data-testid={testId}>
        <div class="rl-empty rl-resp-headers__empty">{emptyText}</div>
      </div>
    );
  }
  return (
    <div class="rl-resp-headers" data-testid={testId}>
      <div class="rl-resp-headers__toolbar">
        <span class="rl-muted">{plural(headers.length, 'header')}</span>
        {toolbar}
        <span class="rl-spacer" />
        <CopyButton text={() => headersToText(headers)} label="Copy all" done="Copied headers" />
      </div>
      <table class="rl-table rl-resp-headers__table">
        <tbody>
          {headers.map((h, i) => {
            const tag = tagFor?.(h) ?? null;
            return (
              <tr key={`${i}:${h.name}`} class={tag?.tone === 'warn' ? 'rl-resp-headers__row--dropped' : undefined}>
                <th scope="row" class="rl-resp-headers__name rl-mono">
                  {h.name}
                  {tag && <span class={`rl-resp-tag rl-resp-tag--${tag.tone}`}>{tag.label}</span>}
                </th>
                <td class="rl-resp-headers__value rl-mono">
                  <span
                    class="rl-resp-headers__copy"
                    title="Click to copy value"
                    onClick={(e) => {
                      if (!hasTextSelection(e.currentTarget)) void copyText(h.value, `Copied ${h.name}`);
                    }}
                  >
                    {h.value}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
