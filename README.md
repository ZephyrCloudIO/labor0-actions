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

The manifest selects the agent runtime and optional model. Repository checkouts accept GitHub HTTPS or SSH URLs and use repository-scoped installation tokens from the manifest when present. `run-agent` installs missing CLIs on the runner, validates runtime auth before launch, prepares Codex with a temporary `CODEX_HOME` plus API-key login, runs Claude Code with environment auth, and runs OpenCode with `opencode run --dangerously-skip-permissions`. Provider credentials are injected only from the bootstrapped `agent_runtime_environment`; they are never workflow inputs.

Runtime credential requirements:

- Codex requires `OPENAI_API_KEY`.
- Claude Code requires `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`.
- OpenCode requires `OPENCODE_CONFIG_CONTENT`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY`. When no explicit OpenCode config is provided, `run-agent` synthesizes `OPENCODE_CONFIG_CONTENT` with environment-variable substitution.

For graph-update planning tasks, the runner requests structured JSON draft output and reports a `graph_update_draft` callback. For coding tasks, changed `read_write` repository checkouts are committed to a Labor0 branch, pushed, opened as pull requests by default, and reported back as `pull_request_linked` callbacks unless the binding sets `auto_pull_request_enabled=false`.

During active development, target repository wrappers should consume the reusable workflow from the `main` branch so runner changes are available without waiting for release tags.
