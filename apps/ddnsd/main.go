package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/cloudflare/cloudflare-go/v5"
	"github.com/cloudflare/cloudflare-go/v5/dns"
	"github.com/cloudflare/cloudflare-go/v5/option"
	"github.com/cloudflare/cloudflare-go/v5/zones"
	dnsclient "github.com/miekg/dns"
)

var (
	once      = flag.Bool("once", false, "Run the update once and exit")
	interval  = flag.Duration("interval", defaultInterval(), "Interval between updates (e.g., 30s, 5m, 1h)")
	name      = flag.String("name", os.Getenv("CLOUDFLARE_DNS_NAME"), "DNS record name (or @ for the zone apex)")
	zone      = flag.String("zone", os.Getenv("CLOUDFLARE_DNS_ZONE"), "Cloudflare zone name (required)")
	token     = flag.String("token", os.Getenv("CLOUDFLARE_API_TOKEN"), "Cloudflare API token (required)")
	tokenFile = flag.String("token-file", os.Getenv("CLOUDFLARE_API_TOKEN_FILE"), "Path to a file containing Cloudflare API token")
	proxied   = flag.Bool("proxied", false, "Enable Cloudflare proxy (default false)")
	verbose   = flag.Bool("verbose", false, "Enable verbose logging")
)

func main() {
	flag.Parse()
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if *verbose {
		slog.SetLogLoggerLevel(slog.LevelDebug)
	}

	if *token == "" && *tokenFile == "" {
		logger.Error("Token not found, set CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_TOKEN_FILE environment variable or use -token or -token-file flag")
		os.Exit(1)
	}

	if *token == "" {
		tokenBytes, err := os.ReadFile(*tokenFile)
		if err != nil {
			logger.Error("Failed to read token file", "error", err.Error())
			os.Exit(1)
		}

		if len(tokenBytes) == 0 {
			logger.Error("Token file is empty", "path", *tokenFile)
			os.Exit(1)
		}
		*token = strings.TrimSpace(string(tokenBytes))
	}

	if *name == "" {
		*name = getOSHostname()
	}

	if *zone == "" {
		logger.Error("Zone is required")
		os.Exit(1)
	}

	ip, err := getIP()
	if err != nil {
		logger.Error("Failed to get IP address", "error", err.Error())
		os.Exit(1)
	}

	logger = logger.With("name", *name, "zone", *zone, "ip", ip, "proxied", *proxied)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	api := cloudflare.NewClient(
		option.WithAPIToken(*token),
	)

	if err := update(ctx, api, ip, *name, *zone, *proxied, logger); err != nil {
		logger.Error("Update failed", "error", err.Error())
		os.Exit(1)
	}

	if *once {
		return
	}

	ticker := time.NewTicker(*interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			logger.Info("Shutting down due to signal")
			return
		case <-ticker.C:
			if err := update(ctx, api, ip, *name, *zone, *proxied, logger); err != nil {
				logger.Error("Update failed", "error", err.Error())
				os.Exit(1)
			}
		}
	}
}

func update(ctx context.Context, api *cloudflare.Client, ip, name, zone string, proxied bool, logger *slog.Logger) error {
	zones, err := api.Zones.List(ctx, zones.ZoneListParams{
		Name: cloudflare.String(zone),
	})

	if err != nil {
		return fmt.Errorf("getting zones: %w", err)
	}

	if len(zones.Result) == 0 {
		return fmt.Errorf("zone not found: %s", zone)
	}

	if zones.Result[0].Name != zone {
		return fmt.Errorf("zone name mismatch: %s != %s", zones.Result[0].Name, zone)
	}

	zoneID := zones.Result[0].ID

	records, err := api.DNS.Records.List(ctx, dns.RecordListParams{
		ZoneID: cloudflare.String(zoneID),
		Name: cloudflare.F(dns.RecordListParamsName{
			Exact: cloudflare.String(name + "." + zone),
		}),
		Type: cloudflare.F(dns.RecordListParamsTypeA),
	})
	if err != nil {
		return fmt.Errorf("listing DNS records: %w", err)
	}

	desiredName := name + "." + zone
	var (
		recordID       string
		currentIP      string
		currentProxied bool
		found          bool
	)
	for _, record := range records.Result {
		if record.Type == "A" && record.Name == desiredName {
			found = true
			recordID = record.ID
			currentIP = record.Content
			currentProxied = record.Proxied
			break
		}
	}

	if found && currentIP == ip && currentProxied == proxied {
		logger.Info("no changes")
		return nil
	}

	comment := "Updated by ddnsd on " + time.Now().Format(time.RFC3339)
	if recordID != "" {
		_, err := api.DNS.Records.Update(ctx, recordID, dns.RecordUpdateParams{
			ZoneID: cloudflare.String(zoneID),
			Body: dns.RecordUpdateParamsBody{
				Type:    cloudflare.F(dns.RecordUpdateParamsBodyTypeA),
				Name:    cloudflare.String(name),
				Content: cloudflare.String(ip),
				Comment: cloudflare.String(comment),
				Proxied: cloudflare.F(proxied),
				TTL:     cloudflare.F(dns.TTL(1)),
			},
		})
		if err != nil {
			return fmt.Errorf("updating DNS record: %w", err)
		}
		logger.Info("updated DNS record")
	} else {
		_, err = api.DNS.Records.New(ctx, dns.RecordNewParams{
			ZoneID: cloudflare.String(zoneID),
			Body: dns.RecordNewParamsBody{
				Type:    cloudflare.F(dns.RecordNewParamsBodyTypeA),
				Name:    cloudflare.String(name),
				Content: cloudflare.String(ip),
				Comment: cloudflare.String(comment),
				Proxied: cloudflare.F(proxied),
				TTL:     cloudflare.F(dns.TTL(1)),
			},
		})
		if err != nil {
			return fmt.Errorf("creating DNS record: %w", err)
		}

		logger.Info("created DNS record")
	}
	return nil
}

func getIP() (string, error) {
	var ip string
	m := new(dnsclient.Msg)
	m.Id = dnsclient.Id()
	m.RecursionDesired = true
	m.Question = make([]dnsclient.Question, 1)
	m.Question[0] = dnsclient.Question{Name: "whoami.cloudflare.", Qtype: dnsclient.TypeTXT, Qclass: dnsclient.ClassCHAOS}

	c := new(dnsclient.Client)
	in, _, err := c.Exchange(m, "1.1.1.1:53")
	if err != nil {
		return ip, err
	}

	if t, ok := in.Answer[0].(*dnsclient.TXT); ok {
		ip = t.Txt[0]
	}

	if net.ParseIP(ip) == nil {
		return ip, fmt.Errorf("could not determine IP address: %s", ip)

	}
	return ip, nil
}

func getOSHostname() string {
	name, err := os.Hostname()
	if err != nil {
		slog.Error("failed to get OS hostname", "error", err.Error())
		os.Exit(1)
	}
	return strings.ToLower(name)
}

func defaultInterval() time.Duration {
	envInterval := os.Getenv("DDNSD_INTERVAL")
	if envInterval == "" {
		return 5 * time.Minute
	}
	d, err := time.ParseDuration(envInterval)
	if err != nil {
		slog.Error("invalid interval format", "error", err.Error(), "interval", envInterval)
		os.Exit(1)
	}
	return d
}
