namespace Lookout.Tests;

public class AgentUpdaterTests
{
    private static Policy WithAgent(string version) => Policy.Parse(Fixtures.PolicyJson) with
    {
        Agent = new AgentPolicy(version, "https://example.test/Lookout.msi", new string('A', 64)),
    };

    [Fact]
    public async Task DoesNothingWithoutAnAgentEntryOrAtTheRunningVersion()
    {
        var system = new FakeSystem();
        Assert.Null(await new AgentUpdater(system, "0.2.0").UpdateAsync(Policy.Parse(Fixtures.PolicyJson), CancellationToken.None));
        Assert.Null(await new AgentUpdater(system, "0.2.0").UpdateAsync(WithAgent("0.2.0"), CancellationToken.None));
        Assert.Empty(system.Detached);
    }

    [Fact]
    public async Task StartsMsiexecDetachedOnAVerifiedDownload()
    {
        var system = new FakeSystem();
        var started = await new AgentUpdater(system, "0.2.0").UpdateAsync(WithAgent("0.3.0"), CancellationToken.None);

        Assert.Equal("upgrading 0.2.0 to 0.3.0", started);
        var msiexec = Assert.Single(system.Detached);
        Assert.Equal($"msiexec.exe /i \"{Paths.UpdateMsi(system)}\" /qn /norestart", msiexec);
        Assert.True(system.Files.ContainsKey(Paths.UpdateMsi(system)));
        Assert.DoesNotContain(system.Commands, c => c.StartsWith("msiexec"));
    }
}
