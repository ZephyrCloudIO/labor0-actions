"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { redact, shouldRedactKey } = require("../actions/lib/redaction");

test("redacts nested token, secret, credential, and prompt fields", () => {
  const value = {
    prompt: "private task prompt",
    agent_runtime_environment: {
      OPENAI_API_KEY: "api-key",
    },
    nested: {
      accessToken: "token",
      regular: "visible",
      credential: {
        token: "nested-token",
      },
    },
  };
  assert.deepEqual(redact(value), {
    prompt: "[REDACTED]",
    agent_runtime_environment: {
      OPENAI_API_KEY: "[REDACTED]",
    },
    nested: {
      accessToken: "[REDACTED]",
      regular: "visible",
      credential: "[REDACTED]",
    },
  });
});

test("detects common secret key spellings", () => {
  assert.equal(shouldRedactKey("access_token"), true);
  assert.equal(shouldRedactKey("accessToken"), true);
  assert.equal(shouldRedactKey("OPENAI_API_KEY"), true);
  assert.equal(shouldRedactKey("provider_secret"), true);
  assert.equal(shouldRedactKey("summary"), false);
});
