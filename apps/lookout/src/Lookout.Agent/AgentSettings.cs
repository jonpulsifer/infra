using System.Reflection;
using System.Text.Json;

namespace Lookout.Agent;

/// <summary>
/// Where the policy comes from. C:\ProgramData\Lookout\settings.json overrides
/// the default, which is the policy on main.
/// </summary>
public sealed record AgentSettings(Uri PolicyUrl)
{
    public const string DefaultPolicyUrl = "https://raw.githubusercontent.com/jonpulsifer/infra/main/apps/lookout/policy/policy.json";

    public static readonly string Version =
        Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0.0.0";

    public static AgentSettings Load(ISystem system)
    {
        var json = system.ReadText(Paths.Settings(system));
        if (json is null) return new AgentSettings(new Uri(DefaultPolicyUrl));
        var file = JsonSerializer.Deserialize<SettingsFile>(json, Json.Options);
        var url = string.IsNullOrWhiteSpace(file?.PolicyUrl) ? DefaultPolicyUrl : file.PolicyUrl;
        return new AgentSettings(new Uri(url));
    }

    private sealed record SettingsFile(string? PolicyUrl);
}
