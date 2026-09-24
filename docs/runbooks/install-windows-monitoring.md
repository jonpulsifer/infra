---
title: Install Windows monitoring
description: Add a Windows desktop to folly's Prometheus, install or update its monitoring agents, and find why it stopped reporting.
---

Use this runbook to make a Windows desktop report to folly's Prometheus and VictoriaLogs, to update its agents, or to find why it stopped reporting. `dotfiles/windows/Install-Monitoring.ps1` installs three agents from downloads pinned by SHA256.

## Before you start

- You need an administrator account on the desktop, and its checkout from [Install a Windows desktop](install-a-windows-desktop.md).
- You need a full checkout on a Linux machine, such as the WSL distro, and SSH access to a lab host, such as [spore](../hosts/spore.md).
- The desktop must be on a network in the [Internal firewall zone](../platform/network/routing-and-firewall.md), such as Management or `future`.

`<host>` is the desktop name. `<HOST>` is `<host>` in upper case, and `<HOST>_IP` is its key in `clusters/folly/config/lab-topology.json`.

| Agent | Port | Supplies | Runs as |
| --- | --- | --- | --- |
| `windows_exporter` | 9182 | System metrics and GPU load | Service |
| OhmGraphite | 4445 | Sensors, from LibreHardwareMonitor | Service, as LocalSystem |
| Vector | None | System and Application event logs | Scheduled task, as LocalSystem |

## Add a desktop to Prometheus

1. Under `desktops` in `terraform/network/unifi/folly/clients.yaml`, add `<host>` with its `mac` and its `ip`, the host part of its address.
2. Add `<HOST>_IP` to `clusters/folly/config/lab-topology.json`.
3. Add `<host>` to `local.windows_hosts` in `terraform/network/unifi/folly/windows-hosts.tf`. If the desktop is on `future`, copy the `tallboy` entry. If it is on Management, copy the `atomic` entry.
4. Add an endpoint with `${<HOST>_IP}` and `nodeName: <host>` to the EndpointSlice in `clusters/folly/monitoring/windows-exporters.yaml`.
5. Apply the change through a pull request. See [Apply an OpenTofu change](apply-an-opentofu-change.md).

   Result: The Atlantis plan creates `unifi_client.windows_hosts["<host>"]`.

## Install or update the agents

1. On the desktop, open PowerShell 7 as administrator.
2. Go to the checkout.

   ```powershell
   cd $HOME\src\github.com\jonpulsifer\infra
   ```

3. Pull `main`.

   ```powershell
   git pull --ff-only
   ```

   Result: `Already up to date.`, or the changed files.

4. Run the installer. To leave out the event logs, add `-SkipVector`.

   ```powershell
   .\dotfiles\windows\Install-Monitoring.ps1
   ```

   Result: The last line is `running  Event Log shipping to VictoriaLogs`, or `==> Vector skipped` with `-SkipVector`.

## Change an agent version

1. On a Linux machine, get the SHA256 of the new release file, `<url>`.

   ```bash
   curl -sL <url> | sha256sum
   ```

   Result: The hash, then `-`.

2. In `Install-Monitoring.ps1`, change the `<Agent>Version`, `<Agent>Url` and `<Agent>Sha256` parameters together. `<Agent>` is `Exporter`, `Ohm` or `Vector`.
3. Merge the change.
4. If the agent is Vector, do [Remove Vector](#remove-vector) on each desktop.
5. Do [Install or update the agents](#install-or-update-the-agents) on each desktop.

## Remove Vector

Before a Vector upgrade, do this procedure.

1. On the desktop, open PowerShell 7 as administrator.
2. Stop the `Vector` task.

   ```powershell
   Stop-ScheduledTask -TaskName Vector
   ```

3. Uninstall Vector in Settings, Apps, Installed apps.
4. Make sure `vector.exe` is gone.

   ```powershell
   Test-Path 'C:\Program Files\Vector\bin\vector.exe'
   ```

   Result: `False`.

## Check a desktop

> [!NOTE]
> A WSL distro in mirrored networking mode cannot reach the LAN address of its own desktop.

1. In the full checkout, read the desktop address, `<ip>`.

   ```bash
   jq -r .data.<HOST>_IP clusters/folly/config/lab-topology.json
   ```

   Result: The desktop address.

2. Read the status of `windows_exporter` from a lab host.

   ```bash
   ssh spore.lolwtf.ca "curl -s -o /dev/null -w '%{http_code}\n' http://<ip>:9182/metrics"
   ```

   Result: `200`, or `000` if the desktop is off.

3. Read the collector status.

   ```bash
   ssh spore.lolwtf.ca "curl -s http://<ip>:9182/metrics" | grep '^windows_exporter_collector_success'
   ```

   Result: Each collector has the value `1`.

4. Count the OhmGraphite metrics.

   ```bash
   ssh spore.lolwtf.ca "curl -s http://<ip>:4445/metrics" | grep -c '^ohm_'
   ```

   Result: A number larger than `0`.

5. Read the Prometheus targets of `<host>`.

   ```bash
   curl -s -G https://prom.lolwtf.ca/api/v1/query --data-urlencode 'query=up{job="windows-exporter",instance="<host>"}' \
     | jq -r '.data.result[] | "\(.metric.endpoint) \(.value[1])"'
   ```

   Result: `http-metrics 1` and `sensors 1`.

6. In Grafana, query the VictoriaLogs data source with `{job="windows-eventlog", host="<host>"}`.

   Result: The event log lines of `<host>`.

## Check Memory Integrity

Memory Integrity and the vulnerable driver blocklist are Windows security settings. When either one is on, Windows blocks the LibreHardwareMonitor driver. The desktop then has no CPU temperature or fan speed, so `WindowsCpuTempHigh` and `WindowsFanStopped` cannot fire. If only those sensors are missing, do this procedure.

1. On the desktop, open PowerShell 7.
2. Read the security services that run.

   ```powershell
   (Get-CimInstance -Namespace root\Microsoft\Windows\DeviceGuard -ClassName Win32_DeviceGuard).SecurityServicesRunning
   ```

   Result: The list includes `2` if Memory Integrity is on.

3. Read the vulnerable driver blocklist setting.

   ```powershell
   Get-ItemProperty HKLM:\SYSTEM\CurrentControlSet\Control\CI\Config -Name VulnerableDriverBlocklistEnable
   ```

   Result: `VulnerableDriverBlocklistEnable` is `1` if the blocklist is on.

4. If either setting is on, accept the missing sensors.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `TargetDown` fires for job `windows-exporter`. | A desktop is off or unreachable. | Do step 2 of [Check a desktop](#check-a-desktop). |
| `WindowsCollectorFailing` fires. | The performance counter registry is damaged. | As administrator, run `lodctr /R`. Run `Restart-Service windows_exporter`. |
| Step 2 of [Check a desktop](#check-a-desktop) prints `000`, and the desktop is on. | The desktop has another address, or it is outside the Internal zone. | Find the desktop with [Inspect the UniFi network](inspect-the-unifi-network.md). |
| The installer stops with `Hash mismatch`. | The download is not the pinned file. | Make sure the `<Agent>Url` and `<Agent>Sha256` parameters name the same release. |
| Step 4 of [Check a desktop](#check-a-desktop) prints `0`. | The `OhmGraphite` service stopped, or it does not run as LocalSystem. | As administrator, run `sc.exe config OhmGraphite obj= LocalSystem`. Run `Restart-Service OhmGraphite`. |
| GPU temperature is present, and GPU load is missing. | The `gpu` collector is off. | Run the installer again. |
| Step 6 of [Check a desktop](#check-a-desktop) shows no lines. | The `Vector` task stopped, or `vector.yaml` has another endpoint. | Run the installer again. |
| Vector stays at an old version. | The installer skips Vector when `vector.exe` exists. | Do [Remove Vector](#remove-vector). Run the installer again. |

## Related

- [Observability](../platform/observability.md)
- [Install a Windows desktop](install-a-windows-desktop.md)
- [tallboy](../hosts/tallboy.md) and [atomic](../hosts/atomic.md)
