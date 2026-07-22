'use strict';

const crypto = require('crypto');

/**
 * Uniform contract every ingestion pipeline (Excel, Google Sheets, filesystem,
 * mock) must implement. Downstream code (queryService, dataStore, aiEngine)
 * only ever talks to this interface, so a real adapter can replace a mock
 * adapter (or a scraper can replace a Sheets adapter) without touching the
 * repository, REST API, or AI prompts.
 */
class BaseAdapter {
  constructor({ sourceId, sourceLabel }) {
    if (new.target === BaseAdapter) {
      throw new Error('BaseAdapter is abstract and cannot be instantiated directly');
    }
    if (!sourceId || !sourceLabel) {
      throw new Error('BaseAdapter requires both sourceId and sourceLabel');
    }
    this.sourceId = sourceId;
    this.sourceLabel = sourceLabel;
  }

  /**
   * Fetch raw, un-normalized rows from the underlying medium
   * (sheet API response, xlsx worksheet, directory listing, etc).
   * Must resolve to an array, even when empty (never throw for "no data yet").
   */
  // eslint-disable-next-line class-methods-use-this
  async fetchRaw() {
    throw new Error(`${this.constructor.name} must implement fetchRaw()`);
  }

  /**
   * Map one raw row into the adapter's canonical row shape.
   * Return null/undefined to skip an invalid or empty row.
   */
  // eslint-disable-next-line class-methods-use-this
  normalize(rawRow) {
    throw new Error(`${this.constructor.name} must implement normalize(rawRow)`);
  }

  /**
   * Return a stable string that uniquely identifies this row's real-world
   * identity (e.g. athlete + sport + event), used to derive a deterministic
   * id so re-syncing the same logical row updates it instead of duplicating it.
   */
  // eslint-disable-next-line class-methods-use-this
  getBusinessKey(normalizedRow) {
    throw new Error(`${this.constructor.name} must implement getBusinessKey(normalizedRow)`);
  }

  /**
   * Full pipeline: fetch -> normalize -> attach id/hash/source metadata.
   * This is the only method callers outside this file should invoke.
   */
  async fetchNormalized() {
    const rawRows = await this.fetchRaw();
    if (!Array.isArray(rawRows)) {
      throw new Error(`${this.constructor.name}.fetchRaw() must resolve to an array`);
    }

    const normalized = [];
    for (const raw of rawRows) {
      const row = this.normalize(raw);
      if (!row) continue;

      const { _sourceOverride, _businessKeyOverride, ...rest } = row;
      // Lets a normalize() implementation supply a guaranteed-unique key
      // (e.g. a source row id) instead of one reconstructed from other
      // fields, for sources where reconstructed keys can legitimately
      // collide (e.g. several distinct team-event match rows that share
      // the same athlete/sport/event/date).
      const businessKey = _businessKeyOverride || this.getBusinessKey(rest);
      const id = BaseAdapter.computeId(this.sourceId, businessKey);
      const contentHash = BaseAdapter.computeContentHash(rest);

      normalized.push({
        ...rest,
        id,
        contentHash,
        source: _sourceOverride || this.sourceLabel,
        sourceId: this.sourceId,
        ingestedAt: new Date().toISOString(),
      });
    }
    return normalized;
  }

  static computeId(sourceId, businessKey) {
    return crypto.createHash('sha256').update(`${sourceId}::${businessKey}`).digest('hex');
  }

  static computeContentHash(row) {
    return crypto.createHash('sha256').update(BaseAdapter.stableStringify(row)).digest('hex');
  }

  static stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(BaseAdapter.stableStringify).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${BaseAdapter.stableStringify(value[k])}`).join(',')}}`;
  }
}

module.exports = { BaseAdapter };
