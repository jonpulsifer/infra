using Lookout;
using Lookout.Agent;

var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddWindowsService(options => options.ServiceName = "Lookout");
builder.Logging.AddEventLog(settings =>
{
    settings.SourceName = "Lookout";
    settings.LogName = "Application";
});
builder.Logging.AddFilter("Microsoft", LogLevel.Warning);

builder.Services.AddSingleton<ISystem, WindowsSystem>();
builder.Services.AddSingleton(sp => AgentSettings.Load(sp.GetRequiredService<ISystem>()));
builder.Services.AddSingleton<AgentState>();
builder.Services.AddHostedService<AgentWorker>();
builder.Services.AddHostedService<PipeServer>();

await builder.Build().RunAsync();
