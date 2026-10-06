// Screenshot tool panel: capture modes (visible area, region, element, full page, a kineReqLens panel component),
// the result view (zoom, annotations, copy, download) and the recent captures strip (in memory, ≤ 10).
//
// Mount it anywhere inside the overlay App (it needs the enclosing `.rl-root` for the theme tokens and the
// BridgeContext's RemoteBridge for the page side), e.g. `<ScreenshotTool onClose={…} />` in a sidebar.
import type { JSX } from 'preact';
import { useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { OutputScale } from '../../lib/screenshot';
import { getUiRoot } from '../components/root';
import { Icon } from '../components/Icon';
import { toast } from '../components/toast';
import { BridgeContext } from '../hooks';
import { captureComponent, captureFullPage, capturePicked, captureVisibleArea, createShotBackend, isShotHost } from './engine';
import type { CaptureOutput, ShotBackend, ShotMode } from './engine';
import { ShotIcon } from './icons';
import type { ShotIconName } from './icons';
import { MODE_LABELS, ResultView } from './ResultView';
import { DefaultPaddingField, useDefaultPadding } from './PaddingControl';
import { addShot, clearShots, getShot, onShotSelection, takeShotSelection, useShots } from './store';
import { shotContextFromBridge } from './sendContext';
import { getShellState } from '../shellState';
import { useScreenshotStyles } from './styles';

/** A kineReqLens component the "Panel" mode can capture. */
export interface ComponentTarget {
  id: string;
  label: string;
  /** CSS selector inside the panel's UI root. */
  selector: string;
}

/** Default "Panel" mode targets (test ids from docs/ARCHITECTURE.md §4.4). */
export const DEFAULT_COMPONENT_TARGETS: readonly ComponentTarget[] = [
  { id: 'results', label: 'Response / test result', selector: '[data-testid="rl-results"]' },
  { id: 'detail', label: 'Request editor', selector: '[data-testid="rl-detail"]' },
  { id: 'list', label: 'Request list', selector: '[data-testid="rl-request-list"]' },
  { id: 'export', label: 'Export', selector: '[data-testid="rl-export"]' },
  { id: 'panel', label: 'Whole panel', selector: '[data-testid="rl-panel"]' },
];

export interface ScreenshotToolProps {
  /** Capture backend; defaults to one over the BridgeContext's RemoteBridge (the overlay panel). */
  backend?: ShotBackend;
  /** "Panel" mode targets (default DEFAULT_COMPONENT_TARGETS). */
  componentTargets?: readonly ComponentTarget[];
  /** Where "Panel" mode looks for targets (default: the overlay's UI root). */
  componentRoot?: () => ParentNode | null;
  /** Shows a close button (e.g. to hide the sidebar). */
  onClose?: () => void;
  /** Extra class on the root element. */
  class?: string;
}

const MODES: ReadonlyArray<{ id: ShotMode; label: string; icon: ShotIconName; hint: string }> = [
  { id: 'visible', label: 'Visible', icon: 'visible', hint: 'The visible part of the page' },
  { id: 'region', label: 'Region', icon: 'region', hint: 'Drag a rectangle over the page' },
  { id: 'element', label: 'Element', icon: 'element', hint: 'Hover and click a page element (↑ ↓ / wheel: parent · child); captured with the padding around it' },
  { id: 'fullpage', label: 'Full page', icon: 'fullpage', hint: 'Scroll and stitch the whole page (up to 20 000 px)' },
  { id: 'component', label: 'Panel', icon: 'panel', hint: 'A part of the kineReqLens panel' },
];

interface Busy {
  mode: ShotMode;
  done: number;
  total: number;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException ? err.name === 'AbortError' : err instanceof Error && /cancelled/i.test(err.message);
}

export function ScreenshotTool(props: ScreenshotToolProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const captureRef = useRef<HTMLButtonElement>(null);
  useScreenshotStyles(rootRef);
  const bridge = useContext(BridgeContext);
  const backend = useMemo<ShotBackend | null>(() => props.backend ?? (isShotHost(bridge) ? createShotBackend(bridge) : null), [props.backend, bridge]);
  const targets = props.componentTargets ?? DEFAULT_COMPONENT_TARGETS;

  const shots = useShots();
  const [mode, setMode] = useState<ShotMode>('visible');
  const [target, setTarget] = useState<string>(targets[0]?.id ?? '');
  const [output, setOutput] = useState<OutputScale>('device');
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const [padding] = useDefaultPadding(bridge);

  // A capture opened from elsewhere (the MCP `screenshot` tool, a response value's camera button).
  useEffect(() => {
    const take = () => {
      const id = takeShotSelection();
      if (id) setSelectedId(id);
    };
    take();
    return onShotSelection(take);
  }, []);

  useEffect(
    () => () => {
      alive.current = false;
      abortRef.current?.abort();
    },
    [],
  );

  const selected = getShot(selectedId) ?? shots[0] ?? null;

  const findTarget = (): Element | null => {
    const t = targets.find((x) => x.id === target);
    const root = props.componentRoot?.() ?? getUiRoot();
    return t && root ? root.querySelector(t.selector) : null;
  };

  /** "Panel" targets currently in the panel (others are listed disabled); keeps the choice on one that is. */
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
  const refreshTargets = () => {
    const root = props.componentRoot?.() ?? getUiRoot();
    // Present and rendered (the request list / editor are hidden while the tool fills the panel's main view).
    const next = new Set(targets.filter((t) => (root?.querySelector(t.selector)?.getClientRects().length ?? 0) > 0).map((t) => t.id));
    setShown(next);
    if (!next.has(target)) {
      const first = targets.find((t) => next.has(t.id));
      if (first) setTarget(first.id);
    }
  };
  useEffect(() => {
    if (mode === 'component') refreshTargets();
  }, [mode]);

  const capture = async () => {
    if (busy || !backend) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy({ mode, done: 0, total: 0 });
    setError(null);
    setNotice(null);
    try {
      let out: CaptureOutput | null;
      const opts = { output, signal: ac.signal };
      switch (mode) {
        case 'visible':
          out = await captureVisibleArea(backend, opts);
          break;
        case 'region':
          out = await capturePicked(backend, mode, opts);
          break;
        case 'element':
          // The picked element with the default padding (changed afterwards in the result view).
          out = await capturePicked(backend, mode, { ...opts, padding });
          break;
        case 'fullpage':
          out = await captureFullPage(backend, { ...opts, onProgress: (done, total) => alive.current && setBusy({ mode, done, total }) });
          break;
        case 'component': {
          const el = findTarget();
          if (!el) throw new Error(`${targets.find((x) => x.id === target)?.label ?? 'That component'} is not shown right now`);
          out = await captureComponent(backend, el, opts);
          break;
        }
      }
      if (!alive.current) return;
      if (!out) {
        setNotice('Cancelled');
        return;
      }
      const item = await addShot(out);
      if (alive.current) setSelectedId(item.id);
    } catch (err) {
      if (!alive.current) return;
      if (isAbort(err)) setNotice('Cancelled');
      else {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        toast(`Screenshot failed: ${message}`, 'error');
      }
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      if (alive.current) {
        setBusy(null);
        // The panel was hidden during page captures: give the focus back.
        captureRef.current?.focus({ preventScroll: true });
      }
    }
  };

  const onModeKey = (e: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const i = MODES.findIndex((m) => m.id === mode);
    const next = MODES[(i + dir + MODES.length) % MODES.length]!;
    setMode(next.id);
    (e.currentTarget.querySelector(`[data-mode="${next.id}"]`) as HTMLElement | null)?.focus();
  };

  const modeInfo = MODES.find((m) => m.id === mode)!;
  const pct = busy && busy.total > 0 ? Math.round((busy.done / busy.total) * 100) : 0;

  return (
    <div ref={rootRef} class={`rl-shot${props.class ? ` ${props.class}` : ''}`} data-testid="rl-shot" data-busy={busy ? busy.mode : undefined}>
      <div class="rl-shot__bar">
        <span class="rl-shot__title">
          <ShotIcon name="camera" size={15} />
          Screenshot
        </span>
        <div class="rl-shot__seg" role="radiogroup" aria-label="Capture mode" onKeyDown={onModeKey}>
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              class="rl-shot__seg-btn"
              aria-checked={mode === m.id}
              tabIndex={mode === m.id ? 0 : -1}
              title={m.hint}
              data-testid="rl-shot-mode"
              data-mode={m.id}
              disabled={busy !== null}
              onClick={() => setMode(m.id)}
            >
              <ShotIcon name={m.icon} />
              <span class="rl-shot__mode-label">{m.label}</span>
            </button>
          ))}
        </div>
        {mode === 'element' && <DefaultPaddingField bridge={bridge} disabled={busy !== null} />}
        {mode === 'component' && (
          <select
            class="rl-select rl-shot__select"
            aria-label="Panel component"
            data-testid="rl-shot-component"
            value={target}
            disabled={busy !== null}
            onFocus={refreshTargets}
            onPointerDown={refreshTargets}
            onChange={(e) => setTarget(e.currentTarget.value)}
          >
            {targets.map((t) => (
              <option key={t.id} value={t.id} disabled={!shown.has(t.id)}>
                {shown.has(t.id) ? t.label : `${t.label} (not shown)`}
              </option>
            ))}
          </select>
        )}
        <span class="rl-spacer rl-grow" />
        <button
          type="button"
          class="rl-chip"
          aria-pressed={output === 'css'}
          title="Save at 1 pixel per CSS pixel instead of the screen's device pixels"
          data-testid="rl-shot-scale"
          onClick={() => setOutput(output === 'css' ? 'device' : 'css')}
        >
          1×
        </button>
        <button
          ref={captureRef}
          type="button"
          class="rl-btn rl-btn--sm rl-btn--primary"
          data-testid="rl-shot-capture"
          disabled={busy !== null || !backend}
          title={backend ? modeInfo.hint : 'Screenshots need the kineReqLens overlay'}
          onClick={() => void capture()}
        >
          {busy ? <span class="rl-spinner" aria-hidden="true" /> : <ShotIcon name="camera" size={12} />}
          Capture
        </button>
        {props.onClose && (
          <button type="button" class="rl-icon-btn" aria-label="Close screenshot tool" title="Close" data-testid="rl-shot-close" onClick={props.onClose}>
            <Icon name="close" />
          </button>
        )}
      </div>

      <div class="rl-shot__status" role="status" aria-live="polite" data-testid="rl-shot-status" data-state={busy ? 'busy' : error ? 'error' : 'idle'}>
        {busy ? (
          busy.total > 0 ? (
            <>
              <span>
                Capturing tile {busy.done} of {busy.total}… <span class="rl-kbd">Esc</span> on the page cancels
              </span>
              <span class="rl-shot__progress" aria-hidden="true">
                <span style={{ width: `${pct}%` }} />
              </span>
            </>
          ) : (
            <span>
              <span class="rl-spinner" aria-hidden="true" /> {mode === 'region' || mode === 'element' ? 'Select on the page — Esc cancels' : 'Capturing…'}
            </span>
          )
        ) : notice ? (
          <span>{notice}</span>
        ) : (
          <span>{modeInfo.hint}</span>
        )}
      </div>
      {error && (
        <div class="rl-error" data-testid="rl-shot-error">
          <Icon name="warning" />
          <span>{error}</span>
        </div>
      )}

      {selected ? (
        <ResultView item={selected} sendContext={() => shotContextFromBridge(bridge, getShellState().selectedId)} />
      ) : (
        <div class="rl-empty rl-shot__empty">
          <ShotIcon name="camera" size={22} />
          <div class="rl-empty__title">No screenshot yet</div>
          <div class="rl-empty__text">
            Pick a mode and press Capture. The overlay hides while the page is captured; Region and Element let you select on the
            page, <span class="rl-kbd">Esc</span> cancels.
          </div>
        </div>
      )}

      {shots.length > 0 && (
        <div class="rl-shot__recent">
          <span class="rl-shot__recent-label">Recent</span>
          <div class="rl-shot__strip" role="group" aria-label="Recent screenshots" data-testid="rl-shot-recent">
            {shots.map((s) => (
              <button
                key={s.id}
                type="button"
                class="rl-shot__thumb"
                aria-pressed={selected?.id === s.id}
                title={`${MODE_LABELS[s.mode]} · ${s.width} × ${s.height} · ${new Date(s.createdAt).toLocaleTimeString()}`}
                data-testid="rl-shot-recent-item"
                data-shot-id={s.id}
                onClick={() => setSelectedId(s.id)}
              >
                {s.thumbUrl && <img src={s.thumbUrl} alt="" draggable={false} />}
                <span class="rl-shot__thumb-mode">{MODE_LABELS[s.mode]}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            class="rl-icon-btn rl-icon-btn--sm"
            aria-label="Clear recent screenshots"
            title="Clear recent screenshots"
            onClick={() => {
              clearShots();
              setSelectedId(null);
            }}
          >
            <Icon name="trash" size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
