# Brand Onboarding Agent

Non-blocking newsletter onboarding and ingestion pipeline for brand discovery.

## Simplified Architecture

The agent runs as short jobs and never blocks waiting for inbox events inside signup runs.

1. `discover_and_signup`
- Finds candidate brands and submits newsletter forms.
- Marks records as `awaiting_confirmation` for async handling.

2. `scan_inbox`
- Pulls recent Gmail messages, upserts by `gmailMessageId`.
- Resolves brand identity and classifies email type.

3. `process_confirmations`
- Handles only pending confirmation emails.
- Clicks confirmation links with Playwright and records retry state.

4. `ingest_newsletters`
- Saves newsletter/welcome email content and screenshot artifacts.
- Uploads screenshots to B2 (when configured) and materializes urk `Listing` records.
- Marks ingestion state in MongoDB.

## Message Lifecycle

`discovered -> parsed -> typed -> brand_resolved|brand_unresolved -> confirmation_processed -> ingested -> finalized`

Database state is the source of truth, not Gmail read/unread status.

## Local Setup

### 1) Environment

Set variables in `.env`:

- `MONGODB_URI`
- `URKLIST_USER_ID` (Mongo ObjectId for listing ownership)
- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REFRESH_TOKEN` (or use `/setup/gmail`)
- `GMAIL_USER`
- `API_KEY`
- `B2_KEY_ID` and `B2_APPLICATION_KEY` (optional but recommended for image URLs)

Optional:

- `AGENT_API_KEY`
- `ANTHROPIC_API_KEY` (only for AI categorization fallback)

### 2) Install + checks

```bash
npm install
npm run check
```

### 3) Run jobs manually

```bash
npm run job:discover
npm run job:scan-inbox
npm run job:scan-full
npm run job:confirm
npm run job:ingest
npm run job:backfill
npm run job:migrate
npm run job:cycle
```

Migration orchestration details:
- See [docs/FNL_READER_MIGRATION_RUNBOOK.md](docs/FNL_READER_MIGRATION_RUNBOOK.md)
- `job:migrate` runs full-history scan + confirmation + ingestion + optional backfill in one sequence.

Full-history scan controls (env):
- `SCAN_FULL_MAX_RESULTS` default `0` (0 = no cap)
- `SCAN_FULL_PAGE_SIZE` default `500`
- `SCAN_FULL_QUERY` optional Gmail query override
- `LINK_RESOLUTION_ENABLED` default `false`
- `LINK_RESOLUTION_MAX_LINKS` default `5`
- `LINK_RESOLUTION_TIMEOUT_MS` default `5000`
- `BRAND_MATCH_CONFIDENCE_THRESHOLD` default `9` (below this goes to manual review queue)
- `EXTERNAL_SENDER_PROMOTION_MIN_COUNT` default `3`
- `ALLOW_EXTERNAL_SENDER_DOMAIN_PROMOTION` default `false`
- `EXTERNAL_SENDER_DOMAIN_PROMOTION_MIN_COUNT` default `6`

Backfill controls (env):
- `BACKFILL_LIMIT` default `500`
- `BACKFILL_WITH_SCREENSHOTS` default `false`
- `BACKFILL_FORCE_UPDATE` default `false`

### 4) Run API server

```bash
npm start
```

### 5) Trigger jobs over API

```bash
curl -X POST http://localhost:3000/api/agent/process-inbox \
  -H "x-api-key: $API_KEY" \
  -H "content-type: application/json" \
  -d '{"hours":24,"maxResults":100}'

curl -X POST http://localhost:3000/api/agent/process-confirmations \
  -H "x-api-key: $API_KEY" \
  -H "content-type: application/json" \
  -d '{"limit":20}'

curl -X POST http://localhost:3000/api/agent/ingest-newsletters \
  -H "x-api-key: $API_KEY" \
  -H "content-type: application/json" \
  -d '{"limit":20}'

curl -X POST http://localhost:3000/api/agent/run-simplified-cycle \
  -H "x-api-key: $API_KEY" \
  -H "content-type: application/json" \
  -d '{"batchSize":10,"inboxHours":24,"maxInboxResults":100}'
```

## Artifacts

Screenshots are written to `artifacts/newsletters/`.
