'use strict';

const { dataStore } = require('../repository/dataStore');
const { nameMatches, nameFuzzyMatches } = require('../repository/nameMatcher');
const { config } = require('../../config/environment');
const {
  ContingentSheetAdapter,
  ScheduleSheetAdapter,
  HighlightsSheetAdapter,
  PbNrReferenceSheetAdapter,
} = require('../ingestion/googleSheets');
const { ExcelHistoricalAdapter } = require('../ingestion/localFileAdapter');
const {
  MockContingentAdapter,
  MockScheduleAdapter,
  MockExcelHistoricalAdapter,
  MockHighlightsAdapter,
  MockPbNrReferenceAdapter,
} = require('../ingestion/mockAdapter');

/**
 * Matches a row's sport against a query at whichever taxonomy level the
 * row has. Historical rows carry both a specific sport ("Swimming") and a
 * broader classification ("Aquatics"); other collections only have the
 * single field they were given. Checking both (when present) means a
 * query for either "Swimming" or "Aquatics" finds the same rows.
 */
function sportMatches(row, sport) {
  if (!sport) return true;
  const query = sport.trim().toLowerCase();
  if (row.sport && row.sport.toLowerCase() === query) return true;
  if (row.sportGroup && row.sportGroup.toLowerCase() === query) return true;
  return false;
}

// Fields safe to filter/group by per collection - a fixed allowlist, not
// arbitrary property access, so a caller (ultimately an LLM) can compose
// novel aggregate questions ("most medalled athlete", "sport with the most
// entries in 2022", ...) without ever touching internal fields (id,
// contentHash, sourceId, ...) or executing arbitrary code.
const QUERYABLE_FIELDS = {
  historical: ['athleteName', 'sport', 'sportGroup', 'games', 'year', 'medal', 'event', 'country'],
  schedule: ['athleteName', 'sport', 'event', 'round', 'medal', 'recordType', 'status', 'date', 'opponentAthleteName', 'opponentCountry'],
  contingent: ['athleteName', 'sport', 'event', 'eligibility', 'status', 'debutantStatus'],
};

// Cells that name multiple people for a team result use these as
// separators; a bare country/entity name (not a person) is sometimes used
// in place of a roster for old team results and isn't a real athlete.
const TEAM_ENTITY_PLACEHOLDERS = new Set(['SINGAPORE', 'SGP', 'TEAM SINGAPORE']);

function splitAthleteNames(compound) {
  return String(compound || '')
    .split(/[\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** Parses the contingent sheet's DOB column, e.g. "9-Jul-2007", "09-Jul-2007", "4 Nov 2010" - inconsistent day-padding and separator ('-' or space), always D-MMM-YYYY. */
function parseDob(raw) {
  const parts = String(raw || '').trim().split(/[\s-]+/);
  if (parts.length !== 3) return null;
  const [dayStr, monStr, yearStr] = parts;
  const month = MONTHS[monStr.toLowerCase().slice(0, 3)];
  const day = parseInt(dayStr, 10);
  const year = parseInt(yearStr, 10);
  if (month === undefined || Number.isNaN(day) || Number.isNaN(year)) return null;
  const date = new Date(Date.UTC(year, month, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Parses the schedule sheet's DATE column, e.g. "23/7/2026" (D/M/YYYY). */
function parseScheduleDate(raw) {
  const m = String(raw || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
  return Number.isNaN(date.getTime()) ? null : date;
}

// Singapore Time is a fixed UTC+8 year-round (no DST), so "now in SGT" and
// schedule row timestamps are both represented as a Date object whose UTC
// getters (getUTCHours etc.) read as SGT wall-clock values. Both sides use
// this same convention, so subtracting their .getTime() epoch values still
// yields the correct real elapsed milliseconds between them - only the
// *display* of these values needs the "SGT" label attached, the arithmetic
// itself needs no further timezone conversion.
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

function nowInSgt() {
  return new Date(Date.now() + SGT_OFFSET_MS);
}

/** Parses the schedule sheet's DATE ("23/7/2026") + TIME ("17:55") columns together, both already in SGT. */
function parseScheduleDateTime(dateRaw, timeRaw) {
  const dateOnly = parseScheduleDate(dateRaw);
  if (!dateOnly) return null;
  const timeMatch = String(timeRaw || '').match(/^(\d{1,2}):(\d{2})$/);
  const hour = timeMatch ? Number(timeMatch[1]) : 0;
  const minute = timeMatch ? Number(timeMatch[2]) : 0;
  return new Date(Date.UTC(dateOnly.getUTCFullYear(), dateOnly.getUTCMonth(), dateOnly.getUTCDate(), hour, minute));
}

/**
 * Parses a date given in whatever reasonable format a caller (ultimately
 * an LLM) is likely to produce - ISO ("2026-07-23"), the sheet's own D/M/Y
 * ("23/7/2026"), or a month name ("23 July 2026", "July 23, 2026", "23
 * July"/"July 23" with year assumed to be the current SGT year). Returns
 * null (not a guess) when nothing matches, so callers can surface a clear
 * "couldn't understand that date" error instead of silently matching zero
 * rows the way a failed exact-string filter would.
 */
function parseFlexibleDate(input) {
  const s = String(input || '').trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); // 2026-07-23
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));

  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // 23/7/2026 (matches our own stored format)
  if (m) return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));

  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]+)\.?[\s,-]+(\d{4})$/); // "23 July 2026", "23rd Jul, 2026"
  if (m && MONTHS[m[2].toLowerCase().slice(0, 3)] !== undefined) {
    return new Date(Date.UTC(Number(m[3]), MONTHS[m[2].toLowerCase().slice(0, 3)], Number(m[1])));
  }

  m = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/); // "July 23, 2026", "Jul 23 2026"
  if (m && MONTHS[m[1].toLowerCase().slice(0, 3)] !== undefined) {
    return new Date(Date.UTC(Number(m[3]), MONTHS[m[1].toLowerCase().slice(0, 3)], Number(m[2])));
  }

  const currentYear = nowInSgt().getUTCFullYear();
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]+)$/); // "23 July" - no year, assume current
  if (m && MONTHS[m[2].toLowerCase().slice(0, 3)] !== undefined) {
    return new Date(Date.UTC(currentYear, MONTHS[m[2].toLowerCase().slice(0, 3)], Number(m[1])));
  }
  m = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?$/); // "July 23" - no year, assume current
  if (m && MONTHS[m[1].toLowerCase().slice(0, 3)] !== undefined) {
    return new Date(Date.UTC(currentYear, MONTHS[m[1].toLowerCase().slice(0, 3)], Number(m[2])));
  }

  return null;
}

function formatSgt(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} SGT`;
}

/** Whole years between dob and asOf - standard "age as of a date" calculation. */
function ageInYears(dob, asOf) {
  let age = asOf.getUTCFullYear() - dob.getUTCFullYear();
  const hadBirthdayThisYear =
    asOf.getUTCMonth() > dob.getUTCMonth() || (asOf.getUTCMonth() === dob.getUTCMonth() && asOf.getUTCDate() >= dob.getUTCDate());
  if (!hadBirthdayThisYear) age -= 1;
  return age;
}

/** The group key(s) a row contributes when aggregating by `field`. Splits
 * multi-person team cells so each named athlete gets their own credit
 * instead of the whole team being counted as one "athlete". */
function groupKeysFor(row, field) {
  if (field !== 'athleteName') return [row[field] ?? '(unspecified)'];
  return splitAthleteNames(row.athleteName).filter((n) => !TEAM_ENTITY_PLACEHOLDERS.has(n.toUpperCase()));
}

/**
 * Master orchestration service: owns the 4 ingestion adapters, drives syncs,
 * ingests uploaded Excel buffers, and exposes filtered read methods that the
 * REST API and the AI tool layer both call. This is the only module that
 * decides mock vs. real - everything downstream is adapter-agnostic.
 */
class QueryService {
  constructor() {
    this.adapters = this._buildAdapters();
  }

  _buildAdapters() {
    if (config.MOCK_MODE) {
      return {
        historical: new MockExcelHistoricalAdapter(),
        contingent: new MockContingentAdapter(),
        schedule: new MockScheduleAdapter(),
        highlights: new MockHighlightsAdapter(),
        pbNrReference: new MockPbNrReferenceAdapter(),
      };
    }
    return {
      historical: new ExcelHistoricalAdapter(),
      contingent: new ContingentSheetAdapter(),
      schedule: new ScheduleSheetAdapter(),
      highlights: new HighlightsSheetAdapter(),
      pbNrReference: new PbNrReferenceSheetAdapter(),
    };
  }

  async syncAll() {
    const results = {};
    for (const name of Object.keys(this.adapters)) {
      // eslint-disable-next-line no-await-in-loop
      results[name] = await this._syncOne(name);
    }
    return results;
  }

  async syncSource(name) {
    if (!this.adapters[name]) throw new Error(`Unknown source: ${name}`);
    return this._syncOne(name);
  }

  async _syncOne(name) {
    try {
      const rows = await this.adapters[name].fetchNormalized();
      return await dataStore.upsertMany(name, rows);
    } catch (err) {
      return { error: err.message, inserted: 0, updated: 0, skipped: 0, invalid: 0 };
    }
  }

  /** Ingest a freshly uploaded Source 1 spreadsheet buffer (multer memory storage). */
  async ingestExcelBuffer(buffer, originalFileName) {
    if (!buffer || !buffer.length) throw new Error('Empty file buffer provided');
    const adapter = new ExcelHistoricalAdapter(buffer, config.paths.historicalExcel, originalFileName || 'past_results.xlsx');
    const rows = await adapter.fetchNormalized();
    if (!rows.length) {
      throw new Error(
        'No valid rows parsed from the uploaded spreadsheet. Verify it has an AthleteName column and at least one data row.'
      );
    }
    return dataStore.upsertMany('historical', rows);
  }

  /**
   * fuzzy: when true, uses typo-tolerant name matching instead of exact.
   * Intended only as a fallback the caller invokes after an exact-match
   * query on the same filters comes back empty, to surface unconfirmed
   * "possible match" candidates - never the default matching behavior.
   */
  getMedalSummary({ sport, medal, country, games, athleteName } = {}, { fuzzy = false } = {}) {
    const nameCheck = fuzzy ? nameFuzzyMatches : nameMatches;
    const matches = (r) =>
      sportMatches(r, sport) &&
      (!medal || r.medal === medal.toUpperCase()) &&
      (!country || r.country.toLowerCase() === country.toLowerCase()) &&
      nameCheck(r.athleteName, athleteName);

    // games (e.g. "Commonwealth Games", "SEA Games") only applies to the
    // historical archive, which spans multiple past Games; the live
    // schedule feed is inherently scoped to Glasgow 2026 already.
    const historical = dataStore.getAll(
      'historical',
      (r) => r.medal && matches(r) && (!games || r.games.toLowerCase() === games.toLowerCase())
    );
    const current = dataStore.getAll('schedule', (r) => r.medal && matches(r));
    return { historical, current };
  }

  getRecords({ sport, recordType, athleteName } = {}, { fuzzy = false } = {}) {
    const nameCheck = fuzzy ? nameFuzzyMatches : nameMatches;
    return dataStore.getAll(
      'schedule',
      (r) =>
        r.recordType &&
        sportMatches(r, sport) &&
        (!recordType || r.recordType === recordType.toUpperCase()) &&
        nameCheck(r.athleteName, athleteName)
    );
  }

  /**
   * Pre-Games PB/NR reference baselines (not achievements) - what an
   * athlete's personal best already was, and the standing national record
   * for that event, BEFORE Glasgow 2026 results come in. Distinct from
   * getRecords(), which reports PB/NR/GR actually ACHIEVED during the
   * Games via the live schedule feed. No Games Record equivalent exists
   * here - see PbNrReferenceRowSchema for why.
   */
  getPbNrReference({ sport, athleteName, event } = {}, { fuzzy = false } = {}) {
    const nameCheck = fuzzy ? nameFuzzyMatches : nameMatches;
    return dataStore.getAll(
      'pbNrReference',
      (r) =>
        sportMatches(r, sport) &&
        (!event || r.event.toLowerCase() === event.toLowerCase()) &&
        nameCheck(r.athleteName, athleteName)
    );
  }

  getSchedule({ sport, status, athleteName, date } = {}, { fuzzy = false } = {}) {
    const nameCheck = fuzzy ? nameFuzzyMatches : nameMatches;
    // date is matched by actual calendar date (parsed on both sides), not
    // string equality - the sheet stores "23/7/2026", but a caller may
    // reasonably send "2026-07-23" or "23 July 2026"; exact-string
    // matching would silently return zero rows for any format mismatch.
    const targetDate = date ? parseFlexibleDate(date) : null;
    if (date && !targetDate) {
      throw new Error(`Could not understand the date "${date}". Try a format like "2026-07-23" or "23 July 2026".`);
    }
    return dataStore.getAll('schedule', (r) => {
      if (!sportMatches(r, sport)) return false;
      if (status && r.status.toLowerCase() !== status.toLowerCase()) return false;
      if (!nameCheck(r.athleteName, athleteName)) return false;
      if (targetDate) {
        const rowDate = parseScheduleDate(r.date);
        if (!rowDate || rowDate.getTime() !== targetDate.getTime()) return false;
      }
      return true;
    });
  }

  /**
   * Schedule rows falling between now and `hours` hours from now, both
   * computed in Singapore Time (the schedule's own DATE/TIME columns are
   * already SGT, per the sheet's "TIME START (SGP)" column). The reference
   * timestamps are returned alongside the rows so the answer can state
   * exactly what "now" and the window end were - never leave a model to
   * infer/guess the current time itself, since it has no reliable access
   * to the real wall clock.
   */
  getUpcomingSchedule({ hours = 24, sport, status } = {}) {
    const now = nowInSgt();
    const windowEnd = new Date(now.getTime() + hours * 60 * 60 * 1000);
    const oneDayMs = 24 * 60 * 60 * 1000;

    const candidates = dataStore.getAll(
      'schedule',
      (r) => sportMatches(r, sport) && (!status || r.status.toLowerCase() === status.toLowerCase())
    );

    const confirmed = [];
    const unconfirmedTime = [];
    for (const r of candidates) {
      const dateOnly = parseScheduleDate(r.date);
      if (!dateOnly) continue; // no parseable date at all - can't place it anywhere

      const hasRealTime = /^\d{1,2}:\d{2}$/.test(String(r.time || '').trim());
      if (!hasRealTime) {
        // Time is a placeholder (e.g. "TBC") - do NOT default it to
        // midnight and assert a specific instant. Only surface it as an
        // unconfirmed candidate if its calendar day (SGT) overlaps the
        // window at all; never state it as a confirmed time.
        const dayEnd = new Date(dateOnly.getTime() + oneDayMs - 1);
        if (dateOnly <= windowEnd && dayEnd >= now) unconfirmedTime.push(r);
        continue;
      }

      const dt = parseScheduleDateTime(r.date, r.time);
      if (dt && dt >= now && dt <= windowEnd) confirmed.push({ row: r, dt });
    }
    confirmed.sort((a, b) => a.dt - b.dt);

    return {
      nowSgt: formatSgt(now),
      windowEndSgt: formatSgt(windowEnd),
      hours,
      count: confirmed.length,
      rows: confirmed.map((x) => x.row),
      unconfirmedTimeCount: unconfirmedTime.length,
      unconfirmedTimeRows: unconfirmedTime,
    };
  }

  getContingent({ sport, athleteName } = {}, { fuzzy = false } = {}) {
    const nameCheck = fuzzy ? nameFuzzyMatches : nameMatches;
    return dataStore.getAll('contingent', (r) => sportMatches(r, sport) && nameCheck(r.athleteName, athleteName));
  }

  /**
   * Per-sport contingent size, counting each athlete once regardless of
   * how many events they're entered in. The raw contingent collection has
   * one row per athlete+event, so a plain row count materially overstates
   * multi-event sports (e.g. Athletics/Gymnastics/Aquatics athletes
   * routinely enter 2-3 events each) - "largest contingent" questions
   * need distinct people, not entries, and asking a model to de-duplicate
   * dozens of rows itself is unreliable.
   */
  getContingentSummary() {
    const rows = dataStore.getAll('contingent');
    const bySport = new Map();
    for (const r of rows) {
      if (!bySport.has(r.sport)) bySport.set(r.sport, { athletes: new Set(), entryCount: 0, sources: new Set() });
      const entry = bySport.get(r.sport);
      entry.athletes.add(r.athleteName.trim().toUpperCase());
      entry.entryCount += 1;
      entry.sources.add(r.source);
    }
    return [...bySport.entries()]
      .map(([sport, { athletes, entryCount, sources }]) => ({
        sport,
        athleteCount: athletes.size,
        entryCount,
        // Derived from the underlying rows' own source metadata, not
        // hardcoded, so this stays correct if contingent data is ever
        // merged from more than one source.
        source: [...sources].join(', '),
      }))
      .sort((a, b) => b.athleteCount - a.athleteCount);
  }

  /**
   * General-purpose group/count/sort over one collection, for analytical
   * questions with no dedicated method ("most medalled athlete", "sport
   * with the most entries in 2022", "which year had the most golds", ...).
   * This is NOT arbitrary code execution: collection, groupBy, and filter
   * keys are all checked against a fixed field allowlist (QUERYABLE_FIELDS)
   * and the only operation is count-per-group - callers (including an
   * LLM tool call) can compose novel questions within that shape, nothing
   * broader.
   *
   * @param {'historical'|'schedule'|'contingent'} collection
   * @param {string} groupBy - field to group by (must be in QUERYABLE_FIELDS[collection])
   * @param {Object} [filters] - exact-match filters, e.g. { medal: 'GOLD', games: 'SEA Games' }
   * @param {boolean} [requireMedal] - only rows with a medal set (historical/schedule)
   * @param {boolean} [requireRecordType] - only rows with a recordType set (schedule)
   * @param {'asc'|'desc'} [sortDirection]
   * @param {number} [limit]
   */
  aggregate({ collection, groupBy, filters = {}, requireMedal = false, requireRecordType = false, sortDirection = 'desc', limit = 10 }) {
    const fields = QUERYABLE_FIELDS[collection];
    if (!fields) {
      throw new Error(`Unknown collection "${collection}". Must be one of: ${Object.keys(QUERYABLE_FIELDS).join(', ')}`);
    }
    if (!fields.includes(groupBy)) {
      throw new Error(`Cannot group "${collection}" by "${groupBy}". Groupable fields: ${fields.join(', ')}`);
    }
    for (const key of Object.keys(filters || {})) {
      if (!fields.includes(key)) {
        throw new Error(`Cannot filter "${collection}" by "${key}". Filterable fields: ${fields.join(', ')}`);
      }
    }

    let rows = dataStore.getAll(collection);
    for (const [key, value] of Object.entries(filters || {})) {
      if (value === undefined || value === null || value === '') continue;
      const query = String(value).toLowerCase();
      rows = rows.filter((r) => typeof r[key] === 'string' && r[key].toLowerCase() === query);
    }
    if (requireMedal) rows = rows.filter((r) => r.medal);
    if (requireRecordType) rows = rows.filter((r) => r.recordType);

    // The contingent collection has one row per athlete PER EVENT, so
    // counting rows overstates any group containing a multi-event athlete
    // (e.g. grouping by debutantStatus previously returned 69 for "Yes"
    // when only 41 distinct athletes are actually debutants - the other
    // 28 were double-counted multi-event debutants). Track distinct
    // athletes per group instead of raw rows whenever grouping by
    // anything other than athleteName itself on this collection.
    const dedupeByAthlete = collection === 'contingent' && groupBy !== 'athleteName';

    const groups = new Map();
    for (const r of rows) {
      for (const key of groupKeysFor(r, groupBy)) {
        if (!groups.has(key)) groups.set(key, { count: 0, source: r.source, seenAthletes: dedupeByAthlete ? new Set() : null });
        const g = groups.get(key);
        if (dedupeByAthlete) {
          if (g.seenAthletes.has(r.athleteName)) continue;
          g.seenAthletes.add(r.athleteName);
        }
        g.count += 1;
      }
    }

    const entries = [...groups.entries()].map(([key, { count, source }]) => ({ [groupBy]: key, count, source }));
    entries.sort((a, b) => (sortDirection === 'asc' ? a.count - b.count : b.count - a.count));
    return entries.slice(0, Math.min(Math.max(limit, 1), 50));
  }

  /**
   * Youngest and oldest TeamSG athletes, computed from real birthdates
   * (not the sheet's own "Age" column, which can go stale) as of the
   * Games' actual start date - the earliest date found in the live
   * schedule feed - falling back to today only if the schedule is empty.
   * Age "as of the Games" (not as of today) is the standard convention
   * for this kind of question.
   */
  getAthleteAgeExtremes() {
    const scheduleDates = dataStore.getAll('schedule').map((r) => parseScheduleDate(r.date)).filter(Boolean);
    const referenceDate = scheduleDates.length ? new Date(Math.min(...scheduleDates.map((d) => d.getTime()))) : new Date();

    const contingentRows = this.getContingent({});
    const byAthlete = new Map();
    for (const r of contingentRows) {
      if (byAthlete.has(r.athleteName)) continue; // one entry per athlete, they may have multiple event rows
      byAthlete.set(r.athleteName, r);
    }

    const withKnownDob = [];
    let missingDobCount = 0;
    for (const r of byAthlete.values()) {
      const dob = parseDob(r.dateOfBirth);
      if (!dob) {
        missingDobCount += 1;
        continue;
      }
      withKnownDob.push({
        athleteName: r.athleteName,
        sport: r.sport,
        dateOfBirth: r.dateOfBirth,
        ageYears: ageInYears(dob, referenceDate),
        source: r.source,
      });
    }
    withKnownDob.sort((a, b) => a.ageYears - b.ageYears);

    return {
      referenceDate: referenceDate.toISOString().slice(0, 10),
      totalAthletes: byAthlete.size,
      athletesWithKnownBirthdate: withKnownDob.length,
      missingBirthdateCount: missingDobCount,
      youngest: withKnownDob[0] || null,
      oldest: withKnownDob[withKnownDob.length - 1] || null,
    };
  }

  /**
   * Sports in the current contingent with no historical row (medal or
   * otherwise) for the given past Games. CAVEAT that callers must surface:
   * the historical archive only records MEDAL-WINNING results for
   * SEA/Asian/Commonwealth Games - full participation is only tracked for
   * Olympic Games - so "no historical row" here means "no medal ever won
   * at that Games", not proof the sport was never contested before.
   * Matches against both the specific sport and broader sportGroup on the
   * historical side, so a naming-granularity difference (e.g. a sport
   * grouped differently between sheets) doesn't produce a false debut.
   */
  getContingentSportsWithoutHistory({ games } = {}) {
    const contingentRows = this.getContingent({});
    const bySport = new Map();
    for (const r of contingentRows) {
      if (!bySport.has(r.sport.toLowerCase())) bySport.set(r.sport.toLowerCase(), r);
    }

    const historicalRows = dataStore.getAll('historical', (r) => !games || r.games.toLowerCase() === games.toLowerCase());
    const historicalSports = new Set();
    for (const r of historicalRows) {
      if (r.sport) historicalSports.add(r.sport.toLowerCase());
      if (r.sportGroup) historicalSports.add(r.sportGroup.toLowerCase());
    }

    return [...bySport.entries()]
      .filter(([lower]) => !historicalSports.has(lower))
      .map(([, row]) => ({ sport: row.sport, source: row.source }))
      .sort((a, b) => a.sport.localeCompare(b.sport));
  }

  /**
   * For every sport in the current TeamSG contingent: whether TeamSG has
   * ever won a medal at the given past Games, and if so, the most recent
   * year they did - a "sport by sport" debut/history breakdown. Same
   * medal-archive caveat as getContingentSportsWithoutHistory(): the
   * historical archive only records MEDAL-WINNING results for
   * SEA/Asian/Commonwealth Games (full participation is only tracked for
   * Olympic Games), so "no medal" here means "no medal ever won at that
   * Games", not proof the sport was never contested before.
   */
  getSportMedalHistory({ games = 'Commonwealth Games' } = {}) {
    const contingentRows = this.getContingent({});
    const bySport = new Map();
    for (const r of contingentRows) {
      if (!bySport.has(r.sport.toLowerCase())) bySport.set(r.sport.toLowerCase(), r.sport);
    }

    const historicalRows = dataStore.getAll(
      'historical',
      (r) => r.medal && r.games.toLowerCase() === games.toLowerCase()
    );
    const lastMedalYearBySport = new Map();
    for (const r of historicalRows) {
      const year = Number(r.year);
      if (Number.isNaN(year)) continue;
      for (const key of [r.sport, r.sportGroup]) {
        if (!key) continue;
        const lower = key.toLowerCase();
        if (!lastMedalYearBySport.has(lower) || lastMedalYearBySport.get(lower) < year) {
          lastMedalYearBySport.set(lower, year);
        }
      }
    }

    return [...bySport.entries()]
      .map(([lower, sport]) => {
        const lastMedalYear = lastMedalYearBySport.has(lower) ? lastMedalYearBySport.get(lower) : null;
        return { sport, games, hasWonMedalBefore: lastMedalYear !== null, lastMedalYear };
      })
      .sort((a, b) => a.sport.localeCompare(b.sport));
  }

  getHighlights({ sport } = {}) {
    return dataStore.getAll('highlights', (r) => sportMatches(r, sport));
  }

  searchHighlights(keyword) {
    if (!keyword) return dataStore.getAll('highlights');
    const kw = keyword.toLowerCase();
    return dataStore.getAll(
      'highlights',
      (r) => r.sport.toLowerCase().includes(kw) || r.content.toLowerCase().includes(kw)
    );
  }

  getStats() {
    return dataStore.stats();
  }
}

const queryService = new QueryService();

module.exports = { queryService, QueryService };
