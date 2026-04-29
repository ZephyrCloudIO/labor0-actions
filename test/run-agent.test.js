"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  graphUpdateDraftFromOutput,
  prepareCodexAuthentication,
  prepareOpenCodeAuthentication,
  runtimeAuthStatus,
  runtimeCommand,
  shouldCreatePullRequest,
  synthesizeOpenCodeConfig,
  validateRuntimeAuth,
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

test("opencode command passes model and permission bypass", () => {
  const command = runtimeCommand({
    agent_runtime_type: "opencode",
    agent_task_purpose: "coding",
    agent_model: "openai/gpt-5.4",
    prompt: "Implement runtime auth",
  });

  assert.deepEqual(command, [
    "opencode",
    "run",
    "--dangerously-skip-permissions",
    "--model",
    "openai/gpt-5.4",
    "Implement runtime auth",
  ]);
});

test("runtime auth validation reports missing provider credentials", () => {
  assert.deepEqual(runtimeAuthStatus("codex", {}), {
    ok: false,
    missing: ["OPENAI_API_KEY"],
  });
  assert.deepEqual(runtimeAuthStatus("claude_code", { ANTHROPIC_AUTH_TOKEN: "token" }), {
    ok: true,
    missing: [],
  });
  assert.deepEqual(runtimeAuthStatus("opencode", { OPENCODE_CONFIG_CONTENT: "{}" }), {
    ok: true,
    missing: [],
  });
  assert.throws(
    () => validateRuntimeAuth({ agent_runtime_type: "opencode" }, {}),
    /OPENAI_API_KEY or ANTHROPIC_API_KEY or OPENCODE_CONFIG_CONTENT/,
  );
});

test("codex auth preparation uses a temporary CODEX_HOME and stdin login", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "labor0-codex-test-"));
  const calls = [];
  const env = { OPENAI_API_KEY: "sk-test" };

  const codexHome = prepareCodexAuthentication(env, {
    tempDir,
    runner: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(env.CODEX_HOME, codexHome);
  assert.match(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), /forced_login_method = "api"/);
  assert.equal(calls[0].command, "codex");
  assert.deepEqual(calls[0].args, ["login", "--with-api-key"]);
  assert.equal(calls[0].options.input, "sk-test\n");
});

test("opencode auth preparation synthesizes env-substituted provider config", () => {
  const env = {
    ANTHROPIC_API_KEY: "sk-ant",
    ANTHROPIC_BASE_URL: "https://anthropic.example",
    OPENAI_API_KEY: "sk-openai",
  };

  const content = prepareOpenCodeAuthentication(env);
  const parsed = JSON.parse(content);

  assert.equal(parsed.$schema, "https://opencode.ai/config.json");
  assert.equal(parsed.provider.openai.options.apiKey, "{env:OPENAI_API_KEY}");
  assert.equal(parsed.provider.anthropic.options.apiKey, "{env:ANTHROPIC_API_KEY}");
  assert.equal(parsed.provider.anthropic.options.baseURL, "{env:ANTHROPIC_BASE_URL}");
  assert.equal(content.includes("sk-openai"), false);
  assert.deepEqual(synthesizeOpenCodeConfig({}), {
    $schema: "https://opencode.ai/config.json",
    provider: {},
  });
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
