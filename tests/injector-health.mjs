import assert from "node:assert/strict";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { backendHeartbeatExpression, backendVerificationExpression, CdpSession, createMonitorStopController, nextEndpointLoss, runOnce } from "../scripts/injector.mjs";

const now = Date.now();
const document = { getElementById: () => ({ shadowRoot: {} }) };
const window = { __CODEX_USAGE_MONITOR_STATE__: { usage: { currentThreadId: "preserve-me" } } };
const context = vm.createContext({ window, document });
const evaluate = (expression) => vm.runInContext(expression, context);
assert.equal(evaluate(backendVerificationExpression(123, now)).backendRunning, false, "leftover panel is not backend liveness");
evaluate(backendHeartbeatExpression(123, now));
assert.equal(evaluate(backendVerificationExpression(123, now + 1000)).backendRunning, true);
assert.equal(evaluate(backendVerificationExpression(456, now + 1000)).backendRunning, false, "old process cannot verify its replacement");
assert.equal(evaluate(backendVerificationExpression(123, now + 16000)).backendRunning, false);
document.getElementById = () => null;
evaluate(backendHeartbeatExpression(456, now));
assert.equal(evaluate(backendVerificationExpression(456, now + 1000)).phase, "waiting-composer");
assert.equal(evaluate(backendVerificationExpression(456, now + 1000)).backendRunning, true, "slow/absent Composer is not a stopped daemon");
assert.equal(evaluate(backendVerificationExpression(123, now + 1000)).backendRunning, true, "each candidate owns its own heartbeat");
assert.equal(nextEndpointLoss(null, true, now + 600000).shouldExit, false, "responsive desktop without a page can load arbitrarily slowly");
const loss = nextEndpointLoss(null, false, now);
assert.equal(nextEndpointLoss(loss.missingSince, false, now + 179999).shouldExit, false);
assert.equal(nextEndpointLoss(loss.missingSince, false, now + 180000).shouldExit, true, "closed desktop eventually releases daemon");
assert.deepEqual(nextEndpointLoss(loss.missingSince, true, now + 150000), { missingSince: null, shouldExit: false });

// Exercise the actual CLI verification route with an isolated CDP transport.
// Any injected code, settings writes or runtime bindings would fail these checks.
const originalFetch = globalThis.fetch;
const originalSocket = globalThis.WebSocket;
const originalLog = console.log;
const originalExitCode = process.exitCode;
const methods = [];
class FakeSocket extends EventTarget {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor() { super(); this.readyState = 0; setTimeout(() => { this.readyState = FakeSocket.OPEN; this.dispatchEvent(new Event("open")); }, 0); }
  send(text) {
    const message = JSON.parse(text);
    methods.push(message.method);
    let result = {};
    if (message.method === "Runtime.evaluate") result = { result: { value: evaluate(message.params.expression) } };
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: message.id, result }) })));
  }
  close() { this.readyState = FakeSocket.CLOSING; queueMicrotask(() => { this.readyState = FakeSocket.CLOSED; this.dispatchEvent(new Event("close")); }); }
}
try {
  globalThis.WebSocket = FakeSocket;
  globalThis.fetch = async () => ({ ok: true, json: async () => [{ id: "main", type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9335/devtools/page/main" }] });
  const results = [];
  console.log = (text) => results.push(JSON.parse(text));
  const previousUsage = JSON.stringify(window.__CODEX_USAGE_MONITOR_STATE__);
  await runOnce({ mode: "verify", port: 9335, timeoutMs: 1000, expectedPid: 456 });
  assert.equal(results.at(-1).verified, true);
  assert.equal(JSON.stringify(window.__CODEX_USAGE_MONITOR_STATE__), previousUsage);
  assert.deepEqual([...new Set(methods)].sort(), ["Page.enable", "Runtime.enable", "Runtime.evaluate"]);
  methods.length = 0;
  await runOnce({ mode: "verify", port: 9335, timeoutMs: 1000, expectedPid: 999 });
  assert.equal(results.at(-1).verified, false);
  assert.equal(process.exitCode, 1);
  assert.equal(JSON.stringify(window.__CODEX_USAGE_MONITOR_STATE__), previousUsage);

  const session = new CdpSession({ webSocketDebuggerUrl: "ws://127.0.0.1:9335/devtools/page/main" }, 1000);
  await session.open();
  session.ws.send = () => {}; // The renderer disappears with commands in flight.
  const pending = session.send("Runtime.evaluate").then(() => "resolved", (error) => error.message);
  await session.close();
  let timeout;
  const outcome = await Promise.race([pending, new Promise((resolve) => { timeout = setTimeout(() => resolve("still pending"), 100); })]);
  clearTimeout(timeout);
  assert.equal(outcome, "CDP session is closed", "closing a target must settle every in-flight command");
  assert.equal(session.pending.size, 0);
  await assert.rejects(session.send("Runtime.evaluate"), /session is closed/);
  await session.close(); // Idempotent close must preserve rejection semantics.
} finally {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalSocket;
  console.log = originalLog;
  process.exitCode = originalExitCode;
}
// Exercise the real shutdown controller through child-process boundaries.
// A hidden PowerShell failure must reach the UI and release the retry latch.
{
  const replies = [], children = [];
  let prepared = 0;
  const session = { evaluate: async (expression) => vm.runInNewContext(expression, { window: {
    __CODEX_USAGE_MONITOR_STATE__: { monitorControlResult: (requestId, result) => { replies.push({ requestId, result }); return true; } },
  } }) };
  const stop = createMonitorStopController({
    prepare: async () => { prepared++; },
    launch: (_file, args, options) => {
      assert.equal(prepared, children.length + 1, "disable relaunch before spawning the shutdown helper");
      assert.ok(args.includes("-ReportProgress"));
      assert.equal(options.windowsHide, true);
      assert.equal(options.detached, false);
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), unref() {} });
      children.push(child);
      return child;
    },
    logError: () => {},
  });
  await stop(session, "request-1", 9335);
  assert.equal(replies.length, 0, "do not report success merely because a child was spawned");
  assert.equal(await stop(session, "request-1", 9335), false, "a duplicate request must not override the active result");
  children[0].stdout.write('{"event":"shutdown-started"}\n');
  await new Promise(setImmediate);
  assert.equal(replies.at(-1).result.pending, true);
  children[0].stderr.write("real shutdown error");
  children[0].emit("close", 1);
  await new Promise(setImmediate);
  assert.equal(replies.at(-1).result.ok, false);
  assert.match(replies.at(-1).result.message, /real shutdown error/);
  await stop(session, "request-2", 9335);
  assert.equal(children.length, 2, "a failed helper must allow retry");
  children[1].stdout.write('{"event":"shutdown-started"}\n');
  children[1].emit("close", 0);
  await new Promise(setImmediate);
  assert.equal(replies.at(-1).result.ok, true);
  assert.equal(replies.at(-1).result.pending, undefined);
}
// Check the Windows PowerShell launch/stdio boundary as well as the controller.
// This helper emits only a protocol marker and an error; it never calls Codex.
if (process.platform === "win32") {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "codex-shutdown-protocol-"));
  const originalLocalAppData = process.env.LOCALAPPDATA;
  try {
    process.env.LOCALAPPDATA = scratch;
    const controlPath = path.join(scratch, "CodexUsageMonitor", "runtime-control.json");
    await fs.mkdir(path.dirname(controlPath));
    await fs.writeFile(controlPath, JSON.stringify({ enabled: true }), "utf8");
    const script = path.join(scratch, "shutdown-probe.ps1");
    await fs.writeFile(script, '\ufeff[Console]::Out.WriteLine(\'{"event":"shutdown-started"}\')\nthrow "shutdown-protocol-probe"\n', "utf8");
    let receive;
    const response = new Promise((resolve) => { receive = resolve; });
    const stop = createMonitorStopController({ script, logError: () => {} });
    await stop({ evaluate: async (expression) => vm.runInNewContext(expression, { window: {
      __CODEX_USAGE_MONITOR_STATE__: { monitorControlResult: (_id, result) => { if (!result.pending) receive(result); return true; } },
    } }) }, "process-launch-probe", 9335);
    const result = await response;
    assert.equal(result.ok, false);
    assert.match(result.message, /shutdown-protocol-probe/);
    assert.equal(JSON.parse(await fs.readFile(controlPath, "utf8")).enabled, false, "disable state must persist even when the actual PowerShell helper fails");
  } finally {
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
console.log("PASS: read-only backend verification, endpoint recovery, and shutdown service failure/retry reporting.");
