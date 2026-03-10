# Brand Onboarding Agent Workflow

## End-to-End Flow

```mermaid
flowchart TD
  A[discover_and_signup] --> B[scan_inbox]
  B --> C[process_confirmations]
  C --> D[ingest_newsletters]

  A --> A1[Discover up to batchSize candidates]
  A1 --> A2[De-dupe by domain]
  A2 --> A3[Onboard all unique in this run]
  A3 --> A4[Categorize + signup attempt]
  A4 --> A5[Brand status: awaiting_confirmation OR failed]

  B --> B1[Read Gmail recent messages]
  B1 --> B2[Upsert EmailMessage by gmailMessageId]
  B2 --> B3[Resolve brand by sender/domain]
  B3 --> B4[Type: confirmation/welcome/newsletter/transactional/other]
  B4 --> B5[Email state: brand_resolved OR brand_unresolved]

  C --> C1[Pick typed confirmation emails]
  C1 --> C2[Extract + click confirmation links]
  C2 --> C3[Brand status active if confirmed]
  C2 --> C4[Retry / fail path]

  D --> D1[Pick welcome + newsletter emails]
  D1 --> D2[Save html/text/metadata]
  D2 --> D3[Generate screenshot]
  D3 --> D4[Email state ingested]
```

## Batch Size Behavior

- Discovery targets `batchSize` candidates.
- After dedupe, the run onboards all unique candidates from that discovered set.
- There is no extra `*2` expansion and no truncation to first N after dedupe.

## Brand Status Definitions

- `discovered`: Candidate identified but no signup started.
- `subscribing`: Signup automation currently in progress.
- `submitted`: Form was submitted (legacy/optional transitional state).
- `awaiting_confirmation`: Waiting for confirmation/welcome/newsletter email.
- `confirmed`: Confirmation click succeeded (transitional; typically moves to active).
- `active`: Brand is considered onboarded and receiving newsletters.
- `failed`: Signup/confirmation failed or timed out.
- `captcha_blocked`: Bot protection blocked automation.
- `stale`: Previously active but no relevant email seen in staleness window.
- `duplicate`: Candidate rejected due duplicate domain/brand match.
- `skipped`: Manually skipped/removed.

## Email Type Definitions

- `confirmation`: Asks user to confirm/verify subscription.
- `welcome`: First onboarding/welcome note.
- `newsletter`: Recurring marketing/editorial campaign email.
- `transactional`: Order/receipt/shipping/account/system messages.
- `other`: Non-newsletter content that does not match known patterns.
- `unknown`: Not yet classified.

## Where Artifacts and Logs Live

- Newsletter screenshots: `artifacts/newsletters/` (local filesystem of running service).
- Runtime logs: console + `logs/agent.log`.
- Persistent activity logs (Mongo): `activitylogs` collection (30-day TTL).
- Parsed emails and ingest states: `emailmessages` collection.
