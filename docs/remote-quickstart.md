# Remote Quickstart

This guide is the shortest supported path for running OpenAlice on a private
Linux or macOS host while keeping the browser on your laptop. It explains the
daily workflow, the security and lifetime model, and the product ideas behind
the design.

The current remote path is a source-backed preview on the `dev` lane. It is
suitable for personal dogfooding and private development hosts, but it is not
yet a signed standalone headless release. The authoritative lifecycle,
protocol, recovery, and compatibility contract remains
[[docs/remote-access.md]]. For an HTTPS/container deployment, use
[[docs/docker-deployment.md]] instead.

## Choose the Right Surface

| Need | Recommended surface |
|---|---|
| Complete local desktop installation | Electron |
| Local source checkout in a browser | `openalice start` |
| Private remote machine reached through SSH | `openalice remote` |
| Already-running remote Server; tunnel only | `openalice ssh` |
| Durable container behind HTTPS, Tailscale, or a private proxy | Docker deployment |

Electron remains a complete distribution. The CLI and remote path add another
way to use OpenAlice; they do not replace the packaged desktop app.

## Mental Model

```text
laptop
  openalice CLI
    └── ssh -L 127.0.0.1:<local-port>:127.0.0.1:47331
          └── remote host
                Guardian-owned OpenAlice Server
                  ├── Alice HTTP + WebSocket on 127.0.0.1:47331
                  ├── Workspace files and persistent state
                  ├── Shell and Agent PTYs
                  ├── managed Pi and other native Agent CLIs
                  └── optional UTA and Connector Service

laptop browser
  └── http://127.0.0.1:<local-port>
        └── the SSH tunnel above
```

The browser renders locally. The source checkout, Workspace files, shell,
Agent process, tools, provider request, and optional trading Runtime all run on
the remote host. Normal page traffic and the Workspace PTY WebSocket share the
same loopback tunnel.

This differs from opening SSH and launching a TUI inside the remote shell. In
that traditional path, the TUI itself runs remotely and its terminal byte
stream crosses SSH. In the OpenAlice browser path, menus, layout, Markdown, and
most application presentation remain local, while the embedded shell or Agent
terminal still reflects a remote PTY and therefore still pays network latency.

## Prerequisites

On the laptop:

- macOS, Linux, or WSL with `curl` and OpenSSH;
- Node.js `22.19.0` or newer;
- SSH access to the target host.

On the remote host:

- Linux or macOS;
- Node.js `22.19.0` or newer;
- `curl`, Git, and a clone of OpenAlice;
- enough disk and memory to install dependencies and build the source Runtime.

The managed remote flow can offer to install missing Linux source-build tools
after showing the exact plan. It does not install Node.js, clone the repository,
configure SSH, or copy provider credentials from the laptop.

Prefer a concrete alias in `~/.ssh/config`:

```sshconfig
Host openalice-box
  HostName server.example.com
  User alice
  IdentityFile ~/.ssh/id_ed25519
```

Verify ordinary SSH first:

```bash
ssh openalice-box
```

OpenAlice deliberately delegates keys, agents, host verification, ports,
`ProxyJump`, and other transport policy to OpenSSH.

## One-Time Setup

### 1. Prepare the remote checkout

Clone the current preview lane on the remote host:

```bash
ssh openalice-box \
  'git clone --branch dev https://github.com/TraderAlice/OpenAlice.git "$HOME/OpenAlice"'
```

Ask the remote shell for the absolute path. `openalice remote` intentionally
rejects `~` in `--app-dir` so the plan always names one unambiguous checkout:

```bash
ssh openalice-box 'cd "$HOME/OpenAlice" && pwd'
```

The examples below use `/home/alice/OpenAlice`; replace it with that output.

### 2. Install the local CLI

The preview installer shows its complete plan before asking for consent:

```bash
curl -fsSL https://raw.githubusercontent.com/TraderAlice/OpenAlice/dev/install | bash -s -- --branch dev
```

Open a new terminal so the managed PATH block is active, then verify both
commands:

```bash
openalice --version
openalice version --json
pi --version
```

The installer adds the small `openalice` CLI and a pinned, release-local Pi. It
does not install Electron, clone OpenAlice, start a service, or configure an AI
provider. The JSON version output records this local CLI's version, installer
source, and selector. Managed remote uses that record when the remote control
CLI is missing or different; `openalice remote` has no separate branch/version
flag.
See [[docs/cli-installer.md]] for the transaction and trust model.

### 3. Review the remote plan

Run a read-only probe first:

```bash
openalice remote openalice-box \
  --app-dir /home/alice/OpenAlice \
  --plan
```

The plan reports the target, platform, Node.js version, checkout, CLI and Pi
versions, Server owner, build requirements, ports, and every proposed
mutation. `--plan` never installs, starts, stops, or replaces anything.

### 4. Connect

Run the same command without `--plan`:

```bash
openalice remote openalice-box \
  --app-dir /home/alice/OpenAlice
```

After explicit consent, the command can:

1. install or update the ordinary OpenAlice CLI on the remote host;
2. install the pinned managed Pi when it is missing or incompatible;
3. install missing Linux source-build tools declared by the plan;
4. prepare the source Runtime;
5. start or reuse a detached Guardian-owned Server;
6. open a local SSH loopback tunnel and browser URL.

The first step makes the remote host pull the small matching control CLI from
its recorded installer URL. OpenAlice is not uploaded from the laptop through
SSH. The large source Runtime remains the checkout named by `--app-dir` and is
prepared on that host; `remote` never checks out or switches its Git branch.

The first preparation can take several minutes. Successful build output is
compact; a failed phase includes a bounded diagnostic tail.

### 5. Configure the remote Runtime in the browser

Create or open a Workspace and complete AI Provider setup in OpenAlice. The
credential, Workspace, Session history, and Agent state are stored under the
remote `OPENALICE_HOME`, not copied back to the laptop. Pi is already available
through the managed runtime installed with the remote CLI.

## Everyday Use

Reconnect with the same command:

```bash
openalice remote openalice-box \
  --app-dir /home/alice/OpenAlice
```

OpenAlice remembers the last successful local port for the target and remote
home. If that port is free, an existing browser tab can recover on the same
localhost origin. To reserve an explicit origin instead:

```bash
openalice remote openalice-box \
  --app-dir /home/alice/OpenAlice \
  --local-port 49891
```

Useful variations:

```bash
# Print the URL instead of opening the browser.
openalice remote openalice-box \
  --app-dir /home/alice/OpenAlice \
  --no-open

# Tunnel only when a compatible Server is already running.
openalice ssh openalice-box

# Use an identity without adding an SSH config alias.
openalice remote alice@server.example.com \
  --identity ~/.ssh/id_ed25519 \
  --app-dir /home/alice/OpenAlice
```

Pressing `Ctrl+C` closes only the local tunnel. The detached remote Server,
Workspace, PTYs, and Agent processes keep running. Reconnecting creates another
tunnel to the same Runtime.

## Status, Stop, and Ownership

Inspect the remote Server without changing it:

```bash
ssh openalice-box \
  '"$HOME/.openalice/bin/openalice" server status'
```

Stop it explicitly:

```bash
ssh openalice-box \
  '"$HOME/.openalice/bin/openalice" server stop'
```

`server stop` asks the owning Guardian to shut down its own tree. It does not
guess a PID or delete a live lock. A normal `remote` command also refuses to
replace an Electron session, another launcher, an unhealthy Runtime, or an
incompatible owner. `--takeover` is a separate explicit authority and should
only be used after inspecting `server status`.

## Security and Persistence

- Alice stays bound to remote `127.0.0.1`; SSH authenticates and encrypts the
  transport.
- Do not publish port `47331` directly and never use
  `OPENALICE_DISABLE_AUTH=1` for remote access.
- Use a least-privilege remote account and the same SSH host-key discipline as
  any other development server.
- Back up the remote source checkout and `OPENALICE_HOME` according to the
  value of the data. The browser is a client, not a backup.
- An SSH disconnect does not stop a detached Server. A destroyed VM, container,
  or ephemeral sandbox can still destroy its local filesystem.

Railway Sandboxes were useful for clean-host acceptance, including a real Pi
provider round trip, but Railway describes them as experimental and ephemeral.
They are appropriate for temporary dogfooding, not the only copy of important
Workspace state. For a durable host, use a persistent VM or the Docker path
with a volume and private HTTPS/Tailscale access.

## Why This Architecture

OpenAlice did not start by inventing a hosted Studio protocol. The first goal
was to make the existing local/server boundary real, measurable, and useful:

1. one CLI can start the same product locally or manage it remotely;
2. one detached Server owns files, processes, credentials, and lifecycle;
3. SSH supplies an already-understood private transport;
4. the existing browser UI remains a replaceable client;
5. Electron remains complete while sharing the same Runtime concepts.

That ordering lets us dogfood remote work before committing to a relay,
pairing system, or application-specific remote protocol.

### Drizzle Studio: a browser can be a distribution surface

[`drizzle-kit studio`](https://orm.drizzle.team/docs/drizzle-kit-studio)
starts a loopback server and opens a browser-based database UI. The useful
lesson is the product shape: installing a small CLI can be enough to make a
rich local tool available without asking every user to build a repository or
install a desktop shell.

OpenAlice borrows that low-friction entry shape, but initially serves its UI
and APIs from one Runtime-owned localhost origin. This avoids making hosted
domains, cross-domain cookies, and public network exposure prerequisites for
the CLI path.

### Herdr: durable Runtime, replaceable clients

[`herdr`](https://github.com/ogulcancelik/herdr) separates persistent terminal
state and PTYs from attached clients. Its remote mode keeps a thin client local,
reaches the server through SSH, and leaves agents running after detach. The
important lesson is ownership: the host with the files owns execution and
durable Runtime facts; presentation can disconnect and return.

Herdr can stream a matching compact binary to the host. OpenAlice deliberately
does not copy that mechanism for its much larger Runtime: SSH carries control
commands, the remote host pulls the small CLI itself, and a future standalone
headless bundle must be a versioned CDN download rather than a laptop upload.

OpenAlice starts with a simpler transport than Herdr's private framed TUI
protocol: the existing HTTP and Workspace WebSocket cross an SSH loopback
tunnel unchanged. We will add terminal snapshot/diff/backpressure semantics
only if real latency measurements justify them. The pinned source comparison
lives in [[docs/reference/herdr-remote-architecture.md]].

### Codex: an Agent Runtime can power multiple rich clients

Codex exposes an open-source
[`app-server`](https://github.com/openai/codex/tree/main/codex-rs/app-server)
behind rich interfaces. Its
[documented SSH remote flow](https://learn.chatgpt.com/docs/remote-connections.md#connect-to-an-ssh-host)
starts the Codex app-server on the remote host while the desktop client remains
local. Its
[remote TUI mode](https://learn.chatgpt.com/docs/app-server.md#connect-the-cli-terminal-ui)
likewise separates a local terminal client from an app-server transport.

That validates the longer-term direction: OpenAlice can eventually expose a
versioned, presentation-neutral Runtime snapshot/event protocol for Electron,
a local browser, or an independent Studio. We deliberately have not copied the
Codex protocol. Stage 2 first proves our own ownership, lifecycle, security,
and compatibility boundaries over the browser protocol we already operate.

### Traditional Agent TUI over SSH: the compatibility baseline

Running Claude Code, Codex, opencode, or Pi after `ssh host` remains the most
compatible fallback. It is often perfectly usable, especially on a good
connection. It also makes the remote terminal application responsible for
every redraw sent through the outer SSH terminal stream.

OpenAlice therefore keeps Shell and native Agent PTYs available, but does not
make a remotely rendered heavyweight TUI the only product surface. The browser
path lets us measure the remaining PTY latency independently from the rest of
the UI before building a more specialized terminal transport.

## Current Limits

- The remote host must already contain an OpenAlice checkout; `remote` does not
  clone or update source.
- The preview installer follows mutable `dev` rather than signed immutable
  release assets.
- Linux and macOS remote hosts are supported; the native Windows distribution
  remains Electron.
- One interactive browser per terminal is the conservative assumption until
  controller/observer and resize authority are explicit.
- Representative 20/80/150 ms Agent TUI measurements are still needed before
  deciding whether to build a structured terminal transport.
- A hosted independent Studio, device pairing, relay access, and a standalone
  headless Runtime bundle are later stages, not hidden features of this path.

For implementation details, failure classes, protocol versions, recovery, and
the staged roadmap, continue with [[docs/remote-access.md]].
