// Annotation model + canvas rendering of the screenshot tool. Coordinates are image px; the preview draws at
// `k` canvas px per image px, the export at k = 1 (full resolution).
import { arrowHead, normalizeRect, pixelateBlock } from '../../lib/screenshot';

export type AnnotationTool = 'rect' | 'arrow' | 'text' | 'pixelate';

export type Annotation =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; color: string; width: number }
  | { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  | { kind: 'text'; x: number; y: number; text: string; color: string; size: number }
  | { kind: 'pixelate'; x: number; y: number; w: number; h: number; block: number };

/** Annotation colors (high-contrast on screenshots in either theme). */
export const ANNOTATION_COLORS = [
  { id: 'red', label: 'Red', value: '#e5332a' },
  { id: 'amber', label: 'Amber', value: '#f0ac1f' },
  { id: 'blue', label: 'Blue', value: '#0230bb' },
  { id: 'green', label: 'Green', value: '#1ba84b' },
] as const;

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Stroke width / font size scaled with the capture (a 2× capture gets 2× lines). */
export function strokeFor(scale: number): number {
  return Math.max(2, Math.round(3 * scale));
}
export function fontFor(scale: number): number {
  return Math.max(14, Math.round(20 * scale));
}

/** Build the annotation a drag from (x1, y1) to (x2, y2) makes with `tool` (null when too small). */
export function annotationFromDrag(tool: Exclude<AnnotationTool, 'text'>, x1: number, y1: number, x2: number, y2: number, color: string, scale: number): Annotation | null {
  const min = 3 * Math.max(1, scale);
  if (tool === 'arrow') {
    if (Math.hypot(x2 - x1, y2 - y1) < min) return null;
    return { kind: 'arrow', x1, y1, x2, y2, color, width: strokeFor(scale) };
  }
  const r = normalizeRect({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
  if (r.width < min || r.height < min) return null;
  if (tool === 'rect') return { kind: 'rect', x: r.x, y: r.y, w: r.width, h: r.height, color, width: strokeFor(scale) };
  return { kind: 'pixelate', x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), block: pixelateBlock(r, scale) };
}

function textFont(size: number): string {
  return `600 ${size}px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`;
}

/** Pixelate a region of `base` (image px) onto `ctx`: average blocks, then scale up without smoothing. */
function drawPixelated(ctx: Ctx, base: CanvasImageSource, a: Extract<Annotation, { kind: 'pixelate' }>, k: number, image: { width: number; height: number }): void {
  const x = Math.max(0, Math.min(image.width, a.x));
  const y = Math.max(0, Math.min(image.height, a.y));
  const w = Math.min(image.width - x, a.w);
  const h = Math.min(image.height - y, a.h);
  if (w <= 0 || h <= 0) return;
  const block = Math.max(1, a.block);
  const sw = Math.max(1, Math.ceil(w / block));
  const sh = Math.max(1, Math.ceil(h / block));
  const small = new OffscreenCanvas(sw, sh);
  const sctx = small.getContext('2d');
  if (!sctx) return;
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(base, x, y, w, h, 0, 0, sw, sh);
  const smoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, sw, sh, x * k, y * k, w * k, h * k);
  ctx.imageSmoothingEnabled = smoothing;
}

/** Draw `annotations` over an already drawn base image (`k` canvas px per image px). */
export function drawAnnotations(ctx: Ctx, base: CanvasImageSource, annotations: readonly Annotation[], k: number, image: { width: number; height: number }): void {
  for (const a of annotations) {
    ctx.save();
    switch (a.kind) {
      case 'pixelate':
        drawPixelated(ctx, base, a, k, image);
        break;
      case 'rect':
        ctx.strokeStyle = a.color;
        ctx.lineWidth = a.width * k;
        ctx.lineJoin = 'round';
        ctx.strokeRect(a.x * k, a.y * k, a.w * k, a.h * k);
        break;
      case 'arrow': {
        ctx.strokeStyle = a.color;
        ctx.fillStyle = a.color;
        ctx.lineWidth = a.width * k;
        ctx.lineCap = 'round';
        const head = Math.max(10, a.width * 4.5);
        // The shaft stops inside the head so its round cap never pokes through the tip.
        const len = Math.hypot(a.x2 - a.x1, a.y2 - a.y1) || 1;
        const back = Math.min(len, head * 0.6);
        const sx = a.x2 - ((a.x2 - a.x1) / len) * back;
        const sy = a.y2 - ((a.y2 - a.y1) / len) * back;
        ctx.beginPath();
        ctx.moveTo(a.x1 * k, a.y1 * k);
        ctx.lineTo(sx * k, sy * k);
        ctx.stroke();
        const [[lx, ly], [rx, ry]] = arrowHead(a.x1, a.y1, a.x2, a.y2, head);
        ctx.beginPath();
        ctx.moveTo(a.x2 * k, a.y2 * k);
        ctx.lineTo(lx * k, ly * k);
        ctx.lineTo(rx * k, ry * k);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'text': {
        ctx.font = textFont(a.size * k);
        ctx.textBaseline = 'top';
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(2, (a.size / 5) * k);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
        const lines = a.text.split('\n');
        lines.forEach((line, i) => {
          const ly = (a.y + i * a.size * 1.25) * k;
          ctx.strokeText(line, a.x * k, ly);
          ctx.fillStyle = a.color;
          ctx.fillText(line, a.x * k, ly);
        });
        break;
      }
    }
    ctx.restore();
  }
}

/** Full-resolution PNG of `base` with `annotations` burnt in (the base PNG itself when there are none). */
export async function exportAnnotated(base: ImageBitmap, original: Blob, annotations: readonly Annotation[]): Promise<Blob> {
  if (annotations.length === 0) return original;
  const canvas = new OffscreenCanvas(base.width, base.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.drawImage(base, 0, 0);
  drawAnnotations(ctx, base, annotations, 1, base);
  return canvas.convertToBlob({ type: 'image/png' });
}

/**
 * Annotations moved by (dx, dy) image px: when a padded capture is cropped again with another padding, the picture's
 * origin moves and the annotations follow the page content they were drawn on.
 */
export function shiftAnnotations(annotations: readonly Annotation[], dx: number, dy: number): Annotation[] {
  if (!dx && !dy) return annotations.slice();
  return annotations.map((a): Annotation => {
    switch (a.kind) {
      case 'arrow':
        return { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy };
      case 'pixelate':
        return { ...a, x: Math.round(a.x + dx), y: Math.round(a.y + dy) };
      default:
        return { ...a, x: a.x + dx, y: a.y + dy };
    }
  });
}
