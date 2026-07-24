# Cloudflare DDNS Client (`ddnsd`)

A dynamic DNS updater for Cloudflare-managed domains: it keeps a DNS record
pointed at the current IP address. Useful for home servers, IoT devices, or any
setup on a dynamic IP.

`ddnsd` ships two ways from this repo — as the `ghcr.io/jonpulsifer/ddnsd`
container image, and as a Nix package that NixOS hosts run as a systemd service
via `nix/system/ddnsd.nix`.

## 🚀 Features

- Update A records for specified hostname within your Cloudflare zone
- Automatic IP detection using Cloudflare's `whoami` service
- Configurable update intervals
- Optional one-time update mode
- Support for Cloudflare proxy status (orange cloud)

## 📋 Prerequisites

Before you begin, ensure you have met the following requirements:

- A Cloudflare account and API token with permissions to edit DNS records
- The zone (domain) name for which you want to update the DNS record
- Go 1.25 or later, to build from source

## 🛠 Installation

Build the binary from this directory:

```bash
cd apps/ddnsd
go build
```

## ⚙ Configuration

Set up the required environment variables or use command-line flags to configure `ddnsd`:

- `CLOUDFLARE_DNS_NAME`: DNS record name (or `@` for the zone apex) (e.g. `home`, `server1`, `@`)
- `CLOUDFLARE_ZONE_NAME`: Your Cloudflare zone name (e.g., yourdomain.com)
- and one of the following:
  - `CLOUDFLARE_API_TOKEN`: Your Cloudflare API token
  - `CLOUDFLARE_API_TOKEN_PATH`: Path to a file containing your Cloudflare API token

Alternatively, you can use flags:

```bash
./ddnsd -token-path="/var/secrets/token" -name="home" -zone="yourdomain.com"
```

## 📘 Usage

Start `ddnsd` with the desired configuration.

```bash
Usage of ddnsd:
  -interval duration
        Interval between updates (e.g., 30s, 5m, 1h) (default 5m0s)
  -name string
        DNS record name (or @ for the zone apex)
  -once
        Run the update once and exit (default true)
  -proxied
        Enable Cloudflare proxy (default false)
  -token string
        Cloudflare API token (required)
  -token-path string
        Path to file containing Cloudflare API token
  -verbose
        Enable verbose logging
  -zone string
        Cloudflare zone name (required)

```

To update your DNS record and exit:

```bash
./ddnsd
```

To run `ddnsd` in a loop with a specified interval (default is 5 minutes):

```bash
./ddnsd -interval=30m
```

## 🔧 Troubleshooting

If you encounter any issues, first ensure your API token has the necessary permissions to list zones and edit DNS records. Check the verbose output (-verbose) for clues and verify your network connectivity.

## 🤝 Contributing

Contributions to `ddnsd` are welcome! Whether it's reporting bugs, discussing new features, or contributing code, please feel free to reach out.

1. Fork the repository
1. Create your feature branch (`git checkout -b feature/AmazingFeature`)
1. Commit your changes (`git commit -am 'Add some AmazingFeature'`)
1. Push to the branch (`git push origin feature/AmazingFeature`)
1. Open a pull request
