"use strict";

const SECRET_KEYS = new Set([
  "access_token",
  "authorization",
  "client_secret",
  "credential",
  "id_token",
  "password",
  "private_key",
  "prompt",
  "api_key",
  "auth_token",
  "secret",
  "token",
]);

function redact(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = shouldRedactKey(key) ? "[REDACTED]" : redact(item);
    }
    return output;
  }
  return value;
}

function shouldRedactKey(key) {
  const normalized = normalizeKey(key);
  return (
    SECRET_KEYS.has(normalized) ||
    normalized.endsWith("_api_key") ||
    normalized.endsWith("_auth_token") ||
    normalized.endsWith("_token") ||
    normalized.endsWith("_secret")
  );
}

function normalizeKey(key) {
  return String(key || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

module.exports = { normalizeKey, redact, shouldRedactKey };
