CREATE TABLE host_observations (
  mac_address TEXT PRIMARY KEY NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  boot_count INTEGER NOT NULL CHECK (boot_count >= 0),
  last_outcome TEXT NOT NULL,
  last_profile TEXT
);

CREATE INDEX host_observations_last_seen_idx
  ON host_observations (last_seen DESC);
