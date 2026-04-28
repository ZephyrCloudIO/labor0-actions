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
  fail,
  getInput,
  info,
  readJSON,
  setOutput,
  writeJSON,
};
