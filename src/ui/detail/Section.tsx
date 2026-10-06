// OWNER: ui-editor agent. Collapsible editor section (Params / Headers / Body) with modified marker and revert.
import type { ComponentChildren } from 'preact';
import { Icon } from '../components/Icon';
import { cx, usePersistentToggle } from './util';

export interface SectionProps {
  /** Section id: used for the test id (`rl-section-<id>`) and to remember the collapsed state. */
  id: 'query' | 'headers' | 'body';
  title: string;
  /** Small count rendered after the title. */
  count?: ComponentChildren;
  modified: boolean;
  onRevert(): void;
  /** Controls right-aligned in the header (body type select, view toggle, ...). */
  actions?: ComponentChildren;
  /** Warning/error counts of this section (from draftWarnings). */
  issues?: { errors: number; warns: number };
  /**
   * The section has nothing to show (e.g. no query params): it starts collapsed to one line so the sections
   * below get the room (its open state is remembered separately from the non-empty one).
   */
  empty?: boolean;
  children: ComponentChildren;
}

export function Section(props: SectionProps) {
  const [openFull, setOpenFull] = usePersistentToggle(`section:${props.id}`, true);
  const [openEmpty, setOpenEmpty] = usePersistentToggle(`section:${props.id}:empty`, false);
  const open = props.empty ? openEmpty : openFull;
  const setOpen = props.empty ? setOpenEmpty : setOpenFull;
  const bodyId = `rl-ed-section-${props.id}`;
  const issues = props.issues;
  return (
    <section
      class={cx('rl-ed-section', props.modified && 'rl-ed-section--modified', !open && 'rl-ed-section--collapsed')}
      data-testid={`rl-section-${props.id}`}
      data-modified={String(props.modified)}
    >
      <header class="rl-ed-section__header">
        <button
          type="button"
          class="rl-ed-section__toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen()}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
          <span class="rl-ed-section__title">{props.title}</span>
          {props.count !== undefined && <span class="rl-ed-section__count">{props.count}</span>}
          {props.modified && <span class="rl-modified-dot" title="Modified" />}
        </button>
        {issues && issues.errors > 0 && (
          <span class="rl-ed-section__issue rl-ed-section__issue--error" title={`${issues.errors} error(s)`}>
            <Icon name="warning" size={12} />
            {issues.errors}
          </span>
        )}
        {issues && issues.errors === 0 && issues.warns > 0 && (
          <span class="rl-ed-section__issue" title={`${issues.warns} warning(s)`}>
            <Icon name="warning" size={12} />
            {issues.warns}
          </span>
        )}
        <span class="rl-spacer" />
        {open && props.actions}
        {props.modified && (
          <button
            type="button"
            class="rl-icon-btn rl-icon-btn--sm rl-ed-revert"
            data-testid="rl-section-revert"
            title={`Revert ${props.title.toLowerCase()} to the captured version`}
            aria-label={`Revert ${props.title}`}
            onClick={props.onRevert}
          >
            <Icon name="revert" size={13} />
          </button>
        )}
      </header>
      {open && (
        <div class="rl-ed-section__body" id={bodyId}>
          {props.children}
        </div>
      )}
    </section>
  );
}
