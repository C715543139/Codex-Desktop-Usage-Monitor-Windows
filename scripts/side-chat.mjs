import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SideChatStore } from "./side-chat-store.mjs";

const BINDING = "__codexUsageMonitorSideChatRequest";
const STATE = "__CODEX_USAGE_MONITOR_SIDECHAT__";
const MAX_BYTES = 32 * 1024 * 1024;
const store = new SideChatStore();
const registered = new WeakSet();
const assets = ["side-chat-adapter.js", "side-chat-save.js"].map(name => new URL(`../assets/${name}`, import.meta.url));

export async function applySideChat(session) {
  try {
    if (!registered.has(session)) {
      registered.add(session);
      session.on("Runtime.bindingCalled", ({ name, payload }) => {
        if (name !== BINDING || typeof payload !== "string") return;
        // No HTTP server or renderer-selected filesystem paths are exposed.
        if (Buffer.byteLength(payload, "utf8") > MAX_BYTES) return;
        let message;
        try { message = JSON.parse(payload); } catch { return; }
        const { requestId, action, payload: request } = message;
        if (!/^[a-f0-9-]{36}$/i.test(requestId || "") || !request || !["snapshot", "save", "release"].includes(action)) return;
        Promise.resolve().then(() => {
          if (action === "snapshot") return store.snapshot(request);
          if (action === "save") return store.save(request);
          store.release(request.source_ref);
          return null;
        }).then(value => ({ ok: true, value }), error => ({ ok: false, message: error.message || "旁支保存失败" }))
          .then(result => session.evaluate(`window[${JSON.stringify(STATE)}]?.receive(${JSON.stringify(requestId)},${JSON.stringify(result)})`))
          .catch(() => {});
      });
    }
    await session.send("Runtime.addBinding", { name: BINDING });
    for (const asset of assets) await session.evaluate(await fs.readFile(fileURLToPath(asset), "utf8"));
    return true;
  } catch (error) {
    console.error(`[usage-monitor] side chat unavailable: ${String(error.message).slice(0, 180)}`);
    return false;
  }
}

export function removeSideChatExpression() {
  return `(() => { window[${JSON.stringify(STATE)}]?.dispose?.(); window.__CODEX_USAGE_MONITOR_SIDECHAT_ADAPTER__?.dispose?.(); return true; })()`;
}
