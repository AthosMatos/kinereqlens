// Registration of the chrome.webRequest listeners.
//
// MV3: listeners must be added synchronously during the worker's first evaluation so events wake the
// worker. They are added unconditionally at startup; once tab state is loaded, they are removed while no
// tab has the overlay open (so ordinary browsing never wakes the worker or pays for `extraHeaders`) and
// re-added when a tab opens it.
type Wr = typeof chrome.webRequest;

export interface WebRequestHandlers {
  onBeforeRequest(details: chrome.webRequest.OnBeforeRequestDetails): void;
  onSendHeaders(details: chrome.webRequest.OnSendHeadersDetails): void;
  onHeadersReceived(details: chrome.webRequest.OnHeadersReceivedDetails): void;
  onBeforeRedirect(details: chrome.webRequest.OnBeforeRedirectDetails): void;
  onCompleted(details: chrome.webRequest.OnCompletedDetails): void;
  onErrorOccurred(details: chrome.webRequest.OnErrorOccurredDetails): void;
}

export interface WebRequestRegistration {
  /** Add (true) or remove (false) every listener; idempotent. */
  setActive(active: boolean): void;
  readonly active: boolean;
}

const FILTER: chrome.webRequest.RequestFilter = { urls: ['<all_urls>'] };

/** Adds the listeners immediately (call synchronously at top level) and returns a switch. */
export function registerWebRequestListeners(handlers: WebRequestHandlers, wr: Wr = chrome.webRequest): WebRequestRegistration {
  // Wrap once so add/remove use the same function identities.
  const onBeforeRequest = (d: chrome.webRequest.OnBeforeRequestDetails): undefined => {
    handlers.onBeforeRequest(d);
    return undefined;
  };
  const onSendHeaders = (d: chrome.webRequest.OnSendHeadersDetails): void => handlers.onSendHeaders(d);
  const onHeadersReceived = (d: chrome.webRequest.OnHeadersReceivedDetails): undefined => {
    handlers.onHeadersReceived(d);
    return undefined;
  };
  const onBeforeRedirect = (d: chrome.webRequest.OnBeforeRedirectDetails): void => handlers.onBeforeRedirect(d);
  const onCompleted = (d: chrome.webRequest.OnCompletedDetails): void => handlers.onCompleted(d);
  const onErrorOccurred = (d: chrome.webRequest.OnErrorOccurredDetails): void => handlers.onErrorOccurred(d);

  let active = false;
  const add = (): void => {
    wr.onBeforeRequest.addListener(onBeforeRequest, FILTER, ['requestBody']);
    wr.onSendHeaders.addListener(onSendHeaders, FILTER, ['requestHeaders', 'extraHeaders']);
    wr.onHeadersReceived.addListener(onHeadersReceived, FILTER, ['responseHeaders', 'extraHeaders']);
    wr.onBeforeRedirect.addListener(onBeforeRedirect, FILTER);
    wr.onCompleted.addListener(onCompleted, FILTER);
    wr.onErrorOccurred.addListener(onErrorOccurred, FILTER);
  };
  const remove = (): void => {
    wr.onBeforeRequest.removeListener(onBeforeRequest);
    wr.onSendHeaders.removeListener(onSendHeaders);
    wr.onHeadersReceived.removeListener(onHeadersReceived);
    wr.onBeforeRedirect.removeListener(onBeforeRedirect);
    wr.onCompleted.removeListener(onCompleted);
    wr.onErrorOccurred.removeListener(onErrorOccurred);
  };

  const registration: WebRequestRegistration = {
    get active() {
      return active;
    },
    setActive(next: boolean) {
      if (next === active) return;
      active = next;
      try {
        if (next) add();
        else remove();
      } catch (err) {
        console.error('[kineReqLens] webRequest listener update failed', err);
      }
    },
  };
  registration.setActive(true);
  return registration;
}
