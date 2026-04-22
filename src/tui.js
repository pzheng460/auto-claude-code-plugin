// Helpers that parse Claude Code's TUI output from capture-pane snapshots.
// Shared by watcher.mjs (form auto-fill + surfacing) and commands.js
// (cmdForm auto-advance detection).

// Detect Claude Code's multi-step form tab bar, e.g.
//   ←  ☐ README  ☒ License  ✔ Submit  →
// Glyphs: ☐ unanswered, ☒ current / partially answered, ✔/✓/✅ completed.
// Returns { tabs: [{ glyph, done, label }] } or null.
export function detectMultiStepForm(paneText) {
  if (!paneText) return null;
  const lines = paneText.split("\n");
  for (const line of lines) {
    if (!line.includes("←") || !line.includes("→")) continue;
    if (!/[☐☒✔✓✅]/.test(line)) continue;
    const inner = line.replace("←", "").replace("→", "");
    const tabs = [];
    const re = /([☐☒✔✓✅])\s+([^☐☒✔✓✅]+?)(?=\s+[☐☒✔✓✅]|\s*$)/g;
    let m;
    while ((m = re.exec(inner)) !== null) {
      tabs.push({
        glyph: m[1],
        done: m[1] === "✔" || m[1] === "✓" || m[1] === "✅",
        label: m[2].trim(),
      });
    }
    if (tabs.length >= 2) return { tabs };
  }
  return null;
}

// Extract the modal body (question + numbered options + description lines)
// from a pane snapshot. Anchors on the first `1.` line, walks forward
// picking up every line until a TUI boundary, and walks backward including
// the question text above.
export function extractModalBlock(pane) {
  if (!pane) return null;
  const lines = pane.split("\n");
  let firstOpt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*❯?\s*1\.\s+/.test(lines[i])) { firstOpt = i; break; }
  }
  if (firstOpt < 0) return null;

  let lastOpt = firstOpt;
  for (let i = firstOpt + 1; i < Math.min(lines.length, firstOpt + 20); i++) {
    const line = lines[i];
    if (/^[\s]*[─━═\-]{8,}/.test(line)) break;
    if (/Enter to (select|submit|amend|send|confirm)|Tab\/Arrow|Esc to cancel|ctrl\+/i.test(line)) break;
    if (line.includes("←") && line.includes("→")) break;
    lastOpt = i;
  }

  let ctxStart = firstOpt;
  let blankRun = 0;
  for (let i = firstOpt - 1; i >= Math.max(0, firstOpt - 15); i--) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { blankRun++; if (blankRun >= 2) break; continue; }
    blankRun = 0;
    if (/(─{6,}|━{6,}|═{6,}|-{10,})/.test(t)) break;
    if (line.includes("←") && line.includes("→")) break;
    ctxStart = i;
  }

  const cleaned = lines.slice(ctxStart, lastOpt + 1)
    .map((l) => l.replace(/^\s*❯\s?/, "").replace(/\s+$/, ""));
  while (cleaned.length && cleaned[0].trim() === "") cleaned.shift();
  while (cleaned.length && cleaned[cleaned.length - 1].trim() === "") cleaned.pop();
  return cleaned.length ? cleaned.join("\n") : null;
}

// Compact fingerprint of the modal body. Used for auto-advance detection:
// compare sig(pre) to sig(post) around a key press — if they differ, the
// TUI moved to a different tab / question.
export function modalSignature(paneText) {
  const block = extractModalBlock(paneText);
  if (!block) return "";
  return block.split("\n").slice(0, 4).map((l) => l.trim()).join(" | ").slice(0, 140);
}
