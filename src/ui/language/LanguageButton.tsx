// "Site language" (docs/ARCHITECTURE.md §11): the navigation rail item (badge = the active tag) opening the Language
// popover, and the header indicator shown while an override applies to this tab.
import type { ComponentChildren, JSX } from 'preact';
import type { LanguageStatus } from '../../shared/language';
import { primaryLanguage } from '../../shared/language';
import { Icon } from '../components/Icon';
import { PopoverButton } from '../components/Menu';
import { useLanguageStatus } from './client';
import { LanguagePanel } from './LanguagePanel';

/** Tooltip of the rail item / header indicator. */
export function languageTitle(status: LanguageStatus): string {
  const tag = primaryLanguage(status.effective);
  if (!tag) return 'Site language — Edge default';
  return `Site language: ${tag} (${status.scope === 'tab' ? 'this tab' : `site ${status.host ?? ''}`})`;
}

export interface LanguageButtonProps {
  /** Button classes (the rail's `rl-rail__btn`). */
  class: string;
  attrs?: JSX.HTMLAttributes<HTMLButtonElement>;
  /** The button's inside (the rail's icon / label / badge). */
  content(info: { tag: string | null; status: LanguageStatus }): ComponentChildren;
}

/** The rail item + its popover (opens beside the rail). */
export function LanguageButton(props: LanguageButtonProps) {
  const status = useLanguageStatus();
  const tag = primaryLanguage(status.effective);
  return (
    <PopoverButton
      title={languageTitle(status)}
      beside
      class={props.class}
      testId="rl-language-button"
      trigger={{
        content: props.content({ tag, status }),
        attrs: { ...props.attrs, 'data-language': tag ?? '', 'data-scope': status.scope ?? '' } as JSX.HTMLAttributes<HTMLButtonElement>,
      }}
    >
      {(close) => <LanguagePanel status={status} close={close} />}
    </PopoverButton>
  );
}

/** Small header chip while a language override applies to this tab (nothing otherwise). */
export function LanguageIndicator() {
  const status = useLanguageStatus();
  const tag = primaryLanguage(status.effective);
  if (!tag) return null;
  const title = languageTitle(status);
  return (
    <span
      class="rl-lang-indicator"
      role="status"
      title={title}
      aria-label={title}
      data-testid="rl-language-indicator"
      data-language={tag}
      data-scope={status.scope ?? ''}
    >
      <Icon name="globe" size={11} />
      <span class="rl-lang-indicator__tag">{tag}</span>
    </span>
  );
}
