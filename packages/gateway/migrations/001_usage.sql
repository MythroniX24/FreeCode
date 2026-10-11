-- FreeCode gateway — usage ledger.
--
-- Apply once, before starting the gateway:
--
--   psql "$GATEWAY_DATABASE_URL" -f migrations/001_usage.sql
--
-- Idempotent, so it is safe to re-run from a deploy script.
--
-- Why a surrogate `bigserial` key rather than `(principal_id, at)`:
-- two requests from the same account can complete within the same millisecond,
-- so the natural key is not unique and would drop legitimate rows. The surrogate
-- key makes every served request a distinct row, which is what an audit needs.
--
-- Why `bigint` for the token counts: at any real scale a daily total exceeds the
-- 32-bit range, and an overflow would wrap negative — turning a quota breach into
-- negative usage. `bigint` removes the failure mode entirely.
--
-- Why the compound index is `(principal_id, at DESC)`: every read is a windowed
-- summary for one principal ("requests since midnight", "tokens since the top of
-- the minute"), and this index answers all of them with one scan.

CREATE TABLE IF NOT EXISTS usage_records (
  id            bigserial PRIMARY KEY,
  at            timestamptz  NOT NULL DEFAULT now(),
  principal_id  text         NOT NULL,
  model         text         NOT NULL,
  provider_id   text         NOT NULL,
  input_tokens  bigint       NOT NULL DEFAULT 0 CHECK (input_tokens  >= 0),
  output_tokens bigint       NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_usd      numeric(12, 6) NOT NULL DEFAULT 0 CHECK (cost_usd   >= 0),
  latency_ms    integer      NOT NULL DEFAULT 0 CHECK (latency_ms   >= 0),
  status        integer      NOT NULL DEFAULT 200
);

CREATE INDEX IF NOT EXISTS usage_records_principal_at_idx
  ON usage_records (principal_id, at DESC);

-- The gateway-wide spend ceiling sums across every principal.
CREATE INDEX IF NOT EXISTS usage_records_at_idx
  ON usage_records (at DESC);
