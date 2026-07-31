# TeamSG Media Desk - Glasgow 2026

A media-focused, strictly data-grounded chatbot for tracking Team Singapore (TeamSG) at the Glasgow 2026 Commonwealth Games.

## Architecture

```
Excel Parser (.xlsx) + Google Sheets Connectors
        -> Multi-Source Ingestion Sync Layer (dedup + SHA-256 hash IDs)
        -> In-Memory Normalized Datastore Repository
        -> Filtered REST Data APIs
        -> Tool-Calling / Prompt-Grounded Orchestrator Engine (OpenAI or Gemini)
        -> Single-Page Chatbot UI
```

| Layer | File |
|---|---|
| Env validation | `config/environment.js` |
| Adapter contract | `src/ingestion/baseAdapter.js` |
| Google Sheets (Sources 2, 3 & 4) | `src/ingestion/googleSheets.js` |
| Excel (Source 1) | `src/ingestion/localFileAdapter.js` |
| Mock framework (all 4 sources) | `src/ingestion/mockAdapter.js` |
| Repository | `src/repository/dataStore.js` |
| Sync/query orchestration | `src/services/queryService.js` |
| AI orchestration (provider-agnostic loop) | `src/services/aiEngine.js` |
| LLM provider contract | `src/services/llmProviders/baseProvider.js` |
| OpenAI backend | `src/services/llmProviders/openaiProvider.js` |
| Gemini backend | `src/services/llmProviders/geminiProvider.js` |
| REST API | `src/server/routes.js` |
| Entry point | `src/app.js` |
| UI | `public/index.html` |

Every mock adapter in `mockAdapter.js` **extends** its real counterpart and only overrides `fetchRaw()`. Swapping mock for real (or a real adapter for a future scraper) never requires touching the repository, REST API, or AI prompts - they only ever see the `BaseAdapter.fetchNormalized()` contract.

The same pattern applies to the AI backend: `aiEngine.js` never talks to OpenAI or Gemini directly. It drives a neutral tool-calling loop against whatever `BaseLLMProvider` `resolveProvider()` picks, so adding a third backend later is one new file in `src/services/llmProviders/`, not a rewrite of the grounding rules or the tool-calling loop.

### Choosing an AI provider

`AI_PROVIDER` in `.env` controls this:

- `auto` (default) - uses OpenAI if `OPENAI_API_KEY` is set, otherwise Gemini if `GEMINI_API_KEY` is set, otherwise chat is disabled (REST data endpoints still work).
- `openai` - force OpenAI; chat is disabled if `OPENAI_API_KEY` is missing.
- `gemini` - force Gemini; chat is disabled if `GEMINI_API_KEY` is missing.

`GET /api/health` reports which provider (if any) is actually active, and the chatbot UI's status pill shows it live.

Gemini support uses Google's current `@google/genai` SDK (not the older, deprecated `@google/generative-ai`), which requires **Node.js 20+** - hence the `engines` bump in `package.json`.

## 1. Installation

```bash
# 1. Install dependencies
npm install

# 2. Create your local environment file
cp .env.example .env

# 3. (Optional but recommended) generate local fixture files for Source 1 & 4
npm run seed
```

By default `MOCK_MODE=true` in `.env.example`, so the app runs fully end-to-end with **zero external credentials** - all 4 sources are served by `src/ingestion/mockAdapter.js`.

To use the AI chat, set `OPENAI_API_KEY` and/or `GEMINI_API_KEY` in `.env` (see [Choosing an AI provider](#choosing-an-ai-provider) above). Without either, the server still boots and every REST data endpoint works; `/api/chat` will return a clear "not configured" message instead of crashing.

## 2. Running

```bash
npm start        # production
npm run dev       # nodemon, auto-restart on change
```

The server cold-boot-syncs all 4 sources on startup, then re-syncs every `SYNC_INTERVAL_MS` (default 5 minutes). Open http://localhost:3000.

## 3. Going live (real data sources)

1. Set `MOCK_MODE=false` in `.env`.
2. **Source 1 (past results)**: run `npm run seed` to write a starter `data/historical/past_results.xlsx`, or POST a real spreadsheet to `/api/upload-excel` (see curl example below).
3. **Source 2 & 3 (Google Sheets)**: create a Google Cloud service account, share both sheets with its `client_email` as Viewer, then fill in `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_SHEET_ID_CONTINGENT`, `GOOGLE_SHEET_ID_SCHEDULE` in `.env`. Sheet header rows must include at minimum `AthleteName`, `Sport`, `Event` (Contingent) and `AthleteName`, `Sport`, `Event`, `Date` (Schedule).
4. **Source 4 (highlights)**: share the highlights spreadsheet with the same service account and set `GOOGLE_SHEET_ID_HIGHLIGHTS` in `.env`. Every tab is treated as a sport category - column A holds row labels (`Sport`, `HPSM`, `Summaries`, `Highlights`, ...), and every column after it is one sport, with that sport's non-empty cells folded into one narrative per sport. Tabs are discovered dynamically, so adding/renaming/removing a category tab needs no code change.
5. **PB/NR reference (same spreadsheet as Source 3)**: pre-Games Personal Best / National Record baselines, read from the `[CWG] PB, NR, GR` tab (`GOOGLE_PB_NR_RANGE`, default `'[CWG] PB, NR, GR'!B3:Q1000`) in the Schedule spreadsheet - no separate sheet ID needed. This is baseline data (what an athlete's PB already was, and an event's standing NR, going into the Games), distinct from PB/NR/GR actually *achieved* during Glasgow 2026 (still read from Source 3's own schedule columns via `get_records`). There is no Games Record equivalent here, since a GR can only be set/broken live during competition.
6. **Web search fallback**: set `WEB_SEARCH_ENABLED=true` and implement a real provider inside `webSearchTool()` in `src/services/aiEngine.js` (currently a labelled stub).

## 4. Strict data-grounding guarantees

- Every row ingested carries a `source` field (e.g. `past_results.xlsx`, `Google Sheet ("Schedule" tab)`, `swimming.md`) - for Google Sheets sources, the tab name is read from the configured range (`GOOGLE_CONTINGENT_RANGE`/`GOOGLE_SCHEDULE_RANGE`), so it always matches whatever tab that data actually lives in. The AI system prompt requires every factual sentence in a response to end with `(Source: <value>)`.
- If local tools return nothing and `WEB_SEARCH_ENABLED=true`, the AI may call `web_search`, but must prefix that part of the answer with the exact banner:
  `[SOURCE: EXTERNAL WEB ENGINE - UNVERIFIED LOCAL SCHEMA]`
  followed by the URL.
- Tool results are treated as data only in the system prompt (defence against prompt injection via sheet/file content).

## 5. curl workflows

Health / sync status:
```bash
curl http://localhost:3000/api/health
```

Trigger a manual sync of all 4 sources:
```bash
curl -X POST http://localhost:3000/api/sync
```

Upload a historical results spreadsheet (Source 1):
```bash
curl -X POST http://localhost:3000/api/upload-excel \
  -F "file=@./data/historical/past_results.xlsx"
```

Filtered medal summary:
```bash
curl "http://localhost:3000/api/medals?sport=Swimming&medal=GOLD"
```

Records actually achieved during the Games (PB/GR/WR/NR):
```bash
curl "http://localhost:3000/api/records?recordType=NR"
```

Pre-Games PB/NR reference baselines:
```bash
curl "http://localhost:3000/api/pb-nr-reference?athleteName=Gan+Ching+Hwee"
```

Live schedule:
```bash
curl "http://localhost:3000/api/schedule?status=Completed"
```

Contingent roster:
```bash
curl "http://localhost:3000/api/contingent?sport=Badminton"
```

Highlights for one sport:
```bash
curl http://localhost:3000/api/highlights/Swimming
```

Chat (task a/b/c all go through this one endpoint):
```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Summarize every TeamSG medal so far with sources."}'
```

## 6. Notes

- The datastore is in-memory (`Map`-backed) and rebuilt from source on every sync; there is no separate persistence layer to manage.
- Re-syncing is idempotent: unchanged rows are skipped, changed rows (e.g. a schedule result finalizing) are updated in place, both keyed by a deterministic SHA-256 id derived from each row's business key, with a separate content hash used to detect changes (`src/ingestion/baseAdapter.js`).

## 7. Deploying to Google Cloud (Cloud Run)

The app is a single stateless HTTP process, which maps cleanly onto Cloud Run:
it already reads its port from `process.env.PORT` (`config/environment.js`),
and there's a `Dockerfile` / `.dockerignore` in the repo root.

**State caveat first:** the datastore is in-memory only (see Notes above). If
you scale to more than one Cloud Run instance, data pulled from Google Sheets
/ the local Excel/Markdown files stays consistent across instances (each
instance independently syncs from the same source), but anything pushed via
the `/api/upload` endpoint only lands on the instance that handled that
request. If you rely on manual uploads, either pin `--max-instances=1` or
treat uploads as a MOCK_MODE/dev-only convenience.

### One-time setup

```bash
gcloud config set project <YOUR_PROJECT_ID>
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com cloudbuild.googleapis.com

gcloud artifacts repositories create teamsg-media-chatbot \
  --repository-format=docker \
  --location=asia-southeast1
```

Put real secrets in Secret Manager rather than as plain env vars — at
minimum `GEMINI_API_KEY` (or `OPENAI_API_KEY`) and `GOOGLE_PRIVATE_KEY`:

```bash
printf '%s' "$GEMINI_API_KEY" | gcloud secrets create GEMINI_API_KEY --data-file=-
printf '%s' "$GOOGLE_PRIVATE_KEY" | gcloud secrets create GOOGLE_PRIVATE_KEY --data-file=-
```

(On Windows/PowerShell, replace the `printf | gcloud` pipe with
`gcloud secrets create GEMINI_API_KEY --data-file=path\to\key.txt`.)

### Deploy

From the project root, with the real `data/historical/*.xlsx` file present
on disk (it's gitignored but not dockerignored, so `--source .` bakes in
whatever is currently there):

```bash
gcloud run deploy teamsg-media-chatbot \
  --source . \
  --region asia-southeast1 \
  --allow-unauthenticated \
  --set-secrets="GEMINI_API_KEY=GEMINI_API_KEY:latest,GOOGLE_PRIVATE_KEY=GOOGLE_PRIVATE_KEY:latest" \
  --set-env-vars="MOCK_MODE=false,AI_PROVIDER=gemini,GEMINI_MODEL=gemini-flash-lite-latest,GOOGLE_SERVICE_ACCOUNT_EMAIL=<service-account>@<project>.iam.gserviceaccount.com,GOOGLE_SHEET_ID_CONTINGENT=<id>,GOOGLE_SHEET_ID_SCHEDULE=<id>,GOOGLE_SHEET_ID_HIGHLIGHTS=<id>"
```

Adjust `--set-env-vars` for whichever of `config/environment.js`'s optional
fields you need to override (`GOOGLE_CONTINGENT_RANGE`, `GOOGLE_SCHEDULE_RANGE`,
`GOOGLE_DEBUTANT_RANGE`, `WEB_SEARCH_ENABLED`, etc.) — anything not passed
just falls back to its default. `--allow-unauthenticated` makes the chatbot
publicly reachable; drop it (and front the service with IAP or your own
auth) if this needs to stay internal.

`gcloud run deploy --source .` builds via Cloud Build and deploys in one
step, so the `Dockerfile` above is all that's required — no separate `docker
build`/`push` needed for a one-off deploy.

### Optional: CI/CD via Cloud Build

`cloudbuild.yaml` in the repo root builds the image, pushes it to Artifact
Registry, and deploys to Cloud Run — wire it up with a trigger on your
GitHub repo:

```bash
gcloud builds triggers create github \
  --repo-name=<your-repo> \
  --repo-owner=<your-github-username> \
  --branch-pattern="^main$" \
  --build-config=cloudbuild.yaml
```

Because this builds from the GitHub repo (not local disk), the gitignored
`data/historical/*.xlsx` file won't be present in that build context —
Source 1 (historical Excel) will come up empty until you either commit a
sanitized version of that file, mount it from Cloud Storage at startup, or
keep using the manual `--source .` deploy path above for that source.
Source 4 (highlights) is unaffected either way, since it's now a live
Google Sheet fetched over the API rather than a bundled local file.
