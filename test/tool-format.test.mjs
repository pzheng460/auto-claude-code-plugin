import test from "node:test";
import assert from "node:assert/strict";

import { formatToolUse, __test__ } from "../src/tool-format.js";

const { diffBlock, fileBlock, clipBody, compactPath } = __test__;

const limit = { maxBodyChars: 1500, maxBodyLines: 40 };

test("non-tool_use block returns null", () => {
  assert.equal(formatToolUse({ type: "text", text: "hi" }), null);
  assert.equal(formatToolUse(null), null);
  assert.equal(formatToolUse({}), null);
});

test("Edit renders a unified-diff fenced block with file path", () => {
  const out = formatToolUse({
    type: "tool_use",
    name: "Edit",
    input: {
      file_path: "/tmp/foo.js",
      old_string: "const a = 1;",
      new_string: "const a = 2;",
    },
  });
  assert.match(out, /^✏️ \*\*Edit\*\* `\/tmp\/foo\.js`/);
  assert.match(out, /```diff\n- const a = 1;\n\+ const a = 2;\n```/);
});

test("Edit with replace_all gets the all-occurrences tag", () => {
  const out = formatToolUse({
    type: "tool_use",
    name: "Edit",
    input: { file_path: "/tmp/x", old_string: "a", new_string: "b", replace_all: true },
  });
  assert.match(out, /_\(replace all\)_/);
});

test("Edit truncates very large old/new strings with a marker inside the fence", () => {
  const big = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const out = formatToolUse({
    type: "tool_use",
    name: "Edit",
    input: { file_path: "/tmp/x.txt", old_string: big, new_string: big },
  }, { maxBodyChars: 600, maxBodyLines: 20 });
  // Marker must live inside the diff fence so it stays attached visually.
  assert.match(out, /# … \+\d+ more removed/);
  assert.match(out, /# … \+\d+ more added/);
  assert.match(out, /```diff[\s\S]+```/);
});

test("MultiEdit renders up to 3 edits then summarises the rest", () => {
  const edits = Array.from({ length: 5 }, (_, i) => ({
    old_string: `o${i}`,
    new_string: `n${i}`,
  }));
  const out = formatToolUse({
    type: "tool_use",
    name: "MultiEdit",
    input: { file_path: "/tmp/m.ts", edits },
  });
  assert.match(out, /_edit 1\/5_/);
  assert.match(out, /_edit 3\/5_/);
  assert.doesNotMatch(out, /_edit 4\/5_/);
  assert.match(out, /\+2 more edit\(s\)/);
});

test("Write tags lang from extension and shows line count", () => {
  const out = formatToolUse({
    type: "tool_use",
    name: "Write",
    input: { file_path: "/tmp/sample.py", content: "def x():\n    return 1\n" },
  });
  assert.match(out, /^📝 \*\*Write\*\* `\/tmp\/sample\.py` _\(3 lines\)_/);
  assert.match(out, /```python\n[\s\S]+\n```/);
});

test("Write with no content stays a one-liner (head only)", () => {
  const out = formatToolUse({
    type: "tool_use",
    name: "Write",
    input: { file_path: "/tmp/empty.txt", content: "" },
  });
  assert.equal(out, "📝 **Write** `/tmp/empty.txt` _(0 lines)_");
});

test("Bash combines description with the command in a bash fence", () => {
  const out = formatToolUse({
    type: "tool_use",
    name: "Bash",
    input: { command: "npm test", description: "Run unit tests" },
  });
  assert.equal(
    out,
    "⚡ **Bash** · Run unit tests\n```bash\nnpm test\n```",
  );
});

test("Bash without description still renders the command", () => {
  const out = formatToolUse({
    type: "tool_use",
    name: "Bash",
    input: { command: "ls -la" },
  });
  assert.match(out, /^⚡ \*\*Bash\*\*\n```bash\nls -la\n```$/);
});

test("Read shows path and (when set) offset/limit hint", () => {
  assert.equal(
    formatToolUse({ type: "tool_use", name: "Read", input: { file_path: "/etc/hosts" } }),
    "📖 Read `/etc/hosts`",
  );
  assert.equal(
    formatToolUse({
      type: "tool_use",
      name: "Read",
      input: { file_path: "/x", offset: 100, limit: 50 },
    }),
    "📖 Read `/x` _(offset=100, limit=50)_",
  );
});

test("Grep / Glob / WebFetch / WebSearch stay one line", () => {
  assert.match(
    formatToolUse({ type: "tool_use", name: "Grep", input: { pattern: "TODO", path: "src" } }),
    /^🔎 Grep `TODO` in `src`$/,
  );
  assert.match(
    formatToolUse({ type: "tool_use", name: "Glob", input: { pattern: "**/*.js" } }),
    /^🗂 Glob `\*\*\/\*\.js`$/,
  );
  assert.match(
    formatToolUse({ type: "tool_use", name: "WebFetch", input: { url: "https://example.com/" } }),
    /^🌐 WebFetch https:\/\/example\.com\//,
  );
  assert.match(
    formatToolUse({ type: "tool_use", name: "WebSearch", input: { query: "claude code" } }),
    /^🔍 WebSearch `claude code`$/,
  );
});

test("TodoWrite shows status icons for up to 8 items", () => {
  const todos = Array.from({ length: 10 }, (_, i) => ({
    content: `task ${i}`,
    status: i === 0 ? "completed" : i === 1 ? "in_progress" : "pending",
  }));
  const out = formatToolUse({ type: "tool_use", name: "TodoWrite", input: { todos } });
  assert.match(out, /✅ task 0/);
  assert.match(out, /▶️ task 1/);
  assert.match(out, /• task 2/);
  assert.match(out, /\+2 more/);
});

test("unknown tool falls back to one-line summary", () => {
  const out = formatToolUse({
    type: "tool_use",
    name: "ExoticTool",
    input: { description: "do a thing" },
  });
  assert.equal(out, "🔧 ExoticTool(do a thing)");
});

test("HOME prefix collapses to ~ in compactPath", () => {
  const home = process.env.HOME || "";
  if (!home) return; // skip if HOME unset
  assert.equal(compactPath(`${home}/proj/x`), "~/proj/x");
  assert.equal(compactPath(home), "~");
  assert.equal(compactPath("/var/log"), "/var/log");
});

test("clipBody respects line and char caps and reports dropped lines", () => {
  const text = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
  const r = clipBody(text, { maxChars: 1000, maxLines: 5 });
  assert.equal(r.body.split("\n").length, 5);
  assert.equal(r.droppedLines, 15);
});

test("inner ``` fences are defused so the outer fence stays valid", () => {
  const out = formatToolUse({
    type: "tool_use",
    name: "Write",
    input: {
      file_path: "/tmp/readme.md",
      content: "Example:\n```js\nconsole.log(1);\n```\n",
    },
  });
  // The outer fence opens once, closes once — inner ``` must be defused.
  const opens = (out.match(/```/g) || []).length;
  assert.equal(opens, 2, "exactly one open and one close fence in the rendered body");
});
