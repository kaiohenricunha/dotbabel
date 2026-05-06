# Azure DevOps and ACR

## Key Concepts

- **Azure Pipelines** — CI/CD service. YAML pipelines (in-repo) preferred over classic UI-only pipelines.
- **Azure Repos** — Git hosting. Branch policies, build validation, required reviewers.
- **Azure Artifacts** — package feeds (NuGet, npm, Maven, Python, universal).
- **ACR (Azure Container Registry)** — container registry. SKUs: Basic/Standard/Premium (Premium adds geo-replication, content trust, private link).
- **ACR Tasks** — build and patch images on ACR-managed agents; base image updates auto-trigger rebuilds.

## Common Patterns

```yaml
# azure-pipelines.yml — multi-stage with approval gate
trigger:
  branches: { include: ["main"] }

stages:
  - stage: Build
    jobs:
      - job: BuildImage
        pool: { vmImage: "ubuntu-latest" }
        steps:
          - task: Docker@2
            inputs:
              containerRegistry: "my-acr"
              repository: "my-app"
              command: "buildAndPush"
              tags: |
                $(Build.BuildId)
                latest

  - stage: DeployProd
    dependsOn: Build
    condition: succeeded()
    jobs:
      - deployment: DeployToProd
        environment: "production" # requires approval configured in env settings
        strategy:
          runOnce:
            deploy:
              steps:
                - script: kubectl apply -f k8s/
```

```yaml
# ACR Task — auto-rebuild on base image update
version: v1.1.0
steps:
  - build: -t $Registry/my-app:{{.Run.ID}} .
  - push: [$Registry/my-app:{{.Run.ID}}]
triggers:
  base:
    - image: mcr.microsoft.com/dotnet/aspnet:8.0
```

## Checklist

- [ ] Pipelines defined in YAML (git-tracked), not classic UI-only.
- [ ] Production deploys gated by environment approvals.
- [ ] Service connections use Workload Identity federation (not long-lived service principal secrets).
- [ ] Branch policies on `main`: build must pass, required reviewers, linear history.
- [ ] ACR: Premium SKU for production; content trust enabled for signed images.
- [ ] ACR tasks configured for base image update triggers on critical images.
- [ ] Pipeline secrets stored in Azure Key Vault, referenced via variable groups.

## Gotchas

- Pipelines YAML parser silently accepts extra keys — typos in task input names don't fail, just don't apply the value.
- Environment approvals block the deployment job, not the stage — pre-deploy tasks in the same stage run before approval.
- Self-hosted agents without `chmod +x` on a script task fail with "permission denied" — use `script:` inline or ensure agent image has scripts.
- ACR admin user (`--admin-enabled`) should be disabled in production; use Managed Identity or SP with `AcrPull` role.
- Service connections set to "Grant access permission to all pipelines" is convenient but bypasses per-pipeline consent — review for production.
- ACR quarantine + vulnerability scanning (Defender for Containers) is separate from ACR Tasks — enable explicitly.
