# Lookout

The lab's monitoring agent for a Windows desktop, installed from an MSI. The
agent, a Windows service, keeps windows_exporter, OhmGraphite and Vector at
the versions and configuration `policy/policy.json` declares, and reports its
own health through windows_exporter's textfile collector. The tray shows the
state and offers a sync or a pause.

| Directory | What it is |
| --- | --- |
| `policy/` | The desired state, fetched from `main` by every desktop |
| `src/Lookout.Core` | Policy, reconcilers and status, behind an `ISystem` seam; tested anywhere |
| `src/Lookout.Agent` | The service: the loop, the real `ISystem`, the named pipe |
| `src/Lookout.Tray` | The tray icon, WPF |
| `tests/` | xunit tests for Core |
| `packaging/` | The WiX source, the icon, and `Build-Package.ps1` |

```sh
mise run lookout:test      # anywhere
dotnet build apps/lookout  # anywhere; WPF compiles on Linux and runs on Windows
pwsh apps/lookout/packaging/Build-Package.ps1   # Windows, with the wix dotnet tool
```

The wiki page is `docs/apps/lookout.md`.
