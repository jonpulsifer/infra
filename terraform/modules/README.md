# modules

Reusable OpenTofu modules that roots call by relative `source` path. See [OpenTofu and Atlantis](https://wiki.lolwtf.ca/platform/opentofu/) on the wiki.

Each subdirectory is one module. A module has no `backend` block and no state. CI validates a changed module in its own directory:

```bash
tofu -chdir=terraform/modules/<module> init -backend=false
tofu -chdir=terraform/modules/<module> validate
```

Atlantis plans each root that calls a changed module, because `clusters/offsite/apps/atlantis/helm-release.yaml` sets `ATLANTIS_AUTOPLAN_MODULES`.

<!-- BEGIN_TF_DOCS -->
## Requirements

No requirements.

## Providers

No providers.

## Modules

No modules.

## Resources

No resources.

## Inputs

No inputs.

## Outputs

No outputs.
<!-- END_TF_DOCS -->