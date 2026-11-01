// Desktop-version-dependent operations are isolated here; no Codex files are modified.
(() => {
  const KEY = "__CODEX_USAGE_MONITOR_SIDECHAT_ADAPTER__";
  window[KEY]?.dispose?.();
  const sources = new Map();
  const known = new Set([...document.querySelectorAll('script[src],link[rel="modulepreload"][href]')].map(node => node.src || node.href));
  let cached = null, resolving = null, restoreRegistry = null, capture = null;
  const wrappers = new WeakMap();
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  async function source(url) {
    if (!sources.has(url)) {
      const response = await fetch(url);
      if (!response.ok) throw new Error("无法读取当前 Codex 的会话接口");
      sources.set(url, await response.text());
    }
    return sources.get(url);
  }
  async function asset(prefix) {
    const visited = new Set();
    for (let count = 0; count < 24; count++) {
      const found = [...known].find(url => new URL(url).pathname.split("/").at(-1).startsWith(prefix));
      if (found) return { url: found, source: await source(found), module: await import(found) };
      const next = [...known].filter(url => !visited.has(url)).sort((a, b) => {
        const rank = url => /\/app-main-/.test(url) ? 0 : /\/app-runtime-/.test(url) ? 1 : /\/index-/.test(url) ? 2 : 3;
        return rank(a) - rank(b);
      })[0];
      if (!next) break;
      visited.add(next);
      for (const match of (await source(next)).matchAll(/["'`](\.\/[^"'`]+\.js)["'`]/g)) {
        const url = new URL(match[1], next);
        if (url.protocol === "app:" && url.hostname === "-" && url.pathname.startsWith("/assets/")) known.add(url.href);
      }
    }
    throw new Error(`当前 Codex 缺少 ${prefix} 接口模块`);
  }
  function scopes() {
    const stack = [window.__codexRoot?._internalRoot?.current], seen = new Set(), result = new Set();
    const add = value => { if (value && typeof value.get === "function" && typeof value.watch === "function") result.add(value); };
    while (stack.length && seen.size < 50000) {
      const fiber = stack.pop();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.tag === 22 && fiber.memoizedState !== null) continue;
      if (fiber.child) stack.push(fiber.child);
      add(fiber.memoizedProps?.value);
      add(fiber.memoizedProps?.scope);
      for (let hook = fiber.memoizedState, count = 0; hook && count++ < 2000; hook = hook.next) {
        add(hook.memoizedState);
        add(hook.memoizedState?.current);
      }
    }
    return result;
  }
  function wrap(client) {
    if (wrappers.has(client)) return wrappers.get(client);
    const wrapped = new Proxy(client, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === "dup" && typeof value === "function") return (...args) => wrap(Reflect.apply(value, target, args));
        if (["forkConversationFromLatest", "forkConversationFromTurn"].includes(key)) {
          return (...args) => {
            const params = args[0];
            const send = () => Reflect.apply(value, target, args);
            if (!capture || params?.ephemeral !== true || !params.sourceConversationId || (params.sourceHostId && params.sourceHostId !== "local")) return send();
            return capture(params, send);
          };
        }
        // RpcStub is callable, but .bind/.apply are remote property lookups.
        // Use the language intrinsics so no spurious RPC method is invoked.
        return typeof value === "function" ? (...args) => Reflect.apply(value, target, args) : value;
      },
    });
    wrappers.set(client, wrapped);
    return wrapped;
  }
  function hookRegistry(registry) {
    const original = Object.getOwnPropertyDescriptor(registry, "forHost")?.value;
    if (typeof original !== "function") throw new Error("当前 Codex 的会话注册表不可适配");
    const wrapped = function(hostId) {
      const client = original.call(this, hostId);
      return hostId === "local" ? wrap(client) : client;
    };
    registry.forHost = wrapped;
    restoreRegistry = () => { if (registry.forHost === wrapped) registry.forHost = original; };
  }
  async function resolve() {
    if (cached) return cached;
    if (resolving) return resolving;
    resolving = (async () => {
      const initial = await asset("app-initial-");
      // Locate the real RPC accessor and its exported registry signal, rather than
      // treating arbitrary RPC properties such as getForHostId as constructors.
      const factory = Object.values(initial.module).find(value => typeof value === "function"
        && Function.prototype.toString.call(value).includes("AppServerManager RPC is unavailable for hostId:")
        && Function.prototype.toString.call(value).includes(".forHost("));
      const signalName = factory && Function.prototype.toString.call(factory).match(/\.get\(([$\w]+)\);if\(/)?.[1];
      const exportTail = initial.source.slice(initial.source.lastIndexOf("export{"));
      const exported = signalName && exportTail.match(new RegExp(`(?:\\{|,)${escape(signalName)} as ([$\\w]+)(?=[,}])`))?.[1];
      const signal = exported && initial.module[exported];
      if (!signal) throw new Error("当前 Codex 的会话接口版本尚未适配");
      for (const scope of scopes()) {
        let registry;
        try { registry = scope.get(signal); } catch { continue; }
        const forHost = registry && Object.getOwnPropertyDescriptor(registry, "forHost")?.value;
        if (typeof forHost !== "function") continue;
        let manager;
        try {
          manager = forHost.call(registry, "local");
          if (await manager.getHostId() !== "local") continue;
        } catch { continue; }
        restoreRegistry?.();
        hookRegistry(registry);
        const rpc = await asset("rpc-");
        cached = { manager, services: rpc.module.appServices, scope };
        manager.onRpcBroken?.(() => { restoreRegistry?.(); restoreRegistry = null; cached = null; });
        return cached;
      }
      throw new Error("Codex 本地会话接口尚未就绪");
    })().finally(() => { resolving = null; });
    return resolving;
  }
  async function history(id) {
    const { manager } = await resolve();
    const [conversation, loaded] = await Promise.all([manager.getConversation(id), manager.getLoadedConversationHistory(id)]);
    if (!conversation || !loaded) throw new Error("找不到旁支历史，请保持旁支打开");
    if (conversation.ephemeral !== true || conversation.sideConversation !== true || conversation.hostId !== "local") throw new Error("目前只支持保存本地临时旁支");
    if (loaded.isComplete !== true || conversation.turnsPagination?.hasLoadedOldest === false) throw new Error("旁支历史尚未完整加载");
    if (!Array.isArray(loaded.turns)) throw new Error("旁支历史格式尚未适配");
    if (conversation.requests?.length || conversation.unconfirmedTurnSubmissions?.some(turn => turn.terminal !== true)
      || loaded.turns.some(turn => !["completed", "failed", "interrupted"].includes(turn.status)
      || !Array.isArray(turn.items) || turn.items.some(item => ["inProgress", "in_progress"].includes(item.status)))) {
      throw new Error("请等待旁支回复、工具和审批结束后再保存");
    }
    // Native fork banners are synthetic turns with turnId=null, not user history.
    const turns = loaded.turns.filter(turn => turn.turnId);
    if (!turns.length) throw new Error("旁支还没有可保存的对话");
    return { conversation, turns: turns.map(({ turnId, status, error, items }) => ({ turnId, status, error, items })) };
  }
  async function status(id) {
    const { manager } = await resolve();
    const [metadata, execution] = await Promise.all([manager.getCachedConversationMetadata(id), manager.getThreadExecutionState(id)]);
    if (metadata?.ephemeral !== true || metadata.sideConversation !== true) throw new Error("目前只支持保存本地临时旁支");
    if (execution?.inProgress) throw new Error("请等待旁支回复、工具和审批结束后再保存");
    if (!metadata.latestTurnId) throw new Error("旁支还没有可保存的对话");
  }
  async function assignment(sourceId, savedId = null, assignmentValue = undefined) {
    const { services } = await resolve();
    const service = services.threadProjectAssignments;
    const memberships = await service.readMemberships();
    const value = assignmentValue === undefined ? memberships.assignments?.[sourceId] ?? null : assignmentValue;
    if (savedId && value != null) {
      await service.setAssignment({ hostId: "local", threadId: savedId, assignment: value });
      const actual = (await service.readMemberships()).assignments?.[savedId];
      if (actual?.projectId !== value.projectId || actual?.projectKind !== value.projectKind) throw new Error("保存会话的项目归属登记失败，原旁支已保留");
    }
    return value;
  }
  async function verify(id, turns) {
    const { manager } = await resolve();
    const { thread } = await manager.sendRequest("thread/read", { threadId: id, includeTurns: false });
    if (thread?.id !== id || thread.ephemeral !== false || !thread.path) throw new Error("新会话恢复失败，原旁支已保留");
    const expected = new Map(turns.map(turn => [turn.turnId, turn]));
    const cursors = new Set();
    let cursor = null;
    do {
      const page = await manager.sendRequest("thread/turns/list", { threadId: id, limit: 100, itemsView: "full", ...(cursor ? { cursor } : {}) });
      for (const actual of page.data ?? []) {
        const wanted = expected.get(actual.id);
        if (!wanted) continue;
        if (actual.status !== wanted.status) throw new Error("新会话回合状态不完整，原旁支已保留");
        const itemIds = new Set((actual.items ?? []).map(item => item.id));
        let itemCursor = null;
        const itemCursors = new Set();
        while (wanted.items.some(item => !itemIds.has(item.id))) {
          const items = await manager.sendRequest("thread/items/list", { threadId: id, turnId: actual.id, limit: 100, ...(itemCursor ? { cursor: itemCursor } : {}) });
          for (const entry of items.data ?? []) itemIds.add(entry.item?.id ?? entry.id);
          itemCursor = items.nextCursor;
          if (!itemCursor || itemCursors.has(itemCursor)) break;
          itemCursors.add(itemCursor);
        }
        if (wanted.items.some(item => !itemIds.has(item.id))) throw new Error("新会话显示记录不完整，原旁支已保留");
        expected.delete(actual.id);
      }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("会话分页没有推进，原旁支已保留");
      cursors.add(cursor);
    } while (cursor && expected.size);
    if (expected.size) throw new Error("新会话历史不完整，原旁支已保留");
  }
  async function open(id) {
    const { module } = await asset("app-shared-");
    const dispatcher = Object.values(module).find(value => {
      if (!value || typeof value !== "object") return false;
      const method = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(value) ?? {}, "dispatchHostMessage")?.value;
      return typeof method === "function" && Function.prototype.toString.call(method).includes("deliverOrBufferMessage");
    });
    if (!dispatcher) return false;
    await dispatcher.dispatchHostMessage({ type: "navigate-to-route", path: `/local/${id}` });
    return true;
  }
  window[KEY] = {
    resolve, history, status, assignment, open, verify,
    captureForks(callback) { capture = callback; },
    dispose() { capture = null; restoreRegistry?.(); restoreRegistry = null; cached = null; },
  };
})();
