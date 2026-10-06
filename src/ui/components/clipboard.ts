// OWNER: ui-shell agent.
import { getActiveElementInUi, getUiRoot } from './root';
import { toast } from './toast';

/** Legacy copy path: a hidden textarea inside the overlay shadow root + execCommand('copy'). */
function copyViaTextarea(text: string): boolean {
  const host = getUiRoot();
  if (!host) return false;
  const previous = getActiveElementInUi();
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.setAttribute('aria-hidden', 'true');
  ta.tabIndex = -1;
  // Off-screen but still selectable (display:none / visibility:hidden would block selection).
  ta.style.cssText =
    'position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
  host.appendChild(ta);
  let ok = false;
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    ta.remove();
    previous?.focus({ preventScroll: true });
  }
  return ok;
}

/**
 * Copy text: navigator.clipboard.writeText, falling back to a hidden textarea + execCommand('copy')
 * created inside the overlay shadow root. Shows a toast ("Copied" / "Copy failed"). Returns success.
 */
export async function copyText(text: string, label = 'Copied'): Promise<boolean> {
  let ok = false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch {
    // Permissions-Policy, unfocused document, insecure context... fall back below.
    ok = false;
  }
  if (!ok) ok = copyViaTextarea(text);
  toast(ok ? label : 'Copy failed', ok ? 'success' : 'error');
  return ok;
}
