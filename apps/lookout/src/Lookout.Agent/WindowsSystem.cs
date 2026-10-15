using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.ServiceProcess;
using Microsoft.Win32;

namespace Lookout.Agent;

/// <summary>The real machine.</summary>
public sealed class WindowsSystem : ISystem, IDisposable
{
    private static readonly TimeSpan ServiceWait = TimeSpan.FromSeconds(60);
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromMinutes(5) };
    private readonly HttpClient probe = new() { Timeout = TimeSpan.FromSeconds(10) };

    public string ProgramFiles => Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
    public string ProgramData => Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
    public DateTimeOffset Now => DateTimeOffset.Now;

    public bool FileExists(string path) => File.Exists(path);
    public string? ReadText(string path) => File.Exists(path) ? File.ReadAllText(path) : null;
    public void CreateDirectory(string path) => Directory.CreateDirectory(path);
    public void DeleteFile(string path) => File.Delete(path);
    public string TempFile(string extension) => Path.Combine(Path.GetTempPath(), $"lookout-{Guid.NewGuid():N}{extension}");
    public void ExtractZip(string zipPath, string destination) => ZipFile.ExtractToDirectory(zipPath, destination, overwriteFiles: true);

    public void WriteText(string path, string content)
    {
        // A reader such as the textfile collector never sees a half-written file.
        var temp = path + ".tmp";
        File.WriteAllText(temp, content, new System.Text.UTF8Encoding(false));
        File.Move(temp, path, overwrite: true);
    }

    public string? FileProductVersion(string path)
    {
        if (!File.Exists(path)) return null;
        var version = FileVersionInfo.GetVersionInfo(path).ProductVersion;
        return string.IsNullOrWhiteSpace(version) ? null : version.Trim();
    }

    public ServiceInfo? QueryService(string name)
    {
        try
        {
            using var controller = new ServiceController(name);
            var running = controller.Status == ServiceControllerStatus.Running;
            using var key = Registry.LocalMachine.OpenSubKey($@"SYSTEM\CurrentControlSet\Services\{name}");
            var path = key?.GetValue("ImagePath") as string ?? "";
            return new ServiceInfo(name, path, running);
        }
        catch (InvalidOperationException)
        {
            return null;
        }
    }

    public Task StopServiceAsync(string name, CancellationToken ct) => Task.Run(() =>
    {
        using var controller = new ServiceController(name);
        if (controller.Status is ServiceControllerStatus.Stopped or ServiceControllerStatus.StopPending)
        {
            controller.WaitForStatus(ServiceControllerStatus.Stopped, ServiceWait);
            return;
        }
        controller.Stop();
        controller.WaitForStatus(ServiceControllerStatus.Stopped, ServiceWait);
    }, ct);

    public Task StartServiceAsync(string name, CancellationToken ct) => Task.Run(() =>
    {
        using var controller = new ServiceController(name);
        if (controller.Status is ServiceControllerStatus.Running) return;
        if (controller.Status is not ServiceControllerStatus.StartPending) controller.Start();
        controller.WaitForStatus(ServiceControllerStatus.Running, ServiceWait);
    }, ct);

    public bool ProcessRunning(string imageName)
    {
        var processes = Process.GetProcessesByName(imageName);
        try
        {
            return processes.Length > 0;
        }
        finally
        {
            foreach (var p in processes) p.Dispose();
        }
    }

    public async Task<ProcessResult> RunAsync(string file, string arguments, CancellationToken ct)
    {
        var info = new ProcessStartInfo(file, arguments)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        if (Path.IsPathRooted(file)) info.WorkingDirectory = Path.GetDirectoryName(file);

        using var process = Process.Start(info) ?? throw new InvalidOperationException($"could not start {file}");
        var stdout = process.StandardOutput.ReadToEndAsync(ct);
        var stderr = process.StandardError.ReadToEndAsync(ct);
        await process.WaitForExitAsync(ct);
        return new ProcessResult(process.ExitCode, await stdout, await stderr);
    }

    public Task<string> DownloadTextAsync(Uri url, CancellationToken ct) => http.GetStringAsync(url, ct);

    public async Task<string> DownloadFileAsync(Uri url, string sha256, string extension, CancellationToken ct)
    {
        var path = TempFile(extension);
        await using (var stream = await http.GetStreamAsync(url, ct))
        await using (var file = File.Create(path))
        {
            await stream.CopyToAsync(file, ct);
        }

        string actual;
        await using (var file = File.OpenRead(path))
        {
            actual = Convert.ToHexString(await SHA256.HashDataAsync(file, ct));
        }
        if (!actual.Equals(sha256, StringComparison.OrdinalIgnoreCase))
        {
            File.Delete(path);
            throw new HashMismatchException(url, sha256.ToUpperInvariant(), actual);
        }
        return path;
    }

    public async Task<bool> HttpOkAsync(Uri url, CancellationToken ct)
    {
        try
        {
            using var response = await probe.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
            return response.IsSuccessStatusCode;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            return false;
        }
    }

    public void Dispose()
    {
        http.Dispose();
        probe.Dispose();
    }
}
