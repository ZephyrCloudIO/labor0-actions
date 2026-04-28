"use strict";

const { addMask, fail, getInput, info, readJSON } = require("../lib/core");
const { requestOIDCToken } = require("../lib/github-oidc");
const { readManifest } = require("../lib/manifest");
const { redact } = require("../lib/redaction");

async function main() {
  const manifest = readManifest(getInput("manifest_path", { required: true }));
  const eventType = getInput("event_type", { required: true });
  const resultPath = getInput("result_path");
  const draftPath = getInput("dependency_analysis_draft_path");
  const graphUpdateDraftPath = getInput("graph_update_draft_path");
  const baseURL = callbackBaseURL(manifest);
  const audience = getInput("oidc_audience") || baseURL;
  const token = await requestOIDCToken(audience);
  addMask(token);

  const payload = {
    event_type: eventType,
    message: getInput("message"),
    occurred_at: new Date().toISOString(),
  };
  if (resultPath) {
    payload.result_json = redact(readJSON(resultPath));
  }
  if (draftPath) {
    payload.dependency_analysis_draft = redact(readJSON(draftPath));
  }
  if (graphUpdateDraftPath) {
    payload.graph_update_draft = redact(readJSON(graphUpdateDraftPath));
  }

  const response = await fetch(manifest.callback_url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`graph-agent event report failed with ${response.status}: ${await response.text()}`);
  }
  info(`Reported ${eventType} for session ${manifest.agent_task_session_id}`);
}

function callbackBaseURL(manifest) {
  const url = new URL(manifest.callback_url);
  return `${url.protocol}//${url.host}`;
}

main().catch(fail);
