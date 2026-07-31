'use strict';

/**
 * npm run seed
 *
 * Generates a real fixture file on disk for Source 1 (Excel), so the system
 * can be exercised end-to-end against the *real* local file adapter even
 * with MOCK_MODE=false. (Google Sheets sources 2, 3 & 4 still require live
 * credentials in that mode - use MOCK_MODE=true to test those without any
 * external setup at all.)
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { config } = require('../config/environment');

const HISTORICAL_ROWS = [
  {
    AthleteName: 'Joseph Tan',
    Sport: 'Swimming',
    Event: "Men's 50m Freestyle",
    Games: 'Gold Coast 2018',
    Year: '2018',
    Country: 'SGP',
    Result: '22.31',
    Medal: 'SILVER',
    Position: '2',
    Notes: 'Narrowly missed gold on the final touch.',
  },
  {
    AthleteName: 'Feng Yingying',
    Sport: 'Table Tennis',
    Event: "Women's Singles",
    Games: 'Birmingham 2022',
    Year: '2022',
    Country: 'SGP',
    Result: 'Won final 4-1',
    Medal: 'GOLD',
    Position: '1',
    Notes: 'TeamSG extended its dominant Commonwealth table tennis run.',
  },
  {
    AthleteName: 'Rachel Neo',
    Sport: 'Badminton',
    Event: "Women's Singles",
    Games: 'Birmingham 2022',
    Year: '2022',
    Country: 'SGP',
    Result: 'Lost semifinal',
    Medal: 'BRONZE',
    Position: '3',
    Notes: '',
  },
  {
    AthleteName: 'Danial Yusof',
    Sport: 'Athletics',
    Event: "Men's Long Jump",
    Games: 'Gold Coast 2018',
    Year: '2018',
    Country: 'SGP',
    Result: '7.65m',
    Medal: '',
    Position: '6',
    Notes: 'Season best in qualifying round.',
  },
];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function seedExcel() {
  ensureDir(path.dirname(config.paths.historicalExcel));
  const worksheet = XLSX.utils.json_to_sheet(HISTORICAL_ROWS);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'PastResults');
  XLSX.writeFile(workbook, config.paths.historicalExcel);
  console.log(`Seeded historical Excel: ${config.paths.historicalExcel}`);
}

function seedUploadsDir() {
  ensureDir(config.paths.uploadDir);
  console.log(`Ensured upload scratch directory exists: ${config.paths.uploadDir}`);
}

function main() {
  seedExcel();
  seedUploadsDir();
  console.log('\nSeed complete.');
  console.log('- MOCK_MODE=true  -> app uses in-code mock data for all 4 sources (no setup needed).');
  console.log('- MOCK_MODE=false -> app reads the seeded file above for Source 1; Google Sheets (Source 2, 3 & 4) still need live credentials.');
}

main();
