using System.Security;
using Windows.Data.Xml.Dom;
using Windows.UI.Notifications;

namespace Lookout.Tray;

/// <summary>
/// Windows notifications. An unpackaged app sends them under the
/// AppUserModelID that the installer puts on the Start menu shortcut. When
/// that fails, the tray icon's balloon tip is the notification instead.
/// </summary>
public sealed class Toasts(Action<string, string> fallback)
{
    public const string AppUserModelId = "lolwtf.Lookout";

    private ToastNotifier? notifier;
    private bool unavailable;

    public void Show(string title, string body)
    {
        if (unavailable)
        {
            fallback(title, body);
            return;
        }
        try
        {
            notifier ??= ToastNotificationManager.CreateToastNotifier(AppUserModelId);
            var xml = new XmlDocument();
            xml.LoadXml($"""
                <toast>
                  <visual>
                    <binding template="ToastGeneric">
                      <text>{SecurityElement.Escape(title)}</text>
                      <text>{SecurityElement.Escape(body)}</text>
                    </binding>
                  </visual>
                </toast>
                """);
            notifier.Show(new ToastNotification(xml));
        }
        catch (Exception)
        {
            unavailable = true;
            fallback(title, body);
        }
    }
}
