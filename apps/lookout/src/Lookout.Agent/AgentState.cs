namespace Lookout.Agent;

/// <summary>The latest report, the pause deadline, and the signal the pipe uses to ask for a sync.</summary>
public sealed class AgentState
{
    private readonly Lock gate = new();
    private readonly SemaphoreSlim wake = new(0);
    private StatusReport? latest;
    private DateTimeOffset? pausedUntil;
    private bool forceNext;

    public StatusReport? Latest
    {
        get { lock (gate) return latest; }
        set { lock (gate) latest = value; }
    }

    public DateTimeOffset? PausedUntil
    {
        get { lock (gate) return pausedUntil; }
        set { lock (gate) pausedUntil = value; }
    }

    public bool IsPaused(DateTimeOffset now) => PausedUntil is { } until && until > now;

    /// <summary>Asks the worker for a pass now. A forced pass converges even while paused.</summary>
    public void RequestSync(bool force)
    {
        lock (gate) forceNext |= force;
        wake.Release();
    }

    /// <summary>Waits for the interval or a request, whichever is first. Returns whether the pass is forced.</summary>
    public async Task<bool> WaitAsync(TimeSpan interval, CancellationToken ct)
    {
        await wake.WaitAsync(interval, ct);
        while (wake.CurrentCount > 0) wake.Wait(0, ct);
        lock (gate)
        {
            var force = forceNext;
            forceNext = false;
            return force;
        }
    }
}
