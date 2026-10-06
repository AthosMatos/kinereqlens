// Entry of panel.js: the overlay UI, running in panel.html — an extension page the frame host (ui.js) shows
// in a cross-origin iframe over the page. It talks to the page's store through a RemoteBridge over a
// chrome.runtime Port, and reports where it takes pointer events (hit regions).
import { render } from 'preact';
import { PANEL_PORT_NAME, PANEL_PROTOCOL_VERSION } from '../../shared/panel-protocol';
import { App } from '../App';
import { setUiRoot } from '../components/root';
import { BridgeContext } from '../hooks';
import { ALL_CSS } from '../styles';
import { setControlHandler, startClaudeLink } from './claudeLink';
import { runPanelControl } from './control';
import { watchOverlayActivity } from './activity';
import { watchHitRegions } from './hit';
import { RemoteBridge } from './remote';
import { startTerminals } from '../terminal/session';
import { startUiStateHandoff } from './uiState';
import { installScreenshotTestHook } from '../screenshot/testHook';

async function tabIdOfThisFrame(): Promise<number | null> {
  try {
    const answer: unknown = await chrome.runtime.sendMessage({ type: 'PANEL_TAB' });
    const tabId = (answer as { tabId?: unknown } | undefined)?.tabId;
    return typeof tabId === 'number' && Number.isSafeInteger(tabId) && tabId >= 0 ? tabId : null;
  } catch {
    return null;
  }
}

/** Same structure as the in-page overlay used to have: a shadow root with the adopted styles. */
function createRoot(): { shadow: ShadowRoot; container: HTMLElement } {
  const hostEl = document.getElementById('reqlens-panel') ?? document.body.appendChild(document.createElement('div'));
  const shadow = hostEl.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`:host { all: initial; }\n${ALL_CSS}`);
  shadow.adoptedStyleSheets = [sheet];
  const container = document.createElement('div');
  container.className = 'rl-mount';
  shadow.appendChild(container);
  return { shadow, container };
}

async function main(): Promise<void> {
  // Only meaningful inside the overlay host's frame.
  if (window.top === window) return;
  const tabId = await tabIdOfThisFrame();
  if (tabId === null) return;
  const port = chrome.tabs.connect(tabId, { name: PANEL_PORT_NAME, frameId: 0 });
  const bridge = new RemoteBridge((message) => port.postMessage(message));
  port.onMessage.addListener((message: unknown) => bridge.handle(message));
  port.onDisconnect.addListener(() => bridge.disconnected());
  port.postMessage({ t: 'hello', v: PANEL_PROTOCOL_VERSION, nonce: location.hash.slice(1) });
  await bridge.ready;

  const { shadow, container } = createRoot();
  setUiRoot(container);
  startUiStateHandoff(bridge);
  // Embedded terminal store first: the link's hello makes the worker hand back terminals that outlived a reload.
  startTerminals();
  // Claude Code bridge: status, the worker's queries, "Send to Claude Code" (only while the bridge is on), and the
  // control plane's commands (src/ui/panel/control.ts).
  setControlHandler(runPanelControl);
  startClaudeLink(tabId, bridge);
  render(
    <BridgeContext.Provider value={bridge}>
      <App />
    </BridgeContext.Provider>,
    container,
  );
  // E2E only: the screenshot tool harness (window.__reqlensScreenshot) until the App mounts the tool itself.
  if (__E2E__) installScreenshotTestHook(shadow, bridge);
  watchHitRegions(shadow, (rects) => {
    try {
      port.postMessage({ t: 'hit', rects });
    } catch {
      /* disconnected */
    }
  });
  // What the user does with the overlay: automatic error screenshots never hide it under the user's hands.
  watchOverlayActivity(shadow);
}

void main();
