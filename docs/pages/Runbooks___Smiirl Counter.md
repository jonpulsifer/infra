tags:: runbook, smiirl

- Use this when the Smiirl split-flap counter on the iot VLAN stops following the page, shows the wrong flaps, or refuses to join Wi-Fi. The counter runs stock firmware and believes it talks to Smiirl's cloud; `apps/smiirl` is that cloud, running on folly behind the Gateway in `clusters/folly/apps/smiirl/`, and the lab resolvers answer `api.smiirl.com` with that Gateway's address (`nix/services/coredns-sinkhole.nix`). Network background is on [[Architecture/Networking]].
- # Quick checks
	- The page and its API live at `https://smiirl.lolwtf.ca` (also `https://counter.lolwtf.ca`). `device.online` is true when the counter has polled within the last minute:
	- ```bash
	  curl -s https://smiirl.lolwtf.ca/api/state | jq .device
	  ```
	- The counter must resolve `api.smiirl.com` to the Gateway's pinned address. Ask a lab resolver directly (capsule and spore both serve it):
	- ```bash
	  ssh capsule.lolwtf.ca getent hosts api.smiirl.com
	  ```
	- The app answers the counter's boot-time check byte for byte like the cloud. Through the Gateway, on the device hostname:
	- ```bash
	  curl -s -D - -H 'Host: api.smiirl.com' http://10.3.0.84/number
	  ```
	- Expected: `content-length: 12` and exactly `{"number":1}`.
	- The counter's own web server answers on its iot address (find it by MAC on the controller, see [[Runbooks/Inspect UniFi Network]]):
	- ```bash
	  curl -s http://<counter-ip>/cgi-bin/luci/smiirl/api/version
	  ```
	- Every change reaches the app's log (`kubectl -n smiirl logs deploy/smiirl`), one line per handover.
- # How the counter talks
	- Plain HTTP, `User-Agent: ESP32 HTTP Client/1.0`, always to `api.smiirl.com`. `apps/smiirl/main.go` implements every route it uses; `apps/smiirl/README.md` lists them.
	- After joining Wi-Fi it fetches `GET /number` and compares the reply literally with the cloud's `{"number":1}`; any other byte (a trailing newline, a different length) makes the setup wizard report "Counter does not have access to internet" and fall back to its own access point.
	- It then bootstraps with `GET /v1.0/<mac>/<key>`, which tells it what URL to poll and how often, posts a status report, and polls `GET /<mac>/number` about every 20 seconds. The app holds that poll and answers the moment the display should change.
	- The display is five cells over `0-9`, `a` (blank flap) and `b` (striped flap). A plain number goes to the counter as an integer and shows with leading blanks; anything else (stripes, explicit leading zeros) goes as a five-character string.
	- The counter shows one mode at a time, chosen on the page or with `PUT /api/mode`: the number (with the daily step), the clock as `HH` stripes `MM` in `Canada/Atlantic` (24-hour, or 12-hour with a blank flap for the leading zero when `hour12` is set), today's date as month stripes day, the days until or since a date, a countdown to a moment as hours stripes minutes, the time since a moment the same way, a GitHub login's public commits or pull requests, or a cycle that hands the drums to each of a list of modes in turn. The app recomputes the display every second while a poll is held, so a clock, a countdown or a cycle turn lands within a poll.
	- Every mode's setting is kept whether or not that mode has the drums, so switching back never asks for it again. A cycle silently drops any member whose setting has gone and refuses to be left with fewer than two it can show.
	- The GitHub count comes from the public search API with no token, asked at most once every five minutes. A failed fetch leaves the last number on the drums and reports itself on the page; the pod reaches `api.github.com` directly, so this is the one mode that needs egress.
	- The page is a PWA: `manifest.webmanifest`, `sw.js` and the icons come out of the same binary, so it installs to a home screen and opens offline. The service worker caches the shell and never `/api`, and a deploy wins on the first load with a network.
	- The counter turns a drum a full revolution for any change at all, however small: measured on the device on 2026-09-07, `11112` to `11113` turned the drums exactly as far as a wholesale change did, through both the integer form and the cells string. Between changes the drums sit still, even though the counter keeps polling every twenty seconds. The cost is therefore per change, not per flap, and no value the app can choose makes a change cheaper.
	- What that leaves is changing less often. `tick` coarsens the clock, the countdown and the countup to a multiple of N minutes: at `tick` 5 the clock turns the drums twelve times an hour instead of sixty. It is 1 by default. A mode that changes once a day (`date`, `days`) or on demand (`number`) costs a turn only then.
	- `device.lastSent` in `/api/state` is what the counter was actually handed, as opposed to what the app would hand it now; the two differ while a change waits out the ten-second settle, and only the former moved the drums.
	- The app never hands the counter a different value less than ten seconds after the previous one. Each drum needs seconds per flip, and values arriving mid-turn leave drums out of step.
	- Only the counter opens connections. Nothing needs to reach it from the cluster. No firewall rule gates the path either: the Gateway address is a Cilium LB VIP, which is in no UniFi zone, so iot traffic to it takes the gateway's `→ WAN` fall-through rather than an iot→Lab policy — see [[Architecture/Networking]].
- # Set the number
	- The page is the normal way. From a shell on the LAN:
	- ```bash
	  curl -s -X PUT -H 'Content-Type: application/json' -d '{"number":42}' https://smiirl.lolwtf.ca/api/number
	  curl -s -X PUT -H 'Content-Type: application/json' -d '{"cells":"aa3b2"}' https://smiirl.lolwtf.ca/api/number
	  curl -s -X PUT -H 'Content-Type: application/json' -d '{"step":1,"at":"08:00"}' https://smiirl.lolwtf.ca/api/daily
	  curl -s -X PUT -H 'Content-Type: application/json' -d '{"mode":"clock"}' https://smiirl.lolwtf.ca/api/mode
	  curl -s -X PUT -H 'Content-Type: application/json' -d '{"mode":"clock","hour12":true}' https://smiirl.lolwtf.ca/api/mode
	  curl -s -X PUT -H 'Content-Type: application/json' -d '{"mode":"days","date":"2026-12-25"}' https://smiirl.lolwtf.ca/api/mode
	  curl -s -X PUT -H 'Content-Type: application/json' -d '{"mode":"countdown","at":"2026-12-25T08:00"}' https://smiirl.lolwtf.ca/api/mode
	  curl -s -X PUT -H 'Content-Type: application/json' -d '{"mode":"countup","at":"2026-01-01T00:00"}' https://smiirl.lolwtf.ca/api/mode
	  curl -s -X PUT -H 'Content-Type: application/json' -d '{"mode":"clock","tick":5}' https://smiirl.lolwtf.ca/api/mode
	  curl -s -X PUT -H 'Content-Type: application/json' -d '{"mode":"github","user":"jonpulsifer","what":"commits"}' https://smiirl.lolwtf.ca/api/mode
	  curl -s -X PUT -H 'Content-Type: application/json' -d '{"mode":"cycle","modes":["clock","date","github"],"every":5}' https://smiirl.lolwtf.ca/api/mode
	  ```
	- The daily step runs in `Canada/Atlantic` and catches up missed days after a restart. The number itself is on the `smiirl-data` volume in the `smiirl` namespace.
	- The counter's local test endpoint sets the flaps directly and blocks until the firmware's fixed wait ends (about ten seconds), but the next poll overwrites it:
	- ```bash
	  curl -s "http://<counter-ip>/cgi-bin/luci/smiirl/api/test/number?number=00042"
	  ```
- # If the page says the counter hasn't checked in
	- The counter is not polling the app. In order of likelihood:
	- DNS still points at the cloud: the quick check above must return the Gateway address on both capsule and spore. They pick up `main` on their nightly upgrade; to apply sooner, run the host's own upgrade unit (`sudo systemctl start nixos-upgrade.service`), one host at a time, as in [[Runbooks/Deploy a NixOS Host]].
	- The counter is idle: opening its setup wizard pages (anything under `http://<counter-ip>/`) stops its cloud loop until it is power-cycled.
	- The counter is off the Wi-Fi: no client with its MAC on the controller. Re-run its setup wizard (`SmiirlSetup` network, then `192.168.1.1`).
	- The Gateway is not programmed, or the pod is not running: `kubectl -n smiirl get gateway,pods`. Route and pod checks are on [[Runbooks/Kubernetes GitOps Change]].
	- The app is wedged on its NFS volume: `/api/state` hangs and the pod's log stops mid-stream, while the pod reads `1/1 Running` and `/healthz` and `/number` still answer instantly. Those two routes take no lock; a write to the `smiirl-data` volume that never returns leaves the state lock held, so `/api/state` and the counter's poll are the only things that hang. The volume is NFS from spore:
	- ```bash
	  curl -s --max-time 5 -o /dev/null -w '%{http_code}\n' https://smiirl.lolwtf.ca/api/state
	  rpcinfo -T tcp $(jq -r .data.SPORE_IP clusters/folly/config/lab-topology.json) nfs
	  ```
	- A dead server answers `Program not registered`. Fix it on spore, not here: `systemctl status nfs-server nfs-data-directories` and start `nfs-server.service`. Clients recover on their own once nfsd answers, with no pod restarts.
- # If the setup wizard says "Counter does not have access to internet"
	- Its check is the byte-exact `GET /number` above. Verify it through the Gateway first.
	- To see exactly what the counter asks, capture on the UDM by MAC on the iot bridge. The `-i any` pseudo-interface cannot filter by MAC and silently captures nothing:
	- ```bash
	  UNIFI_SSH_HOST=10.13.37.1 .agents/skills/unifi-network/unifi.sh ssh \
	    'timeout 120 tcpdump -nn -A -s0 -i br666 "ether host <counter-mac>"'
	  ```
	- The counter tries the check three times a second apart, then drops back to its access point and retries a minute later.
- # If the flaps show the wrong digits
	- The drums position themselves to the value the firmware sends, offset by a per-drum calibration the firmware stores. Values arriving faster than the drums turn, or a scrambled calibration, leave every later value landing a fixed distance off (stripes where blanks belong, a 7 where a 0 belongs). No value the app can send corrects that: relative moves preserve the offset.
	- The fix is the firmware's own calibration wizard, from any browser on the LAN:
	- Point the app at all stripes first, so its poll matches what the firmware believes during the wizard:
	- ```bash
	  curl -s -X PUT -H 'Content-Type: application/json' -d '{"cells":"bbbbb"}' https://smiirl.lolwtf.ca/api/number
	  ```
	- Open `http://<counter-ip>/calibrate/index.html`. Step 1, "WHAT DO YOU SEE?": tap each box until it matches the physical flap, left to right (digits, then blank, then stripes), then NEXT and wait about ten seconds. The firmware records the offsets and turns every drum to stripes.
	- Step 2, "CLICK ON THE DIGIT IF YOU SEE STRIPES": mark every drum that shows stripes. When all five are marked, NEXT saves the calibration and reboots the counter. If some drums are not on stripes, NEXT re-drives those; mark again and repeat.
	- After "COUNTER IS REBOOTING", wait for `device.online` and set the number back through the page or the API. Every drum steps one flap from stripes to its digit; a correct result here proves the calibration.
	- A drum that still lands one flap off after a clean calibration is mechanical. Re-run the wizard once; if it persists, that module needs attention, not software.
- # Take the counter back to the cloud
	- Remove the `api.smiirl.com` line from `nix/services/coredns-sinkhole.nix`, merge, and let capsule and spore upgrade. The counter then resolves the real service and needs a Smiirl account again. The app and page keep running; they just stop being polled.
