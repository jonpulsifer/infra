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

	"github.com/cloudflare/cloudflare-go"
	"github.com/miekg/dns"
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

	logger = logger.With("name", *name, "zone", *zone, "ip", ip)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	api, err := cloudflare.NewWithAPIToken(*token)
	if err != nil {
		logger.Error("Failed to create Cloudflare client", "error", err.Error())
		os.Exit(1)
	}

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

func update(ctx context.Context, api *cloudflare.API, ip, name, zone string, proxied bool, logger *slog.Logger) error {
	zoneID, err := api.ZoneIDByName(zone)
	if err != nil {
		return fmt.Errorf("getting zone ID: %w", err)
	}

	records, _, err := api.ListDNSRecords(ctx, cloudflare.ZoneIdentifier(zoneID), cloudflare.ListDNSRecordsParams{Name: name + "." + zone})
	if err != nil {
		return fmt.Errorf("listing DNS records: %w", err)
	}

	var recordID string
	var sameIP bool
	for _, record := range records {
		if record.Type == "A" && record.Name == name+"."+zone {
			if record.Content == ip {
				sameIP = true
				break
			}
			recordID = record.ID
			break
		}
	}

	if sameIP {
		logger.Info("IP address has not changed")
		return nil
	}

	comment := "Updated by ddnsd on " + time.Now().Format(time.RFC3339)
	if recordID != "" {
		_, err := api.UpdateDNSRecord(context.Background(), cloudflare.ZoneIdentifier(zoneID), cloudflare.UpdateDNSRecordParams{
			ID:      recordID,
			Type:    "A",
			Name:    name,
			Content: ip,
			Proxied: &proxied,
			TTL:     1,
			Comment: &comment,
		})
		if err != nil {
			return fmt.Errorf("updating DNS record: %w", err)
		}
		logger.Info("updated DNS record")
	} else {
		_, err = api.CreateDNSRecord(context.Background(), cloudflare.ZoneIdentifier(zoneID), cloudflare.CreateDNSRecordParams{
			Name:    name,
			Type:    "A",
			Content: ip,
			TTL:     1,
			Proxied: &proxied,
			Comment: comment,
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
	m := new(dns.Msg)
	m.Id = dns.Id()
	m.RecursionDesired = true
	m.Question = make([]dns.Question, 1)
	m.Question[0] = dns.Question{Name: "whoami.cloudflare.", Qtype: dns.TypeTXT, Qclass: dns.ClassCHAOS}

	c := new(dns.Client)
	in, _, err := c.Exchange(m, "1.1.1.1:53")
	if err != nil {
		return ip, err
	}

	if t, ok := in.Answer[0].(*dns.TXT); ok {
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
