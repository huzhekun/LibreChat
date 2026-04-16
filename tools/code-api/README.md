# LibreChat Code Interpreter API (self-hosted)

This is a drop-in, self-hosted replacement for LibreChat's hosted code interpreter API.

## Security/isolation model

- **No docker-in-docker**: all code runs as child processes inside this container.
- **Sandbox execution**: `/exec` uses `SANDBOX_BACKEND=landlock` by default, running code as `SANDBOX_UID:SANDBOX_GID` with a Landlock filesystem allowlist, hard timeout, and `ulimit` controls.
- **Optional bubblewrap backend**: `SANDBOX_BACKEND=bwrap` keeps the older PID/IPC/UTS namespace sandbox for hosts that permit nested user/mount namespaces.
- **Directory isolation**: each session has an isolated workspace under `DATA_ROOT/sessions/<session_id>/workspace`, available as `/mnt/data` inside the sandbox.
- **Attribution model**:
  - API key auth via `x-api-key`.
  - User identity sourced from `User-Id` header (or `user_id` body fallback).
  - Session metadata stores owner hash and optional `entity_id`.
- **Agent isolation and sharing**:
  - If `entity_id` is provided, session is pinned to `ent_<entity_id>`, enabling shared files for that agent identity.
  - Cross-session file references are allowed only when ownership hash matches or `entity_id` matches.

## Endpoints

Implemented endpoints:

- `POST /exec`
- `POST /upload`
- `GET /download/:session_id/:fileId`
- `GET /files/:session_id`
- `DELETE /files/:session_id/:fileId`
- `GET /health`

`GET /health` is intentionally unauthenticated so it can be used by container/platform health checks.

## Run with Docker

```bash
docker build -t librechat-code-api -f tools/code-api/Dockerfile .

docker run -d --name librechat-code-api \
  -p 3085:3085 \
  -e CODE_API_KEY=change-me \
  -v librechat-code-data:/var/lib/librechat-code-api \
  librechat-code-api
```

## Landlock backend

`SANDBOX_BACKEND=landlock` is intended for Kubernetes environments where nested
mount namespaces are blocked. It does not need `CAP_SYS_ADMIN` or a container
host socket. Instead, a small native launcher applies a Landlock filesystem
policy, drops to `SANDBOX_UID:SANDBOX_GID`, and runs the command.

Landlock does not remap paths, so the server serializes Landlock executions and
temporarily points `/mnt/data` at the active session workspace while that command
runs. Code can read/write the active session workspace, while reads of app files
and sibling session workspaces are denied by Landlock.

Limitations:

- Landlock is filesystem access control, not a PID or mount namespace.
- `/mnt/data` compatibility is serialized for safety, so concurrent `/exec`
  requests run one at a time with this backend.
- Runtime/toolchain directories such as `/usr/bin`, `/usr/lib`, and
  `/usr/include` are readable so interpreters and compilers can run.
- The node kernel must support Landlock. If it does not, `/exec` fails with
  `code-landlock: Landlock is unavailable on this kernel`.

With Podman on SELinux/AppArmor-confined hosts, `bubblewrap` may be blocked from
creating its nested mount namespace and fail with `bwrap: Failed to make / slave:
Permission denied`. If that happens, start the container with the host security
label disabled for this container:

```bash
podman run -d --name librechat-code-api \
  --security-opt label=disable \
  -p 3085:3085 \
  -e CODE_API_KEY=change-me \
  -v librechat-code-data:/var/lib/librechat-code-api \
  docker.io/zhekunhu/librechat-code-api:0.0.9
```

If the error persists, the host is blocking nested user/mount namespaces for this
container. Confirm with:

```bash
podman exec --user 10001:10001 librechat-code-api \
  bwrap --unshare-user --unshare-pid --ro-bind / / --tmpfs /tmp -- bash -lc 'id'
```

Then configure LibreChat:

- `CODE_API_URL=http://<host>:3085`
- `LIBRECHAT_CODE_BASEURL=http://<host>:3085/v1`
- `LIBRECHAT_CODE_API_KEY=change-me`

## Startup command override for the stock LibreChat container

Preferred (clean) approach: export `LIBRECHAT_CODE_BASEURL` during startup.

```bash
/bin/sh -lc 'export LIBRECHAT_CODE_BASEURL=http://code-api:3085/v1 && npm run backend'
```

If you cannot inject that env var, you can patch the default hosted URL at container start with `sed`:

```bash
/bin/sh -lc "grep -RIl 'https://api.librechat.ai/v1' /app/node_modules/@librechat/agents | xargs -r sed -i 's#https://api.librechat.ai/v1#http://code-api:3085/v1#g' && npm run backend"
```

## Notes

- Runtime support depends on installed compilers/interpreters in the image.
- `memory` and `cpu_time` in response are currently returned as `null`.
- `SANDBOX_NETWORK_MODE=isolated` (default) uses `--unshare-net` to disable sandbox network access.
- `SANDBOX_NETWORK_MODE=shared` keeps host/container networking shared with sandboxed code.

## Network hardening (internal network protection)

`bubblewrap` alone cannot do "internet-only" filtering. If you need outbound internet while blocking internal ranges, use one of these patterns:

1. Opt into `SANDBOX_NETWORK_MODE=shared`, and enforce egress policy at container/host firewall level (drop RFC1918, link-local, ULA, metadata IPs).
2. Route all sandbox traffic through an authenticated egress proxy or gateway that deny-lists internal CIDRs and only allows approved domains/ports.

In short: **use external network controls for internet-only access**; use `SANDBOX_NETWORK_MODE=none` for strongest local isolation.
