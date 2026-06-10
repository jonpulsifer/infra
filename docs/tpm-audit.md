# TPM Audit - Homelab Hosts

**Audited:** 2026-06-10  
**Method:** kubectl exec onto Cilium pods (hostNetwork: true) to access `/sys/class/dmi/id/` and `dmesg`

## Summary

| Hostname | Role | Cluster | Machine Model | TPM Hardware | TPM Version | TPM Enabled | Enableable | Notes |
|----------|------|---------|---------------|-------------|-------------|-------------|-------------|-------|
| optiplex | control-plane | folly | Dell OptiPlex 3050 | Present (fTPM) | 2.0 | No | Yes | firmware-level TPM, probe failed, needs BIOS config |
| riptide | worker | folly | HP EliteDesk 800 G5 Desktop Mini | Present (fTPM) | 2.0 | Yes | N/A | TPM 2.0 detected and operational |
| shale | worker | folly | HP EliteDesk 800 G2 DM 35W | Present | 1.2 | No | Yes | TPM 1.2 present but disabled; probe error |
| oldschool | worker | offsite | HP EliteDesk 800 G3 DM 35W | Unknown | Unknown | Unknown | Unknown | pod timeout, could not verify |
| retrofit | control-plane | offsite | HP EliteDesk 800 G2 DM 65W | Unknown | Unknown | Unknown | Unknown | pod timeout, could not verify |

**k8s-node**: Not a registered node in the cluster; appears to be a netboot target alias, not a live host.

## Detailed Findings

### optiplex (folly control-plane)
- **Model:** Dell OptiPlex 3050
- **TPM:** ACPI TPM2 table present (DELL CBX3). Intel PTT (fTPM) likely implemented via ME.
- **Dmesg:** `tpm_tis MSFT0101:00: probe with driver tpm_tis failed with error -1`
- **Status:** TPM hardware exists but kernel driver fails to claim it. Likely requires BIOS enablement of "Intel Platform Trust Technology" (PTT) or "TPM 2.0" option.
- **Actionable:** Yes — enter BIOS, enable TPM 2.0 / Intel PTT, set TPM active, reboot.

### riptide (folly worker)
- **Model:** HP EliteDesk 800 G5 Desktop Mini
- **TPM:** ACPI TPM2 table present (INTEL CFL). Detected as `tpm_tis IFX0785:00: 2.0 TPM (device-id 0x1B, rev-id 22)`
- **Dmesg:** No errors. TPM operational.
- **Status:** TPM 2.0 fully functional.
- **Actionable:** N/A — already working.

### shale (folly worker)
- **Model:** HP EliteDesk 800 G2 DM 35W
- **TPM:** ACPI TPM2 table present. However, dmesg shows `tpm_tis 00:01: 1.2 TPM (device-id 0x1B, rev-id 16)` — TPM 1.2 device detected.
- **Status:** TPM 1.2 hardware present but probe may have failed. BIOS setting likely needed to enable.
- **Actionable:** Yes — enter BIOS, enable TPM, set active.

### oldschool (offsite worker)
- **Model:** HP EliteDesk 800 G3 DM 35W
- **TPM:** Could not verify. Pod experienced timeouts; network latency to offsite cluster is high.
- **Status:** Unknown — direct SSH access not available from this environment.
- **Actionable:** Requires physical/local access or reliable SSH to check.

### retrofit (offsite control-plane)
- **Model:** HP EliteDesk 800 G2 DM 65W
- **TPM:** Could not verify. Pod experienced timeouts; network latency to offsite cluster is high.
- **Status:** Unknown — direct SSH access not available from this environment.
- **Actionable:** Requires physical/local access or reliable SSH to check.

## NixOS Configuration Note

The x86 hardware profile (`nix/hardware/x86/default.nix`) sets:
```
systemd.tpm2.enable = lib.mkDefault false;
```

This means TPM2 is **not** currently being used by NixOS on any of these hosts. If TPM-based features (e.g., `systemd-cryptenroll`, disk encryption with TPM, UKI measured boot) are desired, this option should be set to `true` per-host and the TPM must be enabled in firmware.

## Recommendations

1. **Enable TPM in BIOS** for optiplex, shale, oldschool, retrofit (if hardware supports it)
2. **Set `systemd.tpm2.enable = true`** in host configs for any that will use TPM-backed disk encryption
3. **Investigate offsite access** — high latency prevents reliable exec-based auditing; consider a Tailscale subnet router or SSH jump for reliable access to oldschool/retrofit

## Commands Used

```bash
# From a Cilium pod (hostNetwork: true) on each node:
cat /sys/class/dmi/id/product_name      # machine model
ls /dev/tpm*                           # TPM device nodes
dmesg | grep -i tpm                     # TPM kernel messages
```

## Host Details

| Host | Internal IP | Kernel | OS |
|------|-------------|--------|-----|
| optiplex | 10.3.0.10 | 7.0.9 | NixOS 25.11 (Xantusia) |
| riptide | 10.3.0.12 | 7.0.9 | NixOS 25.11 (Xantusia) |
| shale | 10.3.0.11 | 7.0.10 | NixOS 25.11 (Xantusia) |
| oldschool | 10.89.0.11 | 6.17.9 | NixOS 25.11 (Xantusia) |
| retrofit | 10.89.0.10 | 6.17.9 | NixOS 25.11 (Xantusia) |