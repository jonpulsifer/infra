using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Lookout;

/// <summary>
/// The desired state of the three monitoring agents, as git declares it in
/// apps/lookout/policy/policy.json. The agent fetches it from main.
/// </summary>
public sealed record Policy(
    int Schema,
    int IntervalMinutes,
    ExporterPolicy WindowsExporter,
    OhmGraphitePolicy OhmGraphite,
    VectorPolicy Vector,
    AgentPolicy? Agent = null)
{
    public const int CurrentSchema = 1;

    public static Policy Parse(string json)
    {
        var policy = JsonSerializer.Deserialize<Policy>(json, Json.Options)
            ?? throw new PolicyException("policy is empty");
        if (policy.Schema != CurrentSchema)
        {
            throw new PolicyException($"policy schema {policy.Schema} is not {CurrentSchema}");
        }
        if (policy.IntervalMinutes < 5)
        {
            throw new PolicyException("intervalMinutes must be at least 5");
        }
        policy.WindowsExporter.Validate("windowsExporter");
        policy.OhmGraphite.Validate("ohmGraphite");
        policy.Vector.Validate("vector");
        policy.Agent?.Validate("agent");
        return policy;
    }
}

public abstract record ComponentPolicy(string Version, string Url, string Sha256)
{
    private static readonly Regex Hex64 = new("^[0-9A-Fa-f]{64}$");

    public virtual void Validate(string name)
    {
        if (string.IsNullOrWhiteSpace(Version)) throw new PolicyException($"{name}.version is missing");
        if (!Uri.TryCreate(Url, UriKind.Absolute, out var uri) || uri.Scheme != "https")
        {
            throw new PolicyException($"{name}.url must be an https URL");
        }
        if (!Hex64.IsMatch(Sha256)) throw new PolicyException($"{name}.sha256 must be 64 hex characters");
    }
}

public sealed record ExporterPolicy(string Version, string Url, string Sha256, string Collectors, int Port)
    : ComponentPolicy(Version, Url, Sha256)
{
    public override void Validate(string name)
    {
        base.Validate(name);
        if (string.IsNullOrWhiteSpace(Collectors)) throw new PolicyException($"{name}.collectors is missing");
        if (!Collectors.Split(',').Contains("textfile"))
        {
            throw new PolicyException($"{name}.collectors must include textfile, which carries the agent's own metrics");
        }
        if (Port is < 1 or > 65535) throw new PolicyException($"{name}.port is out of range");
    }
}

public sealed record OhmGraphitePolicy(string Version, string Url, string Sha256, string ConfigUrl, int Port)
    : ComponentPolicy(Version, Url, Sha256)
{
    public override void Validate(string name)
    {
        base.Validate(name);
        if (!Uri.TryCreate(ConfigUrl, UriKind.Absolute, out _)) throw new PolicyException($"{name}.configUrl is not a URL");
        if (Port is < 1 or > 65535) throw new PolicyException($"{name}.port is out of range");
    }
}

public sealed record VectorPolicy(string Version, string Url, string Sha256, string ConfigUrl, string ProductCode)
    : ComponentPolicy(Version, Url, Sha256)
{
    private static readonly Regex Guid = new("^\\{[0-9A-Fa-f-]{36}\\}$");

    public override void Validate(string name)
    {
        base.Validate(name);
        if (!Uri.TryCreate(ConfigUrl, UriKind.Absolute, out _)) throw new PolicyException($"{name}.configUrl is not a URL");
        if (!Guid.IsMatch(ProductCode)) throw new PolicyException($"{name}.productCode must be a braced GUID");
    }
}

/// <summary>The Lookout MSI itself. When present and newer than the running agent, the agent installs it.</summary>
public sealed record AgentPolicy(string Version, string Url, string Sha256) : ComponentPolicy(Version, Url, Sha256)
{
    private static readonly Regex ThreePart = new("^\\d+\\.\\d+\\.\\d+$");

    public override void Validate(string name)
    {
        base.Validate(name);
        if (!ThreePart.IsMatch(Version)) throw new PolicyException($"{name}.version must be major.minor.patch");
    }
}

public sealed class PolicyException(string message) : Exception(message);

/// <summary>The policy plus the config files it names, resolved to text.</summary>
public sealed record PolicyBundle(Policy Policy, string OhmGraphiteConfig, string VectorConfig, string Source);

public static class Json
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter() },
    };
}
