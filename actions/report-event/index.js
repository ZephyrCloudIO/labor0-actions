"use strict";

const { addMask, fail, getInput, info, readJSON } = require("../lib/core");
const { requestOIDCToken } = require("../lib/github-oidc");
const { readManifest } = require("../lib/manifest");
const { redact } = require("../lib/redaction");

async function main() {
  const manifest = readManifest(getInput("manifest_path", { required: true }));
  const eventType = getInput("event_type", { required: true });
  const resultPath = getInput("result_path");
  const dependencyDraftPath = getInput("dependency_analysis_draft_path");
  const graphDraftPath = getInput("graph_update_draft_path");
  const pullRequestsPath = getInput("pull_requests_path");
  const baseURL = callbackBaseURL(manifest);
  const audience = getInput("oidc_audience") || baseURL;
  const token = await requestOIDCToken(audience);
  addMask(token);

  if (pullRequestsPath) {
    const pullRequests = readJSON(pullRequestsPath);
    if (!Array.isArray(pullRequests)) {
      throw new Error("pull_requests_path must contain an array");
    }
    for (const pullRequest of pullRequests) {
      await postEvent(manifest, token, {
        event_type: "pull_request_linked",
        message: getInput("message"),
        occurred_at: new Date().toISOString(),
        pull_request: redact(pullRequest),
      });
    }
    info(`Reported ${pullRequests.length} pull request link(s) for session ${manifest.agent_task_session_id}`);
    return;
  }

  const payload = {
    event_type: eventType,
    message: getInput("message"),
    occurred_at: new Date().toISOString(),
  };
  if (resultPath) {
    payload.result_json = redact(readJSON(resultPath));
  }
  if (dependencyDraftPath) {
    payload.dependency_analysis_draft = redact(readJSON(dependencyDraftPath));
  }
  if (graphDraftPath) {
    payload.graph_update_draft = redact(readJSON(graphDraftPath));
  }

  await postEvent(manifest, token, payload);
  info(`Reported ${eventType} for session ${manifest.agent_task_session_id}`);
}

async function postEvent(manifest, token, payload) {
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
}

function callbackBaseURL(manifest) {
  const url = new URL(manifest.callback_url);
  return `${url.protocol}//${url.host}`;
}

main().catch(fail);
