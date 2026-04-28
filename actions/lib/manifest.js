"use strict";

const { addMask, readJSON } = require("./core");

function readManifest(filePath) {
  const manifest = readJSON(filePath);
  maskManifestSecrets(manifest);
  if (!manifest.agent_task_session_id) {
    throw new Error("Manifest is missing agent_task_session_id");
  }
  if (!manifest.callback_url) {
    throw new Error("Manifest is missing callback_url");
  }
  return manifest;
}

function maskManifestSecrets(manifest) {
  addMask(manifest.prompt);
  for (const repository of manifest.repositories || []) {
    addMask(repository.token);
    addMask(repository.access_token);
    addMask(repository.credential && repository.credential.token);
  }
}

module.exports = { maskManifestSecrets, readManifest };
