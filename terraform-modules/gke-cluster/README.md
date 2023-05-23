<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.1.9 |
| <a name="requirement_google"></a> [google](#requirement\_google) | ~> 4.66.0 |
| <a name="requirement_google-beta"></a> [google-beta](#requirement\_google-beta) | ~> 4.65.0 |

## Providers

| Name | Version |
|------|---------|
| <a name="provider_google"></a> [google](#provider\_google) | 4.66.0 |
| <a name="provider_google-beta"></a> [google-beta](#provider\_google-beta) | 4.65.2 |

## Modules

No modules.

## Resources

| Name | Type |
|------|------|
| [google-beta_google_container_cluster.lab](https://registry.terraform.io/providers/hashicorp/google-beta/latest/docs/resources/google_container_cluster) | resource |
| [google_compute_firewall.ssh-to-gke-nodes](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_firewall) | resource |
| [google_compute_network.gke](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_network) | resource |
| [google_compute_router.gke_nodes](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_router) | resource |
| [google_compute_router_nat.gke_nodes](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_router_nat) | resource |
| [google_compute_subnetwork.nodes](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_subnetwork) | resource |
| [google_kms_crypto_key.gke](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/kms_crypto_key) | resource |
| [google_kms_key_ring.gke](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/kms_key_ring) | resource |
| [google_kms_key_ring_iam_member.gke](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/kms_key_ring_iam_member) | resource |
| [google_project_service.container](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/project_service) | resource |
| [google_project_service.containerregistry](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/project_service) | resource |
| [google_project_service.deploymentmanager](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/project_service) | resource |
| [google_project_service.replicapool](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/project_service) | resource |
| [google_project_service.replicapoolupdater](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/project_service) | resource |
| [google_project_service.resourceviews](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/project_service) | resource |
| [google_service_account.nodes](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/service_account) | resource |
| [google_project.current](https://registry.terraform.io/providers/hashicorp/google/latest/docs/data-sources/project) | data source |

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| <a name="input_binary_authorization"></a> [binary\_authorization](#input\_binary\_authorization) | Enable Binary Authorization | `bool` | `true` | no |
| <a name="input_cloudrun"></a> [cloudrun](#input\_cloudrun) | Enable Cloud Run on GKE (requires istio) | `bool` | `false` | no |
| <a name="input_google_cloud_load_balancer"></a> [google\_cloud\_load\_balancer](#input\_google\_cloud\_load\_balancer) | Enable Google Cloud Load Balancer | `bool` | `false` | no |
| <a name="input_hpa"></a> [hpa](#input\_hpa) | Enable Horizontal Pod Autoscaling | `bool` | `false` | no |
| <a name="input_istio"></a> [istio](#input\_istio) | Enable Istio | `bool` | `false` | no |
| <a name="input_istio_strict_mtls"></a> [istio\_strict\_mtls](#input\_istio\_strict\_mtls) | Istio MTLS behavior: MTLS\_PERMISSIVE or MTLS\_STRICT | `string` | `"MTLS_STRICT"` | no |
| <a name="input_kms_key_ring"></a> [kms\_key\_ring](#input\_kms\_key\_ring) | Name of the KMS key ring used to encrypt etcd | `string` | `null` | no |
| <a name="input_kubernetes_version"></a> [kubernetes\_version](#input\_kubernetes\_version) | Default Kubernetes version for the master | `string` | `"1.11.6-gke.6"` | no |
| <a name="input_labels"></a> [labels](#input\_labels) | List of Kubernetes labels to apply to the nodes | `map` | `{}` | no |
| <a name="input_location"></a> [location](#input\_location) | Location of the cluster (region or zone) | `string` | n/a | yes |
| <a name="input_logging_service"></a> [logging\_service](#input\_logging\_service) | Logging Service for the cluster, one of logging.googleapis.com, logging.googleapis.com/kubernetes, or none | `string` | `"logging.googleapis.com/kubernetes"` | no |
| <a name="input_master_authorized_networks"></a> [master\_authorized\_networks](#input\_master\_authorized\_networks) | Map of cidrs that can access the master network | `map` | `{}` | no |
| <a name="input_monitoring_service"></a> [monitoring\_service](#input\_monitoring\_service) | Monitoring Service for the cluster, one of monitoring.googleapis.com/kubernetes, or none | `string` | `"monitoring.googleapis.com/kubernetes"` | no |
| <a name="input_name"></a> [name](#input\_name) | Prefix of the cluster resources | `string` | `"lab"` | no |
| <a name="input_network_config"></a> [network\_config](#input\_network\_config) | VPC network configuration for the cluster | `map` | <pre>{<br>  "enable_natgw": false,<br>  "enable_ssh": false,<br>  "master_cidr": "10.20.30.0/28",<br>  "node_cidr": "10.0.0.0/24",<br>  "pod_cidr": "10.2.0.0/24",<br>  "private_master": true,<br>  "private_nodes": true,<br>  "service_cidr": "10.1.0.0/24"<br>}</pre> | no |
| <a name="input_network_policy"></a> [network\_policy](#input\_network\_policy) | Enable Network Policy | `bool` | `true` | no |
| <a name="input_pod_security_policy"></a> [pod\_security\_policy](#input\_pod\_security\_policy) | Enable Pod Security Policy | `bool` | `true` | no |
| <a name="input_project"></a> [project](#input\_project) | The GCP project to use | `string` | n/a | yes |
| <a name="input_rbac_group_domain"></a> [rbac\_group\_domain](#input\_rbac\_group\_domain) | Google Groups for RBAC requires a G Suite domain | `string` | `"pulsifer.ca"` | no |
| <a name="input_release_channel"></a> [release\_channel](#input\_release\_channel) | Release cadence of the GKE cluster | `string` | `"RAPID"` | no |
| <a name="input_shielded_nodes"></a> [shielded\_nodes](#input\_shielded\_nodes) | Forces node pools to use shielded (uefi) images | `bool` | `true` | no |

## Outputs

| Name | Description |
|------|-------------|
| <a name="output_name"></a> [name](#output\_name) | n/a |
| <a name="output_network"></a> [network](#output\_network) | n/a |
| <a name="output_node_service_account"></a> [node\_service\_account](#output\_node\_service\_account) | n/a |
| <a name="output_subnetwork"></a> [subnetwork](#output\_subnetwork) | n/a |
| <a name="output_version"></a> [version](#output\_version) | n/a |
<!-- END_TF_DOCS -->