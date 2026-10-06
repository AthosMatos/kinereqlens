// OWNER: ui-export agent. "Set up" links of the Export tab: open the Settings popover of the navigation rail and
// bring its Claude Code section into view. The popover is owned by the shell (App.tsx), so this drives its
// trigger button (test id `rl-settings`) instead of reaching into its state.
import { getUiRoot } from '../components/root';
import { toast } from '../components/toast';

/** Test id of the Claude Code section in the Settings popover. */
export const CLAUDE_SECTION_TESTID = 'rl-claude-section';
const MAX_FRAMES = 20;

function reveal(frame: number): void {
  requestAnimationFrame(() => {
    const root = getUiRoot();
    const section = root?.querySelector<HTMLElement>(`[data-testid="${CLAUDE_SECTION_TESTID}"]`);
    const popup = section?.closest<HTMLElement>('.rl-popup');
    // The popover renders hidden until it is positioned.
    if (!section || !popup || popup.style.visibility === 'hidden') {
      if (frame < MAX_FRAMES) reveal(frame + 1);
      return;
    }
    section.scrollIntoView({ block: 'start', inline: 'nearest' });
    const target = section.querySelector<HTMLElement>('[data-claude-focus]') ?? section;
    target.focus({ preventScroll: true });
    section.classList.remove('rl-claude--flash');
    // Restart the highlight animation (reflow between remove and add).
    void section.offsetWidth;
    section.classList.add('rl-claude--flash');
  });
}

/** Open Settings → Claude Code. */
export function openClaudeSettings(): void {
  const trigger = getUiRoot()?.querySelector<HTMLButtonElement>('[data-testid="rl-settings"]');
  if (!trigger) {
    toast('Open Settings (gear icon in the sidebar) → Claude Code', 'info');
    return;
  }
  if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
  reveal(0);
}
