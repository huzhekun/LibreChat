# LibreChat Code Interpreter API (self-hosted)

This is a drop-in, self-hosted replacement for LibreChat's hosted code interpreter API.

## Security/isolation model

- **No docker-in-docker**: all code runs as child processes inside this container.
- **Process isolation**: each `/exec` call runs in a separate process group with hard timeout and basic `ulimit` controls.
- **Directory isolation**: each session has an isolated workspace under `DATA_ROOT/sessions/<session_id>/workspace`.
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

## Run with Docker

```bash
docker build -t librechat-code-api -f tools/code-api/Dockerfile .

docker run -d --name librechat-code-api \
  -p 3085:3085 \
  -e CODE_API_KEY=change-me \
  -v librechat-code-data:/var/lib/librechat-code-api \
  librechat-code-api
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
