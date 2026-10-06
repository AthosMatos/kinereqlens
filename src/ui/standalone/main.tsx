// Entry of standalone.js: the standalone React Native tab (static/app.html). The same App as the overlay, in a
// full-tab layout, over a StandaloneBridge fed by the worker (Port 'reqlens-standalone'); settings come from
// chrome.storage.local like in the content script. Opened from Settings → React Native or by the app's dev
// menu ("Open kineReqLens").
import { render } from 'preact';
import { SETTINGS_KEY } from '../../shared/constants';
import { RN_STANDALONE_PORT } from '../../shared/rn-protocol';
import type { StandaloneToWorker, WorkerToStandalone } from '../../shared/rn-protocol';
import { frameScheduler } from '../../content/schedule';
import { SettingsStore } from '../../content/settings';
import type { SettingsStorage } from '../../content/settings';
import { App } from '../App';
import { setUiRoot } from '../components/root';
import { BridgeContext } from '../hooks';
import { startClaudeLink } from '../panel/claudeLink';
import { setRnStatus } from '../rn/status';
import { setShellMode } from '../shellMode';
import { ALL_CSS } from '../styles';
import { startTerminals } from '../terminal/session';
import { StandaloneBridge } from './bridge';
import { TargetPicker } from './TargetPicker';

const RECONNECT_MS = 1000;

function storage(): SettingsStorage {
  return {
    read: async () => (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY],
    write: async (settings) => {
      try {
        await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
        return true;
      } catch {
        return false;
      }
    },
    watch: (listener) => {
      const onChanged = (changes: Record<string, chrome.storage.StorageChange>, areaName: string): void => {
        const change = areaName === 'local' ? changes[SETTINGS_KEY] : undefined;
        if (change) listener(change.newValue);
      };
      chrome.storage.onChanged.addListener(onChanged);
      return () => chrome.storage.onChanged.removeListener(onChanged);
    },
  };
}

function createRoot(): HTMLElement {
  const hostEl = document.getElementById('reqlens-panel') ?? document.body.appendChild(document.createElement('div'));
  const shadow = hostEl.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`:host { all: initial; }\n${ALL_CSS}`);
  shadow.adoptedStyleSheets = [sheet];
  const container = document.createElement('div');
  container.className = 'rl-mount';
  shadow.appendChild(container);
  return container;
}

async function currentTabId(): Promise<number | null> {
  try {
    const tab = await chrome.tabs.getCurrent();
    return typeof tab?.id === 'number' ? tab.id : null;
  } catch {
    return null;
  }
}

function sessionFromHash(): string | null {
  const match = /(?:^|[#&])session=([A-Za-z0-9_-]{1,64})/.exec(location.hash);
  return match ? match[1]! : null;
}

async function main(): Promise<void> {
  setShellMode('standalone');
  const settings = new SettingsStore(storage());
  settings.start();
  await settings.ready;

  let port: chrome.runtime.Port | null = null;
  const bridge = new StandaloneBridge({
    settings,
    post: (message: StandaloneToWorker) => port?.postMessage(message),
    schedule: frameScheduler(window),
    version: chrome.runtime.getManifest().version,
  });
  const initial = sessionFromHash();
  if (initial) bridge.select(initial);

  const connect = (): void => {
    const next = chrome.runtime.connect({ name: RN_STANDALONE_PORT });
    port = next;
    bridge.reconnected();
    next.onMessage.addListener((message: unknown) => {
      const m = message as WorkerToStandalone;
      if (m && m.t === 'status') setRnStatus(m.status);
      // Keep the shown app in the URL, so reloading the tab shows it again.
      if (m && m.t === 'select' && /^[A-Za-z0-9_-]{1,64}$/.test(m.session)) history.replaceState(null, '', `#session=${m.session}`);
      bridge.handle(message);
    });
    next.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (port !== next) return;
      port = null;
      bridge.disconnected();
      // The worker restarted (or the extension reloaded): reconnect; the worker re-sends what it buffered.
      setTimeout(connect, RECONNECT_MS);
    });
    next.postMessage({ t: 'hello', v: 1 } satisfies StandaloneToWorker);
  };
  connect();

  // A link with another #session= selects that app.
  window.addEventListener('hashchange', () => {
    const session = sessionFromHash();
    if (session) bridge.select(session);
  });

  const container = createRoot();
  setUiRoot(container);
  startTerminals();
  const tabId = await currentTabId();
  if (tabId !== null) startClaudeLink(tabId, bridge);
  render(
    <BridgeContext.Provider value={bridge}>
      <App standalone headerExtra={<TargetPicker bridge={bridge} />} />
    </BridgeContext.Provider>,
    container,
  );
  if (__E2E__) (globalThis as { __reqlensStandalone?: StandaloneBridge }).__reqlensStandalone = bridge;
}

void main();
