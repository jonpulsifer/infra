# folly bootstrap

The OpenTofu root that installs CoreDNS and Flux on the folly cluster and labels its nodes. [Kubernetes](https://wiki.lolwtf.ca/platform/kubernetes/) describes what it creates.

It calls `terraform/modules/flux-bootstrap` with `flux-values.yaml`, which points Flux at `clusters/folly/flux-system`. `node-labels.tf` sets each node's role and `bgp-enabled` labels. State is in `gs://homelab-ng/clusters/folly/bootstrap`.

## Develop

```bash
tofu -chdir=clusters/folly/bootstrap init -backend=false
tofu -chdir=clusters/folly/bootstrap validate
tofu -chdir=clusters/folly/bootstrap test
```

`bootstrap.tftest.hcl` runs against mock providers and needs no cluster access. CI runs the same three commands.

## Deploy

Atlantis applies this root from the PR, as [Apply an OpenTofu change](https://wiki.lolwtf.ca/runbooks/apply-an-opentofu-change/) describes. A change to `flux-values.yaml` alone does not autoplan, so comment `atlantis plan -d clusters/folly/bootstrap` on the PR. Comment `atlantis apply` before you merge. A merge without an apply does not change the cluster.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_github"></a> [github](#requirement\_github) | n/a |
| <a name="requirement_helm"></a> [helm](#requirement\_helm) | n/a |
| <a name="requirement_kubernetes"></a> [kubernetes](#requirement\_kubernetes) | n/a |
| <a name="requirement_tls"></a> [tls](#requirement\_tls) | n/a |
<!-- END_TF_DOCS -->
