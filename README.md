# AnyMCP Roblox

AnyMCP connects a read-only Roblox Studio plugin to the MCP server through a
token-protected HTTP bridge. The available tools inspect Studio status, the
bounded game hierarchy, and the current selection. The bridge does not execute
arbitrary Lua or modify game objects.

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

All bridge API routes, including `/health`, require the `X-AnyMCP-Token`
header. Do not commit tokens or disable authentication to troubleshoot a
connection.
