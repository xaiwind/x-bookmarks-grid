// Runs in the page's own JavaScript world on X bookmark pages.
// It watches the bookmark timeline request that X's web client makes, and can repeat that same
// request with a different cursor so the extension can read the whole list without scrolling.
// Nothing is sent anywhere except back to the extension's content script on this page.
(() => {
  if (window.__xBookmarkLibraryHook) return;
  window.__xBookmarkLibraryHook = true;

  const CHANNEL = "x-bookmark-library";
  const REQUEST_TIMEOUT_MS = 40_000;
  const nativeFetch = window.fetch;
  let template = null;

  function operationName(url) {
    try {
      return new URL(String(url), location.origin).pathname.match(/^\/i\/api\/graphql\/[^/]+\/([^/?]+)/)?.[1] || "";
    } catch {
      return "";
    }
  }

  function isBookmarkTimelineOperation(name) {
    return /bookmark/i.test(name) && !/^(create|delete|add|remove|edit|update)/i.test(name) && !/folders|slice/i.test(name);
  }

  function readVariables(request) {
    try {
      if (request.method === "POST") return JSON.parse(request.body || "{}").variables || {};
      return JSON.parse(new URL(request.url).searchParams.get("variables") || "{}");
    } catch {
      return {};
    }
  }

  function remember(request, text) {
    if (typeof text !== "string" || !text.includes('"instructions"')) return;
    const variables = readVariables(request);
    // A folder or a search result is not the whole list, so it never becomes the paging template.
    if (!variables.bookmark_collection_id && !variables.rawQuery) template = request;
    window.postMessage({ channel: CHANNEL, direction: "to-extension", type: "captured", text }, location.origin);
  }

  function buildRequest({ cursor, count }) {
    const headers = { ...template.headers };
    const csrf = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/)?.[1];
    if (csrf) headers["x-csrf-token"] = csrf;
    const variables = { ...readVariables(template) };
    if (cursor) variables.cursor = cursor;
    else delete variables.cursor;
    if (Number.isInteger(count) && count > 0) variables.count = count;
    if (template.method === "POST") {
      const body = { ...JSON.parse(template.body || "{}"), variables };
      return { url: template.url, init: { method: "POST", headers, body: JSON.stringify(body), credentials: "include" } };
    }
    const url = new URL(template.url);
    url.searchParams.set("variables", JSON.stringify(variables));
    return { url: url.href, init: { method: "GET", headers, credentials: "include" } };
  }

  async function fetchPage(payload) {
    if (!template) return { ok: false, status: 0, error: "no_template" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const { url, init } = buildRequest(payload);
      const response = await nativeFetch.call(window, url, { ...init, signal: controller.signal });
      const text = await response.text();
      return response.ok ? { ok: true, status: response.status, text } : { ok: false, status: response.status, error: `X 返回了错误（${response.status}）。` };
    } catch (error) {
      return { ok: false, status: 0, error: error?.name === "AbortError" ? "读取 X 收藏超时。" : "读取 X 收藏时网络异常。" };
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    const proto = XMLHttpRequest.prototype;
    const nativeOpen = proto.open;
    const nativeSend = proto.send;
    const nativeSetHeader = proto.setRequestHeader;
    proto.open = function (method, url) {
      try {
        this.__xBookmarkRequest = isBookmarkTimelineOperation(operationName(url))
          ? { method: String(method || "GET").toUpperCase(), url: new URL(String(url), location.origin).href, headers: {}, body: "" }
          : null;
      } catch {
        this.__xBookmarkRequest = null;
      }
      return nativeOpen.apply(this, arguments);
    };
    proto.setRequestHeader = function (name, value) {
      if (this.__xBookmarkRequest) this.__xBookmarkRequest.headers[String(name).toLowerCase()] = String(value);
      return nativeSetHeader.apply(this, arguments);
    };
    proto.send = function (body) {
      const request = this.__xBookmarkRequest;
      if (request) {
        request.body = typeof body === "string" ? body : "";
        this.addEventListener("load", () => {
          try {
            if (this.status !== 200) return;
            const text = this.responseType === "" || this.responseType === "text" ? this.responseText : JSON.stringify(this.response);
            remember(request, text);
          } catch {}
        });
      }
      return nativeSend.apply(this, arguments);
    };
  } catch {}

  if (typeof nativeFetch === "function") {
    window.fetch = function (input, init) {
      const promise = nativeFetch.apply(this, arguments);
      try {
        const url = typeof input === "string" ? input : input?.url || String(input);
        if (isBookmarkTimelineOperation(operationName(url))) {
          const headers = {};
          new Headers(init?.headers || input?.headers || {}).forEach((value, key) => { headers[key.toLowerCase()] = value; });
          const request = {
            method: String(init?.method || input?.method || "GET").toUpperCase(),
            url: new URL(url, location.origin).href,
            headers,
            body: typeof init?.body === "string" ? init.body : "",
          };
          promise.then((response) => (response.ok ? response.clone().text().then((text) => remember(request, text)) : null)).catch(() => {});
        }
      } catch {}
      return promise;
    };
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== window || event.origin !== location.origin || message?.channel !== CHANNEL || message.direction !== "to-page") return;
    const reply = (payload) => window.postMessage({ channel: CHANNEL, direction: "to-extension", type: "reply", id: message.id, payload }, location.origin);
    if (message.type === "state") reply({ ok: true, ready: Boolean(template) });
    if (message.type === "fetch-page") fetchPage(message.payload || {}).then(reply, () => reply({ ok: false, status: 0, error: "读取 X 收藏失败。" }));
  });
})();
