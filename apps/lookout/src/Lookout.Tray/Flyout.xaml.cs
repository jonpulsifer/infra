using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using Brush = System.Windows.Media.Brush;
using Color = System.Windows.Media.Color;

namespace Lookout.Tray;

/// <summary>
/// The panel above the tray, in the manner of the Wi-Fi and battery flyouts:
/// one card per agent, the last sync, and the actions. It hides when it loses
/// focus. Windows draws its acrylic backdrop and rounded corners.
/// </summary>
public partial class Flyout : Window
{
    private const string GrafanaBase = "https://grafana.lolwtf.ca/d/windows-desktops";
    private const int Gap = 12;

    // A click on the tray icon deactivates an open flyout before the click arrives.
    private static readonly TimeSpan ClickSlack = TimeSpan.FromMilliseconds(400);

    private readonly Func<PipeRequest, Task> send;
    private StatusReport? latest;
    private DateTimeOffset hiddenAt = DateTimeOffset.MinValue;

    public Flyout(Func<PipeRequest, Task> send)
    {
        this.send = send;
        InitializeComponent();
        Deactivated += (_, _) =>
        {
            hiddenAt = DateTimeOffset.Now;
            Hide();
        };
        SizeChanged += (_, _) => Place();
    }

    public void Toggle()
    {
        if (IsVisible)
        {
            Hide();
            return;
        }
        if (DateTimeOffset.Now - hiddenAt < ClickSlack) return;
        Place();
        Show();
        Activate();
    }

    public void Update(StatusReport? status, bool reachable)
    {
        latest = status;
        var overall = reachable ? status?.Overall : null;
        OverallDot.Fill = StatusColors.Brush(overall);
        Headline.Text = overall switch
        {
            null => "Service not reachable",
            Overall.Healthy => "All agents current",
            Overall.Attention => "Needs attention",
            Overall.Down => "An agent is down",
            _ => "Lookout",
        };
        Subline.Text = overall is null ? "The tray cannot reach the Lookout service." : status!.Summary;

        Components.ItemsSource = (status?.Components ?? []).Select(c => new ComponentRow(
            c.Component,
            StatusColors.Brush(!c.Healthy ? Overall.Down : c.Current ? Overall.Healthy : Overall.Attention),
            c.Problems.Count > 0 ? string.Join("\n", c.Problems) : $"{c.InstalledVersion ?? "not installed"}",
            !c.Healthy ? "down" : c.Current ? "current" : "drifted")).ToList();

        Meta.Text = status is null ? "" : string.Join("  ·  ", MetaParts(status));
        PauseButton.Content = status?.Paused == true ? $"Resume (until {status.PausedUntil:HH:mm})" : "Pause for 1 hour";
        PauseButton.IsEnabled = reachable;
        SyncButton.IsEnabled = reachable;
    }

    private static IEnumerable<string> MetaParts(StatusReport status)
    {
        yield return status.LastSyncAt is { } at ? $"Synced {Ago(at)}" : "Never synced";
        if (status.RebootPending) yield return "reboot pending";
        if (!status.PolicyFetchOk) yield return "policy from cache";
        yield return $"agent {status.AgentVersion}";
    }

    private static string Ago(DateTimeOffset at)
    {
        var span = DateTimeOffset.Now - at;
        return span.TotalSeconds < 90 ? "just now"
            : span.TotalMinutes < 90 ? $"{(int)span.TotalMinutes} min ago"
            : span.TotalHours < 36 ? $"{(int)span.TotalHours} h ago"
            : $"{(int)span.TotalDays} d ago";
    }

    private void Place()
    {
        // The corner of the work area that the taskbar sits against.
        var area = SystemParameters.WorkArea;
        var screen = SystemParameters.PrimaryScreenHeight;
        var height = ActualHeight > 0 ? ActualHeight : 320;
        Left = area.Right - Width - Gap;
        Top = area.Top > 0 && area.Bottom >= screen ? area.Top + Gap : area.Bottom - height - Gap;
    }

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        var source = (HwndSource)PresentationSource.FromVisual(this)!;
        source.CompositionTarget.BackgroundColor = Colors.Transparent;
        Dwm.Dress(source.Handle);
    }

    protected override void OnContentRendered(EventArgs e)
    {
        base.OnContentRendered(e);
        // The theme applies its own backdrop on first render; ours goes on after it.
        Dwm.Dress(new WindowInteropHelper(this).Handle);
    }

    private async void OnSync(object sender, RoutedEventArgs e) => await send(new PipeRequest(PipeCommand.Sync));

    private async void OnPause(object sender, RoutedEventArgs e) => await send(latest?.Paused == true
        ? new PipeRequest(PipeCommand.Resume)
        : new PipeRequest(PipeCommand.Pause, 60));

    private void OnGrafana(object sender, RoutedEventArgs e)
        => Open($"{GrafanaBase}?var-instance={latest?.Host ?? Environment.MachineName.ToLowerInvariant()}");

    private void OnEventViewer(object sender, RoutedEventArgs e) => Open("eventvwr.msc");

    private void OnStatusFile(object sender, RoutedEventArgs e) => Open(Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Lookout", "status.json"));

    public static void Open(string target)
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

    private sealed record ComponentRow(string Name, Brush Dot, string Detail, string State);
}

/// <summary>The four state colours, shared by the icon badge and the flyout.</summary>
public static class StatusColors
{
    public static readonly Color Healthy = Color.FromRgb(0x2E, 0xA0, 0x43);
    public static readonly Color Attention = Color.FromRgb(0xE3, 0xA0, 0x08);
    public static readonly Color Down = Color.FromRgb(0xD1, 0x24, 0x2F);
    public static readonly Color Unknown = Color.FromRgb(0x8A, 0x8A, 0x8A);

    public static Color For(Overall? overall) => overall switch
    {
        Overall.Healthy => Healthy,
        Overall.Attention => Attention,
        Overall.Down => Down,
        _ => Unknown,
    };

    public static Brush Brush(Overall? overall)
    {
        var brush = new SolidColorBrush(For(overall));
        brush.Freeze();
        return brush;
    }
}

/// <summary>The Desktop Window Manager attributes a flyout needs on Windows 11.</summary>
public static class Dwm
{
    private const int UseImmersiveDarkMode = 20;
    private const int WindowCornerPreference = 33;
    private const int SystemBackdropType = 38;
    private const int CornerRound = 2;
    private const int BackdropTransient = 3;

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(nint hwnd, int attribute, ref int value, int size);

    public static void Dress(nint hwnd)
    {
        var dark = Theme.AppsAreDark ? 1 : 0;
        var round = CornerRound;
        var backdrop = BackdropTransient;
        // Each call fails harmlessly on a Windows that lacks the attribute.
        _ = DwmSetWindowAttribute(hwnd, UseImmersiveDarkMode, ref dark, sizeof(int));
        _ = DwmSetWindowAttribute(hwnd, WindowCornerPreference, ref round, sizeof(int));
        _ = DwmSetWindowAttribute(hwnd, SystemBackdropType, ref backdrop, sizeof(int));
    }
}

/// <summary>What Settings says about light and dark, for the parts WPF does not theme.</summary>
public static class Theme
{
    private const string Personalize = @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";

    public static bool AppsAreDark => Read("AppsUseLightTheme") == 0;

    /// <summary>The taskbar follows the system colour, not the app colour.</summary>
    public static bool TaskbarIsDark => Read("SystemUsesLightTheme") == 0;

    private static int Read(string value)
    {
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(Personalize);
            return key?.GetValue(value) as int? ?? 0;
        }
        catch (Exception)
        {
            return 0;
        }
    }
}
