// OWNER: capture-page agent. Isolated-world content script (all frames): hook bridge, store, UI loader.
// See docs/ARCHITECTURE.md §2.1–2.4 and §4.2; the runtime lives in ./app.ts, start-up in ./boot.ts.
import { bootContentScript } from './boot';

try {
  bootContentScript();
} catch {
  // kineReqLens must never break the page it runs in.
}
