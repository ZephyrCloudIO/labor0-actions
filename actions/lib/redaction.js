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
  const normalized = key.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`).toLowerCase();
  return SECRET_KEYS.has(normalized) || normalized.endsWith("_token") || normalized.endsWith("_secret");
}

module.exports = { redact, shouldRedactKey };
