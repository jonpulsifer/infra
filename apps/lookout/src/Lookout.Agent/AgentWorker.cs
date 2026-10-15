using System.Text.Json;

namespace Lookout.Agent;

/// <summary>
/// The loop: fetch the policy, observe the three agents, converge what drifted
/// unless paused, then write status.json, the textfile metric and the log.
/// </summary>
public sealed class AgentWorker(ISystem system, AgentSettings settings, AgentState state, ILogger<AgentWorker> log) : BackgroundService
{
    private static readonly TimeSpan RetryInterval = TimeSpan.FromMinutes(15);

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        log.LogInformation("Lookout {Version} starting; policy from {Url}", AgentSettings.Version, settings.PolicyUrl);
        var force = false;
        while (!ct.IsCancellationRequested)
        {
            var interval = RetryInterval;
            try
            {
                interval = await PassAsync(force, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception e)
            {
                log.LogError(e, "sync pass failed");
            }
            force = await state.WaitAsync(interval, ct);
        }
    }

    private async Task<TimeSpan> PassAsync(bool force, CancellationToken ct)
    {
        var now = system.Now;
        var (bundle, policyError) = await new PolicyLoader(system, settings.PolicyUrl).LoadAsync(ct);
        if (policyError is not null) log.LogWarning("policy: {Error}", policyError);

        if (bundle is null)
        {
            Publish(new StatusReport(AgentSettings.Version, Hostname, now, state.Latest?.LastSyncAt, false, false,
                null, state.PausedUntil, state.Latest?.RebootPending ?? false, [], [], [policyError ?? "no policy"]));
            return RetryInterval;
        }

        var paused = state.IsPaused(now) && !force;
        var result = await Reconciler.ForWindows(system).RunAsync(bundle, converge: !paused, ct);

        foreach (var action in result.Actions) log.LogInformation("{Action}", action);
        foreach (var error in result.Errors) log.LogError("{Error}", error);
        foreach (var c in result.Components.Where(c => !c.Current || !c.Healthy))
        {
            log.LogWarning("{Component}: {Problems}", c.Component, string.Join("; ", c.Problems));
        }

        var report = new StatusReport(
            AgentSettings.Version, Hostname, system.Now, system.Now, result.Ok, policyError is null, bundle.Source,
            state.PausedUntil, result.RebootPending || (state.Latest?.RebootPending ?? false),
            result.Components, result.Actions, result.Errors);
        Publish(report);
        log.LogInformation("sync done: {Summary}", report.Summary);

        return result.Ok ? TimeSpan.FromMinutes(bundle.Policy.IntervalMinutes) : RetryInterval;
    }

    private void Publish(StatusReport report)
    {
        state.Latest = report;
        try
        {
            system.CreateDirectory(Paths.StateDir(system));
            system.WriteText(Paths.Status(system), JsonSerializer.Serialize(report, Json.Options));
            system.CreateDirectory(Paths.TextfileDir(system));
            system.WriteText(Paths.TextfileMetrics(system), Textfile.Render(report));
        }
        catch (Exception e)
        {
            log.LogError(e, "could not write the status files");
        }
    }

    private static string Hostname => Environment.MachineName.ToLowerInvariant();
}
