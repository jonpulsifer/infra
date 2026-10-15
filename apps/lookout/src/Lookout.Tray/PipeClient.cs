using System.IO;
using System.IO.Pipes;
using System.Text.Json;

namespace Lookout.Tray;

/// <summary>One request, one response, over the agent's named pipe.</summary>
public sealed class PipeClient
{
    private static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(3);

    public async Task<PipeResponse?> SendAsync(PipeRequest request, CancellationToken ct)
    {
        try
        {
            await using var pipe = new NamedPipeClientStream(".", Pipe.Name, PipeDirection.InOut, PipeOptions.Asynchronous);
            await pipe.ConnectAsync((int)ConnectTimeout.TotalMilliseconds, ct);
            await using var writer = new StreamWriter(pipe, leaveOpen: true) { AutoFlush = true };
            using var reader = new StreamReader(pipe, leaveOpen: true);
            await writer.WriteLineAsync(JsonSerializer.Serialize(request, Json.Options).ReplaceLineEndings(" "));
            var line = await reader.ReadLineAsync(ct);
            return line is null ? null : JsonSerializer.Deserialize<PipeResponse>(line, Json.Options);
        }
        catch (Exception e) when (e is TimeoutException or IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }
}
