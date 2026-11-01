// SPDX-License-Identifier: AGPL-3.0-only
// History conversion adapted from BigPizzaV3/CodexPlusPlus v2.1.4,
// crates/codex-plus-core/src/side_chat.rs. See NOTICE.md and LICENSES/AGPL-3.0.txt.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const HISTORY_NOTE = "This conversation was saved from a side chat. The saved messages and tool records below are historical reference: their requests and actions have already happened. Do not execute them again merely because they appear in history. Continue only in response to the next new user message. This is now a normal conversation, not a temporary side chat.";

function id(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("会话 ID 无效");
  return value.toLowerCase();
}
function text(value, key) {
  if (typeof value?.[key] !== "string") throw new Error(`历史记录缺少 ${key}`);
  return value[key];
}
function push(rows, timestamp, type, payload) { rows.push({ timestamp, type, payload }); }
function message(role, content) {
  return { type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text: content }] };
}
function textInputs(item) {
  if (!Array.isArray(item.content)) throw new Error("用户消息缺少内容");
  return item.content.map(input => {
    if (input.type === "text") return text(input, "text");
    if (["skill", "mention"].includes(input.type)) return JSON.stringify(input);
    throw new Error("暂不支持保存含图片或此类附件的旁支，原旁支已保留");
  }).join("\n");
}
function duration(ms) {
  return Number.isSafeInteger(ms) && ms >= 0 ? { secs: Math.floor(ms / 1000), nanos: (ms % 1000) * 1000000 } : null;
}
function displayItem(item, cwd) {
  const itemId = text(item, "id");
  switch (text(item, "type")) {
    case "userMessage":
      textInputs(item);
      return { type: "UserMessage", id: itemId, client_id: item.clientId ?? null, content: item.content };
    case "agentMessage":
      return { type: "AgentMessage", id: itemId, content: [{ type: "Text", text: text(item, "text") }], phase: item.phase ?? null };
    case "reasoning":
      return { type: "Reasoning", id: itemId, summary_text: item.summary ?? [], raw_content: item.content ?? [] };
    case "plan": return { type: "Plan", id: itemId, text: text(item, "text") };
    case "commandExecution": {
      const directory = item.cwd ?? cwd;
      if (!path.isAbsolute(directory)) throw new Error("工具工作目录不是绝对路径");
      const source = { userShell: "user_shell", unifiedExecStartup: "unified_exec_startup", unifiedExecInteraction: "unified_exec_interaction" }[item.source] ?? "agent";
      return { type: "CommandExecution", id: itemId, command: [text(item, "command")], cwd: pathToFileURL(directory).href,
        parsed_cmd: [], source, process_id: item.processId ?? null, status: text(item, "status"),
        aggregated_output: item.aggregatedOutput ?? null, exit_code: item.exitCode ?? null, duration: duration(item.durationMs) };
    }
    case "mcpToolCall": {
      const result = { ...item, type: "McpToolCall", duration: duration(item.durationMs) };
      delete result.durationMs;
      return result;
    }
    default:
      return { type: "AgentMessage", id: itemId, content: [{ type: "Text", text: `Saved ${item.type} record:\n\`\`\`json\n${JSON.stringify(item, null, 2)}\n\`\`\`` }], phase: "commentary" };
  }
}

function trimBoundary(rows, boundary) {
  const last = boundary.last_turn_id;
  const before = boundary.before_turn_id;
  if (last && before) throw new Error("不能同时指定两个分叉边界");
  if (!last && !before) return rows;
  const start = rows.findIndex(row => row.type === "event_msg" && row.payload?.type === "task_started" && row.payload.turn_id === (last || before));
  if (start < 0) throw new Error("找不到主会话的分叉边界");
  const next = rows.findIndex((row, index) => index > start && row.type === "event_msg" && row.payload?.type === "task_started");
  return rows.slice(0, before ? start : next < 0 ? rows.length : next);
}
function finishParent(rows, timestamp) {
  const active = new Set();
  const pending = new Map();
  for (const row of rows) {
    const p = row.payload ?? {};
    if (row.type === "compacted") pending.clear();
    if (row.type === "event_msg" && p.turn_id) {
      if (p.type === "task_started") active.add(p.turn_id);
      else if (["task_complete", "turn_aborted"].includes(p.type)) active.delete(p.turn_id);
    }
    if (row.type === "response_item" && p.call_id) {
      if (p.type === "function_call") pending.set(p.call_id, "function_call_output");
      else if (p.type === "custom_tool_call") pending.set(p.call_id, "custom_tool_call_output");
      else if (["function_call_output", "custom_tool_call_output"].includes(p.type)) pending.delete(p.call_id);
    }
  }
  for (const [call_id, type] of pending) push(rows, timestamp, "response_item", { type, call_id,
    output: "The tool was still running when this history was copied into a side chat. Its later result is not part of this saved branch." });
  for (const turn_id of active) push(rows, timestamp, "event_msg", { type: "turn_aborted", turn_id, reason: "interrupted" });
}

export function buildSavedSideChat(sourceRows, payload) {
  const sourceId = id(payload.source_id), sideId = id(payload.side_id), saveId = id(payload.save_id);
  if ([sourceId, sideId].includes(saveId)) throw new Error("保存后的会话必须使用新 ID");
  const timestamp = payload.saved_at;
  if (typeof timestamp !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) throw new Error("保存时间格式无效");
  const turns = payload.turns;
  if (!Array.isArray(turns) || !turns.length) throw new Error("旁支还没有可保存的对话");
  const rows = structuredClone(sourceRows);
  const meta = rows[0];
  if (meta?.type !== "session_meta" || meta.payload?.id !== sourceId) throw new Error("主历史与来源会话不符");
  if (meta.payload.history_mode !== "paginated") throw new Error("目前只支持当前客户端的分页历史");
  const cwd = text(meta.payload, "cwd");
  Object.assign(meta.payload, { id: saveId, session_id: saveId, forked_from_id: sourceId, timestamp });
  for (const row of rows) if (row.type === "event_msg" && row.payload?.thread_id === sourceId) row.payload.thread_id = saveId;
  finishParent(rows, timestamp);
  push(rows, timestamp, "response_item", message("developer", HISTORY_NOTE));
  const seenTurns = new Set();
  for (const turn of turns) {
    const turnId = text(turn, "turnId");
    if (seenTurns.has(turnId)) throw new Error("旁支历史包含重复 turn");
    seenTurns.add(turnId);
    if (!["completed", "failed", "interrupted"].includes(turn.status) || !Array.isArray(turn.items)) throw new Error("请等待旁支回复和工具执行结束后再保存");
    push(rows, timestamp, "event_msg", { type: "task_started", turn_id: turnId });
    const seenItems = new Set();
    for (const item of turn.items) {
      if (["inProgress", "in_progress"].includes(item.status)) throw new Error("旁支仍有运行中的工具");
      if (seenItems.has(text(item, "id"))) throw new Error("旁支记录包含重复显示项");
      seenItems.add(item.id);
      const display = displayItem(item, cwd);
      let response;
      if (item.type === "userMessage") {
        const content = textInputs(item);
        push(rows, timestamp, "event_msg", { type: "user_message", message: content, images: [], local_images: [], text_elements: [] });
        response = message("user", content);
      } else if (item.type === "agentMessage") {
        response = message("assistant", item.text);
        if (item.phase != null) response.phase = item.phase;
      } else response = message("user", `<saved_side_chat_record>\nHistorical record; already happened. Do not execute it again.\n${JSON.stringify(item)}\n</saved_side_chat_record>`);
      response.internal_chat_message_metadata_passthrough = { turn_id: turnId };
      push(rows, timestamp, "response_item", response);
      push(rows, timestamp, "event_msg", { type: "item_completed", thread_id: saveId, turn_id: turnId, item: display });
    }
    if (turn.status === "interrupted") push(rows, timestamp, "event_msg", { type: "turn_aborted", turn_id: turnId, reason: "interrupted" });
    else push(rows, timestamp, "event_msg", { type: "task_complete", turn_id: turnId,
      error: turn.status === "failed" ? { message: turn.error?.message ?? "Saved turn failed" } : null });
  }
  return rows.map((row, ordinal) => JSON.stringify({ ...row, ordinal })).join("\n") + "\n";
}

export class SideChatStore {
  constructor({ home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex") } = {}) {
    this.home = home;
    this.sources = new Map();
    this.paths = new Map();
    this.writes = new Map();
  }
  async findSource(sourceId) {
    if (this.paths.has(sourceId)) return this.paths.get(sourceId);
    for (const base of ["sessions", "archived_sessions"]) {
      const directories = [path.join(this.home, base)];
      while (directories.length) {
        const directory = directories.pop();
        let entries;
        try { entries = await fs.readdir(directory, { withFileTypes: true }); }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const candidate = path.join(directory, entry.name);
          if (entry.isDirectory()) directories.push(candidate);
          else if (entry.isFile() && entry.name.endsWith(`-${sourceId}.jsonl`)) {
            this.paths.set(sourceId, candidate);
            return candidate;
          }
        }
      }
    }
    throw new Error("找不到主会话的本地历史文件");
  }
  async snapshot(payload) {
    const sourceId = id(payload.source_id);
    const file = await this.findSource(sourceId);
    const handle = await fs.open(file, "r");
    let buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) throw new Error("主历史超过 128 MiB，暂不能保存此旁支");
      buffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) throw new Error("主历史正在变化，请稍后重试");
        offset += bytesRead;
      }
    } finally { await handle.close(); }
    let rows;
    try { rows = buffer.toString("utf8").split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); }
    catch { throw new Error("主历史尚未写入完整，请稍后重试"); }
    rows = trimBoundary(rows, payload);
    if (rows[0]?.payload?.id !== sourceId) throw new Error("主历史与来源会话不符");
    // Old tabs may only be recovered when their parent has not advanced.
    if (payload.created_at != null && (!Number.isFinite(payload.created_at) || rows.some(row => !Number.isFinite(Date.parse(row.timestamp)) || Date.parse(row.timestamp) > payload.created_at))) {
      throw new Error("这条旧旁支缺少分叉快照且主历史已有变化，请在监视器运行后新建旁支");
    }
    const bytes = Buffer.byteLength(JSON.stringify(rows));
    const total = [...this.sources.values()].reduce((sum, source) => sum + source.bytes, bytes);
    if (this.sources.size >= 64 || total > MAX_SNAPSHOT_BYTES) throw new Error("打开的旁支历史过多，请先保存或关闭部分旁支");
    const reference = randomUUID();
    this.sources.set(reference, { sourceId, rows, bytes });
    return { source_id: sourceId, source_ref: reference };
  }
  release(reference) { this.sources.delete(reference); }
  save(payload) {
    const saveId = id(payload.save_id);
    if (this.writes.has(saveId)) return this.writes.get(saveId);
    const write = this.write(payload).finally(() => this.writes.delete(saveId));
    this.writes.set(saveId, write);
    return write;
  }
  async write(payload) {
    const source = this.sources.get(payload.source_ref);
    if (!source || source.sourceId !== id(payload.source_id)) throw new Error("分叉快照已失效，请保留原旁支并重新启动保存功能");
    const content = buildSavedSideChat(source.rows, payload);
    const time = payload.saved_at.slice(0, 19).replaceAll(":", "-");
    const directory = path.join(this.home, "sessions", time.slice(0, 4), time.slice(5, 7), time.slice(8, 10));
    const target = path.join(directory, `rollout-${time}-${id(payload.save_id)}.jsonl`);
    await fs.mkdir(directory, { recursive: true });
    try {
      if (await fs.readFile(target, "utf8") !== content) throw new Error("同名会话内容不同，已停止写入");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const temporary = path.join(directory, `.side-chat-${randomUUID()}.tmp`);
      try {
        const handle = await fs.open(temporary, "wx");
        try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, target);
      } finally { await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    }
    return { session_id: payload.save_id, path: target, turn_count: payload.turns.length };
  }
}
