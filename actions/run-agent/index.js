"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { fail, getInput, info, setOutput, writeJSON } = require("../lib/core");
const { readManifest } = require("../lib/manifest");
const { redact } = require("../lib/redaction");

function main() {
  const manifest = readManifest(getInput("manifest_path", { required: true }));
  const resultPath = path.join(process.env.RUNNER_TEMP || process.cwd(), "labor0-agent-task-result.json");
  const command = runtimeCommand(manifest);
  info(`Running ${manifest.agent_runtime_type || "agent"} for ${manifest.agent_task_purpose || "task"}`);
  const startedAt = new Date();
  const result = spawnSync(command[0], command.slice(1), {
    cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
    env: {
      ...process.env,
      LABOR0_AGENT_TASK_SESSION_ID: manifest.agent_task_session_id,
      LABOR0_AGENT_TASK_ID: manifest.agent_task_id,
      LABOR0_GRAPH_AGENT_TASK_ID: manifest.graph_agent_task_id,
      LABOR0_AGENT_TASK_PURPOSE: manifest.agent_task_purpose || "",
      LABOR0_AGENT_RUNTIME_TYPE: manifest.agent_runtime_type || "",
      LABOR0_AGENT_PROMPT: manifest.prompt || "",
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
}

function runtimeCommand(manifest) {
  if (process.env.LABOR0_AGENT_COMMAND) {
    return shellCommand(process.env.LABOR0_AGENT_COMMAND, manifest.prompt || "");
  }
  switch (manifest.agent_runtime_type) {
    case "codex":
      return ["codex", "exec", "--ask-for-approval", "never", "--sandbox", "danger-full-access", manifest.prompt || ""];
    case "claude_code":
      return ["claude", "--print", manifest.prompt || ""];
    case "opencode":
      return ["opencode", "run", manifest.prompt || ""];
    default:
      throw new Error(`Unsupported agent_runtime_type: ${manifest.agent_runtime_type || "(empty)"}`);
  }
}

function shellCommand(command, prompt) {
  void prompt;
  return ["bash", "-lc", command];
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
