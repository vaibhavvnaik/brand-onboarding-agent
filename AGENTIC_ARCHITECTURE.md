# Brand Onboarding Agent â Agentic Architecture

## Author: Vaibhav Naik
## Project: [urklist.com](https://urklist.com) â Automated Brand Discovery & Newsletter Onboarding Platform

---

## Executive Summary

This document describes an autonomous brand onboarding agent built for urklist.com that discovers brands, automates newsletter signups via browser automation, processes confirmation emails, and ingests newsletter content â all orchestrated by an agentic runtime implementing modern AI agent patterns: **computer use, persistent memory, sub-agent orchestration, human-in-the-loop controls, self-healing, and observability**.

### Related Repositories
- **Original Pipeline**: [brand-onboarding-agent](https://github.com/vaibhavvnaik/brand-onboarding-agent)
- **Agentic Version**: [brand-onboarding-agent-agentic](https://github.com/vaibhavvnaik/brand-onboarding-agent-agentic)
- **urklist.com Platform**: [urk](https://github.com/vaibhavvnaik/urk)

---

## What the Agent Does

The agent runs a non-blocking, event-driven pipeline with four core stages:

1. **discover_and_signup** â Generates candidate brands using LLM with a persistent 1000+ candidate pool in MongoDB. Submits newsletter signup forms via Playwright browser automation. Records brand status progression.

2. **scan_inbox** â Polls Gmail API, classifies emails (confirmation/welcome/newsletter/transactional), resolves brand identity using domain network matching with confidence scoring.

3. **process_confirmations** â Extracts and clicks confirmation links using Playwright browser automation. Updates brand status to confirmed â active.

4. **ingest_newsletters** â Captures newsletter content (HTML, text, screenshots), uploads to Backblaze B2, creates Listing records for the urklist catalog.

---

## Agentic Patterns Implemented

### 1. Computer Use (Browser Automation)

**Implementation**: Full Playwright-based headless browser automation in `services/newsletterSignup.js`.

**Capabilities**:
- Multi-strategy form detection with 40+ CSS selector patterns
- ESP-specific handling: Mailchimp, Klaviyo, Substack, Shopify, custom forms
- CAPTCHA detection and Cloudflare challenge handling
- Screenshot capture on failure for manual review
- Confirmation link clicking via browser automation
- Runtime preflight checks ensure Chromium/dependencies are ready
- Container-based deployment (Dockerfile) pre-installs all browser dependencies

**Code Path**: `boot.js` â `runtimePreflight.js` â `newsletterSignup.js` â Playwright session

### 2. Persistent Memory

**Implementation**: `services/agentMemory.js` with MongoDB persistence via Config model.

**Semantic Memory** (cross-run learning):
- Tool reliability statistics (success/failure counts per tool)
- Failure pattern classification (captcha, timeout, selector breakage, etc.)
- Aggregate run statistics

**Episodic Memory** (run history):
- Last 300 step records (tool, status, attempts, summary)
- Last 300 incident-learning entries
- Windowed history for pattern detection

**Per-Run Memory**:
- Short-term: decisions (LLM vs heuristic), tool outputs, checkpoints
- Long-term reference: passed to LLM planner for reliability-informed decisions

**How it works**: Memory is loaded at cycle start, updated after each tool execution, and persisted back to MongoDB. The LLM planner receives memory context to avoid unreliable tools and prioritize successful paths.

### 3. Sub-Agent Orchestration

**Implementation**: `services/agentTools.js` (tool registry) + `services/agenticRuntime.js` (orchestration).

**7 Specialized Tool-Agents**:

| Tool | Risk Level | Function |
|------|-----------|----------|
| discover_and_signup | High | Brand discovery + form filling |
| scan_inbox | Medium | Email classification + brand resolution |
| process_confirmations | Medium | Confirmation link clicking |
| ingest_newsletters | Low | Content capture + screenshot |
| recover_failed_signups | Medium | Retry logic + MCP delegation |
| retry_missing_screenshots | Low | Screenshot quality retry |
| diagnose_and_heal | Low | Self-diagnostics + auto-healing |

**Orchestration Logic**:
- LLM planner decides next tool based on queue state + memory reliability stats
- Heuristic fallback planner if LLM unavailable (drains queues before new signups)
- MCP (Model Context Protocol) integration for external tool extensibility

**Reference**: A LangGraph-based alternative implementation exists in `langgraph-demo/src/graph.ts` showing state machine orchestration.

### 4. Planning (LLM + Heuristic)

**LLM Planner** (`agenticRuntime.js` â `llmPlannerDecision()`):
- Receives current queue state (pending confirmations, unresolved emails, ingestion backlog, recovery queue)
- Receives memory context (tool reliability, failure patterns)
- Returns structured JSON with next tool selection and reasoning

**Heuristic Fallback** (`fallbackPlannerDecision()`):
- Priority: drain queues â process confirmations â ingest â recover â discover new
- Avoids duplicate tool execution within a run
- Respects max steps and failure budget

### 5. Human-in-the-Loop (HITL)

**Implementation**: Configurable approval gates in `agenticRuntime.js`.

- `requireApprovalFor` array specifies which tools need human approval
- Run pauses with `status=stopped`, emits `approval_required` SSE event
- Resume via `POST /api/agent/approve-agentic-run` + `POST /api/agent/resume-agentic-cycle`
- Approval metadata (who approved, when) recorded in AgentRun document

### 6. Self-Healing & Incident Learning

**Implementation**: `services/agentDiagnostics.js`

**6 Failure Categories**:
1. captcha_or_bot_challenge
2. runtime_dependency_missing
3. selector_breakage
4. timeout_or_network_instability
5. rate_limit_or_throttle
6. llm_parse_or_response_error

**Auto-Healing Actions**:
- Cooldown periods for transient failures
- Tool fallback (heuristic planner for LLM parse errors)
- Recovery tool routing (recover_failed_signups for selector/captcha issues)
- Failure patterns persisted in semantic memory for future avoidance

### 7. Observability & Streaming

**Implementation**: `services/agentObservability.js` + `services/agentEvals.js`

- **SSE Streaming**: `GET /api/agentic/events/:runId` â live step updates
- **Queue Monitoring**: pending confirmations, ingestion backlog, unresolved emails, signup recovery
- **Run Quality Scoring** (0-100):
  - Reliability (40% weight): tool success rate
  - Backlog Impact (25%): queue reduction
  - Recovery Effectiveness (20%): resolved/attempted recovery
  - Controllability (15%): approval + failure penalties
- **Overview Dashboard**: `GET /api/agentic/observability/overview?hours=24`

### 8. Controllability & Policy

- Per-run configuration: `allowedTools`, `blockedTools`, `maxPlannerSteps` (default 8), `maxToolFailures` (default 3)
- `stopOnFirstFailure` option
- Tool-level retry policies (e.g., discover_and_signup: 1 retry, scan_inbox: 2 retries)
- Risk rating per tool (high/medium/low)

### 9. Failure Recovery Loop

- Failed signups auto-enqueue as `SignupRecoveryTask` in MongoDB
- Recovery worker processes queue with configurable retry limits
- Optional MCP handoff for external browser automation
- Tracks recovery attempts and outcomes

---

## Architecture Diagram

```
âââââââââââââââââââââââââââââââââââââââââââââââââââ
â              AGENTIC CONTROL LAYER              â
â                                                  â
â  ââââââââââââ  ââââââââââââ  ââââââââââââââââ  â
â  â Planner  âââ Policy   âââ HITL Gates   â  â
â  â LLM +    â  â Control  â  â Approve/     â  â
â  â Heuristicâ  â          â  â Pause/Resume â  â
â  ââââââââââââ  ââââââââââââ  ââââââââââââââââ  â
â        â              â              â           â
â  ââââââââââââ  ââââââââââââ  ââââââââââââââââ  â
â  â Memory   â  â Observ.  â  â Self-Healing â  â
â  â Semantic â  â SSE +    â  â Diagnostics  â  â
â  â Episodic â  â Evals    â  â + Recovery   â  â
â  ââââââââââââ  ââââââââââââ  ââââââââââââââââ  â
âââââââââââââââââââââââ¬ââââââââââââââââââââââââââââ
                      â
âââââââââââââââââââââââ¼ââââââââââââââââââââââââââââ
â              EXECUTION TOOLS                     â
â                                                  â
â  discover_and_signup  â  scan_inbox              â
â  process_confirmations â  ingest_newsletters     â
â  recover_failed_signupsâ  retry_screenshots      â
â  diagnose_and_heal    â  MCP external tools      â
âââââââââââââââââââââââ¬ââââââââââââââââââââââââââââ
                      â
âââââââââââââââââââââââ¼ââââââââââââââââââââââââââââ
â              INFRASTRUCTURE                      â
â                                                  â
â  Playwright (Browser)  â  Gmail API              â
â  MongoDB               â  Ollama LLM             â
â  Backblaze B2          â  Railway (Deploy)       â
âââââââââââââââââââââââââââââââââââââââââââââââââââ
```

---

## Memory System Deep Dive

### Where Memory Lives in the Codebase

Memory is implemented in `services/agentMemory.js` and persisted to MongoDB via the `config` collection. It operates at three levels:

**1. Semantic Memory (Cross-Run Learning)**
Accumulated knowledge that survives across all agent runs. Stored as aggregated statistics:
- **Tool reliability stats**: For each of the 7 tools, tracks `successes`, `failures`, `totalAttempts`, `lastStatus`, `lastError`. Example: if `discover_and_signup` has a 60% success rate due to CAPTCHAs, the planner deprioritizes it in favor of draining other queues first.
- **Failure pattern classification**: Maps failure types (captcha, timeout, selector breakage) to frequencies. Used by `agentDiagnostics.js` to trigger appropriate healing actions.
- **Aggregate run statistics**: Total runs, average steps per run, overall success rate.

**2. Episodic Memory (Run History)**
A sliding window of recent execution events:
- **Last 300 step records**: Each entry captures `{ tool, status, attempts, summary, timestamp }`. Enables pattern detection like "the last 5 `discover_and_signup` calls all failed with timeout â switch to heuristic planner."
- **Last 300 incident-learning entries**: Captures failure â resolution pairs. Example: `{ incident: "selector_breakage on klaviyo.com", resolution: "fallback to generic form detector", outcome: "success" }`.

**3. Per-Run Memory (Short-Term)**
Exists only for the duration of a single agent run:
- **Decisions log**: Records whether the LLM planner or heuristic fallback made each decision, and why.
- **Tool outputs**: Intermediate results (e.g., list of discovered brands, parsed emails) available to subsequent tools in the same run.
- **Checkpoints**: Saved after each step so a crashed run can be resumed from the last successful step.

### How Memory Flows Through the Pipeline

```
Cycle Start
  â
  ââ Load semantic + episodic memory from MongoDB
  â
  ââ Pass memory context to LLM planner prompt:
  â    "Tool reliability: discover_and_signup 60% success,
  â     scan_inbox 95% success. Last 5 discovery attempts
  â     failed with timeout. Recommendation: prioritize
  â     inbox scanning and confirmation processing."
  â
  ââ Planner selects next tool (memory-informed)
  â
  ââ Tool executes â result captured in per-run memory
  â
  ââ Update semantic memory (increment success/failure counters)
  â
  ââ Update episodic memory (append step record)
  â
  ââ Save checkpoint
  â
  ââ Loop until max steps or all queues drained
```

---

## Visual Workflow Architecture

The pipeline can also be represented as a multi-agent workflow with visual orchestration:

```
Start â Planner â Task Router (Classify, 5 categories)
  ââ discover           â Brand Discovery Agent        â End
  ââ scan_inbox         â Inbox Scanner Agent          â End
  ââ process_confirmations â Confirmation Processor Agent â End
  ââ ingest_newsletters â Newsletter Ingester Agent    â End
  ââ recover_or_diagnose â Recovery & Self-Heal Agent
                              â User Approval (HITL gate)
                                  ââ Approve â Browser Signup Agent â End
                                  ââ Reject  â (unconnected)
```

**Autonomous Discovery Path**: Brand discovery runs on a 10-minute scheduler without human approval. The Planner agent decides the next tool based on queue state, just like the heuristic/LLM planner in `agenticRuntime.js`.

**Human-in-the-Loop for Recovery Only**: The HITL approval gate sits exclusively on the recovery path. When Playwright automation fails for certain brands (CAPTCHAs, non-standard forms, Cloudflare challenges), the operator reviews the list of failed brands, approves the subset worth retrying, and delegates to a Browser Signup agent that uses computer use to manually navigate signup forms.

**Browser Signup Agent (Computer Use)**: This sub-agent receives a list of failed brands (with URLs, failure reasons, retry counts) after user approval. It uses MCP-based browser automation to navigate each brand's signup page, locate the form, fill in the email, handle multi-step flows, and report results.

---

## Connecting the Workflow to the Backend

The visual workflow uses **schema-only function tools** â JSON contracts that define parameters and return types for the LLM to reason about, but contain no execution logic. The actual tool logic lives in the Railway-deployed Node.js backend.

Two approaches bridge this gap:

**Agents SDK Runner (Recommended)**: A runner script loads the workflow, listens for `function_call` events, routes each call to the Railway backend via HTTP, and returns results to the LLM. This integrates with the existing 10-minute scheduler.

**MCP Server**: The Railway backend can be exposed as an MCP server, allowing the workflow to discover and execute tools directly without an intermediary runner.

```
ââââââââââââââââââââââââââââ     ââââââââââââââââââââââââââââ
â    Visual Workflow        â     â   Railway Backend        â
â                          â     â                          â
â  Planner â Task Router   â     â  agenticRuntime.js       â
â    â Agent nodes with    âââââââ  agentTools.js           â
â      function tools      â     â  newsletterSignup.js     â
â    â User Approval gate  â     â  agentMemory.js          â
â    â Browser Signup      â     â  agentDiagnostics.js     â
â                          â     â                          â
â  (LLM decides WHAT to    â     â  (Backend executes HOW   â
â   call and WHEN)         â     â   to do it)              â
ââââââââââââââââââââââââââââ     ââââââââââââââââââââââââââââ
        â                                   â
        â       Agents SDK Runner           â
        â  (routes function_call events     â
        â   to Railway HTTP endpoints)      â
        âââââââââââââââââââââââââââââââââââââ
```

---

## Business Context: urklist.com

urklist.com is a brand newsletter aggregation platform. The agent powers the supply side â automatically discovering brands, subscribing to their newsletters, capturing content, and transforming it into searchable listings.

**Business Value Flow**:
Acquire Brands â Convert to Subscribers â Capture Email Content â Transform to Listings â Improve Reliability

---

## API Surface

### Agentic Endpoints
- `POST /api/agent/run-agentic-cycle` â Start autonomous agent run
- `POST /api/agent/recover-failed-signups` â Process recovery queue
- `POST /api/agent/approve-agentic-run` â Approve paused run
- `POST /api/agent/resume-agentic-cycle` â Resume after approval
- `GET /api/agentic/runs` â List all agent runs
- `GET /api/agentic/runs/:runId` â Get specific run details
- `GET /api/agentic/events/:runId` â SSE live streaming
- `GET /api/agentic/observability/overview` â Dashboard metrics
- `POST /api/agentic/evals/run` â Trigger evaluation
- `GET /api/agentic/evals` â List evaluations
- `POST /api/agentic/diagnose-and-heal` â Manual diagnostics

### Pipeline Endpoints
- `POST /api/agent/process-inbox` â Scan Gmail
- `POST /api/agent/process-confirmations` â Click confirmations
- `POST /api/agent/ingest-newsletters` â Capture content
- `POST /api/agent/run-simplified-cycle` â Run full pipeline

---

## Data Models

| Collection | Purpose |
|---|---|
| brands | Brand metadata, onboarding status, logo URLs |
| emailmessages | Parsed emails with classification, brand resolution |
| discovery_candidates | Persistent 1000+ candidate pool |
| agentruns | Full run history with steps, checkpoints, memory |
| agentevals | Run quality scores |
| signuprecoverytasks | Failed signup recovery queue |
| workflowruns | Step execution traces |
| activitylogs | 30-day TTL operational logs |
| config | Persistent agent memory |

---

## Tech Stack

- **Runtime**: Node.js 18+ with Express
- **Database**: MongoDB with Mongoose
- **Browser Automation**: Playwright with Chromium
- **LLM**: Ollama (local) / Anthropic Claude (optional)
- **Email**: Gmail API with OAuth2
- **Storage**: Backblaze B2 for screenshots
- **Deployment**: Railway with Docker
- **Streaming**: Server-Sent Events (SSE)
- **External Integration**: MCP (Model Context Protocol)

---

## Key Highlights

1. **Real Production System**: Not a demo â this runs in production onboarding real brands for urklist.com
2. **Full Agent Lifecycle**: Planning â Execution â Memory â Recovery â Evaluation
3. **Developer Experience Focus**: Clean REST APIs, SSE streaming, configurable policies, comprehensive observability
4. **Safety & Governance**: HITL approval gates, risk-rated tools, failure budgets, policy controls
5. **Extensibility**: MCP tool registry for external integrations, pluggable LLM planner
6. **Self-Improving**: Persistent memory enables cross-run learning; self-healing reduces manual intervention
7. **Computer Use**: Real browser automation for form filling across 40+ patterns
