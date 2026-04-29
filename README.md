# labor0-actions

Shared GitHub Actions runner infrastructure for Labor0 graph-agent tasks.

Use the reusable workflow from a target repository wrapper:

```yaml
jobs:
  labor0-agent-task:
    uses: ZephyrCloudIO/labor0-actions/.github/workflows/agent-task.yml@main
    with:
      agent_task_session_id: ${{ inputs.agent_task_session_id }}
      graph_agent_base_url: ${{ inputs.graph_agent_base_url }}
```

Prompts, repository credentials, and provider credentials must not be passed as workflow inputs. The workflow bootstraps with GitHub Actions OIDC and receives the execution manifest from graph-agent.

The manifest selects the agent runtime and optional model. Repository checkouts accept GitHub HTTPS or SSH URLs and use repository-scoped installation tokens from the manifest when present. `run-agent` installs missing CLIs on the runner, validates runtime auth before launch, prepares Codex with a temporary `CODEX_HOME`, expands supported content-backed credentials into temporary files, runs Claude Code with environment auth, and runs OpenCode with `opencode run --dangerously-skip-permissions`. Provider credentials are injected only from the bootstrapped `agent_runtime_environment`; they are never workflow inputs.

Runtime credential requirements:

- Codex requires `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_AGENT_IDENTITY`, `CODEX_AUTH_JSON_CONTENT`, or `CODEX_CONFIG_CONTENT`.
- Claude Code requires a direct Anthropic API key/token, Claude Code OAuth token or refresh-token pair, or a supported Bedrock/Mantle, Vertex, or Foundry credential set. Refresh-token pairs are exchanged with `claude auth login`; `GOOGLE_APPLICATION_CREDENTIALS_JSON`, `CLAUDE_CODE_CLIENT_CERT_CONTENT`, and `CLAUDE_CODE_CLIENT_KEY_CONTENT` are written to temporary files before launch.
- OpenCode requires `OPENCODE_AUTH_CONTENT`, `OPENCODE_CONFIG_CONTENT`, direct OpenAI/Anthropic credentials, or supported AWS/GCP provider credentials. When no explicit OpenCode config is provided, `run-agent` synthesizes `OPENCODE_CONFIG_CONTENT` with environment-variable substitution for direct OpenAI/Anthropic keys.

For graph-update planning tasks, the runner appends the manifest `graph_update_context` to the agent prompt, requests one YAML draft document, parses that YAML into the existing draft object, and reports a JSON `graph_update_draft` callback with the manifest graph head sequence. The callback and `graph_update_draft_path` file remain JSON for graph-agent compatibility. The parser keeps legacy JSON and Claude Code `structured_output` envelope fallback support, but the default runtime prompts no longer use JSON structured-output flags. For coding tasks, changed `read_write` repository checkouts are committed to a Labor0 branch, pushed, opened as pull requests by default, and reported back as `pull_request_linked` callbacks unless the binding sets `auto_pull_request_enabled=false`.

`run-agent` always writes a sanitized result JSON before failing after runtime launch. The result includes runtime identity, timing, exit status, output byte counts, stdout/stderr tails, and graph-update draft parse errors when present. When GitHub Actions step debug logging sets `RUNNER_DEBUG=1`, or when `LABOR0_AGENT_DEBUG=true` is set for local/manual debugging, `run-agent` emits sanitized debug diagnostics and exposes a `debug_artifact_path` output. The reusable workflow uploads that artifact only when debug mode is active. Diagnostics include manifest metadata, graph-update context counts and head sequence, runtime environment key names, repository IDs and paths, command shape with prompts redacted, output byte counts, and sanitized output tails; prompts, graph task text, provider credentials, and repository tokens are redacted from logs and artifacts.

During active development, target repository wrappers should consume the reusable workflow from the `main` branch so runner changes are available without waiting for release tags.
