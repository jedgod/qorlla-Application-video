-- Rollback of v4.25 (restricted verification-phase telephone peer). Credentials are short-lived and single-use, so dropping the table loses no durable business data.
DROP TABLE IF EXISTS phone_peer_credentials;
