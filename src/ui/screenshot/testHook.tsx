// E2E build only (panel/main.tsx calls it under `if (__E2E__)`): pixel probes of the captures for the tests, plus
// a harness that mounts a second screenshot tool in its own popup over the panel (the App shows the tool from its
// navigation rail: tests/e2e/screenshot.spec.ts opens it there).
//   window.__reqlensScreenshot.mount()        show the tool (bottom-left popup, `rl-shot-harness`)
//   window.__reqlensScreenshot.unmount()
//   window.__reqlensScreenshot.latest()       {id, mode, width, height, scale, padding?…} of the newest capture
//   window.__reqlensScreenshot.pixels(pts)    [r, g, b, a] of the newest capture at image px points
//   window.__reqlensScreenshot.shot(args)     runShotCommand (the MCP `screenshot` handler), image data left out
//   window.__reqlensScreenshot.find(args)     runFindCommand (the MCP `find_in_page` handler)
import { render } from 'preact';
import { BridgeContext, useResolvedTheme } from '../hooks';
import type { ReqlensBridge } from '../../shared/types';
import type { FindCommandArgs, FindCommandResult, ShotCommandArgs, ShotCommandResult } from '../../shared/control-shot';
import { runFindCommand, runShotCommand } from '../control/shot';
import { ScreenshotTool } from './ScreenshotTool';
import { isControlHost } from './open';
import { getShots } from './store';

/** A ShotCommandResult without the base64 data (sizes and types only). */
export type ShotCommandSummary = Omit<ShotCommandResult, 'image' | 'preview'> & {
  image: Omit<ShotCommandResult['image'], 'data'> & { bytes: number };
  preview: Omit<ShotCommandResult['preview'], 'data'> & { bytes: number };
};

export interface ScreenshotTestHook {
  mount(): void;
  unmount(): void;
  latest(): {
    id: string;
    mode: string;
    width: number;
    height: number;
    scale: number;
    annotations: number;
    count: number;
    /** Padded captures: the padding shown, the re-crop limit (-1: the page edges), the captured area's picture size. */
    padding?: number;
    limit?: number;
    source?: { width: number; height: number };
    label?: string;
  } | null;
  pixels(points: Array<[number, number]>): Promise<Array<[number, number, number, number]>>;
  shot(args: ShotCommandArgs): Promise<ShotCommandSummary>;
  find(args: FindCommandArgs): Promise<FindCommandResult>;
}

function Harness({ onClose }: { onClose: () => void }) {
  const theme = useResolvedTheme();
  return (
    <div class="rl-root" data-theme={theme}>
      <div
        class="rl-popup"
        data-testid="rl-shot-harness"
        style={{ left: '12px', bottom: '12px', width: 'min(640px, calc(100vw - 24px))', height: 'min(560px, calc(100vh - 24px))', maxWidth: 'none', padding: 0, overflow: 'hidden' }}
      >
        <ScreenshotTool onClose={onClose} />
      </div>
    </div>
  );
}

/** Install `window.__reqlensScreenshot` (E2E build only). */
export function installScreenshotTestHook(shadow: ShadowRoot, bridge: ReqlensBridge): void {
  let container: HTMLElement | null = null;
  const hook: ScreenshotTestHook = {
    mount() {
      if (container) return;
      container = document.createElement('div');
      container.className = 'rl-mount';
      shadow.appendChild(container);
      render(
        <BridgeContext.Provider value={bridge}>
          <Harness onClose={() => hook.unmount()} />
        </BridgeContext.Provider>,
        container,
      );
    },
    unmount() {
      if (!container) return;
      render(null, container);
      container.remove();
      container = null;
    },
    latest() {
      const s = getShots()[0];
      if (!s) return null;
      const out: ReturnType<ScreenshotTestHook['latest']> = {
        id: s.id,
        mode: s.mode,
        width: s.width,
        height: s.height,
        scale: s.scale,
        annotations: s.annotations.length,
        count: getShots().length,
      };
      if (s.label) out.label = s.label;
      if (s.padded) {
        out.padding = s.padded.padding;
        out.limit = Number.isFinite(s.padded.limit) ? Math.floor(s.padded.limit) : -1;
        out.source = { width: s.padded.source.width, height: s.padded.source.height };
      }
      return out;
    },
    async pixels(points) {
      const s = getShots()[0];
      if (!s) return [];
      const bitmap = await createImageBitmap(s.blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      return points.map(([x, y]) => {
        const d = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
        return [d[0]!, d[1]!, d[2]!, d[3]!];
      });
    },
    async shot(args) {
      const result = await runShotCommand(args, isControlHost(bridge) ? { host: bridge } : undefined);
      const strip = (img: ShotCommandResult['image']) => ({ mimeType: img.mimeType, width: img.width, height: img.height, bytes: Math.floor((img.data.length * 3) / 4) });
      return { ...result, image: strip(result.image), preview: strip(result.preview) };
    },
    find(args) {
      return runFindCommand(args, isControlHost(bridge) ? { host: bridge } : undefined);
    },
  };
  (window as unknown as { __reqlensScreenshot?: ScreenshotTestHook }).__reqlensScreenshot = hook;
}
