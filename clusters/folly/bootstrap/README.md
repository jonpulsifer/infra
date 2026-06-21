# folly bootstrap (Flux + node labels)

Terraform root module that bootstraps FluxCD on the **folly** cluster and labels
folly nodes. Was previously `terraform/k8s/`.

State: `gs://homelab-ng/clusters/folly/bootstrap`

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_github"></a> [github](#requirement\_github) | n/a |
| <a name="requirement_helm"></a> [helm](#requirement\_helm) | n/a |
| <a name="requirement_kubernetes"></a> [kubernetes](#requirement\_kubernetes) | n/a |
| <a name="requirement_tls"></a> [tls](#requirement\_tls) | n/a |
<!-- END_TF_DOCS -->
