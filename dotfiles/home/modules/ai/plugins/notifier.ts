import { type Plugin } from "@opencode-ai/plugin";

export const NotifierPlugin: Plugin = async ({ $, project }) => {
  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") {
        return;
      }

      const title = "OpenCode Task Complete";
      const message = `Project: ${project.name || "Current Directory"}`;
      const isDarwin = process.platform === "darwin";

      if (isDarwin) {
        const escapedTitle = title.replace(/'/g, "''");
        const escapedMessage = message.replace(/'/g, "''");
        await $`osascript -e 'display notification "${escapedMessage}" with title "${escapedTitle}" sound name "Glass"'`;
        return;
      }

      await $`powershell.exe -Command "[System.Media.SystemSounds]::Asterisk.Play()"`.nothrow();
      const psCommand = `
        [void] [System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');
        $notification = New-Object System.Windows.Forms.NotifyIcon;
        $notification.Icon = [System.Drawing.SystemIcons]::Information;
        $notification.BalloonTipTitle = '${title}';
        $notification.BalloonTipText = '${message}';
        $notification.Visible = $True;
        $notification.ShowBalloonTip(5000);
      `;
      await $`powershell.exe -Command "${psCommand.replace(/\n/g, "")}"`.nothrow();
    },
  };
};
