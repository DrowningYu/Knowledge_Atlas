BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS maps (
    id TEXT PRIMARY KEY,
    graph TEXT NOT NULL,
    cursor INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS history (
    map_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    graph TEXT NOT NULL,
    PRIMARY KEY (map_id, position)
);

CREATE TABLE IF NOT EXISTS deleted (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    graph TEXT NOT NULL,
    cursor INTEGER NOT NULL
);

PRAGMA user_version = 1;
COMMIT;
