"use strict";

const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { fail, getInput, info, readJSON, setOutput, writeJSON } = require("../lib/core");
const { readManifest } = require("../lib/manifest");
const { redact } = require("../lib/redaction");

const CODEX_PACKAGE = "@openai/codex@0.125.0";

function main() {
  const manifest = readManifest(getInput("manifest_path", { required: true }));
  const resultPath = path.join(process.env.RUNNER_TEMP || process.cwd(), "labor0-agent-task-result.json");
  const graphUpdateDraftPath = graphUpdateDraftOutputPath(manifest);
  const prompt = promptForManifest(manifest, graphUpdateDraftPath);
  const agentEnv = runtimeEnvironment(manifest);
  const command = runtimeCommand(manifest, prompt, agentEnv);
  info(`Running ${manifest.agent_runtime_type || "agent"} for ${manifest.agent_task_purpose || "task"}`);
  const startedAt = new Date();
  const result = spawnSync(command[0], command.slice(1), {
    cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
    env: {
      ...process.env,
      ...agentEnv,
      LABOR0_AGENT_TASK_SESSION_ID: manifest.agent_task_session_id,
      LABOR0_AGENT_TASK_ID: manifest.agent_task_id,
      LABOR0_GRAPH_AGENT_TASK_ID: manifest.graph_agent_task_id,
      LABOR0_AGENT_TASK_PURPOSE: manifest.agent_task_purpose || "",
      LABOR0_AGENT_RUNTIME_TYPE: manifest.agent_runtime_type || "",
      LABOR0_AGENT_PROMPT: prompt,
      LABOR0_GRAPH_UPDATE_DRAFT_PATH: graphUpdateDraftPath || "",
    },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const endedAt = new Date();
  const output = {
    agent_task_session_id: manifest.agent_task_session_id,
    agent_task_id: manifest.agent_task_id,
    graph_agent_task_id: manifest.graph_agent_task_id,
    agent_task_purpose: manifest.agent_task_purpose,
    agent_runtime_type: manifest.agent_runtime_type,
    exit_code: result.status ?? 1,
    signal: result.signal,
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    stdout_tail: tail(result.stdout || ""),
    stderr_tail: tail(result.stderr || ""),
  };
  writeJSON(resultPath, redact(output));
  setOutput("result_path", resultPath);
  if (result.status !== 0) {
    throw new Error(`${command[0]} exited with ${result.status ?? result.signal}`);
  }
  if (graphUpdateDraftPath) {
    if (!fs.existsSync(graphUpdateDraftPath)) {
      throw new Error(`graph_update agent completed without writing ${graphUpdateDraftPath}`);
    }
    readJSON(graphUpdateDraftPath);
    setOutput("graph_update_draft_path", graphUpdateDraftPath);
  }
}

function runtimeCommand(manifest, prompt, agentEnv) {
  const overrideCommand = process.env.LABOR0_AGENT_COMMAND || agentEnv.LABOR0_AGENT_COMMAND;
  if (overrideCommand) {
    return shellCommand(overrideCommand, prompt);
  }
  switch (manifest.agent_runtime_type) {
    case "codex":
      return codexCommand(prompt);
    case "claude_code":
      return ["claude", "--print", prompt];
    case "opencode":
      return ["opencode", "run", prompt];
    default:
      throw new Error(`Unsupported agent_runtime_type: ${manifest.agent_runtime_type || "(empty)"}`);
  }
}

function codexCommand(prompt) {
  const args = ["--ask-for-approval", "never", "--sandbox", "danger-full-access", "exec", prompt];
  if (commandExists("codex")) {
    return ["codex", ...args];
  }
  return ["npx", "--yes", CODEX_PACKAGE, ...args];
}

function commandExists(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function shellCommand(command, prompt) {
  void prompt;
  return ["bash", "-lc", command];
}

function runtimeEnvironment(manifest) {
  const value = manifest.agent_runtime_environment || {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Manifest agent_runtime_environment must be an object");
  }
  const env = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new Error(`Manifest agent_runtime_environment.${key} must be a string`);
    }
    env[key] = item;
  }
  return env;
}

function graphUpdateDraftOutputPath(manifest) {
  if (manifest.agent_task_purpose !== "graph_update") {
    return "";
  }
  return path.join(process.env.RUNNER_TEMP || process.cwd(), "labor0-graph-update-draft.json");
}

function promptForManifest(manifest, graphUpdateDraftPath) {
  const basePrompt = manifest.prompt || "";
  if (!graphUpdateDraftPath) {
    return basePrompt;
  }
  return `${basePrompt}

After analyzing the project graph, write the proposed graph update draft as JSON to the file path in LABOR0_GRAPH_UPDATE_DRAFT_PATH. Do not edit the visible graph directly.

The JSON must use this shape:
{
  "source_agent_task_session_id": "${manifest.agent_task_session_id}",
  "summary": "short human-readable summary",
  "task_drafts": [
    {
      "draft_task_key": "stable-key-for-this-draft-task",
      "task_type": "agent_execution",
      "title": "visible graph task title",
      "description": "coding task prompt",
      "labels": ["optional-label"],
      "execution_repository_bindings": [
        {
          "repository_id": "repository UUID from the manifest",
          "selected_ref": "branch-or-ref",
          "access_mode": "read_write",
          "auto_pull_request_enabled": true
        }
      ]
    }
  ],
  "upsert_edges": [
    {
      "predecessor": { "draft_task_key": "dependency-key" },
      "successor": { "draft_task_key": "dependent-key" },
      "edge_type": "depends_on"
    }
  ],
  "remove_edges": []
}

Use graph_agent_task_id instead of draft_task_key when an edge references an existing visible graph task. New coding tasks must include at least one read_write execution_repository_bindings entry.`;
}

function tail(value) {
  const max = 12000;
  return value.length > max ? value.slice(value.length - max) : value;
}

try {
  main();
} catch (error) {
  fail(error);
}
