// Result view of the screenshot tool: zoomable preview, annotations (rectangle, arrow, text, pixelate for
// redaction, undo), Copy (ClipboardItem image/png), Download (blob URL + a[download]) and Send to Claude (a Claude
// Code session or an embedded terminal, SendDialog.tsx).
import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { fitZoom, screenshotFilename, stepZoom } from '../../lib/screenshot';
import { clippedNote } from '../../lib/elementShot';
import { getUiRoot } from '../components/root';
import { toast } from '../components/toast';
import { Icon } from '../components/Icon';
import { ANNOTATION_COLORS, annotationFromDrag, drawAnnotations, exportAnnotated, fontFor } from './annotate';
import type { Annotation, AnnotationTool } from './annotate';
import { ShotIcon } from './icons';
import type { ShotIconName } from './icons';
import { PaddingControl } from './PaddingControl';
import { SendDialog } from './SendDialog';
import type { ShotSendContext } from './sendModel';
import { setAnnotations } from './store';
import type { ShotItem } from './store';

/** Preview canvas backing store cap (px): a 20 000 px page is drawn downscaled, exported at full size. */
const MAX_PREVIEW_AREA = 16_000_000;
const STAGE_PADDING = 24;

const TOOLS: ReadonlyArray<{ id: AnnotationTool | 'none'; label: string; icon: ShotIconName; key: string }> = [
  { id: 'none', label: 'Pan (no tool)', icon: 'hand', key: 'V' },
  { id: 'rect', label: 'Rectangle', icon: 'rect', key: 'R' },
  { id: 'arrow', label: 'Arrow', icon: 'arrow', key: 'A' },
  { id: 'text', label: 'Text', icon: 'text', key: 'T' },
  { id: 'pixelate', label: 'Pixelate (redact)', icon: 'pixelate', key: 'P' },
];

export const MODE_LABELS: Record<ShotItem['mode'], string> = {
  visible: 'Visible area',
  region: 'Region',
  element: 'Element',
  fullpage: 'Full page',
  component: 'Panel',
};

type Zoom = 'fit' | number;

interface TextEdit {
  x: number;
  y: number;
  value: string;
}

/** Decode the item's PNG once per item. */
function useBitmap(item: ShotItem): ImageBitmap | null {
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  useEffect(() => {
    let live = true;
    let decoded: ImageBitmap | null = null;
    setBitmap(null);
    createImageBitmap(item.blob).then(
      (b) => {
        decoded = b;
        if (live) setBitmap(b);
        else b.close();
      },
      () => toast('Could not decode the screenshot', 'error'),
    );
    return () => {
      live = false;
      decoded?.close();
    };
  }, [item.blob]);
  return bitmap;
}

/** Size of an element's content box, following resizes. */
function useBoxSize(ref: { current: HTMLElement | null }): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize((prev) => (prev.width === el.clientWidth && prev.height === el.clientHeight ? prev : { width: el.clientWidth, height: el.clientHeight }));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return size;
}

function pageUrlOf(host: string): string {
  return host ? `https://${host}/` : '';
}

export interface ResultViewProps {
  item: ShotItem;
  /** Where annotations are kept (default: the screenshot tool's recent captures store). */
  onAnnotations?(id: string, annotations: Annotation[]): void;
  /** Context "Send to Claude" offers (page URL, selected request, error analysis), read when the dialog opens. */
  sendContext?(): ShotSendContext;
}

export function ResultView({ item, onAnnotations, sendContext }: ResultViewProps) {
  const bitmap = useBitmap(item);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const stage = useBoxSize(stageRef);
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [tool, setTool] = useState<AnnotationTool | 'none'>('rect');
  const [color, setColor] = useState<string>(ANNOTATION_COLORS[0].value);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);
  const [busy, setBusy] = useState<'copy' | 'download' | null>(null);
  const [sending, setSending] = useState<ShotSendContext | null>(null);
  const drag = useRef<{ x: number; y: number; id: number; pan?: { left: number; top: number; cx: number; cy: number } } | null>(null);
  const [panning, setPanning] = useState(false);
  const annotations = item.annotations;

  // Natural size = one image px per CSS px of the page (the capture scale undone).
  const natural = useMemo(() => ({ width: item.width / item.scale, height: item.height / item.scale }), [item.width, item.height, item.scale]);
  const z = zoom === 'fit' ? fitZoom(natural, { width: stage.width - STAGE_PADDING, height: stage.height - STAGE_PADDING }) : zoom;
  const display = { width: Math.max(1, Math.round(natural.width * z)), height: Math.max(1, Math.round(natural.height * z)) };
  const backing = useMemo(() => {
    const dpr = window.devicePixelRatio || 1;
    let w = Math.min(item.width, Math.round(display.width * dpr));
    let h = Math.min(item.height, Math.round(display.height * dpr));
    if (w * h > MAX_PREVIEW_AREA) {
      const f = Math.sqrt(MAX_PREVIEW_AREA / (w * h));
      w = Math.floor(w * f);
      h = Math.floor(h * f);
    }
    return { width: Math.max(1, w), height: Math.max(1, h) };
  }, [display.width, display.height, item.width, item.height]);

  // Reset the view for another capture.
  useEffect(() => {
    setZoom('fit');
    setDraft(null);
    setTextEdit(null);
    setSending(null);
  }, [item.id]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bitmap) return;
    if (canvas.width !== backing.width) canvas.width = backing.width;
    if (canvas.height !== backing.height) canvas.height = backing.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const k = canvas.width / item.width;
    drawAnnotations(ctx, bitmap, draft ? [...annotations, draft] : annotations, k, item);
  }, [bitmap, backing, annotations, draft, item]);

  useEffect(() => {
    if (textEdit) textRef.current?.focus({ preventScroll: true });
  }, [textEdit !== null]);

  const commit = (list: Annotation[]) => (onAnnotations ?? setAnnotations)(item.id, list);
  const undo = () => {
    if (textEdit) {
      setTextEdit(null);
      return;
    }
    if (annotations.length) commit(annotations.slice(0, -1));
  };

  const toImage = (e: PointerEvent | MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / Math.max(1, rect.width)) * item.width;
    const y = ((e.clientY - rect.top) / Math.max(1, rect.height)) * item.height;
    return { x: Math.max(0, Math.min(item.width, x)), y: Math.max(0, Math.min(item.height, y)) };
  };

  const commitText = () => {
    const edit = textEdit;
    setTextEdit(null);
    const text = edit?.value.replace(/\s+$/, '') ?? '';
    if (!edit || !text) return;
    commit([...annotations, { kind: 'text', x: edit.x, y: edit.y, text, color, size: fontFor(item.scale) }]);
  };

  const onPointerDown = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !bitmap || e.target === textRef.current) return;
    if (tool === 'text') {
      e.preventDefault();
      if (textEdit) commitText();
      const p = toImage(e);
      setTextEdit({ x: p.x, y: p.y, value: '' });
      return;
    }
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const p = toImage(e);
    const st = stageRef.current;
    drag.current = { ...p, id: e.pointerId, ...(tool === 'none' && st ? { pan: { left: st.scrollLeft, top: st.scrollTop, cx: e.clientX, cy: e.clientY } } : {}) };
    if (tool === 'none') setPanning(true);
  };
  const onPointerMove = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (d.pan) {
      const st = stageRef.current;
      if (st) {
        st.scrollLeft = d.pan.left - (e.clientX - d.pan.cx);
        st.scrollTop = d.pan.top - (e.clientY - d.pan.cy);
      }
      return;
    }
    if (tool === 'none' || tool === 'text') return;
    const p = toImage(e);
    setDraft(annotationFromDrag(tool, d.x, d.y, p.x, p.y, color, item.scale));
  };
  const onPointerUp = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setPanning(false);
    if (d.pan || tool === 'none' || tool === 'text') return;
    const p = toImage(e);
    const next = annotationFromDrag(tool, d.x, d.y, p.x, p.y, color, item.scale);
    setDraft(null);
    if (next) commit([...annotations, next]);
  };

  const exportBlob = (): Promise<Blob> => (bitmap ? exportAnnotated(bitmap, item.blob, annotations) : Promise.resolve(item.blob));

  const copy = async () => {
    if (busy) return;
    setBusy('copy');
    try {
      if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) throw new Error('Clipboard images are not supported here');
      // The promise keeps the click's user activation for the write.
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': exportBlob() })]);
      toast('Screenshot copied', 'success');
    } catch (err) {
      toast(`Copy failed${err instanceof Error && err.message ? `: ${err.message}` : ''}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    if (busy) return;
    setBusy('download');
    try {
      const blob = await exportBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = screenshotFilename(pageUrlOf(item.host), new Date(item.createdAt));
      a.rel = 'noopener';
      a.style.display = 'none';
      (getUiRoot() ?? document.body).appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      toast(`Download failed${err instanceof Error && err.message ? `: ${err.message}` : ''}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('textarea, input, select')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
      return;
    }
    if (mod || e.altKey) return;
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      setZoom(stepZoom(z, 1));
    } else if (e.key === '-') {
      e.preventDefault();
      setZoom(stepZoom(z, -1));
    } else if (e.key === '0') {
      e.preventDefault();
      setZoom('fit');
    } else {
      const t = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
      if (t) {
        e.preventDefault();
        setTool(t.id);
      }
    }
  };

  const textStyle: JSX.CSSProperties | undefined = textEdit
    ? {
        left: `${(textEdit.x / item.width) * display.width}px`,
        top: `${(textEdit.y / item.height) * display.height}px`,
        color,
        fontSize: `${Math.max(10, (fontFor(item.scale) / item.scale) * z)}px`,
      }
    : undefined;

  return (
    <div
      class="rl-shot__result"
      data-testid="rl-shot-result"
      data-shot-id={item.id}
      data-mode={item.mode}
      data-width={item.width}
      data-height={item.height}
      data-annotations={annotations.length}
      onKeyDown={onKeyDown}
    >
      <div class="rl-shot__tools" role="toolbar" aria-label="Annotate">
        <div class="rl-shot__seg" role="group" aria-label="Annotation tool">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              class="rl-shot__seg-btn rl-shot__seg-btn--icon"
              aria-pressed={tool === t.id}
              title={`${t.label} (${t.key})`}
              aria-label={t.label}
              data-testid="rl-shot-tool"
              data-tool={t.id}
              onClick={() => setTool(t.id)}
            >
              <ShotIcon name={t.icon} />
            </button>
          ))}
        </div>
        <div class="rl-shot__seg" role="group" aria-label="Color">
          {ANNOTATION_COLORS.map((c) => (
            <button
              key={c.id}
              type="button"
              class="rl-shot__swatch"
              style={{ '--rl-swatch': c.value } as JSX.CSSProperties}
              aria-pressed={color === c.value}
              aria-label={c.label}
              title={c.label}
              onClick={() => setColor(c.value)}
            />
          ))}
        </div>
        <button type="button" class="rl-icon-btn" title="Undo (Ctrl+Z)" aria-label="Undo" data-testid="rl-shot-undo" disabled={!annotations.length && !textEdit} onClick={undo}>
          <ShotIcon name="undo" />
        </button>
        <button type="button" class="rl-icon-btn" title="Remove all annotations" aria-label="Remove all annotations" disabled={!annotations.length} onClick={() => commit([])}>
          <Icon name="trash" />
        </button>
        <span class="rl-spacer rl-grow" />
        <div class="rl-shot__seg" role="group" aria-label="Zoom">
          <button type="button" class="rl-shot__seg-btn rl-shot__seg-btn--icon" aria-label="Zoom out" title="Zoom out (−)" data-testid="rl-shot-zoom-out" onClick={() => setZoom(stepZoom(z, -1))}>
            <ShotIcon name="zoom-out" />
          </button>
          <button
            type="button"
            class="rl-shot__seg-btn rl-shot__zoom"
            title="Actual size (100%)"
            aria-label={`Zoom ${Math.round(z * 100)}%, show at 100%`}
            data-testid="rl-shot-zoom"
            data-zoom={zoom === 'fit' ? 'fit' : String(zoom)}
            onClick={() => setZoom(1)}
          >
            {Math.round(z * 100)}%
          </button>
          <button type="button" class="rl-shot__seg-btn rl-shot__seg-btn--icon" aria-label="Zoom in" title="Zoom in (+)" data-testid="rl-shot-zoom-in" onClick={() => setZoom(stepZoom(z, 1))}>
            <ShotIcon name="zoom-in" />
          </button>
          <button type="button" class="rl-shot__seg-btn rl-shot__seg-btn--icon" aria-pressed={zoom === 'fit'} aria-label="Fit" title="Fit (0)" data-testid="rl-shot-zoom-fit" onClick={() => setZoom('fit')}>
            <ShotIcon name="fit" />
          </button>
        </div>
        <button type="button" class="rl-btn rl-btn--sm" data-testid="rl-shot-copy" disabled={busy !== null} onClick={() => void copy()}>
          <Icon name="copy" size={12} />
          Copy
        </button>
        <button type="button" class="rl-btn rl-btn--sm rl-btn--primary" data-testid="rl-shot-download" disabled={busy !== null} onClick={() => void download()}>
          <Icon name="download" size={12} />
          PNG
        </button>
        <button
          type="button"
          class="rl-btn rl-btn--sm"
          data-testid="rl-shot-send"
          title="Send the annotated screenshot with a prompt to Claude Code (a connected session or a terminal)"
          aria-haspopup="dialog"
          aria-expanded={sending !== null}
          disabled={!bitmap}
          onClick={() => {
            if (textEdit) commitText();
            setSending(sendContext?.() ?? {});
          }}
        >
          <Icon name="send" size={12} />
          Send to Claude
        </button>
      </div>

      {item.padded ? <PaddingControl item={item} /> : null}

      <div ref={stageRef} class="rl-shot__stage" tabIndex={0} aria-label="Screenshot preview" data-testid="rl-shot-stage">
        <div
          ref={wrapRef}
          class="rl-shot__canvas-wrap"
          style={{ width: `${display.width}px`, height: `${display.height}px` }}
          data-tool={tool}
          data-panning={panning ? '' : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            drag.current = null;
            setDraft(null);
            setPanning(false);
          }}
        >
          <canvas ref={canvasRef} class="rl-shot__canvas" data-testid="rl-shot-canvas" role="img" aria-label={`${MODE_LABELS[item.mode]} screenshot, ${item.width} × ${item.height} pixels`} />
          {textEdit && (
            <textarea
              ref={textRef}
              class="rl-input rl-shot__text-input"
              rows={1}
              style={textStyle}
              value={textEdit.value}
              aria-label="Annotation text (Enter to place, Esc to cancel)"
              data-testid="rl-shot-text-input"
              onInput={(e) => setTextEdit({ ...textEdit, value: e.currentTarget.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  commitText();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  setTextEdit(null);
                }
              }}
              onBlur={commitText}
            />
          )}
        </div>
      </div>

      <div class="rl-shot__meta" data-testid="rl-shot-meta">
        <span>
          <strong>
            {item.width} × {item.height}
          </strong>{' '}
          px
        </span>
        <span>{MODE_LABELS[item.mode]}</span>
        {item.label && <span class="rl-mono rl-truncate">{item.label}</span>}
        {item.host && <span class="rl-mono rl-truncate">{item.host}</span>}
        <span>{item.scale === 1 ? '1×' : `${Math.round(item.scale * 100) / 100}× device pixels`}</span>
        {item.capped && <span class="rl-shot__meta-warn">{item.padded ? 'Cut at the size limit' : 'Page cut at the height limit'}</span>}
        {item.padded
          ? [clippedNote(item.padded.crop.clipped), ...item.padded.notes.filter((n) => !/size limit/.test(n))]
              .filter((n): n is string => !!n)
              .map((n) => (
                <span key={n} class="rl-shot__meta-note" data-testid="rl-shot-note">
                  {n}
                </span>
              ))
          : null}
      </div>
      {sending ? <SendDialog item={item} exportBlob={exportBlob} context={sending} onClose={() => setSending(null)} /> : null}
    </div>
  );
}
