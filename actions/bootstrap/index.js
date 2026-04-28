"use strict";

const path = require("node:path");
const { addMask, fail, getInput, info, setOutput, writeJSON } = require("../lib/core");
const { requestOIDCToken } = require("../lib/github-oidc");
const { maskManifestSecrets } = require("../lib/manifest");

async function main() {
  const sessionID = getInput("agent_task_session_id", { required: true });
  const baseURL = getInput("graph_agent_base_url", { required: true }).replace(/\/+$/, "");
  const audience = getInput("oidc_audience") || baseURL;
  const token = await requestOIDCToken(audience);
  addMask(token);

  const response = await fetch(`${baseURL}/github-actions/agent-task-sessions/${sessionID}/bootstrap`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!response.ok) {
    throw new Error(`graph-agent bootstrap failed with ${response.status}: ${await response.text()}`);
  }
  const manifest = await response.json();
  maskManifestSecrets(manifest);
  const manifestPath = path.join(process.env.RUNNER_TEMP || process.cwd(), "labor0-agent-task-manifest.json");
  writeJSON(manifestPath, manifest);
  setOutput("manifest_path", manifestPath);
  info(`Received graph-agent manifest for session ${sessionID}`);
}

main().catch(fail);
