# Knowledge Atlas local server

From the workspace root:

```sh
cargo run -p atlas-server -- --db ./data/atlas.sqlite --port 38473 --token-file ./data/atlas.token --allow-origin http://localhost:5173
```

The first launch creates the SQLite database and seeds the PID learning example. Existing databases are never automatically reseeded, including after deleting every map. The token file is generated from OS randomness if absent; Unix permissions are 0600. Existing token files must be private regular files. Standard output contains the actual URL and token-file path, never the token. If the requested port is occupied, an available loopback port is selected.

Use an MCP client supporting native Streamable HTTP, pointed at `http://127.0.0.1:PORT/mcp`, with an `Authorization: Bearer TOKEN` header. Read TOKEN locally from the private token file. The six tools are `list_maps`, `create_map`, `get_map`, `get_node`, `apply_graph_patch`, and `export_outline`. Patch schemas describe every operation; optimistic version conflicts are returned as MCP tool errors and never partially commit.

HTTP clients use authenticated `POST /api` with `{ "method": "list_maps", "params": {} }`. The dispatch additionally supports undo, redo, deleted-map restoration, import, recommendations, and map deletion. Authenticated `GET /events` streams committed changes as SSE `change` events; a `resync` event requests a fresh map read after a slow consumer misses updates. `/api` method `connection_info` returns local connection configuration, including the token, and must be treated as sensitive. `GET /healthz` has no token or database content.

The listener binds only to 127.0.0.1. Requests require a loopback Host header. Native requests may omit Origin; browser Origins must exactly match standard Tauri origins or explicitly configured loopback HTTP(S) origins. `null` and foreign origins are rejected. All `/api`, `/events`, and `/mcp` requests require the bearer token. CORS preflight is allowed only for approved origins; requests remain authenticated. Bodies are limited to 2 MiB. No tokens are logged. Connection `last_seen` tracks actual MCP transport requests, not the GUI's API/event traffic.

Run the real protocol integration test:

```sh
cargo test -p atlas-server --test protocol
```

It uses the official pinned rmcp 3.9.0 client against the real local HTTP listener and verifies initialization, tool discovery/calls, atomic invalid patches, optimistic conflicts, undo/redo, deletion/restoration, live SSE, missing credentials, forbidden Origins/Hosts, and the body limit.
