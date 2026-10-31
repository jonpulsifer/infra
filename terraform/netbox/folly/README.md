# Lab NetBox

OpenTofu root for the lab at folly and oldschool (the `offsite` cluster). It applies folly's nodes file, `clusters/folly/inventory/nodes.yaml`, into NetBox on capsule. See [Hardware inventory](https://wiki.lolwtf.ca/reference/inventory/) on the wiki.

For each node it declares the device with its site, role, platform, device type and serial, the address as an IP address on the interface the device type's template makes, that address as the primary IPv4, the cable to the declared switch port, and the declared custom fields. It also declares the node models' device types and interface templates, every custom field on `dcim.device` with its choice sets, and the fleet-controller webhook and its event rule. `nodes.tf` reads the file and `catalog.tf` checks it before the plan reads NetBox, among other things that no two nodes share a serial or approve the same EK and that every approved EK hash is 64 lowercase hex characters. `tofu test` runs `inventory.tftest.hcl`, which plans the fixtures in `testdata/` against mocked providers.

Terraform creates a device as `planned` and never updates it in place, so the status, `desired_action` and the fields talos-attest and fleet-controller write stay theirs. `restapi_object.declared` sends a node's serial, model, primary IPv4 and declared custom fields as a PATCH of those keys alone, when the node is created or its entry changes. Its approved EK binding goes to `approved_ek_hash` and `approved_ek_hash_ecc`, null when the entry has none; fleetd alone writes the observed `ek_hash` and `ek_hash_ecc`. Removing an entry deletes the device, its address and its cable.

`lab-inventory.json` declares the additional physical hosts and network equipment. MACs and reserved addresses reference UniFi clients and the topology files where those sources exist. Controller-only equipment records its observed base MAC on a management interface; DHCP addresses, wireless links, unverified rack unit positions and cables stay unset. Devices with a confirmed `rack` in the inventory receive that rack association through a separate PATCH; their descriptions record shelf and stack order. `cabling.tf` traces oldschool’s node links through panel ports 8–10, and the gateway uplink through port 12. Port 11 is blank. Rear termination types remain unverified. Status is set on creation and then belongs to the owner. Declared metadata updates use PATCH without custom fields or rack placement.

`sites.tf` declares the oldschool site and both racks. `rack-components.json` records their current shelves, panels, power units and elevations; `rack-components.tf` checks unit bounds and overlap. The oldschool compute shelf and stack occupy U1–U3 as one assembly. Shelf contents retain zero-unit device records and descriptions. Folly’s gateway and switch occupy U12 and U10, and the OptiPlex sits on U6. `networks.tf` reads each UniFi `network-catalog.json` and the topology files for VLANs and missing prefixes. Existing folly seed objects remain in NetBox.

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
| <a name="requirement_random"></a> [random](#requirement\_random) | ~> 3.7 |
| <a name="requirement_restapi"></a> [restapi](#requirement\_restapi) | ~> 3.0 |

## Providers

| Name | Version |
| ---- | ------- |
| <a name="provider_netbox"></a> [netbox](#provider\_netbox) | 5.8.0 |
| <a name="provider_random"></a> [random](#provider\_random) | 3.9.1 |
| <a name="provider_restapi"></a> [restapi](#provider\_restapi) | 3.0.0 |

## Modules

| Name | Source | Version |
| ---- | ------ | ------- |
| <a name="module_anchor_topology"></a> [anchor\_topology](#module\_anchor\_topology) | ../../modules/cluster-topology | n/a |
| <a name="module_oldschool_topology"></a> [oldschool\_topology](#module\_oldschool\_topology) | ../../modules/cluster-topology | n/a |
| <a name="module_topology"></a> [topology](#module\_topology) | ../../modules/cluster-topology | n/a |

## Resources

| Name | Type |
| ---- | ---- |
| [netbox_cable.node](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/cable) | resource |
| [netbox_cable.oldschool_node](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/cable) | resource |
| [netbox_cable.oldschool_patch_switch](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/cable) | resource |
| [netbox_cable.oldschool_uplink_gateway](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/cable) | resource |
| [netbox_cable.oldschool_uplink_switch](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/cable) | resource |
| [netbox_custom_field.device](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/custom_field) | resource |
| [netbox_custom_field_choice_set.fleet](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/custom_field_choice_set) | resource |
| [netbox_device.lab](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/device) | resource |
| [netbox_device.node](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/device) | resource |
| [netbox_device.rack_component](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/device) | resource |
| [netbox_device_front_port.oldschool](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/device_front_port) | resource |
| [netbox_device_interface.lab](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/device_interface) | resource |
| [netbox_device_interface.lab_wifi](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/device_interface) | resource |
| [netbox_device_interface.oldschool_gateway_lan](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/device_interface) | resource |
| [netbox_device_interface.oldschool_node_port](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/device_interface) | resource |
| [netbox_device_interface.oldschool_switch_uplink](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/device_interface) | resource |
| [netbox_device_primary_ip.lab](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/device_primary_ip) | resource |
| [netbox_device_rear_port.oldschool](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/device_rear_port) | resource |
| [netbox_device_role.lab](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/device_role) | resource |
| [netbox_device_role.rack_component](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/device_role) | resource |
| [netbox_device_type.lab](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/device_type) | resource |
| [netbox_device_type.node](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/device_type) | resource |
| [netbox_device_type.rack_component](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/device_type) | resource |
| [netbox_event_rule.fleet_controller](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/event_rule) | resource |
| [netbox_interface_template.node](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/interface_template) | resource |
| [netbox_ip_address.lab](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/ip_address) | resource |
| [netbox_ip_address.lab_wifi](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/ip_address) | resource |
| [netbox_ip_address.node](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/ip_address) | resource |
| [netbox_mac_address.lab](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/mac_address) | resource |
| [netbox_mac_address.lab_wifi](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/mac_address) | resource |
| [netbox_manufacturer.lab](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/manufacturer) | resource |
| [netbox_permission.fleetd_add](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/permission) | resource |
| [netbox_permission.fleetd_change](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/permission) | resource |
| [netbox_permission.fleetd_read](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/permission) | resource |
| [netbox_permission.terraform_manage](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/permission) | resource |
| [netbox_permission.terraform_read](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/permission) | resource |
| [netbox_platform.lab](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/platform) | resource |
| [netbox_prefix.lab](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/prefix) | resource |
| [netbox_rack.lab](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/rack) | resource |
| [netbox_site.oldschool](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/site) | resource |
| [netbox_user.fleetd](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/user) | resource |
| [netbox_user.terraform](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/user) | resource |
| [netbox_vlan.lab](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/vlan) | resource |
| [netbox_webhook.fleet_controller](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/resources/webhook) | resource |
| [random_password.netbox_user](https://registry.terraform.io/providers/hashicorp/random/latest/docs/resources/password) | resource |
| [restapi_object.datetime_field](https://registry.terraform.io/providers/Mastercard/restapi/latest/docs/resources/object) | resource |
| [restapi_object.declared](https://registry.terraform.io/providers/Mastercard/restapi/latest/docs/resources/object) | resource |
| [restapi_object.lab_declared](https://registry.terraform.io/providers/Mastercard/restapi/latest/docs/resources/object) | resource |
| [restapi_object.lab_rack](https://registry.terraform.io/providers/Mastercard/restapi/latest/docs/resources/object) | resource |
| [restapi_object.mounted_device](https://registry.terraform.io/providers/Mastercard/restapi/latest/docs/resources/object) | resource |
| [restapi_object.mounted_type](https://registry.terraform.io/providers/Mastercard/restapi/latest/docs/resources/object) | resource |
| [restapi_object.rack_anchor](https://registry.terraform.io/providers/Mastercard/restapi/latest/docs/resources/object) | resource |
| [restapi_object.shelved_node](https://registry.terraform.io/providers/Mastercard/restapi/latest/docs/resources/object) | resource |
| [netbox_device_interfaces.created](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/data-sources/device_interfaces) | data source |
| [netbox_device_interfaces.existing](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/data-sources/device_interfaces) | data source |
| [netbox_device_interfaces.switch](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/data-sources/device_interfaces) | data source |
| [netbox_device_role.anchor](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/data-sources/device_role) | data source |
| [netbox_device_role.gateway](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/data-sources/device_role) | data source |
| [netbox_device_role.node](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/data-sources/device_role) | data source |
| [netbox_device_role.switch](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/data-sources/device_role) | data source |
| [netbox_device_type.lab](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/data-sources/device_type) | data source |
| [netbox_device_type.mounted_switch](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/data-sources/device_type) | data source |
| [netbox_devices.anchors](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/data-sources/devices) | data source |
| [netbox_devices.nodes](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/data-sources/devices) | data source |
| [netbox_devices.switch](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/data-sources/devices) | data source |
| [netbox_manufacturers.lab](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/data-sources/manufacturers) | data source |
| [netbox_manufacturers.node](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/data-sources/manufacturers) | data source |
| [netbox_platform.lab](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/data-sources/platform) | data source |
| [netbox_platform.talos](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/data-sources/platform) | data source |
| [netbox_site.folly](https://registry.terraform.io/providers/e-breuninger/netbox/latest/docs/data-sources/site) | data source |

## Inputs

| Name | Description | Type | Default | Required |
| ---- | ----------- | ---- | ------- | :------: |
| <a name="input_nodes_file"></a> [nodes\_file](#input\_nodes\_file) | The nodes file, relative to this root. Only a test names another. | `string` | `"../../../clusters/folly/inventory/nodes.yaml"` | no |

## Outputs

No outputs.
<!-- END_TF_DOCS -->
