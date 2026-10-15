using System.Globalization;
using System.Text;

namespace Lookout;

public enum Overall
{
    /// <summary>Every component is current and answering.</summary>
    Healthy,
    /// <summary>Something drifted, a sync failed, or a reboot is pending. Nothing is down.</summary>
    Attention,
    /// <summary>A component is not answering.</summary>
    Down,
}

/// <summary>What the agent knows after its last pass. Written to status.json and served on the pipe.</summary>
public sealed record StatusReport(
    string AgentVersion,
    string Host,
    DateTimeOffset GeneratedAt,
    DateTimeOffset? LastSyncAt,
    bool LastSyncOk,
    bool PolicyFetchOk,
    string? PolicySource,
    DateTimeOffset? PausedUntil,
    bool RebootPending,
    IReadOnlyList<ComponentState> Components,
    IReadOnlyList<string> Actions,
    IReadOnlyList<string> Errors)
{
    public bool Paused => PausedUntil is { } until && until > GeneratedAt;

    public Overall Overall
    {
        get
        {
            if (Components.Count == 0 || Components.Any(c => !c.Healthy)) return Overall.Down;
            if (!LastSyncOk || !PolicyFetchOk || RebootPending || Components.Any(c => !c.Current)) return Overall.Attention;
            return Overall.Healthy;
        }
    }

    public string Summary => Overall switch
    {
        Overall.Healthy => "All agents current",
        Overall.Down => $"Down: {string.Join(", ", Components.Where(c => !c.Healthy).Select(c => c.Component))}",
        _ => string.Join("; ", Attention()),
    };

    private IEnumerable<string> Attention()
    {
        if (RebootPending) yield return "reboot pending";
        if (!PolicyFetchOk) yield return "policy fetch failed";
        if (!LastSyncOk) yield return "last sync failed";
        foreach (var c in Components.Where(c => !c.Current)) yield return $"{c.Component} drifted";
    }
}

/// <summary>Renders the agent's own metrics for windows_exporter's textfile collector.</summary>
public static class Textfile
{
    public static string Render(StatusReport status)
    {
        var sb = new StringBuilder();
        void Gauge(string name, string help, string labels, double value)
        {
            sb.Append("# HELP ").Append(name).Append(' ').Append(help).Append('\n');
            sb.Append("# TYPE ").Append(name).Append(" gauge\n");
            sb.Append(name).Append(labels).Append(' ').Append(value.ToString("R", CultureInfo.InvariantCulture)).Append('\n');
        }

        Gauge("lookout_info", "The Lookout agent build.", $"{{version=\"{status.AgentVersion}\"}}", 1);
        Gauge("lookout_last_sync_timestamp_seconds", "When the agent last finished a sync.", "",
            status.LastSyncAt?.ToUnixTimeSeconds() ?? 0);
        Gauge("lookout_last_sync_success", "1 when the last sync converged every component without error.", "", status.LastSyncOk ? 1 : 0);
        Gauge("lookout_policy_fetch_success", "1 when the last policy fetch from git succeeded.", "", status.PolicyFetchOk ? 1 : 0);
        Gauge("lookout_paused", "1 while the owner has paused convergence.", "", status.Paused ? 1 : 0);
        Gauge("lookout_reboot_pending", "1 when an installer asked for a reboot.", "", status.RebootPending ? 1 : 0);

        foreach (var c in status.Components)
        {
            var labels = $"{{component=\"{c.Component}\"}}";
            Gauge("lookout_component_current", "1 when the component runs the declared version and configuration.", labels, c.Current ? 1 : 0);
            Gauge("lookout_component_healthy", "1 when the component runs and answers.", labels, c.Healthy ? 1 : 0);
        }
        return sb.ToString();
    }
}
