-- Certificate-based workload identity (A3.4): revoked client certificates (by SHA-256 thumbprint of the DER, base64url). A revoked certificate is refused even if it is still inside its validity
-- period, its CA is trusted and the workload token bound to it is still valid. Append-only in practice: rows are never updated or deleted by the service. Idempotent.
CREATE TABLE IF NOT EXISTS shield_revoked_certs (
  thumbprint text PRIMARY KEY CHECK (thumbprint ~ '^[A-Za-z0-9_-]{43}$'),
  revoked_at timestamptz NOT NULL DEFAULT now(),
  revoked_by text NOT NULL,
  reason text NOT NULL
);
