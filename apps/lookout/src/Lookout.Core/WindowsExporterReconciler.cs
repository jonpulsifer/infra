namespace Lookout;

/// <summary>
/// windows_exporter from its MSI. The MSI writes --collectors.enabled onto the
/// service command line, and a flag beats config.yaml, so a wrong collector
/// list means a reinstall, never a config edit.
/// </summary>
public sealed class WindowsExporterReconciler(ISystem system) : IComponentReconciler
{
    public string Name => "windows_exporter";

    public async Task<ComponentState> ObserveAsync(PolicyBundle bundle, CancellationToken ct)
    {
        var policy = bundle.Policy.WindowsExporter;
        var problems = new List<string>();

        var installedVersion = system.FileProductVersion(Paths.ExporterExe(system));
        var installed = installedVersion == policy.Version;
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
        var msi = await system.DownloadFileAsync(new Uri(policy.Url), policy.Sha256, ".msi", ct);
        try
        {
            var exit = await Msi.InstallAsync(system, msi,
                $"ADDLOCAL=FirewallException ENABLED_COLLECTORS=\"{policy.Collectors}\"", ct);
            return new ConvergeResult([$"installed {policy.Version} with collectors {policy.Collectors}"], exit == Msi.RebootRequired);
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

    public static async Task<int> UninstallAsync(ISystem system, string productCode, CancellationToken ct)
    {
        var result = await system.RunAsync("msiexec.exe", $"/x {productCode} /qn /norestart", ct);
        if (result.ExitCode is not (0 or UnknownProduct or RebootRequired))
        {
            throw new InvalidOperationException($"msiexec exited {result.ExitCode} removing {productCode}");
        }
        return result.ExitCode;
    }
}
