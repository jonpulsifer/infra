tags:: runbook, unifi, network

- Use this for read-only inspection of the live UniFi network before changing Terraform desired state. Desired state still lives under `terraform/network/unifi/`; changes apply through Atlantis. See [[Runbooks/Terraform Change]].
- # Rule
	- Inspect live state only. Do not add write operations to the inspection helper and do not mutate the controller manually.
- # Start with a summary
	- From the repo root:
	- ```bash
	  D=.agents/skills/unifi-network/unifi.sh
	  $D summary
	  ```
	- The summary should show controller info, subsystem health, networks/VLANs, WLANs, and adopted devices.
- # Common reads
	- Networks and VLANs:
	- ```bash
	  $D networks
	  ```
	- Adopted devices:
	- ```bash
	  $D devices
	  ```
	- WLANs:
	- ```bash
	  $D wlans
	  ```
	- Active and known clients:
	- ```bash
	  $D clients
	  $D clients-known
	  ```
	- Find a device, IP, MAC, hostname, or SSID:
	- ```bash
	  $D find <term>
	  ```
- # If the helper cannot authenticate
	- Confirm the expected CLI tools are available:
	- ```bash
	  command -v op curl jq
	  ```
	- Confirm the environment has access to the required 1Password service account. Do not paste or commit credential lookup commands or revealed values.
	- Confirm controller reachability:
	- ```bash
	  curl -sk -o /dev/null -w '%{http_code}\n' https://unifi.fml.pulsifer.ca
	  ```
	- Expected HTTP status is `200`.
- # If results look stale
	- The helper caches the controller session in the local temp directory. Remove the cache and retry:
	- ```bash
	  rm -f "${TMPDIR:-/tmp}/.unifi-cookies-$(id -u)" "${TMPDIR:-/tmp}/.unifi-csrf-$(id -u)"
	  $D summary
	  ```
- # For BGP and routes
	- Prefer helper subcommands first:
	- ```bash
	  $D routes
	  $D bgp
	  ```
	- Use on-box SSH only for data the API cannot expose, and keep any credential handling out of public docs.
- # Reconcile with Terraform
	- Compare observed live state to:
		- `terraform/network/unifi/folly/`
		- `terraform/network/unifi/offsite/`
	- Author the desired change in Terraform and use [[Runbooks/Terraform Change]].
