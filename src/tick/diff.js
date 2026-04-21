// Compute transitions between two todo snapshots from consecutive ticks.
//
// We match by (index, content) rather than by content alone because Claude
// frequently writes duplicate todo descriptions (e.g. two "Run tests" steps
// at different phases of a plan). Content-only keying would falsely credit
// one duplicate with the status change of the other.
//
// Returns { completed, started, added } — each an array of content strings.
export function diffTodos(prev, curr) {
  const prevList = Array.isArray(prev) ? prev : [];
  const currList = Array.isArray(curr) ? curr : [];

  const prevByKey = new Map();
  for (let i = 0; i < prevList.length; i++) {
    const t = prevList[i];
    const key = `${i}|${t?.content ?? ""}`;
    prevByKey.set(key, t?.status);
  }

  const out = { completed: [], started: [], added: [] };
  for (let i = 0; i < currList.length; i++) {
    const t = currList[i];
    const key = `${i}|${t?.content ?? ""}`;
    const prior = prevByKey.get(key);
    if (prior === undefined) {
      out.added.push(t.content);
    } else if (prior !== "completed" && t.status === "completed") {
      out.completed.push(t.content);
    } else if (prior !== "in_progress" && t.status === "in_progress") {
      out.started.push(t.content);
    }
  }
  return out;
}
