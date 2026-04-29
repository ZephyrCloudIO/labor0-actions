# labor0-actions

Shared GitHub Actions runner infrastructure for Labor0 graph-agent tasks.

Use the reusable workflow from a target repository wrapper:

```yaml
jobs:
  labor0-agent-task:
    uses: ZephyrCloudIO/labor0-actions/.github/workflows/agent-task.yml@v0.1
    with:
      agent_task_session_id: ${{ inputs.agent_task_session_id }}
      graph_agent_base_url: ${{ inputs.graph_agent_base_url }}
```

Prompts, repository credentials, and provider credentials must not be passed as workflow inputs. The workflow bootstraps with GitHub Actions OIDC and receives the execution manifest from graph-agent.

The manifest selects the agent runtime and optional model. `run-agent` installs missing CLIs on the runner, runs Codex with `codex exec`, runs Claude Code with `claude -p`, and injects provider credentials only from the bootstrapped `agent_runtime_environment`.

For graph-update planning tasks, the runner requests structured JSON draft output and reports a `graph_update_draft` callback. For coding tasks, changed `read_write` repository checkouts are committed to a Labor0 branch, pushed, opened as pull requests by default, and reported back as `pull_request_linked` callbacks unless the binding sets `auto_pull_request_enabled=false`.

The `v0.1` tag is the current release tag for this runtime behavior. Keep `v0` pinned for wrappers that still need the original bootstrap-only runner contract.
