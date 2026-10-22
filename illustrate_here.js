/**
 * Illustrate Here — 이 메시지 그리기 v1.0.0
 *
 * AI 메시지의 동작 줄(복사·편집·삭제가 있는 줄) 삭제 단추 앞에 붙는 그림 아이콘으로, 그 메시지 시점의 장면을
 * 내장 일러스트레이터 에이전트에게 그리게 하는 확장.
 * 엔진의 POST /api/generate/retry-agents 로 일러스트레이터 에이전트를 그대로 다시 돌린다
 * (forMessageId 로 메시지만 지정). 자동으로 돌 때와 같은 지시문·같은 모델 설정으로 돌고,
 * 그릴지 말지도 에이전트가 정한다.
 *
 * 갤러리의 그리기 버튼이 쓰는 illustratorRetryTargets 는 붙이지 않는다. 그 경로는 에이전트를
 * 돌리지 않고 별도의 그림 설명 작성기를 쓴다(v2.4.6 기준).
 *
 * 일러스트레이터는 채팅에 켜 두면 몇 메시지마다 스스로 돌기 때문에, 이 확장은
 * 버튼을 누른 동안에만 채팅의 에이전트 목록에 넣었다가 실행이 시작되면 바로 뺀다.
 *
 * 런타임: Browser (client), 전체 페이지 접근 필요.
 * 라이선스: AGPL-3.0
 */
(function (marinara) {
  "use strict";

  const host = marinara || {};
  const AGENT = "illustrator";
  const CHAT_KEY = "marinara-active-chat-id";
  const PENDING_KEY = "illustrate-here:pending-restore";

  /* ═══════════════════════ 상태 ═══════════════════════ */

  const S = {
    busyId: null,        // 그리는 중인 메시지 ID
    busyChatId: null,
    abort: null,
    results: new Map(),  // 메시지 ID → 이번 세션에 그린 이미지 주소들
    toastTimer: 0,
    frame: 0,
  };
  const MARK = "data-illh-for";

  const cleanups = [];
  const on = (target, event, handler, options) => {
    target.addEventListener(event, handler, options);
    cleanups.push(() => target.removeEventListener(event, handler, options));
  };
  const parseJson = (v) => {
    if (v && typeof v === "object") return v;
    try { return JSON.parse(v || "{}") || {}; } catch (e) { return {}; }
  };

  /* ═══════════════════════ 아이콘 ═══════════════════════ */

  const ICON_PICTURE =
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3" y="4" width="14" height="12" rx="2.5"/><circle cx="7.5" cy="8.5" r="1.2"/>' +
    '<path d="m3.5 14 3.5-3.5 3 3 2-2 4.5 4"/></svg>';
  const ICON_SPIN = '<span class="illh-spin" aria-hidden="true"></span>';

  /* ═══════════════════════ API ═══════════════════════ */

  function writeHeaders(extra) {
    const headers = new Headers(extra || {});
    headers.set("x-marinara-csrf", "1");
    headers.set("Content-Type", "application/json");
    return headers;
  }

  async function api(path, opts = {}) {
    if (typeof host.apiFetch === "function") return host.apiFetch(path, opts);
    const method = (opts.method || "GET").toUpperCase();
    const write = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
    const response = await fetch(`/api${path}`, {
      ...opts,
      method,
      headers: write ? writeHeaders(opts.headers) : opts.headers,
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error((body && (body.error || body.message)) || `Marinara API 오류 (${response.status})`);
    }
    return response.status === 204 ? undefined : response.json();
  }

  const chatPath = (chatId) => `/chats/${encodeURIComponent(chatId)}`;

  /* ═══════════════ 일러스트레이터 잠깐 켜기 · 되돌리기 ═══════════════ */

  function readPending() {
    try { return JSON.parse(localStorage.getItem(PENDING_KEY) || "null"); } catch (e) { return null; }
  }
  function writePending(value) {
    try {
      if (value) localStorage.setItem(PENDING_KEY, JSON.stringify(value));
      else localStorage.removeItem(PENDING_KEY);
    } catch (e) {}
  }

  // 수동 실행은 채팅의 에이전트 목록에 있는 에이전트만 돌린다.
  // 무엇을 바꿨는지 먼저 적어 두어, 도중에 페이지가 닫혀도 다음에 되돌릴 수 있게 한다.
  async function turnOn(chatId) {
    const chat = await api(chatPath(chatId));
    const meta = parseJson(chat && chat.metadata);
    const ids = Array.isArray(meta.activeAgentIds) ? meta.activeAgentIds : [];
    const added = !ids.includes(AGENT);
    const enabled = meta.enableAgents === false || meta.enableAgents === "false";
    if (!added && !enabled) return;
    const patch = {};
    if (added) patch.activeAgentIds = [...ids, AGENT];
    if (enabled) patch.enableAgents = true;
    writePending({ chatId, added, enabled, enableAgents: meta.enableAgents });
    await api(`${chatPath(chatId)}/metadata`, { method: "PATCH", body: JSON.stringify(patch) });
  }

  // 이 확장이 바꾼 것만 되돌린다. 그사이 사용자가 바꾼 다른 에이전트 설정은 그대로 둔다.
  async function restore() {
    const pending = readPending();
    if (!pending || !pending.chatId) return;
    const chat = await api(chatPath(pending.chatId));
    const meta = parseJson(chat && chat.metadata);
    const ids = Array.isArray(meta.activeAgentIds) ? meta.activeAgentIds : [];
    const patch = {};
    if (pending.added && ids.includes(AGENT)) patch.activeAgentIds = ids.filter((id) => id !== AGENT);
    if (pending.enabled && meta.enableAgents === true) patch.enableAgents = pending.enableAgents;
    if (Object.keys(patch).length) {
      await api(`${chatPath(pending.chatId)}/metadata`, { method: "PATCH", body: JSON.stringify(patch) });
    }
    writePending(null);
  }

  /* ═══════════════════ 엔진 화면 새로 읽히기 ═══════════════════ */

  // 엔진 화면은 메시지·갤러리를 캐시(React Query)로 그린다. 그 캐시를 찾아 이 채팅 것만
  // 다시 읽게 하면, 엔진이 그린 그림을 메시지 아래와 갤러리에 직접 보여 준다.
  function findQueryClient() {
    const container = [...document.body.children].find((node) =>
      Object.keys(node).some((key) => key.startsWith("__reactContainer$")),
    );
    if (!container) return null;
    const key = Object.keys(container).find((k) => k.startsWith("__reactContainer$"));
    const queue = [container[key]];
    for (let seen = 0; queue.length && seen < 4000; seen++) {
      const fiber = queue.shift();
      if (!fiber) continue;
      const client = fiber.memoizedProps && fiber.memoizedProps.client;
      if (client && typeof client.invalidateQueries === "function") return client;
      if (fiber.child) queue.push(fiber.child);
      if (fiber.sibling) queue.push(fiber.sibling);
    }
    return null;
  }

  function refreshEngine(chatId) {
    try {
      const client = findQueryClient();
      if (!client) return false;
      client.invalidateQueries({
        predicate: (query) =>
          Array.isArray(query.queryKey) &&
          query.queryKey.includes(chatId) &&
          (query.queryKey[0] === "gallery" || query.queryKey.includes("messages")),
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ═══════════════════════ 그리기 ═══════════════════════ */

  async function readEvents(body, onEvent) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const flush = (block) => {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) return;
      try { onEvent(JSON.parse(data)); } catch (e) {}
    };
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const blocks = buffer.replace(/\r\n/g, "\n").split("\n\n");
      buffer = done ? "" : blocks.pop();
      blocks.forEach(flush);
      if (done) return;
    }
  }

  async function illustrate(messageId) {
    if (S.busyId || !messageId) return;
    let chatId = null;
    try { chatId = localStorage.getItem(CHAT_KEY); } catch (e) {}
    if (!chatId) {
      toast("열린 채팅을 찾지 못했습니다. 채팅을 다시 열고 눌러 주세요.", "err");
      return;
    }

    const abort = new AbortController();
    S.busyId = messageId;
    S.busyChatId = chatId;
    S.abort = abort;
    render();

    const urls = [];
    let error = "";
    let declined = null; // 에이전트가 그리지 않기로 했을 때의 이유
    let restoring = null;
    try {
      await restore();
      await turnOn(chatId);
      const response = await fetch("/api/generate/retry-agents", {
        method: "POST",
        headers: writeHeaders(),
        credentials: "same-origin",
        cache: "no-store",
        signal: abort.signal,
        body: JSON.stringify({
          chatId,
          agentTypes: [AGENT],
          forMessageId: messageId,
        }),
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => null);
        throw new Error((body && (body.error || body.message)) || `HTTP ${response.status}`);
      }
      await readEvents(response.body, (event) => {
        const data = event.data;
        if (event.type === "agent_start") {
          // 서버가 에이전트 목록을 읽은 뒤다. 자동 실행에 끼지 않게 바로 뺀다
          restoring = restore().catch(() => {});
        } else if (event.type === "illustration" && data && data.imageUrl) {
          urls.push(String(data.imageUrl));
        } else if (event.type === "agent_error" && data && data.error) {
          error = String(data.error);
        } else if (event.type === "agent_result" && data && data.success === false && data.error) {
          error = error || String(data.error);
        } else if (event.type === "agent_result" && data && data.data && typeof data.data === "object") {
          if (data.agentType === AGENT && data.data.shouldGenerate !== true) {
            const text = data.data.reason || data.data.raw || "";
            declined = typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, 160) : "";
          }
        } else if (event.type === "error") {
          error = String(data || "알 수 없는 오류");
        }
      });
    } catch (e) {
      if (!abort.signal.aborted) error = (e && e.message) || String(e);
    }

    let restored = true;
    try {
      await restoring;
      await restore();
    } catch (e) {
      restored = false;
    }

    S.busyId = null;
    S.busyChatId = null;
    S.abort = null;
    render();

    // 엔진이 직접 보여 주지 못할 때만 메시지 아래에 임시로 보여 준다
    if (urls.length && !refreshEngine(chatId)) {
      S.results.set(messageId, urls);
      syncCards();
    }
    if (!restored) {
      toast("일러스트레이터가 이 채팅에 켜진 채로 남았습니다. 채팅 설정의 에이전트에서 꺼 주세요.", "err", true);
    } else if (urls.length) {
      toast("그림을 붙였습니다.");
    } else if (error) {
      toast("그리지 못했습니다: " + error, "err");
    } else if (!abort.signal.aborted) {
      toast(
        declined !== null
          ? "일러스트레이터가 이 장면은 그리지 않기로 했습니다." + (declined ? " 이유: " + declined : "")
          : "일러스트레이터가 그림을 내놓지 않았습니다. 다시 눌러 보세요.",
        "err",
      );
    }
  }

  /* ═══════════════════════ 화면 ═══════════════════════ */

  const rootEl = document.createElement("div");
  rootEl.id = "illh-root";
  const toastEl = document.createElement("p");
  toastEl.id = "illh-toast";
  toastEl.setAttribute("role", "status");
  toastEl.setAttribute("aria-live", "polite");
  rootEl.appendChild(toastEl);
  document.body.appendChild(rootEl);

  const styleEl = document.createElement("style");
  styleEl.dataset.illustrateHereStyle = "true";
  styleEl.textContent = `
    #illh-root {
      position: fixed; inset: 0; z-index: 99997; pointer-events: none;
      font-family: inherit; font-size: 13px; line-height: 1.45;
      -webkit-font-smoothing: antialiased;
    }
    .illh-btn svg { width: 1em; height: 1em; flex: none; }
    .illh-btn[aria-busy="true"] { color: var(--marinara-chat-message-action-text-hover, currentColor); }

    .illh-spin {
      width: 0.85em; height: 0.85em; flex: none; border-radius: 50%;
      border: 2px solid currentColor; border-right-color: transparent;
      animation: illh-turn 700ms linear infinite;
    }
    @keyframes illh-turn { to { rotate: 360deg; } }

    #illh-toast {
      position: absolute; left: 50%; bottom: 96px; translate: -50% 6px;
      max-width: min(520px, calc(100vw - 32px)); margin: 0; padding: 8px 14px;
      border: 1px solid var(--border, rgba(127,127,127,0.35)); border-radius: 10px;
      background: var(--card, #18181b); color: var(--foreground, #f4f4f5);
      box-shadow: 0 12px 32px -12px rgba(0,0,0,0.55);
      text-wrap: pretty; overflow-wrap: anywhere;
      opacity: 0; visibility: hidden; pointer-events: none;
      transition: opacity 160ms ease-out, translate 160ms ease-out, visibility 0s 160ms;
    }
    #illh-toast.illh-show {
      opacity: 1; visibility: visible; translate: -50% 0; pointer-events: auto;
      transition-delay: 0s;
    }
    #illh-toast.illh-err { border-color: #e5484d; }

    .illh-card { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
    .illh-card a { display: block; line-height: 0; border-radius: 10px; overflow: hidden; }
    .illh-card img {
      display: block; max-width: min(360px, 100%); max-height: 360px; border-radius: 10px;
      outline: 1px solid rgba(127,127,127,0.25); outline-offset: -1px;
    }

    @media (prefers-reduced-motion: reduce) {
      #illh-toast { transition-duration: 1ms; }
      .illh-spin { animation-duration: 2s; }
    }
  `;
  document.head.appendChild(styleEl);

  function toast(text, kind, sticky) {
    clearTimeout(S.toastTimer);
    toastEl.textContent = text;
    toastEl.className = "illh-show" + (kind ? " illh-" + kind : "");
    if (!sticky) S.toastTimer = setTimeout(hideToast, kind === "err" ? 8000 : 3000);
  }
  function hideToast() {
    clearTimeout(S.toastTimer);
    toastEl.className = "";
  }

  function isAssistant(el) {
    const role = el.getAttribute("data-message-role");
    return role ? role === "assistant" : !el.classList.contains("mari-message-user");
  }

  function findMessage(id) {
    return [...document.querySelectorAll("[data-message-id]")].find((el) => el.getAttribute("data-message-id") === id);
  }

  // 엔진 동작 단추와 같은 클래스를 써서 테마·크기·폰 폭 배치를 그대로 따른다
  const ENGINE_BTN_CLASS =
    "mari-chat-style-control mari-chat-message-action [-webkit-tap-highlight-color:transparent] inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 text-base leading-none transition-colors md:transition-all md:active:scale-90 max-md:h-8 max-md:w-7 max-md:max-w-full max-md:text-sm max-md:active:bg-[var(--marinara-chat-message-action-bg-hover)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-30 " +
    "text-[var(--marinara-chat-message-action-text)] [@media(pointer:fine)]:hover:bg-[var(--marinara-chat-message-action-bg-hover)] [@media(pointer:fine)]:hover:text-[var(--marinara-chat-message-action-text-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)]";

  function makeButton(messageId) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "illh-btn " + ENGINE_BTN_CLASS;
    b.setAttribute(MARK, messageId);
    b.addEventListener("click", (event) => {
      event.stopPropagation();
      if (S.busyId === messageId) cancel();
      else illustrate(messageId);
    });
    return b;
  }

  // 자리: 동작 줄의 삭제(휴지통) 단추 바로 앞. 휴지통이 없으면 줄 끝
  function slotFor(el) {
    const bar = [...el.querySelectorAll(".mari-message-actions")].find(
      (b) => b.closest("[data-message-id]") === el,
    );
    if (!bar) return null;
    const trash = bar.querySelector(":scope > button svg.lucide-trash-2, :scope > button svg.lucide-trash");
    return { parent: bar, before: trash ? trash.closest("button") : null };
  }

  function syncButtons() {
    const live = new Set();
    for (const el of document.querySelectorAll("[data-message-id]")) {
      const id = el.getAttribute("data-message-id");
      if (!id || !isAssistant(el) || el.querySelector("[data-chat-message-editor]")) continue;
      const slot = slotFor(el);
      if (!slot) continue;
      let b = slot.parent.querySelector(`:scope > .illh-btn[${MARK}="${CSS.escape(id)}"]`);
      if (!b) b = makeButton(id);
      // 엔진이 줄을 다시 그리며 단추가 끝으로 밀렸으면 휴지통 앞으로 되돌린다
      if (b.parentElement !== slot.parent || (slot.before ? b.nextElementSibling !== slot.before : b !== slot.parent.lastElementChild)) {
        slot.parent.insertBefore(b, slot.before);
      }
      live.add(b);
      const busy = S.busyId === id;
      const state = busy ? "busy" : S.busyId ? "wait" : "idle";
      if (b._illhState !== state) {
        b._illhState = state;
        b.innerHTML = busy ? ICON_SPIN : ICON_PICTURE;
        const label = busy ? "그리기 취소" : "이 메시지 그리기";
        b.title = label;
        b.setAttribute("aria-label", label);
        b.setAttribute("aria-busy", busy ? "true" : "false");
        // 한 번에 한 메시지만 그린다
        b.disabled = state === "wait";
      }
    }
    document.querySelectorAll(".illh-btn").forEach((b) => {
      if (!live.has(b)) b.remove();
    });
  }

  function render() {
    schedule();
  }

  function schedule() {
    if (S.frame) return;
    S.frame = requestAnimationFrame(() => {
      S.frame = 0;
      observer.disconnect();
      try {
        syncButtons();
      } finally {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    });
  }

  const observer = new MutationObserver(schedule);

  // 엔진 화면을 새로 읽히지 못했을 때의 대비책. 엔진이 직접 보여 줄 때까지 메시지 아래에 임시로 보여 준다.
  function syncCards() {
    for (const [id, urls] of S.results) {
      const el = findMessage(id);
      if (!el) continue;
      const names = urls.map((url) => url.split("/").pop());
      const shown = [...el.querySelectorAll("img")].some(
        (img) => !img.classList.contains("illh-img") && names.some((n) => (img.getAttribute("src") || "").includes(n)),
      );
      const card = el.querySelector(".illh-card");
      if (shown) {
        if (card) card.remove();
        S.results.delete(id);
        continue;
      }
      if (card) continue;
      const next = document.createElement("div");
      next.className = "illh-card";
      urls.forEach((url) => {
        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener";
        const img = document.createElement("img");
        img.className = "illh-img";
        img.src = url;
        img.alt = "그린 그림";
        link.appendChild(img);
        next.appendChild(link);
      });
      (el.querySelector(".mari-message-body") || el).appendChild(next);
    }
  }

  /* ═══════════════════════ 동작 ═══════════════════════ */

  function cancel() {
    // 최신 엔진은 연결이 끊겨도 일러스트레이터를 끝까지 돌린다. 멈춤을 따로 요청한다
    if (S.busyChatId) {
      api("/generate/abort", { method: "POST", body: JSON.stringify({ chatId: S.busyChatId, agentsOnly: true }) }).catch(() => {});
    }
    if (S.abort) S.abort.abort();
  }

  on(toastEl, "click", hideToast);
  observer.observe(document.body, { childList: true, subtree: true });

  const cardTimer = setInterval(syncCards, 1500);

  render();
  // 지난번에 되돌리지 못하고 닫혔다면 지금 되돌린다
  restore().catch(() => {
    toast("일러스트레이터가 채팅에 켜진 채로 남았습니다. 채팅 설정의 에이전트에서 꺼 주세요.", "err", true);
  });

  const cleanup = () => {
    if (S.abort) S.abort.abort();
    clearInterval(cardTimer);
    observer.disconnect();
    clearTimeout(S.toastTimer);
    if (S.frame) cancelAnimationFrame(S.frame);
    for (const fn of cleanups.splice(0).reverse()) fn();
    document.querySelectorAll(".illh-card, .illh-btn").forEach((node) => node.remove());
    styleEl.remove();
    rootEl.remove();
  };
  if (typeof host.onCleanup === "function") host.onCleanup(cleanup);
})(marinara);
