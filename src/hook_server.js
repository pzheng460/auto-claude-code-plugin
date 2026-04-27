// HTTP listener attached to the watcher process. Two consumers:
//   1. Claude Code lifecycle hooks (Stop / UserPromptSubmit / PreToolUse)
//      → POST /hooks/<event>; we decide what claude should do next.
//   2. The acc_ask_user MCP tool → POST /mcp with JSON-RPC frames; we
//      block the tool until a Feishu reply arrives.
//
// State held here is a small bridge between the in-process watcher and
// the rest of the openclaw plugin (which forwards user replies via
// POST /answer). Using a single shared HTTP port keeps the plugin
// single-process — no MCP subprocess per claude session.

import http from "node:http";
import { randomUUID } from "node:crypto";

import { envNum } from "./env.js";


const DEFAULT_PORT = envNum("AUTO_CLAUDE_CODE_HOOK_PORT", 7779);

// In-memory map of pending acc_ask_user requests.
// Key = questionId, value = { resolve, reject, payload, createdAt }.
const pending = new Map();

// Latest force-continue intent set by Stop hook → consumed by next
// UserPromptSubmit hook. `null` means "no pending nudge".
let pendingForceContinuePrompt = null;

// Hook callbacks set by watcher.mjs at startup. Allows the watcher
// to make domain decisions (force mode, max-continues check, etc.)
// without import-time circular deps.
let onStopHook = async (_payload) => null;
let pushQuestionToChat = async (_q) => { /* override at startup */ };


// ---- public API used by watcher.mjs ----

export function startHookServer({ port = DEFAULT_PORT, hooks = {} } = {}) {
  if (typeof hooks.onStop === "function") onStopHook = hooks.onStop;
  if (typeof hooks.pushQuestion === "function") pushQuestionToChat = hooks.pushQuestion;

  const server = http.createServer((req, res) => handleRequest(req, res).catch((err) => {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  }));

  // Bind synchronously (host=127.0.0.1 to avoid surprises) and remember
  // the actual port so callers don't have to wait for the 'listening'
  // event before logging.
  server.listen(port, "127.0.0.1");
  server._listenedPort = port;   // address().port may not be ready yet
  return server;
}

// Called by watcher when it wants the next UserPromptSubmit hook to
// inject a force-continue prompt (because end_turn arrived but tasks
// aren't done).
export function queueForceContinue(prompt) {
  pendingForceContinuePrompt = prompt;
}

// Called by openclaw plugin (commands.js) when a user reply arrives
// via sticky chat. Resolves the matching pending question if any.
// Returns true if a pending was resolved.
export function deliverAnswer(answerText) {
  if (pending.size === 0) return false;
  // Resolve the oldest pending question (FIFO; only one is active at a time
  // because the LLM blocks on its tool call).
  const [[id, entry]] = pending.entries();
  pending.delete(id);
  try { entry.resolve({ answer: answerText }); } catch {}
  return true;
}

export function pendingCount() {
  return pending.size;
}


// ---- request routing ----

async function handleRequest(req, res) {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  const method = req.method;

  // Hook callbacks
  if (method === "POST" && path === "/hooks/stop") {
    const body = await readJson(req);
    const out = (await onStopHook(body)) || {};
    return sendJson(res, 200, out);
  }
  if (method === "POST" && path === "/hooks/user-prompt") {
    return sendJson(res, 200, takePendingPrompt());
  }
  if (method === "POST" && path === "/hooks/pre-tool") {
    const body = await readJson(req);
    return sendJson(res, 200, handlePreTool(body));
  }

  // Answer delivery (from openclaw plugin sticky route)
  if (method === "POST" && path === "/answer") {
    const body = await readJson(req);
    const ok = deliverAnswer(body.answer || "");
    return sendJson(res, 200, { delivered: ok });
  }

  // Visibility
  if (method === "GET" && path === "/pending") {
    return sendJson(res, 200, { count: pending.size });
  }

  // MCP — single JSON-RPC endpoint, supports initialize/tools/list/tools/call
  if (method === "POST" && path === "/mcp") {
    const body = await readJson(req);
    return sendJson(res, 200, await handleMcp(body));
  }

  if (path === "/healthz") return sendJson(res, 200, { ok: true });
  res.statusCode = 404;
  res.end();
}


// ---- hook handlers ----

// System-level reminder injected on every UserPromptSubmit. Claude Code's
// PreToolUse hook is unreliable for the built-in AskUserQuestion tool
// (GH #15872, #28273), so the only deterministic lever we have is to keep
// reminding the model not to reach for AskUserQuestion in the first place.
// Pairs with the acc_ask_user MCP tool exposed by this same server.
const REMOTE_CHAT_REMINDER = [
  "[auto-claude-code] The user is on remote chat (Feishu / Telegram), NOT in front of the local terminal.",
  "Anything rendered in the Claude Code TUI (modals, multi-step forms, AskUserQuestion prompts) is INVISIBLE to them and will hang the session.",
  "",
  "When you need clarifying input from the user:",
  "  - DO use the `acc_ask_user` MCP tool. Same shape as AskUserQuestion: { questions: [{ header, question, multiSelect, options }] }. It pushes the question to chat and blocks until the user replies.",
  "  - DO NOT use the built-in AskUserQuestion tool, even for a single question.",
  "  - DO NOT print numbered options as plain text and ask them to type a number — `acc_ask_user` formats the card properly for the chat client.",
].join("\n");

function takePendingPrompt() {
  const force = pendingForceContinuePrompt;
  pendingForceContinuePrompt = null;
  const additionalContext = force
    ? `${REMOTE_CHAT_REMINDER}\n\n${force}`
    : REMOTE_CHAT_REMINDER;
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  };
}

// PreToolUse: when LLM tries to call the built-in AskUserQuestion tool,
// nudge it toward acc_ask_user instead. Don't try to deliver answers
// via deny+reason — the user said acc_ask_user (real MCP tool) is the
// proper path; this hook is just a soft redirect for when the LLM
// forgets and reaches for AskUserQuestion.
function handlePreTool(body) {
  const toolName = body?.tool_name || "";
  if (toolName === "AskUserQuestion") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "AskUserQuestion is unavailable in this session — the user is on " +
          "remote chat (Feishu/TG) and cannot see the local TUI. " +
          "Use the `acc_ask_user` tool instead. Same parameters: " +
          "{ questions: [{ header, question, multiSelect, options }] }.",
      },
    };
  }
  return {};
}


// ---- MCP server ----

async function handleMcp(req) {
  // Minimal JSON-RPC 2.0. We only handle the methods claude code uses
  // when probing an HTTP MCP server: initialize, notifications/initialized,
  // tools/list, tools/call.
  const { jsonrpc = "2.0", id, method, params } = req || {};
  const wrap = (result) => ({ jsonrpc, id, result });
  const wrapErr = (code, message) => ({ jsonrpc, id, error: { code, message } });

  if (method === "initialize") {
    return wrap({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "auto-claude-code", version: "0.1.0" },
    });
  }
  if (method === "notifications/initialized") return wrap({});
  if (method === "tools/list") return wrap({ tools: [askUserToolSpec()] });
  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    if (name === "acc_ask_user") {
      const result = await runAccAskUser(args || {});
      return wrap({
        content: [
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      });
    }
    return wrapErr(-32601, `unknown tool: ${name}`);
  }
  return wrapErr(-32601, `unknown method: ${method}`);
}


function askUserToolSpec() {
  return {
    name: "acc_ask_user",
    description:
      "Ask the user one or more multi-choice / free-text questions through " +
      "the user's connected chat channel (Feishu/Telegram via openclaw). " +
      "Use this INSTEAD OF AskUserQuestion when interacting with a " +
      "remote user. Blocks until the user replies.",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: {
            type: "object",
            required: ["question", "options"],
            properties: {
              header: { type: "string", description: "Short tab/section label" },
              question: { type: "string" },
              multiSelect: { type: "boolean", default: false },
              options: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  required: ["label"],
                  properties: {
                    label: { type: "string" },
                    description: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
      required: ["questions"],
    },
  };
}


async function runAccAskUser(args) {
  const questions = Array.isArray(args.questions) ? args.questions : [];
  if (questions.length === 0) {
    return { error: "questions array is empty" };
  }
  const id = randomUUID();
  const entry = await new Promise((resolveOuter) => {
    // Push to chat first; only register pending after push succeeds so a
    // failed push doesn't block forever.
    pushQuestionToChat({ id, questions })
      .then(() => {
        const p = new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject, payload: { questions }, createdAt: Date.now() });
        });
        resolveOuter(p);
      })
      .catch((err) => resolveOuter(Promise.reject(err)));
  });
  return entry;   // { answer: "..." }
}


// ---- helpers ----

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}
