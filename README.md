# TeamSG Media Desk - Glasgow 2026

A media-focused, strictly data-grounded chatbot for tracking Team Singapore (TeamSG) at the Glasgow 2026 Commonwealth Games.

## Architecture

```
Excel Parser (.xlsx) + Google Sheets Connectors + FS Document Reader
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
| Google Sheets (Sources 2 & 3) | `src/ingestion/googleSheets.js` |
| Excel + filesystem (Sources 1 & 4) | `src/ingestion/localFileAdapter.js` |
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
4. **Source 4 (highlights)**: drop `<sport>.md` or `<sport>.txt` files into `HIGHLIGHTS_DIR` (default `./data/highlights/`), e.g. `swimming.md`, `athletics.md`.
5. **Web search fallback**: set `WEB_SEARCH_ENABLED=true` and implement a real provider inside `webSearchTool()` in `src/services/aiEngine.js` (currently a labelled stub).

## 4. Strict data-grounding guarantees

- Every row ingested carries a `source` field (e.g. `past_results.xlsx`, `Google Sheet - Competition Schedule and Results`, `swimming.md`). The AI system prompt requires every factual sentence in a response to end with `(Source: <value>)`.
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

Records (PB/GR/WR/NR):
```bash
curl "http://localhost:3000/api/records?recordType=NR"
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
