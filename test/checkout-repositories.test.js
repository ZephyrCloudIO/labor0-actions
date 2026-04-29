"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { credentialedGitURL, normalizeRef } = require("../actions/checkout-repositories/index");

test("credentialedGitURL injects token into HTTPS GitHub URLs", () => {
  assert.equal(
    credentialedGitURL({
      git_url: "https://github.com/ZephyrCloudIO/labor0-actions.git",
      token: "ghs_plain",
    }),
    "https://x-access-token:ghs_plain@github.com/ZephyrCloudIO/labor0-actions.git",
  );
});

test("credentialedGitURL converts SSH GitHub URLs with installation token to HTTPS", () => {
  assert.equal(
    credentialedGitURL({
      git_url: "git@github.com:kdy1/labor0-test.git",
      credential: {
        token: "ghs_nested",
      },
    }),
    "https://x-access-token:ghs_nested@github.com/kdy1/labor0-test.git",
  );
});

test("credentialedGitURL leaves SSH GitHub URLs without tokens unchanged", () => {
  assert.equal(
    credentialedGitURL({
      git_url: "git@github.com:kdy1/labor0-test.git",
    }),
    "git@github.com:kdy1/labor0-test.git",
  );
});

test("credentialedGitURL encodes token characters", () => {
  assert.equal(
    credentialedGitURL({
      git_url: "https://github.com/ZephyrCloudIO/labor0-actions.git",
      access_token: "ghs_plus+slash/colon:",
    }),
    "https://x-access-token:ghs_plus%2Bslash%2Fcolon%3A@github.com/ZephyrCloudIO/labor0-actions.git",
  );
});

test("normalizeRef strips Git ref prefixes", () => {
  assert.equal(normalizeRef("refs/heads/main"), "main");
  assert.equal(normalizeRef("refs/tags/v1.0.0"), "v1.0.0");
  assert.equal(normalizeRef("feature/test"), "feature/test");
});
