using System.Diagnostics;
using System.IO;
using System.Drawing;
using System.Windows.Forms;
using System.Windows.Threading;

namespace Lookout.Tray;

/// <summary>
/// The icon, its menu, and the poll that colours it. Green is every agent
/// current and answering, amber is drift or a failed sync, red is an agent
/// down, grey is no Lookout service to ask.
/// </summary>
public sealed class TrayIcon(PipeClient client) : IDisposable
{
    private const string GrafanaBase = "https://grafana.lolwtf.ca/d/windows-desktops";
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(30);

    private readonly NotifyIcon icon = new() { Visible = true, Text = "Lookout" };
    private readonly Dictionary<int, Icon> icons = new();
    private readonly DispatcherTimer timer = new() { Interval = PollInterval };
    private readonly ToolStripMenuItem summary = new("Starting") { Enabled = false };
    private readonly ToolStripMenuItem detail = new() { Enabled = false, Visible = false };
    private readonly ToolStripMenuItem pause = new("Pause for 1 hour");
    private Toasts? toasts;
    private StatusReport? latest;
    private Overall? shown;
    private bool announced;
    private bool reachable = true;

    public void Start()
    {
        toasts = new Toasts((title, body) => icon.ShowBalloonTip(10_000, title, body, ToolTipIcon.None));
        var menu = new ContextMenuStrip();
        menu.Items.Add(summary);
        menu.Items.Add(detail);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Sync now", null, async (_, _) => await SendAsync(new PipeRequest(PipeCommand.Sync)));
        pause.Click += async (_, _) => await SendAsync(latest?.Paused == true
            ? new PipeRequest(PipeCommand.Resume)
            : new PipeRequest(PipeCommand.Pause, 60));
        menu.Items.Add(pause);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Open Grafana", null, (_, _) => Open($"{GrafanaBase}?var-instance={latest?.Host ?? Environment.MachineName.ToLowerInvariant()}"));
        menu.Items.Add("Open Event Viewer", null, (_, _) => Open("eventvwr.msc"));
        menu.Items.Add("Open status file", null, (_, _) => Open(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Lookout", "status.json")));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => System.Windows.Application.Current.Shutdown());
        icon.ContextMenuStrip = menu;
        icon.DoubleClick += async (_, _) => await SendAsync(new PipeRequest(PipeCommand.Sync));

        Render();
        timer.Tick += async (_, _) => await PollAsync();
        timer.Start();
        _ = PollAsync();
    }

    private async Task PollAsync() => Apply(await client.SendAsync(new PipeRequest(PipeCommand.Status), CancellationToken.None));

    private async Task SendAsync(PipeRequest request) => Apply(await client.SendAsync(request, CancellationToken.None));

    private void Apply(PipeResponse? response)
    {
        var wasReachable = reachable;
        reachable = response is not null;
        if (response?.Status is { } status) latest = status;

        var now = latest?.Overall;
        if (!reachable) now = null;
        if (now != shown || wasReachable != reachable)
        {
            Notify(now);
            shown = now;
        }
        Render();
    }

    private void Notify(Overall? overall)
    {
        var first = !announced;
        announced = true;
        if (first && overall is Overall.Healthy) return;
        var (title, body) = overall switch
        {
            null => ("Lookout service not running", "The tray cannot reach the Lookout service."),
            Overall.Healthy => ("Monitoring healthy", "Every agent is current and answering."),
            Overall.Attention => ("Monitoring needs attention", latest?.Summary ?? ""),
            Overall.Down => ("Monitoring agent down", latest?.Summary ?? ""),
            _ => ("Lookout", ""),
        };
        toasts?.Show(title, body);
    }

    private void Render()
    {
        var overall = reachable ? latest?.Overall : null;
        icon.Icon = IconFor(overall);
        var text = overall switch
        {
            null => "Lookout: service not reachable",
            _ => $"Lookout: {latest!.Summary}",
        };
        if (latest?.Paused == true) text += " (paused)";
        icon.Text = text.Length > 127 ? text[..127] : text;

        summary.Text = overall is null ? "Service not reachable" : latest!.Summary;
        var problems = latest?.Components.SelectMany(c => c.Problems.Select(p => $"{c.Component}: {p}")).ToList() ?? [];
        detail.Text = string.Join("\n", problems);
        detail.Visible = problems.Count > 0;
        pause.Text = latest?.Paused == true ? $"Resume (paused until {latest.PausedUntil:HH:mm})" : "Pause for 1 hour";
        pause.Enabled = reachable;
    }

    private Icon IconFor(Overall? overall)
    {
        var key = overall is { } o ? (int)o : -1;
        if (icons.TryGetValue(key, out var cached)) return cached;
        var color = overall switch
        {
            Overall.Healthy => Color.FromArgb(0x2E, 0xA0, 0x43),
            Overall.Attention => Color.FromArgb(0xE3, 0xA0, 0x08),
            Overall.Down => Color.FromArgb(0xD1, 0x24, 0x2F),
            _ => Color.FromArgb(0x8A, 0x8A, 0x8A),
        };
        using var bitmap = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bitmap))
        using (var brush = new SolidBrush(color))
        using (var ring = new Pen(Color.FromArgb(0x60, 0, 0, 0), 2))
        {
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            g.FillEllipse(brush, 4, 4, 24, 24);
            g.DrawEllipse(ring, 4, 4, 24, 24);
        }
        var created = Icon.FromHandle(bitmap.GetHicon());
        icons[key] = created;
        return created;
    }

    private static void Open(string target)
    {
        try
        {
            Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
        }
        catch (Exception)
        {
            // A missing status file or a box without a browser is not the tray's problem.
        }
    }

    public void Dispose()
    {
        timer.Stop();
        icon.Visible = false;
        icon.Dispose();
        foreach (var i in icons.Values) i.Dispose();
    }
}
