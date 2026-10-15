namespace Lookout.Tests;

/// <summary>An in-memory Windows: files, services, processes and the commands the reconcilers run.</summary>
public sealed class FakeSystem : ISystem
{
    public string ProgramFiles => @"C:\Program Files";
    public string ProgramData => @"C:\ProgramData";
    public DateTimeOffset Now { get; set; } = new(2026, 10, 15, 12, 0, 0, TimeSpan.Zero);

    public Dictionary<string, string> Files { get; } = new(StringComparer.OrdinalIgnoreCase);
    public Dictionary<string, string> Versions { get; } = new(StringComparer.OrdinalIgnoreCase);
    public Dictionary<string, ServiceInfo> Services { get; } = new(StringComparer.OrdinalIgnoreCase);
    public HashSet<string> Processes { get; } = new(StringComparer.OrdinalIgnoreCase);
    public HashSet<string> Directories { get; } = new(StringComparer.OrdinalIgnoreCase);
    public Dictionary<string, string> Downloads { get; } = new();
    public HashSet<string> OkUrls { get; } = new();
    public HashSet<string> FirewallRules { get; } = new(StringComparer.OrdinalIgnoreCase);
    public HashSet<string> Tasks { get; } = new(StringComparer.OrdinalIgnoreCase);
    public List<string> Commands { get; } = new();
    public List<string> Extracted { get; } = new();
    /// <summary>A test hook. Returning null falls through to the built-in behaviour.</summary>
    public Func<string, string, ProcessResult?>? OnRun { get; set; }
    public int MsiExit { get; set; }

    private int tempCounter;

    public bool FileExists(string path) => Files.ContainsKey(path) || Versions.ContainsKey(path);
    public string? ReadText(string path) => Files.GetValueOrDefault(path);
    public void WriteText(string path, string content) => Files[path] = content;
    public void CreateDirectory(string path) => Directories.Add(path);
    public void DeleteFile(string path) => Files.Remove(path);
    public string TempFile(string extension) => $@"C:\Temp\lookout-{++tempCounter}{extension}";
    public void ExtractZip(string zipPath, string destination) => Extracted.Add($"{zipPath} -> {destination}");
    public string? FileProductVersion(string path) => Versions.GetValueOrDefault(path);
    public ServiceInfo? QueryService(string name) => Services.GetValueOrDefault(name);

    public Task StopServiceAsync(string name, CancellationToken ct)
    {
        Commands.Add($"stop-service {name}");
        if (Services.TryGetValue(name, out var s)) Services[name] = s with { Running = false };
        return Task.CompletedTask;
    }

    public Task StartServiceAsync(string name, CancellationToken ct)
    {
        Commands.Add($"start-service {name}");
        if (Services.TryGetValue(name, out var s)) Services[name] = s with { Running = true };
        return Task.CompletedTask;
    }

    public bool ProcessRunning(string imageName) => Processes.Contains(imageName);

    public Task<ProcessResult> RunAsync(string file, string arguments, CancellationToken ct)
    {
        var line = $"{file} {arguments}";
        Commands.Add(line);
        if (OnRun?.Invoke(file, arguments) is { } hooked) return Task.FromResult(hooked);

        if (file == "msiexec.exe") return Task.FromResult(new ProcessResult(MsiExit, "", ""));
        if (file == "netsh.exe")
        {
            var name = arguments.Split("name=\"")[1].Split('"')[0];
            if (arguments.Contains("add rule")) FirewallRules.Add(name);
            return Task.FromResult(new ProcessResult(FirewallRules.Contains(name) ? 0 : 1, "", ""));
        }
        if (file == "schtasks.exe")
        {
            var name = arguments.Split("/TN \"")[1].Split('"')[0];
            if (arguments.StartsWith("/Create")) Tasks.Add(name);
            var exists = Tasks.Contains(name);
            if (arguments.StartsWith("/Run") && exists) Processes.Add("vector");
            return Task.FromResult(new ProcessResult(exists ? 0 : 1, "", ""));
        }
        if (file.EndsWith("OhmGraphite.exe") && arguments == "install")
        {
            Services["OhmGraphite"] = new ServiceInfo("OhmGraphite", file, false);
            return Task.FromResult(new ProcessResult(0, "", ""));
        }
        return Task.FromResult(new ProcessResult(0, "", ""));
    }

    public Task<string> DownloadTextAsync(Uri url, CancellationToken ct)
        => Downloads.TryGetValue(url.ToString(), out var text)
            ? Task.FromResult(text)
            : throw new HttpRequestException($"404 {url}");

    public Task<string> DownloadFileAsync(Uri url, string sha256, string extension, CancellationToken ct)
    {
        Commands.Add($"download {url} {sha256}");
        var path = TempFile(extension);
        Files[path] = "binary";
        return Task.FromResult(path);
    }

    public Task<bool> HttpOkAsync(Uri url, CancellationToken ct) => Task.FromResult(OkUrls.Contains(url.ToString()));

    public void InstallEverything(PolicyBundle bundle)
    {
        var p = bundle.Policy;
        Versions[Paths.ExporterExe(this)] = p.WindowsExporter.Version;
        Services["windows_exporter"] = new ServiceInfo("windows_exporter",
            $"\"{Paths.ExporterExe(this)}\" --log.file eventlog --collectors.enabled \"{p.WindowsExporter.Collectors}\"", true);
        OkUrls.Add($"http://127.0.0.1:{p.WindowsExporter.Port}/metrics");

        Versions[Paths.OhmExe(this)] = p.OhmGraphite.Version;
        Services["OhmGraphite"] = new ServiceInfo("OhmGraphite", Paths.OhmExe(this), true);
        Files[Paths.OhmConfig(this)] = bundle.OhmGraphiteConfig;
        FirewallRules.Add("OhmGraphite");
        OkUrls.Add($"http://127.0.0.1:{p.OhmGraphite.Port}/metrics/");

        Files[Paths.VectorExe(this)] = "exe";
        Files[Paths.VectorConfig(this)] = bundle.VectorConfig;
        Tasks.Add("Vector");
        Processes.Add("vector");
        OnRun = (file, args) => file.EndsWith("vector.exe") && args == "--version"
            ? new ProcessResult(0, $"vector {p.Vector.Version} (x86_64-pc-windows-msvc)\n", "")
            : null;
    }
}

public static class Fixtures
{
    public static string PolicyJson => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "policy.json"));

    public static PolicyBundle Bundle() => new(Policy.Parse(PolicyJson), "<ohm config/>", "sinks: {}\n", "test");
}
