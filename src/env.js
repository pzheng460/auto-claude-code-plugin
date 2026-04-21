// Env-var parsers that warn on invalid input instead of silently using the
// fallback. A typo like `AUTO_CLAUDE_CODE_NUDGE_AFTER_SEC=abc` used to
// silently fall through to the default and no one noticed until behaviour
// looked wrong days later — now it prints one line to stderr so the
// misconfiguration is visible in watcher.log / cron output.

function warn(name, rawValue, fallback, why) {
  if (typeof process === "undefined") return;
  // Only warn when env was set but unusable — a missing var is not a bug.
  process.stderr.write(
    `[auto-claude-code] ${name}="${rawValue}" ${why}; using ${fallback}\n`,
  );
}

// Returns a positive finite number from process.env[name], or `fallback` if
// the var is unset. If the var is set to something that can't be parsed as a
// positive number, emits a warning to stderr and still returns `fallback`.
export function envNum(name, fallback, { min = 1 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    warn(name, raw, fallback, "is not a number");
    return fallback;
  }
  if (v < min) {
    warn(name, raw, fallback, `is below minimum ${min}`);
    return fallback;
  }
  return v;
}

// Parses 1/true/yes/on (case-insensitive) as true, 0/false/no/off as false.
// Anything else set but unparseable emits a warning and returns `fallback`.
export function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  warn(name, raw, String(fallback), "is not a boolean (expected 1/0/true/false)");
  return fallback;
}
