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
        void Family(string name, string help, params (string Labels, double Value)[] samples)
        {
            // One HELP and TYPE per metric name: the text parser rejects a second pair.
            sb.Append("# HELP ").Append(name).Append(' ').Append(help).Append('\n');
            sb.Append("# TYPE ").Append(name).Append(" gauge\n");
            foreach (var (labels, value) in samples)
            {
                sb.Append(name).Append(labels).Append(' ').Append(value.ToString("R", CultureInfo.InvariantCulture)).Append('\n');
            }
        }
        static string ComponentLabels(ComponentState c) => $"{{component=\"{c.Component}\"}}";

        Family("lookout_info", "The Lookout agent build.", ($"{{version=\"{status.AgentVersion}\"}}", 1));
        Family("lookout_last_sync_timestamp_seconds", "When the agent last finished a sync.",
            ("", status.LastSyncAt?.ToUnixTimeSeconds() ?? 0));
        Family("lookout_last_sync_success", "1 when the last sync converged every component without error.", ("", status.LastSyncOk ? 1 : 0));
        Family("lookout_policy_fetch_success", "1 when the last policy fetch from git succeeded.", ("", status.PolicyFetchOk ? 1 : 0));
        Family("lookout_paused", "1 while the owner has paused convergence.", ("", status.Paused ? 1 : 0));
        Family("lookout_reboot_pending", "1 when an installer asked for a reboot.", ("", status.RebootPending ? 1 : 0));
        Family("lookout_component_current", "1 when the component runs the declared version and configuration.",
            status.Components.Select(c => (ComponentLabels(c), c.Current ? 1.0 : 0)).ToArray());
        Family("lookout_component_healthy", "1 when the component runs and answers.",
            status.Components.Select(c => (ComponentLabels(c), c.Healthy ? 1.0 : 0)).ToArray());
        return sb.ToString();
    }
}
