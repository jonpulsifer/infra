# metal-dev

OpenTofu root for the metal dev env: one spot Compute Engine VM with nested virtualization in `homelab-ng` that runs `nix/hosts/metal-dev.nix`. See [Metal dev env](https://wiki.lolwtf.ca/platform/metal-dev/) on the wiki.

The root always declares the VPC, the service account and the image. `on = true` adds the disk and the VM, created stopped; `scripts/metal-dev/up.sh` and `down.sh` start and stop it, and the root ignores that state.

The image is named by the bucket object's content hash, so a new upload makes a new image. The disk ignores image changes and has `prevent_destroy`: it holds the dev DevID CA, the swtpm EK CA, the NetBox database, the Talos secrets and every virtual node, and the running system upgrades itself from `main` like every host. Nothing prunes `gs://homelab-ng-free/metal-dev/`; each upload is a multi-GB object, so delete the old ones by hand after a new image lands.

## Start over

1. Snapshot the disk, in case the old state is wanted again: `gcloud compute disks snapshot metal-dev --zone northamerica-northeast1-a --project homelab-ng --snapshot-names metal-dev-$(date +%Y%m%d)`.
2. In a pull request, remove `prevent_destroy` from `google_compute_disk.boot` and change its `name`, or set `on = false`; apply through Atlantis, then put it back.
3. On the new VM, `mise run metal-dev:up` places the DNS-01 token again, and the host requests a new certificate for the enrollment name. Let's Encrypt issues at most five duplicate certificates per name per week; a rebuild loop burns that budget.

## Develop

```bash
tofu -chdir=terraform/metal-dev init -backend=false
tofu -chdir=terraform/metal-dev validate
TF_DIR=terraform/metal-dev mise run tf:plan
```

A local plan impersonates `terraform@homelab-ng.iam.gserviceaccount.com`, so your Google account needs Service Account Token Creator on it. `mise run tf:docs` regenerates the tables below.

## Deploy

Atlantis plans this root on a pull request that changes it. Comment `atlantis apply` to apply the plan, and a successful apply merges the pull request. State is in `gs://homelab-ng/terraform/metal-dev`.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
| ---- | ------- |
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.3.3 |
| <a name="requirement_google"></a> [google](#requirement\_google) | ~> 8.8.0 |
| <a name="requirement_google-beta"></a> [google-beta](#requirement\_google-beta) | ~> 8.8.0 |

## Providers

| Name | Version |
| ---- | ------- |
| <a name="provider_google"></a> [google](#provider\_google) | 8.8.1 |

## Modules

| Name | Source | Version |
| ---- | ------ | ------- |
| <a name="module_network"></a> [network](#module\_network) | ../modules/gce-vpc | n/a |

## Resources

| Name | Type |
| ---- | ---- |
| [google_compute_disk.boot](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_disk) | resource |
| [google_compute_image.nixos](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_image) | resource |
| [google_compute_instance.metal_dev](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_instance) | resource |
| [google_service_account.vm](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/service_account) | resource |
| [google_storage_bucket_object.image](https://registry.terraform.io/providers/hashicorp/google/latest/docs/data-sources/storage_bucket_object) | data source |
| [google_storage_bucket_objects.images](https://registry.terraform.io/providers/hashicorp/google/latest/docs/data-sources/storage_bucket_objects) | data source |

## Inputs

| Name | Description | Type | Default | Required |
| ---- | ----------- | ---- | ------- | :------: |
| <a name="input_disk_gb"></a> [disk\_gb](#input\_disk\_gb) | Boot disk size. The mirrored release images and each virtual node's disk live on it. | `number` | `100` | no |
| <a name="input_machine_type"></a> [machine\_type](#input\_machine\_type) | An Intel machine type that supports nested virtualization. N2 does; E2 and shared-core types do not. | `string` | `"n2-standard-8"` | no |
| <a name="input_on"></a> [on](#input\_on) | Declare the VM and its disk. Off, the root keeps only the network, the service account and the image, which cost nothing. | `bool` | `false` | no |

## Outputs

| Name | Description |
| ---- | ----------- |
| <a name="output_image"></a> [image](#output\_image) | The bucket object the VM image is made from, or null before the first upload. |
| <a name="output_instance"></a> [instance](#output\_instance) | The VM's name and zone, for gcloud, or null while var.on is false. |
<!-- END_TF_DOCS -->
