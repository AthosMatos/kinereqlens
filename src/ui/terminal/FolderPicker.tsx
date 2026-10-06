// The terminal's new-session form (docs/CLAUDE_INTEGRATION.md "Working directory"): pick the folder Claude Code
// starts in without typing paths — the OS-native chooser ("Choose folder…"), an inline folder browser
// (breadcrumbs, Home, Up, sub-folders with git / project badges, type-to-filter, hidden folders toggle), recent
// folders and detected git projects as quick picks, and a small "type a path" fallback. Folder names come from
// the hub (fsClient.ts); nothing is read until the user opens this form.
//
// Keyboard (folder list): ↑/↓ Home/End PageUp/PageDown move, → or double-click opens, ← / Backspace goes up,
// Enter starts Claude in the highlighted folder (or the current one), typing filters, Esc clears the filter.
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { FsEntry } from '../../shared/claude-protocol';
import { Icon } from '../components/Icon';
import { baseName, childPath, filterEntries, homeBreadcrumbs, parentOfTyped, tildePath } from './folders';
import type { PathSep } from './folders';
import { FsRequestError, folderClient } from './fsClient';
import type { FsClient, FsListing, FsProjects } from './fsClient';
import { dirLabel } from './store';

export interface FolderPickerProps {
  recentDirs: readonly string[];
  /** Why the last start failed, with its folder (shown again). */
  failed: { cwd: string; error: string } | null;
  /** Focus the folder list on mount. */
  autoFocus: boolean;
  /** Start Claude in `dir` — called inside the click / key handler. Returns an error, or null. */
  onStart(dir: string): string | null;
  /** Tests / stories. */
  client?: FsClient;
  /** Form heading (default "Start Claude Code in…"). */
  heading?: string;
  /** Submit button label (default "Start Claude here"). */
  actionLabel?: string;
}

/** Remembered while the panel lives: where the browser was, and the hidden folders toggle. */
const memory: { path: string | null; showHidden: boolean } = { path: null, showHidden: false };

/** Rows a PageUp / PageDown moves. */
const PAGE = 10;
const PROJECT_ROOTS_HINT = '~/Documents, ~/Projects, ~/dev, ~/code, ~/src, ~/GitHub';

type ProjectsState = { state: 'idle' } | { state: 'loading' } | { state: 'done'; result: FsProjects } | { state: 'error'; error: string };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function optionId(index: number): string {
  return `rl-fp-opt-${index}`;
}

export function FolderPicker({ recentDirs, failed, autoFocus, onStart, client: injected, heading = 'Start Claude Code in…', actionLabel = 'Start Claude here' }: FolderPickerProps) {
  const client = injected ?? folderClient();
  const [listing, setListing] = useState<FsListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [showHidden, setShowHidden] = useState(memory.showHidden);
  const [active, setActive] = useState<string | null>(null);
  const [typed, setTyped] = useState(() => failed?.cwd ?? '');
  const [error, setError] = useState<string | null>(failed?.error ?? null);
  const [picking, setPicking] = useState(false);
  const [projects, setProjects] = useState<ProjectsState>(() => (client.cachedProjects ? { state: 'done', result: client.cachedProjects } : { state: 'idle' }));
  const listRef = useRef<HTMLDivElement>(null);
  const crumbsRef = useRef<HTMLElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const navSeq = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!failed) return;
    setTyped(failed.cwd);
    setError(failed.error);
  }, [failed]);

  const sep: PathSep = listing?.sep ?? '/';
  const home = listing?.home ?? null;
  const visible = useMemo(() => (listing ? filterEntries(listing.entries, filter, showHidden) : []), [listing, filter, showHidden]);
  const hiddenCount = useMemo(() => (listing ? listing.entries.filter((e) => e.hidden).length : 0), [listing]);
  const activeIndex = active === null ? -1 : visible.findIndex((e) => e.name === active);
  const typedPath = typed.trim();
  const target = typedPath || (listing ? (activeIndex >= 0 ? childPath(listing.path, visible[activeIndex]!.name, sep) : listing.path) : '');

  /** Browse to `path` (highlighting `highlight` when present). */
  const go = (path: string, options: { highlight?: string | null; keepTyped?: boolean; focusList?: boolean } = {}): void => {
    const seq = ++navSeq.current;
    setLoading(true);
    client.list(path).then(
      (next) => {
        if (!alive.current || seq !== navSeq.current) return;
        memory.path = next.path;
        setListing(next);
        setFilter('');
        setActive(options.highlight && next.entries.some((e) => e.name === options.highlight) ? options.highlight : null);
        setBrowseError(null);
        setUnavailable(null);
        setLoading(false);
        if (!options.keepTyped) {
          setTyped('');
          setError(null);
        }
        if (options.focusList) listRef.current?.focus({ preventScroll: true });
      },
      (err: unknown) => {
        if (!alive.current || seq !== navSeq.current) return;
        setLoading(false);
        if (err instanceof FsRequestError && err.unavailable) setUnavailable(err.message);
        else setBrowseError(errorText(err));
      },
    );
  };

  // First listing: where this panel browsed last, else next to the most recent folder, else home.
  useEffect(() => {
    const recent = recentDirs[0];
    const start = memory.path ?? (recent ? parentOfTyped(recent) : null) ?? '~';
    const highlight = memory.path ? null : recent ? baseName(recent) : null;
    go(start, { highlight, keepTyped: true });
    if (autoFocus) listRef.current?.focus({ preventScroll: true });
  }, []);

  // A failed first listing of a remembered / recent folder: try home instead (once).
  const triedHome = useRef(false);
  useEffect(() => {
    if (!browseError || listing || triedHome.current) return;
    triedHome.current = true;
    go('~', { keepTyped: true });
  }, [browseError, listing]);

  // Long paths: keep the current folder (last breadcrumb) in view.
  useEffect(() => {
    const el = crumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [listing?.path]);

  // Keep the highlighted row visible.
  useEffect(() => {
    if (activeIndex < 0) return;
    const row = listRef.current?.querySelector<HTMLElement>(`#${optionId(activeIndex)}`);
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, listing]);

  const start = (dir: string): void => {
    const trimmed = dir.trim();
    if (!trimmed) {
      setError('Choose a folder first');
      return;
    }
    setError(onStart(trimmed));
  };

  const highlight = (name: string | null): void => {
    setActive(name);
    if (typed) setTyped('');
    setError(null);
  };

  const enter = (entry: FsEntry): void => {
    if (!listing) return;
    go(childPath(listing.path, entry.name, sep), { focusList: true });
  };

  const up = (): void => {
    if (!listing?.parent) return;
    go(listing.parent, { highlight: baseName(listing.path), focusList: true });
  };

  const changeFilter = (value: string): void => {
    setFilter(value);
    const next = listing ? filterEntries(listing.entries, value, showHidden) : [];
    if (value.trim()) setActive(next[0]?.name ?? null);
    else if (active !== null && !next.some((e) => e.name === active)) setActive(null);
  };

  const toggleHidden = (): void => {
    const next = !showHidden;
    memory.showHidden = next;
    setShowHidden(next);
    if (!next && active?.startsWith('.') && !filter.trim().startsWith('.')) setActive(null);
  };

  const pick = (): void => {
    if (picking) return;
    setPicking(true);
    setBrowseError(null);
    // Inside the click: the client checks the user activation before the request leaves the panel.
    client.pick(listing?.path ?? (typedPath || undefined)).then(
      (path) => {
        if (!alive.current) return;
        setPicking(false);
        if (path) go(path, { focusList: true });
      },
      (err: unknown) => {
        if (!alive.current) return;
        setPicking(false);
        setBrowseError(errorText(err));
      },
    );
  };

  const findProjects = (refresh: boolean): void => {
    setProjects({ state: 'loading' });
    client.projects(refresh).then(
      (result) => alive.current && setProjects({ state: 'done', result }),
      (err: unknown) => alive.current && setProjects({ state: 'error', error: errorText(err) }),
    );
  };

  /** Keys shared by the filter field and the list. Returns true when handled. */
  const navKey = (e: JSX.TargetedKeyboardEvent<HTMLElement>): boolean => {
    const count = visible.length;
    const move = (index: number): void => {
      if (!count) return;
      highlight(visible[Math.max(0, Math.min(count - 1, index))]!.name);
    };
    switch (e.key) {
      case 'ArrowDown':
        move(activeIndex < 0 ? 0 : activeIndex + 1);
        return true;
      case 'ArrowUp':
        move(activeIndex < 0 ? count - 1 : activeIndex - 1);
        return true;
      case 'PageDown':
        move(activeIndex < 0 ? PAGE - 1 : activeIndex + PAGE);
        return true;
      case 'PageUp':
        move(activeIndex < 0 ? 0 : activeIndex - PAGE);
        return true;
      case 'Enter':
        start(target);
        return true;
      case 'Escape':
        if (filter) {
          changeFilter('');
          return true;
        }
        if (active !== null) {
          setActive(null);
          return true;
        }
        return false;
      default:
        return false;
    }
  };

  const onListKey = (e: JSX.TargetedKeyboardEvent<HTMLDivElement>): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (navKey(e)) {
      e.preventDefault();
      return;
    }
    const entry = activeIndex >= 0 ? visible[activeIndex] : undefined;
    switch (e.key) {
      case 'Home':
        if (visible.length) highlight(visible[0]!.name);
        break;
      case 'End':
        if (visible.length) highlight(visible[visible.length - 1]!.name);
        break;
      case 'ArrowRight':
        if (entry) enter(entry);
        break;
      case 'ArrowLeft':
        up();
        break;
      case 'Backspace':
        if (filter) changeFilter(filter.slice(0, -1));
        else up();
        break;
      default:
        // Type to filter (the list keeps the focus, so the keys above keep working).
        if (e.key.length === 1 && e.key !== ' ') {
          changeFilter(filter + e.key);
          break;
        }
        return;
    }
    e.preventDefault();
  };

  const onFilterKey = (e: JSX.TargetedKeyboardEvent<HTMLInputElement>): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (navKey(e)) {
      e.preventDefault();
      return;
    }
    // → at the end of the text opens the highlighted folder.
    const input = e.currentTarget;
    const entry = activeIndex >= 0 ? visible[activeIndex] : undefined;
    if (e.key === 'ArrowRight' && entry && input.selectionStart === input.value.length && input.selectionEnd === input.value.length) {
      e.preventDefault();
      enter(entry);
    }
  };

  const crumbs = listing ? homeBreadcrumbs(listing.path, sep, home) : [];
  const shownTarget = target ? (typedPath ? typedPath : tildePath(target, home, sep)) : '';

  return (
    <form
      class="rl-term__form rl-fp"
      data-testid="rl-claude-terminal-form"
      onSubmit={(e) => {
        e.preventDefault();
        start(target);
      }}
    >
      <div class="rl-fp__head">
        <div class="rl-term__form-title">
          <Icon name={actionLabel === 'Start Claude here' ? 'terminal' : 'folder'} size={14} />
          {heading}
        </div>
        <span class="rl-spacer" />
        <button
          type="button"
          class="rl-btn rl-btn--sm"
          data-testid="rl-claude-fp-pick"
          disabled={picking}
          title="Open your system’s folder chooser"
          onClick={pick}
        >
          {picking ? <span class="rl-spinner rl-fp__spinner" aria-hidden="true" /> : <Icon name="folder" size={12} />}
          {picking ? 'Waiting for the folder chooser…' : 'Choose folder…'}
        </button>
      </div>

      <div class="rl-fp__grid">
        <section class="rl-fp__browser" aria-label="Folder browser" data-testid="rl-claude-fp-browser">
          <div class="rl-fp__nav">
            <button
              type="button"
              class="rl-icon-btn rl-icon-btn--sm"
              title="Home folder"
              aria-label="Home folder"
              data-testid="rl-claude-fp-home"
              onClick={() => go('~', { focusList: true })}
            >
              <Icon name="home" size={13} />
            </button>
            <button
              type="button"
              class="rl-icon-btn rl-icon-btn--sm"
              title="Up one folder (←)"
              aria-label="Up one folder"
              data-testid="rl-claude-fp-up"
              disabled={!listing?.parent}
              onClick={up}
            >
              <Icon name="arrow-up" size={13} />
            </button>
            <nav ref={crumbsRef} class="rl-fp__crumbs" aria-label="Current folder" data-testid="rl-claude-fp-path" data-path={listing?.path ?? ''}>
              {crumbs.map((crumb, i) => {
                const last = i === crumbs.length - 1;
                return (
                  <span class="rl-fp__crumb-wrap" key={crumb.path}>
                    {i > 0 && !(i === 1 && crumbs[0]!.label === '/') ? <Icon name="chevron-right" size={10} class="rl-fp__crumb-sep" /> : null}
                    <button
                      type="button"
                      class={`rl-fp__crumb${last ? ' rl-fp__crumb--current' : ''}`}
                      data-testid="rl-claude-fp-crumb"
                      data-path={crumb.path}
                      aria-current={last ? 'location' : undefined}
                      title={crumb.path}
                      onClick={() => (last ? highlight(null) : go(crumb.path, { highlight: crumbs[i + 1]?.label ?? null, focusList: true }))}
                    >
                      {crumb.label}
                    </button>
                  </span>
                );
              })}
            </nav>
            <button
              type="button"
              class="rl-icon-btn rl-icon-btn--sm"
              title="Reload this folder"
              aria-label="Reload this folder"
              data-testid="rl-claude-fp-refresh"
              disabled={!listing}
              onClick={() => listing && go(listing.path, { highlight: active, keepTyped: true })}
            >
              <Icon name="reload" size={12} />
            </button>
            <button
              type="button"
              class="rl-icon-btn rl-icon-btn--sm"
              title={showHidden ? 'Hide hidden folders' : `Show hidden folders${hiddenCount ? ` (${hiddenCount})` : ''}`}
              aria-label="Show hidden folders"
              aria-pressed={showHidden ? 'true' : 'false'}
              data-testid="rl-claude-fp-hidden"
              onClick={toggleHidden}
            >
              <Icon name="eye" size={13} />
            </button>
          </div>
          <div class="rl-fp__filter">
            <Icon name="search" size={12} />
            <input
              ref={filterRef}
              type="text"
              class="rl-fp__filter-input"
              placeholder="Filter folders"
              aria-label="Filter folders"
              aria-controls="rl-fp-list"
              spellcheck={false}
              autocomplete="off"
              data-testid="rl-claude-fp-filter"
              value={filter}
              onInput={(e) => changeFilter(e.currentTarget.value)}
              onKeyDown={onFilterKey}
            />
            {listing ? (
              <span class="rl-faint rl-fp__count" data-testid="rl-claude-fp-count">
                {filter ? `${visible.length} of ` : ''}
                {listing.entries.length - (showHidden ? 0 : hiddenCount)}
                {listing.truncated ? '+' : ''}
              </span>
            ) : null}
          </div>
          <div
            ref={listRef}
            id="rl-fp-list"
            class="rl-fp__list"
            role="listbox"
            tabIndex={0}
            aria-label={listing ? `Folders in ${listing.path}` : 'Folders'}
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            aria-busy={loading ? 'true' : 'false'}
            data-testid="rl-claude-fp-list"
            data-path={listing?.path ?? ''}
            data-loading={loading ? 'true' : 'false'}
            onKeyDown={onListKey}
          >
            {unavailable ? (
              <div class="rl-fp__note" data-testid="rl-claude-fp-unavailable" role="note">
                <Icon name="info" size={12} />
                <span>{unavailable} Meanwhile, type a path below.</span>
              </div>
            ) : browseError && !listing ? (
              <div class="rl-fp__note rl-fp__note--error" data-testid="rl-claude-fp-error" role="alert">
                {browseError}
              </div>
            ) : !listing ? (
              <div class="rl-fp__note rl-faint">
                <span class="rl-spinner rl-fp__spinner" aria-hidden="true" /> Loading folders…
              </div>
            ) : visible.length === 0 ? (
              <div class="rl-fp__note rl-faint" data-testid="rl-claude-fp-empty">
                {filter ? `No folder matches “${filter}”` : hiddenCount && !showHidden ? 'Only hidden folders here' : 'No sub-folders — start Claude here'}
              </div>
            ) : (
              visible.map((entry, index) => (
                <div
                  key={entry.name}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === activeIndex ? 'true' : 'false'}
                  class={`rl-fp__row${index === activeIndex ? ' rl-fp__row--active' : ''}${entry.hidden ? ' rl-fp__row--hidden' : ''}`}
                  data-testid="rl-claude-fp-entry"
                  data-name={entry.name}
                  data-git={entry.git ? 'true' : undefined}
                  data-project={entry.project ? 'true' : undefined}
                  title={`${entry.name} — double-click to open, Enter to start Claude here`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    listRef.current?.focus({ preventScroll: true });
                  }}
                  onClick={() => highlight(entry.name)}
                  onDblClick={() => enter(entry)}
                >
                  <Icon name="folder" size={13} class="rl-fp__row-icon" />
                  <span class="rl-fp__row-name rl-truncate">{entry.name}</span>
                  {entry.git ? (
                    <span class="rl-fp__badge rl-fp__badge--git" data-testid="rl-claude-fp-badge-git">
                      git
                    </span>
                  ) : entry.project ? (
                    <span class="rl-fp__badge" data-testid="rl-claude-fp-badge-project">
                      project
                    </span>
                  ) : null}
                </div>
              ))
            )}
          </div>
          {browseError && listing ? (
            <div class="rl-error rl-fp__inline-error" data-testid="rl-claude-fp-error" role="alert">
              {browseError}
            </div>
          ) : listing?.truncated ? (
            <div class="rl-faint rl-fp__inline-error">Showing the first {listing.entries.length} folders — filter to find others.</div>
          ) : null}
        </section>

        <aside class="rl-fp__quick" aria-label="Quick picks">
          {recentDirs.length ? (
            <div class="rl-term__recent">
              <div class="rl-term__recent-title rl-faint">Recent</div>
              <ul class="rl-term__recent-list">
                {recentDirs.map((dir) => (
                  <li key={dir} class="rl-fp__quick-item">
                    <button
                      type="button"
                      class="rl-term__recent-item rl-mono"
                      title={`Start Claude Code in ${dir}`}
                      data-testid="rl-claude-terminal-recent"
                      data-dir={dir}
                      onClick={() => start(dir)}
                    >
                      <span class="rl-term__recent-name">{dirLabel(dir)}</span>
                      {dirLabel(dir) !== dir ? <span class="rl-term__recent-path rl-faint rl-truncate">{tildePath(dir, home, sep)}</span> : null}
                    </button>
                    <button
                      type="button"
                      class="rl-icon-btn rl-icon-btn--sm rl-fp__quick-browse"
                      title={`Browse ${dir}`}
                      aria-label={`Browse ${dirLabel(dir)}`}
                      data-testid="rl-claude-fp-recent-browse"
                      onClick={() => go(dir, { focusList: true })}
                    >
                      <Icon name="folder" size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div class="rl-term__recent" data-testid="rl-claude-fp-projects" data-state={projects.state}>
            <div class="rl-row rl-fp__quick-title">
              <span class="rl-term__recent-title rl-faint">Projects</span>
              <span class="rl-spacer" />
              {projects.state === 'done' || projects.state === 'error' ? (
                <button
                  type="button"
                  class="rl-icon-btn rl-icon-btn--sm"
                  title="Look for projects again"
                  aria-label="Look for projects again"
                  data-testid="rl-claude-fp-projects-refresh"
                  onClick={() => findProjects(true)}
                >
                  <Icon name="reload" size={11} />
                </button>
              ) : null}
            </div>
            {projects.state === 'idle' ? (
              <button
                type="button"
                class="rl-btn rl-btn--sm rl-btn--ghost rl-fp__scan"
                title={`Git repositories up to two levels inside ${PROJECT_ROOTS_HINT}`}
                data-testid="rl-claude-fp-projects-scan"
                onClick={() => findProjects(false)}
              >
                <Icon name="search" size={12} />
                Find git projects
              </button>
            ) : projects.state === 'loading' ? (
              <div class="rl-faint rl-fp__quick-note">
                <span class="rl-spinner rl-fp__spinner" aria-hidden="true" /> Looking in {PROJECT_ROOTS_HINT}…
              </div>
            ) : projects.state === 'error' ? (
              <div class="rl-error rl-fp__quick-note" role="alert">
                {projects.error}
              </div>
            ) : projects.result.projects.length === 0 ? (
              <div class="rl-faint rl-fp__quick-note">No git projects in {PROJECT_ROOTS_HINT}.</div>
            ) : (
              <ul class="rl-term__recent-list">
                {projects.result.projects.map((project) => (
                  <li key={project.path} class="rl-fp__quick-item">
                    <button
                      type="button"
                      class="rl-term__recent-item rl-mono"
                      title={`Start Claude Code in ${project.path}`}
                      data-testid="rl-claude-fp-project"
                      data-dir={project.path}
                      onClick={() => start(project.path)}
                    >
                      <span class="rl-term__recent-name">{project.name}</span>
                      <span class="rl-term__recent-path rl-faint rl-truncate">{tildePath(parentOfTyped(project.path) ?? project.path, projects.result.home, sep)}</span>
                    </button>
                    <button
                      type="button"
                      class="rl-icon-btn rl-icon-btn--sm rl-fp__quick-browse"
                      title={`Browse ${project.path}`}
                      aria-label={`Browse ${project.name}`}
                      data-testid="rl-claude-fp-project-browse"
                      onClick={() => go(project.path, { focusList: true })}
                    >
                      <Icon name="folder" size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>

      <div class="rl-fp__typed">
        <label class="rl-faint rl-fp__typed-label" for="rl-fp-typed">
          Or type a path
        </label>
        <input
          id="rl-fp-typed"
          type="text"
          class={`rl-input rl-input--mono rl-grow rl-fp__typed-input${error && typedPath ? ' rl-input--invalid' : ''}`}
          placeholder="~/projects/my-app"
          spellcheck={false}
          autocomplete="off"
          data-testid="rl-claude-terminal-cwd"
          value={typed}
          onInput={(e) => {
            setTyped(e.currentTarget.value);
            setError(null);
          }}
        />
        <button
          type="button"
          class="rl-btn rl-btn--sm"
          title="Browse to this path"
          data-testid="rl-claude-terminal-cwd-go"
          disabled={!typedPath || !!unavailable}
          onClick={() => go(typedPath, { keepTyped: true, focusList: true })}
        >
          Browse
        </button>
      </div>

      {error ? (
        <div class="rl-error rl-term__form-error" data-testid="rl-claude-terminal-form-error" role="alert">
          {error}
        </div>
      ) : null}

      <div class="rl-fp__footer">
        <span class="rl-fp__target-label rl-faint">Start in</span>
        <code class="rl-mono rl-truncate rl-fp__target" data-testid="rl-claude-fp-target" data-path={target} title={target}>
          {shownTarget || '—'}
        </code>
        <span class="rl-spacer" />
        {activeIndex >= 0 && !typedPath ? (
          <button
            type="button"
            class="rl-btn rl-btn--sm rl-btn--ghost"
            data-testid="rl-claude-fp-use-current"
            title={`Start in ${listing?.path ?? ''} instead`}
            onClick={() => highlight(null)}
          >
            Use this folder
          </button>
        ) : null}
        <button
          type="submit"
          class="rl-btn rl-btn--primary rl-btn--sm"
          data-testid="rl-claude-terminal-start"
          disabled={!target}
          title="Runs the real claude CLI from your login shell in that folder"
        >
          <Icon name={actionLabel === 'Start Claude here' ? 'terminal' : 'check'} size={12} />
          {actionLabel}
        </button>
      </div>
    </form>
  );
}
