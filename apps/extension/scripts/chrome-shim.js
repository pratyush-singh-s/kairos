// Chrome build only: the extension is written against Firefox's `browser` API. Chrome has the
// same calls under `chrome` (with promises in Manifest V3), with three differences handled here.
if (typeof globalThis.browser === "undefined" && typeof chrome !== "undefined") {
  const c = chrome;
  // 1. A message listener can't answer by returning a promise; it must call sendResponse.
  const onMessage = {
    addListener(fn) {
      c.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        const answer = fn(msg, sender);
        if (answer && typeof answer.then === "function") {
          answer.then(sendResponse, () => sendResponse(undefined));
          return true;
        }
        if (answer !== undefined) sendResponse(answer);
        return false;
      });
    },
  };
  const runtime = new Proxy(c.runtime, {
    get(target, key) {
      if (key === "onMessage") return onMessage;
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  globalThis.browser = new Proxy(c, {
    get(target, key) {
      if (key === "runtime") return runtime;
      // 2. The toolbar button is `action` in Manifest V3.
      if (key === "browserAction") return target.action;
      return target[key];
    },
  });
  // 3. The background is a service worker, which Chrome stops after 30 s without extension
  // calls. Keep it awake so the link to the Focus app (a long-running request) stays open,
  // and wake it every 30 s if it was stopped anyway.
  if (typeof ServiceWorkerGlobalScope !== "undefined" && globalThis instanceof ServiceWorkerGlobalScope) {
    setInterval(() => void c.runtime.getPlatformInfo(), 20_000);
    c.alarms.create("keep-awake", { periodInMinutes: 0.5 });
    c.alarms.onAlarm.addListener(() => {});
  }
}
