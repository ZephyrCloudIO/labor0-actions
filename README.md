# labor0-actions

Shared GitHub Actions runner infrastructure for Labor0 graph-agent tasks.

Use the reusable workflow from a target repository wrapper:

```yaml
jobs:
  labor0-agent-task:
    uses: ZephyrCloudIO/labor0-actions/.github/workflows/agent-task.yml@v0
    with:
      agent_task_session_id: ${{ inputs.agent_task_session_id }}
      graph_agent_base_url: ${{ inputs.graph_agent_base_url }}
```

Prompts, repository credentials, and provider credentials must not be passed as workflow inputs. The workflow bootstraps with GitHub Actions OIDC and receives the execution manifest from graph-agent.
