// Padding of an element / region capture (result view): a slider and a number field. Changes re-crop the capture
// live from the margin captured around it (store.ts setShotPadding, no new capture); a padding beyond that margin
// captures the element again when the slider is released / the number committed (elementCapture.ts recaptureShot) —
// or, when the element is gone, shows what the capture holds. Also the default padding field of the tool's Element
// mode (settings.shotPadding).
import type { JSX } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { SHOT_PADDING_MAX } from '../../shared/screenshot-protocol';
import type { ReqlensBridge } from '../../shared/types';
import { sanitizePadding } from '../../lib/elementShot';
import { BridgeContext } from '../hooks';
import { toast } from '../components/toast';
import { defaultPadding, recaptureShot } from './elementCapture';
import { isShotHost } from './engine';
import { setShotPadding } from './store';
import type { ShotItem } from './store';

/** Slider range at least this wide (CSS px); the number field takes up to SHOT_PADDING_MAX. */
const SLIDER_MIN_MAX = 250;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** settings.shotPadding, following changes, and its setter (persisted; shown at once while it is being saved). */
export function useDefaultPadding(bridge: ReqlensBridge | null): [number, (padding: number) => void] {
  const [, rerender] = useState(0);
  const [pending, setPending] = useState<number | null>(null);
  useEffect(() => (bridge ? bridge.subscribeSettings(() => rerender((n) => n + 1)) : undefined), [bridge]);
  const value = pending ?? defaultPadding(bridge);
  const set = (padding: number) => {
    const next = sanitizePadding(padding, value);
    setPending(next);
    const done = () => setPending((p) => (p === next ? null : p));
    if (!bridge) return;
    bridge.updateSettings({ shotPadding: next }).then(done, (err: unknown) => {
      done();
      toast(`Could not save: ${errorText(err)}`, 'error');
    });
  };
  return [value, set];
}

/**
 * A number field committed on Enter / blur (typing alone only previews, `onInput`). What the user typed is kept for
 * the value it was typed over: a new value from outside replaces it (no effect involved — Preact runs effects after
 * paint, and a late one would overwrite what was just typed).
 */
function NumberField(props: { value: number; label: string; testId: string; title?: string; disabled?: boolean; onInput?(n: number): void; onCommit(n: number): void }) {
  const [edit, setEdit] = useState<{ text: string; over: number } | null>(null);
  const text = edit && edit.over === props.value ? edit.text : String(props.value);
  const commit = () => {
    setEdit(null);
    const raw = text.trim();
    const n = Number(raw);
    if (!raw || !Number.isFinite(n)) return;
    const next = sanitizePadding(n, props.value);
    if (next !== props.value) props.onCommit(next);
  };
  return (
    <input
      type="number"
      class="rl-input rl-shot__padding-input"
      min={0}
      max={SHOT_PADDING_MAX}
      step={1}
      value={text}
      aria-label={props.label}
      title={props.title}
      data-testid={props.testId}
      disabled={props.disabled}
      onInput={(e) => {
        const typed = e.currentTarget.value;
        setEdit({ text: typed, over: props.value });
        const n = Number(typed);
        if (typed.trim() && Number.isFinite(n)) props.onInput?.(sanitizePadding(n, props.value));
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

/** The tool bar's default padding (Element mode): what the next pick keeps around the element. */
export function DefaultPaddingField({ bridge, disabled }: { bridge: ReqlensBridge | null; disabled?: boolean }) {
  const [padding, setPadding] = useDefaultPadding(bridge);
  return (
    <label class="rl-shot__padding-default" title="Space kept around the picked element (CSS px); change it on each capture afterwards">
      <span>Padding</span>
      <NumberField value={padding} label="Default padding around the element (px)" testId="rl-shot-default-padding" disabled={disabled} onCommit={setPadding} />
      <span class="rl-faint">px</span>
    </label>
  );
}

/** The result view's padding control of a padded capture. */
export function PaddingControl({ item }: { item: ShotItem }) {
  const bridge = useContext(BridgeContext);
  const padded = item.padded!;
  // The value being dragged / committed until the capture shows it (then the capture's own padding).
  const [local, setLocal] = useState<{ id: string; value: number } | null>(null);
  const value = local && local.id === item.id ? local.value : padded.padding;
  const [state, setState] = useState<'idle' | 'cropping' | 'capturing'>('idle');
  const [noteOf, setNoteOf] = useState<{ id: string; text: string } | null>(null);
  const note = noteOf && noteOf.id === item.id ? noteOf.text : null;
  const setNote = (text: string | null) => setNoteOf(text === null ? null : { id: item.id, text });
  const live = useRef(0);
  /** The capture shows `padding` now: drop the local value if it is that one. */
  const settled = (padding: number) => setLocal((l) => (l && l.value === padding ? null : l));

  const limit = padded.limit;
  const finiteLimit = Number.isFinite(limit) ? Math.floor(limit) : null;
  const sliderMax = Math.min(SHOT_PADDING_MAX, Math.max(SLIDER_MIN_MAX, finiteLimit ?? 0, value, padded.padding));
  const shotHost = isShotHost(bridge) ? bridge : null;

  /** Re-crop from what was captured (live: the latest value wins). */
  const crop = (padding: number) => {
    const ticket = ++live.current;
    setState('cropping');
    setShotPadding(item.id, padding).then(
      () => {
        settled(padding);
        if (ticket === live.current) setState('idle');
      },
      (err: unknown) => {
        settled(padding);
        if (ticket !== live.current) return;
        setState('idle');
        setNote(errorText(err));
      },
    );
  };

  /** A committed value: beyond the captured margin, capture the element again; else re-crop. */
  const commit = (padding: number) => {
    setLocal({ id: item.id, value: padding });
    setNote(null);
    if (finiteLimit !== null && padding > limit + 0.5 && shotHost) {
      const ticket = ++live.current;
      setState('capturing');
      // What the capture holds first, then the new capture.
      void setShotPadding(item.id, padding)
        .then(() => recaptureShot(shotHost, item.id, padding))
        .then(
          () => {
            settled(padding);
            if (ticket === live.current) setState('idle');
          },
          (err: unknown) => {
            settled(padding);
            if (ticket !== live.current) return;
            setState('idle');
            setNote(`${errorText(err)} — showing the ${finiteLimit} px captured around it`);
          },
        );
      return;
    }
    crop(padding);
  };

  const hint =
    finiteLimit === null
      ? 'The capture reaches the page edges'
      : padded.crop.short
        ? `Captured ${finiteLimit} px around it — more needs a new capture`
        : `Up to ${finiteLimit} px without a new capture`;
  const fill = `${Math.round((Math.min(value, sliderMax) / Math.max(1, sliderMax)) * 100)}%`;

  return (
    <div
      class="rl-shot__padding"
      data-testid="rl-shot-padding"
      data-padding={padded.padding}
      data-limit={finiteLimit === null ? 'page' : String(finiteLimit)}
      data-state={state}
      data-short={padded.crop.short ? 'true' : undefined}
    >
      <span class="rl-shot__padding-label" id={`rl-shot-padding-${item.id}`}>
        Padding
      </span>
      <input
        type="range"
        class="rl-range rl-shot__padding-range"
        min={0}
        max={sliderMax}
        step={1}
        value={Math.min(value, sliderMax)}
        style={{ '--rl-range-fill': fill } as JSX.CSSProperties}
        aria-labelledby={`rl-shot-padding-${item.id}`}
        aria-valuetext={`${value} px`}
        title={hint}
        data-testid="rl-shot-padding-range"
        disabled={state === 'capturing'}
        onInput={(e) => {
          const n = sanitizePadding(Number(e.currentTarget.value), value);
          setLocal({ id: item.id, value: n });
          crop(n);
        }}
        onChange={(e) => commit(sanitizePadding(Number(e.currentTarget.value), value))}
      />
      <NumberField
        value={value}
        label="Padding around the element (px)"
        testId="rl-shot-padding-input"
        title={hint}
        disabled={state === 'capturing'}
        onInput={(n) => {
          // Live within what was captured; a larger value is captured when committed.
          if (finiteLimit === null || n <= limit) crop(n);
        }}
        onCommit={commit}
      />
      <span class="rl-faint">px</span>
      <span class="rl-shot__padding-hint" data-testid="rl-shot-padding-note" aria-live="polite">
        {state === 'capturing' ? (
          <>
            <span class="rl-spinner" aria-hidden="true" /> Capturing more of the page…
          </>
        ) : (
          (note ?? hint)
        )}
      </span>
    </div>
  );
}
