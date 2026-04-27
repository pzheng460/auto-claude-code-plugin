// Force-mode auto-answer: when claude calls acc_ask_user but no human is
// going to reply, spawn a one-shot `claude -p` subprocess to pick a
// reasonable answer based on the worker's task context. The subprocess
// runs WITHOUT --plugin-dir so it doesn't recurse into our own MCP
// server (which would itself try to push questions).

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const DEFAULT_MODEL = process.env.AUTO_CLAUDE_CODE_AUTO_ANSWER_MODEL || "haiku";
const DEFAULT_TIMEOUT_MS = Number(process.env.AUTO_CLAUDE_CODE_AUTO_ANSWER_TIMEOUT_MS) || 60_000;
const DEFAULT_BUDGET_USD = process.env.AUTO_CLAUDE_CODE_AUTO_ANSWER_BUDGET_USD || "0.05";

// Build a prompt that asks the sub-agent to produce a single chat-reply
// line answering the questions. Format mirrors what the human would type
// in feishu, e.g. `1, 2, "my-repo", 3` — the worker's claude is already
// trained (via the plugin's UserPromptSubmit context) to interpret that
// shape as the acc_ask_user answer.
function buildAutoAnswerPrompt({ task, questions }) {
  const taskLine = task ? `Task the worker is doing: ${task}` : "(No explicit task description.)";
  const blocks = questions.map((q, i) => {
    const lines = [`Question ${i + 1}: ${q.question}`];
    if (q.header && q.header !== q.question) lines.push(`Section: ${q.header}`);
    (q.options || []).forEach((opt, j) => {
      const desc = opt.description ? ` — ${opt.description}` : "";
      lines.push(`  ${j + 1}. ${opt.label}${desc}`);
    });
    if (q.multiSelect) lines.push("(multi-select)");
    return lines.join("\n");
  }).join("\n\n");

  return [
    "You are auto-answering questions on behalf of an absent user for a Claude Code worker running in autonomous (force) mode.",
    "",
    taskLine,
    "",
    "The worker is asking the following:",
    "",
    blocks,
    "",
    "Pick the most reasonable answer for each question based on the task. If genuinely ambiguous, pick the option that keeps the work moving forward (avoid choices that abort/cancel/escalate).",
    "",
    "Output FORMAT — exactly one line, no preamble, no explanation:",
    "  • One token per question, comma-separated, in question order.",
    "  • For numbered options: just the digit, e.g. `2`.",
    "  • For free text: wrap in double quotes, e.g. `\"my-repo\"`.",
    "  • For multi-select: digits joined with space inside one slot, e.g. `\"1 3\"`.",
    "",
    "Example for 3 questions: `1, 2, \"my-repo\"`",
    "",
    "Now produce ONLY the answer line:",
  ].join("\n");
}

// Run `claude -p <prompt>` in a fresh subprocess and return its stdout
// trimmed. Throws on non-zero exit or timeout.
//
// Notes:
//  - No --plugin-dir → sub-claude doesn't load our hooks/MCP, no recursion.
//  - --no-session-persistence → doesn't pollute jsonl history under cwd.
//  - --max-budget-usd → hard cost cap.
//  - --dangerously-skip-permissions → no permission TUI in headless mode.
export async function autoAnswerInForceMode({ task, questions, model = DEFAULT_MODEL, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error("autoAnswerInForceMode: empty questions");
  }
  const prompt = buildAutoAnswerPrompt({ task, questions });
  const args = [
    "-p", prompt,
    "--model", model,
    "--no-session-persistence",
    "--max-budget-usd", String(DEFAULT_BUDGET_USD),
    "--output-format", "text",
    "--dangerously-skip-permissions",
  ];
  const { stdout } = await execFile("claude", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1 * 1024 * 1024,
  });
  const answer = String(stdout || "").trim();
  if (!answer) throw new Error("auto-answer subprocess returned empty stdout");
  // Sub-agent sometimes wraps the answer in code fences or quotes;
  // strip a single leading/trailing backtick line and surrounding ``` blocks.
  return stripCodeFence(answer);
}

function stripCodeFence(s) {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return s;
  if (lines.length >= 3 && /^```/.test(lines[0]) && /^```/.test(lines[lines.length - 1])) {
    return lines.slice(1, -1).join("\n").trim();
  }
  // Single-line backtick wrap: `1, 2, 3`
  const single = lines.join(" ").trim();
  return single.replace(/^`(.+)`$/, "$1").trim();
}
