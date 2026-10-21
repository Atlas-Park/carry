CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  code VARCHAR(6) NOT NULL UNIQUE,
  name VARCHAR(40) NOT NULL,
  final_deadline TIMESTAMPTZ NOT NULL,
  capacity SMALLINT NOT NULL CHECK (capacity BETWEEN 2 AND 8),
  leader_id TEXT,
  workflow_screen TEXT NOT NULL DEFAULT 'lobby',
  state JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS room_members (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name VARCHAR(20) NOT NULL,
  phone VARCHAR(20),
  kakao VARCHAR(40),
  email VARCHAR(100),
  is_creator BOOLEAN NOT NULL DEFAULT FALSE,
  is_host BOOLEAN NOT NULL DEFAULT FALSE,
  access_token_hash CHAR(64),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS room_members_name_unique
  ON room_members (room_id, LOWER(name));
CREATE INDEX IF NOT EXISTS room_members_room_idx ON room_members(room_id);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  deliverable TEXT NOT NULL DEFAULT '',
  personal_deadline TIMESTAMPTZ NOT NULL,
  position SMALLINT NOT NULL
);

CREATE INDEX IF NOT EXISTS roles_room_idx ON roles(room_id);

CREATE TABLE IF NOT EXISTS assignments (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES room_members(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  preference_rank SMALLINT NOT NULL,
  personal_deadline TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'active', 'done')),
  accepted BOOLEAN NOT NULL DEFAULT FALSE,
  reminded_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (room_id, member_id)
);
