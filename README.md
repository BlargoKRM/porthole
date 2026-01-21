# Porthole

A window into your local dev ports - discover, manage, and access your services from anywhere.

## The Problem

I do a lot of AI-assisted coding work using tools like [OpenCode](https://opencode.ai) on my home machine. The workflow is great when I'm at my desk - the AI makes changes, I see them instantly in my browser, I give feedback, iterate, and ship.

But what about when I'm away from my desk?

I often find myself:
- **On my phone** wanting to continue a coding conversation
- **Away from home** but my dev server is running with work in progress
- **Needing to see live changes** that an AI agent just made to my code

Yes, there's Claude Code in the browser and GitHub Copilot mobile - but those environments don't let you easily **run the build and see the changes immediately**. Not like on my home machine where it's live-reloading right there.

I wanted to **control my home dev environment from my phone** - see what's running, access my local services remotely, and eventually interact with AI coding agents on the go.

## The Vision

The ultimate goal is a mobile-friendly way to:

1. **See all my local dev services** - What's running on ports 3000, 4096, 5000?
2. **Access them remotely** - View my running Next.js app from my phone over cellular
3. **Interact with AI coding tools** - Talk to OpenCode, see what it's doing, give it feedback
4. **Watch changes happen** - See the AI make code changes and watch them hot-reload

Think about how easy it is to talk to ChatGPT on the iOS app - you just talk or type, it responds, done. No special commands, no complicated setup. I want that same experience but connected to my home machine's development environment.

## What Porthole Does (v1)

This is the foundation - solving problems #1 and #2 above:

- **Port Scanner** - Automatically discovers services running on common dev ports
- **Process Identification** - Shows which process owns each port (node, python, etc.)
- **Remote Access via ngrok** - Exposes the dashboard through a secure tunnel
- **Proxy Mode** - Access any local service through the main tunnel
- **Dynamic Tunnels** - Create dedicated URLs for specific services
- **OAuth Protection** - Secure everything with Google OAuth
- **Quick Launch** - Start common services with one tap
- **Mobile-First UI** - Card-based responsive design that works great on phones

## How It Works

```
┌─────────────────┐
│   Your Phone    │
│  (anywhere)     │
└────────┬────────┘
         │ HTTPS
         ▼
┌─────────────────┐
│  ngrok Tunnel   │
│  (OAuth gate)   │
└────────┬────────┘
         │
         ▼
┌────────────────────────────────────────────────────┐
│              Your Home Machine                      │
│  ┌──────────────────────────────────────────────┐  │
│  │              Porthole (:8888)                   │  │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────────┐   │  │
│  │  │ Scanner │  │  Proxy  │  │ Tunnel Mgr  │   │  │
│  │  └─────────┘  └─────────┘  └─────────────┘   │  │
│  └──────────────────────────────────────────────┘  │
│                        │                            │
│         ┌──────────────┼──────────────┐            │
│         ▼              ▼              ▼            │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│   │ Next.js  │  │ OpenCode │  │ API      │        │
│   │ :3000    │  │ :4096    │  │ :5000    │        │
│   └──────────┘  └──────────┘  └──────────┘        │
└────────────────────────────────────────────────────┘
```

### Port Scanning

On page load, Porthole scans configured port ranges using TCP connections. For each open port, it uses `lsof` to identify the process.

### Proxy Mode

Click "Proxy" to access any local service through the main ngrok tunnel. Porthole forwards all requests (including assets) to the target port. Great for quick access without creating extra tunnels.

### Dynamic Tunnels

Click "Tunnel" to create a dedicated ngrok URL for a service. Useful for:
- WebSocket apps that need their own origin
- OAuth callbacks that need a stable URL
- Sharing a specific service with someone

### OAuth Protection

The main tunnel uses ngrok's traffic policy to enforce Google OAuth, restricted to your email domain. Only you can access your services.

## Setup

### Prerequisites

- **Node.js** v14+
- **ngrok** installed and authenticated (`ngrok config add-authtoken YOUR_TOKEN`)
- **ngrok account** - Free works, paid recommended for custom domains and multiple tunnels

### Installation

```bash
git clone https://github.com/yourusername/porthole.git
cd porthole
cp config.example.json config.json
# Edit config.json with your settings
```

No `npm install` needed - zero dependencies!

### Configuration

```json
{
  "serverPort": 8888,
  "ngrok": {
    "domain": "your-subdomain.ngrok.dev",
    "allowedEmailDomain": "@your-domain.com"
  },
  "portRanges": [
    [3000, 3100],
    [4000, 4100],
    [5000, 5100]
  ],
  "quickLaunch": [
    {
      "name": "My App",
      "command": "npm run dev",
      "port": 3000
    }
  ]
}
```

| Option | Description |
|--------|-------------|
| `serverPort` | Port Porthole runs on |
| `ngrok.domain` | Custom ngrok domain (optional) |
| `ngrok.allowedEmailDomain` | Email domain for OAuth (e.g., `@gmail.com`) |
| `portRanges` | `[start, end]` ranges to scan |
| `quickLaunch` | Commands for Quick Launch buttons |

### Running

```bash
node server.js
```

Output:
```
Porthole server running at http://localhost:8888
Starting ngrok tunnel...
Tunnel active at https://your-domain.ngrok.dev
```

Now open that URL on your phone!

## Lessons Learned

### ngrok Local API

ngrok runs a local API on port 4040:
```bash
# List tunnels
curl http://localhost:4040/api/tunnels

# Create tunnel
curl -X POST -H "Content-Type: application/json" \
  -d '{"addr":"3000","proto":"http","name":"my-tunnel"}' \
  http://localhost:4040/api/tunnels

# Delete tunnel
curl -X DELETE http://localhost:4040/api/tunnels/my-tunnel
```

### Traffic Policies

ngrok traffic policies (OAuth, IP restrictions) can only be set via CLI flags or the cloud API - not the local API. So dynamic tunnels don't get OAuth protection (use the proxy instead for protected access).

### Reusing ngrok Sessions

When starting up, Porthole checks if ngrok is already running with the right config. If so, it reuses the existing tunnel instead of killing and restarting. Faster startup, no URL changes.

## Tech Stack

- **Node.js** - Runtime
- **Zero dependencies** - Only built-in modules (`http`, `net`, `child_process`, `fs`)
- **ngrok** - Tunneling with OAuth
- **Vanilla CSS** - Mobile-first responsive design

## Future Ideas

This is v1. The bigger vision includes:

- [ ] **OpenCode integration** - See OpenCode's output, send commands
- [ ] **Live terminal view** - Watch builds and logs from your phone
- [ ] **Voice input** - Talk to your AI coding agent
- [ ] **Push notifications** - Get notified when a build completes or agent needs input
- [ ] **File browser** - View and edit files remotely
- [ ] **Git integration** - Commit, push, see diffs from mobile

The dream: a mobile app that's as easy as ChatGPT but connected to your full local dev environment.

## Contributing

Ideas and PRs welcome! This started as a personal tool but I'd love to see where others take it.

## License

MIT
