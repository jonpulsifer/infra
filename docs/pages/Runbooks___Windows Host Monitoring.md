tags:: runbook, monitoring, windows

- Use this when a Windows desktop needs to appear in Grafana, when one has stopped reporting, or when its temperatures, GPU or Event Log are missing from an otherwise healthy host. The machines are `tallboy` and `atomic`.
- Both halves are in git. On the box, `dotfiles/windows/Install-Monitoring.ps1` installs the three agents and `dotfiles/windows/monitoring/` holds their configuration — the same pinned, hash-verified, idempotent shape the rest of the Windows desk uses, see [[Runbooks/Bootstrap a Windows Desk]]. In the cluster, `clusters/folly/monitoring/windows-exporters.yaml` is the scrape and the alerts, `clusters/folly/monitoring/victoria-logs-route.yaml` is the log endpoint, and `terraform/network/unifi/folly/windows-hosts.tf` holds the reservations.
- Change those files, never the live box — see [[Architecture/GitOps]]. Windows has no operator watching git, so "apply" here means re-running the installer; everything it does is idempotent.
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
	- From an elevated PowerShell 7, in the dotfiles checkout:
	- ```powershell
	  .\dotfiles\windows\Install-Monitoring.ps1
	  ```
	- Or as part of a desk bootstrap, which elevates for this stage on its own:
	- ```powershell
	  .\dotfiles\windows\bootstrap.ps1 -WithMonitoring
	  ```
	- Re-running it is how a host takes an update. Each agent is skipped when it is already at the pinned version with the declared configuration, and the OhmGraphite config is rewritten every run because unpacking the release overwrites it with the upstream Graphite default.
	- `-SkipVector` installs the metrics half only. `-LogEndpoint` overrides where Event Log is pushed.
	- ## Why none of this comes from winget
		- `configuration.winget` owns everything else on the desk, and would be the right home for these too, except that each one fails it differently.
		- **windows_exporter** is in the catalogue, but the manifest offers a portable build ahead of the MSI and carries no installer switches. Only the MSI registers the service and opens the firewall. Worse, the collector list has to be an installer property: the MSI writes `--collectors.enabled` onto the service command line, and a CLI flag always beats `config.yaml`, so a host installed without the property is pinned to `[defaults]` and editing that file afterwards changes nothing. Check what a service is actually running with:
		- ```powershell
		  (Get-CimInstance Win32_Service -Filter "Name='windows_exporter'").PathName
		  ```
		- **OhmGraphite** is in neither the catalogue nor the Store.
		- **Vector** ships an MSI with no Windows service in it — a console binary and a config path, and running it is left to you. `vector.exe` never calls `StartServiceCtrlDispatcher`, so `sc.exe create` produces a service the SCM kills with error 1053; the installer registers a startup scheduled task running as SYSTEM instead, which needs no wrapper binary.
		- So all three are pinned by URL and SHA256 and verified before anything executes, the way `Install-NerdFont.ps1` and `Install-VibranceGui.ps1` already handle what winget cannot. Moving a version means changing both the URL and the hash.
	- ## What each agent is configured to do
		- `windows_exporter` runs `[defaults],gpu,cpu_info,diskdrive` on 9182. `thermalzone` is deliberately absent — on a desktop board it is one ACPI number that tracks nothing.
		- OhmGraphite runs as LocalSystem on 4445, which is what lets LibreHardwareMonitor load its kernel driver. Sensors reading zero or missing entirely is almost always the service running as something else. Its metric names are `ohm_<hardwaretype>_<unit>` with `hardware`, `sensor` and `hw_instance` labels, so an NVIDIA card's temperature is `ohm_gpunvidia_celsius{sensor="GPU Core"}` and an AMD one is `ohm_gpuamd_celsius` — which is why the alert rules match on `{__name__=~"ohm_gpu.+_celsius"}`.
		- Vector reads the System and Application channels and pushes to `https://logs.lolwtf.ca/insert`. The endpoint stops at `/insert` on purpose: the `loki` sink appends `/loki/api/v1/push` itself, and spelling the full path posts it twice for a `400 unsupported path`. The route publishes only `/insert`, so an agent can write and nothing on the LAN can query the log store.
		- `read_existing_events` is false, so a fresh agent starts from now rather than replaying the whole log.
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
- # If CPU temperature and board fans are missing but the GPU and drives are fine
	- This is Memory Integrity, not a broken install, and it is the expected state on a current Windows 11 desk. Confirmed on `tallboy` (11 Pro, build 26200) on 2026-09-20.
	- LibreHardwareMonitor reads CPU package temperature over MSRs and SuperIO fan and voltage over LPC port I/O, and both need its ring0 kernel driver. That driver is WinRing0-derived, it is on Microsoft's vulnerable-driver blocklist, and HVCI refuses to load it. The GPU comes from NVML and drive temperatures from the Windows storage APIs, neither of which needs a driver, so those keep working and the failure looks partial rather than total.
	- Check both switches:
	- ```powershell
	  Get-CimInstance -Namespace root\Microsoft\Windows\DeviceGuard -ClassName Win32_DeviceGuard |
	    Select-Object SecurityServicesRunning, VirtualizationBasedSecurityStatus
	  Get-ItemProperty HKLM:\SYSTEM\CurrentControlSet\Control\CI\Config -Name VulnerableDriverBlocklistEnable
	  ```
	- `SecurityServicesRunning` containing `2` is HVCI running. The blocklist value is `1` when on. Either one alone is enough to block the driver.
	- The tell in the metrics is `ohm_cpu_watts` reading a flat `0` while `ohm_cpu_load_percent` is live: load comes from performance counters, package power comes from an MSR. No `ohm_cpu_celsius` series at all, and no `superio` or `motherboard` hardware, is the same symptom.
	- There is no fix that keeps both. Turning Memory Integrity off buys CPU temperature and case-fan RPM at the cost of the protection it provides, on a desktop that also plays games and browses. `WindowsCpuTempHigh` and `WindowsFanStopped` simply never fire on a host in this state — they are written so an absent series is silent rather than wrong.
	- The GPU is unaffected, so `WindowsGpuTempHigh` still covers the part of a gaming desk most likely to cook.
- # If a collector is failing
	- `WindowsCollectorFailing` fires on `windows_exporter_collector_success == 0`. A failing collector returns nothing rather than erroring the scrape, so its metrics simply vanish and every panel and rule built on them goes quiet — this alert is the only thing that notices.
	- The usual cause is a damaged performance-counter registry. From an elevated prompt:
	- ```powershell
	  lodctr /R
	  Restart-Service windows_exporter
	  ```
- # Why there is no "host is down" alert
	- These are desktops. Powering one off overnight is the normal case, and an alert that fires every night is an alert nobody reads. Every rule in `windows-exporters.yaml` is written to state something while the machine is up and to resolve on its own when it goes away. If a host is meant to be always-on, that is a property worth declaring before adding an alert that assumes it.
