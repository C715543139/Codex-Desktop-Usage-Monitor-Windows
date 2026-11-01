// SPDX-License-Identifier: AGPL-3.0-only
// Saving workflow adapted from CodexPlusPlus v2.1.4 / 85-side-chat-save.js.
(() => {
  const KEY = "__CODEX_USAGE_MONITOR_SIDECHAT__";
  const BINDING = "__codexUsageMonitorSideChatRequest";
  const SELECTOR = "[data-usage-monitor-side-chat-save]";
  const previous = window[KEY];
  previous?.dispose?.();
  const entries = previous?.entries ?? new Map();
  const pending = new Map();
  const adapter = window.__CODEX_USAGE_MONITOR_SIDECHAT_ADAPTER__;
  if (!adapter) throw new Error("旁支保存接口模块缺失");
  let disposed = false, scanning = false, initialError = "正在连接会话接口…", initializing = null;
  let lastAttempt = 0, timer, toastTimer;
  const tabs = () => [...document.querySelectorAll('[data-tab-id^="sidechat:"]')]
    .filter(tab => tab.querySelector(":scope > [data-app-shell-tab-close-button]"));
  function request(action, payload, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error("旁支保存后台没有响应，请保持监视器运行")); }, timeoutMs);
      pending.set(requestId, { resolve, reject, timeout });
      try {
        if (typeof window[BINDING] !== "function") throw new Error("旁支保存后台未连接");
        const body = JSON.stringify({ requestId, action, payload });
        if (new TextEncoder().encode(body).byteLength > 32 * 1024 * 1024) throw new Error("旁支记录超过 32 MiB，暂不能保存");
        window[BINDING](body);
      } catch (error) { clearTimeout(timeout); pending.delete(requestId); reject(error); }
    });
  }
  function toast(message) {
    document.getElementById("codex-usage-side-chat-toast")?.remove();
    const node = document.createElement("div");
    node.id = "codex-usage-side-chat-toast";
    node.setAttribute("role", "status");
    node.textContent = message;
    node.style.cssText = "position:fixed;bottom:100px;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:min(560px,85vw);padding:10px 16px;border-radius:10px;background:var(--color-token-main-surface-primary,#292929);color:var(--color-token-text-primary,#fff);border:1px solid #8886;box-shadow:0 6px 24px #0003;font:13px/1.5 system-ui;white-space:pre-wrap";
    document.body.appendChild(node);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.remove(), 8000);
  }
  function release(source) { if (source?.source_ref) void request("release", { source_ref: source.source_ref }).catch(() => {}); }
  async function capture(params, send) {
    let source, error;
    try {
      source = await request("snapshot", { source_id: params.sourceConversationId, last_turn_id: params.lastTurnId, before_turn_id: params.beforeTurnId }, 10000);
    } catch (reason) { error = reason.message; }
    try {
      const result = await send();
      if (disposed || !result?.conversationId || result.ephemeral === false) release(source);
      else entries.set(result.conversationId, { source, error, lastSeen: Date.now() });
      return result;
    } catch (reason) { release(source); throw reason; }
  }
  async function ready() {
    if (initializing) return initializing;
    initializing = adapter.resolve().then(value => {
      if (disposed) return value;
      initialError = "";
      adapter.captureForks(capture);
      return value;
    }).catch(error => { initialError = error.message; throw error; }).finally(() => { initializing = null; });
    return initializing;
  }
  async function sourceFor(conversation, entry) {
    if (entry.source) return entry.source;
    if (!conversation.forkedFromId || !Number.isFinite(conversation.createdAt)) throw new Error("缺少创建时的主历史，请在监视器运行后新建旁支");
    entry.source = await request("snapshot", { source_id: conversation.forkedFromId,
      created_at: conversation.createdAt < 1e12 ? conversation.createdAt * 1000 : conversation.createdAt });
    return entry.source;
  }
  async function save(id) {
    let entry = entries.get(id);
    if (!entry) { entry = { lastSeen: Date.now() }; entries.set(id, entry); }
    if (entry.busy) return;
    entry.busy = true;
    void refresh();
    try {
      const { manager } = await ready();
      const { conversation, turns } = await adapter.history(id);
      const fingerprint = JSON.stringify(turns);
      const source = await sourceFor(conversation, entry);
      const assignment = await adapter.assignment(source.source_id);
      if (entry.fingerprint !== fingerprint) {
        entry.fingerprint = fingerprint;
        entry.saveId = crypto.randomUUID();
        entry.savedAt = new Date().toISOString();
        entry.written = null;
        const parent = await manager.getConversation(source.source_id);
        entry.title = `${parent?.title?.trim() || "旁支聊天"}（旁支）`.slice(0, 60);
      }
      if (!entry.written) entry.written = await request("save", { source_id: source.source_id, source_ref: source.source_ref,
        side_id: id, save_id: entry.saveId, saved_at: entry.savedAt, turns });
      const target = entry.written;
      await manager.sendRequest("thread/resume", { threadId: target.session_id, path: target.path, excludeTurns: true,
        ...(conversation.latestModel ? { model: conversation.latestModel } : {}) });
      await adapter.verify(target.session_id, turns);
      await adapter.assignment(source.source_id, target.session_id, assignment);
      await manager.setThreadTitle(target.session_id, entry.title);
      await manager.refreshRecentConversations({ sortKey: "updated_at" });
      const opened = await adapter.open(target.session_id);
      let unchanged = false;
      try { unchanged = JSON.stringify((await adapter.history(id)).turns) === fingerprint; } catch {}
      entry.saved = true;
      if (opened && unchanged) tabs().find(tab => tab.getAttribute("data-tab-id") === `sidechat:${id}`)
        ?.querySelector(":scope > [data-app-shell-tab-close-button]")?.click();
      toast(`已保存为普通聊天「${entry.title}」${opened ? "" : "，可从聊天列表打开"}`);
    } catch (error) {
      toast(`${error.message || "保存失败"}；原旁支已保留`);
    } finally { entry.busy = false; void refresh(); }
  }
  async function refresh() {
    if (disposed || scanning) return;
    const visible = tabs();
    scanning = true;
    try {
      const allIds = new Set([...document.querySelectorAll('[data-tab-id^="sidechat:"]')].map(tab => tab.getAttribute("data-tab-id").slice(9)));
      for (const [id, entry] of entries) {
        if (allIds.has(id)) entry.lastSeen = Date.now();
        else if (!entry.busy && Date.now() - (entry.lastSeen ?? Date.now()) > 30000) {
          entry.lastSeen = Date.now();
          // Switching pages can unmount a live tab. Only discard a snapshot once
          // the native manager confirms that the conversation is gone.
          try {
            const { manager } = await adapter.resolve();
            if (await manager.getCachedConversationMetadata(id) == null) { release(entry.source); entries.delete(id); }
          } catch {}
        }
      }
      if (!visible.length) return;
      if (Date.now() - lastAttempt >= 10000) {
        lastAttempt = Date.now();
        await ready().catch(() => {});
      }
      for (const tab of visible) {
        if (disposed || !tab.isConnected) continue;
        const id = tab.getAttribute("data-tab-id").slice(9);
        let button = tab.querySelector(SELECTOR);
        if (!button) {
          button = document.createElement("button");
          button.type = "button";
          button.dataset.usageMonitorSideChatSave = "true";
          button.style.cssText = "-webkit-app-region:no-drag;position:relative;z-index:40;flex-shrink:0;margin-inline:6px 28px;padding:2px 7px;border-radius:5px;border:1px solid #8885;font:12px system-ui;color:inherit;background:transparent;cursor:pointer";
          button.addEventListener("pointerdown", event => event.stopPropagation());
          button.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); void save(id); });
          tab.insertBefore(button, tab.lastElementChild);
        }
        const entry = entries.get(id);
        let reason = initialError;
        if (!reason) try { await adapter.status(id); } catch (error) { reason = error.message; }
        if (disposed) break;
        button.disabled = Boolean(reason || entry?.busy);
        button.textContent = entry?.busy ? "保存中…" : reason ? "保存不可用" : entry?.saved ? "再次保存" : "保存";
        button.title = reason || (entry?.busy ? "正在保存为普通聊天" : "保存为普通聊天，关闭或重启后仍可打开");
        button.setAttribute("aria-label", button.title);
        button.setAttribute("aria-busy", String(entry?.busy === true));
        button.style.opacity = button.disabled ? "0.55" : "1";
      }
    } finally { scanning = false; }
  }
  window[KEY] = {
    entries,
    diagnose() { return { available: !initialError, reason: initialError || null, trackedBranches: entries.size }; },
    receive(requestId, result) {
      const waiter = pending.get(requestId);
      if (!waiter) return;
      pending.delete(requestId);
      clearTimeout(waiter.timeout);
      if (result?.ok) waiter.resolve(result.value); else waiter.reject(new Error(result?.message || "旁支保存失败"));
    },
    dispose() {
      disposed = true;
      clearInterval(timer); clearTimeout(toastTimer);
      adapter.dispose();
      document.querySelectorAll(SELECTOR).forEach(button => button.remove());
      document.getElementById("codex-usage-side-chat-toast")?.remove();
      for (const waiter of pending.values()) { clearTimeout(waiter.timeout); waiter.reject(new Error("旁支保存模块已重新加载")); }
      pending.clear();
    },
  };
  void ready().catch(() => {});
  timer = setInterval(() => { void refresh().catch(() => {}); }, 1500);
  void refresh().catch(() => {});
})();
