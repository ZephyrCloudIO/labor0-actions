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

For graph-update planning tasks, the runner requests structured JSON draft output and reports a `graph_update_draft` callback. For coding tasks, changed `read_write` repository checkouts are committed to a Labor0 branch, pushed, opened as pull requests by default, and reported back as `pull_request_linked` callbacks unless the binding sets `auto_pull_request_enabled=false`.

During active development, target repository wrappers should consume the reusable workflow from the `main` branch so runner changes are available without waiting for release tags.
