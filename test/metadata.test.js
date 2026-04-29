"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const actionDirs = [
  "actions/bootstrap",
  "actions/checkout-repositories",
  "actions/run-agent",
  "actions/report-event",
];

test("all action metadata uses Node 24 entrypoints", () => {
  for (const actionDir of actionDirs) {
    const metadata = fs.readFileSync(path.join(root, actionDir, "action.yml"), "utf8");
    assert.match(metadata, /runs:\n\s+using:\s+node24\n\s+main:\s+index\.js/);
    assert.ok(fs.existsSync(path.join(root, actionDir, "index.js")), `${actionDir} index.js missing`);
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
  assert.match(workflow, /labor0-actions\/actions\/run-agent@main/);
});
