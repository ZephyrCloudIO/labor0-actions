"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function getInput(name, options = {}) {
  const key = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  const value = (process.env[key] || "").trim();
  if (options.required && !value) {
    throw new Error(`Missing required input: ${name}`);
  }
  return value;
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}${os.EOL}`, "utf8");
    return;
  }
  process.stdout.write(`::set-output name=${name}::${escapeCommand(value)}${os.EOL}`);
}

function addMask(value) {
  if (value) {
    process.stdout.write(`::add-mask::${escapeCommand(String(value))}${os.EOL}`);
  }
}

function info(message) {
  process.stdout.write(`${message}${os.EOL}`);
}

function isRunnerDebug(env = process.env) {
  return String(env.RUNNER_DEBUG || "") === "1";
}

function isAgentDebug(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.LABOR0_AGENT_DEBUG || "").trim());
}

function isDebugMode(env = process.env) {
  return isRunnerDebug(env) || isAgentDebug(env);
}

function debug(message, env = process.env) {
  if (isRunnerDebug(env)) {
    process.stdout.write(`::debug::${escapeCommand(message)}${os.EOL}`);
  }
  if (isAgentDebug(env)) {
    info(`[debug] ${message}`);
  }
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`::error::${escapeCommand(message)}${os.EOL}`);
  process.exitCode = 1;
}

function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJSON(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function escapeCommand(value) {
  return String(value)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

module.exports = {
  addMask,
  debug,
  fail,
  getInput,
  info,
  isAgentDebug,
  isDebugMode,
  isRunnerDebug,
  readJSON,
  setOutput,
  writeJSON,
};
