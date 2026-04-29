"use strict";

const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { debug, fail, getInput, info, isDebugMode, setOutput, writeJSON } = require("../lib/core");
const { readManifest } = require("../lib/manifest");
const { redact } = require("../lib/redaction");

function main() {
  const manifest = readManifest(getInput("manifest_path", { required: true }));
  runAgent(manifest);
}

function runAgent(manifest, options = {}) {
  const baseEnv = options.env || process.env;
  const tempDir = options.tempDir || baseEnv.RUNNER_TEMP || process.cwd();
  const resultPath = path.join(tempDir, "labor0-agent-task-result.json");
  const debugArtifactPath = path.join(tempDir, "labor0-agent-debug-diagnostics.json");
  const graphUpdateDraftPath = path.join(tempDir, "labor0-graph-update-draft.json");
  const graphUpdateSchemaPath = path.join(tempDir, "labor0-graph-update-draft.schema.json");
  const pullRequestsPath = path.join(tempDir, "labor0-agent-task-pull-requests.json");
  const emitOutput = options.setOutput || setOutput;
  const debugEnabled = isDebugMode(baseEnv);
  const secrets = manifestSecretValues(manifest);
  const debugLines = [];

  let command = [];
  let graphUpdateDraft = null;
  let pullRequests = [];
  let result = { status: 1, signal: null, stdout: "", stderr: "" };
  let draftParseError = "";
  let runError = null;
  const startedAt = new Date();

  try {
    const env = agentEnvironment(manifest, baseEnv);
    const runtimeValidator = options.validateRuntimeAuth || validateRuntimeAuth;
    const runtimeInstaller = options.installRuntime || installRuntime;
    const runtimeAuthPreparer = options.prepareRuntimeAuthentication || prepareRuntimeAuthentication;
    runtimeValidator(manifest, env);
    runtimeInstaller(manifest.agent_runtime_type);
    runtimeAuthPreparer(manifest, env, { tempDir });
    if (manifest.agent_task_purpose === "graph_update") {
      writeJSON(graphUpdateSchemaPath, graphUpdateDraftSchema());
    }
    command = runtimeCommand(manifest, { graphUpdateSchemaPath, env: baseEnv });
    const cwd = options.cwd || baseEnv.GITHUB_WORKSPACE || process.cwd();
    recordDebug(debugLines, baseEnv, secrets, "manifest", manifestDebugSummary(manifest));
    recordDebug(debugLines, baseEnv, secrets, "runtime command", commandForDebug(command, manifest, secrets));
    info(`Running ${manifest.agent_runtime_type || "agent"} for ${manifest.agent_task_purpose || "task"}`);
    const spawner = options.spawnSync || spawnSync;
    result = spawner(command[0], command.slice(1), {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
    recordDebug(debugLines, baseEnv, secrets, "runtime result", runtimeResultSummary(result));
    recordDebug(debugLines, baseEnv, secrets, "runtime output tail", {
      stdout_tail: sanitizeText(tail(result.stdout || "", 4000), secrets),
      stderr_tail: sanitizeText(tail(result.stderr || "", 4000), secrets),
    });

    if (manifest.agent_task_purpose === "graph_update" && result.status === 0) {
      try {
        graphUpdateDraft = graphUpdateDraftFromOutput(manifest, result.stdout || "");
        writeJSON(graphUpdateDraftPath, graphUpdateDraft);
        emitOutput("graph_update_draft_path", graphUpdateDraftPath);
      } catch (error) {
        draftParseError = error instanceof Error ? error.message : String(error);
        runError = error;
        recordDebug(debugLines, baseEnv, secrets, "graph update draft parse error", draftParseError);
      }
    }

    if (!runError && result.status === 0 && manifest.agent_task_purpose === "coding") {
      const pullRequestCreator = options.createPullRequestsForChangedRepositories || createPullRequestsForChangedRepositories;
      pullRequests = pullRequestCreator(manifest);
      if (pullRequests.length > 0) {
        writeJSON(pullRequestsPath, pullRequests);
        emitOutput("pull_requests_path", pullRequestsPath);
      }
    }
  } catch (error) {
    runError = error;
    recordDebug(
      debugLines,
      baseEnv,
      secrets,
      "run error",
      error instanceof Error ? error.message : String(error),
    );
  }
  const endedAt = new Date();

  const output = redact({
    agent_task_session_id: manifest.agent_task_session_id,
    agent_task_id: manifest.agent_task_id,
    graph_agent_task_id: manifest.graph_agent_task_id,
    agent_task_purpose: manifest.agent_task_purpose,
    agent_runtime_type: manifest.agent_runtime_type,
    agent_model: manifest.agent_model || "",
    debug_enabled: debugEnabled,
    graph_update_draft_created: Boolean(graphUpdateDraft),
    pull_request_count: pullRequests.length,
    exit_code: result.status ?? 1,
    signal: result.signal,
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    duration_ms: endedAt.getTime() - startedAt.getTime(),
    stdout_bytes: byteLength(result.stdout || ""),
    stderr_bytes: byteLength(result.stderr || ""),
    stdout_tail: sanitizeText(tail(result.stdout || ""), secrets),
    stderr_tail: sanitizeText(tail(result.stderr || ""), secrets),
    draft_parse_error: draftParseError || undefined,
    error_message: runError ? sanitizeText(runError instanceof Error ? runError.message : String(runError), secrets) : undefined,
  });
  writeJSON(resultPath, output);
  emitOutput("result_path", resultPath);

  if (debugEnabled) {
    writeJSON(
      debugArtifactPath,
      redact({
        manifest: manifestDebugSummary(manifest),
        command: commandForDebug(command, manifest, secrets),
        result: output,
        debug_lines: debugLines,
      }),
    );
    emitOutput("debug_artifact_path", debugArtifactPath);
  }
  if (runError) {
    throw runError;
  }
  if (result.status !== 0) {
    throw new Error(`${command[0]} exited with ${result.status ?? result.signal}`);
  }
  return {
    resultPath,
    debugArtifactPath: debugEnabled ? debugArtifactPath : "",
    graphUpdateDraftPath: graphUpdateDraft ? graphUpdateDraftPath : "",
    pullRequestsPath: pullRequests.length > 0 ? pullRequestsPath : "",
    output,
  };
}

function agentEnvironment(manifest, baseEnv = process.env) {
  return {
    ...baseEnv,
    ...(manifest.agent_runtime_environment || {}),
    LABOR0_AGENT_TASK_SESSION_ID: manifest.agent_task_session_id,
    LABOR0_AGENT_TASK_ID: manifest.agent_task_id,
    LABOR0_GRAPH_AGENT_TASK_ID: manifest.graph_agent_task_id,
    LABOR0_AGENT_TASK_PURPOSE: manifest.agent_task_purpose || "",
    LABOR0_AGENT_RUNTIME_TYPE: manifest.agent_runtime_type || "",
    LABOR0_AGENT_MODEL: manifest.agent_model || "",
    LABOR0_AGENT_PROMPT: manifest.prompt || "",
  };
}

function installRuntime(runtimeType) {
  switch (runtimeType) {
    case "codex":
      installNpmPackageIfMissing("codex", "@openai/codex");
      break;
    case "claude_code":
      installNpmPackageIfMissing("claude", "@anthropic-ai/claude-code");
      break;
    case "opencode":
      installNpmPackageIfMissing("opencode", "opencode-ai");
      break;
    default:
      throw new Error(`Unsupported agent_runtime_type: ${runtimeType || "(empty)"}`);
  }
}

function installNpmPackageIfMissing(binary, packageName) {
  if (commandExists(binary)) {
    return;
  }
  info(`Installing ${packageName}`);
  run("npm", ["i", "-g", packageName], { cwd: process.cwd() });
}

function commandExists(binary) {
  return spawnSync(binary, ["--version"], { encoding: "utf8" }).status === 0;
}

function runtimeCommand(manifest, options = {}) {
  const prompt = runtimePrompt(manifest);
  const env = options.env || process.env;
  if (env.LABOR0_AGENT_COMMAND) {
    return shellCommand(env.LABOR0_AGENT_COMMAND);
  }
  const graphUpdateSchemaPath =
    manifest.agent_task_purpose === "graph_update" ? options.graphUpdateSchemaPath : "";
  switch (manifest.agent_runtime_type) {
    case "codex":
      return compact([
        "codex",
        "exec",
        "--full-auto",
        "--sandbox",
        "danger-full-access",
        "--skip-git-repo-check",
        graphUpdateSchemaPath ? "--output-schema" : "",
        graphUpdateSchemaPath,
        manifest.agent_model ? "--model" : "",
        manifest.agent_model || "",
        prompt,
      ]);
    case "claude_code":
      return compact([
        "claude",
        "-p",
        "--permission-mode",
        "bypassPermissions",
        graphUpdateSchemaPath ? "--output-format" : "",
        graphUpdateSchemaPath ? "json" : "",
        graphUpdateSchemaPath ? "--json-schema" : "",
        graphUpdateSchemaPath ? JSON.stringify(graphUpdateDraftSchema()) : "",
        manifest.agent_model ? "--model" : "",
        manifest.agent_model || "",
        prompt,
      ]);
    case "opencode":
      return compact([
        "opencode",
        "run",
        "--dangerously-skip-permissions",
        manifest.agent_model ? "--model" : "",
        manifest.agent_model || "",
        prompt,
      ]);
    default:
      throw new Error(`Unsupported agent_runtime_type: ${manifest.agent_runtime_type || "(empty)"}`);
  }
}

function validateRuntimeAuth(manifest, env) {
  const status = runtimeAuthStatus(manifest.agent_runtime_type, env);
  if (!status.ok) {
    throw new Error(
      `${runtimeLabel(manifest.agent_runtime_type)} is missing runtime auth. Configure ${status.missing.join(" or ")} in the workspace Agent credentials settings.`,
    );
  }
  return status;
}

function runtimeAuthStatus(runtimeType, env) {
  switch (runtimeType) {
    case "codex":
      return hasAny(env, [
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "CODEX_AGENT_IDENTITY",
        "CODEX_AUTH_JSON_CONTENT",
        "CODEX_CONFIG_CONTENT",
      ])
        ? { ok: true, missing: [] }
        : {
            ok: false,
            missing: [
              "OPENAI_API_KEY",
              "CODEX_API_KEY",
              "CODEX_AGENT_IDENTITY",
              "CODEX_AUTH_JSON_CONTENT",
              "CODEX_CONFIG_CONTENT",
            ],
          };
    case "claude_code":
      return hasClaudeCodeAuthentication(env)
        ? { ok: true, missing: [] }
        : {
            ok: false,
            missing: [
              "direct Anthropic API key/token",
              "Claude Code OAuth token",
              "Claude Code OAuth refresh token and scopes",
              "Bedrock/Mantle credentials",
              "Vertex credentials",
              "Foundry credentials",
            ],
          };
    case "opencode":
      return hasOpenCodeAuthentication(env)
        ? { ok: true, missing: [] }
        : {
            ok: false,
            missing: [
              "OPENCODE_AUTH_CONTENT",
              "OPENCODE_CONFIG_CONTENT",
              "OPENAI_API_KEY",
              "ANTHROPIC_API_KEY",
              "supported AWS/GCP provider credentials",
            ],
          };
    default:
      throw new Error(`Unsupported agent_runtime_type: ${runtimeType || "(empty)"}`);
  }
}

function has(env, key) {
  return String(env[key] || "").trim().length > 0;
}

function hasAny(env, keys) {
  return keys.some((key) => has(env, key));
}

function hasFlag(env, key) {
  const value = String(env[key] || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function hasClaudeCodeAuthentication(env) {
  if (hasAny(env, ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"])) {
    return true;
  }
  if (has(env, "CLAUDE_CODE_OAUTH_REFRESH_TOKEN") && has(env, "CLAUDE_CODE_OAUTH_SCOPES")) {
    return true;
  }
  if (hasFlag(env, "CLAUDE_CODE_USE_BEDROCK") && hasAWSRuntimeAuthentication(env)) {
    return true;
  }
  if (hasFlag(env, "CLAUDE_CODE_USE_MANTLE")) {
    if (hasFlag(env, "CLAUDE_CODE_SKIP_MANTLE_AUTH") && has(env, "ANTHROPIC_BEDROCK_MANTLE_BASE_URL")) {
      return true;
    }
    if (hasAWSRuntimeAuthentication(env)) {
      return true;
    }
  }
  if (hasFlag(env, "CLAUDE_CODE_USE_VERTEX") && hasClaudeCodeVertexAuthentication(env)) {
    return true;
  }
  if (hasFlag(env, "CLAUDE_CODE_USE_FOUNDRY") && hasClaudeCodeFoundryAuthentication(env)) {
    return true;
  }
  return false;
}

function hasOpenCodeAuthentication(env) {
  if (hasAny(env, ["OPENCODE_AUTH_CONTENT", "OPENCODE_CONFIG_CONTENT", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"])) {
    return true;
  }
  return hasAWSRuntimeAuthentication(env) || hasGoogleRuntimeAuthentication(env);
}

function hasAWSRuntimeAuthentication(env) {
  if (!has(env, "AWS_REGION")) {
    return false;
  }
  if (has(env, "AWS_BEARER_TOKEN_BEDROCK")) {
    return true;
  }
  if (has(env, "AWS_ACCESS_KEY_ID") && has(env, "AWS_SECRET_ACCESS_KEY")) {
    return true;
  }
  if (has(env, "AWS_PROFILE")) {
    return true;
  }
  return has(env, "AWS_WEB_IDENTITY_TOKEN_FILE") && has(env, "AWS_ROLE_ARN");
}

function hasGoogleRuntimeAuthentication(env) {
  return hasAny(env, ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_APPLICATION_CREDENTIALS_JSON"]);
}

function hasClaudeCodeVertexAuthentication(env) {
  return has(env, "ANTHROPIC_VERTEX_PROJECT_ID") && has(env, "CLOUD_ML_REGION") && hasGoogleRuntimeAuthentication(env);
}

function hasClaudeCodeFoundryAuthentication(env) {
  if (!hasAny(env, ["ANTHROPIC_FOUNDRY_RESOURCE", "ANTHROPIC_FOUNDRY_BASE_URL"])) {
    return false;
  }
  if (has(env, "ANTHROPIC_FOUNDRY_API_KEY")) {
    return true;
  }
  return has(env, "AZURE_CLIENT_ID") && has(env, "AZURE_TENANT_ID") && has(env, "AZURE_CLIENT_SECRET");
}

function prepareRuntimeAuthentication(manifest, env, options = {}) {
  switch (manifest.agent_runtime_type) {
    case "codex":
      return prepareCodexAuthentication(env, options);
    case "opencode":
      return prepareOpenCodeAuthentication(env);
    case "claude_code":
      return prepareClaudeCodeAuthentication(env, options);
    default:
      throw new Error(`Unsupported agent_runtime_type: ${manifest.agent_runtime_type || "(empty)"}`);
  }
}

function prepareCodexAuthentication(env, options = {}) {
  const tempDir = options.tempDir || process.env.RUNNER_TEMP || process.cwd();
  const runner = options.runner || run;
  const codexHome = fs.mkdtempSync(path.join(tempDir, "labor0-codex-home-"));
  env.CODEX_HOME = codexHome;
  const runAPIKeyLogin = shouldRunCodexAPIKeyLogin(env);
  if (has(env, "CODEX_CONFIG_CONTENT")) {
    writeSecretFile(path.join(codexHome, "config.toml"), env.CODEX_CONFIG_CONTENT);
    delete env.CODEX_CONFIG_CONTENT;
  } else if (runAPIKeyLogin) {
    writeSecretFile(path.join(codexHome, "config.toml"), 'forced_login_method = "api"\n');
  }
  if (has(env, "CODEX_AUTH_JSON_CONTENT")) {
    writeSecretFile(path.join(codexHome, "auth.json"), env.CODEX_AUTH_JSON_CONTENT);
    delete env.CODEX_AUTH_JSON_CONTENT;
  }
  if (runAPIKeyLogin) {
    runner("codex", ["login", "--with-api-key"], {
      capture: true,
      env,
      input: `${env.OPENAI_API_KEY}\n`,
    });
  }
  return codexHome;
}

function shouldRunCodexAPIKeyLogin(env) {
  return (
    has(env, "OPENAI_API_KEY") &&
    !hasAny(env, ["CODEX_API_KEY", "CODEX_AGENT_IDENTITY", "CODEX_AUTH_JSON_CONTENT", "CODEX_CONFIG_CONTENT"])
  );
}

function prepareClaudeCodeAuthentication(env, options = {}) {
  const tempDir = options.tempDir || process.env.RUNNER_TEMP || process.cwd();
  const runner = options.runner || run;
  if (has(env, "GOOGLE_APPLICATION_CREDENTIALS_JSON")) {
    env.GOOGLE_APPLICATION_CREDENTIALS = writeTempSecretFile(
      tempDir,
      "labor0-google-credentials-",
      "credentials.json",
      env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
    );
    delete env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  }
  if (has(env, "CLAUDE_CODE_CLIENT_CERT_CONTENT")) {
    env.CLAUDE_CODE_CLIENT_CERT = writeTempSecretFile(
      tempDir,
      "labor0-claude-client-cert-",
      "client-cert.pem",
      env.CLAUDE_CODE_CLIENT_CERT_CONTENT,
    );
    delete env.CLAUDE_CODE_CLIENT_CERT_CONTENT;
  }
  if (has(env, "CLAUDE_CODE_CLIENT_KEY_CONTENT")) {
    env.CLAUDE_CODE_CLIENT_KEY = writeTempSecretFile(
      tempDir,
      "labor0-claude-client-key-",
      "client-key.pem",
      env.CLAUDE_CODE_CLIENT_KEY_CONTENT,
    );
    delete env.CLAUDE_CODE_CLIENT_KEY_CONTENT;
  }
  if (
    !has(env, "CLAUDE_CODE_OAUTH_TOKEN") &&
    has(env, "CLAUDE_CODE_OAUTH_REFRESH_TOKEN") &&
    has(env, "CLAUDE_CODE_OAUTH_SCOPES")
  ) {
    runner("claude", ["auth", "login"], {
      capture: true,
      env,
    });
  }
  return {
    googleApplicationCredentials: env.GOOGLE_APPLICATION_CREDENTIALS || "",
    clientCert: env.CLAUDE_CODE_CLIENT_CERT || "",
    clientKey: env.CLAUDE_CODE_CLIENT_KEY || "",
  };
}

function prepareOpenCodeAuthentication(env) {
  if (String(env.OPENCODE_CONFIG_CONTENT || "").trim()) {
    return env.OPENCODE_CONFIG_CONTENT;
  }
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(synthesizeOpenCodeConfig(env));
  return env.OPENCODE_CONFIG_CONTENT;
}

function synthesizeOpenCodeConfig(env) {
  const provider = {};
  if (String(env.OPENAI_API_KEY || "").trim()) {
    provider.openai = {
      options: {
        apiKey: "{env:OPENAI_API_KEY}",
      },
    };
  }
  if (String(env.ANTHROPIC_API_KEY || "").trim()) {
    provider.anthropic = {
      options: {
        apiKey: "{env:ANTHROPIC_API_KEY}",
        ...(String(env.ANTHROPIC_BASE_URL || "").trim()
          ? { baseURL: "{env:ANTHROPIC_BASE_URL}" }
          : {}),
      },
    };
  }
  return {
    $schema: "https://opencode.ai/config.json",
    provider,
  };
}

function writeTempSecretFile(tempDir, directoryPrefix, filename, content) {
  const directory = fs.mkdtempSync(path.join(tempDir, directoryPrefix));
  const filePath = path.join(directory, filename);
  writeSecretFile(filePath, content);
  return filePath;
}

function writeSecretFile(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o600 });
}

function runtimeLabel(runtimeType) {
  switch (runtimeType) {
    case "codex":
      return "Codex";
    case "claude_code":
      return "Claude Code";
    case "opencode":
      return "OpenCode";
    default:
      return runtimeType || "Agent runtime";
  }
}

function graphUpdateDraftSchema() {
  const upsertRefSchema = graphUpdateTaskRefSchema(true);
  const removeRefSchema = graphUpdateTaskRefSchema(false);
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "task_drafts", "upsert_edges", "remove_edges"],
    properties: {
      summary: { type: "string" },
      task_drafts: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: true,
          required: ["draft_task_key", "task_type", "title", "description", "execution_repository_bindings"],
          properties: {
            draft_task_key: { type: "string" },
            task_type: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            labels: {
              type: "array",
              items: { type: "string" },
            },
            execution_repository_bindings: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: true,
                required: ["repository_id", "selected_ref", "access_mode"],
                properties: {
                  repository_id: { type: "string" },
                  selected_ref: { type: "string" },
                  access_mode: { type: "string" },
                  auto_pull_request_enabled: { type: "boolean" },
                },
              },
            },
          },
        },
      },
      upsert_edges: {
        type: "array",
        items: graphUpdateEdgeSchema(upsertRefSchema),
      },
      remove_edges: {
        type: "array",
        items: graphUpdateEdgeSchema(removeRefSchema),
      },
    },
  };
}

function graphUpdateEdgeSchema(refSchema) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["predecessor", "successor"],
    properties: {
      predecessor: refSchema,
      successor: refSchema,
      edge_type: {
        type: "string",
        enum: ["depends_on"],
      },
    },
  };
}

function graphUpdateTaskRefSchema(allowDraftRef) {
  const graphAgentTaskIDRef = {
    type: "object",
    additionalProperties: false,
    required: ["graph_agent_task_id"],
    properties: {
      graph_agent_task_id: { type: "string" },
    },
  };
  if (!allowDraftRef) {
    return graphAgentTaskIDRef;
  }
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      graph_agent_task_id: { type: "string" },
      draft_task_key: { type: "string" },
    },
    oneOf: [
      {
        required: ["graph_agent_task_id"],
      },
      {
        required: ["draft_task_key"],
      },
    ],
  };
}

function runtimePrompt(manifest) {
  if (manifest.agent_task_purpose !== "graph_update") {
    return manifest.prompt || "";
  }
  const graphContext = manifest.graph_update_context
    ? `\n\nCurrent graph context (JSON; use graph_agent_task_id for existing task refs):\n${JSON.stringify(manifest.graph_update_context, null, 2)}`
    : "";
  return `${manifest.prompt || ""}
${graphContext}

Return only one JSON object matching this shape:
{
  "summary": "short summary",
  "task_drafts": [
    {
      "draft_task_key": "stable-kebab-key",
      "task_type": "agent_execution",
      "title": "task title",
      "description": "task details",
      "labels": ["label"],
      "execution_repository_bindings": [
        {
          "repository_id": "uuid from the manifest repositories list",
          "selected_ref": "refs/heads/main",
          "access_mode": "read_write",
          "auto_pull_request_enabled": true
        }
      ]
    }
  ],
  "upsert_edges": [
    {
      "predecessor": { "draft_task_key": "stable-kebab-key" },
      "successor": { "draft_task_key": "another-stable-kebab-key" },
      "edge_type": "depends_on"
    }
  ],
  "remove_edges": [
    {
      "predecessor": { "graph_agent_task_id": "existing predecessor graph_agent_task_id" },
      "successor": { "graph_agent_task_id": "existing successor graph_agent_task_id" },
      "edge_type": "depends_on"
    }
  ]
}
For draft edge refs, use nested predecessor/successor objects only.
Use graph_agent_task_id for existing tasks from the current graph context and draft_task_key for proposed task_drafts.
Do not use predecessor_task_id or successor_task_id in draft payloads; those names appear only in the current graph context.
Do not wrap the JSON in Markdown.`;
}

function shellCommand(command) {
  return ["bash", "-lc", command];
}

function graphUpdateDraftFromOutput(manifest, stdout) {
  const parsed = graphUpdateDraftCandidate(extractJSONObject(stdout));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("graph_update task did not produce a JSON draft");
  }
  if (!Array.isArray(parsed.task_drafts) || parsed.task_drafts.length === 0) {
    throw new Error("graph_update draft must include task_drafts");
  }
  const draft = {
    source_agent_task_session_id: manifest.agent_task_session_id,
    graph_head_sequence: graphUpdateContextHeadSequence(manifest),
    summary: String(parsed.summary || ""),
    task_drafts: parsed.task_drafts,
    upsert_edges: Array.isArray(parsed.upsert_edges) ? parsed.upsert_edges : [],
    remove_edges: Array.isArray(parsed.remove_edges) ? parsed.remove_edges : [],
  };
  validateGraphUpdateDraftEdgePayloads(draft);
  return draft;
}

function validateGraphUpdateDraftEdgePayloads(draft) {
  validateGraphUpdateDraftEdges("graph_update_draft.upsert_edges", draft.upsert_edges, true);
  validateGraphUpdateDraftEdges("graph_update_draft.remove_edges", draft.remove_edges, false);
}

function validateGraphUpdateDraftEdges(field, edges, allowDraftRefs) {
  if (!Array.isArray(edges)) {
    throw new Error(`${field} must be an array`);
  }
  edges.forEach((edge, index) => {
    const edgeField = `${field}[${index}]`;
    if (!edge || typeof edge !== "object" || Array.isArray(edge)) {
      throw new Error(`${edgeField} must be an object`);
    }
    if ("predecessor_task_id" in edge || "successor_task_id" in edge) {
      throw new Error(
        `${edgeField} must use predecessor/successor task refs; predecessor_task_id and successor_task_id are graph context fields only`,
      );
    }
    validateGraphUpdateTaskRef(`${edgeField}.predecessor`, edge.predecessor, allowDraftRefs);
    validateGraphUpdateTaskRef(`${edgeField}.successor`, edge.successor, allowDraftRefs);
    const edgeType = String(edge.edge_type || "").trim();
    if (edgeType && edgeType !== "depends_on") {
      throw new Error(`${edgeField}.edge_type must be depends_on`);
    }
  });
}

function validateGraphUpdateTaskRef(field, ref, allowDraftRef) {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
    throw new Error(`${field} must be an object`);
  }
  const graphAgentTaskID = String(ref.graph_agent_task_id || "").trim();
  const draftTaskKey = String(ref.draft_task_key || "").trim();
  if (allowDraftRef) {
    if ((graphAgentTaskID === "") === (draftTaskKey === "")) {
      throw new Error(`${field} must set exactly one of graph_agent_task_id or draft_task_key`);
    }
    return;
  }
  if (draftTaskKey) {
    throw new Error(`${field} must set graph_agent_task_id; draft_task_key is only allowed in upsert_edges`);
  }
  if (!graphAgentTaskID) {
    throw new Error(`${field} must set graph_agent_task_id`);
  }
}

function extractJSONObject(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first === -1 || last <= first) {
      return null;
    }
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      return null;
    }
  }
}

function graphUpdateDraftCandidate(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  if (parsed.structured_output && typeof parsed.structured_output === "object") {
    return parsed.structured_output;
  }
  if (typeof parsed.structured_output === "string") {
    return graphUpdateDraftCandidate(extractJSONObject(parsed.structured_output));
  }
  if (Array.isArray(parsed.task_drafts) || typeof parsed.summary === "string") {
    return parsed;
  }
  if (parsed.result && typeof parsed.result === "object") {
    return graphUpdateDraftCandidate(parsed.result);
  }
  if (typeof parsed.result === "string") {
    return graphUpdateDraftCandidate(extractJSONObject(parsed.result));
  }
  return null;
}

function recordDebug(lines, env, secrets, label, value) {
  if (!isDebugMode(env)) {
    return;
  }
  const message = `${label}: ${formatDebugValue(value, secrets)}`;
  debug(message, env);
  lines.push(message);
}

function formatDebugValue(value, secrets) {
  const formatted = typeof value === "string" ? value : JSON.stringify(redact(value));
  return sanitizeText(formatted || "", secrets);
}

function manifestDebugSummary(manifest) {
  return {
    agent_task_session_id: manifest.agent_task_session_id,
    agent_task_id: manifest.agent_task_id,
    graph_agent_task_id: manifest.graph_agent_task_id,
    agent_task_purpose: manifest.agent_task_purpose || "",
    agent_runtime_type: manifest.agent_runtime_type || "",
    agent_model: manifest.agent_model || "",
    prompt_bytes: byteLength(manifest.prompt || ""),
    graph_update_context: graphUpdateContextDebugSummary(manifest.graph_update_context),
    repository_count: Array.isArray(manifest.repositories) ? manifest.repositories.length : 0,
    repositories: (manifest.repositories || []).map((repository) => ({
      repository_id: repository.repository_id || "",
      git_url: repository.git_url || "",
      checkout_path: repository.checkout_path || "",
      selected_ref: repository.selected_ref || "",
      access_mode: repository.access_mode || "",
      auto_pull_request_enabled: repository.auto_pull_request_enabled !== false,
    })),
    agent_runtime_environment_keys: Object.keys(manifest.agent_runtime_environment || {}).sort(),
  };
}

function runtimeResultSummary(result) {
  return {
    exit_code: result.status ?? 1,
    signal: result.signal,
    stdout_bytes: byteLength(result.stdout || ""),
    stderr_bytes: byteLength(result.stderr || ""),
  };
}

function commandForDebug(command, manifest, secrets) {
  const prompt = runtimePrompt(manifest);
  return (command || []).map((part) => {
    const value = String(part || "");
    if (value === prompt || value === String(manifest.prompt || "")) {
      return "[PROMPT_REDACTED]";
    }
    if (looksLikeGraphUpdateSchema(value)) {
      return "[JSON_SCHEMA]";
    }
    return sanitizeText(value, secrets);
  });
}

function looksLikeGraphUpdateSchema(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return false;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && parsed.type === "object" && parsed.properties && parsed.properties.task_drafts;
  } catch {
    return false;
  }
}

function manifestSecretValues(manifest) {
  const values = [manifest.prompt, runtimePrompt(manifest), ...graphUpdateContextSecretValues(manifest.graph_update_context)];
  for (const value of Object.values(manifest.agent_runtime_environment || {})) {
    values.push(value);
  }
  for (const repository of manifest.repositories || []) {
    values.push(repository.token);
    values.push(repository.access_token);
    values.push(repository.credential && repository.credential.token);
  }
  return [...new Set(values.map((value) => String(value || "")).filter((value) => value.length >= 3))].sort(
    (left, right) => right.length - left.length,
  );
}

function graphUpdateContextHeadSequence(manifest) {
  const value =
    manifest &&
    manifest.graph_update_context &&
    manifest.graph_update_context.graph_head &&
    manifest.graph_update_context.graph_head.graph_head_sequence;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function graphUpdateContextDebugSummary(context) {
  if (!context || typeof context !== "object") {
    return undefined;
  }
  return {
    graph_head_sequence: graphUpdateContextHeadSequence({ graph_update_context: context }),
    task_count: Array.isArray(context.tasks) ? context.tasks.length : 0,
    edge_count: Array.isArray(context.edges) ? context.edges.length : 0,
    repository_count: Array.isArray(context.repositories) ? context.repositories.length : 0,
  };
}

function graphUpdateContextSecretValues(context) {
  const values = [];
  if (!context || typeof context !== "object" || !Array.isArray(context.tasks)) {
    return values;
  }
  for (const task of context.tasks) {
    values.push(task && task.title);
    values.push(task && task.description);
    if (Array.isArray(task && task.labels)) {
      values.push(...task.labels);
    }
  }
  return values;
}

function sanitizeText(value, secrets) {
  let output = String(value || "");
  for (const secret of secrets || []) {
    output = output.split(secret).join("[REDACTED]");
  }
  return output;
}

function createPullRequestsForChangedRepositories(manifest) {
  const pullRequests = [];
  for (const repository of manifest.repositories || []) {
    if (!shouldCreatePullRequest(repository)) {
      continue;
    }
    const checkoutPath = path.resolve(
      process.env.GITHUB_WORKSPACE || process.cwd(),
      repository.checkout_path || `repositories/${repository.repository_id}`,
    );
    if (!fs.existsSync(checkoutPath) || !hasChanges(checkoutPath)) {
      continue;
    }
    pullRequests.push(createPullRequest(manifest, repository, checkoutPath));
  }
  return pullRequests;
}

function shouldCreatePullRequest(repository) {
  return repository.access_mode === "read_write" && repository.auto_pull_request_enabled !== false;
}

function hasChanges(cwd) {
  const result = run("git", ["status", "--porcelain"], { cwd, capture: true });
  return result.stdout.trim().length > 0;
}

function createPullRequest(manifest, repository, cwd) {
  const ref = parseGitHubRepository(repository.git_url);
  if (!ref) {
    throw new Error(`Cannot open pull request for non-GitHub repository ${repository.git_url}`);
  }
  const token = repository.token || repository.access_token || (repository.credential && repository.credential.token);
  const branchName = `labor0/${shortID(manifest.agent_task_session_id)}/${shortID(repository.repository_id)}`;
  const baseBranch = normalizeRef(repository.selected_ref);
  const title = `chore: apply ${manifest.task_title || "Labor0 agent task"}`;
  const body = [
    `Labor0 agent task: ${manifest.agent_task_id}`,
    `Session: ${manifest.agent_task_session_id}`,
    `Runtime: ${manifest.agent_runtime_type}${manifest.agent_model ? ` (${manifest.agent_model})` : ""}`,
  ].join("\n");
  const env = { ...process.env, ...(token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {}) };

  run("git", ["config", "user.name", "labor0-agent"], { cwd });
  run("git", ["config", "user.email", "agent@labor0.com"], { cwd });
  run("git", ["checkout", "-B", branchName], { cwd });
  run("git", ["add", "-A"], { cwd });
  run("git", ["commit", "-m", title], { cwd });
  run("git", ["push", "-u", "origin", `HEAD:${branchName}`], { cwd });

  const existing = viewPullRequest(branchName, cwd, env);
  const pr = existing || createGitHubPullRequest(branchName, baseBranch, title, body, cwd, env);
  return {
    repository_id: repository.repository_id,
    git_url: repository.git_url,
    branch_name: branchName,
    pull_request_ref: `github:${ref.owner}/${ref.repo}#${pr.number}`,
    pull_request_number: pr.number,
    pull_request_url: pr.url,
    is_open: true,
  };
}

function viewPullRequest(branchName, cwd, env) {
  const result = spawnSync("gh", ["pr", "view", branchName, "--json", "number,url"], {
    cwd,
    env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return null;
  }
  return JSON.parse(result.stdout);
}

function createGitHubPullRequest(branchName, baseBranch, title, body, cwd, env) {
  const create = run(
    "gh",
    ["pr", "create", "--title", title, "--body", body, "--base", baseBranch, "--head", branchName],
    { cwd, env, capture: true },
  );
  const url = create.stdout.trim().split(/\s+/).find((item) => /^https?:\/\//.test(item)) || "";
  const view = run("gh", ["pr", "view", url || branchName, "--json", "number,url"], {
    cwd,
    env,
    capture: true,
  });
  return JSON.parse(view.stdout);
}

function parseGitHubRepository(gitURL) {
  const match = String(gitURL || "").match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return match ? { owner: match[1], repo: match[2] } : null;
}

function normalizeRef(ref) {
  return (ref || "main").replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "");
}

function shortID(value) {
  return String(value || "task").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "task";
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    encoding: "utf8",
    input: options.input,
    stdio: options.capture || options.input !== undefined ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    const stderr = result.stderr || "";
    throw new Error(`${command} failed with ${result.status}: ${stderr.trim()}`);
  }
  return result;
}

function compact(values) {
  return values.filter(Boolean);
}

function tail(value, max = 12000) {
  return value.length > max ? value.slice(value.length - max) : value;
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    fail(error);
  }
}

module.exports = {
  agentEnvironment,
  extractJSONObject,
  graphUpdateDraftSchema,
  graphUpdateDraftFromOutput,
  graphUpdateDraftCandidate,
  manifestSecretValues,
  prepareClaudeCodeAuthentication,
  prepareCodexAuthentication,
  prepareOpenCodeAuthentication,
  prepareRuntimeAuthentication,
  runtimeAuthStatus,
  runtimeCommand,
  runAgent,
  sanitizeText,
  shouldCreatePullRequest,
  synthesizeOpenCodeConfig,
  validateRuntimeAuth,
};
