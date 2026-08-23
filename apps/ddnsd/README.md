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
- Go 1.27 or later, to build from source

## 🛠 Installation

Build the binary from this directory:

```bash
cd apps/ddnsd
go build
```

## ⚙ Configuration

Configure `ddnsd` with environment variables or flags. Flags win over the
environment.

| Environment variable | Flag | Meaning |
| --- | --- | --- |
| `CLOUDFLARE_DNS_ZONE` | `-zone` | Cloudflare zone name, e.g. `yourdomain.com` (required) |
| `CLOUDFLARE_DNS_NAME` | `-name` | Record name, or `@` for the zone apex (default: the OS hostname) |
| `CLOUDFLARE_API_TOKEN` | `-token` | Cloudflare API token |
| `CLOUDFLARE_API_TOKEN_FILE` | `-token-file` | Path to a file containing the token |
| `DDNSD_INTERVAL` | `-interval` | Time between updates, e.g. `30s`, `5m`, `1h` (default `5m`) |
| — | `-proxied` | Enable the Cloudflare proxy (orange cloud) |
| — | `-once` | Update once and exit |

One of `-token` or `-token-file` is required.

```bash
./ddnsd -token-file=/var/secrets/token -name=home -zone=yourdomain.com
```

## 📘 Usage

```bash
Usage of ddnsd:
  -interval duration
        Interval between updates (e.g., 30s, 5m, 1h) (default 5m0s)
  -name string
        DNS record name, or @ for the zone apex (default: OS hostname)
  -once
        Run the update once and exit
  -proxied
        Enable Cloudflare proxy
  -token string
        Cloudflare API token (required)
  -token-file string
        Path to a file containing the Cloudflare API token
  -zone string
        Cloudflare zone name (required)
```

Update the record once and exit:

```bash
./ddnsd -once
```

Run in a loop with a custom interval:

```bash
./ddnsd -interval=30m
```

## 🔧 Troubleshooting

`ddnsd` logs JSON to stdout. Startup failures — a missing zone, an unreadable
token file, a zone the token cannot see — are reported and exit non-zero; a
failed update mid-loop is logged and retried on the next pass.

If records are not updating, confirm the API token can list zones and edit DNS
records in the target zone, and that the host can reach `1.1.1.1:53` over UDP —
that is where `ddnsd` asks for its own address.

## 🤝 Contributing

Contributions to `ddnsd` are welcome! Whether it's reporting bugs, discussing new features, or contributing code, please feel free to reach out.

1. Fork the repository
1. Create your feature branch (`git checkout -b feature/AmazingFeature`)
1. Commit your changes (`git commit -am 'Add some AmazingFeature'`)
1. Push to the branch (`git push origin feature/AmazingFeature`)
1. Open a pull request
