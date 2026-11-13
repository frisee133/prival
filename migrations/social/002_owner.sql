ALTER TABLE profiles ADD COLUMN role text NOT NULL DEFAULT 'member' CHECK(role IN ('member','owner'));
CREATE UNIQUE INDEX single_device_owner ON profiles(role) WHERE role='owner';
