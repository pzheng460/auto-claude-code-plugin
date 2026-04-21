// Pure formatter for assistant text pushed by bin/watcher.mjs to the chat
// channel. Tuned for feishu's lark-md renderer, which only understands
// bold/italic/inline-code/links — it chokes on ATX headings, dash-style
// bullets, and GFM tables.
//
// Previously this was three functions (multiLine → rewriteGfmTables →
// normalizeForFeishuLarkMd) each of which split and re-joined the text.
// This module folds them into one walk so per-event text passes pay for
// one split + one join instead of three.

const TABLE_HEADER_RE = /^\s*\|.+\|\s*$/;
const TABLE_SEP_RE = /^\s*\|[\s:\-|]+\|\s*$/;
const ATX_HEADING_RE = /^(\s*)(#{1,6})\s+(.+?)\s*$/;
const UL_BULLET_RE = /^(\s*)[-*+]\s+(.+)$/;

function splitTableRow(row) {
  return row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

// Walk the already-split lines, emitting the transformed output array.
// Handles three categories inline:
//  1. GFM tables (header row + separator row) expand to bold row label +
//     • bullet: value per column, matching the old rewriteGfmTables.
//  2. ATX headings (# Foo) become **Foo** bold lines.
//  3. Unordered list bullets (-, *, +) become unicode • bullets.
// Other lines pass through with trailing whitespace stripped.
function transformLines(lines) {
  const out = [];
  for (let i = 0; i < lines.length; ) {
    const line = (lines[i] ?? "").replace(/\s+$/g, "");
    const nextRaw = lines[i + 1];
    const next = nextRaw == null ? "" : nextRaw.replace(/\s+$/g, "");

    if (TABLE_HEADER_RE.test(line) && TABLE_SEP_RE.test(next)) {
      const headers = splitTableRow(line);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && TABLE_HEADER_RE.test(lines[j])) {
        rows.push(splitTableRow(lines[j]));
        j++;
      }
      for (const row of rows) {
        const label = row[0] || "—";
        out.push(`**${label}**`);
        const cols = Math.max(row.length, headers.length);
        for (let k = 1; k < cols; k++) {
          const key = headers[k] || `列${k}`;
          // Old pipeline emitted "- k: v" then rewrote to "• k: v" in a
          // second normalize pass. Skip straight to the final form.
          out.push(`• ${key}: ${row[k] ?? ""}`);
        }
        out.push("");
      }
      i = j;
      continue;
    }

    const h = line.match(ATX_HEADING_RE);
    if (h) {
      out.push(`${h[1]}**${h[3]}**`);
      i++;
      continue;
    }

    const ul = line.match(UL_BULLET_RE);
    if (ul) {
      out.push(`${ul[1]}• ${ul[2]}`);
      i++;
      continue;
    }

    out.push(line);
    i++;
  }
  return out;
}

/**
 * Convert assistant text to feishu-friendly markdown and ellipsis-truncate
 * to `maxLen` characters. Single-pass replacement for the old three-phase
 * pipeline.
 */
export function formatAssistantText(s, maxLen) {
  const raw = (s ?? "").toString().replace(/\r/g, "");
  const transformed = transformLines(raw.split("\n"));
  const joined = transformed.join("\n").trim();
  if (!Number.isFinite(maxLen) || joined.length <= maxLen) return joined;
  return `${joined.slice(0, maxLen - 1)}…`;
}

// Internal helpers exported purely for unit tests — the production
// pipeline only needs formatAssistantText.
export const _internal = { transformLines, splitTableRow };
