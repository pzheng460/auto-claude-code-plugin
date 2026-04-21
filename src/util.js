// Tiny shared helpers used across launch/tmux/watcher/render. Keeping them
// here removes 4× duplicated `sleep` and 3× near-duplicated `oneLine` impls.

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Collapse whitespace runs to a single space and ellipsize at `n` chars.
// Used for compact log/status lines where line breaks would be noise.
export function oneLine(s, n) {
  const t = (s ?? "").toString().replace(/\s+/g, " ").trim();
  if (!n || t.length <= n) return t;
  return `${t.slice(0, n - 1)}…`;
}
