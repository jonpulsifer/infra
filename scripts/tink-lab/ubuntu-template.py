"""Turns the provision Template's spec.data (stdin) into the Ubuntu Template's (stdout).

The deltas are spike 06's, applied to the Template as it stands rather than to a copy of it:
the install action runs the Ubuntu installer image with DISK, PAYLOAD and NODE_HOSTNAME and
needs the payload the attest step leaves, and next-boot finds the ESP by its type, since
Ubuntu's has no name, and treats other entries named Ubuntu as stale. Everything else, the
serial check, the pull before the wipe, the EFI probe and the erase, stays as it is. Each
replaced text must occur exactly once, so a Template that has moved on fails here instead of
running half changed.
"""

import sys
import textwrap

DELTAS = [
    (
        "          INSTALLER_IMAGE: '{{ or (index . \"installer_image\") \"\" }}'\n",
        "          INSTALLER_IMAGE: '{{ or (index . \"installer_image\") \"\" }}'\n"
        "          PAYLOAD_FILE: /tmp/fleet/payload.tar.gz\n"
        "          NODE_HOSTNAME: \"{{ (index .Hardware.Interfaces 0).DHCP.Hostname }}\"\n",
    ),
    (
        '                check_disk "nothing installed"\n',
        '                if [ ! -s "$PAYLOAD_FILE" ]; then\n'
        '                  log "no payload: the attest step fetched none"\n'
        "                  exit 1\n"
        "                fi\n"
        '                check_disk "nothing installed"\n',
    ),
    (
        "                  --entrypoint /bin/installer \\\n"
        '                  "$INSTALLER_IMAGE" \\\n'
        '                  install --platform metal --disk "$DISK" --meta "0x0b=$code" >/tmp/fleet/install.log 2>&1 &\n',
        "                  --volume /worker/fleet:/tmp/fleet:ro \\\n"
        '                  --env DISK="$DISK" --env PAYLOAD="$PAYLOAD_FILE" --env NODE_HOSTNAME="$NODE_HOSTNAME" \\\n'
        '                  "$INSTALLER_IMAGE" >/tmp/fleet/install.log 2>&1 &\n',
    ),
    ('log "installed Talos to $DISK"', 'log "installed Ubuntu to $DISK"'),
    (
        """esp=$(sgdisk -p "$DISK" | awk '$NF == "EFI" { print $1; exit }')""",
        """esp=$(sgdisk -p "$DISK" | awk '$6 == "EF00" { print $1; exit }')""",
    ),
    ('fail "$DISK has no partition named EFI"', 'fail "$DISK has no EFI system partition"'),
    ("grep -F 'Talos Linux UKI' | grep -iv", "grep -E '^Boot[0-9A-Fa-f]{4}\\*? Ubuntu' | grep -iv"),
]


def indented(block: str, indent: str) -> str:
    return "".join(indent + line if line.strip() else line for line in block.splitlines(True))


def main() -> None:
    data = "\n" + sys.stdin.read()
    for old, new in DELTAS:
        old, new = textwrap.dedent(old), textwrap.dedent(new)
        if "\n" not in old:
            found = [("", data.count(old))]
        else:
            # A block starts a line, at the indentation it has in the Template.
            found = [(" " * i, data.count("\n" + indented(old, " " * i))) for i in range(0, 24, 2)]
        hits = [(indent, n) for indent, n in found if n]
        if len(hits) != 1 or hits[0][1] != 1:
            sys.exit(f"ubuntu-template: the Template does not have exactly one {old.strip()[:70]!r}")
        indent = hits[0][0]
        if "\n" not in old:
            data = data.replace(old, new)
        else:
            data = data.replace("\n" + indented(old, indent), "\n" + indented(new, indent))
    sys.stdout.write(data[1:])

main()
