# ADR-0002: SQLite + Drizzle ORM, with Litestream backups

- Status: Proposed
- Date: 2026-10-10

## Context

The data is relational: players, memberships, session drafts, submissions
and sightings. It is tiny (under 10k players and under 100k rows after
years). Metrics are aggregate queries over sightings. The app runs as a single
instance on hobby infrastructure.

## Options considered

| Option                  | Pros                                                   | Cons                                                      |
| ----------------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| PostgreSQL              | Default choice, rich SQL, many hosts                   | A second service to run, back up and pay for              |
| **SQLite (WAL)**        | Zero ops, one file, fast, window functions for metrics | Single writer, single host                                |
| Document DB             | Flexible schema                                        | Data is relational, and metrics need joins and aggregates |
| JSON files (status quo) | Simple                                                 | No history, no metrics, no concurrency safety             |

## Decision

SQLite in WAL mode, accessed through **Drizzle ORM** (typed schema and
drizzle-kit migrations). **Litestream** continuously replicates it to an
S3-compatible bucket.

## Consequences

- (+) Backup and restore is one command, and local dev is identical to prod.
- (+) Drizzle also supports Postgres, so moving to it later is a dialect and migration swap, not a rewrite. Avoid SQLite-only SQL outside `metrics` views.
- (−) It must run on a host with a persistent volume, not on serverless functions. In production that is the Unraid appdata folder mounted at `/data` ([ADR-0006](0006-docker-on-unraid.md)). Litestream is optional there, because *Appdata Backup* already covers the folder.
