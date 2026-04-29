"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { isDebugMode } = require("../actions/lib/core");
const {
  graphUpdateDraftFromOutput,
  prepareClaudeCodeAuthentication,
  prepareCodexAuthentication,
  prepareOpenCodeAuthentication,
  runtimeAuthStatus,
  runtimeCommand,
  runAgent,
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
  assert.deepEqual(command.slice(2, 8), [
    "--permission-mode",
    "bypassPermissions",
    "--output-format",
    "json",
    "--json-schema",
    command[7],
  ]);
  assert.doesNotThrow(() => JSON.parse(command[7]));
  assert.equal(command[8], "--model");
  assert.equal(command[9], "claude-sonnet-4-6");
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
    missing: [
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "CODEX_AGENT_IDENTITY",
      "CODEX_AUTH_JSON_CONTENT",
      "CODEX_CONFIG_CONTENT",
    ],
  });
  assert.deepEqual(runtimeAuthStatus("codex", { CODEX_AUTH_JSON_CONTENT: "{}" }), {
    ok: true,
    missing: [],
  });
  assert.deepEqual(runtimeAuthStatus("claude_code", { CLAUDE_CODE_OAUTH_TOKEN: "token" }), {
    ok: true,
    missing: [],
  });
  assert.deepEqual(
    runtimeAuthStatus("claude_code", {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
      AWS_BEARER_TOKEN_BEDROCK: "token",
    }),
    {
      ok: true,
      missing: [],
    },
  );
  assert.deepEqual(
    runtimeAuthStatus("claude_code", {
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_VERTEX_PROJECT_ID: "project",
      CLOUD_ML_REGION: "global",
      GOOGLE_APPLICATION_CREDENTIALS_JSON: "{}",
    }),
    {
      ok: true,
      missing: [],
    },
  );
  assert.deepEqual(
    runtimeAuthStatus("claude_code", {
      CLAUDE_CODE_USE_FOUNDRY: "true",
      ANTHROPIC_FOUNDRY_BASE_URL: "https://foundry.example/anthropic",
      ANTHROPIC_FOUNDRY_API_KEY: "token",
    }),
    {
      ok: true,
      missing: [],
    },
  );
  assert.deepEqual(runtimeAuthStatus("opencode", { OPENCODE_AUTH_CONTENT: "{}" }), {
    ok: true,
    missing: [],
  });
  assert.deepEqual(runtimeAuthStatus("opencode", { OPENCODE_CONFIG_CONTENT: "{}" }), {
    ok: true,
    missing: [],
  });
  assert.throws(
    () => validateRuntimeAuth({ agent_runtime_type: "opencode" }, {}),
    /OPENCODE_AUTH_CONTENT or OPENCODE_CONFIG_CONTENT/,
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

test("codex auth preparation writes explicit config and auth JSON without API key login", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "labor0-codex-content-test-"));
  const calls = [];
  const env = {
    OPENAI_API_KEY: "sk-test",
    CODEX_CONFIG_CONTENT: 'model_provider = "openai"\n',
    CODEX_AUTH_JSON_CONTENT: '{"auth_mode":"apiKey","OPENAI_API_KEY":"sk-test"}',
  };

  const codexHome = prepareCodexAuthentication(env, {
    tempDir,
    runner: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), 'model_provider = "openai"\n');
  assert.equal(
    fs.readFileSync(path.join(codexHome, "auth.json"), "utf8"),
    '{"auth_mode":"apiKey","OPENAI_API_KEY":"sk-test"}',
  );
  assert.equal(env.CODEX_CONFIG_CONTENT, undefined);
  assert.equal(env.CODEX_AUTH_JSON_CONTENT, undefined);
  assert.deepEqual(calls, []);
});

test("claude auth preparation writes content variables to temporary files", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "labor0-claude-content-test-"));
  const env = {
    GOOGLE_APPLICATION_CREDENTIALS_JSON: '{"type":"service_account"}',
    CLAUDE_CODE_CLIENT_CERT_CONTENT: "-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----\n",
    CLAUDE_CODE_CLIENT_KEY_CONTENT: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n",
  };

  const prepared = prepareClaudeCodeAuthentication(env, { tempDir });

  assert.equal(fs.readFileSync(prepared.googleApplicationCredentials, "utf8"), '{"type":"service_account"}');
  assert.equal(fs.readFileSync(prepared.clientCert, "utf8"), "-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----\n");
  assert.equal(fs.readFileSync(prepared.clientKey, "utf8"), "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n");
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS_JSON, undefined);
  assert.equal(env.CLAUDE_CODE_CLIENT_CERT_CONTENT, undefined);
  assert.equal(env.CLAUDE_CODE_CLIENT_KEY_CONTENT, undefined);
});

test("claude auth preparation exchanges refresh token credentials", () => {
  const calls = [];
  const env = {
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "refresh-token",
    CLAUDE_CODE_OAUTH_SCOPES: "user:profile user:inference user:sessions:claude_code",
  };

  prepareClaudeCodeAuthentication(env, {
    runner: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(calls[0].command, "claude");
  assert.deepEqual(calls[0].args, ["auth", "login"]);
  assert.equal(calls[0].options.env, env);
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

test("opencode auth preparation preserves explicit config and auth content", () => {
  const env = {
    OPENCODE_AUTH_CONTENT: '{"openai":{"type":"api","key":"sk-test"}}',
    OPENCODE_CONFIG_CONTENT: '{"$schema":"https://opencode.ai/config.json","model":"openai/gpt-5.4"}',
  };

  const content = prepareOpenCodeAuthentication(env);

  assert.equal(content, env.OPENCODE_CONFIG_CONTENT);
  assert.equal(env.OPENCODE_AUTH_CONTENT, '{"openai":{"type":"api","key":"sk-test"}}');
});

test("graph update draft extraction accepts stdout around JSON", () => {
  const draft = graphUpdateDraftFromOutput(
    { agent_task_session_id: "0199e7be-9000-7000-8000-000000000001" },
    `planning done
${JSON.stringify(graphUpdateDraftJSON())}`,
  );

  assert.equal(draft.source_agent_task_session_id, "0199e7be-9000-7000-8000-000000000001");
  assert.equal(draft.task_drafts[0].draft_task_key, "implement-runtime");
  assert.deepEqual(draft.upsert_edges, []);
  assert.deepEqual(draft.remove_edges, []);
});

test("graph update draft extraction accepts Claude Code structured output envelopes", () => {
  const draft = graphUpdateDraftFromOutput(
    { agent_task_session_id: "0199e7be-9000-7000-8000-000000000002" },
    JSON.stringify({
      type: "result",
      result: "Created a graph update draft.",
      structured_output: graphUpdateDraftJSON(),
    }),
  );

  assert.equal(draft.source_agent_task_session_id, "0199e7be-9000-7000-8000-000000000002");
  assert.equal(draft.summary, "Create task");
  assert.equal(draft.task_drafts[0].draft_task_key, "implement-runtime");
});

test("graph update parse failure writes result output before failing", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "labor0-run-agent-test-"));
  const outputs = {};
  const manifest = graphUpdateManifest();

  assert.throws(
    () =>
      runAgent(manifest, {
        tempDir,
        cwd: tempDir,
        env: { ANTHROPIC_API_KEY: "sk-ant-test", RUNNER_TEMP: tempDir },
        installRuntime: () => {},
        prepareRuntimeAuthentication: () => {},
        setOutput: (name, value) => {
          outputs[name] = value;
        },
        spawnSync: () => ({
          status: 0,
          signal: null,
          stdout: "planning completed without a JSON object",
          stderr: "warning: no structured output",
        }),
      }),
    /graph_update task did not produce a JSON draft/,
  );

  assert.equal(outputs.result_path, path.join(tempDir, "labor0-agent-task-result.json"));
  const result = JSON.parse(fs.readFileSync(outputs.result_path, "utf8"));
  assert.equal(result.exit_code, 0);
  assert.equal(result.graph_update_draft_created, false);
  assert.equal(result.draft_parse_error, "graph_update task did not produce a JSON draft");
  assert.match(result.stderr_tail, /no structured output/);
});

test("debug diagnostics redact prompt, runtime secrets, and repository tokens", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "labor0-run-agent-debug-test-"));
  const outputs = {};
  const manifest = graphUpdateManifest({
    prompt: "private planning prompt",
    agent_runtime_environment: {
      ANTHROPIC_API_KEY: "sk-ant-private",
    },
    repositories: [
      {
        repository_id: "0199e7be-9000-7000-8000-000000000003",
        git_url: "https://github.com/example/repo.git",
        checkout_path: "repositories/0199e7be-9000-7000-8000-000000000003",
        selected_ref: "refs/heads/main",
        access_mode: "read_only",
        credential: {
          token: "ghs-private-token",
        },
      },
    ],
  });
  const stdout = [
    "private planning prompt",
    JSON.stringify(graphUpdateDraftJSON()),
    "sk-ant-private",
    "ghs-private-token",
  ].join("\n");

  runAgent(manifest, {
    tempDir,
    cwd: tempDir,
    env: { LABOR0_AGENT_DEBUG: "true", RUNNER_TEMP: tempDir },
    installRuntime: () => {},
    prepareRuntimeAuthentication: () => {},
    setOutput: (name, value) => {
      outputs[name] = value;
    },
    spawnSync: () => ({
      status: 0,
      signal: null,
      stdout,
      stderr: "sk-ant-private stderr",
    }),
  });

  const debugArtifact = fs.readFileSync(outputs.debug_artifact_path, "utf8");
  const result = fs.readFileSync(outputs.result_path, "utf8");
  for (const sensitive of ["private planning prompt", "sk-ant-private", "ghs-private-token"]) {
    assert.equal(debugArtifact.includes(sensitive), false);
    assert.equal(result.includes(sensitive), false);
  }
  assert.match(debugArtifact, /\[REDACTED\]/);
  assert.match(debugArtifact, /\[PROMPT_REDACTED\]/);
});

test("debug detection honors runner and Labor0 agent debug environment", () => {
  assert.equal(isDebugMode({}), false);
  assert.equal(isDebugMode({ RUNNER_DEBUG: "1" }), true);
  assert.equal(isDebugMode({ LABOR0_AGENT_DEBUG: "true" }), true);
});

test("pull request creation defaults on for read-write repositories only", () => {
  assert.equal(shouldCreatePullRequest({ access_mode: "read_write" }), true);
  assert.equal(
    shouldCreatePullRequest({ access_mode: "read_write", auto_pull_request_enabled: false }),
    false,
  );
  assert.equal(shouldCreatePullRequest({ access_mode: "read_only" }), false);
});

function graphUpdateDraftJSON() {
  return {
    summary: "Create task",
    task_drafts: [
      {
        draft_task_key: "implement-runtime",
        task_type: "agent_execution",
        title: "Implement runtime",
        description: "Wire the runtime",
        execution_repository_bindings: [],
      },
    ],
    upsert_edges: [],
    remove_edges: [],
  };
}

function graphUpdateManifest(overrides = {}) {
  return {
    agent_task_session_id: "0199e7be-9000-7000-8000-000000000001",
    agent_task_id: "0199e7be-9000-7000-8000-000000000010",
    graph_agent_task_id: "0199e7be-9000-7000-8000-000000000020",
    agent_task_purpose: "graph_update",
    agent_runtime_type: "claude_code",
    agent_model: "claude-sonnet-4-6",
    prompt: "Plan follow-up tasks",
    repositories: [],
    ...overrides,
  };
}
