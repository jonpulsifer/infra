using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;

namespace Lookout.Agent;

/// <summary>
/// Serves the tray on the named pipe. The service runs as SYSTEM and the tray
/// as the signed-in user, so the ACL lets authenticated users read and write.
/// </summary>
public sealed class PipeServer(ISystem system, AgentState state, ILogger<PipeServer> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                using var server = Create();
                await server.WaitForConnectionAsync(ct);
                await ServeAsync(server, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception e)
            {
                log.LogWarning(e, "pipe connection failed");
                await Task.Delay(TimeSpan.FromSeconds(1), ct);
            }
        }
    }

    private static NamedPipeServerStream Create()
    {
        var security = new PipeSecurity();
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null),
            PipeAccessRights.ReadWrite, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            PipeAccessRights.FullControl, AccessControlType.Allow));
        return NamedPipeServerStreamAcl.Create(Pipe.Name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous, 0, 0, security);
    }

    private async Task ServeAsync(NamedPipeServerStream server, CancellationToken ct)
    {
        using var reader = new StreamReader(server, leaveOpen: true);
        await using var writer = new StreamWriter(server, leaveOpen: true) { AutoFlush = true };

        PipeResponse response;
        try
        {
            var line = await reader.ReadLineAsync(ct) ?? throw new InvalidDataException("empty request");
            var request = JsonSerializer.Deserialize<PipeRequest>(line, Json.Options) ?? throw new InvalidDataException("bad request");
            response = Handle(request);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            response = new PipeResponse(false, e.Message, state.Latest);
        }

        await writer.WriteLineAsync(JsonSerializer.Serialize(response, Json.Options).ReplaceLineEndings(" "));
        server.WaitForPipeDrain();
    }

    private PipeResponse Handle(PipeRequest request)
    {
        switch (request.Command)
        {
            case PipeCommand.Status:
                break;
            case PipeCommand.Sync:
                state.RequestSync(force: true);
                break;
            case PipeCommand.Pause:
                var minutes = request.Minutes is > 0 and <= 24 * 60 ? request.Minutes.Value : 60;
                state.PausedUntil = system.Now.AddMinutes(minutes);
                log.LogInformation("paused for {Minutes} minutes", minutes);
                state.RequestSync(force: false);
                break;
            case PipeCommand.Resume:
                state.PausedUntil = null;
                log.LogInformation("resumed");
                state.RequestSync(force: false);
                break;
            default:
                return new PipeResponse(false, $"unknown command {request.Command}", state.Latest);
        }
        var latest = state.Latest is { } r ? r with { PausedUntil = state.PausedUntil, GeneratedAt = system.Now } : null;
        return new PipeResponse(true, null, latest);
    }
}
