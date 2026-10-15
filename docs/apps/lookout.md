---
title: Lookout
description: A Windows app, installed as an MSIX, whose service keeps the monitoring agents on a Windows desktop at the versions git declares and reports its own health to folly. No desktop runs it yet.
status: unverified
---

Lookout is the lab's monitoring agent for a Windows desktop such as [tallboy](../hosts/tallboy.md). Its service installs `windows_exporter`, OhmGraphite and Vector, the three agents [Install Windows monitoring](../runbooks/install-windows-monitoring.md) describes, and keeps them at the versions and configuration that `apps/lookout/policy/policy.json` declares. A tray icon shows the state. No desktop runs it: the first install on tallboy decides the open questions under [Limits](#limits).

## Use it

| Surface | What it does |
| --- | --- |
| Tray icon | Green when every agent is current and answering, amber on drift, a failed sync or a pending reboot, red when an agent is down, grey when the service does not answer |
| Tray menu | Sync now, pause convergence for an hour, open this desktop's Grafana board, the Event Viewer or `status.json` |
| Notifications | One toast each time the state changes |
| `C:\ProgramData\Lookout\status.json` | The last report, for a script |

The service converges on a schedule from the policy, and at once on **Sync now**. A pause holds the schedule only. **Sync now** converges through a pause.

## How it works

The policy is git. `apps/lookout/policy/policy.json` names each agent's version, download URL, SHA256 and, for OhmGraphite and Vector, the URL of its config file in `dotfiles/windows/monitoring/`. The service fetches the policy from `main` on every pass and keeps the last copy in `C:\ProgramData\Lookout\`, so a desktop that is offline converges to the policy it last saw.

Each pass observes the three agents, converges the ones that drifted, then observes again:

| Agent | Drift means | Convergence |
| --- | --- | --- |
| `windows_exporter` | Another version, or other collectors on the service command line | Reinstall the MSI with the declared collectors; a flag on the command line beats `config.yaml` |
| OhmGraphite | Another version, a different config, or no firewall rule | Unpack the zip, rewrite the config, register and restart the service, open the port |
| Vector | Another version, a different config, or no scheduled task | Remove the old product, install the MSI, write the config, register and start the SYSTEM task at boot |

The service writes `lookout.prom` into `windows_exporter`'s `textfile_inputs` directory, so folly scrapes the agent's own state with the host's metrics, and logs to the Application event log under source `Lookout`, which Vector ships to VictoriaLogs. The tray and the service talk over the named pipe `lookout`.

The package holds two programs. The tray is the app, and starts at logon through the package's startup task. The service is a packaged Windows service running as LocalSystem, which the manifest declares with the `packagedServices` and `localSystemServices` capabilities.

## Limits

- Only a signed package installs. `apps/lookout/packaging/Build-Package.ps1` signs when it is given the certificate, and the CI workflow signs when the `LOOKOUT_SIGNING_PFX` and `LOOKOUT_SIGNING_PASSWORD` secrets exist. No secret exists, so the CI artifact is unsigned.
- The certificate's subject must be `CN=lolwtf.ca`, the Publisher in `apps/lookout/packaging/AppxManifest.xml`, and each desktop must trust it once.
- No `.appinstaller` is hosted, so the package does not update itself.
- Memory Integrity still blocks the sensor driver. See [Check Memory Integrity](../runbooks/install-windows-monitoring.md#check-memory-integrity).
- Nothing has run on a desktop. The first install must confirm that Windows registers the service from a sideloaded package, that the tray reaches the pipe, that toasts appear, and that `windows_exporter` reads the textfile.

## Operate

folly alerts in `clusters/folly/monitoring/windows-exporters.yaml`:

| Alert | Fires when |
| --- | --- |
| `LookoutStale` | The service has not finished a pass in 2 days |
| `LookoutComponentDrifted` | An agent has not matched the policy for 6 hours |
| `LookoutComponentUnhealthy` | An agent is not running for 30 minutes; the only alert that sees Vector stop |

To change an agent version, edit `policy.json` and merge. Every desktop converges on its next pass. To test a policy before merging, put its raw URL in `policyUrl` in `C:\ProgramData\Lookout\settings.json` and restart the `Lookout` service.

## Reference

- Source: `apps/lookout/`
- Policy: `apps/lookout/policy/policy.json`
- Tests and build: `mise run lookout:test`; the package builds in `.github/workflows/lookout.yml`
- Grafana: the Windows Desktops dashboard, `clusters/folly/monitoring/grafana-dashboards/windows.json`
