'use strict';

const { z } = require('zod');

/**
 * In-memory, Map-backed repository. Writes to each collection are serialized
 * through a per-collection promise-chain lock so concurrent syncs/uploads
 * can never interleave a read-modify-write cycle on the same Map.
 */

const BaseRowSchema = z.object({
  id: z.string(),
  contentHash: z.string(),
  source: z.string(),
  sourceId: z.string(),
  ingestedAt: z.string(),
});

const HistoricalRowSchema = BaseRowSchema.extend({
  games: z.string(),
  year: z.string(),
  sport: z.string(),
  // Broader classification (e.g. "Aquatics") alongside the specific sport
  // (e.g. "Swimming") - the real historical export tracks both levels, and
  // journalists query both ("swimming" and "aquatics" should each work).
  sportGroup: z.string(),
  event: z.string(),
  athleteName: z.string(),
  country: z.string(),
  resultMark: z.string(),
  medal: z.enum(['GOLD', 'SILVER', 'BRONZE']).nullable(),
  position: z.string(),
  notes: z.string(),
});

const ContingentRowSchema = BaseRowSchema.extend({
  athleteName: z.string(),
  sport: z.string(),
  event: z.string(),
  eligibility: z.string(),
  personalBest: z.string(),
  historicalNotes: z.string(),
  status: z.string(),
  dateOfBirth: z.string(),
  // Literal 'Yes' / 'No' from the source sheet, or '' when the athlete
  // isn't listed on the Debutant Status tab (kept as the raw stored value
  // rather than a boolean, consistent with how other sometimes-missing
  // fields are represented, and so the literal source value is citable).
  debutantStatus: z.string(),
});

const ScheduleRowSchema = BaseRowSchema.extend({
  date: z.string(),
  time: z.string(),
  sport: z.string(),
  event: z.string(),
  round: z.string(),
  heatNumber: z.string(),
  athleteName: z.string(),
  country: z.string(),
  // Head-to-head events only (e.g. Bowls, combat sports) - blank for
  // individual-performance events with no direct opponent (e.g. Swimming).
  opponentAthleteName: z.string(),
  opponentCountry: z.string(),
  resultMark: z.string(),
  medal: z.enum(['GOLD', 'SILVER', 'BRONZE']).nullable(),
  recordType: z.enum(['PB', 'GR', 'WR', 'NR', 'SB']).nullable(),
  status: z.string(),
});

const HighlightRowSchema = BaseRowSchema.extend({
  sport: z.string(),
  fileName: z.string(),
  content: z.string(),
  updatedAt: z.string(),
});

/**
 * Pre-Games PB/NR reference baselines (not achievements) - what an athlete's
 * personal best already was, and what the standing national record is for
 * that event, BEFORE Glasgow 2026 results come in. Games Records (GR) are
 * deliberately NOT part of this: a GR can only be set/broken live during
 * the Games, so there's nothing to pre-populate here - GR achievements are
 * tracked via the schedule collection's own recordType field instead.
 */
const PbNrReferenceRowSchema = BaseRowSchema.extend({
  athleteName: z.string(),
  sport: z.string(),
  sportGroup: z.string(),
  eventGender: z.string(),
  event: z.string(),
  personalBest: z.string(),
  personalBestObtainedAt: z.string(),
  remarks: z.string(),
  nationalRecord: z.string(),
  asOfDate: z.string(),
});

const SCHEMAS = {
  historical: HistoricalRowSchema,
  contingent: ContingentRowSchema,
  schedule: ScheduleRowSchema,
  highlights: HighlightRowSchema,
  pbNrReference: PbNrReferenceRowSchema,
};

/** Minimal FIFO async lock so writes to one collection never race. */
class AsyncLock {
  constructor() {
    this.queue = Promise.resolve();
  }

  run(fn) {
    const result = this.queue.then(() => fn());
    this.queue = result.then(
      () => {},
      () => {}
    );
    return result;
  }
}

class DataStore {
  constructor() {
    this.collections = {
      historical: new Map(),
      contingent: new Map(),
      schedule: new Map(),
      highlights: new Map(),
      pbNrReference: new Map(),
    };
    this.locks = {
      historical: new AsyncLock(),
      contingent: new AsyncLock(),
      schedule: new AsyncLock(),
      highlights: new AsyncLock(),
      pbNrReference: new AsyncLock(),
    };
    this.lastSync = {};
  }

  _assertCollection(name) {
    if (!this.collections[name]) {
      throw new Error(`Unknown collection: ${name}`);
    }
  }

  /**
   * Insert new rows, update rows whose contentHash changed (delta sync),
   * and silently skip unchanged rows (dedup). Invalid rows are rejected
   * by the Zod schema and counted, never thrown.
   */
  async upsertMany(collectionName, rows) {
    this._assertCollection(collectionName);
    const schema = SCHEMAS[collectionName];

    return this.locks[collectionName].run(() => {
      const map = this.collections[collectionName];
      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      let invalid = 0;

      for (const row of rows) {
        const parsed = schema.safeParse(row);
        if (!parsed.success) {
          invalid += 1;
          continue;
        }
        const existing = map.get(parsed.data.id);
        if (!existing) {
          map.set(parsed.data.id, parsed.data);
          inserted += 1;
        } else if (existing.contentHash !== parsed.data.contentHash) {
          map.set(parsed.data.id, parsed.data);
          updated += 1;
        } else {
          skipped += 1;
        }
      }

      this.lastSync[collectionName] = new Date().toISOString();
      return { inserted, updated, skipped, invalid, total: map.size };
    });
  }

  getAll(collectionName, filterFn) {
    this._assertCollection(collectionName);
    const rows = Array.from(this.collections[collectionName].values());
    return typeof filterFn === 'function' ? rows.filter(filterFn) : rows;
  }

  getById(collectionName, id) {
    this._assertCollection(collectionName);
    return this.collections[collectionName].get(id) || null;
  }

  clear(collectionName) {
    this._assertCollection(collectionName);
    this.collections[collectionName].clear();
  }

  stats() {
    const out = {};
    for (const key of Object.keys(this.collections)) {
      out[key] = { count: this.collections[key].size, lastSync: this.lastSync[key] || null };
    }
    return out;
  }
}

const dataStore = new DataStore();

module.exports = { dataStore, DataStore, SCHEMAS };
