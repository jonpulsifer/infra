namespace Lookout;

/// <summary>
/// windows_exporter from its MSI. The MSI writes --collectors.enabled onto the
/// service command line, and a flag beats config.yaml, so a wrong collector
/// list means a reinstall, never a config edit. Windows Installer treats /i of
/// an installed version as a reconfiguration, which this MSI fails with 1603,
/// so the installed product is removed first.
/// </summary>
public sealed class WindowsExporterReconciler(ISystem system) : IComponentReconciler
{
    public string Name => "windows_exporter";

    public async Task<ComponentState> ObserveAsync(PolicyBundle bundle, CancellationToken ct)
    {
        var policy = bundle.Policy.WindowsExporter;
        var problems = new List<string>();

        var installedVersion = system.FileProductVersion(Paths.ExporterExe(system));
        var installed = Versions.Matches(installedVersion, policy.Version);
        if (!installed)
        {
            problems.Add(installedVersion is null ? "not installed" : $"version {installedVersion}, want {policy.Version}");
        }

        var service = system.QueryService(Paths.ExporterService);
        var configured = service is not null && service.BinaryPath.Contains(policy.Collectors, StringComparison.Ordinal);
        if (service is null)
        {
            problems.Add("service missing");
        }
        else if (!configured)
        {
            problems.Add($"service runs other collectors: {service.BinaryPath}");
        }

        var healthy = false;
        if (service is { Running: true })
        {
            healthy = await system.HttpOkAsync(new Uri($"http://127.0.0.1:{policy.Port}/metrics"), ct);
            if (!healthy) problems.Add($"port {policy.Port} does not answer");
        }
        else if (service is not null)
        {
            problems.Add("service stopped");
        }

        return new ComponentState(Name, policy.Version, installedVersion, installed, configured, healthy, problems);
    }

    public async Task<ConvergeResult> ConvergeAsync(PolicyBundle bundle, ComponentState observed, CancellationToken ct)
    {
        var policy = bundle.Policy.WindowsExporter;
        var actions = new List<string>();
        var reboot = false;
        var msi = await system.DownloadFileAsync(new Uri(policy.Url), policy.Sha256, ".msi", ct);
        try
        {
            if (observed.Installed)
            {
                reboot |= await Msi.UninstallAsync(system, $"\"{msi}\"", ct) == Msi.RebootRequired;
                actions.Add($"removed {observed.InstalledVersion}");
            }
            reboot |= await Msi.InstallAsync(system, msi,
                $"ADDLOCAL=FirewallException ENABLED_COLLECTORS=\"{policy.Collectors}\"", ct) == Msi.RebootRequired;
            actions.Add($"installed {policy.Version} with collectors {policy.Collectors}");
            if (!await Readiness.WaitForHttpAsync(system, new Uri($"http://127.0.0.1:{policy.Port}/metrics"), ct))
            {
                actions.Add($"port {policy.Port} did not answer within {Readiness.Wait.TotalSeconds:0}s");
            }
            return new ConvergeResult(actions, reboot);
        }
        finally
        {
            system.DeleteFile(msi);
        }
    }
}

public static class Msi
{
    public const int RebootRequired = 3010;
    public const int UnknownProduct = 1605;

    public static async Task<int> InstallAsync(ISystem system, string path, string properties, CancellationToken ct)
    {
        var result = await system.RunAsync("msiexec.exe", $"/i \"{path}\" /qn /norestart {properties}".TrimEnd(), ct);
        if (result.ExitCode is not (0 or RebootRequired))
        {
            throw new InvalidOperationException($"msiexec exited {result.ExitCode} installing {path}");
        }
        return result.ExitCode;
    }

    /// <summary>Removes a product by its ProductCode, or by the path of the MSI that installed it.</summary>
    public static async Task<int> UninstallAsync(ISystem system, string product, CancellationToken ct)
    {
        var result = await system.RunAsync("msiexec.exe", $"/x {product} /qn /norestart", ct);
        if (result.ExitCode is not (0 or UnknownProduct or RebootRequired))
        {
            throw new InvalidOperationException($"msiexec exited {result.ExitCode} removing {product}");
        }
        return result.ExitCode;
    }
}
