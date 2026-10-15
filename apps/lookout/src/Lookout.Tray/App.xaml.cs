using System.Runtime.InteropServices;
using System.Windows;

namespace Lookout.Tray;

public partial class App : System.Windows.Application
{
    private TrayIcon? tray;

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        // The same id as the Start menu shortcut, so notifications are attributed to it.
        _ = SetCurrentProcessExplicitAppUserModelID(Toasts.AppUserModelId);
        tray = new TrayIcon(new PipeClient());
        tray.Start();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        tray?.Dispose();
        base.OnExit(e);
    }
}
