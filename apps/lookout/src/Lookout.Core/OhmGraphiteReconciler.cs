namespace Lookout;

/// <summary>
/// OhmGraphite from its zip, as a LocalSystem service so LibreHardwareMonitor
/// can load its driver. The unpack restores the Graphite default config, so
/// the declared config is rewritten whenever it differs.
/// </summary>
public sealed class OhmGraphiteReconciler(ISystem system) : IComponentReconciler
{
    public string Name => "ohmgraphite";

    public async Task<ComponentState> ObserveAsync(PolicyBundle bundle, CancellationToken ct)
    {
        var policy = bundle.Policy.OhmGraphite;
        var problems = new List<string>();

        var installedVersion = system.FileProductVersion(Paths.OhmExe(system));
        var service = system.QueryService(Paths.OhmService);
        var installed = installedVersion == policy.Version && service is not null;
        if (installedVersion != policy.Version)
        {
            problems.Add(installedVersion is null ? "not installed" : $"version {installedVersion}, want {policy.Version}");
        }
        if (service is null) problems.Add("service missing");

        var configCurrent = system.ReadText(Paths.OhmConfig(system)) == bundle.OhmGraphiteConfig;
        if (!configCurrent) problems.Add("config differs from policy");
        var firewall = await Firewall.RuleExistsAsync(system, Paths.OhmService, ct);
        if (!firewall) problems.Add("firewall rule missing");
        var configured = configCurrent && firewall;

        var healthy = false;
        if (service is { Running: true })
        {
            healthy = await system.HttpOkAsync(new Uri($"http://127.0.0.1:{policy.Port}/metrics/"), ct);
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
        var policy = bundle.Policy.OhmGraphite;
        var actions = new List<string>();
        var dir = Paths.OhmDir(system);

        if (!observed.Installed)
        {
            var zip = await system.DownloadFileAsync(new Uri(policy.Url), policy.Sha256, ".zip", ct);
            try
            {
                // The service holds the exe open.
                if (system.QueryService(Paths.OhmService) is not null)
                {
                    await system.StopServiceAsync(Paths.OhmService, ct);
                }
                system.CreateDirectory(dir);
                system.ExtractZip(zip, dir);
                actions.Add($"unpacked {policy.Version}");
            }
            finally
            {
                system.DeleteFile(zip);
            }
        }

        if (system.ReadText(Paths.OhmConfig(system)) != bundle.OhmGraphiteConfig)
        {
            system.WriteText(Paths.OhmConfig(system), bundle.OhmGraphiteConfig);
            actions.Add("wrote config");
        }

        if (system.QueryService(Paths.OhmService) is null)
        {
            var result = await system.RunAsync(Paths.OhmExe(system), "install", ct);
            if (result.ExitCode != 0)
            {
                throw new InvalidOperationException($"OhmGraphite.exe install exited {result.ExitCode}: {result.Stderr}");
            }
            actions.Add("registered the service");
        }

        await system.StopServiceAsync(Paths.OhmService, ct);
        await system.StartServiceAsync(Paths.OhmService, ct);
        actions.Add("restarted the service");

        if (!await Firewall.RuleExistsAsync(system, Paths.OhmService, ct))
        {
            await Firewall.AllowInboundTcpAsync(system, Paths.OhmService, policy.Port, ct);
            actions.Add($"opened inbound TCP {policy.Port}");
        }

        return new ConvergeResult(actions, false);
    }
}

public static class Firewall
{
    public static async Task<bool> RuleExistsAsync(ISystem system, string name, CancellationToken ct)
    {
        var result = await system.RunAsync("netsh.exe", $"advfirewall firewall show rule name=\"{name}\"", ct);
        return result.ExitCode == 0;
    }

    public static async Task AllowInboundTcpAsync(ISystem system, string name, int port, CancellationToken ct)
    {
        var result = await system.RunAsync("netsh.exe",
            $"advfirewall firewall add rule name=\"{name}\" dir=in action=allow protocol=TCP localport={port} profile=any", ct);
        if (result.ExitCode != 0)
        {
            throw new InvalidOperationException($"netsh exited {result.ExitCode} adding rule {name}: {result.Stdout}");
        }
    }
}
