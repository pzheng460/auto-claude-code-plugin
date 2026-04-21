// Used by state.test.mjs — child process that performs a single
// increment to state.autoContinueCount so the parent can assert no
// updates were lost under concurrent writers.
import { updateState } from "../../src/state.js";

const [, , stateDir] = process.argv;
if (!stateDir) {
  console.error("usage: concurrent-writer.mjs <stateDir>");
  process.exit(2);
}

updateState(stateDir, (prev) => ({
  ...prev,
  autoContinueCount: (prev.autoContinueCount ?? 0) + 1,
}));
