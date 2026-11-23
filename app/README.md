# OIP Network Display

A browser-based rewrite of the OIP visualizer for a classroom display. Hosts are
drawn as nodes grouped by subnet, and each packet is a glowing dot travelling
from its source to its destination. The Internet is one node at the top.

It has two views, switched with `G`:

- **Graph**: hosts as nodes, packets travelling between them.
- **Grid**: replaces the older `ipvisualizer` project. Every address in one
  network (up to a /16) is a square, laid out so each /24 is a 16x16 block.
  Squares light in the color of the traffic and fade over a few seconds.
  Hover a square for its address, click a block for its busiest hosts. A ping
  sweep shows up as a line crossing a block; a busy server as one bright square.

It runs two ways:

- **Demo**: simulated classroom traffic with short captioned scenarios (web
  browsing, DNS lookup, ping sweep, port scan, large transfer, many clients to
  one server). Needs nothing but Node.
- **Live**: real traffic captured with `tshark` and streamed to the page.

Only packet metadata is used (addresses, protocol, size). Payloads are never
read or sent to the browser.

## Run it

Requires Node 20+. No `npm install`.

```
cd app
node server.mjs
```

Open http://localhost:8080 and press `F` for full screen.

## Live capture

Install Wireshark (on Windows, with Npcap). Then list interfaces and pick one:

```
node server.mjs --list
node server.mjs --iface 6
```

Other options:

| Option | Meaning |
| --- | --- |
| `--filter "<bpf>"` | Capture filter, e.g. `"not port 22"` |
| `--pcap file.pcap` | Replay a capture file instead of capturing |
| `--speed 2` | Replay speed multiplier |
| `--port 8080` | HTTP port |
| `--localnet 10.1.0.0/16` | Network shown in the grid (also `localnet` in config). If unset, the busiest private /16 seen is used |
| `--host 0.0.0.0` | Listen on the network so another machine can show the page |
| `--public-port 8091` | Second listener that serves only aliased data (see below) |
| `--public-host <addr>` | Address for the public listener (default: same as `--host`) |
| `--alias` | Alias the main listener too |

Defaults can also go in `config.json` (copy `config.example.json`), including
`names` to label hosts or subnets (`"10.0.1.0/24": "Classroom"`). Private
addresses are also looked up in reverse DNS.

A capture only sees traffic that reaches the capturing machine. To see the
whole classroom, capture on a mirror (SPAN) port or on the gateway. On a normal
switched port you will see only that machine's own traffic.

Listening on `0.0.0.0` exposes who is talking to whom to anyone who can reach
the port. Keep it on `127.0.0.1` unless you need a second machine.

## Capturing on a firewall or router over SSH

If a firewall sits in the path (for example OPNsense), it already sees every
packet that crosses VLANs, so no mirror port is needed. The server can run the
capture there and stream it back:

```
node server.mjs --ssh oipcap@192.168.200.1 --ssh-key ~/.ssh/oip_capture_ed25519
```

or in `config.json`:

```json
{ "capture": { "ssh": "oipcap@192.168.200.1", "key": "~/.ssh/oip_capture_ed25519" } }
```

On the firewall, create a user whose key is restricted to a single command in
`authorized_keys`, and allow that one command with `sudo`:

```
command="/usr/local/bin/sudo /usr/sbin/tcpdump -i vlan0.200 -n -s 96 -U -w -",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA... oip-capture
```

```
oipcap ALL=(root) NOPASSWD: /usr/sbin/tcpdump -i vlan0.200 -n -s 96 -U -w -
```

Notes:

- Capture on the VLAN interface, not the WAN. Behind NAT, WAN traffic shows only the firewall's address.
- A firewall only sees traffic that crosses it. Hosts talking within one VLAN need a mirror port.
- `-s 96` keeps only headers, which is all the display uses.
- The capture's own SSH session is hidden from the display.
- If a connection drops it retries with a growing delay. A refused key, or five instant failures in a row, stops the retries, so a bad key cannot trigger the firewall's login lockout.

## Public display with aliased names

The normal page shows real device addresses, so it is for staff. To show live
traffic on a screen others can see (a lobby, a signage player), run a second
listener that only ever serves aliases:

```
node server.mjs --public-port 8091
```

or `"publicPort": 8091` in `config.json` (`publicHost` picks its address; it
defaults to `host`). The main port keeps serving real data to staff. Point the
public screen at the public port and keep the main port closed to everyone else.

On the public port:

- Every address is replaced by a fake one that keeps the network's shape: hosts
  that share a real subnet share a fake subnet, a real /16 stays a /16, and
  broadcast and multicast are unchanged. Private addresses become `10.x.y.z`,
  public ones `198.18.x.x`.
- Every host gets a random device name such as "Amber Falcon", and every subnet a
  name such as "Zone Delta". Real hostnames and the `names` in `config.json` are
  never used.
- The capture source, the SSH user and any error text are replaced by generic
  text ("Live capture").
- The grid shows the fake network. Use `localnet` as a /16 or /24 so it maps cleanly.

The mapping is keyed by a secret in `app/.alias-secret`, created on first run
(mode 600, git-ignored). It stays on the server, so the same device keeps the same
alias across restarts and nothing can be reversed from the output. Delete the file
to give every device a new alias. Keep it out of backups that others can read.

The page requests `api/status` and `events` relative to its own address, so
another server can relay the public port under a path (for example `/oip/`) and
the page works there unchanged. Serve it with a trailing slash (`/oip/`). The
relay must not buffer or compress `events`, which is a long-lived stream.

What aliasing does not hide: how much traffic there is, when it happens, which
protocols are used, how many devices are active, and which devices talk to which
(under their aliases). Someone who knows how a particular device behaves could
still guess which alias it is. For the most conservative option, show
`?demo` (simulated traffic) instead. `--alias` makes the main port aliased too.

## Controls

| Key | Action |
| --- | --- |
| Space | Pause / resume |
| G | Switch between graph and address grid |
| Click | Grid: select a /24 block |
| D | Switch between live and demo |
| N | Next demo scenario |
| L | Labels: auto, all, off |
| I | Group outside addresses into one Internet node, or show each |
| + / - | Larger / smaller hosts and text |
| H | Hide / show the overlays |
| F | Full screen |
| ? | Help |
| Drag | Move a host |

Add `?demo` to the URL to force demo mode, `?view=grid` to start on the grid, or `?net=10.1.0.0/16` to pick the grid network.

## Colors

Chosen to stay distinguishable for color-blind viewers.

| Color | Traffic |
| --- | --- |
| Blue | Web (HTTP, TLS, QUIC) |
| Yellow | DNS |
| Green | Other TCP |
| Orange | Other UDP |
| Red | ICMP (ping) |
| Purple | Anything else |

Broadcast and multicast traffic appears as a ring expanding from the sender.

## Layout of the code

- `server.mjs`: static files, tshark wrapper, Server-Sent Events stream
- `public/js/sim.js`: hosts, links, packets, force layout
- `public/js/render.js`: canvas drawing for the graph
- `public/js/grid.js`: address grid (Z-order layout, fade, hover and selection)
- `public/js/demo.js`: simulated network and scenarios
- `public/js/main.js`: sources, overlay, keyboard

The original C++/SDL 1.2 implementation in the repository root is unchanged. The grid replaces the separate `btech-ipvisualizer` project, whose firewall (ULOG) display is not carried over.
