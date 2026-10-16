using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Forms;
using System.Windows.Threading;
using ContextMenu = System.Windows.Controls.ContextMenu;
using MenuItem = System.Windows.Controls.MenuItem;
using Separator = System.Windows.Controls.Separator;

namespace Lookout.Tray;

/// <summary>
/// The icon, the flyout and the poll that colours them. The glyph follows the
/// taskbar's light or dark colour; its badge is green when every agent is
/// current and answering, amber on drift or a failed sync, red when an agent
/// is down, grey when there is no Lookout service to ask. A left click opens
/// the flyout, a right click the menu.
/// </summary>
public sealed class TrayIcon(PipeClient client) : IDisposable
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(30);

    private readonly NotifyIcon icon = new() { Visible = true, Text = "Lookout" };
    private readonly Dictionary<(bool Dark, int State), Icon> icons = new();
    private readonly DispatcherTimer timer = new() { Interval = PollInterval };
    private readonly ContextMenu menu = new();
    private readonly MenuItem summary = new() { Header = "Starting", IsEnabled = false };
    private readonly MenuItem pause = new() { Header = "Pause for 1 hour" };
    private Flyout? flyout;
    private Window? menuOwner;
    private Toasts? toasts;
    private StatusReport? latest;
    private Overall? shown;
    private bool announced;
    private bool reachable = true;

    public void Start()
    {
        toasts = new Toasts((title, body) => icon.ShowBalloonTip(10_000, title, body, ToolTipIcon.None));
        flyout = new Flyout(SendAsync);

        menu.Items.Add(summary);
        menu.Items.Add(new Separator());
        menu.Items.Add(Item("Open Lookout", () => flyout.Toggle()));
        menu.Items.Add(Item("Sync now", () => _ = SendAsync(new PipeRequest(PipeCommand.Sync))));
        pause.Click += (_, _) => _ = SendAsync(latest?.Paused == true
            ? new PipeRequest(PipeCommand.Resume)
            : new PipeRequest(PipeCommand.Pause, 60));
        menu.Items.Add(pause);
        menu.Items.Add(new Separator());
        menu.Items.Add(Item("Exit", () => System.Windows.Application.Current.Shutdown()));
        menu.Closed += (_, _) => menuOwner?.Hide();

        icon.MouseUp += (_, e) =>
        {
            if (e.Button == MouseButtons.Left) flyout.Toggle();
            else if (e.Button == MouseButtons.Right) OpenMenu();
        };

        Render();
        timer.Tick += async (_, _) => await PollAsync();
        timer.Start();
        _ = PollAsync();
    }

    private static MenuItem Item(string header, Action action)
    {
        var item = new MenuItem { Header = header };
        item.Click += (_, _) => action();
        return item;
    }

    /// <summary>
    /// A WPF menu closes on an outside click only while a window of this app is
    /// active, and the tray has none, so an invisible one takes focus for it.
    /// </summary>
    private void OpenMenu()
    {
        menuOwner ??= new Window
        {
            Width = 0, Height = 0, WindowStyle = WindowStyle.None, ShowInTaskbar = false,
            AllowsTransparency = true, Background = System.Windows.Media.Brushes.Transparent, Opacity = 0, Left = -10_000,
        };
        menuOwner.Show();
        menuOwner.Activate();
        menu.Placement = PlacementMode.MousePoint;
        menu.IsOpen = true;
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
        var text = overall is null ? "Lookout: service not reachable" : $"Lookout: {latest!.Summary}";
        if (latest?.Paused == true) text += " (paused)";
        icon.Text = text.Length > 127 ? text[..127] : text;

        summary.Header = overall is null ? "Service not reachable" : latest!.Summary;
        pause.Header = latest?.Paused == true ? $"Resume (paused until {latest.PausedUntil:HH:mm})" : "Pause for 1 hour";
        pause.IsEnabled = reachable;
        flyout?.Update(latest, reachable);
    }

    /// <summary>A ring in the taskbar's foreground colour, with the state as a badge.</summary>
    private Icon IconFor(Overall? overall)
    {
        var key = (Theme.TaskbarIsDark, overall is { } o ? (int)o : -1);
        if (icons.TryGetValue(key, out var cached)) return cached;

        var glyph = key.TaskbarIsDark ? System.Drawing.Color.White : System.Drawing.Color.FromArgb(0x1B, 0x1B, 0x1B);
        var badge = StatusColors.For(overall);
        using var bitmap = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bitmap))
        using (var ring = new Pen(glyph, 3.5f))
        using (var fill = new SolidBrush(System.Drawing.Color.FromArgb(badge.R, badge.G, badge.B)))
        using (var edge = new Pen(key.TaskbarIsDark ? System.Drawing.Color.FromArgb(0x20, 0x20, 0x20) : System.Drawing.Color.White, 2))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(System.Drawing.Color.Transparent);
            g.DrawEllipse(ring, 4, 4, 20, 20);
            g.FillEllipse(fill, 17, 17, 13, 13);
            g.DrawEllipse(edge, 17, 17, 13, 13);
        }
        var created = Icon.FromHandle(bitmap.GetHicon());
        icons[key] = created;
        return created;
    }

    public void Dispose()
    {
        timer.Stop();
        icon.Visible = false;
        icon.Dispose();
        flyout?.Close();
        menuOwner?.Close();
        foreach (var i in icons.Values) i.Dispose();
    }
}
