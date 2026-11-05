// Desktop-version-dependent operations are isolated here; no Codex files are modified.
(() => {
  const KEY = "__CODEX_USAGE_MONITOR_SIDECHAT_ADAPTER__";
  window[KEY]?.dispose?.();
  const sources = new Map();
  const entryUrls = new Set([...document.querySelectorAll('script[type="module"][src]')].map(node => node.src));
  let cached = null, resolving = null, restoreRegistry = null, capture = null;
  let runtime = null;
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
  async function rspackRuntime() {
    if (runtime) return runtime;
    // Rspack publishes its existing loader from a numbered entry module. Import
    // only an entry already on this page; never guess chunk IDs or run a copy.
    for (const url of entryUrls) {
      const parsed = new URL(url);
      if (parsed.protocol !== "app:" || parsed.hostname !== "-" || !parsed.pathname.startsWith("/assets/")) continue;
      if (!(await source(url)).includes("__webpack_require__")) continue;
      const module = await import(url);
      const loader = module.__webpack_require__;
      if (typeof loader === "function" && loader.m && loader.c) return runtime = loader;
    }
    throw new Error("当前 Codex 的模块加载器尚未就绪");
  }
  function rpcAccessor(value) {
    if (typeof value !== "function") return false;
    const text = Function.prototype.toString.call(value);
    return text.includes("AppServerManager RPC is unavailable for hostId:") && text.includes(".forHost(");
  }
  function rspackInterfaces(loader) {
    const interfaces = [];
    for (const [id, factory] of Object.entries(loader.m)) {
      if (typeof factory !== "function") continue;
      const text = Function.prototype.toString.call(factory);
      if (!text.includes("AppServerManager RPC is unavailable for hostId:") || !text.includes(".forHost(")) continue;
      // Read initialized exports only. Instantiating arbitrary lazy modules can
      // create another manager or run unrelated app startup code.
      const module = loader.c[id]?.exports;
      if (!module) continue;
      for (const accessor of Object.values(module).filter(rpcAccessor)) {
        const local = Function.prototype.toString.call(accessor).match(/\.get\(([$\w]+)\);if\(/)?.[1];
        if (!local) continue;
        // Rspack exports signals as constants in the third require.d argument.
        // Match the current local binding; minified export names can change.
        for (const match of text.matchAll(new RegExp(`(?:\\{|,)([$\\w]+):${escape(local)}(?=[,}])`, "g"))) {
          const signal = module[match[1]];
          if (signal) interfaces.push({ signal, moduleId: id });
        }
      }
    }
    return interfaces;
  }
  function rspackServices(loader) {
    for (const entry of Object.values(loader.c)) {
      const exports = entry?.exports;
      if (!exports || !Object.prototype.hasOwnProperty.call(exports, "appServices")) continue;
      if (exports.appServices) return exports.appServices;
    }
    throw new Error("Codex 项目服务尚未就绪");
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
      const loader = await rspackRuntime();
      const interfaces = rspackInterfaces(loader);
      const services = rspackServices(loader);
      if (!interfaces.length) throw new Error("当前 Codex 的会话接口版本尚未适配");
      const availableScopes = scopes();
      for (const { signal } of interfaces) {
        for (const scope of availableScopes) {
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
          cached = { manager, services, scope };
          manager.onRpcBroken?.(() => { restoreRegistry?.(); restoreRegistry = null; cached = null; });
          return cached;
        }
      }
      throw new Error("Codex 本地会话接口尚未就绪");
    })().finally(() => { resolving = null; });
    return resolving;
  }
  async function history(id) {
    const { manager } = await resolve();
    const [conversation, loaded] = await Promise.all([manager.getConversation(id), manager.getLoadedConversationHistory(id)]);
    if (!conversation || !loaded) throw new Error("找不到旁支历史，请保持旁支打开");
    if (typeof conversation.ephemeral !== "boolean" || conversation.sideConversation !== true || conversation.hostId !== "local") throw new Error("目前只支持保存本地旁支");
    // Persistent attached forks are copied by the native manager, including
    // history pages not mounted in the renderer. Only temporary branches need
    // the complete loaded history for the local conversion path.
    if (conversation.ephemeral && (loaded.isComplete !== true || conversation.turnsPagination?.hasLoadedOldest === false)) throw new Error("旁支历史尚未完整加载");
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
    if (typeof metadata?.ephemeral !== "boolean" || metadata.sideConversation !== true) throw new Error("目前只支持保存本地旁支");
    if (execution?.inProgress) throw new Error("请等待旁支回复、工具和审批结束后再保存");
    if (!metadata.latestTurnId) throw new Error("旁支还没有可保存的对话");
  }
  async function forkNative(id) {
    const { manager } = await resolve();
    await status(id);
    const result = await manager.forkConversationFromLatest({ sourceConversationId: id,
      sourceHostId: "local", ephemeral: false, sideConversation: false, addForkedSyntheticItem: false });
    if (!/^[a-f0-9-]{36}$/i.test(result?.conversationId || "") || result.ephemeral !== false) {
      throw new Error("原生会话分叉尚未完成，请稍后重试");
    }
    return { session_id: result.conversationId };
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
    const loader = await rspackRuntime();
    const exports = Object.entries(loader.m).flatMap(([moduleId, factory]) => {
      if (typeof factory !== "function" || !Function.prototype.toString.call(factory).includes("deliverOrBufferMessage")) return [];
      const value = loader.c[moduleId]?.exports;
      return value && (typeof value === "object" || typeof value === "function") ? Object.values(value) : [];
    });
    const dispatcher = exports.find(value => {
      if (!value || typeof value !== "object") return false;
      const method = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(value) ?? {}, "dispatchHostMessage")?.value;
      return typeof method === "function" && Function.prototype.toString.call(method).includes("deliverOrBufferMessage");
    });
    if (!dispatcher) return false;
    await dispatcher.dispatchHostMessage({ type: "navigate-to-route", path: `/local/${id}` });
    return true;
  }
  window[KEY] = {
    resolve, history, status, forkNative, assignment, open, verify,
    diagnose() { return { connected: Boolean(cached), runtime: runtime ? "rspack" : null }; },
    captureForks(callback) { capture = callback; },
    dispose() { capture = null; restoreRegistry?.(); restoreRegistry = null; cached = null; },
  };
})();
