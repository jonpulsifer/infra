namespace Lookout;

/// <summary>
/// Installs the MSI the policy names when its version differs from the
/// running agent. msiexec is started and not awaited: the install stops the
/// Lookout service, replaces the files and starts it again, so the pass that
/// started it never returns.
/// </summary>
public sealed class AgentUpdater(ISystem system, string runningVersion)
{
    /// <summary>Returns what was started, or null when the agent is current.</summary>
    public async Task<string?> UpdateAsync(Policy policy, CancellationToken ct)
    {
        if (policy.Agent is not { } agent || agent.Version == runningVersion) return null;

        var downloaded = await system.DownloadFileAsync(new Uri(agent.Url), agent.Sha256, ".msi", ct);
        var msi = Paths.UpdateMsi(system);
        system.CreateDirectory(Paths.StateDir(system));
        system.DeleteFile(msi);
        system.MoveFile(downloaded, msi);
        system.StartDetached("msiexec.exe", $"/i \"{msi}\" /qn /norestart");
        return $"upgrading {runningVersion} to {agent.Version}";
    }
}
