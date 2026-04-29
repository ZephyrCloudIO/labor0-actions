"use strict";

const SECRET_KEYS = new Set([
  "access_token",
  "api_key",
  "authorization",
  "client_secret",
  "credential",
  "id_token",
  "password",
  "private_key",
  "prompt",
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
  return SECRET_KEYS.has(normalized) || normalized.endsWith("_token") || normalized.endsWith("_secret") || normalized.endsWith("_api_key");
}

function normalizeKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

module.exports = { normalizeKey, redact, shouldRedactKey };
