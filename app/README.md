# OIP Network Display

A browser-based rewrite of the OIP visualizer for a classroom display. Hosts are
drawn as nodes grouped by subnet, and each packet is a glowing dot travelling
from its source to its destination. The Internet is one node at the top.

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
| `--host 0.0.0.0` | Listen on the network so another machine can show the page |

Defaults can also go in `config.json` (copy `config.example.json`), including
`names` to label hosts or subnets (`"10.0.1.0/24": "Classroom"`). Private
addresses are also looked up in reverse DNS.

A capture only sees traffic that reaches the capturing machine. To see the
whole classroom, capture on a mirror (SPAN) port or on the gateway. On a normal
switched port you will see only that machine's own traffic.

Listening on `0.0.0.0` exposes who is talking to whom to anyone who can reach
the port. Keep it on `127.0.0.1` unless you need a second machine.

## Controls

| Key | Action |
| --- | --- |
| Space | Pause / resume |
| D | Switch between live and demo |
| N | Next demo scenario |
| L | Labels: auto, all, off |
| I | Group outside addresses into one Internet node, or show each |
| + / - | Larger / smaller hosts and text |
| H | Hide / show the overlays |
| F | Full screen |
| ? | Help |
| Drag | Move a host |

Add `?demo` to the URL to force demo mode.

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
- `public/js/render.js`: canvas drawing
- `public/js/demo.js`: simulated network and scenarios
- `public/js/main.js`: sources, overlay, keyboard

The original C++/SDL 1.2 implementation in the repository root is unchanged.
