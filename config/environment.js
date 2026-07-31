'use strict';

const path = require('path');
const dotenv = require('dotenv');
const { z } = require('zod');

dotenv.config();

const boolFromString = (defaultValue) =>
  z
    .enum(['true', 'false'])
    .default(defaultValue)
    .transform((v) => v === 'true');

// dotenv turns `KEY=` into an empty string, not undefined, so a plain
// .optional() string schema rejects unset-but-present keys. Treat '' as
// "not provided" for every optional secret/id field below.
const optionalNonEmptyString = () =>
  z
    .string()
    .trim()
    .min(1)
    .optional()
    .or(z.literal('').transform(() => undefined));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  MOCK_MODE: boolFromString('true'),
  MOCK_SEED: z.coerce.number().int().default(2026),

  // Which LLM backend powers /api/chat. 'auto' prefers OpenAI, then Gemini,
  // based on whichever API key is actually configured below.
  AI_PROVIDER: z.enum(['auto', 'openai', 'gemini']).default('auto'),

  OPENAI_API_KEY: optionalNonEmptyString(),
  OPENAI_MODEL: z.string().trim().min(1).default('gpt-4o-mini'),

  GEMINI_API_KEY: optionalNonEmptyString(),
  GEMINI_MODEL: z.string().trim().min(1).default('gemini-flash-lite-latest'),

  WEB_SEARCH_ENABLED: boolFromString('false'),

  GOOGLE_SERVICE_ACCOUNT_EMAIL: z
    .string()
    .trim()
    .email()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  GOOGLE_PRIVATE_KEY: optionalNonEmptyString(),
  GOOGLE_SHEET_ID_CONTINGENT: optionalNonEmptyString(),
  GOOGLE_SHEET_ID_SCHEDULE: optionalNonEmptyString(),
  // Separate spreadsheet (sport-officer-authored highlights/summaries),
  // not a tab within the Contingent/Schedule spreadsheet.
  GOOGLE_SHEET_ID_HIGHLIGHTS: optionalNonEmptyString(),
  GOOGLE_CONTINGENT_RANGE: z.string().trim().min(1).default('Contingent!A1:Z1000'),
  GOOGLE_SCHEDULE_RANGE: z.string().trim().min(1).default('Schedule!A1:Z1000'),
  // Supplementary tab in the same spreadsheet marking each athlete's
  // Commonwealth Games debutant status (Yes/No). Optional - if this tab
  // doesn't exist for a given deployment, contingent sync still succeeds
  // and debutantStatus is just left blank per athlete.
  GOOGLE_DEBUTANT_RANGE: z.string().trim().min(1).default('Debutant Status!A2:I200'),
  // Same spreadsheet as Schedule (GOOGLE_SHEET_ID_SCHEDULE). Real header row
  // is the tab's 3rd row (row 1 is blank, row 2 is a units note), and real
  // columns start at B (A is unused) - so the range starts at B3, making
  // B3 the header fetchSheetRows() keys every row off. PB/NR only - no
  // Games Record column exists in this tab; GR comes from the schedule
  // collection's own recordType field instead (see PbNrReferenceRowSchema).
  GOOGLE_PB_NR_RANGE: z.string().trim().min(1).default("'[CWG] PB, NR, GR'!B3:Q1000"),

  HISTORICAL_EXCEL_PATH: z.string().trim().min(1).default('./data/historical/past_results.xlsx'),
  HIGHLIGHTS_DIR: z.string().trim().min(1).default('./data/highlights'),
  UPLOAD_DIR: z.string().trim().min(1).default('./data/uploads'),

  SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(300000),
  MAX_UPLOAD_SIZE_MB: z.coerce.number().int().positive().default(10),
});

const fullSchema = envSchema.superRefine((val, ctx) => {
  if (!val.MOCK_MODE) {
    const requiredWhenLive = [
      'GOOGLE_SERVICE_ACCOUNT_EMAIL',
      'GOOGLE_PRIVATE_KEY',
      'GOOGLE_SHEET_ID_CONTINGENT',
      'GOOGLE_SHEET_ID_SCHEDULE',
      'GOOGLE_SHEET_ID_HIGHLIGHTS',
    ];
    for (const key of requiredWhenLive) {
      if (!val[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when MOCK_MODE=false`,
        });
      }
    }
  }
});

let parsed;
try {
  parsed = fullSchema.parse(process.env);
} catch (err) {
  console.error('Invalid environment configuration:');
  if (err instanceof z.ZodError) {
    for (const issue of err.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
  } else {
    console.error(err);
  }
  process.exit(1);
}

const config = Object.freeze({
  ...parsed,
  paths: Object.freeze({
    historicalExcel: path.resolve(process.cwd(), parsed.HISTORICAL_EXCEL_PATH),
    highlightsDir: path.resolve(process.cwd(), parsed.HIGHLIGHTS_DIR),
    uploadDir: path.resolve(process.cwd(), parsed.UPLOAD_DIR),
  }),
});

module.exports = { config };
