'use strict';

/**
 * npm run seed
 *
 * Generates real fixture files on disk for Source 1 (Excel) and Source 4
 * (highlight markdown files), so the system can be exercised end-to-end
 * against the *real* local file adapters even with MOCK_MODE=false.
 * (Google Sheets sources 2 & 3 still require live credentials in that mode -
 * use MOCK_MODE=true to test those without any external setup at all.)
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

const HIGHLIGHT_FILES = {
  'swimming.md': `# Swimming - Sport Officer Notes

TeamSG's swimming contingent heads into Glasgow 2026 anchored by Ryan Tng, who arrives off the back of a personal-best season in the Men's 100m Freestyle. Coaches have flagged his back-half speed as the key differentiator against the Commonwealth's deeper sprint field this cycle.

Amanda Chen returns to the 200m Individual Medley after a breakout showing at the most recent SEA Games, having tightened her breaststroke-to-freestyle transition - historically her weakest split.

Watch for: relay depth remains a rebuilding area following the retirement of two senior mixed-relay anchors after Birmingham 2022.
`,
  'athletics.md': `# Athletics - Sport Officer Notes

Danielle Seah leads TeamSG's track contingent in the Women's 100m Hurdles, carrying the National Record into Glasgow after back-to-back sub-13-second clockings this season. Her start reaction time has been the focus of a technical adjustment made over the past 18 months.

The field events roster remains lean this cycle; no TeamSG qualifiers currently hold a top-8 world ranking in throws or jumps disciplines.

Watch for: the hurdles semifinal draw is expected to be highly competitive, with three Oceania-region rivals inside 0.1s of Seah's season best.
`,
  'badminton.md': `# Badminton - Sport Officer Notes

The Mixed Doubles pairing of Marcus Wee and Grace Lim enters Glasgow as one of TeamSG's strongest medal contenders, having climbed steadily in continental rankings since their pairing was formalized after Birmingham 2022.

Their game plan leans on Wee's front-court interception speed and Lim's rear-court smash accuracy, a combination that has troubled higher-seeded pairs in recent tune-up events.

Watch for: draw proximity to the top-seeded pair in the quarterfinal round, which could set up an early marquee match.
`,
  'table-tennis.md': `# Table Tennis - Sport Officer Notes

Wendy Ho carries TeamSG's singles hopes in Women's Singles, coming off a disciplined defensive-to-offensive transition retooled by the coaching staff over the past year.

Historically, TeamSG's table tennis program has been the most decorated Commonwealth Games discipline for Singapore, and expectations inside the camp remain high even as the roster undergoes generational transition.

Watch for: Ho's semifinal opponent, should she advance, will likely be a left-handed penhold stylist - a matchup she has historically found difficult.
`,
};

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

function seedHighlights() {
  ensureDir(config.paths.highlightsDir);
  for (const [name, content] of Object.entries(HIGHLIGHT_FILES)) {
    fs.writeFileSync(path.join(config.paths.highlightsDir, name), content, 'utf-8');
  }
  console.log(`Seeded ${Object.keys(HIGHLIGHT_FILES).length} highlight files in: ${config.paths.highlightsDir}`);
}

function seedUploadsDir() {
  ensureDir(config.paths.uploadDir);
  console.log(`Ensured upload scratch directory exists: ${config.paths.uploadDir}`);
}

function main() {
  seedExcel();
  seedHighlights();
  seedUploadsDir();
  console.log('\nSeed complete.');
  console.log('- MOCK_MODE=true  -> app uses in-code mock data for all 4 sources (no setup needed).');
  console.log('- MOCK_MODE=false -> app reads the seeded files above for Source 1 & 4; Google Sheets (Source 2 & 3) still need live credentials.');
}

main();
