# Docker Deployment

This guide owns the OpenAlice server-image contract, Docker Compose lifecycle,
remote-host safety boundary, and container smoke requirements. It complements
[[docs/project-structure.md]] and [[docs/managed-workspace-runtime.md]].

## Topology

The image is the non-Electron production topology:

```text
tini (PID 1)
└── scripts/guardian/prod.mjs
    ├── Alice HTTP + Workspace process
    └── optional UTA process

/app   immutable image resources
/data  persistent operator state and Workspaces
```

Only Alice's web port `47331` is published. The CLI/MCP gateway and UTA stay on
container loopback. Workspace agents reach Alice through the injected
`alice`, `alice-workspace`, `alice-uta`, and `traderhub` CLI launchers; remote
clients must not expose the internal tool gateway as a replacement API.

The server image installs pinned Claude Code and Codex runtimes. Unlike the
desktop package, it does not currently bundle managed Pi, and it does not
install opencode. Version changes are deliberate Dockerfile changes so a
cached/rebuilt image cannot silently acquire a different native runtime.

## Start and Authenticate

```bash
docker compose up -d --build
docker compose ps
docker compose logs openalice
```

The first boot prints a one-time admin token. Store it in a password manager
and use it on the web login screen. The token hash, sessions, Workspaces,
credentials, reports, and trading state persist in the `openalice-data`
volume. Authenticate the agent runtime you intend to use:

```bash
docker exec -it openalice claude
docker exec -it openalice codex login
```

Never set `OPENALICE_DISABLE_AUTH=1` on a remote deployment. That switch exists
for isolated automated smokes only. Expose port `47331` through HTTPS (for
example Caddy, nginx, Tailscale, or a private tunnel) rather than publishing an
unencrypted public endpoint. Configure `OPENALICE_TRUSTED_PROXIES` only with
the actual proxy peer addresses; an overly broad trusted-proxy range weakens
the localhost/auth boundary.

## Health and Lifecycle

The image healthcheck calls the public `/api/version` route from container
loopback. `docker compose ps` should report `healthy` after Alice is ready.
`stop_grace_period: 30s` gives Guardian time to stop PTYs and UTA before Docker
forces termination. Compose also rotates stdout/stderr logs (`10m`, three
files) so an always-on host does not grow an unbounded Docker json log.

Useful operations:

```bash
docker compose logs --tail=200 -f openalice
docker compose restart openalice
docker compose down
docker compose up -d --build
```

`docker compose down` preserves the named volume. `docker compose down -v` is
a factory reset and permanently removes user data.

## Backup and Restore

Stop the container before taking a filesystem-consistent volume snapshot:

```bash
docker compose stop openalice
docker run --rm \
  -v openalice_openalice-data:/data:ro \
  -v "$PWD":/backup \
  alpine tar -czf /backup/openalice-data.tgz -C /data .
docker compose start openalice
```

Compose derives the volume prefix from the project directory; confirm the real
name with `docker volume ls` before backup. Restore into an empty volume while
OpenAlice is stopped. Treat the archive as sensitive: it can contain sealed
broker credentials, the local sealing key, agent logins, reports, and private
Workspace history.

## Runtime Acceptance

`pnpm docker:smoke` is the local definition of a usable server image. It:

1. builds an isolated, uniquely tagged image;
2. starts it in lite mode with a temporary Docker volume and random host port;
3. waits for Alice HTTP readiness;
4. creates a real Chat Workspace with the shell adapter;
5. opens the real Workspace PTY WebSocket;
6. runs `alice` inside that PTY and requires a live CLI manifest response;
7. offboards the Workspace and removes its container, volume, and owned image.

The smoke uses no AI credential and no broker. It deliberately checks an
observable CLI round trip rather than only asserting that files exist. Docker
build cache is shared infrastructure and is retained; only resources owned by
the smoke are deleted. Use `--keep` or `--keep-image` for investigation.

CI builds with BuildKit's GitHub cache, reuses that caller-owned image with
`--skip-build --image openalice:ci`, and uploads redacted container diagnostics
on failure. The Docker workflow runs for deployment/runtime surfaces on PRs to
`dev` or `master`, and again for matching direct changes on `master`.
