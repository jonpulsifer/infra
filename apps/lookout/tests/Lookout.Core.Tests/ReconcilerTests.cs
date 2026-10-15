namespace Lookout.Tests;

public class WindowsExporterTests
{
    [Fact]
    public async Task InstallsWithTheDeclaredCollectorsAndFirewall()
    {
        var system = new FakeSystem();
        var bundle = Fixtures.Bundle();
        var reconciler = new WindowsExporterReconciler(system);

        var before = await reconciler.ObserveAsync(bundle, CancellationToken.None);
        Assert.False(before.Installed);
        Assert.Contains("not installed", before.Problems);

        var result = await reconciler.ConvergeAsync(bundle, before, CancellationToken.None);

        var msiexec = Assert.Single(system.Commands, c => c.StartsWith("msiexec.exe /i"));
        Assert.Contains("/qn /norestart ADDLOCAL=FirewallException ENABLED_COLLECTORS=\"[defaults],gpu,cpu_info,diskdrive,textfile\"", msiexec);
        Assert.False(result.RebootPending);
        Assert.DoesNotContain(system.Files.Keys, k => k.EndsWith(".msi"));
    }

    [Fact]
    public async Task AWrongCollectorListOnTheServiceCommandLineIsDrift()
    {
        var system = new FakeSystem();
        var bundle = Fixtures.Bundle();
        system.InstallEverything(bundle);
        system.Services["windows_exporter"] = system.Services["windows_exporter"] with
        {
            BinaryPath = "\"C:\\Program Files\\windows_exporter\\windows_exporter.exe\" --collectors.enabled \"[defaults]\"",
        };

        var state = await new WindowsExporterReconciler(system).ObserveAsync(bundle, CancellationToken.None);

        Assert.True(state.Installed);
        Assert.False(state.Configured);
        Assert.True(state.Healthy);
        Assert.Contains(state.Problems, p => p.StartsWith("service runs other collectors"));
    }

    [Fact]
    public async Task ARebootRequestIsReported()
    {
        var system = new FakeSystem { MsiExit = Msi.RebootRequired };
        var bundle = Fixtures.Bundle();
        var reconciler = new WindowsExporterReconciler(system);
        var result = await reconciler.ConvergeAsync(bundle, await reconciler.ObserveAsync(bundle, CancellationToken.None), CancellationToken.None);
        Assert.True(result.RebootPending);
    }

    [Fact]
    public async Task AnInstallerFailureThrows()
    {
        var system = new FakeSystem { MsiExit = 1603 };
        var bundle = Fixtures.Bundle();
        var reconciler = new WindowsExporterReconciler(system);
        var observed = await reconciler.ObserveAsync(bundle, CancellationToken.None);
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => reconciler.ConvergeAsync(bundle, observed, CancellationToken.None));
        Assert.Contains("1603", error.Message);
    }
}

public class OhmGraphiteTests
{
    [Fact]
    public async Task FreshInstallUnpacksConfiguresRegistersAndOpensThePort()
    {
        var system = new FakeSystem();
        var bundle = Fixtures.Bundle();
        var reconciler = new OhmGraphiteReconciler(system);

        var before = await reconciler.ObserveAsync(bundle, CancellationToken.None);
        var result = await reconciler.ConvergeAsync(bundle, before, CancellationToken.None);

        Assert.Single(system.Extracted);
        Assert.Equal(bundle.OhmGraphiteConfig, system.Files[Paths.OhmConfig(system)]);
        Assert.Contains("registered the service", result.Actions);
        Assert.Contains("OhmGraphite", system.FirewallRules);
        Assert.True(system.Services["OhmGraphite"].Running);
    }

    [Fact]
    public async Task ARestoredDefaultConfigIsRewrittenWithoutAReinstall()
    {
        var system = new FakeSystem();
        var bundle = Fixtures.Bundle();
        system.InstallEverything(bundle);
        system.Files[Paths.OhmConfig(system)] = "<graphite default/>";
        var reconciler = new OhmGraphiteReconciler(system);

        var before = await reconciler.ObserveAsync(bundle, CancellationToken.None);
        Assert.True(before.Installed);
        Assert.False(before.Configured);

        var result = await reconciler.ConvergeAsync(bundle, before, CancellationToken.None);

        Assert.Empty(system.Extracted);
        Assert.Equal(["wrote config", "restarted the service"], result.Actions);
        Assert.True((await reconciler.ObserveAsync(bundle, CancellationToken.None)).Current);
    }
}

public class VectorTests
{
    [Fact]
    public async Task ANewVersionRemovesTheOldProductFirst()
    {
        var system = new FakeSystem();
        var bundle = Fixtures.Bundle();
        system.InstallEverything(bundle);
        system.OnRun = (file, args) => file.EndsWith("vector.exe") && args == "--version"
            ? new ProcessResult(0, "vector 0.57.0 (x86_64-pc-windows-msvc)\n", "")
            : null;
        var reconciler = new VectorReconciler(system);

        var before = await reconciler.ObserveAsync(bundle, CancellationToken.None);
        Assert.Equal("0.57.0", before.InstalledVersion);
        Assert.False(before.Installed);

        await reconciler.ConvergeAsync(bundle, before, CancellationToken.None);

        var msi = system.Commands.Where(c => c.StartsWith("msiexec.exe")).ToList();
        Assert.Equal(2, msi.Count);
        Assert.StartsWith($"msiexec.exe /x {bundle.Policy.Vector.ProductCode} /qn /norestart", msi[0]);
        Assert.StartsWith("msiexec.exe /i", msi[1]);
        Assert.True(system.Commands.IndexOf("schtasks.exe /End /TN \"Vector\"") < system.Commands.IndexOf(msi[0]));
    }

    [Fact]
    public async Task AnInstalledVectorThatIsNotRunningIsUnhealthyNotDrifted()
    {
        var system = new FakeSystem();
        var bundle = Fixtures.Bundle();
        system.InstallEverything(bundle);
        system.Processes.Remove("vector");

        var state = await new VectorReconciler(system).ObserveAsync(bundle, CancellationToken.None);

        Assert.True(state.Current);
        Assert.False(state.Healthy);
        Assert.Contains("not running", state.Problems);
    }

    [Fact]
    public void TheTaskRunsAtBootAsSystemForever()
    {
        var xml = ScheduledTask.StartupAsSystemXml(@"C:\Program Files\Vector\bin\vector.exe", "--config \"C:\\x.yaml\"");
        Assert.Contains("<UserId>S-1-5-18</UserId>", xml);
        Assert.Contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>", xml);
        Assert.Contains("<BootTrigger>", xml);
        Assert.Contains("<Arguments>--config &quot;C:\\x.yaml&quot;</Arguments>", xml);
    }
}

public class ReconcilerTests
{
    [Fact]
    public async Task AConvergedMachineReportsEveryComponentCurrentAndHealthy()
    {
        var system = new FakeSystem();
        var bundle = Fixtures.Bundle();
        system.InstallEverything(bundle);

        var result = await Reconciler.ForWindows(system).RunAsync(bundle, converge: true, CancellationToken.None);

        Assert.True(result.Ok);
        Assert.Empty(result.Actions);
        Assert.All(result.Components, c => Assert.True(c.Current && c.Healthy, c.Component));
    }

    [Fact]
    public async Task OneFailingComponentDoesNotStopTheOthers()
    {
        var system = new FakeSystem { MsiExit = 1603 };
        var bundle = Fixtures.Bundle();

        var result = await Reconciler.ForWindows(system).RunAsync(bundle, converge: true, CancellationToken.None);

        Assert.False(result.Ok);
        Assert.Equal(3, result.Components.Count);
        Assert.Contains(result.Errors, e => e.StartsWith("windows_exporter:"));
        Assert.Contains(result.Actions, a => a.StartsWith("ohmgraphite:"));
    }

    [Fact]
    public async Task ObserveOnlyChangesNothing()
    {
        var system = new FakeSystem();
        var result = await Reconciler.ForWindows(system).RunAsync(Fixtures.Bundle(), converge: false, CancellationToken.None);
        Assert.Empty(result.Actions);
        Assert.DoesNotContain(system.Commands, c => c.StartsWith("msiexec"));
        Assert.All(result.Components, c => Assert.False(c.Current));
    }
}
