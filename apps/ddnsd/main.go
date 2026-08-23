package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/netip"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	dnsclient "codeberg.org/miekg/dns"
	"github.com/cloudflare/cloudflare-go/v7"
	"github.com/cloudflare/cloudflare-go/v7/dns"
	"github.com/cloudflare/cloudflare-go/v7/option"
	"github.com/cloudflare/cloudflare-go/v7/zones"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	cfg, err := parseConfig(os.Args[1:], os.Getenv)
	if errors.Is(err, flag.ErrHelp) {
		return
	}
	if err != nil {
		logger.Error("Invalid configuration", "error", err.Error())
		os.Exit(1)
	}

	logger = logger.With("name", cfg.fqdn, "zone", cfg.zone, "proxied", cfg.proxied)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	api := cloudflare.NewClient(option.WithAPIToken(cfg.token))

	u, err := newUpdater(ctx, api, cfg, logger)
	if err != nil {
		logger.Error("Startup failed", "error", err.Error())
		os.Exit(1)
	}

	if err := u.Refresh(ctx); err != nil {
		logger.Error("Update failed", "error", err.Error())
		os.Exit(1)
	}

	if cfg.once {
		return
	}

	ticker := time.NewTicker(cfg.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			logger.Info("Shutting down due to signal")
			return
		case <-ticker.C:
			// A failed tick is not fatal. The address is resolved again from
			// scratch on the next one, and exiting here would turn a single
			// DNS timeout into a service restart.
			if err := u.Refresh(ctx); err != nil {
				logger.Error("Update failed", "error", err.Error())
			}
		}
	}
}

// config is everything ddnsd needs, resolved once before anything talks to the
// network.
type config struct {
	fqdn     string
	zone     string
	token    string
	proxied  bool
	once     bool
	interval time.Duration
}

// parseConfig resolves flags, environment and the token file into a config. It
// touches the filesystem for -token-file and the OS hostname when no name is
// given; everything else is a pure read of args and getenv. It returns errors
// rather than exiting, so main is the only place that ends the process.
func parseConfig(args []string, getenv func(string) string) (config, error) {
	interval := 5 * time.Minute
	if v := getenv("DDNSD_INTERVAL"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			return config{}, fmt.Errorf("DDNSD_INTERVAL %q: %w", v, err)
		}
		interval = d
	}

	fs := flag.NewFlagSet("ddnsd", flag.ContinueOnError)
	var (
		once      = fs.Bool("once", false, "Run the update once and exit")
		every     = fs.Duration("interval", interval, "Interval between updates (e.g., 30s, 5m, 1h)")
		name      = fs.String("name", getenv("CLOUDFLARE_DNS_NAME"), "DNS record name, or @ for the zone apex (default: OS hostname)")
		zone      = fs.String("zone", getenv("CLOUDFLARE_DNS_ZONE"), "Cloudflare zone name (required)")
		token     = fs.String("token", getenv("CLOUDFLARE_API_TOKEN"), "Cloudflare API token (required)")
		tokenFile = fs.String("token-file", getenv("CLOUDFLARE_API_TOKEN_FILE"), "Path to a file containing the Cloudflare API token")
		proxied   = fs.Bool("proxied", false, "Enable Cloudflare proxy")
	)
	if err := fs.Parse(args); err != nil {
		return config{}, err
	}

	cfg := config{
		zone:     strings.ToLower(strings.TrimSpace(*zone)),
		token:    strings.TrimSpace(*token),
		proxied:  *proxied,
		once:     *once,
		interval: *every,
	}

	if cfg.zone == "" {
		return config{}, errors.New("zone is required: set -zone or CLOUDFLARE_DNS_ZONE")
	}

	if cfg.interval <= 0 {
		return config{}, fmt.Errorf("interval must be positive, got %s", cfg.interval)
	}

	if cfg.token == "" {
		if *tokenFile == "" {
			return config{}, errors.New("token is required: set -token or -token-file (or CLOUDFLARE_API_TOKEN / CLOUDFLARE_API_TOKEN_FILE)")
		}
		b, err := os.ReadFile(*tokenFile)
		if err != nil {
			return config{}, fmt.Errorf("reading token file: %w", err)
		}
		cfg.token = strings.TrimSpace(string(b))
		if cfg.token == "" {
			return config{}, fmt.Errorf("token file is empty: %s", *tokenFile)
		}
	}

	n := *name
	if strings.TrimSpace(n) == "" {
		h, err := os.Hostname()
		if err != nil {
			return config{}, fmt.Errorf("no -name given and the OS hostname is unavailable: %w", err)
		}
		n = h
	}
	cfg.fqdn = recordName(n, cfg.zone)

	return cfg, nil
}

// recordName resolves the configured name to the fully-qualified name
// Cloudflare stores the record under. The apex is the zone itself: looking up
// "@.example.com" matches nothing, so a record configured with @ would never be
// found and ddnsd would create a duplicate on every pass.
func recordName(name, zone string) string {
	normalize := func(s string) string {
		return strings.Trim(strings.ToLower(strings.TrimSpace(s)), ".")
	}
	name, zone = normalize(name), normalize(zone)
	switch {
	case name == "" || name == "@" || name == zone:
		return zone
	case strings.HasSuffix(name, "."+zone):
		return name
	default:
		return name + "." + zone
	}
}

// updater reconciles one A record with the address this host appears to come
// from. Everything fixed for the process lifetime — the zone ID included — is
// resolved once, at construction, so a misconfigured zone fails at startup
// rather than on some tick hours later.
type updater struct {
	api     *cloudflare.Client
	resolve func(context.Context) (string, error)
	zoneID  string
	fqdn    string
	proxied bool
	logger  *slog.Logger
}

func newUpdater(ctx context.Context, api *cloudflare.Client, cfg config, logger *slog.Logger) (*updater, error) {
	list, err := api.Zones.List(ctx, zones.ZoneListParams{
		Name: cloudflare.String(cfg.zone),
	})
	if err != nil {
		return nil, fmt.Errorf("getting zones: %w", err)
	}
	if len(list.Result) == 0 {
		return nil, fmt.Errorf("zone not found: %s", cfg.zone)
	}
	if list.Result[0].Name != cfg.zone {
		return nil, fmt.Errorf("zone name mismatch: %s != %s", list.Result[0].Name, cfg.zone)
	}

	return &updater{
		api:     api,
		resolve: resolveIP,
		zoneID:  list.Result[0].ID,
		fqdn:    cfg.fqdn,
		proxied: cfg.proxied,
		logger:  logger,
	}, nil
}

// Refresh resolves the current public address and reconciles the record with
// it. The lookup happens on every pass: an address read once at startup goes
// stale the moment the ISP hands out a new lease, which is the one thing a
// dynamic DNS client exists to notice.
func (u *updater) Refresh(ctx context.Context) error {
	ip, err := u.resolve(ctx)
	if err != nil {
		return fmt.Errorf("getting IP address: %w", err)
	}
	return u.reconcile(ctx, ip, u.logger.With("ip", ip))
}

func (u *updater) reconcile(ctx context.Context, ip string, logger *slog.Logger) error {
	records, err := u.api.DNS.Records.List(ctx, dns.RecordListParams{
		ZoneID: cloudflare.String(u.zoneID),
		Name: cloudflare.F(dns.RecordListParamsName{
			Exact: cloudflare.String(u.fqdn),
		}),
		Type: cloudflare.F(dns.RecordListParamsTypeA),
	})
	if err != nil {
		return fmt.Errorf("listing DNS records: %w", err)
	}

	var recordID string
	var upToDate bool
	for _, record := range records.Result {
		if record.Name != u.fqdn {
			continue
		}
		recordID = record.ID
		upToDate = record.Content == ip && record.Proxied == u.proxied
		break
	}

	if recordID != "" && upToDate {
		logger.Info("no changes")
		return nil
	}

	comment := "Updated by ddnsd on " + time.Now().Format(time.RFC3339)
	if recordID != "" {
		_, err := u.api.DNS.Records.Update(ctx, recordID, dns.RecordUpdateParams{
			ZoneID: cloudflare.String(u.zoneID),
			Body: dns.RecordUpdateParamsBody{
				Type:    cloudflare.F(dns.RecordUpdateParamsBodyTypeA),
				Name:    cloudflare.String(u.fqdn),
				Content: cloudflare.String(ip),
				Comment: cloudflare.String(comment),
				Proxied: cloudflare.F(u.proxied),
				TTL:     cloudflare.F(dns.TTL(1)),
			},
		})
		if err != nil {
			return fmt.Errorf("updating DNS record: %w", err)
		}
		logger.Info("updated DNS record")
		return nil
	}

	_, err = u.api.DNS.Records.New(ctx, dns.RecordNewParams{
		ZoneID: cloudflare.String(u.zoneID),
		Body: dns.RecordNewParamsBody{
			Type:    cloudflare.F(dns.RecordNewParamsBodyTypeA),
			Name:    cloudflare.String(u.fqdn),
			Content: cloudflare.String(ip),
			Comment: cloudflare.String(comment),
			Proxied: cloudflare.F(u.proxied),
			TTL:     cloudflare.F(dns.TTL(1)),
		},
	})
	if err != nil {
		return fmt.Errorf("creating DNS record: %w", err)
	}
	logger.Info("created DNS record")
	return nil
}

// resolveIP asks Cloudflare's whoami service which address this host appears to
// come from.
func resolveIP(ctx context.Context) (string, error) {
	m := dnsclient.NewMsg("whoami.cloudflare.", dnsclient.TypeTXT, dnsclient.ClassCHAOS)

	in, err := dnsclient.Exchange(ctx, m, "udp", "1.1.1.1:53")
	if err != nil {
		return "", err
	}

	var ip string
	if len(in.Answer) > 0 {
		if t, ok := in.Answer[0].(*dnsclient.TXT); ok && len(t.Txt) > 0 {
			ip = t.Txt[0]
		}
	}

	if _, err := netip.ParseAddr(ip); err != nil {
		return ip, fmt.Errorf("could not determine IP address: %s", ip)
	}
	return ip, nil
}
