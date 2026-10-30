# folly NetBox

OpenTofu root that applies folly's nodes file, `clusters/folly/inventory/nodes.yaml`, into NetBox on capsule. See [Hardware inventory](https://wiki.lolwtf.ca/reference/inventory/) on the wiki.

For each node it declares the device with its site, role, platform, device type and serial, the address as an IP address on the interface the device type's template makes, that address as the primary IPv4, the cable to the declared switch port, and the declared custom fields. It also declares the node models' device types and interface templates, every custom field on `dcim.device` with its choice sets, and the fleet-controller webhook and its event rule. `nodes.tf` reads the file and `catalog.tf` checks it before the plan reads NetBox.

Terraform creates a device as `planned` and never updates it in place, so the status, `desired_action` and the fields talos-attest and fleet-controller write stay theirs. `restapi_object.declared` sends a node's serial, model, primary IPv4 and declared custom fields as a PATCH of those keys alone, when the node is created or its entry changes. Removing an entry deletes the device, its address and its cable.

`imports.tf` adopts the objects NetBox held before this root.

## Develop

```bash
tofu -chdir=terraform/netbox/folly init -backend=false
tofu -chdir=terraform/netbox/folly validate
TF_DIR=terraform/netbox/folly mise run tf:plan
```

A local plan needs Google credentials for the state bucket, `OP_SERVICE_ACCOUNT_TOKEN`, and a route to capsule's Anchor network address on port 8080. The token is the credential of the 1Password item `netbox-folly-terraform`. `mise run tf:docs` regenerates the tables below.

## Deploy

Atlantis plans this root on a pull request that changes a `.tf` file in it. A change to only `nodes.yaml` or a topology file does not autoplan, so comment `atlantis plan -d terraform/netbox/folly`. Comment `atlantis apply` to apply the plan, and a successful apply merges the pull request. State is in `gs://homelab-ng/terraform/netbox/folly`.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
| ---- | ------- |
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.11 |
| <a name="requirement_netbox"></a> [netbox](#requirement\_netbox) | ~> 5.8 |
| <a name="requirement_onepassword"></a> [onepassword](#requirement\_onepassword) | ~> 3.0 |
| <a name="requirement_restapi"></a> [restapi](#requirement\_restapi) | ~> 3.0 |

## Providers

| Name | Version |
| ---- | ------- |
| <a name="provider_netbox"></a> [netbox](#provider\_netbox) | 5.8.0 |
| <a name="provider_restapi"></a> [restapi](#provider\_restapi) | 3.0.0 |

## Modules

| Name | Source | Version |
| ---- | ------ | ------- |
| <a name="module_anchor_topology"></a> [anchor\_topology](#module\_anchor\_topology) | ../../modules/cluster-topology | n/a |
| <a name="module_topology"></a> [topology](#module\_topology) | ../../modules/cluster-topology | n/a |

## Resources

| Name | Type |
| ---- | ---- |
| [netbox_cable.node](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/cable) | resource |
| [netbox_custom_field.device](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/custom_field) | resource |
| [netbox_custom_field_choice_set.fleet](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/custom_field_choice_set) | resource |
| [netbox_device.node](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/device) | resource |
| [netbox_device_type.node](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/device_type) | resource |
| [netbox_event_rule.fleet_controller](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/event_rule) | resource |
| [netbox_interface_template.node](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/interface_template) | resource |
| [netbox_ip_address.node](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/ip_address) | resource |
| [netbox_webhook.fleet_controller](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/webhook) | resource |
| [restapi_object.datetime_field](https://registry.terraform.io/providers/Mastercard/restapi/latest/docs/resources/object) | resource |
| [restapi_object.declared](https://registry.terraform.io/providers/Mastercard/restapi/latest/docs/resources/object) | resource |
| [netbox_device_interfaces.created](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/data-sources/device_interfaces) | data source |
| [netbox_device_interfaces.existing](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/data-sources/device_interfaces) | data source |
| [netbox_device_interfaces.switch](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/data-sources/device_interfaces) | data source |
| [netbox_device_role.node](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/data-sources/device_role) | data source |
| [netbox_device_role.switch](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/data-sources/device_role) | data source |
| [netbox_devices.nodes](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/data-sources/devices) | data source |
| [netbox_devices.switch](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/data-sources/devices) | data source |
| [netbox_manufacturers.node](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/data-sources/manufacturers) | data source |
| [netbox_platform.talos](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/data-sources/platform) | data source |
| [netbox_site.folly](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/data-sources/site) | data source |

## Inputs

No inputs.

## Outputs

No outputs.
<!-- END_TF_DOCS -->
