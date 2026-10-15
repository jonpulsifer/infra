using System.Windows;

namespace Lookout.Tray;

public partial class App : System.Windows.Application
{
    private TrayIcon? tray;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        tray = new TrayIcon(new PipeClient(), new Toasts());
        tray.Start();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        tray?.Dispose();
        base.OnExit(e);
    }
}
