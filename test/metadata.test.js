"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const actionEntrypoints = new Map([
  ["actions/bootstrap", "index.js"],
  ["actions/checkout-repositories", "index.js"],
  ["actions/run-agent", "dist/index.js"],
  ["actions/report-event", "index.js"],
]);

test("all action metadata uses Node 24 entrypoints", () => {
  for (const [actionDir, entrypoint] of actionEntrypoints) {
    const metadata = fs.readFileSync(path.join(root, actionDir, "action.yml"), "utf8");
    assert.match(metadata, new RegExp(`runs:\\n\\s+using:\\s+node24\\n\\s+main:\\s+${escapeRegExp(entrypoint)}`));
    assert.ok(fs.existsSync(path.join(root, actionDir, "index.js")), `${actionDir} index.js missing`);
    assert.ok(fs.existsSync(path.join(root, actionDir, entrypoint)), `${actionDir} ${entrypoint} missing`);
  }
});

test("reusable workflow only accepts session bootstrap inputs", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/agent-task.yml"), "utf8");
  assert.match(workflow, /agent_task_session_id:/);
  assert.match(workflow, /graph_agent_base_url:/);
  assert.doesNotMatch(workflow, /prompt:/);
  assert.doesNotMatch(workflow, /provider_secret:/);
  assert.doesNotMatch(workflow, /repo_token:/);
  assert.match(workflow, /contents:\s+write/);
  assert.match(workflow, /id-token:\s+write/);
  assert.match(workflow, /graph_update_draft_path:/);
  assert.match(workflow, /pull_requests_path:/);
  assert.match(workflow, /debug_artifact_path/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /labor0-actions\/actions\/run-agent@main/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
