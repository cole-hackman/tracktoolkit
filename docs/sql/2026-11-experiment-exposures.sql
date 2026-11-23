-- Adds the experiment exposure table (Prisma model ExperimentExposure).
--
-- Generated with `prisma migrate diff --from-schema-datamodel <main's schema>
-- --to-schema-datamodel prisma/schema.prisma --script`, then made re-runnable
-- so a second execution is a no-op rather than an error.
--
-- Purely additive: creates one table, two indexes, and one foreign key. It
-- touches no existing table. The `metrics` rows the experiment code writes
-- (`experiment_enrolled:<experiment>:<variant>`) need no schema change: that
-- table already exists (docs/sql/2026-09-account-lifecycle.sql).
--
-- WHERE TO RUN THIS: the **Azure PostgreSQL Flexible Server** database
-- `tracktoolkit` on `tracktoolkit-pg.postgres.database.azure.com`. Not Neon.
--
--   export AZURE_PROD='postgresql://tracktoolkit_admin:<url-encoded pw>@tracktoolkit-pg.postgres.database.azure.com:5432/tracktoolkit?sslmode=require'
--   docker run --rm -v "$PWD/docs/sql:/sql:ro" postgres:17 \
--     psql "$AZURE_PROD" -v ON_ERROR_STOP=1 -f /sql/2026-11-experiment-exposures.sql
--
-- (password: Key Vault `tracktoolkit-kv`, secret `postgres-admin-password`.)
--
-- RUN IT BEFORE THE BRANCH MERGES. `main` deploys to App Service on every
-- push, and server/lib/schema-preflight.js refuses to start a build whose
-- tables are missing: merging first is an outage, not a degraded experiment.

CREATE TABLE IF NOT EXISTS "experiment_exposures" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "experimentKey" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "experiment_exposures_pkey" PRIMARY KEY ("id")
);

-- The readout reads every row of one experiment, grouped by arm.
CREATE INDEX IF NOT EXISTS "experiment_exposures_experimentKey_variant_idx"
    ON "experiment_exposures"("experimentKey", "variant");

-- One exposure per user per experiment. This constraint, not the code that
-- writes the row, is what makes a second insert impossible.
CREATE UNIQUE INDEX IF NOT EXISTS "experiment_exposures_userId_experimentKey_key"
    ON "experiment_exposures"("userId", "experimentKey");

-- Cascade so deleting an account removes its exposure rows, matching every
-- other per-user table (guarded by tests/account-deletion-cascade.test.js).
-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, hence the guard block.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'experiment_exposures_userId_fkey'
    ) THEN
        ALTER TABLE "experiment_exposures"
            ADD CONSTRAINT "experiment_exposures_userId_fkey"
            FOREIGN KEY ("userId") REFERENCES "users"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
