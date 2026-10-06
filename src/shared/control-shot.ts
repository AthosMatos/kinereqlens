/**
 * Contract between the MCP control plane and the panel's screenshot / Find in page handlers (src/ui/control/shot.ts).
 *
 *  MCP tool `screenshot` / `find_in_page` → hub → worker → the panel of the target tab (mounted headless when the
 *  overlay is closed) → runShotCommand / runFindCommand, which drive the same capture engine and page scanner as the
 *  overlay's own buttons.
 *
 * The control plane validates the arguments before calling; the handlers throw an Error whose message is shown to
 * the user. Fields may be added on either side; renaming or removing one breaks the other side.
 */

/** A rectangle in page (document) CSS px. */
export interface PageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Which page element a command is about: exactly one of `selector`, `text`, `value` or `requestId` (+ `path`). */
export interface ElementLocator {
  /** CSS selector, in the top document (open shadow roots included). */
  selector?: string;
  /** Visible text or label of the element: text content, aria-label, title, alt, placeholder, form values. */
  text?: string;
  /** A response value, matched the way Find in page matches it (formatted numbers and dates included). */
  value?: string;
  /** A captured request (an id from list_requests, or "selected"); with `path`, the value at that path is located. */
  requestId?: string;
  /** JSON path of a value in that request's response, e.g. "data.items[0].name". */
  path?: string;
  /** `text` / `value` must equal the element's text (case- and space-insensitive), not just be contained. Default false. */
  exact?: boolean;
  /** Which match, 0-based in document order, when several elements match. Default 0. */
  index?: number;
}

export type ShotTarget = 'visible' | 'full' | 'region' | 'element';

export interface ShotCommandArgs extends ElementLocator {
  /** Default: 'element' when a locator is set, else 'visible'. */
  target?: ShotTarget;
  /** target 'region': the area to capture. */
  region?: PageRect;
  /** Space kept around the element / region in CSS px (default: the user's default padding, 50). Clamped to the page. */
  padding?: number;
  /** Also open the capture in the overlay's Screenshot view (showing the overlay). Default false. */
  open?: boolean;
}

/** An image, base64 without the `data:` prefix. */
export interface ShotImage {
  data: string;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

/** An element of the page, as reported to the chat. */
export interface ElementInfo {
  /** Tag name, lower case. */
  tag: string;
  /** Visible text, at most 200 characters. */
  text: string;
  /** A CSS selector that finds it again (best effort). */
  selector: string;
  rect: PageRect;
  visible: boolean;
}

export interface ShotCommandResult {
  /** Full resolution (device pixels). */
  image: ShotImage;
  /** For the chat: at most 1568 px on the long side (the same image when it already fits). */
  preview: ShotImage;
  /** The captured area, page CSS px. */
  area: PageRect;
  padding: number;
  /** element target: the element captured, how many elements matched and which one was captured. */
  element?: ElementInfo;
  matches?: number;
  matchIndex?: number;
  /** E.g. "padding clipped at the page edge", "stitched from 3 tiles". */
  notes?: string[];
}

export interface FindCommandArgs extends ElementLocator {
  /** Scroll to match `index` and highlight it on the page, as "Show in page" does. Default false. */
  highlight?: boolean;
  /** Max matches listed. Default 20. */
  limit?: number;
}

export interface FindCommandResult {
  /** Elements matching the locator, in document order, at most `limit`. */
  matches: ElementInfo[];
  total: number;
  /**
   * `requestId` alone: the response values shown in the page (what the find icons mark), in the response's order (at
   * most `limit`, default 500 here); `total` is then the number of values shown. `visible`: hits rendered now; `as`:
   * the form the page shows the value in when it differs (a formatted number or date).
   */
  properties?: Array<{ path: string; value: string; matches: number; visible?: number; as?: string }>;
  /** `highlight`: the index (in `matches`) of the element shown on the page. */
  highlighted?: number;
  /** E.g. why nothing was highlighted. */
  notes?: string[];
}
