'use strict';

const { google } = require('googleapis');
const { BaseAdapter } = require('./baseAdapter');
const { config } = require('../../config/environment');

function normalizeMedal(value) {
  if (!value) return null;
  const v = String(value).trim().toUpperCase();
  if (['GOLD', 'G', '1'].includes(v)) return 'GOLD';
  if (['SILVER', 'S', '2'].includes(v)) return 'SILVER';
  if (['BRONZE', 'B', '3'].includes(v)) return 'BRONZE';
  return null;
}

const KNOWN_RECORD_TYPES = ['PB', 'GR', 'WR', 'NR', 'SB'];

/**
 * Tolerates both a plain single value ("PB") and the compound
 * pipe-delimited values this org's real tracking sheet uses
 * ("NA | NA", "PB | NA") by tokenizing and returning the first
 * recognized record-type token found. "NA" (not applicable / not yet
 * filled in) correctly falls through to null either way.
 */
function normalizeRecordType(value) {
  if (!value) return null;
  const tokens = String(value).toUpperCase().split(/[^A-Z]+/).filter(Boolean);
  return tokens.find((t) => KNOWN_RECORD_TYPES.includes(t)) || null;
}

/**
 * Extracts the tab name a range refers to (e.g. "Contingent!A1:Z1000" ->
 * "Contingent"), so citations can name the actual sheet/tab a fact came
 * from instead of a generic hardcoded label. Handles the quoted form
 * Sheets uses for tab names containing spaces ("'Debutant Status'!A2:I200"),
 * including the doubled-quote escaping for a literal ' in a tab name.
 */
function tabNameFromRange(range) {
  const idx = range.lastIndexOf('!');
  if (idx === -1) return range;
  const name = range.slice(0, idx);
  if (name.startsWith("'") && name.endsWith("'")) {
    return name.slice(1, -1).replace(/''/g, "'");
  }
  return name;
}

function getAuth() {
  const privateKey = (config.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  return new google.auth.JWT({
    email: config.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

/**
 * Pull a sheet range and turn it into an array of header-keyed objects.
 * Row 1 is treated as the header row; blank rows are dropped.
 */
async function fetchSheetRows(sheetId, range) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  const values = res.data.values || [];
  if (values.length < 2) return [];

  const [headerRow, ...dataRows] = values;
  const headers = headerRow.map((h) => String(h ?? '').trim());

  return dataRows
    .filter((row) => row.some((cell) => String(cell ?? '').trim() !== ''))
    .map((row) => {
      const obj = {};
      headers.forEach((header, i) => {
        obj[header] = row[i] !== undefined ? String(row[i]).trim() : '';
      });
      return obj;
    });
}

/**
 * Source 2: Contingent Details - active team lists, event eligibility,
 * historical notes, and current personal records.
 */
class ContingentSheetAdapter extends BaseAdapter {
  constructor() {
    const tabName = tabNameFromRange(config.GOOGLE_CONTINGENT_RANGE);
    super({ sourceId: 'contingent_sheet', sourceLabel: `Google Sheet ("${tabName}" tab)` });
    // athleteName (uppercased) -> literal 'Yes'/'No' from the Debutant
    // Status tab, populated by fetchRaw(). A separate tab (one row per
    // athlete) rather than a column on the main roster tab (one row per
    // athlete PER EVENT), so it's fetched separately and joined by name.
    this._debutantLookup = new Map();
  }

  async fetchRaw() {
    if (!config.GOOGLE_SHEET_ID_CONTINGENT) {
      throw new Error('GOOGLE_SHEET_ID_CONTINGENT is not configured');
    }
    let rosterRows;
    try {
      rosterRows = await fetchSheetRows(config.GOOGLE_SHEET_ID_CONTINGENT, config.GOOGLE_CONTINGENT_RANGE);
    } catch (err) {
      throw new Error(`Failed to fetch Contingent sheet: ${err.message}`);
    }

    // Debutant Status is a supplementary tab, not present in every
    // deployment - a failure here degrades to "no debutant data" rather
    // than failing the whole contingent sync.
    let debutantRows = [];
    try {
      debutantRows = await fetchSheetRows(config.GOOGLE_SHEET_ID_CONTINGENT, config.GOOGLE_DEBUTANT_RANGE);
    } catch {
      debutantRows = [];
    }
    this._debutantLookup = new Map(
      debutantRows
        .map((r) => [
          (r['Name as per Passport'] || '').trim().toUpperCase(),
          (r['DEBUTANT STATUS IN \nCOMMONWEALTH GAMES'] || r['DEBUTANT STATUS'] || '').trim(),
        ])
        .filter(([name]) => name)
    );

    return rosterRows;
  }

  normalize(raw) {
    // 'Name as per Passport' / 'Sports' / 'Going?' are the real column names
    // in this org's live contingent tracker; the plain-English fallbacks
    // (AthleteName, Sport, ...) keep the mock/test fixtures working unchanged.
    const athleteName = raw['Name as per Passport'] || raw.AthleteName || raw.athleteName || '';
    if (!athleteName) return null;

    // A mock/test row can carry this key directly (no separate sheet to
    // join against); a real row falls through to the fetchRaw()-populated
    // lookup, joined by name.
    const debutantStatus = raw['DEBUTANT STATUS IN \nCOMMONWEALTH GAMES'] || this._debutantLookup.get(athleteName.toUpperCase()) || '';

    const going = String(raw['Going?'] || '').trim().toUpperCase();
    const goingKnown = going === 'Y' || going === 'N';
    const roleNotes = [...new Set([raw.Role, raw.Function].filter(Boolean))].join(' / ');

    return {
      athleteName,
      sport: raw.Sports || raw.Sport || raw.sport || 'Unknown',
      event: raw.Event || raw.event || '',
      eligibility: goingKnown ? (going === 'Y' ? 'Confirmed' : 'Not Selected') : raw.Eligibility || raw.eligibility || 'Confirmed',
      personalBest: raw.PersonalBest || raw.PB || raw.personalBest || '',
      historicalNotes: raw.HistoricalNotes || raw.Notes || raw.notes || roleNotes,
      status: goingKnown ? (going === 'Y' ? 'Active' : 'Not Going') : raw.Status || raw.status || 'Active',
      dateOfBirth: raw.DOB || raw.dateOfBirth || raw.DateOfBirth || '',
      debutantStatus,
    };
  }

  // eslint-disable-next-line class-methods-use-this
  getBusinessKey(row) {
    return `${row.athleteName}|${row.sport}|${row.event}`;
  }
}

/**
 * Source 3: Competition Schedule and Results - delta-synced tab driving
 * live medal / PB / GR / WR / NR tracking.
 */
class ScheduleSheetAdapter extends BaseAdapter {
  constructor() {
    const tabName = tabNameFromRange(config.GOOGLE_SCHEDULE_RANGE);
    super({ sourceId: 'schedule_sheet', sourceLabel: `Google Sheet ("${tabName}" tab)` });
  }

  async fetchRaw() {
    if (!config.GOOGLE_SHEET_ID_SCHEDULE) {
      throw new Error('GOOGLE_SHEET_ID_SCHEDULE is not configured');
    }
    try {
      return await fetchSheetRows(config.GOOGLE_SHEET_ID_SCHEDULE, config.GOOGLE_SCHEDULE_RANGE);
    } catch (err) {
      throw new Error(`Failed to fetch Schedule sheet: ${err.message}`);
    }
  }

  // eslint-disable-next-line class-methods-use-this
  normalize(raw) {
    // ALL-CAPS keys (SPORT, EVENT, 'NAME OF ATHLETE (SGP)', ...) are the real
    // column names in this org's live schedule tracker; the plain-English
    // fallbacks (Sport, AthleteName, ...) keep mock/test fixtures working.
    const sport = raw.SPORT || raw.Sport || raw.sport || '';
    if (!sport) return null;

    const resultsFilled = String(raw['RESULTS FILLED'] || '').trim().toUpperCase();
    // Prefer the validated/confirmed record column over the draft one when set.
    const confirmedRecord = raw['CONFIRMED PB/NR/GR'] && raw['CONFIRMED PB/NR/GR'].trim();
    const recordSource = confirmedRecord || raw['PB/NR/GR'] || raw.RecordType || raw.recordType;
    const resultMark =
      raw['TIMING (SGP)\nhh:mm:ss.ms'] ||
      raw['SCORE/DISTANCE/HEIGHT\n(SGP)'] ||
      raw['TOTAL SCORE (SGP)'] ||
      raw.Result ||
      raw.resultMark ||
      '';

    return {
      // The org split the sheet's single DATE column into DATE (SGP) / DATE
      // (UK) at some point - prefer the SGP one, consistent with every other
      // SGP-suffixed column here (times, scores) already being the SGT side
      // of a UK/SGP pair. Old plain "DATE" and mock-fixture fallbacks kept
      // for compatibility.
      date: raw['DATE (SGP)'] || raw['DATE (UK)'] || raw.DATE || raw.Date || raw.date || '',
      time: raw['TIME START (SGP) 24HR CLOCK'] || raw.Time || raw.time || '',
      sport,
      event: raw.EVENT || raw.Event || raw.event || '',
      round: raw['STAGE / ROUND OF COMPETITION'] || raw.Round || raw.round || 'Final',
      heatNumber: raw['HEAT NUMBER'] || '',
      athleteName: raw['NAME OF ATHLETE (SGP)'] || raw.AthleteName || raw.athleteName || '',
      country: raw.Country || raw.country || 'SGP',
      resultMark,
      // MEDAL COLOUR is a separate column from MEDAL in the live sheet
      // (mirroring the historical Excel's MEDAL_COLOUR) - neither has any
      // real value yet (results not in), so which one the org ultimately
      // fills in is unconfirmed; check both rather than guess-remove either.
      medal: normalizeMedal(raw['MEDAL COLOUR'] || raw.MEDAL || raw.Medal || raw.medal),
      recordType: normalizeRecordType(recordSource),
      status: resultsFilled === 'YES' ? 'Completed' : raw.Status || raw.status || 'Scheduled',
    };
  }

  // eslint-disable-next-line class-methods-use-this
  getBusinessKey(row) {
    // time is included because this sheet can list multiple matches for the
    // same athlete/event/round on one date (e.g. several Group Match games
    // against different opponents), differentiated only by kickoff time.
    return `${row.athleteName}|${row.sport}|${row.event}|${row.round}|${row.heatNumber}|${row.date}|${row.time}`;
  }
}

module.exports = {
  ContingentSheetAdapter,
  ScheduleSheetAdapter,
  normalizeMedal,
  normalizeRecordType,
  fetchSheetRows,
};
