import test from "node:test";
import assert from "node:assert/strict";

import { parseInterval } from "../src/cron.js";

test("bare numbers default to minutes", () => {
  assert.equal(parseInterval("5").cron, "*/5 * * * *");
});

test("1m is */1 equivalent (every minute)", () => {
  assert.equal(parseInterval("1m").cron, "* * * * *");
});

test("arbitrary 1-59 minute intervals are accepted", () => {
  for (const n of [2, 3, 5, 7, 13, 15, 17, 30, 45, 59]) {
    const r = parseInterval(`${n}m`);
    assert.equal(r.error, undefined, `${n}m should not error`);
    assert.equal(r.cron, `*/${n} * * * *`);
  }
});

test("seconds must divide 60 evenly", () => {
  assert.equal(parseInterval("30s").cron, "*/30 * * * * *");
  assert.equal(parseInterval("15s").cron, "*/15 * * * * *");
  assert.ok(parseInterval("7s").error, "7s does not divide 60");
});

test("seconds >= 60 roll up into minutes", () => {
  assert.equal(parseInterval("60s").cron, "0 */1 * * * *");
  assert.equal(parseInterval("120s").cron, "0 */2 * * * *");
});

test("hours", () => {
  assert.equal(parseInterval("1h").cron, "0 * * * *");
  assert.equal(parseInterval("2h").cron, "0 */2 * * *");
  assert.ok(parseInterval("24h").error);
});

test("raw cron expressions pass through unchanged", () => {
  assert.equal(parseInterval("*/5 * * * *").cron, "*/5 * * * *");
  assert.equal(parseInterval("0 */2 * * *").cron, "0 */2 * * *");
});

test("unit aliases", () => {
  assert.equal(parseInterval("5 minutes").cron, "*/5 * * * *");
  assert.equal(parseInterval("45m").cron, "*/45 * * * *");
  assert.equal(parseInterval("2 hours").cron, "0 */2 * * *");
});

test("empty / invalid input", () => {
  assert.equal(parseInterval("").cron, null);
  assert.equal(parseInterval(null).cron, null);
  assert.ok(parseInterval("five minutes").error);
});
