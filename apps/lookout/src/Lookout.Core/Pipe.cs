namespace Lookout;

/// <summary>
/// The tray talks to the agent over the named pipe <c>lookout</c>: one JSON
/// request line, one JSON response line, then the agent closes.
/// </summary>
public static class Pipe
{
    public const string Name = "lookout";
}

public enum PipeCommand
{
    Status,
    Sync,
    Pause,
    Resume,
}

public sealed record PipeRequest(PipeCommand Command, int? Minutes = null);

public sealed record PipeResponse(bool Ok, string? Error, StatusReport? Status);
