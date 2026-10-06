// The screenshot tool's stylesheet. It is adopted into the tool's shadow root on first mount, so the component is
// self-contained; it can also be added to styles/index.ts ALL_CSS (then the adoption is skipped).
import { useLayoutEffect } from 'preact/hooks';
import type { RefObject } from 'preact';
import css from './screenshot.css';

export const SCREENSHOT_CSS: string = css;

const adopted = new WeakSet<Document | ShadowRoot>();

/** Adopt SCREENSHOT_CSS into the document / shadow root that holds `ref` (once per root). */
export function useScreenshotStyles(ref: RefObject<Element>): void {
  useLayoutEffect(() => {
    const root = ref.current?.getRootNode();
    if (!(root instanceof ShadowRoot || root instanceof Document) || adopted.has(root)) return;
    adopted.add(root);
    // Already part of the root's styles (ALL_CSS): nothing to add.
    const present = root.adoptedStyleSheets.some((sheet) => {
      try {
        return Array.from(sheet.cssRules).some((rule) => rule instanceof CSSStyleRule && rule.selectorText === '.rl-shot__canvas-wrap');
      } catch {
        return false;
      }
    });
    if (present) return;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(SCREENSHOT_CSS);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  }, []);
}
