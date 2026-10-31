// tink-lab-fleetd runs fleetd's reconcile loop and webhook, apps/fleetd/fleet as a git ref has
// them, against tink-lab's API and netbox.py. It wires what apps/fleetd/main.go's newFleet wires,
// less the verifier, the renderer, the cluster client, the TFTP links and the SPIRE file. Its
// Installer has no renderer: POST /lab/config puts a config as a render would, and GET
// /talos/config serves it through the Installer's own handler. With TINK_LAB_BOOT_ADDR set, the
// handler is also served there as fleetd's boot listener serves it, with that server's timeouts,
// in plain HTTP, so an installed node can fetch its config. While the file TINK_LAB_HOLD_FILE
// holds a regular expression that matches "METHOD PATH?QUERY" of a request to NetBox, the request
// waits unsent until the file goes or stops matching, so a test can stop fleetd between two of its
// NetBox calls. tink-lab.sh copies it into an export of apps/fleetd and builds it there.
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/fleet"
)

func main() {
	cfg, err := fleet.LoadConfig()
	if err != nil {
		log.Fatal(err)
	}
	// The Redfish Machine the patch adds takes the BMC's port from AMTPort.
	if cfg.AMTPort, err = strconv.Atoi(os.Getenv("TINK_LAB_BMC_PORT")); err != nil {
		log.Fatalf("TINK_LAB_BMC_PORT: %v", err)
	}
	// LoadInstaller fills Installs from the class inputs; this binary has no installer.
	cfg.Installs = map[string]string{}
	for _, pair := range strings.Split(os.Getenv("TINK_LAB_INSTALLS"), ",") {
		if class, image, ok := strings.Cut(pair, "="); ok {
			cfg.Installs[class] = image
		}
	}
	token, err := fleet.ReadSecret(os.Getenv("FLEET_NETBOX_TOKEN_FILE"))
	if err != nil {
		log.Fatal(err)
	}
	kube, err := fleet.NewKube(os.Getenv("FLEET_KUBE_SERVER"), os.Getenv("FLEET_KUBE_CA_FILE"),
		os.Getenv("FLEET_KUBE_CERT_FILE"), os.Getenv("FLEET_KUBE_KEY_FILE"), cfg.Namespace)
	if err != nil {
		log.Fatal(err)
	}
	secret, err := fleet.ReadSecret(os.Getenv("FLEET_WEBHOOK_SECRET_FILE"))
	if err != nil {
		log.Fatal(err)
	}
	netbox := &fleet.NetBox{URL: os.Getenv("FLEET_NETBOX_URL"), Token: token,
		Client: &http.Client{Timeout: 30 * time.Second, Transport: hold{os.Getenv("TINK_LAB_HOLD_FILE"), http.DefaultTransport}}}
	metrics := fleet.NewMetrics()
	ttl, err := time.ParseDuration(os.Getenv("TINK_LAB_CONFIG_TTL"))
	if err != nil || ttl <= 0 {
		ttl = time.Hour
	}
	installer := &fleet.Installer{Site: cfg.Site, NetBox: netbox, Kube: kube, Configs: &fleet.Configs{},
		TTL: ttl, Metrics: metrics, Now: time.Now}
	r := &fleet.Reconciler{
		Config:    cfg,
		NetBox:    netbox,
		Kube:      kube,
		Installer: installer,
		Metrics:   metrics,
		Now:       time.Now,
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	trigger := make(chan string, 1)
	mux := http.NewServeMux()
	mux.Handle("POST /webhook", &fleet.Webhook{Secret: []byte(secret), Trigger: trigger, Metrics: r.Metrics})
	mux.Handle("GET /metrics", r.Metrics)
	mux.Handle("GET /talos/config", installer)
	mux.HandleFunc("POST /lab/config", func(w http.ResponseWriter, req *http.Request) {
		var in struct {
			fleet.Pending
			Config []byte
		}
		if err := json.NewDecoder(req.Body).Decode(&in); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		p := in.Pending
		p.Rendered, p.TTL = time.Now(), installer.TTL
		body := in.Config
		if len(body) == 0 {
			body = []byte("# tink-lab: a stand-in config for " + p.Node + "\n")
		}
		if err := installer.Configs.Put(p, body); err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		log.Printf("tink-lab: put a config for %s (workflow %s, %d bytes)", p.Node, p.Workflow, len(body))
		w.WriteHeader(http.StatusCreated)
	})
	srv := &http.Server{Addr: os.Getenv("FLEET_WEBHOOK_ADDR"), Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go r.Loop(ctx, trigger)
	if addr := os.Getenv("TINK_LAB_BOOT_ADDR"); addr != "" {
		boot := http.NewServeMux()
		boot.Handle("/talos/config", installer)
		boot.HandleFunc("/", http.NotFound)
		bs := &http.Server{Addr: addr, Handler: boot, ReadHeaderTimeout: 10 * time.Second,
			ReadTimeout: 30 * time.Second, WriteTimeout: time.Minute, IdleTimeout: 2 * time.Minute}
		bs.ConnContext = fleet.ConnContext
		bs.Protocols = new(http.Protocols)
		bs.Protocols.SetHTTP1(true)
		go func() {
			<-ctx.Done()
			_ = bs.Shutdown(context.Background())
		}()
		go func() {
			if err := bs.ListenAndServe(); err != http.ErrServerClosed {
				log.Fatal(err)
			}
		}()
		log.Printf("tink-lab: the boot listener serves /talos/config at %s, config TTL %s", addr, ttl)
	}
	go func() {
		<-ctx.Done()
		_ = srv.Shutdown(context.Background())
	}()
	log.Printf("tink-lab-fleetd started, interval %s", cfg.Interval)
	if err := srv.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

// hold is a transport that keeps a request unsent while the hold file matches it.
type hold struct {
	file string
	next http.RoundTripper
}

func (h hold) RoundTrip(req *http.Request) (*http.Response, error) {
	what := req.Method + " " + req.URL.RequestURI()
	logged := false
	for h.matches(what) {
		if !logged {
			log.Printf("tink-lab: holding %s", what)
			logged = true
		}
		select {
		case <-req.Context().Done():
			return nil, req.Context().Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
	if logged {
		log.Printf("tink-lab: released %s", what)
	}
	return h.next.RoundTrip(req)
}

func (h hold) matches(what string) bool {
	if h.file == "" {
		return false
	}
	b, err := os.ReadFile(h.file)
	if err != nil {
		return false
	}
	pattern := strings.TrimSpace(string(b))
	if pattern == "" {
		return false
	}
	re, err := regexp.Compile(pattern)
	return err == nil && re.MatchString(what)
}
