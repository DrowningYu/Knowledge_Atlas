# atlas-core

Local SQLite domain store for Knowledge Atlas. `Store` is cloneable; clones synchronize one SQLite connection and share a Tokio broadcast channel. SQLite migrations are tracked with `PRAGMA user_version` (currently 1), use WAL journaling, and reject databases created by a newer schema.

A map is stored as a complete validated graph snapshot. Each successful patch commits a new snapshot and history cursor atomically. Validation considers the final state of the whole patch, allowing forward references and root replacement in one transaction. Deletion operations validate their IDs and reject missing nodes or edges, rolling back the entire patch. Required and recommended edges together must form a DAG; related links may cycle. Validation uses an iterative topological pass, so deeply nested imports do not consume the call stack.

Undo and redo restore content while incrementing the current graph version. Editing after undo discards that map's redo branch. History and cursors survive application restarts. Deleting a map keeps its graph and history in a persistent deletion stack; `restore_deleted_map` restores the latest deletion and advances its version. Deleted map IDs are reserved until restored to avoid overwriting their history. Imports create version 1 maps and never overwrite existing or deleted IDs.

Changes are broadcast only after a successful transaction commits. Errors roll back all graph and history changes and emit no event. Subscribers should reload the graph, and recover from broadcast lag by refreshing their map list.

Markdown exports include each concept once and use links for shared prerequisites. Mermaid exports preserve stable node IDs as `n_<node.id>` diagram identifiers; JSON exports round trip the graph. Recommendations return unfinished concepts whose required and recommended prerequisites are mastered or skipped.

`seed_demo` creates the idempotent `pid-control` map with 21 concepts, shared prerequisites, detailed Markdown explanations, and related links.

Run `cargo test -p atlas-core` from the workspace root.
