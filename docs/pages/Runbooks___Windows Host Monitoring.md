tags:: runbook, monitoring, windows

- Use this when a Windows desktop needs to appear in Grafana, when one has stopped reporting, or when its temperatures, GPU or Event Log are missing from an otherwise healthy host. The machines are `tallboy` and `atomic`. They are the only hosts in the fleet with no declarative layer at all — no [[Architecture/NixOS]] closure, no Flux — so every agent on them is installed by hand and this page is the record of what "installed correctly" means.
- The cluster half *is* declared: `clusters/folly/monitoring/windows-exporters.yaml` for the scrape and the alerts, `clusters/folly/monitoring/victoria-logs-route.yaml` for the log endpoint, `terraform/network/unifi/folly/windows-hosts.tf` for the DHCP reservations. Change those in git, never on the box — see [[Architecture/GitOps]].
- # Quick checks
	- Is the host being scraped at all? From any lab host, which shares the Lab firewall zone with the cluster:
	- ```bash
	  ssh spore.lolwtf.ca 'curl -s -o /dev/null -w "%{http_code}\n" http://10.13.37.2:9182/metrics'
	  ```
	- Expected `200`. A `000` from a desktop usually means the desktop is off, which is normal and deliberately raises no alert.
	- Which collectors are alive on a host, and which are silently returning nothing:
	- ```bash
	  ssh spore.lolwtf.ca 'curl -s http://10.13.37.2:9182/metrics' | grep windows_exporter_collector_success
	  ```
	- Sensors are a second service on its own port. Temperatures missing while CPU and disk are fine means this one, not the exporter:
	- ```bash
	  ssh spore.lolwtf.ca 'curl -s http://10.13.37.2:4445/metrics' | grep -c '^ohm_'
	  ```
	- Event Log lines land in VictoriaLogs. In Grafana, pick the **VictoriaLogs** datasource and query `{job="windows-eventlog"}`.
	- Do not test reachability from WSL. A WSL distro in mirrored networking mode cannot open a connection to its own host's LAN address, so `curl http://10.13.37.2:9182` fails there while the host answers every other machine on the network perfectly. `curl http://127.0.0.1:9182` from WSL does reach it, which makes the mirrored-mode failure look like a firewall problem when it is not.
- # What runs on a Windows host
	- | Agent | Port | Supplies |
	  | --- | --- | --- |
	  | `windows_exporter` | 9182 | CPU, memory, volumes, NICs, services, uptime, GPU utilisation and VRAM |
	  | OhmGraphite | 4445 | every motherboard, CPU, GPU and drive sensor — temperatures, fan RPM, power, voltages, clocks |
	  | Vector | — | Windows Event Log, pushed to VictoriaLogs |
	- The split between the first two is not redundancy. `windows_exporter`'s `gpu` collector reads Windows performance counters, which carry utilisation and memory but no temperature, power or clock; and its `thermalzone` collector reads ACPI zones, which on a desktop board is a single number that tracks nothing you care about. Real sensors need a kernel driver, which is what LibreHardwareMonitor provides and OhmGraphite exposes.
	- Vector rather than an OpenTelemetry collector because the cluster already ships every other log with Vector over the Loki push protocol into VictoriaLogs (`clusters/base/monitoring/vector.yaml`); a Windows agent using the same source-and-sink shape lands in the same store with the same stream labels.
- # Install on a new host
	- ## windows_exporter
		- Download the current `.msi` from the [releases page](https://github.com/prometheus-community/windows_exporter/releases) and install it from an **elevated** PowerShell. The `--%` is required — it stops PowerShell from eating the installer properties.
		- ```powershell
		  msiexec /i .\windows_exporter-0.31.8-amd64.msi --% ADDLOCAL=FirewallException ENABLED_COLLECTORS="[defaults],gpu,cpu_info,diskdrive"
		  ```
		- `ADDLOCAL=FirewallException` is what opens inbound 9182 in Windows Defender Firewall. Without it the service listens and nothing can reach it.
		- `[defaults]` expands to the usual set (`cpu`, `logical_disk`, `memory`, `net`, `os`, `physical_disk`, `service`, `system`); the rest add GPU counters, CPU model information and per-drive health.
		- **Installer properties beat the config file.** The MSI writes the collector list onto the service's command line, and a CLI flag always wins over `config.yaml`. Editing `C:\Program Files\windows_exporter\config.yaml` on a host that was installed with `ENABLED_COLLECTORS` changes nothing — check what the service is actually running with:
		- ```powershell
		  (Get-CimInstance Win32_Service -Filter "Name='windows_exporter'").PathName
		  ```
		- A host installed with no properties shows `--collectors.enabled [defaults]`, and the only ways to change it are to re-run the MSI with the property set, or to rewrite the service's `ImagePath`.
	- ## OhmGraphite
		- Download the release from [OhmGraphite](https://github.com/nickbabcock/OhmGraphite/releases), unpack it somewhere permanent, and point it at Prometheus mode in `OhmGraphite.exe.config`:
		- ```xml
		  <add key="type" value="prometheus" />
		  <add key="prometheus_host" value="*" />
		  <add key="prometheus_port" value="4445" />
		  ```
		- Then register and start it from an elevated PowerShell, and open the port — OhmGraphite does not create its own firewall rule:
		- ```powershell
		  .\OhmGraphite.exe install
		  New-NetFirewallRule -DisplayName "OhmGraphite" -Direction Inbound -Protocol TCP -LocalPort 4445 -Action Allow
		  ```
		- It needs to run as LocalSystem to load the LibreHardwareMonitor driver. Sensors read as zero or missing entirely is almost always the service running as something else.
		- Metric names are `ohm_<hardwaretype>_<unit>` with `hardware`, `sensor` and `hw_instance` labels, so an NVIDIA card's temperature is `ohm_gpunvidia_celsius{sensor="GPU Core"}` and an AMD one is `ohm_gpuamd_celsius`. The alert rules match on `{__name__=~"ohm_gpu.+_celsius"}` for exactly that reason.
	- ## Vector
		- Install Vector for Windows per [its install page](https://vector.dev/docs/setup/installation/operating-systems/windows/), then write `C:\ProgramData\vector\vector.yaml`:
		- ```yaml
		  data_dir: C:\ProgramData\vector

		  sources:
		    windows_events:
		      type: windows_event_log
		      channels: [System, Application]

		  transforms:
		    identify:
		      type: remap
		      inputs: [windows_events]
		      source: |
		        .host = get_hostname!()

		  sinks:
		    victoria_logs:
		      type: loki
		      inputs: [identify]
		      endpoint: https://logs.lolwtf.ca/insert
		      tenant_id: "1"
		      encoding:
		        codec: json
		      dangerously_allow_unconfined_template_resolution: true
		      labels:
		        job: windows-eventlog
		        host: "{{ host }}"
		        channel: "{{ channel }}"
		        level: "{{ level }}"
		  ```
		- The endpoint stops at `/insert` on purpose. Vector's `loki` sink appends `/loki/api/v1/push` itself; spelling the full path here posts it twice and VictoriaLogs answers `400 unsupported path`. This is the same trap the in-cluster agent's config calls out.
		- `read_existing_events` defaults to false, so a fresh agent starts from now rather than replaying the whole log. Set it true once if you want the backlog.
		- The route only publishes `/insert`. Reads stay inside the cluster, so Vector can write but nothing on the LAN can query the log store.
- # If a host is missing from Grafana entirely
	- Confirm the reservation still holds. The addresses live in `clusters/folly/config/lab-topology.json` and are reserved by `terraform/network/unifi/folly/windows-hosts.tf`; the EndpointSlice substitutes the same values, so the two cannot disagree without failing a plan. Check what the controller currently believes with [[Runbooks/Inspect UniFi Network]]:
	- ```bash
	  .agents/skills/unifi-network/unifi.sh find tallboy
	  ```
	- `future` (VLAN 1337) hands out its entire usable range by DHCP, so a host there with no reservation will eventually move and take the scrape target with it.
	- Confirm the zone path. `terraform/network/unifi/folly/firewall.tf` allows Lab → Internal on 9182 and 4445; Management and `future` are Internal networks, Lab Net and Kubernetes are the Lab zone. A host moved onto a different VLAN loses the path.
	- Then check Prometheus has the target: **Status → Targets**, job `windows-exporter`.
- # If temperatures or fans are missing
	- The sensor rules only fire on series that exist, so a host without OhmGraphite is silent rather than alarming. Check the port answers and that `ohm_` series are present (see Quick checks).
	- A GPU that reports utilisation but no temperature is the expected split: utilisation comes from `windows_exporter`'s `gpu` collector, temperature from OhmGraphite. Missing temperature means OhmGraphite, missing utilisation means the `gpu` collector was never enabled.
- # If a collector is failing
	- `WindowsCollectorFailing` fires on `windows_exporter_collector_success == 0`. A failing collector returns nothing rather than erroring the scrape, so its metrics simply vanish and every panel and rule built on them goes quiet — this alert is the only thing that notices.
	- The usual cause is a damaged performance-counter registry. From an elevated prompt:
	- ```powershell
	  lodctr /R
	  Restart-Service windows_exporter
	  ```
- # Why there is no "host is down" alert
	- These are desktops. Powering one off overnight is the normal case, and an alert that fires every night is an alert nobody reads. Every rule in `windows-exporters.yaml` is written to state something while the machine is up and to resolve on its own when it goes away. If a host is meant to be always-on, that is a property worth declaring before adding an alert that assumes it.
