using System.Security;
using Windows.Data.Xml.Dom;
using Windows.UI.Notifications;

namespace Lookout.Tray;

/// <summary>Windows notifications. They need package identity, so an unpackaged run shows nothing.</summary>
public sealed class Toasts
{
    private ToastNotifier? notifier;
    private bool unavailable;

    public void Show(string title, string body)
    {
        if (unavailable) return;
        try
        {
            notifier ??= ToastNotificationManager.CreateToastNotifier();
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
        }
    }
}
