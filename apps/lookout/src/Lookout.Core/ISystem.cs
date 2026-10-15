namespace Lookout;

/// <summary>
/// Everything the reconcilers do to the machine goes through here, so Core
/// compiles and tests anywhere and the agent supplies the Windows half.
/// </summary>
public interface ISystem
{
    string ProgramFiles { get; }
    string ProgramData { get; }
    DateTimeOffset Now { get; }

    bool FileExists(string path);
    string? ReadText(string path);
    void WriteText(string path, string content);
    void CreateDirectory(string path);
    void DeleteFile(string path);
    string TempFile(string extension);
    void ExtractZip(string zipPath, string destination);

    /// <summary>The file's ProductVersion resource, or null when the file is missing or has none.</summary>
    string? FileProductVersion(string path);

    ServiceInfo? QueryService(string name);
    Task StopServiceAsync(string name, CancellationToken ct);
    Task StartServiceAsync(string name, CancellationToken ct);
    bool ProcessRunning(string imageName);

    /// <summary>Runs a program with a raw command line and waits for it.</summary>
    Task<ProcessResult> RunAsync(string file, string arguments, CancellationToken ct);

    Task<string> DownloadTextAsync(Uri url, CancellationToken ct);

    /// <summary>Downloads to a temp file and verifies the SHA256 before returning its path.</summary>
    Task<string> DownloadFileAsync(Uri url, string sha256, string extension, CancellationToken ct);

    Task<bool> HttpOkAsync(Uri url, CancellationToken ct);
}

public sealed record ProcessResult(int ExitCode, string Stdout, string Stderr);

public sealed record ServiceInfo(string Name, string BinaryPath, bool Running);

public sealed class HashMismatchException(Uri url, string expected, string actual)
    : Exception($"hash mismatch for {url}: expected {expected}, got {actual}");

public static class Paths
{
    public const string ExporterService = "windows_exporter";
    public const string OhmService = "OhmGraphite";
    public const string VectorTask = "Vector";
    public const string VectorProcess = "vector";

    public static string ExporterDir(ISystem s) => Path.Combine(s.ProgramFiles, "windows_exporter");
    public static string ExporterExe(ISystem s) => Path.Combine(ExporterDir(s), "windows_exporter.exe");
    public static string TextfileDir(ISystem s) => Path.Combine(ExporterDir(s), "textfile_inputs");
    public static string TextfileMetrics(ISystem s) => Path.Combine(TextfileDir(s), "lookout.prom");

    public static string OhmDir(ISystem s) => Path.Combine(s.ProgramFiles, "OhmGraphite");
    public static string OhmExe(ISystem s) => Path.Combine(OhmDir(s), "OhmGraphite.exe");
    public static string OhmConfig(ISystem s) => Path.Combine(OhmDir(s), "OhmGraphite.exe.config");

    public static string VectorExe(ISystem s) => Path.Combine(s.ProgramFiles, "Vector", "bin", "vector.exe");
    public static string VectorConfig(ISystem s) => Path.Combine(s.ProgramFiles, "Vector", "config", "vector.yaml");
    public static string VectorData(ISystem s) => Path.Combine(s.ProgramData, "vector");

    public static string StateDir(ISystem s) => Path.Combine(s.ProgramData, "Lookout");
    public static string PolicyCache(ISystem s) => Path.Combine(StateDir(s), "policy.json");
    public static string OhmConfigCache(ISystem s) => Path.Combine(StateDir(s), "OhmGraphite.exe.config");
    public static string VectorConfigCache(ISystem s) => Path.Combine(StateDir(s), "vector.yaml");
    public static string Status(ISystem s) => Path.Combine(StateDir(s), "status.json");
    public static string Settings(ISystem s) => Path.Combine(StateDir(s), "settings.json");
}
