BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS installations (
  id uuid PRIMARY KEY,
  credential_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS analysis_jobs (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  idempotency_key varchar(128) NOT NULL,
  entry_id varchar(128) NOT NULL,
  entry_revision integer NOT NULL CHECK (entry_revision > 0),
  status varchar(24) NOT NULL CHECK (status IN ('queued','processing','completed','failed','cancelled','expired','interrupted')),
  feature_set jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  duration_ms integer,
  error_code varchar(64),
  acknowledged_at timestamptz,
  UNIQUE (installation_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS analysis_jobs_installation_created_idx ON analysis_jobs(installation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS analysis_jobs_status_idx ON analysis_jobs(status);

CREATE TABLE IF NOT EXISTS admin_users (
  id uuid PRIMARY KEY,
  username varchar(80) NOT NULL UNIQUE,
  password_hash text NOT NULL,
  session_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE IF NOT EXISTS admin_audit (
  id bigserial PRIMARY KEY,
  admin_id uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  action varchar(80) NOT NULL,
  target_type varchar(80),
  target_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_audit_created_idx ON admin_audit(created_at DESC);

CREATE TABLE IF NOT EXISTS operational_settings (
  key varchar(80) PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS operational_errors (
  id bigserial PRIMARY KEY,
  code varchar(80) NOT NULL,
  component varchar(80) NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
