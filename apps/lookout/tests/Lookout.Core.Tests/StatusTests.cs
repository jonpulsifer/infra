using System.Text.Json;

namespace Lookout.Tests;

public class StatusTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 15, 12, 0, 0, TimeSpan.Zero);

    private static ComponentState Component(string name, bool current = true, bool healthy = true)
        => new(name, "1", "1", current, current, healthy, []);

    private static StatusReport Report(IReadOnlyList<ComponentState> components, bool syncOk = true,
        bool policyOk = true, bool reboot = false, DateTimeOffset? pausedUntil = null)
        => new("0.1.0", "tallboy", Now, Now.AddMinutes(-1), syncOk, policyOk, "git", pausedUntil, reboot, components, [], []);

    [Fact]
    public void OverallIsTheWorstComponent()
    {
        Assert.Equal(Overall.Healthy, Report([Component("a"), Component("b")]).Overall);
        Assert.Equal(Overall.Attention, Report([Component("a", current: false)]).Overall);
        Assert.Equal(Overall.Attention, Report([Component("a")], reboot: true).Overall);
        Assert.Equal(Overall.Attention, Report([Component("a")], policyOk: false).Overall);
        Assert.Equal(Overall.Down, Report([Component("a", current: false, healthy: false)]).Overall);
        Assert.Equal(Overall.Down, Report([]).Overall);
    }

    [Fact]
    public void SummaryNamesTheProblem()
    {
        Assert.Equal("All agents current", Report([Component("a")]).Summary);
        Assert.Equal("Down: vector", Report([Component("a"), Component("vector", healthy: false)]).Summary);
        Assert.Equal("reboot pending; ohmgraphite drifted", Report([Component("ohmgraphite", current: false)], reboot: true).Summary);
    }

    [Fact]
    public void PausedOnlyWhileTheDeadlineIsAhead()
    {
        Assert.True(Report([], pausedUntil: Now.AddHours(1)).Paused);
        Assert.False(Report([], pausedUntil: Now.AddHours(-1)).Paused);
        Assert.False(Report([]).Paused);
    }

    [Fact]
    public void TextfileIsPrometheusText()
    {
        var text = Textfile.Render(Report([Component("windows_exporter"), Component("vector", current: false, healthy: false)]));

        Assert.Contains("# TYPE lookout_info gauge\nlookout_info{version=\"0.1.0\"} 1\n", text);
        Assert.Contains($"lookout_last_sync_timestamp_seconds {Now.AddMinutes(-1).ToUnixTimeSeconds()}\n", text);
        Assert.Contains("lookout_component_current{component=\"windows_exporter\"} 1\n", text);
        Assert.Contains("lookout_component_current{component=\"vector\"} 0\n", text);
        Assert.Contains("lookout_component_healthy{component=\"vector\"} 0\n", text);
        Assert.Contains("lookout_paused 0\n", text);
        Assert.DoesNotContain("\r", text);
    }

    [Fact]
    public void PipeMessagesRoundTripAsCamelCaseJson()
    {
        var request = JsonSerializer.Serialize(new PipeRequest(PipeCommand.Pause, 60), Json.Options);
        Assert.Contains("\"command\": \"Pause\"", request);
        var back = JsonSerializer.Deserialize<PipeRequest>(request, Json.Options);
        Assert.Equal(60, back!.Minutes);

        var response = new PipeResponse(true, null, Report([Component("a")]));
        var json = JsonSerializer.Serialize(response, Json.Options);
        var parsed = JsonSerializer.Deserialize<PipeResponse>(json, Json.Options)!;
        Assert.Equal(Overall.Healthy, parsed.Status!.Overall);
        Assert.Equal("tallboy", parsed.Status.Host);
    }
}
