(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TidelineEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // =========================================================================
  // 1. TUNABLE GAME & ECONOMY CONSTANTS (Edit these to tweak balance/events)
  // =========================================================================
  var GAME_CONFIG = {
    ROUNDS: 5,
    FLEET_SCHEDULE: [1, 2, 3, 5, 7],
    UNLOCKED_COUNTRIES_SCHEDULE: [2, 3, 5, 7, 7],
    STARTING_CASH: 2000000,
    SHIP_CAPACITY: 1000,
    ROUND_DURATION_SEC: 300,
    REVEAL_DURATION_SEC: 30,

    // Fixed & handling costs
    FIXED_OVERHEAD_PER_SHIP: 38000,
    MULTI_COMMODITY_BASE_FEE: 3000,
    MULTI_COMMODITY_STEP_FEE: 2800,

    // Ship & voyage physics
    BASELINE_SPEED_KNOTS: 14,
    FUEL_BASE_TONS_PER_DAY: 4.5,
    FUEL_SPEED_EXPONENT: 2.20,
    FUEL_PRICE_PER_TON_BASE: 510,
    CREW_COST_PER_DAY: 800,
    WEAR_COST_PER_DAY_BASE: 400,
    WEAR_SPEED_EXPONENT: 2.10,
    INSURANCE_BASE_RATE: 0.012,
    DELAY_PENALTY_PER_DAY: 0.016, // ~1.6-2% of revenue per day late
    BREAKDOWN_BASE_CHANCE: 0.020,
    BREAKDOWN_REPAIR_COST: 36000,
    BREAKDOWN_DELAY_DAYS: 2.0,
    HIGH_RISK_BLOCK_PROB: 0.25,

    // Market, sourcing, congestion & anti-snowball
    SOURCING_DEPTH_PER_PLAYER: 1800,
    SOURCING_PRESSURE_ALPHA: 0.30,
    CONGESTION_FREE_RATIO: 1.0,
    CONGESTION_DELAY_PER_SHIP: 0.45,
    CONGESTION_FEE_PER_SHIP: 4800,
    MARKET_SHARE_TAX_THRESHOLD: 0.40,
    MARKET_SHARE_TAX_RATE: 0.20,
    OVERSHOOT_FADE_FACTOR: 0.42,
    MEAN_REVERSION_RATE: 0.25,

    // Reputation
    REP_INIT: 0.50,
    REP_GAIN_ON_DELIVERY: 0.09,
    REP_DECAY_ON_NEGLECT: 0.04,
    REP_MAX: 1.0,
    REP_MIN: 0.15,

    // Forecast uncertainty error bands per uncertainty level (1..5)
    FORECAST_ERROR_BY_LEVEL: [0.06, 0.12, 0.19, 0.28, 0.38],

    // Rank thresholds (profit = finalCash - startingCash)
    RANKS: [
      { minProfit: -Infinity, title: 'Deckhand' },
      { minProfit: 350000, title: 'Mate' },
      { minProfit: 950000, title: 'Captain' },
      { minProfit: 1650000, title: 'Commodore' },
      { minProfit: 2350000, title: 'Admiral' }
    ]
  };

  // =========================================================================
  // 2. WORLD MODEL: PORTS, CHOKEPOINTS, COUNTRIES, COMMODITIES, ROUTES
  // =========================================================================
  var PORTS = {
    mumbai:       { id: 'mumbai',       name: 'Mumbai',         country: 'India (Home)', lon: 72.84,  lat: 18.95 },
    germany:      { id: 'germany',      name: 'Hamburg',        country: 'Germany',      lon: 9.97,   lat: 53.54 },
    uk:           { id: 'uk',           name: 'Southampton',    country: 'UK',           lon: -1.40,  lat: 50.90 },
    france:       { id: 'france',       name: 'Marseille',      country: 'France',       lon: 5.37,   lat: 43.30 },
    russia:       { id: 'russia',       name: 'St. Petersburg', country: 'Russia',       lon: 30.25,  lat: 59.90 },
    usa:          { id: 'usa',          name: 'New York',       country: 'USA',          lon: -74.04, lat: 40.68 },
    australia:    { id: 'australia',    name: 'Fremantle',      country: 'Australia',    lon: 115.74, lat: -32.05 },
    new_zealand:  { id: 'new_zealand',  name: 'Auckland',       country: 'New Zealand',  lon: 174.77, lat: -36.84 }
  };

  var CHOKEPOINTS = {
    bab_el_mandeb: { id: 'bab_el_mandeb', name: 'Bab-el-Mandeb',     lon: 43.4,  lat: 12.6,  tag: 'redsea' },
    suez:          { id: 'suez',          name: 'Suez Canal',        lon: 32.55, lat: 30.0,  tag: 'suez' },
    gibraltar:     { id: 'gibraltar',     name: 'Strait of Gibraltar', lon: -5.6, lat: 36.0, tag: 'med' },
    dover:         { id: 'dover',         name: 'Dover Strait',      lon: 1.5,   lat: 51.0,  tag: 'north-atlantic-storm' },
    danish:        { id: 'danish',        name: 'Danish Straits',    lon: 10.6,  lat: 57.7,  tag: 'baltic-sanctions' },
    cape:          { id: 'cape',          name: 'Cape of Good Hope', lon: 18.4,  lat: -34.8, tag: 'cape' },
    sunda:         { id: 'sunda',         name: 'Sunda Strait',      lon: 105.9, lat: -6.0,  tag: 'malacca-piracy' },
    lombok:        { id: 'lombok',        name: 'Lombok Strait',     lon: 115.7, lat: -8.8,  tag: 'malacca-piracy' }
  };

  var COUNTRIES = [
    {
      id: 'germany',
      name: 'Germany',
      portName: 'Hamburg',
      lon: 9.97,
      lat: 53.54,
      portFee: 19000,
      exchangeRate: 1.07,
      baseTariff: 0.03,
      demandDepthPerPlayer: 1050,
      demand: { crude_oil: 1.42, wheat: 0.96, fertilizer: 1.06, spices_tea: 0.98, textiles: 1.08, electronics: 1.24 }
    },
    {
      id: 'uk',
      name: 'UK',
      portName: 'Southampton',
      lon: -1.40,
      lat: 50.90,
      portFee: 18000,
      exchangeRate: 1.06,
      baseTariff: 0.03,
      demandDepthPerPlayer: 980,
      demand: { crude_oil: 1.00, wheat: 1.05, fertilizer: 0.90, spices_tea: 1.40, textiles: 1.32, electronics: 1.15 }
    },
    {
      id: 'france',
      name: 'France',
      portName: 'Marseille',
      lon: 5.37,
      lat: 43.30,
      portFee: 17000,
      exchangeRate: 1.03,
      baseTariff: 0.03,
      demandDepthPerPlayer: 950,
      demand: { crude_oil: 1.04, wheat: 1.08, fertilizer: 1.10, spices_tea: 1.36, textiles: 1.30, electronics: 1.02 }
    },
    {
      id: 'russia',
      name: 'Russia',
      portName: 'St. Petersburg',
      lon: 30.25,
      lat: 59.90,
      portFee: 17500,
      exchangeRate: 1.13, // pays a premium for distant/risky market
      baseTariff: 0.05,
      demandDepthPerPlayer: 920,
      demand: { crude_oil: 0.78, wheat: 1.34, fertilizer: 1.32, spices_tea: 1.18, textiles: 1.20, electronics: 1.52 }
    },
    {
      id: 'usa',
      name: 'USA',
      portName: 'New York',
      lon: -74.04,
      lat: 40.68,
      portFee: 21000,
      exchangeRate: 1.10,
      baseTariff: 0.04,
      demandDepthPerPlayer: 1220,
      demand: { crude_oil: 1.12, wheat: 0.94, fertilizer: 1.12, spices_tea: 1.10, textiles: 1.38, electronics: 1.44 }
    },
    {
      id: 'australia',
      name: 'Australia',
      portName: 'Fremantle',
      lon: 115.74,
      lat: -32.05,
      portFee: 17500,
      exchangeRate: 0.94,
      baseTariff: 0.02,
      demandDepthPerPlayer: 760,
      demand: { crude_oil: 1.34, wheat: 0.80, fertilizer: 1.08, spices_tea: 1.04, textiles: 1.28, electronics: 1.36 }
    },
    {
      id: 'new_zealand',
      name: 'New Zealand',
      portName: 'Auckland',
      lon: 174.77,
      lat: -36.84,
      portFee: 16500,
      exchangeRate: 0.97,
      baseTariff: 0.02,
      demandDepthPerPlayer: 680,
      demand: { crude_oil: 1.30, wheat: 0.84, fertilizer: 1.14, spices_tea: 1.06, textiles: 1.24, electronics: 1.38 }
    }
  ];

  var COMMODITIES = [
    {
      id: 'crude_oil',
      name: 'Crude Oil',
      shortName: 'Crude',
      unit: 'bbl eq.',
      baseBuyPrice: 350,
      baseSellPrice: 605,
      weightClass: 1.14,
      spoilagePerDay: 0.0004,
      volatility: 0.26,
      tariffSensitivity: 0.6,
      sanctionSensitivity: 0.5,
      elasticity: 0.65,
      color: '#1E293B',
      desc: 'Volatile energy benchmark; moves Fertilizer and Wheat costs.'
    },
    {
      id: 'wheat',
      name: 'Wheat',
      shortName: 'Wheat',
      unit: 'mt',
      baseBuyPrice: 270,
      baseSellPrice: 600,
      weightClass: 1.04,
      spoilagePerDay: 0.0018,
      volatility: 0.25,
      tariffSensitivity: 0.7,
      sanctionSensitivity: 0.3,
      elasticity: 0.62,
      color: '#D97706',
      desc: 'Volatile grain cargo; spoils on long voyages and spikes in crises.'
    },
    {
      id: 'fertilizer',
      name: 'Fertilizer',
      shortName: 'Fert.',
      unit: 'mt',
      baseBuyPrice: 300,
      baseSellPrice: 590,
      weightClass: 1.16,
      spoilagePerDay: 0.0010,
      volatility: 0.27,
      tariffSensitivity: 0.7,
      sanctionSensitivity: 0.6,
      elasticity: 0.64,
      color: '#15803D',
      desc: 'Heavy industrial input correlated with Crude Oil and agricultural shocks.'
    },
    {
      id: 'spices_tea',
      name: 'Spices & Tea',
      shortName: 'Spices',
      unit: 'crates',
      baseBuyPrice: 320,
      baseSellPrice: 615,
      weightClass: 0.86,
      spoilagePerDay: 0.0016,
      volatility: 0.11,
      tariffSensitivity: 0.5,
      sanctionSensitivity: 0.2,
      elasticity: 0.58,
      color: '#B45309',
      desc: 'Steady Mumbai specialty prized by UK and France; sensitive to transit time.'
    },
    {
      id: 'textiles',
      name: 'Textiles',
      shortName: 'Textiles',
      unit: 'bales',
      baseBuyPrice: 335,
      baseSellPrice: 600,
      weightClass: 0.90,
      spoilagePerDay: 0.0005,
      volatility: 0.11,
      tariffSensitivity: 1.45,
      sanctionSensitivity: 0.3,
      elasticity: 0.58,
      color: '#0F766E',
      desc: 'Consumer goods; steady margin until trade tariffs or demand waves hit.'
    },
    {
      id: 'electronics',
      name: 'Electronics',
      shortName: 'Tech',
      unit: 'pallets',
      baseBuyPrice: 410,
      baseSellPrice: 675,
      weightClass: 0.82,
      spoilagePerDay: 0.0003,
      volatility: 0.20,
      tariffSensitivity: 1.1,
      sanctionSensitivity: 1.8,
      elasticity: 0.66,
      color: '#1D4ED8',
      desc: 'High-value cargo with steep insurance and extreme sanction sensitivity.'
    }
  ];

  // Haversine distance in nautical miles
  function haversineNm(a, b) {
    var R_NM = 3440.065;
    var toRad = Math.PI / 180;
    var dLat = (b[1] - a[1]) * toRad;
    var dLon = (b[0] - a[0]) * toRad;
    var lat1 = a[1] * toRad;
    var lat2 = b[1] * toRad;
    var s1 = Math.sin(dLat / 2);
    var s2 = Math.sin(dLon / 2);
    var h = s1 * s1 + Math.cos(lat1) * Math.cos(lat2) * s2 * s2;
    return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function pathLengthNm(waypoints) {
    var sum = 0;
    for (var i = 1; i < waypoints.length; i++) {
      sum += haversineNm(waypoints[i - 1], waypoints[i]);
    }
    return Math.round(sum);
  }

  var P = {
    mumbai: [72.84, 18.95],
    hamburg: [9.97, 53.54],
    southampton: [-1.40, 50.90],
    marseille: [5.37, 43.30],
    stpetersburg: [30.25, 59.90],
    newyork: [-74.04, 40.68],
    fremantle: [115.74, -32.05],
    auckland: [174.77, -36.84]
  };

  // Water-only waypoints verified against Natural Earth 110m coastlines
  var WAYPOINTS = {
    france_suez:       [P.mumbai, [66.0, 15.0], [51.0, 12.2], [43.4, 12.6], [39.5, 19.0], [34.2, 26.8], [32.55, 30.0], [32.3, 31.8], [26.0, 34.0], [18.0, 35.0], [12.0, 36.8], [9.5, 38.8], [6.5, 41.2], P.marseille],
    uk_suez:           [P.mumbai, [66.0, 15.0], [51.0, 12.2], [43.4, 12.6], [39.5, 19.0], [34.2, 26.8], [32.55, 30.0], [32.3, 31.8], [26.0, 34.0], [18.0, 35.0], [11.5, 36.8], [2.0, 37.2], [-5.6, 36.0], [-10.0, 36.8], [-10.5, 44.0], [-5.8, 49.0], [-2.0, 50.2], P.southampton],
    germany_suez:      [P.mumbai, [66.0, 15.0], [51.0, 12.2], [43.4, 12.6], [39.5, 19.0], [34.2, 26.8], [32.55, 30.0], [32.3, 31.8], [26.0, 34.0], [18.0, 35.0], [11.5, 36.8], [2.0, 37.2], [-5.6, 36.0], [-10.0, 36.8], [-10.5, 44.0], [-5.8, 49.0], [1.5, 51.0], [5.5, 54.0], [8.2, 54.4], P.hamburg],
    russia_suez:       [P.mumbai, [66.0, 15.0], [51.0, 12.2], [43.4, 12.6], [39.5, 19.0], [34.2, 26.8], [32.55, 30.0], [32.3, 31.8], [26.0, 34.0], [18.0, 35.0], [11.5, 36.8], [2.0, 37.2], [-5.6, 36.0], [-10.0, 36.8], [-10.5, 44.0], [-5.8, 49.0], [1.5, 51.0], [6.5, 56.5], [10.6, 57.7], [11.0, 56.5], [11.0, 55.3], [13.5, 54.8], [19.0, 56.8], [22.5, 59.4], [27.0, 60.0], P.stpetersburg],
    usa_suez:          [P.mumbai, [66.0, 15.0], [51.0, 12.2], [43.4, 12.6], [39.5, 19.0], [34.2, 26.8], [32.55, 30.0], [32.3, 31.8], [26.0, 34.0], [18.0, 35.0], [11.5, 36.8], [2.0, 37.2], [-5.6, 36.0], [-11.0, 36.0], [-32.0, 35.0], [-58.0, 37.0], [-71.0, 39.5], P.newyork],

    france_cape:       [P.mumbai, [67.0, 8.0], [58.0, -10.0], [52.0, -25.0], [35.0, -34.5], [18.4, -34.8], [10.0, -25.0], [-5.0, -10.0], [-18.5, 12.0], [-15.0, 32.0], [-5.6, 35.9], [0.0, 36.6], [4.5, 40.5], P.marseille],
    uk_cape:           [P.mumbai, [67.0, 8.0], [58.0, -10.0], [52.0, -25.0], [35.0, -34.5], [18.4, -34.8], [10.0, -25.0], [-5.0, -10.0], [-18.5, 12.0], [-16.0, 32.0], [-11.0, 44.0], [-5.8, 49.0], [-2.0, 50.2], P.southampton],
    germany_cape:      [P.mumbai, [67.0, 8.0], [58.0, -10.0], [52.0, -25.0], [35.0, -34.5], [18.4, -34.8], [10.0, -25.0], [-5.0, -10.0], [-18.5, 12.0], [-16.0, 32.0], [-11.0, 44.0], [-5.8, 49.0], [1.5, 51.0], [5.5, 54.0], [8.2, 54.4], P.hamburg],
    russia_cape:       [P.mumbai, [67.0, 8.0], [58.0, -10.0], [52.0, -25.0], [35.0, -34.5], [18.4, -34.8], [10.0, -25.0], [-5.0, -10.0], [-18.5, 12.0], [-16.0, 32.0], [-11.0, 44.0], [-5.8, 49.0], [1.5, 51.0], [6.5, 56.5], [10.6, 57.7], [11.0, 56.5], [11.0, 55.3], [13.5, 54.8], [19.0, 56.8], [22.5, 59.4], [27.0, 60.0], P.stpetersburg],
    usa_cape:          [P.mumbai, [67.0, 8.0], [58.0, -10.0], [52.0, -25.0], [35.0, -34.5], [18.4, -34.8], [0.0, -20.0], [-25.0, 0.0], [-50.0, 20.0], [-68.0, 35.0], P.newyork],

    australia_direct:  [P.mumbai, [72.0, 10.0], [82.0, -5.0], [98.0, -20.0], [110.0, -29.0], P.fremantle],
    australia_sunda:   [P.mumbai, [72.5, 10.0], [80.0, 2.0], [92.0, 0.0], [101.0, -6.5], [104.5, -7.0], [105.9, -6.0], [106.5, -10.0], [110.5, -24.0], P.fremantle],

    nz_south:          [P.mumbai, [72.0, 10.0], [85.0, -10.0], [105.0, -33.0], [116.0, -37.5], [140.0, -40.0], [148.0, -44.5], [166.0, -39.0], [173.2, -33.8], [175.8, -36.0], P.auckland],
    nz_lombok:         [P.mumbai, [72.5, 10.0], [80.0, 2.0], [92.0, -2.0], [104.0, -8.5], [113.0, -9.8], [115.7, -8.8], [122.0, -11.5], [134.0, -10.0], [142.5, -10.2], [148.0, -14.0], [162.0, -23.0], [173.2, -33.8], [175.8, -36.0], P.auckland]
  };

  function makeSuezGroup(countryId, suezWp, capeWp, extraTags) {
    var suezDist = pathLengthNm(suezWp);
    var capeDist = pathLengthNm(capeWp);
    var suezTags = ['redsea', 'suez'].concat(extraTags || []);
    var capeTags = [].concat(extraTags || []);
    return [
      {
        id: countryId + '_suez_fast',
        countryId: countryId,
        stanceIndex: 0,
        stanceLabel: 'Fast & Risky',
        label: 'Suez Express',
        corridor: 'Via Suez & Red Sea',
        knots: 16.5,
        toll: 38000,
        basePiracy: 0.025,
        baseWeather: 0.015,
        waypoints: suezWp,
        distanceNm: suezDist,
        tags: suezTags,
        chokepoints: ['bab_el_mandeb', 'suez']
      },
      {
        id: countryId + '_suez_std',
        countryId: countryId,
        stanceIndex: 1,
        stanceLabel: 'Balanced',
        label: 'Suez Steady',
        corridor: 'Via Suez (14 kn)',
        knots: 14.0,
        toll: 38000,
        basePiracy: 0.018,
        baseWeather: 0.012,
        waypoints: suezWp,
        distanceNm: suezDist,
        tags: suezTags,
        chokepoints: ['bab_el_mandeb', 'suez']
      },
      {
        id: countryId + '_cape_safe',
        countryId: countryId,
        stanceIndex: 2,
        stanceLabel: 'Slow & Safe',
        label: 'Cape of Good Hope',
        corridor: 'Via Cape (No Canal)',
        knots: 13.5,
        toll: 0,
        basePiracy: 0.004,
        baseWeather: 0.022,
        waypoints: capeWp,
        distanceNm: capeDist,
        tags: capeTags,
        chokepoints: []
      }
    ];
  }

  var ROUTES_BY_COUNTRY = {
    france: makeSuezGroup('france', WAYPOINTS.france_suez, WAYPOINTS.france_cape, []),
    uk: makeSuezGroup('uk', WAYPOINTS.uk_suez, WAYPOINTS.uk_cape, ['north-atlantic-storm']),
    germany: makeSuezGroup('germany', WAYPOINTS.germany_suez, WAYPOINTS.germany_cape, ['north-atlantic-storm']),
    russia: makeSuezGroup('russia', WAYPOINTS.russia_suez, WAYPOINTS.russia_cape, ['north-atlantic-storm', 'baltic-sanctions']),
    usa: makeSuezGroup('usa', WAYPOINTS.usa_suez, WAYPOINTS.usa_cape, ['north-atlantic-storm']),
    australia: [
      {
        id: 'australia_direct_fast',
        countryId: 'australia',
        stanceIndex: 0,
        stanceLabel: 'Fast & Risky',
        label: 'Direct Indian Ocean',
        corridor: 'Open Ocean (16.5 kn)',
        knots: 16.5,
        toll: 0,
        basePiracy: 0.006,
        baseWeather: 0.028,
        waypoints: WAYPOINTS.australia_direct,
        distanceNm: pathLengthNm(WAYPOINTS.australia_direct),
        tags: ['indian-cyclone'],
        chokepoints: []
      },
      {
        id: 'australia_direct_std',
        countryId: 'australia',
        stanceIndex: 1,
        stanceLabel: 'Balanced',
        label: 'Direct Indian Ocean',
        corridor: 'Open Ocean (14 kn)',
        knots: 14.0,
        toll: 0,
        basePiracy: 0.005,
        baseWeather: 0.020,
        waypoints: WAYPOINTS.australia_direct,
        distanceNm: pathLengthNm(WAYPOINTS.australia_direct),
        tags: ['indian-cyclone'],
        chokepoints: []
      },
      {
        id: 'australia_sunda_safe',
        countryId: 'australia',
        stanceIndex: 2,
        stanceLabel: 'Slow & Safe',
        label: 'Via Sunda Strait',
        corridor: 'Sheltered Strait (13.5 kn)',
        knots: 13.5,
        toll: 5000,
        basePiracy: 0.015,
        baseWeather: 0.008,
        waypoints: WAYPOINTS.australia_sunda,
        distanceNm: pathLengthNm(WAYPOINTS.australia_sunda),
        tags: ['malacca-piracy'],
        chokepoints: ['sunda']
      }
    ],
    new_zealand: [
      {
        id: 'nz_south_fast',
        countryId: 'new_zealand',
        stanceIndex: 0,
        stanceLabel: 'Fast & Risky',
        label: 'South of Australia',
        corridor: 'Southern Ocean (16.5 kn)',
        knots: 16.5,
        toll: 0,
        basePiracy: 0.004,
        baseWeather: 0.032,
        waypoints: WAYPOINTS.nz_south,
        distanceNm: pathLengthNm(WAYPOINTS.nz_south),
        tags: ['indian-cyclone'],
        chokepoints: []
      },
      {
        id: 'nz_south_std',
        countryId: 'new_zealand',
        stanceIndex: 1,
        stanceLabel: 'Balanced',
        label: 'South of Australia',
        corridor: 'Southern Ocean (14 kn)',
        knots: 14.0,
        toll: 0,
        basePiracy: 0.004,
        baseWeather: 0.022,
        waypoints: WAYPOINTS.nz_south,
        distanceNm: pathLengthNm(WAYPOINTS.nz_south),
        tags: ['indian-cyclone'],
        chokepoints: []
      },
      {
        id: 'nz_lombok_safe',
        countryId: 'new_zealand',
        stanceIndex: 2,
        stanceLabel: 'Slow & Safe',
        label: 'Lombok & Coral Sea',
        corridor: 'Northern Passage (13.5 kn)',
        knots: 13.5,
        toll: 6000,
        basePiracy: 0.014,
        baseWeather: 0.010,
        waypoints: WAYPOINTS.nz_lombok,
        distanceNm: pathLengthNm(WAYPOINTS.nz_lombok),
        tags: ['malacca-piracy'],
        chokepoints: ['lombok']
      }
    ]
  };

  // Add destination chokepoints for northern Europe
  ROUTES_BY_COUNTRY.uk.forEach(function (r) { r.chokepoints = r.chokepoints.concat(['dover']); });
  ROUTES_BY_COUNTRY.germany.forEach(function (r) { r.chokepoints = r.chokepoints.concat(['dover']); });
  ROUTES_BY_COUNTRY.russia.forEach(function (r) { r.chokepoints = r.chokepoints.concat(['dover', 'danish']); });

  // =========================================================================
  // 3. SEEDED PRNG (mulberry32) & DETERMINISTIC HELPERS
  // =========================================================================
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashString(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function clamp(val, min, max) {
    return val < min ? min : val > max ? max : val;
  }

  // Largest-remainder rounding from percentages [0..100] summing to 100 -> whole ships summing to fleetSize
  function allocateShipsFromPct(countryPct, fleetSize) {
    var ids = COUNTRIES.map(function (c) { return c.id; });
    var raw = ids.map(function (id) {
      var pct = Number(countryPct[id]) || 0;
      var exact = (pct / 100) * fleetSize;
      return {
        id: id,
        floor: Math.floor(exact),
        rem: exact - Math.floor(exact),
        pct: pct
      };
    });
    var assigned = 0;
    for (var i = 0; i < raw.length; i++) assigned += raw[i].floor;
    var remaining = fleetSize - assigned;
    raw.sort(function (a, b) {
      if (b.rem !== a.rem) return b.rem - a.rem;
      if (b.pct !== a.pct) return b.pct - a.pct;
      return a.id < b.id ? -1 : 1;
    });
    for (var j = 0; j < remaining; j++) {
      raw[j].floor += 1;
    }
    var out = {};
    for (var k = 0; k < raw.length; k++) {
      out[raw[k].id] = raw[k].floor;
    }
    return out;
  }

  // =========================================================================
  // 4. ESCALATING EVENTS & CONTRACTS GENERATOR
  // =========================================================================
  function getCountryById(id) {
    for (var i = 0; i < COUNTRIES.length; i++) {
      if (COUNTRIES[i].id === id) return COUNTRIES[i];
    }
    return null;
  }

  function getCommodityById(id) {
    for (var i = 0; i < COMMODITIES.length; i++) {
      if (COMMODITIES[i].id === id) return COMMODITIES[i];
    }
    return null;
  }

  var SURPRISE_POOL = [
    {
      id: 'surprise_port_backlog',
      title: 'Container Yard Bottleneck',
      desc: 'Unexpected customs backlog slows arrivals in Northern Europe (+2.2 days, +$14k port fee).',
      targetType: 'routeTag',
      target: 'north-atlantic-storm',
      delayDays: 2.2,
      feeAdd: 14000,
      severity: 'warn'
    },
    {
      id: 'surprise_spice_festival',
      title: 'European Culinary Boom',
      desc: 'Sudden spike in European demand surges Spices & Tea prices by +24%.',
      targetType: 'commodity',
      target: 'spices_tea',
      priceMult: 1.24,
      severity: 'good'
    },
    {
      id: 'surprise_cyber_port',
      title: 'Maritime Terminal Outage',
      desc: 'Automated cranes stall in USA and UK (+2.0 days delay, +$12k handling).',
      targetType: 'countries',
      target: ['usa', 'uk'],
      delayDays: 2.0,
      feeAdd: 12000,
      severity: 'warn'
    },
    {
      id: 'surprise_fert_subsidy',
      title: 'Southern Hemisphere Planting Drive',
      desc: 'Emergency agricultural subsidies lift Fertilizer demand in Australia & NZ (+28%).',
      targetType: 'countryCommodity',
      countries: ['australia', 'new_zealand'],
      commodity: 'fertilizer',
      demandMult: 1.28,
      severity: 'good'
    },
    {
      id: 'surprise_bunker_squeeze',
      title: 'Bunker Fuel Refinery Fire',
      desc: 'Marine fuel costs jump +24% mid-voyage across all routes.',
      targetType: 'global',
      fuelMult: 1.24,
      severity: 'bad'
    },
    {
      id: 'surprise_piracy_skiff',
      title: 'Strait Escort Alert',
      desc: 'Increased piracy patrol costs add +$16k insurance along Malacca/Sunda/Lombok.',
      targetType: 'routeTag',
      target: 'malacca-piracy',
      feeAdd: 16000,
      piracyAdd: 0.03,
      severity: 'warn'
    },
    {
      id: 'surprise_oil_glut',
      title: 'Strategic Reserve Release',
      desc: 'Sudden emergency oil release drops global Crude Oil prices by -20%.',
      targetType: 'commodity',
      target: 'crude_oil',
      priceMult: 0.80,
      severity: 'bad'
    },
    {
      id: 'surprise_oil_embargo',
      title: 'Refinery & Tanker Bottleneck',
      desc: 'Sudden supply squeeze surges global Crude Oil prices by +26%.',
      targetType: 'commodity',
      target: 'crude_oil',
      priceMult: 1.26,
      severity: 'good'
    },
    {
      id: 'surprise_chip_shortage',
      title: 'Semiconductor Fab Outage',
      desc: 'Power outage at wafer fabs spikes global Electronics prices by +28%.',
      targetType: 'commodity',
      target: 'electronics',
      priceMult: 1.28,
      severity: 'good'
    },
    {
      id: 'surprise_grain_bumper',
      title: 'Surprise Bumper Harvest',
      desc: 'Record grain yields push global Wheat down -16% and Fertilizer down -10%.',
      targetType: 'commodities',
      commodities: { wheat: 0.84, fertilizer: 0.90 },
      severity: 'warn'
    },
    {
      id: 'surprise_textile_surge',
      title: 'Retail Apparel Restock Wave',
      desc: 'Department stores rush-order Textiles in USA, UK & France (+26% demand).',
      targetType: 'countryCommodity',
      countries: ['usa', 'uk', 'france'],
      commodity: 'textiles',
      demandMult: 1.26,
      severity: 'good'
    },
    {
      id: 'surprise_fert_crunch',
      title: 'Ammonia Plant Shutdown',
      desc: 'Gas feedstock crunch spikes global Fertilizer prices by +30%.',
      targetType: 'commodity',
      target: 'fertilizer',
      priceMult: 1.30,
      severity: 'good'
    },
    {
      id: 'surprise_canal_fog',
      title: 'Suez & Red Sea Convoy Pileup',
      desc: 'Heavy fog and naval escort checks add +2.4 days and +$16k fee on Suez lanes.',
      targetType: 'routeTag',
      target: 'suez',
      delayDays: 2.4,
      feeAdd: 16000,
      severity: 'warn'
    },
    {
      id: 'surprise_tech_pullback',
      title: 'European Tech Slump',
      desc: 'Cooling hardware orders cut Electronics demand -22% in Germany & UK.',
      targetType: 'countryCommodity',
      countries: ['germany', 'uk'],
      commodity: 'electronics',
      demandMult: 0.78,
      severity: 'bad'
    },
    {
      id: 'surprise_trade_winds',
      title: 'Favorable Monsoon Tailwinds',
      desc: 'Strong tailwinds trim global fuel burn by -14% and lift Wheat +15%.',
      targetType: 'global',
      fuelMult: 0.86,
      commodities: { wheat: 1.15 },
      severity: 'good'
    }
  ];

  function generateRoundBriefing(round, seed, priceState, unlockedCountries) {
    var rng = mulberry32(seed ^ (round * 2654435761));
    var uncertainty = round; // 1 to 5
    var events = [];
    var surprises = [];
    var closedTags = [];
    var unlocked = (unlockedCountries && unlockedCountries.length)
      ? unlockedCountries.slice()
      : COUNTRIES.map(function (c) { return c.id; });

    if (round === 1) {
      events.push({
        id: 'r1_calm',
        title: 'Fair Monsoon Winds',
        desc: 'Global sea lanes are open. Minor bunker fuel drift (+4%) is the only baseline headwind.',
        probability: 1.0,
        guaranteed: true,
        severity: 'calm',
        effects: { fuelMult: 1.04 }
      });
      events.push({
        id: 'r1_high_risk_blockade',
        title: 'High-Risk Express Blockade Alert',
        desc: 'Fast & Risky lanes carry a 25% risk of sudden blockade (forced safe detour +2.2d, +$18k). Slow & Safe routes are NEVER blocked.',
        probability: GAME_CONFIG.HIGH_RISK_BLOCK_PROB,
        guaranteed: false,
        severity: 'bad',
        effects: { blockHighRisk: true, diversionDelay: 2.2, diversionFee: 18000 }
      });
      var r1s = pickSurprise(rng, []);
      surprises.push(r1s);
    } else if (round === 2) {
      events.push({
        id: 'r2_redsea_piracy',
        title: 'Red Sea Piracy Surge',
        desc: 'War-risk insurance rises sharply (+2.4% cargo value) and escort delays (+1.2d) hit Suez & Red Sea transits.',
        probability: 1.0,
        guaranteed: true,
        severity: 'warn',
        targetTag: 'redsea',
        hotspot: { lon: 43.4, lat: 12.6, label: 'Red Sea Piracy' },
        effects: { tag: 'redsea', insuranceAdd: 0.024, piracyAdd: 0.035, delayDays: 1.2 }
      });
      events.push({
        id: 'r2_wheat_tight',
        title: 'Black Sea Harvest Shortfall',
        desc: 'Global Wheat prices climb +16% on tighter export forecasts.',
        probability: 1.0,
        guaranteed: true,
        severity: 'good',
        targetCommodity: 'wheat',
        effects: { commodity: 'wheat', priceMult: 1.16 }
      });
      events.push({
        id: 'r2_high_risk_blockade',
        title: 'High-Risk Express Blockade Alert',
        desc: 'Fast & Risky corridors face a 25% chance of emergency blockade (diverts to safe route +2.2d, +$18k). Slow & Safe routes are NEVER blocked.',
        probability: GAME_CONFIG.HIGH_RISK_BLOCK_PROB,
        guaranteed: false,
        severity: 'bad',
        effects: { blockHighRisk: true, diversionDelay: 2.2, diversionFee: 18000 }
      });
      events.push({
        id: 'r2_suez_congestion',
        title: 'Suez Convoy Toll Hike',
        desc: 'Canal authority may impose a +$18k emergency transit surcharge.',
        probability: 0.60,
        guaranteed: false,
        severity: 'warn',
        targetTag: 'suez',
        hotspot: { lon: 32.55, lat: 30.0, label: 'Suez Surcharge Risk' },
        effects: { tag: 'suez', tollAdd: 18000 }
      });
      var r2s1 = pickSurprise(rng, []);
      surprises.push(r2s1);
      if (rng() < 0.6) surprises.push(pickSurprise(rng, [r2s1.id]));
    } else if (round === 3) {
      events.push({
        id: 'r3_russia_sanctions',
        title: 'Baltic Electronics Sanctions',
        desc: 'New sanctions BAN Electronics to Russia (100% confiscation + $95k fine per ship!). Other Russia cargo incurs +$18k inspection fee.',
        probability: 1.0,
        guaranteed: true,
        severity: 'bad',
        targetCountry: 'russia',
        hotspot: { lon: 22.0, lat: 59.0, label: 'Russia Sanctions' },
        effects: { country: 'russia', bannedCommodity: 'electronics', finePerShip: 95000, feeAdd: 18000 }
      });
      events.push({
        id: 'r3_fuel_spike',
        title: 'OPEC+ Output Cut',
        desc: 'Marine fuel jumps +22% and Crude Oil rallies +18%.',
        probability: 1.0,
        guaranteed: true,
        severity: 'warn',
        targetCommodity: 'crude_oil',
        effects: { fuelMult: 1.22, commodity: 'crude_oil', priceMult: 1.18 }
      });
      events.push({
        id: 'r3_high_risk_blockade',
        title: 'High-Risk Express Blockade Alert',
        desc: 'Fast & Risky lanes carry a 25% risk of being blocked off mid-voyage (forced safe detour +2.2d, +$18k). Slow & Safe lanes are NEVER blocked.',
        probability: GAME_CONFIG.HIGH_RISK_BLOCK_PROB,
        guaranteed: false,
        severity: 'bad',
        effects: { blockHighRisk: true, diversionDelay: 2.2, diversionFee: 18000 }
      });
      events.push({
        id: 'r3_hamburg_strike',
        title: 'Hamburg Dockers Strike',
        desc: 'Potential port walkout in Germany adds +3.0 days delay and +$16k demurrage.',
        probability: 0.65,
        guaranteed: false,
        severity: 'warn',
        targetCountry: 'germany',
        hotspot: { lon: 9.97, lat: 53.54, label: 'Hamburg Strike (65%)' },
        effects: { country: 'germany', delayDays: 3.0, feeAdd: 16000 }
      });
      var r3s1 = pickSurprise(rng, []);
      var r3s2 = pickSurprise(rng, [r3s1.id]);
      surprises.push(r3s1, r3s2);
    } else if (round === 4) {
      closedTags.push('suez');
      events.push({
        id: 'r4_suez_closed',
        title: 'Suez Canal Blockage — CLOSED',
        desc: 'A grounded mega-container vessel blocks the Suez Canal. All Suez routes are CLOSED this round; use Cape of Good Hope.',
        probability: 1.0,
        guaranteed: true,
        severity: 'bad',
        targetTag: 'suez',
        closedTag: 'suez',
        hotspot: { lon: 32.55, lat: 30.0, label: 'SUEZ CLOSED' },
        effects: { closeTag: 'suez' }
      });
      events.push({
        id: 'r4_us_tariff',
        title: 'US Textile Tariff +25%',
        desc: 'New 25% import tariff hits Textiles bound for New York.',
        probability: 1.0,
        guaranteed: true,
        severity: 'warn',
        targetCountry: 'usa',
        targetCommodity: 'textiles',
        hotspot: { lon: -74.04, lat: 40.68, label: 'US +25% Textile Tariff' },
        effects: { country: 'usa', commodity: 'textiles', tariffAdd: 0.25 }
      });
      events.push({
        id: 'r4_high_risk_blockade',
        title: 'High-Risk Express Blockade Alert',
        desc: 'Open Fast & Risky lanes carry a 25% chance of sudden blockage (diverts to safe route +2.2d, +$18k). Slow & Safe routes are NEVER blocked.',
        probability: GAME_CONFIG.HIGH_RISK_BLOCK_PROB,
        guaranteed: false,
        severity: 'bad',
        effects: { blockHighRisk: true, diversionDelay: 2.2, diversionFee: 18000 }
      });
      events.push({
        id: 'r4_indian_cyclone',
        title: 'Indian Ocean Cyclone',
        desc: 'Severe cyclone tracks across direct routes to Australia & southern NZ (+2.8d delay, storm damage risk).',
        probability: 0.70,
        guaranteed: false,
        severity: 'bad',
        targetTag: 'indian-cyclone',
        hotspot: { lon: 92.0, lat: -18.0, label: 'Indian Cyclone (70%)' },
        effects: { tag: 'indian-cyclone', delayDays: 2.8, weatherAdd: 0.055, repairCost: 32000 }
      });
      var s1 = pickSurprise(rng, []);
      var s2 = pickSurprise(rng, [s1.id]);
      surprises.push(s1, s2);
      if (rng() > 0.5) surprises.push(pickSurprise(rng, [s1.id, s2.id]));
    } else if (round === 5) {
      closedTags.push('redsea');
      closedTags.push('suez');
      events.push({
        id: 'r5_redsea_closed',
        title: 'Red Sea & Suez — CLOSED',
        desc: 'Naval blockade closes Bab-el-Mandeb and Suez. All Europe/Russia/USA ships must sail around the Cape.',
        probability: 1.0,
        guaranteed: true,
        severity: 'bad',
        targetTag: 'redsea',
        closedTag: 'redsea',
        hotspot: { lon: 43.4, lat: 12.6, label: 'RED SEA CLOSED' },
        effects: { closeTag: 'redsea' }
      });
      events.push({
        id: 'r5_agri_spike',
        title: 'Global Grain & Fertilizer Spike',
        desc: 'Panic stockpiling surges Wheat +32% and Fertilizer +34% globally.',
        probability: 1.0,
        guaranteed: true,
        severity: 'good',
        effects: { commodities: { wheat: 1.32, fertilizer: 1.34 } }
      });
      events.push({
        id: 'r5_high_risk_blockade',
        title: 'High-Risk Express Blockade Alert',
        desc: 'Remaining Fast & Risky lanes carry a 25% chance of sudden blockade (diverts to safe route +2.2d, +$18k). Slow & Safe lanes are NEVER blocked.',
        probability: GAME_CONFIG.HIGH_RISK_BLOCK_PROB,
        guaranteed: false,
        severity: 'bad',
        effects: { blockHighRisk: true, diversionDelay: 2.2, diversionFee: 18000 }
      });
      events.push({
        id: 'r5_perfect_storm',
        title: 'North Atlantic Bomb Cyclone & Fuel +40%',
        desc: 'Bunker fuel jumps +40%. North Atlantic storms threaten UK, Germany, Russia & USA routes (+2.5d, storm damage risk).',
        probability: 0.75,
        guaranteed: false,
        severity: 'bad',
        targetTag: 'north-atlantic-storm',
        hotspot: { lon: -25.0, lat: 47.0, label: 'N. Atlantic Storm (75%)' },
        effects: { tag: 'north-atlantic-storm', fuelMult: 1.40, delayDays: 2.5, weatherAdd: 0.05 }
      });
      events.push({
        id: 'r5_trade_war',
        title: 'Global Trade War Escalation',
        desc: 'Retaliatory tariffs (+14%) hit Textiles & Electronics; Russia Electronics sanctions remain strictly enforced.',
        probability: 1.0,
        guaranteed: true,
        severity: 'warn',
        effects: { country: 'russia', bannedCommodity: 'electronics', finePerShip: 100000, globalTariffAdd: { textiles: 0.14, electronics: 0.14 } }
      });
      var p1 = pickSurprise(rng, []);
      var p2 = pickSurprise(rng, [p1.id]);
      var p3 = pickSurprise(rng, [p1.id, p2.id]);
      surprises.push(p1, p2, p3);
    }

    // Special contracts (1-2 per round, always targeting unlocked countries)
    var contracts = generateContracts(round, rng, closedTags, unlocked);

    return {
      round: round,
      uncertainty: uncertainty,
      events: events,
      surprises: surprises,
      closedTags: closedTags,
      unlockedCountries: unlocked,
      contracts: contracts
    };
  }

  function pickSurprise(rng, excludeIds) {
    var pool = SURPRISE_POOL.filter(function (s) { return excludeIds.indexOf(s.id) === -1; });
    var idx = Math.floor(rng() * pool.length);
    return Object.assign({}, pool[idx]);
  }

  function generateContracts(round, rng, closedTags, unlockedCountries) {
    var specs = [
      { countryId: 'germany', commodityId: 'crude_oil', targetUnits: 1200, bonusPool: 165000 },
      { countryId: 'uk', commodityId: 'spices_tea', targetUnits: 1000, bonusPool: 145000 },
      { countryId: 'usa', commodityId: 'electronics', targetUnits: 1200, bonusPool: 180000 },
      { countryId: 'france', commodityId: 'textiles', targetUnits: 1000, bonusPool: 140000 },
      { countryId: 'australia', commodityId: 'crude_oil', targetUnits: 900, bonusPool: 135000 },
      { countryId: 'new_zealand', commodityId: 'fertilizer', targetUnits: 850, bonusPool: 130000 },
      { countryId: 'russia', commodityId: 'wheat', targetUnits: 1100, bonusPool: 155000 }
    ];
    if (unlockedCountries && unlockedCountries.length) {
      var filtered = specs.filter(function (s) { return unlockedCountries.indexOf(s.countryId) !== -1; });
      if (filtered.length > 0) specs = filtered;
    }
    // Avoid banned Russia electronics; all listed above are legal
    var i1 = Math.floor(rng() * specs.length);
    var i2 = specs.length > 1 ? (i1 + 1 + Math.floor(rng() * (specs.length - 1))) % specs.length : i1;
    var scale = 1 + (round - 1) * 0.25;
    var picked = (round >= 3 && specs.length > 1) ? [specs[i1], specs[i2]] : [specs[i1]];
    return picked.map(function (c, idx) {
      var co = getCountryById(c.countryId);
      var cm = getCommodityById(c.commodityId);
      var units = Math.round((c.targetUnits * scale) / 50) * 50;
      var bonus = Math.round((c.bonusPool * (1 + (round - 1) * 0.15)) / 5000) * 5000;
      return {
        id: 'contract_r' + round + '_' + idx,
        countryId: c.countryId,
        commodityId: c.commodityId,
        targetUnits: units,
        bonusPool: bonus,
        label: co.name + ' needs ' + units.toLocaleString() + ' ' + cm.name + ' ($' + Math.round(bonus / 1000) + 'k bonus pool)'
      };
    });
  }

  function buildCountryUnlockOrder(matchSeed) {
    var order = COUNTRIES.map(function (c) { return c.id; });
    var rng = mulberry32((matchSeed ^ 0x9E3779B9) >>> 0);
    for (var i = order.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var tmp = order[i];
      order[i] = order[j];
      order[j] = tmp;
    }
    return order;
  }

  function getUnlockedCountryIds(countryUnlockOrder, round) {
    var order = (countryUnlockOrder && countryUnlockOrder.length)
      ? countryUnlockOrder
      : COUNTRIES.map(function (c) { return c.id; });
    var rIdx = clamp((Number(round) || 1) - 1, 0, GAME_CONFIG.UNLOCKED_COUNTRIES_SCHEDULE.length - 1);
    var count = GAME_CONFIG.UNLOCKED_COUNTRIES_SCHEDULE[rIdx];
    return order.slice(0, count);
  }

  function getNewlyUnlockedCountryIds(countryUnlockOrder, round) {
    var r = Number(round) || 1;
    var cur = getUnlockedCountryIds(countryUnlockOrder, r);
    if (r <= 1) return cur;
    var prev = getUnlockedCountryIds(countryUnlockOrder, r - 1);
    return cur.filter(function (id) { return prev.indexOf(id) === -1; });
  }

  // =========================================================================
  // 5. MATCH INITIALIZATION & PRICE EVOLUTION
  // =========================================================================
  function createMatchState(playersConfig, seed) {
    var matchSeed = (seed != null ? seed : Math.floor(Math.random() * 0x7fffffff)) >>> 0;
    var priceIndex = {};
    var priceHistory = {};
    var lastSpike = {};
    COMMODITIES.forEach(function (c) {
      priceIndex[c.id] = 1.0;
      priceHistory[c.id] = [1.0];
      lastSpike[c.id] = 0;
    });

    var demandDrift = {};
    COUNTRIES.forEach(function (co) {
      demandDrift[co.id] = {};
      COMMODITIES.forEach(function (cm) {
        demandDrift[co.id][cm.id] = 1.0;
      });
    });

    var players = playersConfig.map(function (p, idx) {
      var rep = {};
      COUNTRIES.forEach(function (co) { rep[co.id] = GAME_CONFIG.REP_INIT; });
      return {
        id: p.id || ('p' + idx),
        name: p.name || ('Captain ' + (idx + 1)),
        color: p.color || '#13A89E',
        isBot: !!p.isBot,
        botStyle: p.botStyle || 'Adaptive',
        cash: GAME_CONFIG.STARTING_CASH,
        prevCash: GAME_CONFIG.STARTING_CASH,
        rank: idx + 1,
        prevRank: idx + 1,
        worstRoundLoss: 0,
        reputation: rep,
        roundProfits: [],
        lastPlan: null
      };
    });

    var countryUnlockOrder = buildCountryUnlockOrder(matchSeed);
    var unlockedR1 = getUnlockedCountryIds(countryUnlockOrder, 1);

    var state = {
      seed: matchSeed,
      round: 1,
      countryUnlockOrder: countryUnlockOrder,
      priceIndex: priceIndex,
      priceHistory: priceHistory,
      lastSpike: lastSpike,
      demandDrift: demandDrift,
      players: players,
      briefing: null,
      history: []
    };
    state.briefing = generateRoundBriefing(1, matchSeed, state.priceIndex, unlockedR1);
    state.briefing.newlyUnlockedCountries = unlockedR1.slice();
    return state;
  }

  function evolveMarketPrices(state, roundRng, rolledEvents, surprises) {
    // Random walk with mean reversion + lagged overshoot fade
    var nextIndex = {};
    var shocks = {};
    COMMODITIES.forEach(function (c) { shocks[c.id] = 0; });

    // Apply correlated macro shocks from events AND top-level surprise fields
    var allActive = rolledEvents.concat(surprises || []);
    allActive.forEach(function (ev) {
      if (!ev) return;
      var ef = ev.effects || {};
      if (ef.commodity && ef.priceMult) {
        shocks[ef.commodity] += (ef.priceMult - 1.0);
      }
      if (ev.targetType === 'commodity' && ev.target && ev.priceMult && shocks[ev.target] != null) {
        shocks[ev.target] += (ev.priceMult - 1.0);
      }
      if (ef.commodities) {
        Object.keys(ef.commodities).forEach(function (cid) {
          if (shocks[cid] != null) shocks[cid] += (ef.commodities[cid] - 1.0);
        });
      }
      if (ev.commodities) {
        Object.keys(ev.commodities).forEach(function (cid) {
          if (shocks[cid] != null) shocks[cid] += (ev.commodities[cid] - 1.0);
        });
      }
    });

    // Correlated moves: crude_oil moves fertilizer (0.45) and wheat (0.28)
    shocks.fertilizer += shocks.crude_oil * 0.45;
    shocks.wheat += shocks.crude_oil * 0.28;

    COMMODITIES.forEach(function (c) {
      var cur = state.priceIndex[c.id];
      var reversion = (1.0 - cur) * GAME_CONFIG.MEAN_REVERSION_RATE;
      var fade = -(state.lastSpike[c.id] || 0) * GAME_CONFIG.OVERSHOOT_FADE_FACTOR;
      var noise = (roundRng() * 2 - 1) * c.volatility;
      var delta = reversion + fade + noise + shocks[c.id];
      var updated = clamp(cur * (1 + delta), 0.55, 2.05);
      state.lastSpike[c.id] = (updated / cur) - 1.0;
      nextIndex[c.id] = updated;
      state.priceHistory[c.id].push(Math.round(updated * 1000) / 1000);
    });

    // Correlated post-update: oil drift nudges fertilizer & wheat slightly
    var oilDelta = (nextIndex.crude_oil - state.priceIndex.crude_oil);
    nextIndex.fertilizer = clamp(nextIndex.fertilizer + oilDelta * 0.20, 0.55, 2.05);
    nextIndex.wheat = clamp(nextIndex.wheat + oilDelta * 0.12, 0.55, 2.05);
    state.priceIndex = nextIndex;

    // Round-to-round country demand drift (higher volatility)
    COUNTRIES.forEach(function (co) {
      COMMODITIES.forEach(function (cm) {
        var curD = state.demandDrift[co.id][cm.id];
        var d = curD + (1.0 - curD) * 0.26 + (roundRng() * 2 - 1) * 0.13;
        state.demandDrift[co.id][cm.id] = clamp(d, 0.72, 1.35);
      });
    });
  }

  // =========================================================================
  // 6. PLAN NORMALIZATION & VALIDATION
  // =========================================================================
  function createDefaultPlan(closedTags, unlockedCountries) {
    var countryPct;
    if (unlockedCountries && unlockedCountries.length) {
      countryPct = {};
      COUNTRIES.forEach(function (c) { countryPct[c.id] = 0; });
      if (unlockedCountries.length <= 2) {
        countryPct[unlockedCountries[0]] = 100;
      } else if (unlockedCountries.length === 3) {
        countryPct[unlockedCountries[0]] = 50;
        countryPct[unlockedCountries[1]] = 50;
      } else if (unlockedCountries.length === 5) {
        countryPct[unlockedCountries[0]] = 34;
        countryPct[unlockedCountries[1]] = 33;
        countryPct[unlockedCountries[2]] = 33;
      } else {
        var rawU = {};
        unlockedCountries.forEach(function (id) { rawU[id] = 100 / unlockedCountries.length; });
        var normU = normalizePercentages(rawU, unlockedCountries);
        unlockedCountries.forEach(function (id) { countryPct[id] = normU[id]; });
      }
    } else {
      countryPct = { germany: 20, uk: 15, france: 15, russia: 10, usa: 20, australia: 10, new_zealand: 10 };
    }
    var commodityPct = { crude_oil: 20, wheat: 15, fertilizer: 15, spices_tea: 20, textiles: 15, electronics: 15 };
    var routeStance = {};
    COUNTRIES.forEach(function (c) {
      routeStance[c.id] = sanitizeRouteStance(c.id, 1, closedTags || []);
    });
    return { countryPct: countryPct, commodityPct: commodityPct, routeStance: routeStance };
  }

  function createEmptyPlan() {
    var countryPct = {};
    COUNTRIES.forEach(function (c) { countryPct[c.id] = 0; });
    var commodityPct = {};
    COMMODITIES.forEach(function (c) { commodityPct[c.id] = 0; });
    var routeStance = {};
    COUNTRIES.forEach(function (c) { routeStance[c.id] = null; });
    return { countryPct: countryPct, commodityPct: commodityPct, routeStance: routeStance };
  }

  function isRouteClosed(route, closedTags) {
    if (!closedTags || !closedTags.length) return false;
    for (var i = 0; i < route.tags.length; i++) {
      if (closedTags.indexOf(route.tags[i]) !== -1) return true;
    }
    return false;
  }

  function sanitizeRouteStance(countryId, desiredStance, closedTags) {
    var options = ROUTES_BY_COUNTRY[countryId];
    if (!options) return 0;
    var idx = clamp(Math.round(Number(desiredStance) || 0), 0, options.length - 1);
    if (!isRouteClosed(options[idx], closedTags)) return idx;
    // Find nearest open stance (prefer safe fallback)
    for (var i = options.length - 1; i >= 0; i--) {
      if (!isRouteClosed(options[i], closedTags)) return i;
    }
    return options.length - 1;
  }

  function normalizePercentages(obj, keys) {
    var out = {};
    var sum = 0;
    for (var i = 0; i < keys.length; i++) {
      var v = Math.max(0, Math.min(100, Number(obj[keys[i]]) || 0));
      out[keys[i]] = v;
      sum += v;
    }
    if (sum <= 0) {
      var eq = Math.floor(100 / keys.length);
      var rem = 100 - eq * keys.length;
      for (var j = 0; j < keys.length; j++) {
        out[keys[j]] = eq + (j < rem ? 1 : 0);
      }
      return out;
    }
    // Scale to 100 using largest remainder
    var floored = {};
    var rems = [];
    var totalFloor = 0;
    for (var k = 0; k < keys.length; k++) {
      var exact = (out[keys[k]] / sum) * 100;
      var fl = Math.floor(exact);
      floored[keys[k]] = fl;
      totalFloor += fl;
      rems.push({ k: keys[k], r: exact - fl });
    }
    rems.sort(function (a, b) { return b.r - a.r; });
    for (var m = 0; m < 100 - totalFloor; m++) {
      floored[rems[m].k] += 1;
    }
    return floored;
  }

  function validateAndNormalizePlan(plan, closedTags, unlockedCountries) {
    var cKeys = COUNTRIES.map(function (c) { return c.id; });
    var mKeys = COMMODITIES.map(function (c) { return c.id; });
    var activeCKeys = (unlockedCountries && unlockedCountries.length)
      ? cKeys.filter(function (k) { return unlockedCountries.indexOf(k) !== -1; })
      : cKeys;
    var normUnlocked = normalizePercentages((plan && plan.countryPct) || {}, activeCKeys);
    var countryPct = {};
    for (var ci = 0; ci < cKeys.length; ci++) {
      countryPct[cKeys[ci]] = normUnlocked[cKeys[ci]] || 0;
    }
    var commodityPct = normalizePercentages((plan && plan.commodityPct) || {}, mKeys);
    var routeStance = {};
    for (var i = 0; i < cKeys.length; i++) {
      var cid = cKeys[i];
      var rawStance = (plan && plan.routeStance && plan.routeStance[cid] != null) ? plan.routeStance[cid] : 1;
      routeStance[cid] = sanitizeRouteStance(cid, rawStance, closedTags);
    }
    return { countryPct: countryPct, commodityPct: commodityPct, routeStance: routeStance };
  }

  // Rebalance slider percentages cleanly when one slider moves to newValue (0..100)
  function rebalanceSliders(currentMap, changedKey, newValue, keys) {
    var target = clamp(Math.round(newValue), 0, 100);
    var out = {};
    var others = keys.filter(function (k) { return k !== changedKey; });
    var otherSum = 0;
    for (var i = 0; i < others.length; i++) {
      otherSum += Math.max(0, Number(currentMap[others[i]]) || 0);
    }
    out[changedKey] = target;
    var remTarget = 100 - target;
    if (remTarget === 0) {
      for (var j = 0; j < others.length; j++) out[others[j]] = 0;
      return out;
    }
    if (otherSum <= 0) {
      var eq = Math.floor(remTarget / others.length);
      var left = remTarget - eq * others.length;
      for (var k = 0; k < others.length; k++) {
        out[others[k]] = eq + (k < left ? 1 : 0);
      }
      return out;
    }
    var exacts = others.map(function (k) {
      var exact = ((Number(currentMap[k]) || 0) / otherSum) * remTarget;
      var fl = Math.floor(exact);
      return { k: k, fl: fl, rem: exact - fl };
    });
    var flSum = 0;
    for (var m = 0; m < exacts.length; m++) {
      out[exacts[m].k] = exacts[m].fl;
      flSum += exacts[m].fl;
    }
    exacts.sort(function (a, b) { return b.rem - a.rem; });
    for (var n = 0; n < remTarget - flSum; n++) {
      out[exacts[n].k] += 1;
    }
    return out;
  }

  // Empty-aware slider adjustment: keeps untouched 0% sliders at 0% until total exceeds 100%
  function adjustEmptyAwareSliders(currentMap, changedKey, newValue, keys) {
    var target = clamp(Math.round(newValue), 0, 100);
    var out = {};
    var others = keys.filter(function (k) { return k !== changedKey; });
    var otherSum = 0;
    for (var i = 0; i < others.length; i++) {
      var ov = Math.max(0, Math.round(Number(currentMap[others[i]]) || 0));
      out[others[i]] = ov;
      otherSum += ov;
    }
    out[changedKey] = target;
    if (target + otherSum <= 100) {
      return out;
    }
    var remTarget = 100 - target;
    if (remTarget <= 0 || otherSum <= 0) {
      for (var j = 0; j < others.length; j++) out[others[j]] = 0;
      return out;
    }
    var exacts = others.map(function (k) {
      var exact = (out[k] / otherSum) * remTarget;
      var fl = Math.floor(exact);
      return { k: k, fl: fl, rem: exact - fl };
    });
    var flSum = 0;
    for (var m = 0; m < exacts.length; m++) {
      out[exacts[m].k] = exacts[m].fl;
      flSum += exacts[m].fl;
    }
    exacts.sort(function (a, b) { return b.rem - a.rem; });
    for (var n = 0; n < remTarget - flSum; n++) {
      out[exacts[n].k] += 1;
    }
    return out;
  }

  // =========================================================================
  // 7. ROBUST PROFIT & SIMULATION ENGINE
  // =========================================================================
  function getRouteForCountry(countryId, stanceIndex, closedTags) {
    var idx = sanitizeRouteStance(countryId, stanceIndex, closedTags);
    return ROUTES_BY_COUNTRY[countryId][idx];
  }

  function rollBriefingOutcomes(briefing, roundRng) {
    var rolledEvents = [];
    briefing.events.forEach(function (ev) {
      if (ev.guaranteed || roundRng() < ev.probability) {
        rolledEvents.push(Object.assign({}, ev, { triggered: true }));
      }
    });
    return {
      rolledEvents: rolledEvents,
      surprises: briefing.surprises.slice()
    };
  }

  function resolveRound(state, plansByPlayerId) {
    var round = state.round;
    var fleetSize = GAME_CONFIG.FLEET_SCHEDULE[round - 1];
    var playerCount = state.players.length;
    var roundRng = mulberry32(state.seed ^ (round * 1597334677));
    var briefing = state.briefing;

    // 1. Roll probability events & reveal surprises
    var outcome = rollBriefingOutcomes(briefing, roundRng);
    var activeEvents = outcome.rolledEvents.concat(outcome.surprises);

    // Build modifier lookup from active events
    var closedTags = briefing.closedTags.slice();
    var highRiskBlocked = false;
    var highRiskDiversionDelay = 0;
    var highRiskDiversionFee = 0;
    var globalFuelMult = 1.0;
    var tagMods = {};
    var countryMods = {};
    var countryCommodityMods = {};
    var globalTariffMods = {};

    function ensureTag(t) {
      if (!tagMods[t]) tagMods[t] = { delayDays: 0, feeAdd: 0, tollAdd: 0, insuranceAdd: 0, piracyAdd: 0, weatherAdd: 0, repairCost: 0 };
      return tagMods[t];
    }
    function ensureCountry(c) {
      if (!countryMods[c]) countryMods[c] = { delayDays: 0, feeAdd: 0, banned: {}, fines: {} };
      return countryMods[c];
    }

    activeEvents.forEach(function (ev) {
      var ef = ev.effects || {};
      // Surprise events may use top-level properties directly
      var targetType = ev.targetType;
      if (ef.closeTag && closedTags.indexOf(ef.closeTag) === -1) closedTags.push(ef.closeTag);
      if (ef.blockHighRisk) {
        highRiskBlocked = true;
        highRiskDiversionDelay = Math.max(highRiskDiversionDelay, ef.diversionDelay || 2.8);
        highRiskDiversionFee = Math.max(highRiskDiversionFee, ef.diversionFee || 24000);
      }
      if (ef.fuelMult) globalFuelMult *= ef.fuelMult;
      if (ev.fuelMult) globalFuelMult *= ev.fuelMult;
      if (ef.globalTariffAdd) {
        Object.keys(ef.globalTariffAdd).forEach(function (cm) {
          globalTariffMods[cm] = (globalTariffMods[cm] || 0) + ef.globalTariffAdd[cm];
        });
      }
      if (ef.tag) {
        var tm = ensureTag(ef.tag);
        tm.delayDays += ef.delayDays || 0;
        tm.feeAdd += ef.feeAdd || 0;
        tm.tollAdd += ef.tollAdd || 0;
        tm.insuranceAdd += ef.insuranceAdd || 0;
        tm.piracyAdd += ef.piracyAdd || 0;
        tm.weatherAdd += ef.weatherAdd || 0;
        tm.repairCost += ef.repairCost || 0;
      }
      if (targetType === 'routeTag' && ev.target) {
        var st = ensureTag(ev.target);
        st.delayDays += ev.delayDays || 0;
        st.feeAdd += ev.feeAdd || 0;
        st.piracyAdd += ev.piracyAdd || 0;
      }
      if (ef.country) {
        if (ef.commodity && ef.tariffAdd) {
          var key = ef.country + ':' + ef.commodity;
          countryCommodityMods[key] = countryCommodityMods[key] || { tariffAdd: 0, demandMult: 1 };
          countryCommodityMods[key].tariffAdd += ef.tariffAdd;
        } else {
          var cm = ensureCountry(ef.country);
          cm.delayDays += ef.delayDays || 0;
          cm.feeAdd += ef.feeAdd || 0;
          if (ef.bannedCommodity) {
            cm.banned[ef.bannedCommodity] = true;
            cm.fines[ef.bannedCommodity] = ef.finePerShip || 85000;
          }
        }
      }
      if (targetType === 'countries' && ev.target) {
        ev.target.forEach(function (cid) {
          var cmod = ensureCountry(cid);
          cmod.delayDays += ev.delayDays || 0;
          cmod.feeAdd += ev.feeAdd || 0;
        });
      }
      if (targetType === 'countryCommodity' && ev.countries && ev.commodity) {
        ev.countries.forEach(function (cid) {
          var key = cid + ':' + ev.commodity;
          countryCommodityMods[key] = countryCommodityMods[key] || { tariffAdd: 0, demandMult: 1 };
          countryCommodityMods[key].demandMult *= (ev.demandMult || 1);
        });
      }
    });

    // 2. Evolve global price index (correlated shocks + mean reversion + overshoot fade)
    // Snapshot pre-evolve prices as base, then apply round shocks
    evolveMarketPrices(state, roundRng, outcome.rolledEvents, outcome.surprises);

    // 3. Normalize plans and expand ships per player
    var normalizedPlans = {};
    var mumbaiDemandUnits = {};
    COMMODITIES.forEach(function (cm) { mumbaiDemandUnits[cm.id] = 0; });

    var playerShips = {};
    var portArrivals = {};
    var chokeArrivals = {};
    COUNTRIES.forEach(function (co) { portArrivals[co.id] = 0; });
    Object.keys(CHOKEPOINTS).forEach(function (ch) { chokeArrivals[ch] = 0; });

    var unlockedCountries = (briefing && briefing.unlockedCountries) || getUnlockedCountryIds(state.countryUnlockOrder, round);
    state.players.forEach(function (pl) {
      var rawPlan = plansByPlayerId[pl.id] || pl.lastPlan || createDefaultPlan(closedTags, unlockedCountries);
      var plan = validateAndNormalizePlan(rawPlan, closedTags, unlockedCountries);
      normalizedPlans[pl.id] = plan;
      pl.lastPlan = plan;

      var shipAlloc = allocateShipsFromPct(plan.countryPct, fleetSize);
      var ships = [];
      var shipIndex = 0;

      // Count active commodities (> 0%) for multi-commodity handling complexity
      var activeComms = COMMODITIES.filter(function (cm) { return plan.commodityPct[cm.id] > 0; });
      var activeCommCount = activeComms.length;

      COUNTRIES.forEach(function (co) {
        var count = shipAlloc[co.id] || 0;
        if (count <= 0) return;
        var route = getRouteForCountry(co.id, plan.routeStance[co.id], closedTags);

        for (var s = 0; s < count; s++) {
          var cargoUnits = {};
          var exactUnits = [];
          var sumFloor = 0;
          for (var cIdx = 0; cIdx < COMMODITIES.length; cIdx++) {
            var cm = COMMODITIES[cIdx];
            var ex = (plan.commodityPct[cm.id] / 100) * GAME_CONFIG.SHIP_CAPACITY;
            var fl = Math.floor(ex);
            cargoUnits[cm.id] = fl;
            sumFloor += fl;
            exactUnits.push({ id: cm.id, rem: ex - fl });
          }
          exactUnits.sort(function (a, b) { return b.rem - a.rem; });
          for (var r = 0; r < GAME_CONFIG.SHIP_CAPACITY - sumFloor; r++) {
            cargoUnits[exactUnits[r].id] += 1;
          }

          ships.push({
            shipIndex: shipIndex++,
            playerId: pl.id,
            countryId: co.id,
            route: route,
            cargoUnits: cargoUnits,
            activeCommCount: activeCommCount,
            loadFactor: 1.0
          });

          portArrivals[co.id] += 1;
          route.chokepoints.forEach(function (ch) {
            chokeArrivals[ch] = (chokeArrivals[ch] || 0) + 1;
          });
        }
      });

      playerShips[pl.id] = ships;
    });

    // 4. Shared Mumbai Sourcing Pressure (before cash cap)
    // First compute raw demand at Mumbai
    state.players.forEach(function (pl) {
      playerShips[pl.id].forEach(function (sh) {
        COMMODITIES.forEach(function (cm) {
          mumbaiDemandUnits[cm.id] += sh.cargoUnits[cm.id];
        });
      });
    });

    var sourcingDepth = GAME_CONFIG.SOURCING_DEPTH_PER_PLAYER * Math.max(1, playerCount);
    var mumbaiBuyPrice = {};
    COMMODITIES.forEach(function (cm) {
      var excess = Math.max(0, (mumbaiDemandUnits[cm.id] - sourcingDepth * 0.6) / sourcingDepth);
      var sourcingMult = 1.0 + GAME_CONFIG.SOURCING_PRESSURE_ALPHA * excess;
      // Mumbai price also tracks global price index partially (65%) so spikes affect sourcing too
      var indexLink = 1 + (state.priceIndex[cm.id] - 1) * 0.65;
      mumbaiBuyPrice[cm.id] = cm.baseBuyPrice * indexLink * sourcingMult;
    });

    // 5. Cash constraint: ships sail part-loaded if cash cannot cover cargo purchase upfront
    state.players.forEach(function (pl) {
      var ships = playerShips[pl.id];
      var totalCargoPurchase = 0;
      ships.forEach(function (sh) {
        COMMODITIES.forEach(function (cm) {
          totalCargoPurchase += sh.cargoUnits[cm.id] * mumbaiBuyPrice[cm.id];
        });
      });
      if (totalCargoPurchase > 0 && pl.cash < totalCargoPurchase) {
        var factor = clamp(pl.cash / totalCargoPurchase, 0.20, 1.0);
        ships.forEach(function (sh) {
          sh.loadFactor = factor;
          COMMODITIES.forEach(function (cm) {
            sh.cargoUnits[cm.id] = Math.floor(sh.cargoUnits[cm.id] * factor);
          });
        });
      }
    });

    // 6. Shared Country-Commodity Saturation & Market Depth
    var marketSupply = {}; // key: countryId:commodityId -> total units
    COUNTRIES.forEach(function (co) {
      COMMODITIES.forEach(function (cm) {
        marketSupply[co.id + ':' + cm.id] = 0;
      });
    });
    state.players.forEach(function (pl) {
      playerShips[pl.id].forEach(function (sh) {
        COMMODITIES.forEach(function (cm) {
          var cMod = countryMods[sh.countryId];
          if (cMod && cMod.banned[cm.id]) return; // confiscated before sale
          marketSupply[sh.countryId + ':' + cm.id] += sh.cargoUnits[cm.id];
        });
      });
    });

    // Effective player-scaled market depth
    var totalFleetUnits = Math.max(1, playerCount) * fleetSize * GAME_CONFIG.SHIP_CAPACITY;
    var marketPriceMult = {};
    var saturationRatio = {};
    COUNTRIES.forEach(function (co) {
      var countryShareFactor = co.demandDepthPerPlayer / 950;
      COMMODITIES.forEach(function (cm) {
        var key = co.id + ':' + cm.id;
        var depth = Math.max(800, countryShareFactor * (totalFleetUnits / 11.5));
        var sup = marketSupply[key];
        var ratio = sup / depth;
        saturationRatio[key] = ratio;
        if (ratio <= 1.0) {
          marketPriceMult[key] = 1.0;
        } else {
          // Smooth elasticity curve: oversupply depresses price for everyone
          marketPriceMult[key] = clamp(Math.pow(1.0 / ratio, cm.elasticity), 0.42, 1.0);
        }
      });
    });

    // Player supply per country-commodity for Market-Share Tax (>40%)
    var playerSupplyByCountryComm = {};
    state.players.forEach(function (pl) {
      playerSupplyByCountryComm[pl.id] = {};
      playerShips[pl.id].forEach(function (sh) {
        COMMODITIES.forEach(function (cm) {
          var key = sh.countryId + ':' + cm.id;
          playerSupplyByCountryComm[pl.id][key] = (playerSupplyByCountryComm[pl.id][key] || 0) + sh.cargoUnits[cm.id];
        });
      });
    });

    // Fuel price linked to crude_oil global index and fuel event multiplier
    var fuelPricePerTon = GAME_CONFIG.FUEL_PRICE_PER_TON_BASE * (0.4 + 0.6 * state.priceIndex.crude_oil) * globalFuelMult;

    // 7. Resolve every ship voyage
    var playerReports = {};
    var contractDeliveries = {};
    briefing.contracts.forEach(function (ct) { contractDeliveries[ct.id] = {}; });

    var congestionThreshold = Math.max(2, Math.ceil(playerCount * fleetSize * 0.22 * GAME_CONFIG.CONGESTION_FREE_RATIO));

    state.players.forEach(function (pl) {
      var ships = playerShips[pl.id];
      var totalProfit = 0;
      var totalRevenue = 0;
      var totalCosts = 0;
      var shipBreakdowns = [];
      var countriesVisited = {};

      ships.forEach(function (sh) {
        var co = getCountryById(sh.countryId);
        var route = sh.route;
        countriesVisited[co.id] = true;

        var cMod = countryMods[co.id] || { delayDays: 0, feeAdd: 0, banned: {}, fines: {} };
        var rep = pl.reputation[co.id] || GAME_CONFIG.REP_INIT;

        // High-risk blockade (0.25 probability): Fast & Risky (stanceIndex 0) gets blocked & diverted to Low Risk (never blocked!)
        var wasHighRiskBlocked = false;
        if (highRiskBlocked && route.stanceIndex === 0) {
          wasHighRiskBlocked = true;
          var safeOpts = ROUTES_BY_COUNTRY[co.id];
          route = safeOpts[safeOpts.length - 1];
        }

        // Transit time & delays
        var baseDays = route.distanceNm / (route.knots * 24);
        var delayDays = cMod.delayDays + (wasHighRiskBlocked ? highRiskDiversionDelay : 0);
        var extraTagFees = wasHighRiskBlocked ? highRiskDiversionFee : 0;
        var extraTolls = 0;
        var extraInsurance = 0;
        var extraPiracy = 0;
        var extraWeather = 0;
        var extraWeatherRepair = 0;

        route.tags.forEach(function (t) {
          var tm = tagMods[t];
          if (!tm) return;
          delayDays += tm.delayDays;
          extraTagFees += tm.feeAdd;
          extraTolls += tm.tollAdd;
          extraInsurance += tm.insuranceAdd;
          extraPiracy += tm.piracyAdd;
          extraWeather += tm.weatherAdd;
          extraWeatherRepair += tm.repairCost;
        });

        // Port & narrow-strait congestion (capped so single chokepoint doesn't destroy entire fleet)
        var portExcess = Math.max(0, portArrivals[co.id] - congestionThreshold);
        var chokeExcess = 0;
        route.chokepoints.forEach(function (ch) {
          chokeExcess = Math.max(chokeExcess, Math.max(0, (chokeArrivals[ch] || 0) - Math.ceil(congestionThreshold * 1.6)));
        });
        var congestionDelay = Math.min(2.8, (portExcess * 0.55 + chokeExcess * 0.35) * GAME_CONFIG.CONGESTION_DELAY_PER_SHIP);
        var congestionFee = Math.min(18000, (portExcess * 0.6 + chokeExcess * 0.3) * GAME_CONFIG.CONGESTION_FEE_PER_SHIP);
        delayDays += congestionDelay;

        // Per-ship deterministic incident roll (small individual variance, fair across players)
        var shipRng = mulberry32(state.seed ^ (round * 104729) ^ hashString(pl.id) ^ (sh.shipIndex * 7919));
        var speedRatio = route.knots / GAME_CONFIG.BASELINE_SPEED_KNOTS;
        var breakdownChance = GAME_CONFIG.BREAKDOWN_BASE_CHANCE * Math.pow(speedRatio, 2.5) * (1 + (round - 1) * 0.12);
        var hadBreakdown = shipRng() < breakdownChance;
        var hadPiracy = shipRng() < (route.basePiracy + extraPiracy);
        var hadStorm = shipRng() < (route.baseWeather + extraWeather);

        var repairCost = 0;
        if (hadBreakdown) {
          delayDays += GAME_CONFIG.BREAKDOWN_DELAY_DAYS;
          repairCost += GAME_CONFIG.BREAKDOWN_REPAIR_COST;
        }
        if (hadStorm) {
          delayDays += 1.4;
          repairCost += extraWeatherRepair > 0 ? extraWeatherRepair : 22000;
        }

        var totalDays = baseDays + delayDays;

        // Cargo purchase, revenue, tariffs, fines, spoilage, weight
        var cargoPurchase = 0;
        var grossRevenue = 0;
        var tariffsFines = 0;
        var marketShareTax = 0;
        var weightedClass = 0;
        var totalUnits = 0;

        COMMODITIES.forEach(function (cm) {
          var units = sh.cargoUnits[cm.id];
          if (units <= 0) return;
          totalUnits += units;
          weightedClass += units * cm.weightClass;

          var buyUnit = mumbaiBuyPrice[cm.id];
          cargoPurchase += units * buyUnit;

          if (cMod.banned[cm.id]) {
            // Sanction ban: cargo confiscated, 0 revenue + fine!
            tariffsFines += cMod.fines[cm.id] || 90000;
            return;
          }

          var key = co.id + ':' + cm.id;
          var ccMod = countryCommodityMods[key] || { tariffAdd: 0, demandMult: 1 };
          var repDemandBoost = 0.94 + rep * 0.12; // 0.96 .. 1.06
          var spoilageSurv = Math.max(0.70, 1.0 - cm.spoilagePerDay * totalDays);
          var sellPrice = cm.baseSellPrice
            * state.priceIndex[cm.id]
            * co.demand[cm.id]
            * state.demandDrift[co.id][cm.id]
            * ccMod.demandMult
            * co.exchangeRate
            * repDemandBoost
            * marketPriceMult[key];

          var lineRev = units * spoilageSurv * sellPrice;
          if (hadPiracy) {
            lineRev *= 0.90; // 10% pilferage/ransom loss on piracy incident
          }

          // Tariffs
          var tariffRate = co.baseTariff * cm.tariffSensitivity
            + (globalTariffMods[cm.id] || 0)
            + ccMod.tariffAdd;
          tariffsFines += lineRev * tariffRate;

          // Market-share tax above 40% (only when meaningful volume >= 600 units in market)
          var totSup = marketSupply[key];
          var plSup = playerSupplyByCountryComm[pl.id][key] || 0;
          if (totSup >= 1200 && (plSup / totSup) > GAME_CONFIG.MARKET_SHARE_TAX_THRESHOLD) {
            var excessShare = (plSup / totSup) - GAME_CONFIG.MARKET_SHARE_TAX_THRESHOLD;
            marketShareTax += lineRev * excessShare * GAME_CONFIG.MARKET_SHARE_TAX_RATE;
          }

          grossRevenue += lineRev;

          // Track special contracts
          briefing.contracts.forEach(function (ct) {
            if (ct.countryId === co.id && ct.commodityId === cm.id) {
              contractDeliveries[ct.id][pl.id] = (contractDeliveries[ct.id][pl.id] || 0) + units;
            }
          });
        });

        var avgWeight = totalUnits > 0 ? weightedClass / totalUnits : 1.0;

        // Delay penalty (~1.8% per day late beyond baseline transit)
        var delayPenalty = grossRevenue * Math.min(0.25, delayDays * GAME_CONFIG.DELAY_PENALTY_PER_DAY);
        var netRevenue = grossRevenue - delayPenalty;

        // Fuel, tolls, port fees, crew, insurance, maintenance, handling, overhead
        var fuelTons = totalDays * GAME_CONFIG.FUEL_BASE_TONS_PER_DAY * Math.pow(speedRatio, GAME_CONFIG.FUEL_SPEED_EXPONENT) * avgWeight;
        var fuelCost = fuelTons * fuelPricePerTon;
        var tolls = route.toll + extraTolls;
        var repFeeDiscount = 1.08 - rep * 0.16; // 1.05 .. 0.92
        var portFees = co.portFee * repFeeDiscount + cMod.feeAdd + extraTagFees + congestionFee;
        var crewCost = totalDays * GAME_CONFIG.CREW_COST_PER_DAY;
        var cargoVal = Math.max(cargoPurchase, 150000);
        var insurance = cargoVal * (GAME_CONFIG.INSURANCE_BASE_RATE + route.basePiracy * 0.4 + extraInsurance);
        var maintenance = totalDays * GAME_CONFIG.WEAR_COST_PER_DAY_BASE * Math.pow(speedRatio, GAME_CONFIG.WEAR_SPEED_EXPONENT) + repairCost;
        var handling = GAME_CONFIG.MULTI_COMMODITY_BASE_FEE + Math.max(0, sh.activeCommCount - 1) * GAME_CONFIG.MULTI_COMMODITY_STEP_FEE;
        var overhead = GAME_CONFIG.FIXED_OVERHEAD_PER_SHIP;

        var totalShipCost = cargoPurchase + fuelCost + tolls + portFees + crewCost + insurance + maintenance + tariffsFines + handling + overhead + marketShareTax;
        var shipProfit = netRevenue - totalShipCost;

        totalRevenue += netRevenue;
        totalCosts += totalShipCost;
        totalProfit += shipProfit;

        var notes = [];
        if (sh.loadFactor < 0.99) notes.push('Sailed ' + Math.round(sh.loadFactor * 100) + '% loaded (cash cap)');
        if (wasHighRiskBlocked) notes.push('High-risk lane blocked — forced safe detour (+' + highRiskDiversionDelay.toFixed(1) + 'd, +$' + Math.round(highRiskDiversionFee / 1000) + 'k)');
        if (Object.keys(cMod.banned).some(function (b) { return sh.cargoUnits[b] > 0; })) notes.push('Sanctioned cargo confiscated + fined');
        if (hadBreakdown) notes.push('Engine breakdown (+2.2d, repair)');
        if (hadStorm) notes.push('Heavy storm (+1.4d, hull repair)');
        if (hadPiracy) notes.push('Piracy harassment (-10% cargo)');
        if (congestionDelay > 0.5) notes.push('Port/strait queue (+' + congestionDelay.toFixed(1) + 'd)');
        if (marketShareTax > 5000) notes.push('Market-share tax applied');

        shipBreakdowns.push({
          shipIndex: sh.shipIndex + 1,
          countryId: co.id,
          countryName: co.name,
          portName: co.portName,
          routeId: route.id,
          routeLabel: route.label,
          distanceNm: route.distanceNm,
          knots: route.knots,
          transitDays: Math.round(totalDays * 10) / 10,
          loadFactor: sh.loadFactor,
          revenue: Math.round(netRevenue),
          cargoPurchase: Math.round(cargoPurchase),
          fuelCost: Math.round(fuelCost),
          tolls: Math.round(tolls),
          portFees: Math.round(portFees),
          crewCost: Math.round(crewCost),
          insurance: Math.round(insurance),
          maintenance: Math.round(maintenance),
          tariffsFines: Math.round(tariffsFines),
          handling: Math.round(handling),
          overhead: Math.round(overhead),
          taxes: Math.round(marketShareTax),
          profit: Math.round(shipProfit),
          notes: notes
        });
      });

      // Update country reputation
      COUNTRIES.forEach(function (co) {
        if (countriesVisited[co.id]) {
          pl.reputation[co.id] = clamp(pl.reputation[co.id] + GAME_CONFIG.REP_GAIN_ON_DELIVERY, GAME_CONFIG.REP_MIN, GAME_CONFIG.REP_MAX);
        } else {
          pl.reputation[co.id] = clamp(pl.reputation[co.id] - GAME_CONFIG.REP_DECAY_ON_NEGLECT, GAME_CONFIG.REP_MIN, GAME_CONFIG.REP_MAX);
        }
      });

      playerReports[pl.id] = {
        playerId: pl.id,
        roundProfit: Math.round(totalProfit),
        contractBonus: 0,
        revenue: Math.round(totalRevenue),
        costs: Math.round(totalCosts),
        ships: shipBreakdowns,
        highlights: []
      };
    });

    // 8. Special Contract Bonus Payouts
    briefing.contracts.forEach(function (ct) {
      var delivs = contractDeliveries[ct.id];
      var totalDeliv = 0;
      Object.keys(delivs).forEach(function (pid) { totalDeliv += delivs[pid]; });
      if (totalDeliv <= 0) return;
      var fillRatio = Math.min(1.0, totalDeliv / ct.targetUnits);
      var pool = ct.bonusPool * fillRatio;
      Object.keys(delivs).forEach(function (pid) {
        var share = delivs[pid] / totalDeliv;
        var bonus = Math.round(pool * share);
        if (bonus > 0 && playerReports[pid]) {
          playerReports[pid].contractBonus += bonus;
          playerReports[pid].roundProfit += bonus;
          playerReports[pid].highlights.push('Contract fulfilled: +$' + bonus.toLocaleString() + ' (' + ct.label.split(' needs')[0] + ')');
        }
      });
    });

    // 9. Apply profit to player cash & rankings
    state.players.forEach(function (pl) {
      var rep = playerReports[pl.id];
      pl.prevCash = pl.cash;
      pl.cash = Math.round(pl.cash + rep.roundProfit);
      if (rep.roundProfit < pl.worstRoundLoss) {
        pl.worstRoundLoss = rep.roundProfit;
      }
      pl.roundProfits.push(rep.roundProfit);

      // Summary insights ("what went right or wrong")
      if (rep.roundProfit > 150000) rep.highlights.push('Strong voyage margin across your fleet.');
      else if (rep.roundProfit < 0) rep.highlights.push('Voyage losses exceeded net cargo revenue.');
      var satWarnings = [];
      Object.keys(playerSupplyByCountryComm[pl.id]).forEach(function (k) {
        if ((playerSupplyByCountryComm[pl.id][k] || 0) > 0 && saturationRatio[k] > 1.25) {
          var parts = k.split(':');
          satWarnings.push(getCountryById(parts[0]).name + ' ' + getCommodityById(parts[1]).shortName);
        }
      });
      if (satWarnings.length > 0) {
        rep.highlights.push('Market oversupply lowered prices in: ' + satWarnings.slice(0, 3).join(', '));
      }
      rep.newCash = pl.cash;
      rep.cumulativeProfit = pl.cash - GAME_CONFIG.STARTING_CASH;
    });

    // Rank leaderboard (score = cash - startingCash, tie-break: smaller worst single-round loss -> higher worstRoundLoss)
    var sorted = state.players.slice().sort(function (a, b) {
      if (b.cash !== a.cash) return b.cash - a.cash;
      return b.worstRoundLoss - a.worstRoundLoss;
    });
    sorted.forEach(function (pl, idx) {
      pl.prevRank = pl.rank;
      pl.rank = idx + 1;
    });

    // Saturation heatmap per country (average saturation across delivered commodities)
    var countryHeatmap = {};
    COUNTRIES.forEach(function (co) {
      var maxSat = 0;
      var totalUnits = 0;
      COMMODITIES.forEach(function (cm) {
        var key = co.id + ':' + cm.id;
        if (marketSupply[key] > 0) {
          maxSat = Math.max(maxSat, saturationRatio[key]);
          totalUnits += marketSupply[key];
        }
      });
      countryHeatmap[co.id] = {
        ships: portArrivals[co.id],
        units: totalUnits,
        saturation: Math.round(maxSat * 100) / 100
      };
    });

    var roundSummary = {
      round: round,
      fleetSize: fleetSize,
      activeEvents: activeEvents,
      surprises: outcome.surprises,
      closedTags: closedTags,
      highRiskBlocked: highRiskBlocked,
      fuelPricePerTon: Math.round(fuelPricePerTon),
      countryHeatmap: countryHeatmap,
      playerReports: playerReports,
      plans: normalizedPlans
    };
    state.history.push(roundSummary);

    // Advance to next round or finish
    if (round < GAME_CONFIG.ROUNDS) {
      state.round = round + 1;
      var nextUnlocked = getUnlockedCountryIds(state.countryUnlockOrder, state.round);
      state.briefing = generateRoundBriefing(state.round, state.seed, state.priceIndex, nextUnlocked);
      state.briefing.newlyUnlockedCountries = getNewlyUnlockedCountryIds(state.countryUnlockOrder, state.round);
    } else {
      state.finished = true;
    }

    return roundSummary;
  }

  // =========================================================================
  // 8. LIVE ESTIMATED PROFIT RANGE (for UI sliders)
  // =========================================================================
  function estimatePlanProfitRange(state, playerState, rawPlan) {
    var round = state.round;
    var fleetSize = GAME_CONFIG.FLEET_SCHEDULE[round - 1];
    var briefing = state.briefing;
    var unlockedCountries = (briefing && briefing.unlockedCountries) || getUnlockedCountryIds(state.countryUnlockOrder, round);
    var plan = validateAndNormalizePlan(rawPlan, briefing.closedTags, unlockedCountries);
    var shipAlloc = allocateShipsFromPct(plan.countryPct, fleetSize);
    var activeCommCount = COMMODITIES.filter(function (c) { return plan.commodityPct[c.id] > 0; }).length;

    // Baseline expected fuel multiplier from guaranteed events
    var estFuelMult = 1.0;
    var bannedRussia = false;
    var usTextileTariff = 0;
    var globalTariff = {};
    briefing.events.forEach(function (ev) {
      if (!ev.guaranteed) return;
      var ef = ev.effects || {};
      if (ef.fuelMult) estFuelMult *= ef.fuelMult;
      if (ef.country === 'russia' && ef.bannedCommodity === 'electronics') bannedRussia = true;
      if (ef.country === 'usa' && ef.commodity === 'textiles') usTextileTariff += ef.tariffAdd || 0;
      if (ef.globalTariffAdd) {
        Object.keys(ef.globalTariffAdd).forEach(function (k) { globalTariff[k] = (globalTariff[k] || 0) + ef.globalTariffAdd[k]; });
      }
    });

    var fuelPrice = GAME_CONFIG.FUEL_PRICE_PER_TON_BASE * (0.4 + 0.6 * state.priceIndex.crude_oil) * estFuelMult;
    var expectedProfit = 0;
    var ownSupply = {};

    COUNTRIES.forEach(function (co) {
      var count = shipAlloc[co.id] || 0;
      if (count <= 0) return;
      var route = getRouteForCountry(co.id, plan.routeStance[co.id], briefing.closedTags);
      var days = route.distanceNm / (route.knots * 24);
      var speedRatio = route.knots / GAME_CONFIG.BASELINE_SPEED_KNOTS;
      var rep = (playerState && playerState.reputation && playerState.reputation[co.id]) || GAME_CONFIG.REP_INIT;

      // Estimate self-saturation roughly
      var depthApprox = co.demandDepthPerPlayer * Math.max(1, state.players.length) * (1 + (fleetSize - 1) * 0.55) / Math.max(1, state.players.length * 0.6);

      for (var s = 0; s < count; s++) {
        var cargoBuy = 0;
        var rev = 0;
        var tariff = 0;
        var wt = 0;
        COMMODITIES.forEach(function (cm) {
          var units = (plan.commodityPct[cm.id] / 100) * GAME_CONFIG.SHIP_CAPACITY;
          if (units <= 0) return;
          wt += (plan.commodityPct[cm.id] / 100) * cm.weightClass;
          var indexLink = 1 + (state.priceIndex[cm.id] - 1) * 0.65;
          cargoBuy += units * cm.baseBuyPrice * indexLink;

          if (co.id === 'russia' && cm.id === 'electronics' && bannedRussia) {
            tariff += 95000;
            return;
          }
          var k = co.id + ':' + cm.id;
          ownSupply[k] = (ownSupply[k] || 0) + units;
          var satRatio = Math.max(1, ownSupply[k] / depthApprox);
          var satMult = Math.pow(1 / satRatio, cm.elasticity * 0.6);

          var spoil = Math.max(0.75, 1.0 - cm.spoilagePerDay * days);
          var sell = cm.baseSellPrice * state.priceIndex[cm.id] * co.demand[cm.id] * state.demandDrift[co.id][cm.id] * co.exchangeRate * (0.94 + rep * 0.12) * satMult;
          var lineRev = units * spoil * sell;
          var tRate = co.baseTariff * cm.tariffSensitivity + (globalTariff[cm.id] || 0) + (co.id === 'usa' && cm.id === 'textiles' ? usTextileTariff : 0);
          tariff += lineRev * tRate;
          rev += lineRev;
        });

        var fuel = days * GAME_CONFIG.FUEL_BASE_TONS_PER_DAY * Math.pow(speedRatio, GAME_CONFIG.FUEL_SPEED_EXPONENT) * (wt || 1) * fuelPrice;
        var crew = days * GAME_CONFIG.CREW_COST_PER_DAY;
        var ins = Math.max(cargoBuy, 150000) * (GAME_CONFIG.INSURANCE_BASE_RATE + route.basePiracy * 0.4);
        var maint = days * GAME_CONFIG.WEAR_COST_PER_DAY_BASE * Math.pow(speedRatio, GAME_CONFIG.WEAR_SPEED_EXPONENT);
        var port = co.portFee * (1.08 - rep * 0.16);
        var handling = GAME_CONFIG.MULTI_COMMODITY_BASE_FEE + Math.max(0, activeCommCount - 1) * GAME_CONFIG.MULTI_COMMODITY_STEP_FEE;
        var overhead = GAME_CONFIG.FIXED_OVERHEAD_PER_SHIP;
        expectedProfit += (rev - cargoBuy - fuel - route.toll - port - crew - ins - maint - tariff - handling - overhead);
      }
    });

    var errBand = GAME_CONFIG.FORECAST_ERROR_BY_LEVEL[clamp(briefing.uncertainty - 1, 0, 4)];
    var spread = Math.max(60000 * fleetSize, Math.abs(expectedProfit) * errBand + fleetSize * 35000 * briefing.uncertainty);
    return {
      expected: Math.round(expectedProfit),
      low: Math.round(expectedProfit - spread),
      high: Math.round(expectedProfit + spread),
      uncertainty: briefing.uncertainty
    };
  }

  function getRankTitle(profit) {
    var title = GAME_CONFIG.RANKS[0].title;
    for (var i = 0; i < GAME_CONFIG.RANKS.length; i++) {
      if (profit >= GAME_CONFIG.RANKS[i].minProfit) title = GAME_CONFIG.RANKS[i].title;
    }
    return title;
  }

  // =========================================================================
  // 9. AI BOT & STRATEGY ENGINE (for Solo/Multiplayer Bots & sim.js)
  // =========================================================================
  function buildStrategyPlan(strategyName, state, playerState, rng) {
    var briefing = state.briefing;
    var closedTags = briefing.closedTags;
    var round = state.round;
    var fleetSize = GAME_CONFIG.FLEET_SCHEDULE[round - 1];
    var cIds = COUNTRIES.map(function (c) { return c.id; });
    var unlockedIds = (briefing && briefing.unlockedCountries && briefing.unlockedCountries.length)
      ? briefing.unlockedCountries.slice()
      : getUnlockedCountryIds(state.countryUnlockOrder, round);
    var mIds = COMMODITIES.map(function (c) { return c.id; });

    // Helper for equal split
    function emptyMap(keys) {
      var m = {};
      keys.forEach(function (k) { m[k] = 0; });
      return m;
    }

    if (strategyName === 'all-ships-one-country') {
      var pickC = unlockedIds[Math.floor(rng() * unlockedIds.length)];
      var cp = emptyMap(cIds);
      cp[pickC] = 100;
      var mp = { crude_oil: 17, wheat: 17, fertilizer: 17, spices_tea: 17, textiles: 16, electronics: 16 };
      var rs = {};
      cIds.forEach(function (id) { rs[id] = sanitizeRouteStance(id, 1, closedTags); });
      return { countryPct: cp, commodityPct: mp, routeStance: rs };
    }

    if (strategyName === 'all-one-commodity') {
      var pickM = mIds[Math.floor(rng() * mIds.length)];
      var cp2 = { germany: 18, uk: 14, france: 14, russia: 12, usa: 18, australia: 12, new_zealand: 12 };
      var mp2 = emptyMap(mIds);
      mp2[pickM] = 100;
      var rs2 = {};
      cIds.forEach(function (id) { rs2[id] = sanitizeRouteStance(id, 1, closedTags); });
      return validateAndNormalizePlan({ countryPct: cp2, commodityPct: mp2, routeStance: rs2 }, closedTags, unlockedIds);
    }

    if (strategyName === 'always-fastest-route') {
      var rsFast = {};
      cIds.forEach(function (id) { rsFast[id] = sanitizeRouteStance(id, 0, closedTags); });
      return validateAndNormalizePlan({
        countryPct: { germany: 20, uk: 15, france: 15, russia: 10, usa: 20, australia: 10, new_zealand: 10 },
        commodityPct: { crude_oil: 20, wheat: 15, fertilizer: 15, spices_tea: 18, textiles: 17, electronics: 15 },
        routeStance: rsFast
      }, closedTags, unlockedIds);
    }

    if (strategyName === 'always-safest-route') {
      var rsSafe = {};
      cIds.forEach(function (id) { rsSafe[id] = sanitizeRouteStance(id, 2, closedTags); });
      return validateAndNormalizePlan({
        countryPct: { germany: 20, uk: 15, france: 15, russia: 10, usa: 20, australia: 10, new_zealand: 10 },
        commodityPct: { crude_oil: 20, wheat: 15, fertilizer: 15, spices_tea: 18, textiles: 17, electronics: 15 },
        routeStance: rsSafe
      }, closedTags, unlockedIds);
    }

    if (strategyName === 'diversified-static') {
      var rsBal = {};
      cIds.forEach(function (id) { rsBal[id] = sanitizeRouteStance(id, 1, closedTags); });
      return validateAndNormalizePlan({
        countryPct: { germany: 20, uk: 15, france: 14, russia: 10, usa: 21, australia: 11, new_zealand: 9 },
        commodityPct: { crude_oil: 20, wheat: 14, fertilizer: 14, spices_tea: 18, textiles: 18, electronics: 16 },
        routeStance: rsBal
      }, closedTags, unlockedIds);
    }

    if (strategyName === 'random' || strategyName === 'Gambler') {
      var cpR = {};
      var mpR = {};
      var rsR = {};
      cIds.forEach(function (id) {
        cpR[id] = unlockedIds.indexOf(id) !== -1 ? rng() * (strategyName === 'Gambler' ? 100 : 80) : 0;
        rsR[id] = sanitizeRouteStance(id, strategyName === 'Gambler' ? (rng() < 0.7 ? 0 : 1) : Math.floor(rng() * 3), closedTags);
      });
      mIds.forEach(function (id) { mpR[id] = rng() * 100; });
      return validateAndNormalizePlan({ countryPct: cpR, commodityPct: mpR, routeStance: rsR }, closedTags, unlockedIds);
    }

    if (strategyName === 'Cautious') {
      var rsC = {};
      cIds.forEach(function (id) { rsC[id] = sanitizeRouteStance(id, 2, closedTags); });
      // Avoid Russia in R3+
      var rusPct = round >= 3 ? 0 : 8;
      return validateAndNormalizePlan({
        countryPct: { germany: 22, uk: 18, france: 18, russia: rusPct, usa: 22, australia: 12, new_zealand: 8 },
        commodityPct: { crude_oil: 16, wheat: 10, fertilizer: 14, spices_tea: 24, textiles: 22, electronics: 14 },
        routeStance: rsC
      }, closedTags, unlockedIds);
    }

    if (strategyName === 'greedy-last-round-winner' || strategyName === 'Greedy') {
      if (state.history.length > 0) {
        var lastHist = state.history[state.history.length - 1];
        var bestPid = null;
        var bestProfit = -Infinity;
        Object.keys(lastHist.playerReports).forEach(function (pid) {
          if (lastHist.playerReports[pid].roundProfit > bestProfit) {
            bestProfit = lastHist.playerReports[pid].roundProfit;
            bestPid = pid;
          }
        });
        if (bestPid && lastHist.plans[bestPid]) {
          return validateAndNormalizePlan(lastHist.plans[bestPid], closedTags, unlockedIds);
        }
      }
      // Round 1 greedy chases highest raw sell margin (Russia + Electronics)
      return validateAndNormalizePlan({
        countryPct: { germany: 20, uk: 5, france: 5, russia: 40, usa: 30, australia: 0, new_zealand: 0 },
        commodityPct: { crude_oil: 10, wheat: 5, fertilizer: 5, spices_tea: 10, textiles: 15, electronics: 55 },
        routeStance: { germany: 0, uk: 0, france: 0, russia: 0, usa: 0, australia: 0, new_zealand: 0 }
      }, closedTags, unlockedIds);
    }

    // ADAPTIVE BOT: inspects briefing events, sanctions, tariffs, fuel price, contracts, and previous saturation!
    var bannedRussia = false;
    var usTexTariff = false;
    var globalTradeWar = false;
    var highFuel = false;
    var redSeaAlert = false;
    var hamburgStrikeRisk = false;
    var cycloneRisk = false;
    var grainSpike = false;

    briefing.events.forEach(function (ev) {
      var ef = ev.effects || {};
      if (ef.country === 'russia' && ef.bannedCommodity === 'electronics') bannedRussia = true;
      if (ef.country === 'usa' && ef.commodity === 'textiles') usTexTariff = true;
      if (ef.globalTariffAdd) globalTradeWar = true;
      if (ef.fuelMult && ef.fuelMult >= 1.18) highFuel = true;
      if (ef.tag === 'redsea') redSeaAlert = true;
      if (ef.country === 'germany' && ef.delayDays >= 2) hamburgStrikeRisk = true;
      if (ef.tag === 'indian-cyclone') cycloneRisk = true;
      if (ef.commodities && ef.commodities.wheat) grainSpike = true;
    });

    // Score each country dynamically
    var countryScores = {};
    COUNTRIES.forEach(function (co) {
      var score = (co.demandDepthPerPlayer / 950) * co.exchangeRate * 100;
      if (co.id === 'russia' && bannedRussia) score *= 0.72; // avoid Electronics, still trade Wheat/Fertilizer/Spices
      if (co.id === 'germany' && hamburgStrikeRisk) score *= 0.75;
      if ((co.id === 'australia' || co.id === 'new_zealand') && cycloneRisk) score *= 0.85;
      if (playerState && playerState.reputation && playerState.reputation[co.id]) {
        score *= (0.85 + playerState.reputation[co.id] * 0.35);
      }
      if (state.history.length > 0) {
        var lastHm = state.history[state.history.length - 1].countryHeatmap[co.id];
        if (lastHm && lastHm.saturation > 1.15) score *= 0.76;
      }
      countryScores[co.id] = Math.max(10, score);
    });

    briefing.contracts.forEach(function (ct) {
      countryScores[ct.countryId] *= 1.35;
    });

    // Pick top unlocked countries weighted cleanly
    var sortedC = unlockedIds.slice().sort(function (a, b) { return countryScores[b] - countryScores[a]; });
    var activeCountryLimit = Math.min(sortedC.length, Math.min(5, Math.max(1, fleetSize)));
    var cpAdapt = emptyMap(cIds);
    for (var i = 0; i < activeCountryLimit; i++) {
      cpAdapt[sortedC[i]] = Math.pow(countryScores[sortedC[i]], 1.15);
    }
    // If Russia is sanctioned and has no special contract, swap Russia for next unlocked market
    if (bannedRussia && cpAdapt.russia && !briefing.contracts.some(function (ct) { return ct.countryId === 'russia'; })) {
      if (fleetSize >= 2 && sortedC.length > 1) {
        cpAdapt.russia = 0;
        for (var nx = activeCountryLimit; nx < sortedC.length; nx++) {
          if (sortedC[nx] !== 'russia') {
            cpAdapt[sortedC[nx]] = Math.pow(countryScores[sortedC[nx]], 1.15);
            break;
          }
        }
      }
    }

    // Weighted average demand across the countries Adaptive is actually visiting
    var cpAdaptSum = 0;
    cIds.forEach(function (cid) { cpAdaptSum += cpAdapt[cid] || 0; });

    // Score each commodity dynamically based on live Mumbai vs Destination spread, port demand, mean-reversion & events
    var commScores = {};
    COMMODITIES.forEach(function (cm) {
      var curIdx = state.priceIndex[cm.id] || 1.0;
      var fadeAdj = -(state.lastSpike && state.lastSpike[cm.id] ? state.lastSpike[cm.id] * GAME_CONFIG.OVERSHOOT_FADE_FACTOR : 0);
      var revAdj = (1.0 - curIdx) * GAME_CONFIG.MEAN_REVERSION_RATE;
      var expectedIdx = curIdx * (1 + fadeAdj + revAdj);
      var buyEst = cm.baseBuyPrice * (1 + (expectedIdx - 1) * 0.65);

      var avgDemand = 0;
      if (cpAdaptSum > 0) {
        cIds.forEach(function (cid) {
          var w = (cpAdapt[cid] || 0) / cpAdaptSum;
          if (w <= 0) return;
          var co = getCountryById(cid);
          var dDrift = (state.demandDrift && state.demandDrift[cid] && state.demandDrift[cid][cm.id]) || 1.0;
          avgDemand += w * co.demand[cm.id] * dDrift * co.exchangeRate * (1 - co.baseTariff * cm.tariffSensitivity);
        });
      } else {
        avgDemand = 1.08;
      }

      var sellEst = cm.baseSellPrice * expectedIdx * avgDemand;
      if (cm.id === 'wheat' && round === 2) sellEst *= 1.16;
      if (cm.id === 'crude_oil' && round === 3) sellEst *= 1.18;
      if (grainSpike && (cm.id === 'wheat' || cm.id === 'fertilizer')) sellEst *= 1.32;
      var margin = sellEst - buyEst;
      var sc = Math.max(25, margin);
      if (bannedRussia && cpAdapt.russia > 0 && cm.id === 'electronics') sc = 1; // avoid confiscation if visiting Russia
      if (usTexTariff && cpAdapt.usa > 0 && cm.id === 'textiles') sc *= 0.70;
      if (globalTradeWar && (cm.id === 'textiles' || cm.id === 'electronics')) sc *= 0.66;
      if (round >= 4 && !grainSpike && cm.id === 'wheat') sc *= 0.92;
      if (round >= 4 && cm.id === 'spices_tea') sc *= 0.94;
      commScores[cm.id] = sc;
    });

    briefing.contracts.forEach(function (ct) {
      commScores[ct.commodityId] *= 1.45;
    });

    // Pick top 2-4 commodities to balance margin vs multi-commodity handling fee
    var sortedM = mIds.slice().sort(function (a, b) { return commScores[b] - commScores[a]; });
    var activeCommLimit = fleetSize === 1 ? 2 : (fleetSize <= 3 ? 3 : 4);
    var mpAdapt = emptyMap(mIds);
    for (var j = 0; j < activeCommLimit; j++) {
      mpAdapt[sortedM[j]] = Math.pow(commScores[sortedM[j]], 1.25);
    }

    // Route stance per country: avoid Suez when redsea piracy/closed or fuel high; avoid Fast & Risky when 25% blockade risk applies
    var rsAdapt = {};
    cIds.forEach(function (cid) {
      var desired = 1;
      if (cid === 'australia' || cid === 'new_zealand') {
        desired = cycloneRisk ? 2 : 1;
      } else {
        if (redSeaAlert || highFuel) desired = 2;
        else desired = 1;
      }
      rsAdapt[cid] = sanitizeRouteStance(cid, desired, closedTags);
    });

    return validateAndNormalizePlan({ countryPct: cpAdapt, commodityPct: mpAdapt, routeStance: rsAdapt }, closedTags, unlockedIds);
  }

  function getCaptainsHint(state, playerState) {
    var rng = mulberry32((state.seed ^ (state.round * 9973)) >>> 0);
    var plan = buildStrategyPlan('adaptive', state, playerState, rng);
    var reasons = [];
    state.briefing.events.forEach(function (ev) {
      if (ev.id === 'r3_russia_sanctions') reasons.push('Avoid shipping Electronics to Russia (sanctioned).');
      if (ev.id === 'r4_us_tariff') reasons.push('Trim Textiles to USA due to the +25% tariff.');
      if (ev.id === 'r4_suez_closed' || ev.id === 'r5_redsea_closed') reasons.push('Route Europe & USA fleets via the Cape.');
      if (ev.id === 'r2_redsea_piracy') reasons.push('Consider Cape of Good Hope to dodge Red Sea war-risk fees.');
      if (ev.id === 'r5_agri_spike') reasons.push('Lean into Wheat & Fertilizer during the global spike.');
    });
    if (state.briefing.contracts.length > 0) {
      reasons.push('Target contract bonus: ' + state.briefing.contracts[0].label + '.');
    }
    if (reasons.length === 0) {
      reasons.push('Spread ships across open high-demand markets to avoid saturation penalties.');
    }
    return { plan: plan, reasons: reasons };
  }

  return {
    GAME_CONFIG: GAME_CONFIG,
    PORTS: PORTS,
    CHOKEPOINTS: CHOKEPOINTS,
    COUNTRIES: COUNTRIES,
    COMMODITIES: COMMODITIES,
    ROUTES_BY_COUNTRY: ROUTES_BY_COUNTRY,
    mulberry32: mulberry32,
    allocateShipsFromPct: allocateShipsFromPct,
    getUnlockedCountryIds: getUnlockedCountryIds,
    getNewlyUnlockedCountryIds: getNewlyUnlockedCountryIds,
    isRouteClosed: isRouteClosed,
    sanitizeRouteStance: sanitizeRouteStance,
    rebalanceSliders: rebalanceSliders,
    adjustEmptyAwareSliders: adjustEmptyAwareSliders,
    validateAndNormalizePlan: validateAndNormalizePlan,
    createDefaultPlan: createDefaultPlan,
    createEmptyPlan: createEmptyPlan,
    createMatchState: createMatchState,
    resolveRound: resolveRound,
    estimatePlanProfitRange: estimatePlanProfitRange,
    getRankTitle: getRankTitle,
    buildStrategyPlan: buildStrategyPlan,
    getCaptainsHint: getCaptainsHint,
    getCountryById: getCountryById,
    getCommodityById: getCommodityById
  };
}));
