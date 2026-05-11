"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { isDebugMode } = require("../actions/lib/core");
const {
  createPullRequestsForChangedRepositories,
  graphUpdateDraftFromOutput,
  graphUpdateDraftSchema,
  isPlanModeEnabled,
  manifestWithApprovedPlan,
  planGenerationPrompt,
  planTextFromOutput,
  prepareClaudeCodeAuthentication,
  prepareCodexAuthentication,
  prepareOpenCodeAuthentication,
  runtimeAuthStatus,
  runtimeCommand,
  runPlanApprovalLoop,
  runAgent,
  shouldCreatePullRequest,
  shouldUpdateExistingPullRequest,
  synthesizeOpenCodeConfig,
  validateRuntimeAuth,
} = require("../actions/run-agent/index");

test("codex command passes model and YAML graph update prompt", () => {
  const command = runtimeCommand(
    {
      agent_runtime_type: "codex",
      agent_task_purpose: "graph_update",
      agent_model: "gpt-5.4",
      prompt: "Plan follow-up tasks",
      graph_update_context: graphUpdateContext(),
    },
    { graphUpdateSchemaPath: "/tmp/graph-update.schema.json" },
  );

  assert.deepEqual(command.slice(0, 6), [
    "codex",
    "exec",
    "--full-auto",
    "--sandbox",
    "danger-full-access",
    "--skip-git-repo-check",
  ]);
  assert.equal(command.includes("--output-schema"), false);
  assert.equal(command.includes("/tmp/graph-update.schema.json"), false);
  assert.equal(command[6], "--model");
  assert.equal(command[7], "gpt-5.4");
  assert.match(command.at(-1), /Return only one YAML document/);
  assert.match(command.at(-1), /Current graph context/);
  assert.match(command.at(-1), /Design graph update context/);
  assert.match(command.at(-1), /"graph_head_sequence": 42/);
  assert.match(command.at(-1), /predecessor:\n\s+draft_task_key: stable-kebab-key/);
  assert.match(command.at(-1), /Do not use predecessor_task_id or successor_task_id/);
});

test("claude command passes model without structured output schema", () => {
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
  assert.deepEqual(command.slice(2, 4), ["--permission-mode", "bypassPermissions"]);
  assert.equal(command.includes("--output-format"), false);
  assert.equal(command.includes("--json-schema"), false);
  assert.equal(command.includes("json"), false);
  assert.equal(command[4], "--model");
  assert.equal(command[5], "claude-sonnet-4-6");
  assert.match(command.at(-1), /Return only one YAML document/);
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

test("plan commands use provider read-only planning modes where available", () => {
  assert.deepEqual(
    runtimeCommand(
      {
        agent_runtime_type: "codex",
        agent_task_purpose: "coding",
        agent_model: "gpt-5.4",
        prompt: "Plan safely",
      },
      { phase: "plan" },
    ).slice(0, 7),
    ["codex", "exec", "--ask-for-approval", "never", "--sandbox", "read-only", "--skip-git-repo-check"],
  );
  assert.deepEqual(
    runtimeCommand(
      {
        agent_runtime_type: "claude_code",
        agent_task_purpose: "coding",
        agent_model: "claude-sonnet-4-6",
        prompt: "Plan safely",
      },
      { phase: "plan" },
    ).slice(0, 4),
    ["claude", "-p", "--permission-mode", "plan"],
  );
  assert.deepEqual(
    runtimeCommand(
      {
        agent_runtime_type: "opencode",
        agent_task_purpose: "coding",
        agent_model: "openai/gpt-5.4",
        prompt: "Plan safely",
      },
      { phase: "plan" },
    ),
    ["opencode", "run", "--model", "openai/gpt-5.4", "Plan safely"],
  );
});

test("plan prompt and approved plan manifest keep implementation gated", () => {
  const manifest = codingPlanManifest();
  assert.equal(isPlanModeEnabled(manifest), true);
  assert.equal(isPlanModeEnabled({ ...manifest, agent_task_purpose: "graph_update" }), false);
  const prompt = planGenerationPrompt(manifest, {
    revision: 2,
    revisionLimit: 3,
    revisionNotes: "Use the smaller API surface.",
  });
  assert.match(prompt, /Do not edit files/);
  assert.match(prompt, /revision 2/);
  assert.match(prompt, /Use the smaller API surface/);

  const approved = manifestWithApprovedPlan(manifest, {
    planRevision: 2,
    planText: "1. Update the route.\n2. Add tests.",
  });
  assert.match(approved.prompt, /Approved implementation plan, revision 2/);
  assert.equal(approved.plan_mode.approved_plan_revision, 2);
  assert.equal(approved.plan_mode.approved_plan_text, "1. Update the route.\n2. Add tests.");
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
    {
      agent_task_session_id: "0199e7be-9000-7000-8000-000000000001",
      graph_update_context: graphUpdateContext(),
    },
    `planning done
${JSON.stringify(graphUpdateDraftJSON())}`,
  );

  assert.equal(draft.source_agent_task_session_id, "0199e7be-9000-7000-8000-000000000001");
  assert.equal(draft.graph_head_sequence, 42);
  assert.equal(draft.task_drafts[0].draft_task_key, "implement-runtime");
  assert.deepEqual(draft.upsert_edges, []);
  assert.deepEqual(draft.remove_edges, []);
});

test("graph update draft extraction accepts plain YAML", () => {
  const draft = graphUpdateDraftFromOutput(
    {
      agent_task_session_id: "0199e7be-9000-7000-8000-000000000006",
      graph_update_context: graphUpdateContext(),
    },
    `summary: Create YAML task graph
task_drafts:
  - draft_task_key: implement-runtime
    task_type: agent_execution
    title: Implement runtime
    description: Wire the runtime
    labels:
      - backend
      - runtime
    execution_repository_bindings:
      - repository_id: 0199e7be-9000-7000-8000-000000000003
        selected_ref: refs/heads/main
        access_mode: read_write
        auto_pull_request_enabled: true
  - draft_task_key: test-runtime
    task_type: agent_execution
    title: Test runtime
    description: Verify the runtime
    execution_repository_bindings: []
upsert_edges:
  - predecessor:
      draft_task_key: implement-runtime
    successor:
      draft_task_key: test-runtime
    edge_type: depends_on
remove_edges: []`,
  );

  assert.equal(draft.source_agent_task_session_id, "0199e7be-9000-7000-8000-000000000006");
  assert.equal(draft.graph_head_sequence, 42);
  assert.equal(draft.summary, "Create YAML task graph");
  assert.deepEqual(draft.task_drafts[0].labels, ["backend", "runtime"]);
  assert.equal(draft.task_drafts[0].execution_repository_bindings[0].auto_pull_request_enabled, true);
  assert.deepEqual(draft.upsert_edges, [
    {
      predecessor: { draft_task_key: "implement-runtime" },
      successor: { draft_task_key: "test-runtime" },
      edge_type: "depends_on",
    },
  ]);
});

test("graph update draft extraction accepts YAML block scalars", () => {
  const draft = graphUpdateDraftFromOutput(
    {
      agent_task_session_id: "0199e7be-9000-7000-8000-000000000009",
      graph_update_context: graphUpdateContext(),
    },
    `summary: Create multiline task
task_drafts:
  - draft_task_key: implement-runtime
    task_type: agent_execution
    title: Implement runtime
    description: |
      Wire the runtime.
      Keep the graph update parser stable.
    labels:
      - backend
    execution_repository_bindings: []
upsert_edges: []
remove_edges: []`,
  );

  assert.equal(draft.source_agent_task_session_id, "0199e7be-9000-7000-8000-000000000009");
  assert.equal(draft.summary, "Create multiline task");
  assert.equal(draft.task_drafts[0].description, "Wire the runtime.\nKeep the graph update parser stable.\n");
  assert.deepEqual(draft.task_drafts[0].labels, ["backend"]);
});

test("graph update draft extraction accepts fenced YAML with flow refs", () => {
  const draft = graphUpdateDraftFromOutput(
    {
      agent_task_session_id: "0199e7be-9000-7000-8000-000000000007",
      graph_update_context: graphUpdateContext(),
    },
    `Created the graph update draft.

\`\`\`yaml
summary: Create fenced YAML task
task_drafts:
  - draft_task_key: implement-runtime
    task_type: agent_execution
    title: Implement runtime
    description: Wire the runtime
    labels: [backend]
    execution_repository_bindings: []
upsert_edges:
  - predecessor: { draft_task_key: implement-runtime }
    successor: { graph_agent_task_id: 0199e7be-9000-7000-8000-000000000101 }
    edge_type: depends_on
remove_edges: []
\`\`\``,
  );

  assert.equal(draft.source_agent_task_session_id, "0199e7be-9000-7000-8000-000000000007");
  assert.equal(draft.summary, "Create fenced YAML task");
  assert.deepEqual(draft.task_drafts[0].labels, ["backend"]);
  assert.deepEqual(draft.upsert_edges[0], {
    predecessor: { draft_task_key: "implement-runtime" },
    successor: { graph_agent_task_id: "0199e7be-9000-7000-8000-000000000101" },
    edge_type: "depends_on",
  });
});

test("graph update draft extraction accepts YAML inside Claude result strings", () => {
  const draft = graphUpdateDraftFromOutput(
    {
      agent_task_session_id: "0199e7be-9000-7000-8000-000000000008",
      graph_update_context: graphUpdateContext(),
    },
    JSON.stringify({
      type: "result",
      result: `summary: Create YAML result task
task_drafts:
  - draft_task_key: implement-runtime
    task_type: agent_execution
    title: Implement runtime
    description: Wire the runtime
    execution_repository_bindings: []
upsert_edges: []
remove_edges: []

Done.`,
    }),
  );

  assert.equal(draft.source_agent_task_session_id, "0199e7be-9000-7000-8000-000000000008");
  assert.equal(draft.summary, "Create YAML result task");
  assert.equal(draft.task_drafts[0].draft_task_key, "implement-runtime");
});

test("graph update draft extraction accepts nested edge refs", () => {
  const draft = graphUpdateDraftFromOutput(
    {
      agent_task_session_id: "0199e7be-9000-7000-8000-000000000003",
      graph_update_context: graphUpdateContext(),
    },
    JSON.stringify(
      graphUpdateDraftJSON({
        task_drafts: [
          {
            draft_task_key: "implement-runtime",
            task_type: "agent_execution",
            title: "Implement runtime",
            description: "Wire the runtime",
            execution_repository_bindings: [],
          },
          {
            draft_task_key: "test-runtime",
            task_type: "agent_execution",
            title: "Test runtime",
            description: "Verify the runtime",
            execution_repository_bindings: [],
          },
        ],
        upsert_edges: [
          {
            predecessor: { draft_task_key: "implement-runtime" },
            successor: { draft_task_key: "test-runtime" },
            edge_type: "depends_on",
          },
        ],
      }),
    ),
  );

  assert.deepEqual(draft.upsert_edges, [
    {
      predecessor: { draft_task_key: "implement-runtime" },
      successor: { draft_task_key: "test-runtime" },
      edge_type: "depends_on",
    },
  ]);
});

test("graph update draft extraction rejects flat context edge fields", () => {
  assert.throws(
    () =>
      graphUpdateDraftFromOutput(
        {
          agent_task_session_id: "0199e7be-9000-7000-8000-000000000004",
          graph_update_context: graphUpdateContext(),
        },
        JSON.stringify(
          graphUpdateDraftJSON({
            upsert_edges: [
              {
                predecessor_task_id: "0199e7be-9000-7000-8000-000000000101",
                successor_task_id: "0199e7be-9000-7000-8000-000000000102",
                edge_type: "depends_on",
              },
            ],
          }),
        ),
      ),
    /graph_update_draft\.upsert_edges\[0\].*predecessor_task_id and successor_task_id are graph context fields only/,
  );
});

test("graph update draft extraction rejects draft refs in removed edges", () => {
  assert.throws(
    () =>
      graphUpdateDraftFromOutput(
        {
          agent_task_session_id: "0199e7be-9000-7000-8000-000000000005",
          graph_update_context: graphUpdateContext(),
        },
        JSON.stringify(
          graphUpdateDraftJSON({
            remove_edges: [
              {
                predecessor: { draft_task_key: "implement-runtime" },
                successor: { graph_agent_task_id: "0199e7be-9000-7000-8000-000000000102" },
                edge_type: "depends_on",
              },
            ],
          }),
        ),
      ),
    /graph_update_draft\.remove_edges\[0\]\.predecessor must set graph_agent_task_id/,
  );
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

test("graph update parse failure writes result output before failing", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "labor0-run-agent-test-"));
  const outputs = {};
  const manifest = graphUpdateManifest();

  await assert.rejects(
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
          stdout: "planning completed without a YAML document",
          stderr: "warning: no structured output",
        }),
      }),
    /graph_update task did not produce a YAML draft/,
  );

  assert.equal(outputs.result_path, path.join(tempDir, "labor0-agent-task-result.json"));
  const result = JSON.parse(fs.readFileSync(outputs.result_path, "utf8"));
  assert.equal(result.exit_code, 0);
  assert.equal(result.graph_update_draft_created, false);
  assert.equal(result.draft_parse_error, "graph_update task did not produce a YAML draft");
  assert.match(result.stderr_tail, /no structured output/);
});

test("graph update validation failure writes result output before failing", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "labor0-run-agent-validation-test-"));
  const outputs = {};
  const manifest = graphUpdateManifest();

  await assert.rejects(
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
          stdout: JSON.stringify(
            graphUpdateDraftJSON({
              upsert_edges: [
                {
                  predecessor_task_id: "0199e7be-9000-7000-8000-000000000101",
                  successor_task_id: "0199e7be-9000-7000-8000-000000000102",
                  edge_type: "depends_on",
                },
              ],
            }),
          ),
          stderr: "",
        }),
      }),
    /graph_update_draft\.upsert_edges\[0\]/,
  );

  assert.equal(outputs.graph_update_draft_path, undefined);
  assert.equal(outputs.result_path, path.join(tempDir, "labor0-agent-task-result.json"));
  const result = JSON.parse(fs.readFileSync(outputs.result_path, "utf8"));
  assert.equal(result.exit_code, 0);
  assert.equal(result.graph_update_draft_created, false);
  assert.match(result.draft_parse_error, /graph_update_draft\.upsert_edges\[0\]/);
});

test("graph update draft schema requires nested edge refs", () => {
  const schema = graphUpdateDraftSchema();

  assert.deepEqual(schema.properties.upsert_edges.items.required, ["predecessor", "successor"]);
  assert.deepEqual(schema.properties.remove_edges.items.required, ["predecessor", "successor"]);
  assert.equal(schema.properties.upsert_edges.items.additionalProperties, false);
  assert.equal(schema.properties.upsert_edges.items.properties.predecessor.oneOf.length, 2);
  assert.deepEqual(schema.properties.remove_edges.items.properties.successor.required, ["graph_agent_task_id"]);
  assert.equal(schema.properties.remove_edges.items.properties.successor.properties.draft_task_key, undefined);
});

test("plan output extraction accepts provider text and JSON envelopes", () => {
  assert.equal(planTextFromOutput("  ## Plan\n- Change the route\n"), "## Plan\n- Change the route");
  assert.equal(
    planTextFromOutput(JSON.stringify({ type: "result", result: "## Plan\n- Add tests" })),
    "## Plan\n- Add tests",
  );
  assert.equal(
    planTextFromOutput(JSON.stringify({ structured_output: { plan_text: "## Plan\n- Wire callback" } })),
    "## Plan\n- Wire callback",
  );
  assert.throws(() => planTextFromOutput(""), /plan generation did not produce plan text/);
});

test("plan approval loop posts revisions and returns the approved plan", async () => {
  const manifest = codingPlanManifest();
  const posted = [];
  const waited = [];
  const spawnedPrompts = [];
  await withFetch(async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/events")) {
      posted.push(body.plan_proposal);
      return jsonResponse({ ok: true });
    }
    waited.push(body);
    return jsonResponse(
      waited.length === 1
        ? {
            decision: "revision_requested",
            revision_notes: "Cover the route test.",
            plan_revision: 1,
          }
        : {
            decision: "approved",
            plan_revision: 2,
            plan_text: "## Approved plan\n- Cover the route test.",
          },
    );
  }, async () => {
    const approval = await runPlanApprovalLoop(manifest, {
      env: { OPENAI_API_KEY: "sk-test" },
      baseEnv: { OPENAI_API_KEY: "sk-test" },
      requestOIDCToken: async (audience) => {
        assert.equal(audience, "https://graph.example");
        return "oidc-token";
      },
      installRuntime: () => {},
      prepareRuntimeAuthentication: () => {},
      spawnSync: (_command, args) => {
        spawnedPrompts.push(args.at(-1));
        return {
          status: 0,
          signal: null,
          stdout: `## Plan ${spawnedPrompts.length}\n- Step`,
          stderr: "",
        };
      },
    });
    assert.deepEqual(approval, {
      planRevision: 2,
      planText: "## Approved plan\n- Cover the route test.",
    });
    assert.deepEqual(posted.map((item) => item.plan_revision), [1, 2]);
    assert.deepEqual(waited, [{ plan_revision: 1 }, { plan_revision: 2 }]);
    assert.match(spawnedPrompts[1], /Cover the route test/);
  });
});

test("plan approval loop stops on rejection without implementation", async () => {
  const manifest = codingPlanManifest();
  await withFetch(async (url, init) => {
    if (String(url).endsWith("/events")) {
      return jsonResponse({ ok: true });
    }
    assert.deepEqual(JSON.parse(init.body), { plan_revision: 1 });
    return jsonResponse({
      decision: "rejected",
      revision_notes: "Wrong direction.",
      plan_revision: 1,
    });
  }, async () => {
    await assert.rejects(
      runPlanApprovalLoop(manifest, {
        env: { OPENAI_API_KEY: "sk-test" },
        baseEnv: { OPENAI_API_KEY: "sk-test" },
        requestOIDCToken: async () => "oidc-token",
        spawnSync: () => ({
          status: 0,
          signal: null,
          stdout: "## Plan\n- Step",
          stderr: "",
        }),
      }),
      /plan decision was rejected/,
    );
  });
});

test("run agent implements only after plan approval", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "labor0-plan-run-agent-test-"));
  const outputs = {};
  const prompts = [];
  await withFetch(async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/events")) {
      assert.equal(body.event_type, "plan_proposed");
      assert.equal(body.plan_proposal.plan_revision, 1);
      return jsonResponse({ ok: true });
    }
    return jsonResponse({
      decision: "approved",
      plan_revision: 1,
      plan_text: "## Approved plan\n- Implement after approval.",
    });
  }, async () => {
    const result = await runAgent(codingPlanManifest(), {
      tempDir,
      cwd: tempDir,
      env: { OPENAI_API_KEY: "sk-test", RUNNER_TEMP: tempDir },
      installRuntime: () => {},
      prepareRuntimeAuthentication: () => {},
      requestOIDCToken: async () => "oidc-token",
      setOutput: (name, value) => {
        outputs[name] = value;
      },
      spawnSync: (_command, args) => {
        prompts.push(args.at(-1));
        return {
          status: 0,
          signal: null,
          stdout: prompts.length === 1 ? "## Plan\n- Implement after approval." : "done",
          stderr: "",
        };
      },
    });
    assert.equal(result.output.plan_mode_enabled, true);
    assert.equal(result.output.plan_decision, "approved");
    assert.equal(result.output.approved_plan_revision, 1);
    assert.match(prompts[0], /Do not edit files/);
    assert.match(prompts[1], /Approved implementation plan, revision 1/);
    assert.equal(outputs.result_path, path.join(tempDir, "labor0-agent-task-result.json"));
  });
});

test("debug diagnostics redact prompt, runtime secrets, and repository tokens", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "labor0-run-agent-debug-test-"));
  const outputs = {};
  const manifest = graphUpdateManifest({
    prompt: "private planning prompt",
    agent_runtime_environment: {
      ANTHROPIC_API_KEY: "sk-ant-private",
    },
    graph_update_context: graphUpdateContext({
      tasks: [
        {
          graph_agent_task_id: "0199e7be-9000-7000-8000-000000000111",
          task_type: "agent_execution",
          task_status: "ready",
          title: "Sensitive existing task",
          description: "Sensitive existing task description",
          labels: ["sensitive-label"],
        },
      ],
    }),
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
    "Sensitive existing task",
    "Sensitive existing task description",
    "sensitive-label",
    JSON.stringify(graphUpdateDraftJSON()),
    "sk-ant-private",
    "ghs-private-token",
  ].join("\n");

  await runAgent(manifest, {
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
  for (const sensitive of [
    "private planning prompt",
    "sk-ant-private",
    "ghs-private-token",
    "Sensitive existing task",
    "Sensitive existing task description",
    "sensitive-label",
  ]) {
    assert.equal(debugArtifact.includes(sensitive), false);
    assert.equal(result.includes(sensitive), false);
  }
  const debugJSON = JSON.parse(debugArtifact);
  assert.deepEqual(debugJSON.manifest.graph_update_context, {
    graph_head_sequence: 42,
    task_count: 1,
    edge_count: 1,
    repository_count: 1,
  });
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
  assert.equal(
    shouldCreatePullRequest({
      access_mode: "read_write",
      pull_request_update: { branch_name: "feature/review-fix" },
    }),
    false,
  );
  assert.equal(
    shouldUpdateExistingPullRequest({
      access_mode: "read_write",
      auto_pull_request_enabled: false,
      pull_request_update: { branch_name: "feature/review-fix" },
    }),
    true,
  );
});

test("existing pull request update pushes target branch without reporting a new pull request", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "labor0-existing-pr-test-"));
  const checkoutPath = path.join(tempDir, "repo");
  const binPath = path.join(tempDir, "bin");
  const logPath = path.join(tempDir, "commands.jsonl");
  fs.mkdirSync(checkoutPath, { recursive: true });
  fs.mkdirSync(binPath, { recursive: true });
  writeExecutable(
    path.join(binPath, "git"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.LABOR0_TEST_COMMAND_LOG, JSON.stringify({ command: "git", args }) + "\\n");
if (args[0] === "status") {
  process.stdout.write(" M file.js\\n");
}
process.exit(0);
`,
  );
  writeExecutable(
    path.join(binPath, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.LABOR0_TEST_COMMAND_LOG, JSON.stringify({ command: "gh", args: process.argv.slice(2) }) + "\\n");
process.exit(1);
`,
  );

  withEnv(
    {
      GITHUB_WORKSPACE: tempDir,
      LABOR0_TEST_COMMAND_LOG: logPath,
      PATH: `${binPath}${path.delimiter}${process.env.PATH || ""}`,
    },
    () => {
      const pullRequests = createPullRequestsForChangedRepositories({
        agent_task_session_id: "0199e7be-9000-7000-8000-000000000001",
        agent_task_id: "0199e7be-9000-7000-8000-000000000010",
        agent_runtime_type: "codex",
        task_title: "review feedback",
        repositories: [
          {
            repository_id: "0199e7be-9000-7000-8000-000000000003",
            git_url: "https://github.com/example/repo.git",
            checkout_path: "repo",
            selected_ref: "refs/heads/feature/review-fix",
            access_mode: "read_write",
            auto_pull_request_enabled: false,
            pull_request_update: {
              pull_request_ref: "github:example/repo#12",
              pull_request_number: 12,
              pull_request_url: "https://github.com/example/repo/pull/12",
              branch_name: "feature/review-fix",
            },
          },
        ],
      });

      assert.deepEqual(pullRequests, []);
    },
  );

  const commands = fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(commands.map((command) => command.command), ["git", "git", "git", "git", "git", "git"]);
  assert.deepEqual(commands.at(-1), {
    command: "git",
    args: ["push", "origin", "HEAD:feature/review-fix"],
  });
  assert.equal(commands.some((command) => command.command === "gh"), false);
});

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content);
  fs.chmodSync(filePath, 0o755);
}

function withEnv(values, callback) {
  const previous = {};
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    process.env[key] = values[key];
  }
  try {
    return callback();
  } finally {
    for (const key of Object.keys(values)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

async function withFetch(fetcher, callback) {
  const previous = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    return await callback();
  } finally {
    globalThis.fetch = previous;
  }
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status || 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function codingPlanManifest(overrides = {}) {
  return {
    agent_task_session_id: "0199e7be-9000-7000-8000-000000000001",
    agent_task_id: "0199e7be-9000-7000-8000-000000000010",
    graph_agent_task_id: "0199e7be-9000-7000-8000-000000000020",
    agent_task_purpose: "coding",
    agent_runtime_type: "codex",
    agent_model: "gpt-5.4",
    prompt: "Implement plan mode.",
    callback_url: "https://graph.example/github-actions/agent-task-sessions/0199e7be-9000-7000-8000-000000000001/events",
    plan_mode: {
      enabled: true,
      approval_target_user_group_id: "0199e7be-9000-7000-8000-000000000030",
      mobile_tty_session_id: "0199e7be-9000-7000-8000-000000000040",
      revision_limit: 3,
      plan_callback_url: "https://graph.example/github-actions/agent-task-sessions/0199e7be-9000-7000-8000-000000000001/events",
      plan_decision_url:
        "https://graph.example/github-actions/agent-task-sessions/0199e7be-9000-7000-8000-000000000001/plan-decision",
    },
    repositories: [],
    ...overrides,
  };
}

function graphUpdateDraftJSON(overrides = {}) {
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
    ...overrides,
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
    graph_update_context: graphUpdateContext(),
    repositories: [],
    ...overrides,
  };
}

function graphUpdateContext(overrides = {}) {
  return {
    graph_head: {
      graph_head_sequence: 42,
    },
    tasks: [
      {
        graph_agent_task_id: "0199e7be-9000-7000-8000-000000000101",
        task_type: "agent_execution",
        task_status: "ready",
        title: "Design graph update context",
        description: "Make the existing graph visible to the planning task.",
        labels: ["backend"],
      },
    ],
    edges: [
      {
        predecessor_task_id: "0199e7be-9000-7000-8000-000000000101",
        successor_task_id: "0199e7be-9000-7000-8000-000000000102",
        edge_type: "depends_on",
      },
    ],
    repositories: [
      {
        repository_id: "0199e7be-9000-7000-8000-000000000003",
        checkout_path: "repositories/0199e7be-9000-7000-8000-000000000003",
        selected_ref: "refs/heads/main",
        access_mode: "read_only",
        auto_pull_request_enabled: null,
      },
    ],
    ...overrides,
  };
}
