CREATE TABLE profiles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nick varchar(32) NOT NULL, code varchar(16) NOT NULL UNIQUE,
 public_key text NOT NULL UNIQUE, dnd boolean NOT NULL DEFAULT false, last_seen timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE device_sessions (
 digest text PRIMARY KEY, profile uuid NOT NULL REFERENCES profiles ON DELETE CASCADE, expires_at timestamptz NOT NULL
);
CREATE TABLE challenges (
 nonce text PRIMARY KEY, public_key text NOT NULL, purpose text NOT NULL, nick text, expires_at timestamptz NOT NULL
);
CREATE TABLE friendships (
 sender uuid NOT NULL REFERENCES profiles ON DELETE CASCADE, recipient uuid NOT NULL REFERENCES profiles ON DELETE CASCADE,
 accepted boolean NOT NULL DEFAULT false, CHECK(sender<>recipient), PRIMARY KEY(sender,recipient)
);
CREATE UNIQUE INDEX friend_pair ON friendships(least(sender,recipient),greatest(sender,recipient));
CREATE TABLE blocks (
 actor uuid NOT NULL REFERENCES profiles ON DELETE CASCADE, target uuid NOT NULL REFERENCES profiles ON DELETE CASCADE,
 PRIMARY KEY(actor,target), CHECK(actor<>target)
);
-- Only current calls. No ended_at, call history or recordings.
CREATE UNLOGGED TABLE calls (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE UNLOGGED TABLE call_members (
 call_id uuid NOT NULL REFERENCES calls ON DELETE CASCADE, profile uuid NOT NULL REFERENCES profiles ON DELETE CASCADE,
 inviter uuid REFERENCES profiles ON DELETE SET NULL, joined boolean NOT NULL DEFAULT false,
 touched timestamptz NOT NULL DEFAULT now(), lease uuid, session_digest text,
 PRIMARY KEY(call_id,profile)
);
CREATE UNIQUE INDEX one_active_call ON call_members(profile) WHERE joined;
CREATE INDEX member_profile ON call_members(profile);
