# Simplified Brand Onboarding Agent Plan

## Goal
Run a non-blocking, reliable pipeline for onboarding brands at scale without long in-request waits.

## Jobs
1. `discover_and_signup`
- Discover candidate brands.
- Attempt newsletter signup.
- Set brand status to `awaiting_confirmation`.
- Do **not** block waiting for inbox events.

2. `scan_inbox`
- Poll Gmail for recent messages.
- Upsert `EmailMessage` by `gmailMessageId` (idempotent).
- Classify `emailType` (`confirmation|welcome|newsletter|transactional|other`).
- Resolve message to brand by sender email/domain.

3. `process_confirmations`
- Process confirmation-type messages asynchronously.
- Attempt confirmation-link click.
- Update brand status and confirmation metadata.

4. `ingest_newsletters`
- Process `welcome/newsletter` messages.
- Render screenshot and persist path.
- Mark message ingested for downstream readers.

## Message Lifecycle
`discovered -> parsed -> brand_resolved -> typed -> confirmation_processed -> ingested -> finalized`

Important:
- Gmail read/unread is not workflow state.
- DB state (`EmailMessage`) is workflow state.
- Multiple workers can process the same message safely using `processedBy.*` fields.

## Brand vs Email Classification
- Brand-level categorization: vertical like `Fashion & Apparel`, `Food & Beverage`.
- Email-level classification: message type like `welcome` or `newsletter`.

Keep these separate in data model and processing logic.
