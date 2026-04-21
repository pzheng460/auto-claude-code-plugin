import test from "node:test";
import assert from "node:assert/strict";

import { envNum, envBool } from "../src/env.js";

const KEY = "ACC_TEST_ENV_VAR";

function withEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, KEY);
  const prev = process.env[KEY];
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[KEY] = prev;
    else delete process.env[KEY];
  }
}

function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = (chunk) => {
    captured += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    return true;
  };
  try { fn(); } finally { process.stderr.write = original; }
  return captured;
}

test("envNum: unset → fallback, no warning", () => {
  const stderr = captureStderr(() => {
    withEnv(undefined, () => {
      assert.equal(envNum(KEY, 42), 42);
    });
  });
  assert.equal(stderr, "");
});

test("envNum: valid numeric string parses", () => {
  const stderr = captureStderr(() => {
    withEnv("123", () => {
      assert.equal(envNum(KEY, 42), 123);
    });
  });
  assert.equal(stderr, "");
});

test("envNum: non-numeric value → warns and falls back", () => {
  const stderr = captureStderr(() => {
    withEnv("abc", () => {
      assert.equal(envNum(KEY, 7), 7);
    });
  });
  assert.match(stderr, new RegExp(`${KEY}="abc"`));
  assert.match(stderr, /is not a number/);
});

test("envNum: below min → warns and falls back", () => {
  const stderr = captureStderr(() => {
    withEnv("0", () => {
      assert.equal(envNum(KEY, 5), 5);
    });
  });
  assert.match(stderr, /below minimum/);
});

test("envNum: custom min allows lower values", () => {
  const stderr = captureStderr(() => {
    withEnv("2", () => {
      assert.equal(envNum(KEY, 5, { min: 1 }), 2);
    });
  });
  assert.equal(stderr, "");
});

test("envBool: truthy strings → true, falsy strings → false", () => {
  for (const v of ["1", "true", "yes", "on", "TRUE"]) {
    withEnv(v, () => {
      assert.equal(envBool(KEY), true, `expected true for "${v}"`);
    });
  }
  for (const v of ["0", "false", "no", "off", "FALSE"]) {
    withEnv(v, () => {
      assert.equal(envBool(KEY), false, `expected false for "${v}"`);
    });
  }
});

test("envBool: unrecognised value → warns and falls back", () => {
  const captured = captureStderr(() => {
    withEnv("maybe", () => {
      assert.equal(envBool(KEY, false), false);
    });
  });
  assert.match(captured, /is not a boolean/);
});
