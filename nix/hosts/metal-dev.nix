# metal-dev: a Compute Engine VM with nested virtualization that stands in for folly's bootstrap
# VLAN, its anchors and a rack of machines. A libvirt bridge carries the lab's BOOTSTRAP_CIDR, and
# this host owns the boot VIP and spore's bootstrap address on it, so the signed iPXE,
# ISO and HookOS from the talos-folly releases boot unchanged. Virtual nodes get a swtpm TPM 2.0,
# OVMF in Setup Mode (the signed ISO enrolls the lab's keys), and a Redfish BMC from sushy-tools.
#
# Nothing here is folly's: the DevID CA, the Talos secrets, the NetBox and the Tinkerbell API are
# generated on first boot under /var/lib/metal-dev. terraform/metal-dev declares the VM, and
# scripts/metal-dev/ drives it (docs/platform/metal-dev.md).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  lab = import ../lib/anchor.nix;
  fleet = import ../lib/fleet.nix;
  site = "folly";

  # The bridge replays the lab's bootstrap network so the release images' baked addresses resolve.
  net = lib.head (lib.splitString "/" lab.bootstrap.cidr);
  prefixLen = lib.toInt (lib.last (lib.splitString "/" lab.bootstrap.cidr));
  octets = lib.splitString "." net;
  hostAt = n: lib.concatStringsSep "." (lib.take 3 octets ++ [ (toString n) ]);
  bridge = "metalbr0";
  gateway = hostAt 1;
  poolStart = hostAt 2;
  poolEnd = hostAt 9;
  # The one virtual node's fixed lease and the dev cluster's endpoint.
  nodeAddress = hostAt 10;
  nodeMac = "52:54:00:de:ad:10";
  spore = lab.bootstrap.hosts.spore;
  vip = lab.bootstrap.vip;

  enrollHost = "enroll.${fleet.dnsZone}";
  tailnetName = "${config.networking.hostName}.${fleet.tailnet}";
  approvers = "jonathan@pulsifer.ca";

  stateDir = "/var/lib/metal-dev";
  mirrorDir = "${stateDir}/talos/${site}";
  tftpRoot = "/var/lib/tftpboot";
  tftpDir = "${tftpRoot}/talos/${site}";

  iso = "metal-amd64-secureboot.iso";
  ipxe = "ipxe-amd64-secureboot.efi";
  hookos = "hookos-amd64-secureboot-uki.efi";
  signingCert = ../../clusters/folly/talos/secureboot/uki-signing-cert.pem;
  hookosCert = ../../clusters/folly/talos/secureboot/hookos-signing-cert.pem;
  verifyUki = ../../.github/scripts/talos-uki-verify.sh;
  netbootPins = lib.importJSON ../../clusters/folly/talos/netboot.json;

  # The release tag follows the Talos version the folly root installs (nix/services/talos-boot.nix),
  # and the dev cluster runs the root's Kubernetes version.
  rootValue =
    key:
    let
      matches = lib.concatMap (
        line:
        let
          m = builtins.match ''[[:space:]]*${key}[[:space:]]*=[[:space:]]*"(v[0-9]+\.[0-9]+\.[0-9]+)".*'' line;
        in
        if m == null then [ ] else m
      ) (lib.splitString "\n" (builtins.readFile ../../clusters/folly/talos/talos.tf));
    in
    if lib.length matches == 1 then
      lib.head matches
    else
      throw "clusters/folly/talos/talos.tf must set ${key} exactly once";
  talosVersion = rootValue "talos_version";
  kubernetesVersion = rootValue "kubernetes_version";
  tagPrefix = "talos-${site}/${talosVersion}-";
  installer = "ghcr.io/jonpulsifer/talos-installer-folly:${talosVersion}";

  # Ports on loopback behind nginx and tailscale serve.
  enrollPort = 8090;
  enrollAdminPort = 8091;
  enrollAdminServePort = 8443;
  attestPort = 8081;
  attestDevidPort = 8444;
  attestAdminPort = 8082;
  attestAdminServePort = 8445;
  netboxNginxPort = 8080;
  controllerWebhookPort = 8446;
  sushyPort = 8000;
  tinkApiPort = 6443;
  tinkHttpPort = 7080;
  tinkServerPort = 42113;

  # Images the boot plane runs. talos-attest and fleet-controller are built by the containers
  # workflow once their tickets land; until then podman reports the pull failure and the rest runs.
  images = {
    talos-enroll = "ghcr.io/jonpulsifer/talos-enroll:latest";
    talos-attest = "ghcr.io/jonpulsifer/talos-attest:latest";
    fleet-controller = "ghcr.io/jonpulsifer/fleet-controller:latest";
    sushy = "quay.io/metal3-io/sushy-tools:latest";
  };

  talosctl = pkgs.callPackage ../../apps/talos-enroll/talosctl.nix { };
  # QEMU ships the Secure Boot capable edk2 firmware that libvirt's firmware autoselection and sushy name.
  ovmfCode = "${pkgs.qemu_kvm}/share/qemu/edk2-x86_64-secure-code.fd";

  # renovate: datasource=github-releases depName=tinkerbell/tinkerbell
  tinkerbellVersion = "v0.25.0";
  tinkerbell =
    pkgs.runCommand "tinkerbell-embedded-${tinkerbellVersion}"
      {
        src = pkgs.fetchurl {
          name = "tinkerbell-embedded-linux-amd64-${tinkerbellVersion}";
          url = "https://github.com/tinkerbell/tinkerbell/releases/download/${tinkerbellVersion}/tinkerbell-embedded-linux-amd64";
          # tinkerbell-embedded-linux-amd64 in the release's checksums-embedded.txt.
          sha256 = "0b1c033fc1dea85bfde973ebc63b5606c71ac8354306f4ec124e5d983a218089";
        };
        meta.mainProgram = "tinkerbell";
      }
      ''
        install -Dm755 $src $out/bin/tinkerbell
      '';
  tinkDir = "${stateDir}/tinkerbell";
  tinkKubeconfig = pkgs.writeText "metal-dev-tinkerbell-kubeconfig.json" (
    builtins.toJSON {
      apiVersion = "v1";
      kind = "Config";
      clusters = [
        {
          name = "tinkerbell";
          cluster = {
            server = "https://127.0.0.1:${toString tinkApiPort}";
            certificate-authority = "${tinkDir}/ca.crt";
          };
        }
      ];
      users = [
        {
          name = "tinkerbell-admin";
          user = {
            client-certificate = "${tinkDir}/admin.crt";
            client-key = "${tinkDir}/admin.key";
          };
        }
      ];
      contexts = [
        {
          name = "tinkerbell";
          context = {
            cluster = "tinkerbell";
            user = "tinkerbell-admin";
          };
        }
      ];
      current-context = "tinkerbell";
    }
  );
  tinkFlags = [
    "--backend-kube-config=${tinkKubeconfig}"
    "--etcd-dir=${tinkDir}/etcd"
    "--etcd-servers=http://localhost:2379"
    "--kube-apiserver-bind-address=127.0.0.1"
    "--secure-port=${toString tinkApiPort}"
    "--kube-apiserver-tls-cert-file=${tinkDir}/server.crt"
    "--kube-apiserver-tls-private-key-file=${tinkDir}/server.key"
    "--client-ca-file=${tinkDir}/ca.crt"
    "--service-account-key-file=${tinkDir}/sa.key"
    "--service-account-signing-key-file=${tinkDir}/sa.key"
    "--service-account-issuer=https://kubernetes.default.svc"
    "--anonymous-auth=false"
    "--authorization-mode=RBAC"
    "--enable-ui=false"
    "--enable-tootles=false"
    "--enable-secondstar=false"
    "--public-ipv4=${spore}"
    "--bind-address=${spore}"
    "--http-port=${toString tinkHttpPort}"
    "--tink-server-bind-addr=${spore}"
    "--tink-server-bind-port=${toString tinkServerPort}"
    "--syslog-enabled=false"
    # dnsmasq is the bridge's DHCP server and names the signed iPXE; Smee only serves each MAC's
    # script on its HTTP port, which the iPXE's embedded script chains.
    "--dhcp-enabled=false"
    "--tftp-server-enabled=false"
    "--ipxe-http-binary-enabled=false"
    "--ipxe-http-script-osie-url=http://${spore}/talos/${site}"
  ];

  # The HookOS command line the Hardware objects carry, as nodes.env does for folly.
  hookosCmdline = lib.concatStringsSep " " [
    "facility="
    "syslog_host=${spore}"
    "grpc_authority=${spore}:${toString tinkServerPort}"
    "tinkerbell_tls=false"
    "tinkerbell_insecure_tls=false"
    "modules=loop,squashfs,sd-mod,usb-storage"
    "intel_iommu=on"
    "iommu=pt"
    "console=ttyS0,115200"
    "console=tty0"
    "tink_worker_image=${netbootPins.tink_agent_image}"
  ];

  # The dev cluster's render inputs: one controlplane class, and the same content under the node's
  # name for the per-node contract talos-enroll reads today. Patches: install the signed installer
  # to the virtual disk, name the node, and keep the cluster small.
  devPatches = [
    (builtins.toJSON {
      apiVersion = "v1alpha1";
      kind = "UnattendedInstallConfig";
      installer.image = installer;
      provisioning = {
        diskSelector.match = "disk.dev_path == \"/dev/vda\"";
        wipe = true;
      };
    })
    (builtins.toJSON {
      apiVersion = "v1alpha1";
      kind = "HostnameConfig";
      auto = "off";
      hostname = "vnode1";
    })
    (builtins.toJSON { cluster.allowSchedulingOnControlPlanes = true; })
  ];
  classInputs = {
    cluster_name = "metal-dev";
    cluster_endpoint = "https://${nodeAddress}:6443";
    machine_type = "controlplane";
    talos_contract = lib.concatStringsSep "." (lib.take 2 (lib.splitString "." talosVersion));
    kubernetes_version = kubernetesVersion;
    config_patches = devPatches;
  };
  classInputsFile = pkgs.writeText "metal-dev-class-inputs.json" (
    builtins.toJSON { controlplane = classInputs; }
  );

  sushyConfig = pkgs.writeText "sushy.conf" ''
    SUSHY_EMULATOR_LISTEN_IP = '${gateway}'
    SUSHY_EMULATOR_LISTEN_PORT = ${toString sushyPort}
    SUSHY_EMULATOR_SSL_CERT = '/etc/sushy/cert.pem'
    SUSHY_EMULATOR_SSL_KEY = '/etc/sushy/key.pem'
    SUSHY_EMULATOR_AUTH_FILE = '/etc/sushy/htpasswd'
    SUSHY_EMULATOR_LIBVIRT_URI = 'qemu:///system'
    SUSHY_EMULATOR_IGNORE_BOOT_DEVICE = False
    SUSHY_EMULATOR_BOOT_LOADER_MAP = {
        'UEFI': {'x86_64': '${ovmfCode}'},
        'Legacy': {'x86_64': None},
    }
    # Written by metal-dev-intake: the libvirt UUIDs this BMC exposes, one per virtual node.
    exec(open('/etc/sushy/instances.py').read())
  '';

  # First boot: every secret and certificate the dev boot plane needs, once, under ${stateDir}.
  init = pkgs.writeShellApplication {
    name = "metal-dev-init";
    runtimeInputs = with pkgs; [
      coreutils
      openssl
      talosctl
      jq
      apacheHttpd
      swtpm
      gnused
    ];
    text = ''
      umask 077
      mkdir -p ${stateDir}/{enroll,attest/roots,attest-state,netbox,tinkerbell,sushy}
      chmod 755 ${stateDir} ${stateDir}/attest ${stateDir}/attest/roots ${stateDir}/enroll ${stateDir}/tinkerbell ${stateDir}/sushy
      cd ${stateDir}

      # The dev cluster's secrets bundle and a talosconfig for the operator, the class inputs, and
      # the inventory of virtual nodes that metal-dev-intake adds, which talos-attest reads too.
      if [ ! -s enroll/secrets.yaml ]; then
        talosctl gen secrets -o enroll/secrets.yaml
        talosctl gen config --with-secrets enroll/secrets.yaml --output-types talosconfig \
          -o enroll/talosconfig metal-dev "https://${nodeAddress}:6443" >/dev/null
        chmod 600 enroll/secrets.yaml enroll/talosconfig
      fi
      install -m 644 ${classInputsFile} enroll/class-inputs.json
      [ -s enroll/machines.yaml ] || printf 'machines: {}\n' >enroll/machines.yaml
      chmod 644 enroll/machines.yaml
      ln -sfn ../enroll/machines.yaml attest/machines.yaml
      install -m 644 ${../../apps/talos-attest/policy.yaml} attest/policy.yaml

      # A software DevID CA. Nothing outside this VM trusts it.
      if [ ! -s attest/devid-ca.key ]; then
        openssl ecparam -name prime256v1 -genkey -noout -out attest/devid-ca.key
        openssl req -x509 -new -key attest/devid-ca.key -sha256 -days 1825 \
          -subj "/O=metal-dev/CN=metal-dev DevID CA" \
          -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
          -addext "keyUsage=critical,keyCertSign,cRLSign" \
          -out attest/devid-ca-chain.pem
        chmod 644 attest/devid-ca-chain.pem
      fi

      # swtpm's local CA signs each virtual TPM's EK certificate; that CA is the only EK root here.
      # An empty roots directory would make talos-attest refuse every EK, so this step fails loudly.
      if [ ! -s /var/lib/swtpm-localca/swtpm-localca-rootca-cert.pem ]; then
        scratch=$(mktemp -d)
        swtpm_setup --tpm2 --tpmstate "$scratch" --createek --create-ek-cert --logfile "$scratch/setup.log" || {
          cat "$scratch/setup.log" >&2
          echo "swtpm_setup could not create the local EK CA" >&2
          exit 1
        }
        rm -rf "$scratch"
      fi
      [ -s /var/lib/swtpm-localca/swtpm-localca-rootca-cert.pem ] || {
        echo "swtpm_setup ran but /var/lib/swtpm-localca holds no root certificate" >&2
        exit 1
      }
      # libvirt's swtpm_setup signs each virtual TPM's EK certificate with this CA as qemu-libvirtd.
      chgrp -R qemu-libvirtd /var/lib/swtpm-localca
      chmod -R g+rwX /var/lib/swtpm-localca
      install -m 644 /var/lib/swtpm-localca/swtpm-localca-rootca-cert.pem attest/roots/swtpm-localca-rootca.pem
      if [ -s /var/lib/swtpm-localca/issuercert.pem ]; then
        install -m 644 /var/lib/swtpm-localca/issuercert.pem attest/roots/swtpm-localca-issuer.pem
      fi

      # NetBox's Django secret and token pepper, and the superuser's password.
      [ -s netbox/secret-key ] || openssl rand -base64 48 | tr -d '\n' >netbox/secret-key
      [ -s netbox/api-token-pepper ] || openssl rand -base64 48 | tr -d '\n' >netbox/api-token-pepper
      [ -s netbox/superuser-password ] || openssl rand -base64 24 | tr -d '\n=' >netbox/superuser-password

      # The embedded kube-apiserver's CA, serving and admin certificates, and its service-account key.
      if [ ! -s tinkerbell/ca.crt ]; then
        openssl ecparam -name prime256v1 -genkey -noout -out tinkerbell/ca.key
        openssl req -x509 -new -key tinkerbell/ca.key -sha256 -days 3650 -subj "/CN=metal-dev tinkerbell" \
          -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" -out tinkerbell/ca.crt
        openssl ecparam -name prime256v1 -genkey -noout -out tinkerbell/server.key
        openssl req -new -key tinkerbell/server.key -subj "/CN=tinkerbell" \
          -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:${spore},IP:${gateway}" -out tinkerbell/server.csr
        openssl x509 -req -in tinkerbell/server.csr -CA tinkerbell/ca.crt -CAkey tinkerbell/ca.key -CAcreateserial \
          -days 3650 -sha256 -copy_extensions copy -out tinkerbell/server.crt
        openssl ecparam -name prime256v1 -genkey -noout -out tinkerbell/admin.key
        openssl req -new -key tinkerbell/admin.key -subj "/CN=tinkerbell-admin/O=system:masters" -out tinkerbell/admin.csr
        openssl x509 -req -in tinkerbell/admin.csr -CA tinkerbell/ca.crt -CAkey tinkerbell/ca.key -CAcreateserial \
          -days 3650 -sha256 -out tinkerbell/admin.crt
        openssl genrsa -out tinkerbell/sa.key 2048
        rm -f tinkerbell/*.csr tinkerbell/*.srl
        chmod 644 tinkerbell/ca.crt tinkerbell/server.crt tinkerbell/admin.crt
      fi

      # sushy's configuration, serving certificate and its one BMC login.
      install -m 644 ${sushyConfig} sushy/sushy.conf
      if [ ! -s sushy/htpasswd ]; then
        openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
          -subj "/CN=metal-dev bmc" -addext "subjectAltName=IP:${gateway}" -keyout sushy/key.pem -out sushy/cert.pem
        password=$(openssl rand -base64 18 | tr -d '\n=')
        htpasswd -cbB sushy/htpasswd bmc "$password"
        printf 'bmc\n%s\n' "$password" >sushy/credentials
        : >sushy/instances.py
        chmod 644 sushy/cert.pem sushy/key.pem sushy/htpasswd sushy/instances.py
      fi
      [ -s sushy/instances.py ] || : >sushy/instances.py

      # The controller's webhook secret, which NetBox's event rule signs with. The containers mount
      # the netbox directory read-only and root only, so the Django secrets travel with it.
      [ -s netbox/webhook-secret ] || openssl rand -hex 32 | tr -d '\n' >netbox/webhook-secret
      chmod 711 netbox
    '';
  };

  # After NetBox answers: a superuser and an API token for the boot plane and the operator.
  netboxToken = pkgs.writeShellApplication {
    name = "metal-dev-netbox-token";
    runtimeInputs = with pkgs; [
      coreutils
      curl
      jq
    ];
    text = ''
      umask 077
      token=${stateDir}/netbox/api-token
      [ -s "$token" ] && exit 0
      for _ in $(seq 60); do
        curl -fsS -o /dev/null http://127.0.0.1:${toString netboxNginxPort}/api/status/ && break
        sleep 5
      done
      # The password reaches curl on stdin, never on its command line.
      jq -cn --arg u admin --rawfile p ${stateDir}/netbox/superuser-password \
        '{username: $u, password: ($p | rtrimstr("\n")), description: "metal-dev boot plane", write_enabled: true}' \
        | curl -fsS -X POST -H 'Content-Type: application/json' -H 'Accept: application/json' \
          --data @- http://127.0.0.1:${toString netboxNginxPort}/api/users/tokens/provision/ \
        | jq -er '.token // .key' | tr -d '\n' >"$token.tmp"
      mv "$token.tmp" "$token"
    '';
  };

  netboxManage = lib.findFirst (
    p: lib.getName p == "netbox-manage"
  ) (throw "services.netbox no longer installs netbox-manage") config.environment.systemPackages;
  netboxSuperuser = pkgs.writeShellScript "metal-dev-netbox-superuser" ''
    set -euo pipefail
    present=$(${lib.getExe netboxManage} shell --verbosity 0 --command \
      'from users.models import User; print(User.objects.filter(username="admin").exists())' | tail -n 1)
    if [ "$present" != True ]; then
      DJANGO_SUPERUSER_PASSWORD=$(<"$CREDENTIALS_DIRECTORY/superuser-password") \
        ${lib.getExe netboxManage} createsuperuser --no-input --username admin --email admin@${fleet.dnsZone}
    fi
  '';

  # Mirrors the newest talos-folly release for the root's Talos version, as the anchors do, and
  # checks each signed image against its committed certificate before it serves it.
  mirror = pkgs.writeShellApplication {
    name = "metal-dev-talos-mirror";
    runtimeInputs = with pkgs; [
      coreutils
      curl
      jq
      openssl
      sbsigntool
      gnugrep
      gnused
    ];
    text = ''
      mkdir -p ${mirrorDir}
      releases=$(curl -fsS -H 'Accept: application/vnd.github+json' \
        'https://api.github.com/repos/jonpulsifer/infra/releases?per_page=100')
      tag=$(jq -r --arg p '${tagPrefix}' '[.[] | select(.tag_name | startswith($p))] | sort_by(.created_at) | last | .tag_name // empty' <<<"$releases")
      [ -n "$tag" ] || { echo "no release tagged ${tagPrefix}*"; exit 1; }
      if [ "$(cat ${mirrorDir}/current/.tag 2>/dev/null || true)" = "$tag" ]; then
        exit 0
      fi
      next=$(mktemp -d ${mirrorDir}/.next.XXXXXX)
      for asset in ${iso} ${ipxe} ${hookos}; do
        url=$(jq -r --arg t "$tag" --arg a "$asset" '.[] | select(.tag_name == $t) | .assets[] | select(.name == $a) | .browser_download_url' <<<"$releases")
        [ -n "$url" ] || { echo "$tag has no asset $asset"; rm -rf "$next"; exit 1; }
        curl -fsSL -o "$next/$asset" "$url"
      done
      bash ${verifyUki} ${signingCert} "$next/${ipxe}"
      bash ${verifyUki} ${hookosCert} "$next/${hookos}"
      echo "$tag" >"$next/.tag"
      chmod 755 "$next"
      chmod 644 "$next"/*
      if [ -d ${mirrorDir}/current ]; then
        rm -rf ${mirrorDir}/prev
        mv ${mirrorDir}/current ${mirrorDir}/prev
      fi
      mv "$next" ${mirrorDir}/current
      echo "mirrored $tag"
    '';
  };

  # Creates one virtual node, enrolls the lab's Secure Boot keys from the signed ISO, declares it in
  # NetBox, hands it to the Redfish BMC, and asks for a provision.
  intake = pkgs.writeShellApplication {
    name = "metal-dev-intake";
    runtimeInputs = with pkgs; [
      coreutils
      libvirt
      virt-manager
      curl
      jq
      yq-go
      kubectl
      gnused
      systemd
    ];
    text = ''
      name="''${1:-vnode1}"
      [ "$name" = vnode1 ] || { echo "metal-dev runs one virtual node, vnode1: its address and MAC are fixed in nix/hosts/metal-dev.nix"; exit 64; }
      [ -s ${mirrorDir}/current/${iso} ] || { echo "no mirrored release; run: systemctl start metal-dev-talos-mirror"; exit 1; }
      # The token reaches curl through a config file on a descriptor, never on its command line.
      nb() {
        local method="$1" path="$2" body="''${3:-}"
        curl -fsS -K <(printf 'header = "Authorization: Token %s"\n' "$(<${stateDir}/netbox/api-token)") \
          -X "$method" -H 'Content-Type: application/json' -H 'Accept: application/json' \
          ''${body:+--data "$body"} "http://127.0.0.1:${toString netboxNginxPort}/api/$path"
      }
      # The fleet schema first: without it the device would land with no class and no action, and
      # the first POST would die on a bare 400.
      missing=""
      for field in talos_class bmc_type desired_action; do
        nb GET "extras/custom-fields/?name=$field" | jq -e '.count > 0' >/dev/null 2>&1 || missing="$missing $field"
      done
      if [ -n "$missing" ]; then
        echo "intake: this NetBox lacks the fleet custom fields:$missing. Run: mise run metal-dev:seed" >&2
        exit 1
      fi
      serial="MD$(printf '%08X' "$(( $(date +%s) % 4294967296 ))")"
      disk=/var/lib/libvirt/images/$name.qcow2

      if ! virsh dominfo "$name" >/dev/null 2>&1; then
        echo "intake: creating $name with a swtpm TPM 2.0 and OVMF in Setup Mode"
        virt-install --name "$name" --memory 8192 --vcpus 4 --cpu host-passthrough --osinfo linux2024 \
          --disk "path=$disk,size=40,format=qcow2,bus=virtio" \
          --network "bridge=${bridge},mac=${nodeMac},model=virtio" \
          --tpm backend.type=emulator,backend.version=2.0,model=tpm-crb \
          --boot firmware=efi,firmware.feature0.name=secure-boot,firmware.feature0.enabled=yes,firmware.feature1.name=enrolled-keys,firmware.feature1.enabled=no \
          --sysinfo "system.serial=$serial,system.manufacturer=QEMU,system.product=metal-dev" \
          --cdrom ${mirrorDir}/current/${iso} --graphics none --console pty,target.type=serial \
          --noautoconsole --wait 0
        echo "intake: the signed ISO's systemd-boot enrolls PK, KEK and db in a VM and reboots; waiting"
        virsh event --domain "$name" --event reboot --timeout 600 >/dev/null
        virsh destroy "$name" >/dev/null 2>&1 || true
        virsh change-media "$name" --eject --config sda >/dev/null 2>&1 || virsh change-media "$name" --eject --config hda >/dev/null 2>&1 || true
        virt-xml "$name" --edit --boot network,hd >/dev/null
        echo "intake: keys enrolled; $name now boots the bridge's PXE first"
      else
        serial=$(virsh dumpxml "$name" | sed -n 's/.*<entry name="serial">\(.*\)<\/entry>.*/\1/p' | head -n 1)
      fi
      uuid=$(virsh domuuid "$name" | tr -d ' \n')

      # The one BMC exposes exactly this domain.
      printf "SUSHY_EMULATOR_ALLOWED_INSTANCES = ['%s']\n" "$uuid" >${stateDir}/sushy/instances.py
      systemctl restart podman-sushy.service

      # The inventory talos-enroll and talos-attest read, and the controller's BMC login in the
      # Tinkerbell API.
      yq -i ".machines.$name = {\"model\": \"metal-dev\", \"serial\": \"$serial\", \"mac\": \"${nodeMac}\", \"disk\": \"/dev/vda\", \"tpm\": \"2.0\", \"amt\": false, \"secure_boot\": true, \"class\": \"controlplane\", \"status\": \"staged\", \"address\": \"${nodeAddress}\", \"bmc\": {\"type\": \"redfish\", \"address\": \"${gateway}\"}}" ${stateDir}/enroll/machines.yaml
      systemctl try-restart podman-talos-attest.service podman-talos-enroll.service
      mapfile -t bmc <${stateDir}/sushy/credentials
      kubectl --kubeconfig ${tinkKubeconfig} -n tinkerbell create secret generic bmc-redfish \
        --from-literal=username="''${bmc[0]}" --from-literal=password="''${bmc[1]}" \
        --dry-run=client -o json | kubectl --kubeconfig ${tinkKubeconfig} apply -f - >/dev/null

      # NetBox: the site, a device type and role when the seed has not made them, then the device.
      ensure() {
        local path="$1" query="$2" body="$3" id
        id=$(nb GET "$path?$query" | jq -r '.results[0].id // empty')
        [ -n "$id" ] || id=$(nb POST "$path" "$body" | jq -r .id)
        printf '%s' "$id"
      }
      site_id=$(ensure dcim/sites/ slug=dev '{"name": "dev", "slug": "dev", "status": "active"}')
      mfr_id=$(ensure dcim/manufacturers/ slug=qemu '{"name": "QEMU", "slug": "qemu"}')
      type_id=$(ensure dcim/device-types/ slug=metal-dev "{\"manufacturer\": $mfr_id, \"model\": \"metal-dev\", \"slug\": \"metal-dev\"}")
      role_id=$(ensure dcim/device-roles/ slug=kubernetes-node '{"name": "kubernetes-node", "slug": "kubernetes-node", "color": "2196f3"}')
      device=$(jq -cn --arg n "$name" --arg s "$serial" --argjson site "$site_id" --argjson type "$type_id" --argjson role "$role_id" \
        '{name: $n, serial: $s, site: $site, device_type: $type, role: $role, status: "staged",
          custom_fields: {install_disk: "/dev/vda", tpm_version: "2.0", amt: false, secure_boot_expected: true}}')
      dev_id=$(ensure dcim/devices/ "name=$name&site=dev" "$device")
      nb PATCH "dcim/devices/$dev_id/" "$device" >/dev/null
      if_id=$(ensure dcim/interfaces/ "device_id=$dev_id&name=eth0" "{\"device\": $dev_id, \"name\": \"eth0\", \"type\": \"virtual\"}")
      mac_id=$(ensure dcim/mac-addresses/ "mac_address=${nodeMac}" "{\"mac_address\": \"${nodeMac}\", \"assigned_object_type\": \"dcim.interface\", \"assigned_object_id\": $if_id}")
      nb PATCH "dcim/interfaces/$if_id/" "{\"primary_mac_address\": $mac_id}" >/dev/null
      ip_id=$(ensure ipam/ip-addresses/ "address=${nodeAddress}/${toString prefixLen}" "{\"address\": \"${nodeAddress}/${toString prefixLen}\", \"assigned_object_type\": \"dcim.interface\", \"assigned_object_id\": $if_id}")
      bmc_ip_id=$(ensure ipam/ip-addresses/ "address=${gateway}/${toString prefixLen}" "{\"address\": \"${gateway}/${toString prefixLen}\", \"description\": \"metal-dev Redfish BMC\"}")
      nb PATCH "dcim/devices/$dev_id/" "{\"primary_ip4\": $ip_id, \"oob_ip\": $bmc_ip_id}" >/dev/null
      nb PATCH "dcim/devices/$dev_id/" '{"custom_fields": {"talos_class": "controlplane", "bmc_type": "redfish", "desired_action": "provision"}}' >/dev/null

      echo "intake: $name declared (serial $serial, uuid $uuid). Watching its NetBox status; the console is: virsh console $name"
      last=""
      for _ in $(seq 360); do
        status=$(nb GET "dcim/devices/$dev_id/" | jq -r '.status.value')
        if [ "$status" != "$last" ]; then
          echo "intake: $name is $status"
          last=$status
        fi
        [ "$status" = active ] && break
        sleep 10
      done
      [ "$status" = active ] || { echo "intake: $name did not reach active within an hour"; exit 1; }
      echo "intake: done. talosctl --talosconfig ${stateDir}/enroll/talosconfig -n ${nodeAddress} version"
    '';
  };

  # Joins the tailnet as the VM's service account. With --audience, tailscale fetches the
  # account's identity token from the metadata server (format=full), trades it at the token
  # exchange for an API token, and mints a single-use, ephemeral, preauthorized tag:gcp auth key,
  # as nixos-deploy.yaml does. The federated identity is terraform/network/tailscale/metal_dev.tf;
  # terraform/metal-dev sets its client id and audience as metadata attributes.
  tailscaleUp = pkgs.writeShellApplication {
    name = "metal-dev-tailscale-up";
    runtimeInputs = [
      pkgs.curl
      pkgs.jq
      config.services.tailscale.package
    ];
    text = ''
      state=""
      for _ in $(seq 30); do
        state=$(tailscale status --json 2>/dev/null | jq -r '.BackendState') || state=""
        case "$state" in
          "" | NoState | Starting) sleep 2 ;;
          *) break ;;
        esac
      done
      case "$state" in
        Running | Stopped)
          echo "tailscale is $state; nothing to join"
          exit 0
          ;;
        NeedsLogin) ;;
        *)
          echo "tailscale is ''${state:-unreachable}" >&2
          exit 1
          ;;
      esac

      attr() {
        curl -sSf --max-time 10 -H 'Metadata-Flavor: Google' \
          "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"
      }
      if ! client_id=$(attr tailscale-client-id) || ! audience=$(attr tailscale-audience); then
        echo "no tailscale-client-id or tailscale-audience metadata: set them in terraform/metal-dev" >&2
        exit 1
      fi
      tailscale up \
        --client-id="$client_id?ephemeral=true&preauthorized=true" \
        --audience="$audience" \
        ${lib.escapeShellArgs config.services.tailscale.extraUpFlags} \
        --accept-routes=false
    '';
  };

  hardenedContainer = extra: {
    autoStart = true;
    pull = "newer";
    extraOptions = [ "--network=host" ] ++ extra;
  };
in
{
  imports = [ ../images/gce.nix ];

  assertions = [
    {
      assertion = prefixLen >= 24 && lib.last octets == "0";
      message = "metal-dev.nix lays the bootstrap CIDR on a bridge and expects a /24 to /28 network ending in .0";
    }
  ];

  boot.kernelModules = [
    "kvm-intel"
    "vhost_net"
  ];

  # The bridge is the lab's bootstrap VLAN: this host is its gateway, DNS, DHCP, TFTP, NTP, the
  # boot VIP and spore's bootstrap address, all at once.
  systemd.network = {
    netdevs."10-${bridge}".netdevConfig = {
      Kind = "bridge";
      Name = bridge;
    };
    networks."10-${bridge}" = {
      matchConfig.Name = bridge;
      address = map (a: "${a}/${toString prefixLen}") [
        gateway
        spore
        vip
      ];
      networkConfig.ConfigureWithoutCarrier = true;
      linkConfig.RequiredForOnline = "no";
    };
  };
  networking.nat = {
    enable = true;
    internalInterfaces = [ bridge ];
  };
  networking.firewall = {
    trustedInterfaces = [ bridge ];
    interfaces.tailscale0.allowedTCPPorts = [ netboxNginxPort ];
  };

  virtualisation = {
    libvirtd = {
      enable = true;
      qemu = {
        package = pkgs.qemu_kvm;
        swtpm.enable = true;
      };
    };
    podman.enable = true;
    oci-containers = {
      backend = "podman";
      containers = {
        # Each container gets whole host directories, mounted once: a file bind-mounted inside a
        # read-only directory mount fails with EROFS when its path is not already there.
        talos-enroll =
          hardenedContainer [
            "--volume=${stateDir}/enroll:/etc/talos-enroll:ro"
            "--volume=${stateDir}/netbox:/run/netbox:ro"
          ]
          // {
            image = images.talos-enroll;
            # apps/talos-enroll/README.md on the fleet talos-enroll branch is the contract.
            environment = {
              ENROLL_ADDR = "127.0.0.1:${toString enrollPort}";
              ENROLL_ADMIN_ADDR = "127.0.0.1:${toString enrollAdminPort}";
              ENROLL_ADMIN_URL = "https://${tailnetName}:${toString enrollAdminServePort}";
              ENROLL_APPROVERS = approvers;
              ENROLL_SITE = "dev";
              ENROLL_CLASS_INPUTS = "/etc/talos-enroll/class-inputs.json";
              ENROLL_INVENTORY = "/etc/talos-enroll/machines.yaml";
              ENROLL_SECRETS_BUNDLE = "/etc/talos-enroll/secrets.yaml";
              ENROLL_WORKER_SECRETS = "/etc/talos-enroll/secrets.yaml";
              ENROLL_DISCORD_WEBHOOK_FILE = "/dev/null";
              ENROLL_NETBOX_URL = "http://127.0.0.1:${toString netboxNginxPort}";
              ENROLL_NETBOX_TOKEN_FILE = "/run/netbox/api-token";
              HOME = "/tmp";
            };
          };
        talos-attest =
          hardenedContainer [
            "--volume=${stateDir}/attest:/etc/talos-attest:ro"
            "--volume=${stateDir}/attest-state:/var/lib/talos-attest"
            "--volume=${stateDir}/netbox:/run/netbox:ro"
          ]
          // {
            image = images.talos-attest;
            environment = {
              ATTEST_ADDR = "127.0.0.1:${toString attestPort}";
              ATTEST_DEVID_ADDR = "127.0.0.1:${toString attestDevidPort}";
              ATTEST_ADMIN_ADDR = "127.0.0.1:${toString attestAdminPort}";
              ATTEST_APPROVERS = approvers;
              ATTEST_CA_KEY = "/etc/talos-attest/devid-ca.key";
              ATTEST_CA_CHAIN = "/etc/talos-attest/devid-ca-chain.pem";
              ATTEST_EK_ROOTS = "/etc/talos-attest/roots";
              ATTEST_POLICY = "/etc/talos-attest/policy.yaml";
              ATTEST_INVENTORY = "/etc/talos-attest/machines.yaml";
              ATTEST_STATE_DIR = "/var/lib/talos-attest";
              ATTEST_NETBOX_URL = "http://127.0.0.1:${toString netboxNginxPort}";
              ATTEST_NETBOX_TOKEN_FILE = "/run/netbox/api-token";
              ATTEST_NETBOX_PASS_STATUS = "staged";
              # Added by the fleet talos-attest ticket; harmless to an image that predates it.
              ATTEST_SITE = "dev";
            };
          };
        fleet-controller =
          hardenedContainer [
            "--volume=${stateDir}/tinkerbell:/etc/tinkerbell:ro"
            "--volume=${stateDir}/netbox:/run/netbox:ro"
          ]
          // {
            image = images.fleet-controller;
            # apps/fleet-controller/README.md on the fleet controller branch is the contract.
            environment = {
              FLEET_SITE = "dev";
              FLEET_NETBOX_URL = "http://127.0.0.1:${toString netboxNginxPort}";
              FLEET_NETBOX_TOKEN_FILE = "/run/netbox/api-token";
              FLEET_KUBE_SERVER = "https://127.0.0.1:${toString tinkApiPort}";
              FLEET_KUBE_CA_FILE = "/etc/tinkerbell/ca.crt";
              FLEET_KUBE_CERT_FILE = "/etc/tinkerbell/admin.crt";
              FLEET_KUBE_KEY_FILE = "/etc/tinkerbell/admin.key";
              FLEET_NAMESPACE = "tinkerbell";
              FLEET_TEMPLATE = "provision";
              FLEET_WEBHOOK_ADDR = "${gateway}:${toString controllerWebhookPort}";
              FLEET_WEBHOOK_SECRET_FILE = "/run/netbox/webhook-secret";
              FLEET_ATTEST_URL = "http://${vip}/attest";
              FLEET_NTP_SERVER = vip;
              FLEET_HOOKOS_URL = "http://${spore}/talos/${site}/${hookos}";
              FLEET_HOOKOS_CMDLINE = hookosCmdline;
              FLEET_REDFISH_PORT = toString sushyPort;
              FLEET_REDFISH_INSECURE_TLS = "true";
            };
          };
        sushy =
          hardenedContainer [
            "--volume=/var/run/libvirt:/var/run/libvirt"
            "--volume=${stateDir}/sushy:/etc/sushy:ro"
          ]
          // {
            image = images.sushy;
            cmd = [
              "--config"
              "/etc/sushy/sushy.conf"
            ];
          };
      };
    };
  };

  # swtpm's packaged defaults run swtpm-localca with its state in /var/lib/swtpm-localca, so each
  # virtual TPM's EK certificate chains to the one CA that metal-dev-init pins as an EK root.
  users.users.jawn.extraGroups = [ "libvirtd" ];

  environment.systemPackages = [
    init
    intake
    mirror
    tinkerbell
    talosctl
    pkgs.kubectl
    pkgs.virt-manager
    pkgs.python3Packages.virt-firmware
    pkgs.swtpm
  ];
  environment.etc."tinkerbell/kubeconfig".source = tinkKubeconfig;

  # DHCP, DNS, NTP option and TFTP for the bridge, as UniFi and the anchors give the bootstrap VLAN.
  services.dnsmasq = {
    enable = true;
    resolveLocalQueries = false;
    settings = {
      interface = bridge;
      bind-interfaces = true;
      no-resolv = true;
      server = [ "127.0.0.53" ];
      domain-needed = true;
      address = [ "/${enrollHost}/${vip}" ];
      dhcp-range = "${poolStart},${poolEnd},1m";
      dhcp-host = [ "${nodeMac},${nodeAddress},vnode1" ];
      dhcp-option = [
        "option:router,${gateway}"
        "option:dns-server,${gateway}"
        "option:ntp-server,${vip}"
      ];
      dhcp-boot = "talos/${site}/${ipxe},,${vip}";
      enable-tftp = true;
      tftp-root = tftpRoot;
      log-dhcp = true;
    };
  };
  services.chrony = {
    enable = true;
    extraConfig = "allow ${lab.bootstrap.cidr}";
  };

  # The boot files at spore's address and the VIP, the attest device flow behind the VIP, and the
  # enrollment name with a public certificate, which Talos checks against its bundled roots.
  security.acme = {
    acceptTerms = true;
    defaults.email = "admin@${fleet.dnsZone}";
    certs.${enrollHost} = {
      dnsProvider = "cloudflare";
      dnsResolver = "1.1.1.1:53";
      # scripts/metal-dev/up.sh writes the DNS-01 token here from 1Password.
      credentialFiles.CLOUDFLARE_DNS_API_TOKEN_FILE = "${stateDir}/cloudflare-token";
      group = config.services.nginx.group;
    };
  };
  services.nginx = {
    enable = true;
    virtualHosts = {
      talos-boot = {
        listen =
          map
            (addr: {
              inherit addr;
              port = 80;
            })
            [
              spore
              vip
            ];
        locations = {
          "/".return = "404";
          "/talos/${site}/" = {
            alias = "${mirrorDir}/current/";
            extraConfig = ''
              limit_except GET {
                deny all;
              }
              autoindex off;
            '';
          };
          "/attest/" = {
            proxyPass = "http://127.0.0.1:${toString attestPort}/";
            extraConfig = ''
              proxy_set_header X-Forwarded-For $remote_addr;
              client_max_body_size 1m;
            '';
          };
        };
      };
      ${enrollHost} = {
        onlySSL = true;
        useACMEHost = enrollHost;
        listen = [
          {
            addr = vip;
            port = 443;
            ssl = true;
          }
        ];
        locations = {
          "/".return = "404";
        }
        //
          lib.genAttrs
            [
              "= /device/code"
              "= /token"
              "= /config"
              "= /healthz"
            ]
            (_: {
              proxyPass = "http://127.0.0.1:${toString enrollPort}";
              extraConfig = "proxy_set_header X-Forwarded-For $remote_addr;";
            });
      };
      netbox = {
        listen = [
          {
            addr = "0.0.0.0";
            port = netboxNginxPort;
          }
        ];
        locations."/static/".alias = "${config.services.netbox.dataDir}/static/";
        locations."/" = {
          proxyPass = "http://${config.services.netbox.listenAddress}:${toString config.services.netbox.port}";
          extraConfig = ''
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
          '';
        };
      };
    };
  };
  users.users.nginx.extraGroups = [ "netbox" ];

  services.netbox = {
    enable = true;
    package = pkgs.netbox_4_5;
    secretKeyFile = "${stateDir}/netbox/secret-key";
    apiTokenPeppersFile = "${stateDir}/netbox/api-token-pepper";
    settings = {
      ALLOWED_HOSTS = [ "*" ];
      CSRF_TRUSTED_ORIGINS = [
        "http://${tailnetName}:${toString netboxNginxPort}"
        "http://127.0.0.1:${toString netboxNginxPort}"
      ];
    };
  };
  services.postgresql.package = pkgs.postgresql_17;

  systemd.tmpfiles.rules = [
    "d ${stateDir} 0755 root root -"
    "d ${stateDir}/attest-state 0750 root root -"
    "d /var/lib/swtpm-localca 0770 root qemu-libvirtd -"
    "d ${tftpRoot} 0755 root root -"
    "d ${tftpRoot}/talos 0755 root root -"
    "d ${tftpDir} 0755 root root -"
    "L+ ${tftpDir}/${ipxe} - - - - ${mirrorDir}/current/${ipxe}"
  ];

  systemd.services = {
    metal-dev-init = {
      description = "Generate the metal-dev boot plane's secrets and certificates once";
      wantedBy = [ "multi-user.target" ];
      before = [
        "netbox.service"
        "metal-dev-tinkerbell.service"
        "podman-talos-enroll.service"
        "podman-talos-attest.service"
        "podman-fleet-controller.service"
        "podman-sushy.service"
        "acme-${enrollHost}.service"
      ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = lib.getExe init;
      };
    };
    netbox = {
      requires = [ "metal-dev-init.service" ];
      after = [ "metal-dev-init.service" ];
    };
    netbox-superuser = {
      description = "Create the metal-dev NetBox superuser on an empty database";
      wantedBy = [ "netbox.target" ];
      requires = [ "netbox.service" ];
      after = [ "netbox.service" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        User = "netbox";
        Group = "netbox";
        ExecStart = netboxSuperuser;
        LoadCredential = "superuser-password:${stateDir}/netbox/superuser-password";
      };
    };
    metal-dev-netbox-token = {
      description = "Provision the metal-dev NetBox API token for the boot plane";
      wantedBy = [ "multi-user.target" ];
      requires = [ "netbox-superuser.service" ];
      after = [
        "netbox-superuser.service"
        "nginx.service"
      ];
      before = [
        "podman-talos-enroll.service"
        "podman-talos-attest.service"
        "podman-fleet-controller.service"
      ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = lib.getExe netboxToken;
      };
    };
    metal-dev-talos-mirror = {
      description = "Mirror the newest signed talos-${site} release for the bridge";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = lib.getExe mirror;
      };
    };
    metal-dev-tinkerbell = {
      description = "Tinkerbell for the metal-dev bridge";
      wantedBy = [ "multi-user.target" ];
      requires = [
        "metal-dev-init.service"
        "sys-subsystem-net-devices-${bridge}.device"
      ];
      after = [
        "metal-dev-init.service"
        "network-online.target"
        "sys-subsystem-net-devices-${bridge}.device"
      ];
      wants = [ "network-online.target" ];
      startLimitIntervalSec = 0;
      environment.HOME = tinkDir;
      serviceConfig = {
        ExecStart = "${lib.getExe tinkerbell} ${lib.concatStringsSep " " tinkFlags}";
        Restart = "on-failure";
        RestartSec = "15s";
        WorkingDirectory = tinkDir;
      };
    };
    # The controller needs the Templates Flux gives folly; here the admin applies them from the repo.
    metal-dev-tinkerbell-templates = {
      description = "Apply the repo's Tinkerbell Templates to the metal-dev API";
      wantedBy = [ "multi-user.target" ];
      requires = [ "metal-dev-tinkerbell.service" ];
      after = [ "metal-dev-tinkerbell.service" ];
      path = [ pkgs.kubectl ];
      script = ''
        for _ in $(seq 60); do
          kubectl --kubeconfig ${tinkKubeconfig} get --raw /readyz >/dev/null 2>&1 && break
          sleep 5
        done
        kubectl --kubeconfig ${tinkKubeconfig} create namespace tinkerbell --dry-run=client -o json \
          | kubectl --kubeconfig ${tinkKubeconfig} apply -f - >/dev/null
        for f in ${../../clusters/folly/tinkerbell}/template*.yaml; do
          kubectl --kubeconfig ${tinkKubeconfig} -n tinkerbell apply --server-side --field-manager=metal-dev -f "$f" >/dev/null
        done
      '';
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        Restart = "on-failure";
        RestartSec = "30s";
      };
    };
    metal-dev-tailscale-up = {
      description = "Join the tailnet with this VM's Google service account identity";
      wantedBy = [ "multi-user.target" ];
      requires = [ "tailscaled.service" ];
      wants = [ "network-online.target" ];
      after = [
        "network-online.target"
        "tailscaled.service"
      ];
      startLimitIntervalSec = 0;
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = lib.getExe tailscaleUp;
        Restart = "on-failure";
        RestartSec = "30s";
      };
    };
    metal-dev-tailscale-serve = {
      description = "Serve the enrollment and attestation admin APIs on this host's tailnet name";
      wantedBy = [ "multi-user.target" ];
      wants = [
        "tailscaled.service"
        "metal-dev-tailscale-up.service"
      ];
      after = [
        "tailscaled.service"
        "metal-dev-tailscale-up.service"
      ];
      startLimitIntervalSec = 0;
      serviceConfig =
        let
          ts = "${config.services.tailscale.package}/bin/tailscale";
        in
        {
          Type = "oneshot";
          RemainAfterExit = true;
          ExecStart = [
            "${ts} serve --bg --https=${toString enrollAdminServePort} http://127.0.0.1:${toString enrollAdminPort}"
            "${ts} serve --bg --https=${toString attestAdminServePort} http://127.0.0.1:${toString attestAdminPort}"
          ];
          ExecStop = [
            "${ts} serve --https=${toString enrollAdminServePort} off"
            "${ts} serve --https=${toString attestAdminServePort} off"
          ];
          Restart = "on-failure";
          RestartSec = "30s";
        };
    };
  };
  systemd.timers.metal-dev-talos-mirror = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "2m";
      OnUnitActiveSec = "30m";
    };
  };

  # The spot VM is stopped between sessions; nothing here should keep it up.
  services.prometheus.exporters.node.enable = false;
}
