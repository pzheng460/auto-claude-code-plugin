// Format a Claude Code `tool_use` content block as a chat-friendly,
// multi-line body. Replaces the watcher's older one-line summary
// (`🔧 Edit(/path/to/file)`), which dropped the actual code change. Now
// Edit/Write/MultiEdit/NotebookEdit/Bash render fenced diffs or fenced
// content; read-only tools (Read/Grep/Glob/…) stay one line so the
// stream doesn't drown in noise.
//
// Hard caps per tool block (env-tunable so a runaway Write can't paste
// thousands of lines into chat):
//   AUTO_CLAUDE_CODE_TOOL_BODY_CHARS   default 1500
//   AUTO_CLAUDE_CODE_TOOL_BODY_LINES   default 40
// The watcher's outer splitForChat() handles per-message length caps.
//
// Markdown surface kept narrow: fenced code, inline `code`, **bold**,
// `_italic_`. Feishu lark-md and Telegram both render that subset
// reliably; ATX headings / pipe tables / GFM bullets do NOT (which is
// why watcher-format.js rewrites them when they appear in plain text).

import { envNum } from "./env.js";

const DEFAULT_BODY_CHARS = 1500;
const DEFAULT_BODY_LINES = 40;

const LANG_BY_EXT = {
  js: "js", mjs: "js", cjs: "js",
  ts: "ts", tsx: "tsx", jsx: "jsx",
  py: "python",
  rb: "ruby", go: "go", rs: "rust",
  java: "java", kt: "kotlin", swift: "swift",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp",
  cs: "csharp", php: "php",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  xml: "xml", html: "html", htm: "html",
  css: "css", scss: "scss",
  md: "markdown", sql: "sql", lua: "lua", r: "r",
};

function extOf(p) {
  const m = String(p ?? "").match(/\.([^.\/\\]+)$/);
  return m ? m[1].toLowerCase() : "";
}

function langFor(p) {
  return LANG_BY_EXT[extOf(p)] || "";
}

// Replace $HOME prefix with `~` so paths render compactly in chat.
function compactPath(p) {
  if (!p) return "";
  const s = String(p);
  const home = process.env.HOME;
  if (home && (s === home || s.startsWith(home + "/"))) {
    return "~" + s.slice(home.length);
  }
  return s;
}

function shorten(s, n) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (!n || t.length <= n) return t;
  return t.slice(0, n - 1) + "…";
}

// Clip a multi-line body to at most `maxLines` lines and `maxChars` chars,
// reporting how many lines were dropped so the caller can append a
// "+N more lines" marker inside the same code block.
function clipBody(text, { maxChars, maxLines }) {
  const s = String(text ?? "");
  if (!s) return { body: "", droppedLines: 0 };
  const lines = s.split("\n");
  let kept = lines;
  let droppedLines = 0;
  if (lines.length > maxLines) {
    kept = lines.slice(0, maxLines);
    droppedLines = lines.length - maxLines;
  }
  let body = kept.join("\n");
  if (body.length > maxChars) {
    // Prefer cutting on a newline boundary so we don't slice mid-token.
    const cut = body.lastIndexOf("\n", maxChars);
    if (cut >= maxChars - 200) {
      droppedLines += body.slice(cut + 1).split("\n").length;
      body = body.slice(0, cut);
    } else {
      body = body.slice(0, maxChars);
      droppedLines = Math.max(droppedLines, 1);
    }
  }
  return { body, droppedLines };
}

// Wrap body in a fenced code block. Defuses any inner ``` so the outer
// fence stays well-formed when claude includes a markdown sample as the
// edit content.
function fence(body, lang = "") {
  if (!body) return "";
  const safe = body.replace(/```/g, "ʼʼʼ");
  return "```" + (lang || "") + "\n" + safe + "\n```";
}


// Render a unified-diff-style block for an Edit. Budget is split per side
// so a giant `old_string` can't crowd out `new_string`. Truncation marker
// is rendered inside the fence as a `# … +N more` line — survives
// `lang=diff` highlighting and stays visually attached to the block.
function diffBlock(oldStr, newStr, limit) {
  const half = {
    maxChars: Math.max(180, Math.floor(limit.maxBodyChars / 2)),
    maxLines: Math.max(4, Math.floor(limit.maxBodyLines / 2)),
  };
  const oldClip = clipBody(oldStr, half);
  const newClip = clipBody(newStr, half);
  const segs = [];
  if (oldClip.body) {
    segs.push(oldClip.body.split("\n").map((l) => "- " + l).join("\n"));
    if (oldClip.droppedLines) {
      segs.push(`# … +${oldClip.droppedLines} more removed line${oldClip.droppedLines === 1 ? "" : "s"}`);
    }
  }
  if (newClip.body || !oldClip.body) {
    segs.push(newClip.body.split("\n").map((l) => "+ " + l).join("\n"));
    if (newClip.droppedLines) {
      segs.push(`# … +${newClip.droppedLines} more added line${newClip.droppedLines === 1 ? "" : "s"}`);
    }
  }
  return fence(segs.join("\n"), "diff");
}

// Render a full-content block (Write / NotebookEdit) with a language hint
// derived from the file extension.
function fileBlock(content, lang, limit) {
  const { body, droppedLines } = clipBody(content, {
    maxChars: limit.maxBodyChars,
    maxLines: limit.maxBodyLines,
  });
  const tail = droppedLines
    ? `\n# … +${droppedLines} more line${droppedLines === 1 ? "" : "s"}`
    : "";
  return fence(body + tail, lang);
}

function resolveLimits(opts) {
  return {
    maxBodyChars: Number.isFinite(opts?.maxBodyChars)
      ? opts.maxBodyChars
      : envNum("AUTO_CLAUDE_CODE_TOOL_BODY_CHARS", DEFAULT_BODY_CHARS),
    maxBodyLines: Number.isFinite(opts?.maxBodyLines)
      ? opts.maxBodyLines
      : envNum("AUTO_CLAUDE_CODE_TOOL_BODY_LINES", DEFAULT_BODY_LINES),
  };
}

export function formatToolUse(block, opts = {}) {
  if (!block || typeof block !== "object" || block.type !== "tool_use") return null;
  const limit = resolveLimits(opts);
  const name = String(block.name || "tool");
  const input = block.input || {};

  switch (name) {
    case "Edit": {
      const path = compactPath(input.file_path);
      const tag = input.replace_all ? " _(replace all)_" : "";
      const head = `✏️ **Edit** \`${path}\`${tag}`;
      const body = diffBlock(input.old_string, input.new_string, limit);
      return body ? `${head}\n${body}` : head;
    }

    case "MultiEdit": {
      const path = compactPath(input.file_path);
      const edits = Array.isArray(input.edits) ? input.edits : [];
      const head = `✏️ **MultiEdit** \`${path}\` _(${edits.length} edit${edits.length === 1 ? "" : "s"})_`;
      const SHOW = Math.min(edits.length, 3);
      const perEdit = SHOW > 0
        ? {
            maxBodyChars: Math.max(240, Math.floor(limit.maxBodyChars / SHOW)),
            maxBodyLines: Math.max(6, Math.floor(limit.maxBodyLines / SHOW)),
          }
        : limit;
      const blocks = [];
      for (let i = 0; i < SHOW; i++) {
        const e = edits[i] || {};
        const tag = e.replace_all ? " _(replace all)_" : "";
        blocks.push(`_edit ${i + 1}/${edits.length}_${tag}\n${diffBlock(e.old_string, e.new_string, perEdit)}`);
      }
      if (edits.length > SHOW) blocks.push(`_… +${edits.length - SHOW} more edit(s)_`);
      return [head, ...blocks].join("\n");
    }

    case "Write": {
      const path = compactPath(input.file_path);
      const content = String(input.content ?? "");
      const total = content === "" ? 0 : content.split("\n").length;
      const head = `📝 **Write** \`${path}\` _(${total} line${total === 1 ? "" : "s"})_`;
      const body = content ? fileBlock(content, langFor(path), limit) : "";
      return body ? `${head}\n${body}` : head;
    }

    case "NotebookEdit": {
      const path = compactPath(input.notebook_path);
      const cell = input.cell_id ? ` cell \`${input.cell_id}\`` : "";
      const mode = input.edit_mode || input.editMode || "replace";
      const head = `📓 **NotebookEdit** \`${path}\`${cell} _(${mode})_`;
      const body = input.new_source ? fileBlock(String(input.new_source), "python", limit) : "";
      return body ? `${head}\n${body}` : head;
    }

    case "Bash": {
      const cmd = String(input.command ?? "");
      const desc = shorten(input.description, 100);
      const head = desc ? `⚡ **Bash** · ${desc}` : `⚡ **Bash**`;
      const clipped = clipBody(cmd, { maxChars: limit.maxBodyChars, maxLines: limit.maxBodyLines });
      const body = clipped.body
        ? fence(clipped.body + (clipped.droppedLines ? `\n# … +${clipped.droppedLines} more line(s)` : ""), "bash")
        : "";
      return body ? `${head}\n${body}` : head;
    }

    case "Read": {
      const path = compactPath(input.file_path);
      const range = (input.offset != null || input.limit != null)
        ? ` _(offset=${input.offset ?? 0}${input.limit != null ? `, limit=${input.limit}` : ""})_`
        : "";
      return `📖 Read \`${path}\`${range}`;
    }

    case "Grep": {
      const pat = shorten(input.pattern, 120);
      const where = input.path ? ` in \`${compactPath(input.path)}\`` : "";
      const glob = input.glob ? ` glob=\`${shorten(input.glob, 60)}\`` : "";
      return `🔎 Grep \`${pat}\`${where}${glob}`;
    }

    case "Glob": {
      const pat = shorten(input.pattern, 120);
      const where = input.path ? ` in \`${compactPath(input.path)}\`` : "";
      return `🗂 Glob \`${pat}\`${where}`;
    }

    case "WebFetch":
      return `🌐 WebFetch ${shorten(input.url, 200)}`;

    case "WebSearch":
      return `🔍 WebSearch \`${shorten(input.query, 160)}\``;

    case "Task": {
      const sub = input.subagent_type ? `[${input.subagent_type}]` : "";
      const desc = shorten(input.description || input.prompt, 120);
      return `🤖 Task${sub} · ${desc}`;
    }

    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate": {
      const todos = Array.isArray(input.todos) ? input.todos : Array.isArray(input.tasks) ? input.tasks : [];
      // TaskCreate sometimes carries a single-task shape (subject/description) rather than an array.
      if (!todos.length && (input.subject || input.description)) {
        return `📋 **${name}** · ${shorten(input.subject || input.description, 120)}`;
      }
      const head = `📋 **${name}** _(${todos.length} item${todos.length === 1 ? "" : "s"})_`;
      const SHOW = 8;
      const lines = todos.slice(0, SHOW).map((t) => {
        const status = t.status || t.state || "pending";
        const icon = status === "completed" ? "✅" : status === "in_progress" ? "▶️" : "•";
        return `${icon} ${shorten(t.content || t.subject || t.description || "", 100)}`;
      });
      if (todos.length > SHOW) lines.push(`… +${todos.length - SHOW} more`);
      return [head, ...lines].join("\n");
    }

    default: {
      const arg =
        compactPath(input.file_path) ||
        compactPath(input.notebook_path) ||
        input.command ||
        input.pattern ||
        input.url ||
        input.query ||
        input.description ||
        "";
      const shown = arg ? `(${shorten(arg, 120)})` : "";
      return `🔧 ${name}${shown}`;
    }
  }
}

// Internal exports for unit testing — production code uses formatToolUse.
export const __test__ = {
  diffBlock,
  fileBlock,
  clipBody,
  fence,
  compactPath,
  langFor,
};
