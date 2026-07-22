'use strict';

const { config } = require('../../config/environment');
const { ExcelHistoricalAdapter, HighlightsFolderAdapter } = require('./localFileAdapter');
const { ContingentSheetAdapter, ScheduleSheetAdapter } = require('./googleSheets');

/**
 * High-fidelity mock ingestion framework. Every mock adapter *extends* its
 * real counterpart and only overrides fetchRaw() - normalize()/getBusinessKey()
 * are inherited verbatim. This means the moment real credentials/files exist,
 * queryService can swap the mock class for the real one with no other code
 * change anywhere downstream (repository, REST API, AI prompts stay identical).
 *
 * All fictional athlete names below are placeholders for testing only.
 */

const HISTORICAL_MOCK_ROWS = [
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
    Medal: null,
    Position: '6',
    Notes: 'Season best in qualifying round.',
  },
];

const CONTINGENT_MOCK_ROWS = [
  {
    AthleteName: 'Ryan Tng',
    Sport: 'Swimming',
    Event: "Men's 100m Freestyle",
    Eligibility: 'Confirmed',
    PersonalBest: '48.22',
    HistoricalNotes: 'Qualified via SEA Games 2025 timing standard; first Commonwealth Games team.',
    Status: 'Active',
    DOB: '14-May-2006',
    'DEBUTANT STATUS IN \nCOMMONWEALTH GAMES': 'Yes',
  },
  {
    AthleteName: 'Amanda Chen',
    Sport: 'Swimming',
    Event: "Women's 200m Individual Medley",
    Eligibility: 'Confirmed',
    PersonalBest: '2:12.05',
    HistoricalNotes: 'Breakout SEA Games 2025 performance; retooled breaststroke-to-freestyle transition.',
    Status: 'Active',
    DOB: '2-Sep-2008',
    'DEBUTANT STATUS IN \nCOMMONWEALTH GAMES': 'Yes',
  },
  {
    AthleteName: 'Danielle Seah',
    Sport: 'Athletics',
    Event: "Women's 100m Hurdles",
    Eligibility: 'Confirmed',
    PersonalBest: '12.98',
    HistoricalNotes: 'Current National Record holder entering Glasgow 2026.',
    Status: 'Active',
    DOB: '21-Jan-1999',
    'DEBUTANT STATUS IN \nCOMMONWEALTH GAMES': 'No',
  },
  {
    AthleteName: 'Marcus Wee / Grace Lim',
    Sport: 'Badminton',
    Event: 'Mixed Doubles',
    Eligibility: 'Confirmed',
    PersonalBest: '',
    HistoricalNotes: 'Pairing formalized after Birmingham 2022; steadily rising continental ranking.',
    Status: 'Active',
    DOB: '',
    'DEBUTANT STATUS IN \nCOMMONWEALTH GAMES': 'No',
  },
  {
    AthleteName: 'Wendy Ho',
    Sport: 'Table Tennis',
    Event: "Women's Singles",
    Eligibility: 'Confirmed',
    PersonalBest: '',
    HistoricalNotes: 'Retooled defensive-to-offensive playing style over the past year.',
    Status: 'Active',
    DOB: '30-Jun-2003',
    'DEBUTANT STATUS IN \nCOMMONWEALTH GAMES': 'Yes',
  },
];

const SCHEDULE_MOCK_ROWS = [
  {
    Date: '2026-07-25',
    Time: '19:30',
    Sport: 'Swimming',
    Event: "Men's 100m Freestyle",
    Round: 'Final',
    AthleteName: 'Ryan Tng',
    Country: 'SGP',
    Result: '47.85',
    Medal: 'GOLD',
    RecordType: 'GR',
    Status: 'Completed',
  },
  {
    Date: '2026-07-26',
    Time: '20:05',
    Sport: 'Swimming',
    Event: "Women's 200m Individual Medley",
    Round: 'Final',
    AthleteName: 'Amanda Chen',
    Country: 'SGP',
    Result: '2:11.40',
    Medal: 'SILVER',
    RecordType: 'PB',
    Status: 'Completed',
  },
  {
    Date: '2026-07-29',
    Time: '21:10',
    Sport: 'Athletics',
    Event: "Women's 100m Hurdles",
    Round: 'Final',
    AthleteName: 'Danielle Seah',
    Country: 'SGP',
    Result: '12.85',
    Medal: 'BRONZE',
    RecordType: 'NR',
    Status: 'Completed',
  },
  {
    Date: '2026-08-01',
    Time: '15:00',
    Sport: 'Badminton',
    Event: 'Mixed Doubles',
    Round: 'Final',
    AthleteName: 'Marcus Wee / Grace Lim',
    Country: 'SGP',
    Result: 'Won 21-18, 21-15',
    Medal: 'GOLD',
    RecordType: '',
    Status: 'Completed',
  },
  {
    Date: '2026-08-02',
    Time: '10:30',
    Sport: 'Table Tennis',
    Event: "Women's Singles",
    Round: 'Semifinal',
    AthleteName: 'Wendy Ho',
    Country: 'SGP',
    Result: '',
    Medal: '',
    RecordType: '',
    Status: 'Scheduled',
  },
];

const HIGHLIGHT_MOCK_FILES = [
  {
    fileName: 'swimming.md',
    content: `# Swimming - Sport Officer Notes

TeamSG's swimming contingent heads into Glasgow 2026 anchored by Ryan Tng, who arrives off the back of a personal-best season in the Men's 100m Freestyle. Coaches have flagged his back-half speed as the key differentiator against the Commonwealth's deeper sprint field this cycle.

Amanda Chen returns to the 200m Individual Medley after a breakout showing at the most recent SEA Games, having tightened her breaststroke-to-freestyle transition - historically her weakest split.

Watch for: relay depth remains a rebuilding area following the retirement of two senior mixed-relay anchors after Birmingham 2022.`,
  },
  {
    fileName: 'athletics.md',
    content: `# Athletics - Sport Officer Notes

Danielle Seah leads TeamSG's track contingent in the Women's 100m Hurdles, carrying the National Record into Glasgow after back-to-back sub-13-second clockings this season. Her start reaction time has been the focus of a technical adjustment made over the past 18 months.

The field events roster remains lean this cycle; no TeamSG qualifiers currently hold a top-8 world ranking in throws or jumps disciplines.

Watch for: the hurdles semifinal draw is expected to be highly competitive, with three Oceania-region rivals inside 0.1s of Seah's season best.`,
  },
  {
    fileName: 'badminton.md',
    content: `# Badminton - Sport Officer Notes

The Mixed Doubles pairing of Marcus Wee and Grace Lim enters Glasgow as one of TeamSG's strongest medal contenders, having climbed steadily in continental rankings since their pairing was formalized after Birmingham 2022.

Their game plan leans on Wee's front-court interception speed and Lim's rear-court smash accuracy, a combination that has troubled higher-seeded pairs in recent tune-up events.

Watch for: draw proximity to the top-seeded pair in the quarterfinal round, which could set up an early marquee match.`,
  },
  {
    fileName: 'table-tennis.md',
    content: `# Table Tennis - Sport Officer Notes

Wendy Ho carries TeamSG's singles hopes in Women's Singles, coming off a disciplined defensive-to-offensive transition retooled by the coaching staff over the past year.

Historically, TeamSG's table tennis program has been the most decorated Commonwealth Games discipline for Singapore, and expectations inside the camp remain high even as the roster undergoes generational transition.

Watch for: Ho's semifinal opponent, should she advance, will likely be a left-handed penhold stylist - a matchup she has historically found difficult.`,
  },
];

class MockExcelHistoricalAdapter extends ExcelHistoricalAdapter {
  constructor() {
    super(null, config.paths.historicalExcel, 'past_results.xlsx');
  }

  // eslint-disable-next-line class-methods-use-this
  async fetchRaw() {
    return HISTORICAL_MOCK_ROWS;
  }
}

class MockContingentAdapter extends ContingentSheetAdapter {
  // eslint-disable-next-line class-methods-use-this
  async fetchRaw() {
    return CONTINGENT_MOCK_ROWS;
  }
}

class MockScheduleAdapter extends ScheduleSheetAdapter {
  // eslint-disable-next-line class-methods-use-this
  async fetchRaw() {
    return SCHEDULE_MOCK_ROWS;
  }
}

class MockHighlightsAdapter extends HighlightsFolderAdapter {
  // eslint-disable-next-line class-methods-use-this
  async fetchRaw() {
    return HIGHLIGHT_MOCK_FILES.map((f) => ({ ...f, updatedAt: new Date().toISOString() }));
  }
}

module.exports = {
  MockExcelHistoricalAdapter,
  MockContingentAdapter,
  MockScheduleAdapter,
  MockHighlightsAdapter,
};
