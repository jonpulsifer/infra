namespace Lookout.Tests;

public class PolicyTests
{
    [Fact]
    public void ParsesTheCommittedPolicy()
    {
        var policy = Policy.Parse(Fixtures.PolicyJson);
        Assert.Equal(Policy.CurrentSchema, policy.Schema);
        Assert.Contains("textfile", policy.WindowsExporter.Collectors);
        Assert.StartsWith("{", policy.Vector.ProductCode);
    }

    [Fact]
    public void TheAgentEntryIsOptionalAndThreePart()
    {
        Assert.Null(Policy.Parse(Fixtures.PolicyJson).Agent);
        var with = Fixtures.PolicyJson.TrimEnd().TrimEnd('}') + """
            ,
              "agent": {
                "version": "0.2.0",
                "url": "https://github.com/jonpulsifer/infra/releases/download/lookout-v0.2.0/Lookout.msi",
                "sha256": "0AADCE6AFB20182B678BFCA9E8F2E8464EF48C469B28B4CF02E99D82158F5D40"
              }
            }
            """;
        Assert.Equal("0.2.0", Policy.Parse(with).Agent!.Version);
        var error = Assert.Throws<PolicyException>(() => Policy.Parse(with.Replace("\"0.2.0\"", "\"0.2\"")));
        Assert.Contains("major.minor.patch", error.Message);
    }

    [Theory]
    [InlineData("\"schema\": 1", "\"schema\": 2", "schema 2")]
    [InlineData("\"intervalMinutes\": 360", "\"intervalMinutes\": 1", "at least 5")]
    [InlineData("[defaults],gpu,cpu_info,diskdrive,textfile", "[defaults],gpu", "must include textfile")]
    [InlineData("0AADCE6AFB20182B678BFCA9E8F2E8464EF48C469B28B4CF02E99D82158F5D40", "abc", "64 hex")]
    [InlineData("https://packages.timber.io", "http://packages.timber.io", "https URL")]
    public void RejectsABadPolicy(string from, string to, string message)
    {
        var json = Fixtures.PolicyJson.Replace(from, to);
        var error = Assert.Throws<PolicyException>(() => Policy.Parse(json));
        Assert.Contains(message, error.Message);
    }
}

public class PolicyLoaderTests
{
    private static readonly Uri Url = new("https://example.test/policy.json");

    [Fact]
    public async Task FetchesAndCaches()
    {
        var system = new FakeSystem();
        var policy = Policy.Parse(Fixtures.PolicyJson);
        system.Downloads[Url.ToString()] = Fixtures.PolicyJson;
        system.Downloads[policy.OhmGraphite.ConfigUrl] = "<ohm/>";
        system.Downloads[policy.Vector.ConfigUrl] = "vector";

        var (bundle, error) = await new PolicyLoader(system, Url).LoadAsync(CancellationToken.None);

        Assert.Null(error);
        Assert.Equal("<ohm/>", bundle!.OhmGraphiteConfig);
        Assert.Equal(Fixtures.PolicyJson, system.Files[Paths.PolicyCache(system)]);
        Assert.Equal("vector", system.Files[Paths.VectorConfigCache(system)]);
    }

    [Fact]
    public async Task FallsBackToTheCacheOffline()
    {
        var system = new FakeSystem();
        system.Files[Paths.PolicyCache(system)] = Fixtures.PolicyJson;
        system.Files[Paths.OhmConfigCache(system)] = "<ohm/>";
        system.Files[Paths.VectorConfigCache(system)] = "vector";

        var (bundle, error) = await new PolicyLoader(system, Url).LoadAsync(CancellationToken.None);

        Assert.NotNull(bundle);
        Assert.Contains("using the cached policy", error);
        Assert.Equal(Paths.PolicyCache(system), bundle.Source);
    }

    [Fact]
    public async Task ReportsNoPolicyWhenOfflineWithoutACache()
    {
        var (bundle, error) = await new PolicyLoader(new FakeSystem(), Url).LoadAsync(CancellationToken.None);
        Assert.Null(bundle);
        Assert.Contains("no cached policy", error);
    }
}
