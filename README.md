# AnyMCP Roblox

AnyMCP connects a read-only Roblox Studio plugin to the MCP server through a
token-protected HTTP bridge. The available tools inspect Studio status, the
bounded game hierarchy, and the current selection. The bridge does not execute
arbitrary Lua or modify game objects.

## Requirements

- Node.js 18 or newer
- Roblox Studio with HTTP requests enabled
- GitHub Codespaces only when Studio is connecting from outside the Codespace

## Local setup

1. In a terminal, install the server dependencies:

	```sh
	cd server
	npm install
	npm start
	```

2. In Roblox Studio, enable HTTP requests if prompted, open the AnyMCP toolbar
	panel, enter `http://127.0.0.1:39271`, and paste the session token printed by
	the server.

The server binds to `127.0.0.1` by default and uses port `39271`. You can
override these with `ANYMCP_HOST`, `ANYMCP_PORT`, and, when needed for a
controlled deployment, `ANYMCP_TOKEN`. Tokens are never stored by the plugin.

## GitHub Codespaces setup

1. In the Codespaces terminal, install dependencies in the server directory:

	```sh
	cd server
	npm install
	```

2. Start the server so the Codespaces forwarded port can reach it:

	```sh
	ANYMCP_HOST=0.0.0.0 npm start
	```

3. Open the **Ports** tab in Codespaces and forward port `39271`.

4. If Roblox Studio is outside Codespaces, the forwarded port may need
	**Public** visibility. Public visibility exposes the bridge to the internet,
	so use it only when necessary and treat the session token as a secret.

5. Copy the forwarded HTTPS URL ending in `.app.github.dev` from the Ports tab.
	Enter that URL in the plugin, without a path, query string, or credentials,
	and paste the session token printed by the server into the token field.

6. Click **Test local server**, then **Connect to bridge**. The plugin keeps the
	token in memory for the current Studio session only.

To stop the bridge, focus the Codespaces terminal running it and press `Ctrl+C`.
You can then remove the forwarded port from the Ports tab.

## Troubleshooting

- **Authentication failed:** copy the complete token printed by the same server
  process. Do not add spaces, quotes, or a token to the URL.
- **Port or forwarding failure:** confirm the server is using port `39271`, it
  was started with `ANYMCP_HOST=0.0.0.0` in Codespaces, and port `39271` is
  forwarded with the required visibility.
- **Connection failure:** use the exact forwarded HTTPS URL ending in
  `.app.github.dev`; do not include `/health`, a trailing query string, or
  credentials. Check that Roblox Studio permits HTTP requests and that the
  server process is still running.

- **TLS or DNS failure:** copy the HTTPS hostname again from the Codespaces
	Ports tab. Do not invent a hostname, use an HTTP Codespaces URL, or add a
	port/path to the forwarded URL.
- **Server-side port conflict:** stop the process already listening on `39271`,
	then restart with `ANYMCP_HOST=0.0.0.0`. The server reports the bind failure
	without disabling MCP stdio transport.
- **HTTP 500:** inspect the authenticated `/diagnostics` response and the
	server terminal. Responses contain sanitized error categories, not stack
	traces or tokens.

## Security and diagnostics

Every bridge route, including `/health`, `/diagnostics`, `/recover`, and repair
proposal submission, requires `X-AnyMCP-Token`. The server uses a
cryptographically random token by default and compares credentials with a
timing-safe comparison. Request bodies are limited to 100 KB, JSON and field
types are validated, request/authentication rate limits are enforced, and
pending Studio requests and command queues are bounded.

The authenticated `GET /diagnostics` endpoint reports the current state,
heartbeat freshness, queue/pending sizes, sanitized error counters, recovery
status, safe-mode status, and whether a repair proposal is waiting for review.
The plugin shows sanitized connection messages for authentication, permission,
missing endpoint, rate-limit, server, timeout, DNS, and TLS failures.

## Self-healing and safe mode

The runtime controller tracks `HEALTHY`, `DEGRADED`, `RECOVERING`, and
`SAFE_MODE` states. Automatic recovery is enabled by default and can be
disabled with `ANYMCP_AUTO_RECOVERY=0`. Its only automatic action is the
allowlisted cleanup of expired queue entries; retries remain bounded and there
is no arbitrary recovery code execution.

After repeated critical server failures, safe mode blocks MCP operations that
depend on Roblox Studio state while retaining authenticated diagnostics. It
does not disable authentication or silently rotate the token. A maintainer can
request the known cleanup action with an authenticated `POST /recover` body:

```json
{"action":"cleanup_expired"}
```

Unknown recovery actions are rejected.

## Guarded code repair

Faults can be turned into bounded, local proposal files with an authenticated
`POST /repair/proposal` request containing `summary` and `patch`. Proposals are
saved under `.anymcp-repairs/` with `pending_approval` status. The server never
applies, executes, merges, downloads, pushes, or deploys these patches, and
rejects common code-execution primitives. Reviewers must inspect the proposal,
run the syntax checks, tests, audit, and security review, then apply it through
the normal source-control process with explicit maintainer approval.

To roll back, stop the server, restore the last known-good committed version,
rerun `npm install`, `npm test`, `node --check src/index.js`, and `npm audit`,
then restart the bridge. Do not commit `.anymcp-repairs/`, tokens, or local
environment files.

All bridge API routes, including `/health`, require the `X-AnyMCP-Token`
header. Do not commit tokens or disable authentication to troubleshoot a
connection.
