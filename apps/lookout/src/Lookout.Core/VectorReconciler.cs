using System.Text.RegularExpressions;

namespace Lookout;

/// <summary>
/// Vector from its MSI, run by a SYSTEM scheduled task at startup. vector.exe
/// is a console binary that never calls StartServiceCtrlDispatcher, so as an
/// sc.exe service the SCM kills it with error 1053. Every Vector MSI carries
/// the same ProductCode and no upgrade table, so a new version installs only
/// after the old one is removed.
/// </summary>
public sealed partial class VectorReconciler(ISystem system) : IComponentReconciler
{
    public string Name => "vector";

    [GeneratedRegex("^vector (\\S+)")]
    private static partial Regex VersionLine();

    public async Task<ComponentState> ObserveAsync(PolicyBundle bundle, CancellationToken ct)
    {
        var policy = bundle.Policy.Vector;
        var problems = new List<string>();

        var installedVersion = await InstalledVersionAsync(ct);
        var installed = installedVersion == policy.Version;
        if (!installed)
        {
            problems.Add(installedVersion is null ? "not installed" : $"version {installedVersion}, want {policy.Version}");
        }

        var configCurrent = system.ReadText(Paths.VectorConfig(system)) == bundle.VectorConfig;
        if (!configCurrent) problems.Add("config differs from policy");
        var task = await ScheduledTask.ExistsAsync(system, Paths.VectorTask, ct);
        if (!task) problems.Add("scheduled task missing");
        var configured = configCurrent && task;

        var healthy = system.ProcessRunning(Paths.VectorProcess);
        if (installed && !healthy) problems.Add("not running");

        return new ComponentState(Name, policy.Version, installedVersion, installed, configured, healthy, problems);
    }

    public async Task<ConvergeResult> ConvergeAsync(PolicyBundle bundle, ComponentState observed, CancellationToken ct)
    {
        var policy = bundle.Policy.Vector;
        var actions = new List<string>();
        var reboot = false;
        var exe = Paths.VectorExe(system);

        if (!observed.Installed)
        {
            var msi = await system.DownloadFileAsync(new Uri(policy.Url), policy.Sha256, ".msi", ct);
            try
            {
                // The task holds vector.exe open.
                await ScheduledTask.EndAsync(system, Paths.VectorTask, ct);
                if (system.FileExists(exe))
                {
                    reboot |= await Msi.UninstallAsync(system, policy.ProductCode, ct) == Msi.RebootRequired;
                    actions.Add($"removed {observed.InstalledVersion}");
                }
                reboot |= await Msi.InstallAsync(system, msi, "", ct) == Msi.RebootRequired;
                actions.Add($"installed {policy.Version}");
            }
            finally
            {
                system.DeleteFile(msi);
            }
        }

        var config = Paths.VectorConfig(system);
        if (system.ReadText(config) != bundle.VectorConfig)
        {
            system.CreateDirectory(Path.GetDirectoryName(config)!);
            system.WriteText(config, bundle.VectorConfig);
            actions.Add("wrote config");
        }
        system.CreateDirectory(Paths.VectorData(system));

        await ScheduledTask.RegisterAsync(system, Paths.VectorTask,
            ScheduledTask.StartupAsSystemXml(exe, $"--config \"{config}\""), ct);
        await ScheduledTask.EndAsync(system, Paths.VectorTask, ct);
        await ScheduledTask.RunAsync(system, Paths.VectorTask, ct);
        actions.Add("registered and started the task");

        return new ConvergeResult(actions, reboot);
    }

    private async Task<string?> InstalledVersionAsync(CancellationToken ct)
    {
        // vector.exe has no version resource, so its ProductVersion is empty. The binary reports its own.
        var exe = Paths.VectorExe(system);
        if (!system.FileExists(exe)) return null;
        var result = await system.RunAsync(exe, "--version", ct);
        var match = VersionLine().Match(result.Stdout.Trim());
        return match.Success ? match.Groups[1].Value : null;
    }
}

public static class ScheduledTask
{
    public static async Task<bool> ExistsAsync(ISystem system, string name, CancellationToken ct)
    {
        var result = await system.RunAsync("schtasks.exe", $"/Query /TN \"{name}\"", ct);
        return result.ExitCode == 0;
    }

    public static Task EndAsync(ISystem system, string name, CancellationToken ct)
        => system.RunAsync("schtasks.exe", $"/End /TN \"{name}\"", ct);

    public static async Task RunAsync(ISystem system, string name, CancellationToken ct)
    {
        var result = await system.RunAsync("schtasks.exe", $"/Run /TN \"{name}\"", ct);
        if (result.ExitCode != 0)
        {
            throw new InvalidOperationException($"schtasks /Run exited {result.ExitCode}: {result.Stderr}");
        }
    }

    public static async Task RegisterAsync(ISystem system, string name, string xml, CancellationToken ct)
    {
        var file = system.TempFile(".xml");
        try
        {
            system.WriteText(file, xml);
            var result = await system.RunAsync("schtasks.exe", $"/Create /TN \"{name}\" /XML \"{file}\" /F", ct);
            if (result.ExitCode != 0)
            {
                throw new InvalidOperationException($"schtasks /Create exited {result.ExitCode}: {result.Stderr}");
            }
        }
        finally
        {
            system.DeleteFile(file);
        }
    }

    /// <summary>
    /// A task that runs at boot as SYSTEM, restarts every minute on failure,
    /// never times out, and ignores battery state.
    /// </summary>
    public static string StartupAsSystemXml(string command, string arguments)
    {
        static string Escape(string s) => System.Security.SecurityElement.Escape(s) ?? "";
        return $"""
            <?xml version="1.0"?>
            <Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
              <Triggers>
                <BootTrigger>
                  <Enabled>true</Enabled>
                </BootTrigger>
              </Triggers>
              <Principals>
                <Principal id="Author">
                  <UserId>S-1-5-18</UserId>
                  <RunLevel>HighestAvailable</RunLevel>
                </Principal>
              </Principals>
              <Settings>
                <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
                <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
                <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
                <AllowHardTerminate>true</AllowHardTerminate>
                <StartWhenAvailable>true</StartWhenAvailable>
                <AllowStartOnDemand>true</AllowStartOnDemand>
                <Enabled>true</Enabled>
                <Hidden>false</Hidden>
                <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
                <RestartOnFailure>
                  <Interval>PT1M</Interval>
                  <Count>999</Count>
                </RestartOnFailure>
                <Priority>7</Priority>
              </Settings>
              <Actions Context="Author">
                <Exec>
                  <Command>{Escape(command)}</Command>
                  <Arguments>{Escape(arguments)}</Arguments>
                </Exec>
              </Actions>
            </Task>
            """;
    }
}
