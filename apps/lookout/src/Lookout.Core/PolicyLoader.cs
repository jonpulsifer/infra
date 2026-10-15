namespace Lookout;

/// <summary>
/// Fetches the policy and the config files it names from git, caching each in
/// ProgramData. When the fetch fails, the cache serves, so a desktop that is
/// offline keeps converging to the last policy it saw.
/// </summary>
public sealed class PolicyLoader(ISystem system, Uri policyUrl)
{
    public async Task<(PolicyBundle? Bundle, string? Error)> LoadAsync(CancellationToken ct)
    {
        try
        {
            var policyJson = await system.DownloadTextAsync(policyUrl, ct);
            var policy = Policy.Parse(policyJson);
            var ohm = await system.DownloadTextAsync(new Uri(policy.OhmGraphite.ConfigUrl), ct);
            var vector = await system.DownloadTextAsync(new Uri(policy.Vector.ConfigUrl), ct);

            system.CreateDirectory(Paths.StateDir(system));
            system.WriteText(Paths.PolicyCache(system), policyJson);
            system.WriteText(Paths.OhmConfigCache(system), ohm);
            system.WriteText(Paths.VectorConfigCache(system), vector);
            return (new PolicyBundle(policy, ohm, vector, policyUrl.ToString()), null);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception e)
        {
            var cached = LoadCached();
            return (cached, $"{e.Message}{(cached is null ? "; no cached policy" : "; using the cached policy")}");
        }
    }

    private PolicyBundle? LoadCached()
    {
        var policyJson = system.ReadText(Paths.PolicyCache(system));
        var ohm = system.ReadText(Paths.OhmConfigCache(system));
        var vector = system.ReadText(Paths.VectorConfigCache(system));
        if (policyJson is null || ohm is null || vector is null) return null;
        try
        {
            return new PolicyBundle(Policy.Parse(policyJson), ohm, vector, Paths.PolicyCache(system));
        }
        catch (PolicyException)
        {
            return null;
        }
    }
}
