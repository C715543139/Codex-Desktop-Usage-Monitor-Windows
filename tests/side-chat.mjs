import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { SideChatStore, buildSavedSideChat } from "../scripts/side-chat-store.mjs";
import vm from "node:vm";

// Exercise the current desktop bundler through the public adapter, replacing only
// module import/fetch transport. No real conversations or RPCs are changed.
const adapterSource = await fs.readFile(new URL("../assets/side-chat-adapter.js", import.meta.url), "utf8");
{
  const signal = {};
  const nativeCopyId = randomUUID();
  const nativeForks = [];
  let ephemeral = false;
  const manager = {
    async getHostId() { return "local"; },
    async getConversation() { return { hostId: "local", ephemeral, sideConversation: true }; },
    async getLoadedConversationHistory() { return { isComplete: false, turns: [{ turnId: "turn", status: "completed", items: [] }] }; },
    async getCachedConversationMetadata() { return { ephemeral, sideConversation: true, latestTurnId: "turn" }; },
    async getThreadExecutionState() { return { inProgress: false }; },
    async forkConversationFromLatest(params) { nativeForks.push(params); return { conversationId: nativeCopyId, ephemeral: false }; },
  };
  const registry = { forHost() { return manager; } };
  const original = registry.forHost;
  const scope = { get(value) { if (value === signal) return registry; throw new Error("unrecognized signal"); }, watch() {} };
  const messages = [];
  class Dispatcher {
    dispatchHostMessage(message) { this.deliverOrBufferMessage(message); }
    deliverOrBufferMessage(message) { messages.push(message); }
  }
  const services = { threadProjectAssignments: { async readMemberships() { return { assignments: {} }; } } };
  const accessor = function lookup(e,t){let r=e.get(signal);if(!r)throw Error("AppServerManager RPC is unavailable for hostId:"+t);return r.forHost(t)};
  const factory = function bundle(e,t,n){let signal={};function lookup(e,t){let r=e.get(signal);if(!r)throw Error("AppServerManager RPC is unavailable for hostId:"+t);return r.forHost(t)}n.d(t,{V:()=>lookup},{renamedSignal:signal})};
  const modules = new Map([
    ["app://-/assets/765432.changed.js", { __webpack_require__: Object.assign(() => { throw new Error("Do not instantiate lazy modules"); }, {
      m: { renamedRegistry: factory, neverLoaded: factory, messages: function messageModule() { return "deliverOrBufferMessage"; } },
      c: { renamedRegistry: { exports: { V: accessor, renamedSignal: signal } }, services: { exports: { appServices: services } }, messages: { exports: { dispatcher: new Dispatcher() } } },
    }) }],
  ]);
  const fixture = { __codexRoot: { _internalRoot: { current: { memoizedProps: { value: scope } } } } };
  vm.runInNewContext(adapterSource.replace("import(url)", "fixtureImport(url)"), {
    window: fixture, URL,
    document: { querySelectorAll: () => [...modules.keys()].map(src => ({ src })) },
    fetch: async () => ({ ok: true, text: async () => "export { loader as __webpack_require__ }" }),
    fixtureImport: async url => { assert.ok(modules.has(url)); return modules.get(url); },
  });
  const adapter = fixture.__CODEX_USAGE_MONITOR_SIDECHAT_ADAPTER__;
  assert.equal((await adapter.resolve()).manager, manager);
  assert.equal(adapter.diagnose().runtime, "rspack");
  await adapter.status("branch");
  assert.equal((await adapter.history("branch")).turns.length, 1);
  assert.equal((await adapter.forkNative("branch")).session_id, nativeCopyId);
  assert.equal(nativeForks[0].sourceConversationId, "branch", "copy the persistent branch's own native history");
  assert.equal(nativeForks[0].sideConversation, false, "the saved fork must be a normal conversation");
  assert.equal(nativeForks[0].ephemeral, false);
  ephemeral = true;
  await adapter.status("branch");
  await assert.rejects(adapter.history("branch"), /完整加载/, "temporary branches still require full history before conversion");
  ephemeral = false;
  let captured = 0;
  adapter.captureForks(async (_params, send) => { captured++; return send(); });
  await registry.forHost("local").forkConversationFromLatest({ ephemeral: true, sourceConversationId: "parent" });
  assert.equal(captured, 1, "new branches must still capture their parent boundary");
  assert.equal(await adapter.assignment("parent"), null);
  assert.equal(await adapter.open("saved"), true);
  assert.equal(messages[0].path, "/local/saved");
  adapter.dispose();
  assert.equal(registry.forHost, original, "reload must restore the native registry");
}
console.log("PASS: numbered Rspack side-chat interfaces, fork capture and navigation.");

const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-side-chat-"));
const sourceId = randomUUID(), sideId = randomUUID(), saveId = randomUUID();
const timestamp = "2026-11-01T00:00:00.000Z";
const turnId = randomUUID();
const rows = [
  { timestamp, type: "session_meta", payload: { id: sourceId, session_id: sourceId, timestamp, cwd: home,
    originator: "codex_cli_rs", cli_version: "0.166.0", source: "cli", model_provider: "openai", history_mode: "paginated" } },
  { timestamp, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Parent history" }] } },
];
const turns = [{ turnId, status: "completed", items: [
  { id: "side-user", type: "userMessage", content: [{ type: "text", text: "Saved side question" }] },
  { id: "side-command", type: "commandExecution", command: "example", cwd: home, status: "completed", aggregatedOutput: "Historical output", exitCode: 0, durationMs: 25 },
  { id: "side-agent", type: "agentMessage", text: "Saved side answer", phase: "final_answer" },
] }];

async function startServer(binary) {
  const child = spawn(binary, ["app-server", "--listen", "stdio://"], { cwd: home, windowsHide: true,
    env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: "", CODEX_API_KEY: "", RUST_LOG: "off" }, stdio: ["pipe", "pipe", "pipe"] });
  const reader = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 0;
  child.stderr.resume();
  child.stdin.on("error", () => {});
  reader.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id); clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error))); else waiter.resolve(message.result);
  });
  child.on("exit", () => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("app-server exited")); }
    pending.clear();
  });
  function request(method, params) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 20000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  async function stop() {
    reader.close();
    child.stdin.end();
    if (child.exitCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill(), 2000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  try {
    await request("initialize", { clientInfo: { name: "side_chat_test", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    return { request, stop };
  } catch (error) { await stop(); throw error; }
}

try {
  const directory = path.join(home, "sessions", "2026", "11", "01");
  await fs.mkdir(directory, { recursive: true });
  const original = path.join(directory, `rollout-2026-11-01T00-00-00-${sourceId}.jsonl`);
  await fs.writeFile(original, rows.map((row, ordinal) => JSON.stringify({ ...row, ordinal })).join("\n") + "\n");
  const store = new SideChatStore({ home });
  const source = await store.snapshot({ source_id: sourceId });
  await fs.appendFile(original, JSON.stringify({ timestamp: "2026-11-01T00:01:00.000Z", type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Later parent message" }] } }) + "\n");
  const payload = { source_id: sourceId, source_ref: source.source_ref, side_id: sideId, save_id: saveId, saved_at: "2026-11-01T00:02:00.000Z", turns };
  const saved = await store.save(payload);
  const content = await fs.readFile(saved.path, "utf8");
  assert.ok(content.includes("Parent history") && content.includes("Saved side answer") && content.includes("Historical output"));
  assert.ok(!content.includes("Later parent message"));
  assert.deepEqual(await store.save(payload), saved);
  assert.throws(() => buildSavedSideChat(rows, { ...payload, turns: [{ ...turns[0], status: "inProgress" }] }), /等待/);
  assert.throws(() => buildSavedSideChat(rows, { ...payload, turns: [{ ...turns[0], items: [{ id: "image", type: "userMessage", content: [{ type: "image", url: "image" }] }] }] }), /图片/);
  const binary = process.env.CODEX_SIDE_CHAT_TEST_CODEX_PATH;
  if (binary) {
    // Only this synthetic CODEX_HOME is used. No credentials, model calls, or historical tools are executed.
    for (let restart = 0; restart < 2; restart++) {
      const server = await startServer(binary);
      try {
        await server.request("thread/resume", { threadId: saveId, path: saved.path, excludeTurns: true });
        const { thread } = await server.request("thread/read", { threadId: saveId, includeTurns: false });
        assert.equal(thread.ephemeral, false);
        const page = await server.request("thread/turns/list", { threadId: saveId, itemsView: "full", limit: 100 });
        const turn = page.data.find(turn => turn.id === turnId);
        assert.equal(turn?.status, "completed");
        assert.deepEqual(turn.items.map(item => item.id), ["side-user", "side-command", "side-agent"]);
        if (restart === 0) {
          const fork = await server.request("thread/fork", { threadId: saveId, ephemeral: false });
          assert.equal(fork.thread.ephemeral, false);
          const copied = await server.request("thread/turns/list", { threadId: fork.thread.id, itemsView: "full", limit: 100 });
          assert.deepEqual(copied.data.find(item => item.id === turnId)?.items.map(item => item.id), ["side-user", "side-command", "side-agent"], "native forking must preserve the saved turn and its item identities");
        }
      } finally { await server.stop(); }
    }
    console.log("PASS: native app-server restores saved side history before and after restart.");
  }
  console.log("PASS: side-chat parent boundary, history conversion, retry, and unsupported input.");
} finally {
  if (path.dirname(home) === os.tmpdir() && path.basename(home).startsWith("codex-side-chat-")) await fs.rm(home, { recursive: true, force: true });
}
