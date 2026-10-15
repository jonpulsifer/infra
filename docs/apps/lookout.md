---
title: Lookout
description: A Windows app, installed from an MSI, whose service keeps the monitoring agents on a Windows desktop at the versions git declares and reports its own health to folly. No desktop runs it yet.
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

The MSI, built by WiX from `apps/lookout/packaging/Lookout.wxs`, holds two programs. The tray is the app in Settings and the Start menu, and starts at logon through the `Run` key the installer writes. The service runs as LocalSystem. The Start menu shortcut carries the AppUserModelID `lolwtf.Lookout`, which is what lets the tray show notifications without package identity; when that fails, the tray icon's balloon tip is the notification.

The agent updates itself. When the policy's `agent` entry names a version other than the running one, the service downloads that MSI, checks its SHA256 and starts msiexec without waiting. The installer stops the service, replaces the files and starts it again.

## Limits

- The MSI is unsigned, so SmartScreen asks once on a downloaded copy. Choose **More info**, then **Run anyway**.
- No release exists until the first push to `main` after this page, and the policy has no `agent` entry until the owner adds one, so no desktop upgrades itself yet.
- Clicking a notification opens nothing. An unpackaged app needs a COM activator for that, and the tray has none.
- Memory Integrity still blocks the sensor driver. See [Check Memory Integrity](../runbooks/install-windows-monitoring.md#check-memory-integrity).
- Nothing has run on a desktop. The first install must confirm that the tray reaches the pipe, that notifications appear, and that `windows_exporter` reads the textfile.

## Operate

folly alerts in `clusters/folly/monitoring/windows-exporters.yaml`:

| Alert | Fires when |
| --- | --- |
| `LookoutStale` | The service has not finished a pass in 2 days |
| `LookoutComponentDrifted` | An agent has not matched the policy for 6 hours |
| `LookoutComponentUnhealthy` | An agent is not running for 30 minutes; the only alert that sees Vector stop |

To change an agent version, edit `policy.json` and merge. Every desktop converges on its next pass. To test a policy before merging, put its raw URL in `policyUrl` in `C:\ProgramData\Lookout\settings.json` and restart the `Lookout` service.

To roll out a new Lookout, raise `Version` in `apps/lookout/Directory.Build.props` and merge. The `lookout` workflow publishes the GitHub release `lookout-v<version>` with the MSI and its SHA256 in the notes. Then put that version, the asset URL and the hash in the `agent` entry of `policy.json` and merge again.

## Reference

- Source: `apps/lookout/`
- Policy: `apps/lookout/policy/policy.json`
- Tests and build: `mise run lookout:test`; the MSI builds and releases in `.github/workflows/lookout.yml`
- Releases: `lookout-v<version>` on the repository's releases page
- Grafana: the Windows Desktops dashboard, `clusters/folly/monitoring/grafana-dashboards/windows.json`
