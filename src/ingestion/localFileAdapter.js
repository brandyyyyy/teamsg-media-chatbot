'use strict';

const fs = require('fs/promises');
const path = require('path');
const XLSX = require('xlsx');
const { BaseAdapter } = require('./baseAdapter');
const { config } = require('../../config/environment');
const { normalizeMedal } = require('./googleSheets');

const EXCEL_FILE_PATTERN = /\.(xlsx|xls)$/i;

/** Filters out Excel's transient lock files (e.g. "~$consolidated_games.xlsx"). */
function isRealExcelFile(fileName) {
  return EXCEL_FILE_PATTERN.test(fileName) && !fileName.startsWith('~$');
}

/**
 * Picks the sheet actually holding row-level results. Real exports from
 * this org name it "Consolidated Games" among several admin/reference
 * tabs (Change Log, Tally Check, ...); simple single-sheet workbooks
 * (uploads, seeded mock fixtures) fall back to whichever sheet is first.
 */
function pickResultsSheet(workbook) {
  const preferred = workbook.SheetNames.find((n) => n.trim().toLowerCase() === 'consolidated games');
  const name = preferred || workbook.SheetNames[0];
  return name ? { name, sheet: workbook.Sheets[name] } : null;
}

/**
 * Source 1: Past TeamSG Results - uploaded/local static historical Excel
 * spreadsheet. Can read either an in-memory Buffer (fresh upload) or a
 * file already sitting on disk (cold-boot / re-sync).
 *
 * The exact filename is not assumed - the org periodically replaces this
 * file with a freshly-dated export (e.g. "consolidated_games_150726.xlsx").
 * When HISTORICAL_EXCEL_PATH's configured filename isn't present, any
 * .xlsx/.xls file in that same directory is used instead (most recently
 * modified wins if there's more than one).
 */
class ExcelHistoricalAdapter extends BaseAdapter {
  constructor(buffer = null, filePath = config.paths.historicalExcel, label = null) {
    super({
      sourceId: 'historical_excel',
      sourceLabel: label || path.basename(filePath || 'past_results.xlsx'),
    });
    this.buffer = buffer;
    this.filePath = filePath;
    this.explicitLabel = label;
  }

  /**
   * Always scans the directory and picks the most recently modified
   * .xlsx/.xls file, rather than preferring an exact HISTORICAL_EXCEL_PATH
   * filename match. This matters in practice: if a stale file (e.g. one
   * left behind by `npm run seed`) shares the configured default name
   * while a newer dated export sits alongside it, "freshest file wins"
   * is the only rule that reliably picks the real, current data.
   */
  async _resolveExistingFile() {
    const dir = path.dirname(this.filePath);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }

    const candidates = entries.filter((e) => e.isFile() && isRealExcelFile(e.name));
    if (!candidates.length) return null;

    const withStats = await Promise.all(
      candidates.map(async (e) => {
        const fullPath = path.join(dir, e.name);
        const stat = await fs.stat(fullPath);
        return { fullPath, mtimeMs: stat.mtimeMs };
      })
    );
    withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return withStats[0].fullPath;
  }

  async fetchRaw() {
    let workbook;
    if (this.buffer) {
      if (!this.buffer.length) throw new Error('Empty Excel buffer provided');
      workbook = XLSX.read(this.buffer, { type: 'buffer' });
    } else {
      const resolvedPath = await this._resolveExistingFile();
      if (!resolvedPath) return []; // Graceful: no historical spreadsheet has been uploaded/seeded yet.
      if (!this.explicitLabel) this.sourceLabel = path.basename(resolvedPath);
      const fileBuffer = await fs.readFile(resolvedPath);
      workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    }

    const picked = pickResultsSheet(workbook);
    if (!picked) return [];
    return XLSX.utils.sheet_to_json(picked.sheet, { defval: '', raw: false });
  }

  // eslint-disable-next-line class-methods-use-this
  normalize(raw) {
    // ATHLETE_NAME / 'SPORT GROUP' / MEDAL_COLOUR / ROW_ID etc. are the real
    // column names in this org's consolidated historical results export;
    // the plain-English fallbacks (AthleteName, Sport, ...) keep the
    // mock/seeded fixtures working unchanged.
    const countryCode = raw.COUNTRY_CODE || raw.Country || raw.country || '';
    if (countryCode && countryCode.trim().toUpperCase() !== 'SGP') return null; // only TeamSG's own results

    const athleteName = raw.ATHLETE_NAME || raw.AthleteName || raw.Athlete || raw.athleteName || '';
    if (!athleteName) return null;

    // SPORT (specific, e.g. "SWIMMING") and SPORT GROUP (broad, e.g.
    // "AQUATICS") are both real columns in the export - journalists query
    // either level, so both must be independently matchable (see
    // queryService.sportMatches). Mock/simple fixtures only have one
    // "Sport" value, so sportGroup falls back to the same value.
    const sport = raw.SPORT || raw.Sport || raw.sport || 'Unknown';
    const sportGroup = raw['SPORT GROUP'] || sport;

    const cleanedEvent = raw.EVENT || raw.Event || raw.event || '';
    const originalEvent = raw.ORIGINAL_EVENT || '';
    // One row in the real export has a "cleaned" EVENT value that appears
    // to have bled over from the row above it, dropping a Para
    // classification suffix (e.g. "S7") that IS present in ORIGINAL_EVENT.
    // When that suffix is missing from the cleaned value, trust the
    // original instead - evidenced against this specific dataset, not a
    // general assumption about which column is more reliable.
    const paraClassMatch = originalEvent.match(/\b(S|SB|SM)\d{1,2}\b/i);
    const event =
      paraClassMatch && !cleanedEvent.toUpperCase().includes(paraClassMatch[0].toUpperCase())
        ? originalEvent
        : cleanedEvent || originalEvent;

    return {
      games: String(raw['MAJOR GAME'] || raw.Games || raw.games || ''),
      year: String(raw.YEAR || raw.Year || raw.year || ''),
      sport,
      sportGroup,
      event,
      athleteName,
      country: countryCode || 'SGP',
      resultMark: String(raw.REMARKS || raw.Result || raw.resultMark || ''),
      medal: normalizeMedal(raw.MEDAL_COLOUR || raw.Medal || raw.medal),
      position: String(raw.POSITION || raw.Position || raw.position || ''),
      notes: raw.Notes || raw.notes || '',
      // ROW_ID is a genuinely unique per-row identifier in the real export.
      // Reconstructing identity from athlete/sport/event/games alone
      // collides for team events with multiple distinct match rows (e.g.
      // several results under the same "TEAM" event/games/year), so prefer
      // ROW_ID when present instead of falling through to getBusinessKey().
      _businessKeyOverride: raw.ROW_ID ? `excel_row_${raw.ROW_ID}` : undefined,
    };
  }

  // eslint-disable-next-line class-methods-use-this
  getBusinessKey(row) {
    return `${row.athleteName}|${row.sport}|${row.event}|${row.games}|${row.year}`;
  }
}

module.exports = { ExcelHistoricalAdapter };
