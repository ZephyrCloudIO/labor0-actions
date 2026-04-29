"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { fail, getInput, info } = require("../lib/core");
const { readManifest } = require("../lib/manifest");

function main() {
  const manifest = readManifest(getInput("manifest_path", { required: true }));
  for (const repository of manifest.repositories || []) {
    const checkoutPath = path.resolve(process.env.GITHUB_WORKSPACE || process.cwd(), repository.checkout_path || `repositories/${repository.repository_id}`);
    fs.mkdirSync(path.dirname(checkoutPath), { recursive: true });
    if (fs.existsSync(checkoutPath)) {
      info(`Repository path already exists: ${repository.checkout_path}`);
      continue;
    }
    const cloneURL = credentialedGitURL(repository);
    run("git", ["clone", "--no-tags", "--depth", "1", "--branch", normalizeRef(repository.selected_ref), cloneURL, checkoutPath], cloneURL);
    info(`Checked out ${repository.git_url} at ${repository.checkout_path}`);
  }
}

function run(command, args, secret) {
  const result = spawnSync(command, args, { stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0) {
    const stderr = (result.stderr || "").replaceAll(secret || "", "[REDACTED]");
    throw new Error(`${command} failed: ${stderr}`);
  }
}

function normalizeRef(ref) {
  return (ref || "main").replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "");
}

function credentialedGitURL(repository) {
  const token = repository.token || repository.access_token || (repository.credential && repository.credential.token);
  const gitURL = githubHTTPSURL(repository.git_url || "");
  if (!token || !/^https:\/\/github\.com\//i.test(gitURL)) {
    return gitURL;
  }
  return gitURL.replace(/^https:\/\//i, `https://x-access-token:${encodeURIComponent(token)}@`);
}

function githubHTTPSURL(gitURL) {
  const sshMatch = gitURL.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}.git`;
  }
  return gitURL;
}

try {
  main();
} catch (error) {
  fail(error);
}
