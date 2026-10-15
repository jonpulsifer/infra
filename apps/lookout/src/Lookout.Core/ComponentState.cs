namespace Lookout;

/// <summary>What one component looks like right now, against the policy.</summary>
public sealed record ComponentState(
    string Component,
    string DesiredVersion,
    string? InstalledVersion,
    bool Installed,
    bool Configured,
    bool Healthy,
    IReadOnlyList<string> Problems)
{
    /// <summary>Installed at the declared version with the declared configuration.</summary>
    public bool Current => Installed && Configured;
}

public sealed record ConvergeResult(IReadOnlyList<string> Actions, bool RebootPending)
{
    public static readonly ConvergeResult Nothing = new([], false);
}

public interface IComponentReconciler
{
    string Name { get; }
    Task<ComponentState> ObserveAsync(PolicyBundle bundle, CancellationToken ct);
    Task<ConvergeResult> ConvergeAsync(PolicyBundle bundle, ComponentState observed, CancellationToken ct);
}

public sealed record SyncResult(
    IReadOnlyList<ComponentState> Components,
    IReadOnlyList<string> Actions,
    IReadOnlyList<string> Errors,
    bool RebootPending)
{
    public bool Ok => Errors.Count == 0;
}

/// <summary>Observes every component, converges the ones that drifted, and observes again.</summary>
public sealed class Reconciler(IReadOnlyList<IComponentReconciler> components)
{
    public static Reconciler ForWindows(ISystem system) => new(
    [
        new WindowsExporterReconciler(system),
        new OhmGraphiteReconciler(system),
        new VectorReconciler(system),
    ]);

    public async Task<SyncResult> RunAsync(PolicyBundle bundle, bool converge, CancellationToken ct)
    {
        var states = new List<ComponentState>();
        var actions = new List<string>();
        var errors = new List<string>();
        var reboot = false;

        foreach (var component in components)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                var observed = await component.ObserveAsync(bundle, ct);
                if (converge && !observed.Current)
                {
                    var result = await component.ConvergeAsync(bundle, observed, ct);
                    actions.AddRange(result.Actions.Select(a => $"{component.Name}: {a}"));
                    reboot |= result.RebootPending;
                    observed = await component.ObserveAsync(bundle, ct);
                }
                states.Add(observed);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception e)
            {
                errors.Add($"{component.Name}: {e.Message}");
                states.Add(new ComponentState(component.Name, "?", null, false, false, false, [e.Message]));
            }
        }

        return new SyncResult(states, actions, errors, reboot);
    }
}
