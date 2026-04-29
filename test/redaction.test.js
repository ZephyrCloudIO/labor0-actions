"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { redact, shouldRedactKey } = require("../actions/lib/redaction");

test("redacts nested token, secret, credential, and prompt fields", () => {
  const value = {
    prompt: "private task prompt",
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
  assert.equal(shouldRedactKey("ANTHROPIC_AUTH_TOKEN"), true);
  assert.equal(shouldRedactKey("GITHUB_TOKEN"), true);
  assert.equal(shouldRedactKey("WEBHOOK_SECRET"), true);
  assert.equal(shouldRedactKey("provider_secret"), true);
  assert.equal(shouldRedactKey("summary"), false);
});
