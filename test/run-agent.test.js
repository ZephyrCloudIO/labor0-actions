"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  graphUpdateDraftFromOutput,
  runtimeCommand,
  shouldCreatePullRequest,
} = require("../actions/run-agent/index");

test("codex command passes model and graph update schema", () => {
  const command = runtimeCommand(
    {
      agent_runtime_type: "codex",
      agent_task_purpose: "graph_update",
      agent_model: "gpt-5.4",
      prompt: "Plan follow-up tasks",
    },
    { graphUpdateSchemaPath: "/tmp/graph-update.schema.json" },
  );

  assert.deepEqual(command.slice(0, 7), [
    "codex",
    "exec",
    "--full-auto",
    "--sandbox",
    "danger-full-access",
    "--skip-git-repo-check",
    "--output-schema",
  ]);
  assert.equal(command[7], "/tmp/graph-update.schema.json");
  assert.equal(command[8], "--model");
  assert.equal(command[9], "gpt-5.4");
  assert.match(command.at(-1), /Return only one JSON object/);
});

test("claude command passes model and structured output schema", () => {
  const command = runtimeCommand(
    {
      agent_runtime_type: "claude_code",
      agent_task_purpose: "graph_update",
      agent_model: "claude-sonnet-4-6",
      prompt: "Plan follow-up tasks",
    },
    { graphUpdateSchemaPath: "/tmp/graph-update.schema.json" },
  );

  assert.equal(command[0], "claude");
  assert.equal(command[1], "-p");
  assert.deepEqual(command.slice(2, 6), ["--permission-mode", "bypassPermissions", "--json-schema", command[5]]);
  assert.doesNotThrow(() => JSON.parse(command[5]));
  assert.equal(command[6], "--model");
  assert.equal(command[7], "claude-sonnet-4-6");
  assert.match(command.at(-1), /Return only one JSON object/);
});

test("graph update draft extraction accepts stdout around JSON", () => {
  const draft = graphUpdateDraftFromOutput(
    { agent_task_session_id: "0199e7be-9000-7000-8000-000000000001" },
    `planning done
{
  "summary": "Create task",
  "task_drafts": [
    {
      "draft_task_key": "implement-runtime",
      "task_type": "agent_execution",
      "title": "Implement runtime",
      "description": "Wire the runtime",
      "execution_repository_bindings": []
    }
  ],
  "upsert_edges": [],
  "remove_edges": []
}`,
  );

  assert.equal(draft.source_agent_task_session_id, "0199e7be-9000-7000-8000-000000000001");
  assert.equal(draft.task_drafts[0].draft_task_key, "implement-runtime");
  assert.deepEqual(draft.upsert_edges, []);
  assert.deepEqual(draft.remove_edges, []);
});

test("pull request creation defaults on for read-write repositories only", () => {
  assert.equal(shouldCreatePullRequest({ access_mode: "read_write" }), true);
  assert.equal(
    shouldCreatePullRequest({ access_mode: "read_write", auto_pull_request_enabled: false }),
    false,
  );
  assert.equal(shouldCreatePullRequest({ access_mode: "read_only" }), false);
});
