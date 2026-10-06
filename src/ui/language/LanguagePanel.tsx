// "Site language" popover (navigation rail item "Language", docs/ARCHITECTURE.md §11): current state, a searchable
// language picker with custom tags and optional fallbacks, the scope (this tab / this site), Apply (reloads the page
// once by default, so the document request and the page's first scripts see the language) and Reset.
import type { JSX } from 'preact';
import { useMemo, useRef, useState } from 'preact/hooks';
import type { LanguageScope, LanguageStatus } from '../../shared/language';
import {
  canonicalTag,
  formatLanguageItems,
  languageName,
  parseLanguageValue,
  primaryLanguage,
  searchLanguages,
} from '../../shared/language';
import { Icon } from '../components/Icon';
import { useBridge } from '../hooks';
import { applyLanguage, resetLanguage } from './client';

/** The browser's own languages (the panel is an extension page: the page's override never reaches it). */
function browserLanguages(): string {
  try {
    const list = navigator.languages?.length ? navigator.languages : [navigator.language];
    return list.filter(Boolean).join(', ');
  } catch {
    return '';
  }
}

function splitValue(value: string | null): { primary: string; fallbacks: string } {
  const parsed = value ? parseLanguageValue(value) : null;
  if (!parsed || !parsed.ok) return { primary: '', fallbacks: '' };
  const [first, ...rest] = parsed.items;
  return { primary: first?.tag ?? '', fallbacks: formatLanguageItems(rest).replace(/,/g, ', ') };
}

export interface LanguagePanelProps {
  status: LanguageStatus;
  close(): void;
}

export function LanguagePanel({ status, close }: LanguagePanelProps) {
  const bridge = useBridge();
  const initial = useMemo(() => splitValue(status.effective), []);
  const [primary, setPrimary] = useState(initial.primary);
  const [fallbacks, setFallbacks] = useState(initial.fallbacks);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<LanguageScope>(status.scope ?? 'tab');
  const [reload, setReload] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pendingReload, setPendingReload] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => searchLanguages(query), [query]);
  const custom = useMemo(() => {
    const tag = canonicalTag(query);
    return tag && !matches.some((m) => m.tag.toLowerCase() === tag.toLowerCase()) ? tag : null;
  }, [query, matches]);
  const queryInvalid = query.trim() !== '' && !custom && matches.length === 0;

  const combined = primary ? (fallbacks.trim() ? `${primary}, ${fallbacks}` : primary) : '';
  const parsed = combined ? parseLanguageValue(combined) : null;
  const value = parsed?.ok ? parsed.value : null;
  const valueError = parsed && !parsed.ok ? parsed.error : '';
  const siteScope = scope === 'site' && !status.host;
  const unchanged = value !== null && value === status.effective && scope === status.scope;

  const pick = (tag: string) => {
    setPrimary(tag);
    setError('');
  };

  const onSearchKey = (e: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const tag = custom ?? matches[0]?.tag;
    if (tag) pick(tag);
  };

  const apply = async () => {
    if (!value || busy) return;
    setBusy(true);
    setError('');
    try {
      const failure = await applyLanguage(bridge, { value, scope, host: status.host });
      if (failure) {
        setError(failure);
        return;
      }
      if (reload) {
        close();
        bridge.reloadPage();
      } else {
        setPendingReload(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await resetLanguage(bridge, status.host);
      setPrimary('');
      setFallbacks('');
      if (reload) {
        close();
        bridge.reloadPage();
      } else {
        setPendingReload(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const activeTag = primaryLanguage(status.effective);
  const activeName = languageName(activeTag);
  const shadowedSite = status.scope === 'tab' && status.site && status.site !== status.tab ? status.site : null;

  return (
    <div class="rl-lang" data-testid="rl-language-panel">
      <div class="rl-lang__head">
        <Icon name="globe" size={14} />
        <span class="rl-lang__title">Site language</span>
      </div>

      <div
        class={`rl-lang__state${status.effective ? ' rl-lang__state--override' : ''}`}
        data-testid="rl-language-state"
        data-state={status.effective ? 'override' : 'default'}
        data-scope={status.scope ?? ''}
        data-value={status.effective ?? ''}
      >
        {status.effective ? (
          <>
            <span class="rl-lang__state-main">
              <span class="rl-mono">{activeTag}</span>
              {activeName ? <span class="rl-lang__native">{activeName}</span> : null}
              <span class="rl-lang__scope">{status.scope === 'tab' ? 'this tab' : `site ${status.host ?? ''}`}</span>
            </span>
            <span class="rl-lang__header rl-mono rl-truncate" title={`Accept-Language: ${status.effective}`}>
              Accept-Language: {status.effective}
            </span>
            {shadowedSite ? (
              <span class="rl-faint">
                The site language <span class="rl-mono">{primaryLanguage(shadowedSite)}</span> applies again once the tab override is reset.
              </span>
            ) : null}
          </>
        ) : (
          <span class="rl-lang__state-main">
            <span>Edge default</span>
            <span class="rl-mono rl-faint rl-truncate">{browserLanguages()}</span>
          </span>
        )}
      </div>

      <label class="rl-lang__field">
        <span class="rl-lang__label">Language</span>
        <span class="rl-lang__search">
          <Icon name="search" size={12} />
          <input
            ref={searchRef}
            type="text"
            class="rl-input rl-input--sm"
            placeholder="Search, or type a tag (e.g. pt-BR, es-419)"
            value={query}
            spellcheck={false}
            autocomplete="off"
            aria-controls="rl-lang-list"
            data-testid="rl-language-search"
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={onSearchKey}
          />
        </span>
      </label>
      <div class="rl-lang__list" id="rl-lang-list" role="listbox" aria-label="Languages" data-testid="rl-language-list">
        {custom ? (
          <button
            type="button"
            role="option"
            class="rl-lang__option rl-lang__option--custom"
            aria-selected={primary === custom ? 'true' : 'false'}
            data-tag={custom}
            data-testid="rl-language-custom"
            onClick={() => pick(custom)}
          >
            <span class="rl-mono rl-lang__tag">{custom}</span>
            <span class="rl-lang__native">Use this tag{languageName(custom) ? ` — ${languageName(custom)}` : ''}</span>
          </button>
        ) : null}
        {matches.map((option) => (
          <button
            key={option.tag}
            type="button"
            role="option"
            class="rl-lang__option"
            aria-selected={primary === option.tag ? 'true' : 'false'}
            data-tag={option.tag}
            data-testid="rl-language-option"
            title={option.english}
            onClick={() => pick(option.tag)}
          >
            <span class="rl-mono rl-lang__tag">{option.tag}</span>
            <span class="rl-lang__native rl-truncate">{option.name}</span>
            {primary === option.tag ? <Icon name="check" size={12} class="rl-lang__check" /> : null}
          </button>
        ))}
        {queryInvalid ? (
          <div class="rl-lang__empty" data-testid="rl-language-invalid">
            Not a known language or a valid BCP-47 tag
          </div>
        ) : null}
      </div>

      <label class="rl-lang__field">
        <span class="rl-lang__label">Fallbacks (optional)</span>
        <input
          type="text"
          class="rl-input rl-input--sm rl-input--mono"
          placeholder="e.g. en;q=0.8"
          value={fallbacks}
          spellcheck={false}
          autocomplete="off"
          data-testid="rl-language-fallbacks"
          onInput={(e) => {
            setFallbacks(e.currentTarget.value);
            setError('');
          }}
        />
      </label>

      <div class="rl-lang__preview" data-testid="rl-language-preview" data-valid={value ? 'true' : 'false'}>
        {value ? (
          <span class="rl-mono rl-truncate" title={value}>
            Accept-Language: {value}
          </span>
        ) : valueError ? (
          <span class="rl-lang__error" role="alert" data-testid="rl-language-error">
            {valueError}
          </span>
        ) : (
          <span class="rl-faint">Pick a language</span>
        )}
      </div>

      <fieldset class="rl-lang__scopes">
        <legend class="rl-lang__label">Apply to</legend>
        <label class="rl-lang__radio">
          <input
            type="radio"
            name="rl-lang-scope"
            checked={scope === 'tab'}
            data-testid="rl-language-scope-tab"
            onChange={() => setScope('tab')}
          />
          <span>This tab (until it is closed)</span>
        </label>
        <label class={`rl-lang__radio${status.host ? '' : ' rl-lang__radio--disabled'}`}>
          <input
            type="radio"
            name="rl-lang-scope"
            checked={scope === 'site'}
            disabled={!status.host}
            data-testid="rl-language-scope-site"
            onChange={() => setScope('site')}
          />
          <span>
            This site{status.host ? (
              <>
                {' '}
                <span class="rl-mono">{status.host}</span> (saved)
              </>
            ) : ' (not available on this page)'}
          </span>
        </label>
      </fieldset>

      <label class="rl-lang__radio">
        <input
          type="checkbox"
          class="rl-checkbox"
          checked={reload}
          data-testid="rl-language-reload"
          onChange={(e) => setReload(e.currentTarget.checked)}
        />
        <span>Reload the page to apply everywhere</span>
      </label>

      {error ? (
        <div class="rl-lang__error" role="alert" data-testid="rl-language-apply-error">
          {error}
        </div>
      ) : null}

      {pendingReload ? (
        <div class="rl-lang__note" data-testid="rl-language-pending">
          <span>Requests and the page's language APIs use it now; the page loaded before. </span>
          <button
            type="button"
            class="rl-btn rl-btn--sm"
            data-testid="rl-language-reload-now"
            onClick={() => {
              close();
              bridge.reloadPage();
            }}
          >
            <Icon name="reload" size={12} />
            Reload to apply
          </button>
        </div>
      ) : null}

      <div class="rl-lang__actions">
        <button
          type="button"
          class="rl-btn rl-btn--sm rl-btn--ghost"
          disabled={busy || (!status.tab && !status.site)}
          data-testid="rl-language-reset"
          title="Back to the browser's languages on this page"
          onClick={() => void reset()}
        >
          Reset
        </button>
        <span class="rl-spacer" />
        <button
          type="button"
          class="rl-btn rl-btn--sm rl-btn--primary"
          disabled={busy || !value || siteScope || unchanged}
          data-testid="rl-language-apply"
          onClick={() => void apply()}
        >
          Apply
        </button>
      </div>
      <p class="rl-lang__hint rl-faint">
        Sets Accept-Language on the tab's requests and navigator.language / Intl in the page — your Edge settings stay as
        they are.
      </p>
    </div>
  );
}
