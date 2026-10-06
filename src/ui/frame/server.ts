// Host side of the panel connection (ui.js, top frame isolated world): serves the ReqlensBridge to the
// panel iframe over a chrome.runtime Port (see src/shared/panel-protocol.ts).
//
// Only the panel of the iframe this host created is served (it proves it with the nonce of its URL
// fragment), so a page that embeds panel.html in its own frame cannot read the captured data or drive
// replays.
import type { HitRect, HostToPanel, PanelCallName, PanelToHost, PanelUiState, PanelUiStatePatch } from '../../shared/panel-protocol';
import { PANEL_PAGE, PANEL_PORT_NAME } from '../../shared/panel-protocol';
import type { ReqlensBridge, RequestEntry } from '../../shared/types';
import type { WsDelta } from '../../lib/ws';
import { chunkWsDelta } from '../../lib/ws';
import type { FrameHost } from './host';
import { createShotController } from '../screenshot/page/controller';
import type { ShotController } from '../screenshot/page/controller';
import { clearHighlight, showHighlight } from './highlight';
import type { ComponentLocateResult } from '../../shared/initiator-protocol';
import type { ShotBeginOptions } from '../../shared/screenshot-protocol';
import { sanitizeComponentQuery } from '../../shared/initiator-protocol';
import { createFindManager } from './findInPage';
import type { FindManager } from './findInPage';
import { locateElements, scanValues } from './findElements';
import { sanitizeElementRef } from '../../shared/find-protocol';

/** Keep each entries message well below the extension messaging limit. */
const CHUNK_MAX_ENTRIES = 300;
const CHUNK_MAX_BYTES = 16 * 1024 * 1024;
const MAX_HIT_RECTS = 32;
/** A panel that disconnected (navigated away by the page, crashed) is reloaded when none reconnects. */
const RECONNECT_WAIT_MS = 2000;
const RELOAD_LIMIT = 5;

type Port = chrome.runtime.Port;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Validated hit regions from the panel. */
export function sanitizeHitRects(value: unknown): HitRect[] | 'all' | 'none' | null {
  if (value === 'all' || value === 'none') return value;
  if (!Array.isArray(value)) return null;
  const rects: HitRect[] = [];
  for (const item of value.slice(0, MAX_HIT_RECTS)) {
    if (!isRecord(item) || !finite(item.left) || !finite(item.top) || !finite(item.width) || !finite(item.height)) continue;
    rects.push({ left: item.left, top: item.top, width: Math.max(0, item.width), height: Math.max(0, item.height) });
  }
  return rects;
}

/** Validated shotBegin options (src/shared/screenshot-protocol.ts ShotBeginOptions; the controller clamps the cap). */
export function shotBeginOptions(value: unknown): ShotBeginOptions {
  const opts: ShotBeginOptions = { hideOverlay: isRecord(value) && value.hideOverlay === true };
  if (!isRecord(value)) return opts;
  if (finite(value.maxHiddenMs) && value.maxHiddenMs > 0) opts.maxHiddenMs = value.maxHiddenMs;
  if (value.exclusive === true) opts.exclusive = true;
  return opts;
}

/** Apply a UI-state patch: `shell` replaces, each record / runs list replaces (null deletes). */
export function mergeUiState(state: PanelUiState | null, patch: PanelUiStatePatch): PanelUiState {
  const next: PanelUiState = {
    shell: state?.shell ?? {},
    records: { ...(state?.records ?? {}) },
    runs: { ...(state?.runs ?? {}) },
  };
  if (isRecord(patch.shell)) next.shell = patch.shell;
  for (const key of ['records', 'runs'] as const) {
    const changes = patch[key];
    if (!isRecord(changes)) continue;
    for (const [id, value] of Object.entries(changes)) {
      if (value === null) delete next[key][id];
      else next[key][id] = value;
    }
  }
  return next;
}

function bodySize(body: RequestEntry['requestBody'] | undefined): number {
  if (!body) return 0;
  switch (body.kind) {
    case 'text':
      return body.text.length * 2;
    case 'base64':
      return body.base64.length;
    case 'formData':
      return body.entries.reduce((n, e) => n + e.name.length + (e.type === 'text' ? e.value.length * 2 : (e.base64?.length ?? 0)) + 64, 0);
    case 'formFields':
      return body.fields.reduce((n, f) => n + (f.name.length + f.value.length) * 2 + 24, 0);
    default:
      return 64;
  }
}

/** Rough serialized size of an entry (bodies and headers dominate). */
function entrySize(entry: RequestEntry): number {
  let size = 1024 + entry.url.length * 2;
  for (const h of entry.requestHeaders) size += (h.name.length + h.value.length) * 4;
  for (const h of entry.responseHeaders ?? []) size += (h.name.length + h.value.length) * 4;
  return size + bodySize(entry.requestBody) + bodySize(entry.responseBody) + (entry.initiatorStack?.length ?? 0) * 2;
}

/** Split entries into messages bounded by count and (estimated) size. */
export function chunkForPanel(entries: RequestEntry[]): RequestEntry[][] {
  const chunks: RequestEntry[][] = [];
  let current: RequestEntry[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const size = entrySize(entry);
    if (current.length > 0 && (current.length >= CHUNK_MAX_ENTRIES || bytes + size > CHUNK_MAX_BYTES)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(entry);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** One connected panel: sends state and changes, answers calls. */
class PanelSession {
  private readonly sent = new Map<string, RequestEntry>();
  private readonly unsubscribes: Array<() => void> = [];
  private closed = false;
  /** Find in page (src/shared/find-protocol.ts): scans, locate, pick — results go to this panel only. */
  private readonly find: FindManager;

  constructor(
    private readonly port: Port,
    private readonly bridge: ReqlensBridge,
    private readonly frame: FrameHost,
    private readonly ui: { state: PanelUiState | null },
    private readonly shots: ShotController,
  ) {
    this.find = createFindManager(frame, (message) => this.post(message));
  }

  /** The overlay was closed (tab state): nothing of Find in page stays on the page. */
  overlayClosed(): void {
    this.find.overlayClosed();
  }

  start(): void {
    this.post({
      t: 'state',
      version: this.bridge.version,
      tabState: this.bridge.getTabState(),
      settings: this.bridge.getSettings(),
      captureInfo: this.bridge.getCaptureInfo(),
      uiState: this.ui.state,
    });
    this.syncEntries();
    const ws = this.bridge.ws;
    if (ws) this.postWs(ws.snapshot());
    this.post({ t: 'ready' });
    if (ws) this.unsubscribes.push(ws.subscribe((delta) => this.postWs(delta)));
    this.unsubscribes.push(
      this.bridge.subscribeEntries(() => this.syncEntries()),
      this.bridge.subscribeTabState((tabState) => this.post({ t: 'tabState', tabState })),
      this.bridge.subscribeSettings((settings) => this.post({ t: 'settings', settings })),
      this.bridge.subscribeCaptureInfo((captureInfo) => this.post({ t: 'captureInfo', captureInfo })),
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // A capture this panel was driving must never leave the page scrolled, the overlay hidden or the picker up.
    this.shots.end();
    clearHighlight();
    this.find.dispose();
    for (const off of this.unsubscribes.splice(0)) {
      try {
        off();
      } catch {
        /* bridge gone */
      }
    }
    try {
      this.port.disconnect();
    } catch {
      /* already closed */
    }
  }

  handle(message: unknown): void {
    if (this.closed || !isRecord(message)) return;
    const msg = message as PanelToHost;
    switch (msg.t) {
      case 'call':
        void this.call(msg.id, msg.method, Array.isArray(msg.args) ? msg.args : []);
        return;
      case 'hit': {
        const rects = sanitizeHitRects(msg.rects);
        if (rects) this.frame.setHitRegions(rects);
        return;
      }
      case 'ui-state':
        if (isRecord(msg.patch)) this.ui.state = mergeUiState(this.ui.state, msg.patch);
        return;
      default:
        return;
    }
  }

  private post(message: HostToPanel): void {
    if (this.closed) return;
    try {
      this.port.postMessage(message);
    } catch {
      this.close();
    }
  }

  private postWs(delta: WsDelta): void {
    for (const chunk of chunkWsDelta(delta)) this.post({ t: 'ws', delta: chunk });
  }

  /** Send entries that changed (by identity) since the last message, and the ids that are gone. */
  private syncEntries(): void {
    const entries = this.bridge.getEntries();
    const upsert: RequestEntry[] = [];
    const live = new Set<string>();
    for (const entry of entries) {
      live.add(entry.id);
      if (this.sent.get(entry.id) !== entry) {
        upsert.push(entry);
        this.sent.set(entry.id, entry);
      }
    }
    const remove: string[] = [];
    for (const id of this.sent.keys()) if (!live.has(id)) remove.push(id);
    for (const id of remove) this.sent.delete(id);
    if (upsert.length === 0 && remove.length === 0) return;
    const chunks = chunkForPanel(upsert);
    if (chunks.length === 0) this.post({ t: 'entries', upsert: [], remove });
    chunks.forEach((chunk, i) => this.post({ t: 'entries', upsert: chunk, remove: i === 0 ? remove : [] }));
  }

  /** Find components through the page hook; draw the highlight here (ui.js) when asked. */
  private async locateComponents(raw: unknown): Promise<ComponentLocateResult> {
    const query = sanitizeComponentQuery(raw);
    const locate = this.bridge.locateComponents;
    if (!locate) {
      return { frameworks: [], matches: query.names.map((name) => ({ name, count: 0, instances: [] })), error: 'Component detection is not available here' };
    }
    const result = await locate(query);
    if (query.highlight) {
      const match = result.matches.find((m) => m.instances.some((i) => i.rect));
      const boxes = match
        ? match.instances.flatMap((inst, i) =>
            inst.rect ? [{ rect: inst.rect, label: match.instances.length > 1 ? `${match.name} #${i + 1}` : match.name }] : [],
          )
        : [];
      result.highlighted = showHighlight(boxes);
    }
    return result;
  }

  private async call(id: number, method: PanelCallName, args: unknown[]): Promise<void> {
    const b = this.bridge;
    try {
      let value: unknown;
      switch (method) {
        case 'clearEntries':
          b.clearEntries();
          break;
        case 'addManualEntry':
          value = b.addManualEntry(isRecord(args[0]) ? (args[0] as Parameters<ReqlensBridge['addManualEntry']>[0]) : undefined);
          break;
        case 'setTabState':
          value = await b.setTabState(isRecord(args[0]) ? (args[0] as Parameters<ReqlensBridge['setTabState']>[0]) : {});
          break;
        case 'updateSettings':
          value = await b.updateSettings(isRecord(args[0]) ? (args[0] as Parameters<ReqlensBridge['updateSettings']>[0]) : {});
          break;
        case 'replay':
          value = await b.replay(args[0] as Parameters<ReqlensBridge['replay']>[0]);
          break;
        case 'abortReplay':
          if (typeof args[0] === 'string') b.abortReplay(args[0]);
          break;
        case 'reloadPage':
          b.reloadPage();
          break;
        case 'setProtectedEntries':
          if (Array.isArray(args[0])) b.setProtectedEntries(args[0].filter((x): x is string => typeof x === 'string'));
          break;
        case 'wsClear':
          b.ws?.clear();
          break;
        case 'wsSend':
          value =
            b.ws && typeof args[0] === 'string' && typeof args[1] === 'string'
              ? await b.ws.send(args[0], args[1])
              : { ok: false, error: 'WebSocket inspection is not available on this page' };
          break;
        // Initiator tab (src/shared/initiator-protocol.ts).
        case 'locateComponents':
          value = await this.locateComponents(args[0]);
          break;
        case 'clearHighlight':
          clearHighlight();
          break;
        // Screenshot tool (src/shared/screenshot-protocol.ts).
        case 'shotBegin':
          value = await this.shots.begin(shotBeginOptions(args[0]));
          break;
        case 'shotScroll':
          if (typeof args[0] !== 'number' || !Number.isFinite(args[0])) throw new Error('Invalid scroll position');
          value = await this.shots.scroll(args[0], args[1] === true, typeof args[2] === 'number' && Number.isFinite(args[2]) ? args[2] : undefined);
          break;
        case 'shotElement': {
          const ref = sanitizeElementRef(args[0]);
          if (!ref) throw new Error('Invalid element');
          value = await this.shots.element(ref, args[1] === true);
          break;
        }
        case 'shotEnd':
          value = this.shots.end();
          break;
        case 'shotPick':
          if (args[0] !== 'region' && args[0] !== 'element') throw new Error('Invalid pick mode');
          value = await this.shots.pick(args[0]);
          break;
        // Find in page (src/shared/find-protocol.ts); the manager validates every argument.
        case 'findStart':
          value = this.find.start(args[0]);
          break;
        case 'findStop':
          this.find.stop(args[0]);
          break;
        case 'findRescan':
          this.find.rescan(args[0]);
          break;
        case 'findLocate':
          value = await this.find.locate(args[0]);
          break;
        // Element locators (src/shared/find-protocol.ts ElementQuery), validated by the page side.
        case 'findElements':
          value = await locateElements(args[0]);
          break;
        case 'findHighlight':
          value = this.find.highlight(args[0]);
          break;
        case 'findValues':
          value = await scanValues(args[0]);
          break;
        case 'findPick':
          value = await this.find.pick();
          break;
        default:
          throw new Error(`Unknown call ${String(method)}`);
      }
      this.post({ t: 'result', id, ok: true, value });
    } catch (err) {
      this.post({ t: 'result', id, ok: false, error: errorText(err) });
    }
  }
}

/**
 * Serve `bridge` to the panel iframe of `frame`, whose URL fragment is `nonce`. Shows / hides the host with
 * the tab's open state. Returns the stop function.
 */
export function startPanelServer(bridge: ReqlensBridge, frame: FrameHost, nonce: string): () => void {
  const panelUrl = chrome.runtime.getURL(PANEL_PAGE);
  const ui: { state: PanelUiState | null } = { state: null };
  const shots = createShotController(frame);
  let session: PanelSession | null = null;
  let stopped = false;
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  let reloads = 0;

  const fromPanelPage = (port: Port): boolean => {
    const sender = port.sender;
    return !!sender && sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.split('#')[0]!.split('?')[0] === panelUrl;
  };

  const scheduleReload = () => {
    if (reloadTimer || stopped) return;
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      if (stopped || session || reloads >= RELOAD_LIMIT) return;
      reloads++;
      // The page navigated our frame elsewhere (or it crashed): load the panel again.
      frame.iframe.src = `${panelUrl}#${nonce}`;
    }, RECONNECT_WAIT_MS);
  };

  const onConnect = (port: Port) => {
    if (stopped || port.name !== PANEL_PORT_NAME) return;
    if (!fromPanelPage(port)) {
      port.disconnect();
      return;
    }
    let current: PanelSession | null = null;
    port.onMessage.addListener((message: unknown) => {
      if (current) {
        current.handle(message);
        return;
      }
      // Nothing is sent before the panel proved it is the one in our iframe.
      if (!isRecord(message) || message.t !== 'hello' || message.nonce !== nonce) {
        port.disconnect();
        return;
      }
      session?.close();
      current = new PanelSession(port, bridge, frame, ui, shots);
      session = current;
      if (reloadTimer) {
        clearTimeout(reloadTimer);
        reloadTimer = null;
      }
      current.start();
    });
    port.onDisconnect.addListener(() => {
      if (!current) return;
      current.close();
      if (session !== current) return;
      session = null;
      // No pointer events for a frame that is not (yet) a working panel.
      frame.setHitRegions('none');
      scheduleReload();
    });
  };

  const applyOpen = (open: boolean) => {
    if (open) frame.show();
    else {
      frame.hide();
      session?.overlayClosed();
    }
  };

  chrome.runtime.onConnect.addListener(onConnect);
  const offTabState = bridge.subscribeTabState((state) => applyOpen(state.open));
  applyOpen(bridge.getTabState().open);

  return () => {
    if (stopped) return;
    stopped = true;
    if (reloadTimer) clearTimeout(reloadTimer);
    offTabState();
    session?.close();
    session = null;
    shots.dispose();
    try {
      chrome.runtime.onConnect.removeListener(onConnect);
    } catch {
      /* context gone */
    }
  };
}
