(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TidelineEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // =========================================================================
  // 1. TUNABLE GAME & ECONOMY CONSTANTS (Frozen after sim.js calibration)
  // =========================================================================
  var GAME_CONFIG = {
    ROUNDS: 5,
    FLEET_SCHEDULE: [1, 2, 3, 5, 7],
    UNLOCKED_COUNTRIES_SCHEDULE: [2, 3, 5, 7, 7],
    STARTING_CASH: 2000000,
    SHIP_CAPACITY: 1000,
    ROUND_DURATION_SEC: 300,
    REVEAL_DURATION_SEC: 30,

    // Global calibration knobs (tuned by sim.js autoTune and frozen here)
    MARGIN_SCALE: 0.46,
    VOLATILITY_SCALE: 0.50,
    DEPTH_SCALE: 1.00,
    CONGESTION_SCALE: 0.88,
    INSURANCE_SCALE: 0.78,
    COMPLEXITY_SCALE: 0.42,

    // Par-based scoring anchors (measured over 20,000 Monte Carlo runs)
    PAR_PROFIT: 2250000,
    FLOOR_PROFIT: 100000,

    // Optional Market Intel config
    ENABLE_MARKET_INTEL: true,
    MAX_INTEL_SPEND: 150000,
    INTEL_MAX_REDUCTION: 0.40,
    INTEL_DIMINISHING_K: 55000,

    // Fixed, handling & complexity costs: admin = COMPLEXITY_ALPHA * n_distinct^1.4
    FIXED_OVERHEAD_PER_SHIP: 1800,
    COMPLEXITY_ALPHA: 850,
    COMPLEXITY_EXPONENT: 1.4,

    // Ship & voyage physics
    BASELINE_SPEED_KNOTS: 14.0,
    STANCE_SPEED_MULTS: [1.15, 1.00, 0.85], // Fast & Risky, Balanced, Slow & Safe
    FUEL_BASE_TONS_PER_DAY: 1.56,
    FUEL_SPEED_EXPONENT: 3.0,
    FUEL_PRICE_PER_TON_BASE: 345,
    CREW_COST_PER_DAY: 190,
    WEAR_COST_PER_DAY_BASE: 105,
    WEAR_RATE_BY_STANCE: [0.024, 0.014, 0.008],
    WEAR_DECAY_PER_ROUND: 0.90,
    BREAKDOWN_H0: 0.011,
    BREAKDOWN_BETA_WEAR: 0.95,
    BREAKDOWN_REPAIR_COST: 20000,
    BREAKDOWN_DELAY_MIN: 2,
    BREAKDOWN_DELAY_MAX: 4,

    // Value decay & lateness convexity
    LATENESS_ALPHA: 0.011, // a_k base multiplier on max(0, tau - w)^1.5 * revenue
    LATENESS_WINDOW_SLACK_DAYS: 3.2,

    // Insurance, HHI concentration & deductibles
    INSURANCE_BASE_BY_STANCE: [0.013, 0.0085, 0.005], // r0_route
    INSURANCE_BETA_RISK: 0.36,
    INSURANCE_KAPPA_HHI: 0.55,
    SHOCK_KAPPA_HHI: 0.40,
    INCIDENT_DEDUCTIBLE_RATE: 0.20,
    CONVOY_INS_DISCOUNT_STEP: 0.10, // -10% per extra ship on same lane
    CONVOY_INS_MAX_EXTRA_SHIPS: 2,
    SUEZ_CAPE_HEDGE_FACTOR: 0.18,

    // Experience curve
    EXP_DECAY_RATE: 0.05, // exp(-0.05 * n)
    EXP_FLOOR_MULT: 0.85,
    EXP_UNUSED_ROUNDS_DECAY: 2,

    // Congestion & backlogs
    CONGESTION_D0_DAYS: 0.38,
    CONGESTION_BACKLOG_CARRY: 0.22,

    // Sourcing at Mumbai
    SOURCING_SUPPLY_DEPTH_PER_PLAYER: 2800,
    SOURCING_BASE_MARGIN_DEFAULT: 0.23,

    // Finance, overdraft & seizure
    OVERDRAFT_LIMIT_RATIO: 0.55,
    SEIZURE_NET_WORTH_RATIO: 0.20,
    DEBT_BASE_INTEREST: 0.035,
    DEBT_CONVEX_KAPPA: 0.075,

    // Reputation
    REP_INIT: 0.50,
    REP_RETAIN: 0.85,
    REP_RELIABILITY_GAIN: 0.25,
    REP_FAILURE_PENALTY: 0.60,
    REP_MAX: 1.0,
    REP_MIN: 0.05,

    // Forecast & signals
    FORECAST_ROUND_NOISE_STEP: 0.35, // grows ~35% per round
    SIGNAL_ACCURACY_MIN: 0.50,
    SIGNAL_ACCURACY_MAX: 0.65,

    // Combination weakest-link exponent
    WEAKEST_LINK_THRESHOLD: 0.86,
    WEAKEST_LINK_EXPONENT: 1.15,

    // Par-based Score Index Rank Thresholds
    RANKS: [
      { minIndex: -Infinity, minProfit: -Infinity, title: 'Deckhand' },
      { minIndex: 45,        minProfit: 1067500,   title: 'Mate' },
      { minIndex: 75,        minProfit: 1712500,   title: 'Captain' },
      { minIndex: 105,       minProfit: 2357500,   title: 'Commodore' },
      { minIndex: 135,       minProfit: 3002500,   title: 'Admiral' }
    ]
  };

  // =========================================================================
  // 2. WORLD REGIMES (Latent Markov Chain)
  // =========================================================================
  var REGIMES = ['Calm', 'Tension', 'Crisis'];
  var REGIME_INDEX = { Calm: 0, Tension: 1, Crisis: 2 };
  var REGIME_TRANSITIONS = [
    [0.75, 0.22, 0.03], // Calm ->
    [0.30, 0.55, 0.15], // Tension ->
    [0.15, 0.45, 0.40]  // Crisis ->
  ];
  var REGIME_CRISIS_DRIFT_PER_ROUND = 0.05;

  var REGIME_PARAMS = {
    Calm:    { id: 'Calm',    volMult: 1.0, jumpIntensity: 0.05, corr: 0.10, insMult: 1.0, riskFactor: 0.15, shockScale: 0.65 },
    Tension: { id: 'Tension', volMult: 1.6, jumpIntensity: 0.15, corr: 0.35, insMult: 1.6, riskFactor: 0.55, shockScale: 1.05 },
    Crisis:  { id: 'Crisis',  volMult: 2.6, jumpIntensity: 0.35, corr: 0.70, insMult: 3.0, riskFactor: 1.10, shockScale: 1.60 }
  };

  // =========================================================================
  // 3. WORLD MODEL: PORTS, CHOKEPOINTS, COUNTRIES, COMMODITIES, ROUTES
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
    bab_el_mandeb: { id: 'bab_el_mandeb', name: 'Bab-el-Mandeb',       lon: 43.4,  lat: 12.6,  tag: 'redsea',               baseCap: 4.2 },
    suez:          { id: 'suez',          name: 'Suez Canal',          lon: 32.55, lat: 30.0,  tag: 'suez',                 baseCap: 4.4 },
    gibraltar:     { id: 'gibraltar',     name: 'Strait of Gibraltar', lon: -5.6,  lat: 36.0,  tag: 'med',                  baseCap: 6.5 },
    dover:         { id: 'dover',         name: 'Dover Strait',        lon: 1.5,   lat: 51.0,  tag: 'north-atlantic-storm', baseCap: 4.8 },
    danish:        { id: 'danish',        name: 'Danish Straits',      lon: 10.6,  lat: 57.7,  tag: 'baltic-sanctions',     baseCap: 3.4 },
    cape:          { id: 'cape',          name: 'Cape of Good Hope',   lon: 18.4,  lat: -34.8, tag: 'cape',                 baseCap: 7.5 },
    sunda:         { id: 'sunda',         name: 'Sunda Strait',        lon: 105.9, lat: -6.0,  tag: 'malacca-piracy',       baseCap: 3.8 },
    lombok:        { id: 'lombok',        name: 'Lombok Strait',       lon: 115.7, lat: -8.8,  tag: 'malacca-piracy',       baseCap: 3.8 }
  };

  var COUNTRIES = [
    {
      id: 'germany',
      name: 'Germany',
      portName: 'Hamburg',
      lon: 9.97,
      lat: 53.54,
      portFee: 21000,
      portCapacity: 3.6,
      exchangeRate: 1.03,
      baseTariff: 0.035,
      demandDepthPerPlayer: 1050,
      demand: { crude_oil: 1.06, wheat: 0.94, fertilizer: 0.98, spices_tea: 0.95, textiles: 1.00, electronics: 1.08 }
    },
    {
      id: 'uk',
      name: 'UK',
      portName: 'Southampton',
      lon: -1.40,
      lat: 50.90,
      portFee: 15500,
      portCapacity: 3.5,
      exchangeRate: 1.02,
      baseTariff: 0.032,
      demandDepthPerPlayer: 1020,
      demand: { crude_oil: 0.97, wheat: 1.01, fertilizer: 0.93, spices_tea: 1.11, textiles: 1.07, electronics: 1.02 }
    },
    {
      id: 'france',
      name: 'France',
      portName: 'Marseille',
      lon: 5.37,
      lat: 43.30,
      portFee: 14500,
      portCapacity: 3.6,
      exchangeRate: 1.01,
      baseTariff: 0.032,
      demandDepthPerPlayer: 1000,
      demand: { crude_oil: 0.98, wheat: 1.03, fertilizer: 1.01, spices_tea: 1.10, textiles: 1.06, electronics: 0.97 }
    },
    {
      id: 'russia',
      name: 'Russia',
      portName: 'St. Petersburg',
      lon: 30.25,
      lat: 59.90,
      portFee: 16500,
      portCapacity: 2.9,
      exchangeRate: 1.03,
      baseTariff: 0.048,
      demandDepthPerPlayer: 920,
      demand: { crude_oil: 0.72, wheat: 1.11, fertilizer: 1.09, spices_tea: 1.02, textiles: 1.03, electronics: 1.09 }
    },
    {
      id: 'usa',
      name: 'USA',
      portName: 'New York',
      lon: -74.04,
      lat: 40.68,
      portFee: 18500,
      portCapacity: 4.0,
      exchangeRate: 1.03,
      baseTariff: 0.036,
      demandDepthPerPlayer: 1180,
      demand: { crude_oil: 1.03, wheat: 0.93, fertilizer: 1.01, spices_tea: 1.01, textiles: 1.08, electronics: 1.09 }
    },
    {
      id: 'australia',
      name: 'Australia',
      portName: 'Fremantle',
      lon: 115.74,
      lat: -32.05,
      portFee: 14500,
      portCapacity: 3.2,
      exchangeRate: 0.99,
      baseTariff: 0.025,
      demandDepthPerPlayer: 920,
      demand: { crude_oil: 1.06, wheat: 0.80, fertilizer: 1.08, spices_tea: 0.99, textiles: 1.03, electronics: 1.05 }
    },
    {
      id: 'new_zealand',
      name: 'New Zealand',
      portName: 'Auckland',
      lon: 174.77,
      lat: -36.84,
      portFee: 14000,
      portCapacity: 3.0,
      exchangeRate: 1.00,
      baseTariff: 0.025,
      demandDepthPerPlayer: 880,
      demand: { crude_oil: 1.05, wheat: 0.84, fertilizer: 1.09, spices_tea: 1.00, textiles: 1.02, electronics: 1.06 }
    }
  ];

  var COMMODITIES = [
    {
      id: 'crude_oil',
      name: 'Crude Oil',
      shortName: 'Crude',
      unit: 'bbl eq.',
      baseBuyPrice: 445,
      baseSellPrice: 575,
      baseMargin: 0.225,
      weightClass: 1.18,
      spoilagePerDay: 0.0005, // 0.05%/day
      theta: 0.38,
      sigma: 0.14,
      jumpScale: 0.15,
      volatility: 0.14,
      tariffSensitivity: 0.7,
      sanctionSensitivity: 0.6,
      elasticity: 0.70,
      latenessAlpha: 0.014,
      color: '#1E293B',
      desc: 'Energy benchmark; spikes in Tension/Crisis but heavy weight pushes fuel burn.'
    },
    {
      id: 'wheat',
      name: 'Wheat',
      shortName: 'Wheat',
      unit: 'mt',
      baseBuyPrice: 425,
      baseSellPrice: 555,
      baseMargin: 0.23,
      weightClass: 1.04,
      spoilagePerDay: 0.0020, // 0.20%/day
      theta: 0.36,
      sigma: 0.13,
      jumpScale: 0.14,
      volatility: 0.13,
      tariffSensitivity: 0.7,
      sanctionSensitivity: 0.3,
      elasticity: 0.68,
      latenessAlpha: 0.015,
      color: '#D97706',
      desc: 'Food staple; steady on bulk lanes, spoils gradually on extended Cape detours.'
    },
    {
      id: 'fertilizer',
      name: 'Fertilizer',
      shortName: 'Fert.',
      unit: 'mt',
      baseBuyPrice: 432,
      baseSellPrice: 560,
      baseMargin: 0.225,
      weightClass: 1.20,
      spoilagePerDay: 0.0010, // 0.1%/day
      theta: 0.34,
      sigma: 0.14,
      jumpScale: 0.15,
      volatility: 0.14,
      tariffSensitivity: 0.7,
      sanctionSensitivity: 0.6,
      elasticity: 0.68,
      latenessAlpha: 0.014,
      color: '#15803D',
      desc: 'Heavy agricultural input; thrives in farming seasons & slow bulk corridors.'
    },
    {
      id: 'spices_tea',
      name: 'Spices & Tea',
      shortName: 'Spices',
      unit: 'crates',
      baseBuyPrice: 440,
      baseSellPrice: 590,
      baseMargin: 0.25,
      weightClass: 0.84,
      spoilagePerDay: 0.0075, // 0.75%/day
      theta: 0.42,
      sigma: 0.11,
      jumpScale: 0.12,
      volatility: 0.11,
      tariffSensitivity: 0.6,
      sanctionSensitivity: 0.2,
      elasticity: 0.66,
      latenessAlpha: 0.018,
      color: '#B45309',
      desc: 'Perishable high-margin cargo; rapid decay on long Cape routes.'
    },
    {
      id: 'textiles',
      name: 'Textiles',
      shortName: 'Textiles',
      unit: 'bales',
      baseBuyPrice: 438,
      baseSellPrice: 570,
      baseMargin: 0.23,
      weightClass: 0.90,
      spoilagePerDay: 0.0030, // 0.30%/day
      theta: 0.40,
      sigma: 0.11,
      jumpScale: 0.12,
      volatility: 0.11,
      tariffSensitivity: 1.35,
      sanctionSensitivity: 0.4,
      elasticity: 0.66,
      latenessAlpha: 0.017,
      color: '#0F766E',
      desc: 'Consumer textiles; sensitive to trade tariffs and retail lateness penalties.'
    },
    {
      id: 'electronics',
      name: 'Electronics',
      shortName: 'Tech',
      unit: 'pallets',
      baseBuyPrice: 482,
      baseSellPrice: 635,
      baseMargin: 0.24,
      weightClass: 0.80,
      spoilagePerDay: 0.0052, // 0.52%/day
      theta: 0.38,
      sigma: 0.14,
      jumpScale: 0.15,
      volatility: 0.14,
      tariffSensitivity: 1.10,
      sanctionSensitivity: 1.85,
      elasticity: 0.70,
      latenessAlpha: 0.020,
      color: '#1D4ED8',
      desc: 'High capital & obsolescence decay; rewards express reliability, punished by sanctions.'
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
    var capeTags = ['cape'].concat(extraTags || []);
    return [
      {
        id: countryId + '_suez_fast',
        countryId: countryId,
        stanceIndex: 0,
        stanceLabel: 'Fast & Risky',
        label: 'Suez Express',
        corridor: 'Via Suez & Red Sea',
        corridorKind: 'suez',
        riskFactor: 'redsea',
        knots: Math.round(GAME_CONFIG.BASELINE_SPEED_KNOTS * GAME_CONFIG.STANCE_SPEED_MULTS[0] * 10) / 10,
        toll: 16000,
        basePiracy: 0.028,
        baseWeather: 0.016,
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
        corridorKind: 'suez',
        riskFactor: 'redsea',
        knots: GAME_CONFIG.BASELINE_SPEED_KNOTS,
        toll: 16000,
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
        corridorKind: 'cape',
        riskFactor: 'cape_storm',
        knots: Math.round(GAME_CONFIG.BASELINE_SPEED_KNOTS * GAME_CONFIG.STANCE_SPEED_MULTS[2] * 10) / 10,
        toll: 0,
        basePiracy: 0.005,
        baseWeather: 0.025,
        waypoints: capeWp,
        distanceNm: capeDist,
        tags: capeTags,
        chokepoints: ['cape']
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
        corridor: 'Open Ocean (16.1 kn)',
        corridorKind: 'open',
        riskFactor: 'indian_cyclone',
        knots: Math.round(GAME_CONFIG.BASELINE_SPEED_KNOTS * GAME_CONFIG.STANCE_SPEED_MULTS[0] * 10) / 10,
        toll: 0,
        basePiracy: 0.008,
        baseWeather: 0.032,
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
        corridorKind: 'open',
        riskFactor: 'indian_cyclone',
        knots: GAME_CONFIG.BASELINE_SPEED_KNOTS,
        toll: 0,
        basePiracy: 0.006,
        baseWeather: 0.022,
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
        corridor: 'Sheltered Strait (11.9 kn)',
        corridorKind: 'strait',
        riskFactor: 'malacca_piracy',
        knots: Math.round(GAME_CONFIG.BASELINE_SPEED_KNOTS * GAME_CONFIG.STANCE_SPEED_MULTS[2] * 10) / 10,
        toll: 6000,
        basePiracy: 0.018,
        baseWeather: 0.010,
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
        corridor: 'Southern Ocean (16.1 kn)',
        corridorKind: 'open',
        riskFactor: 'indian_cyclone',
        knots: Math.round(GAME_CONFIG.BASELINE_SPEED_KNOTS * GAME_CONFIG.STANCE_SPEED_MULTS[0] * 10) / 10,
        toll: 0,
        basePiracy: 0.006,
        baseWeather: 0.036,
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
        corridorKind: 'open',
        riskFactor: 'indian_cyclone',
        knots: GAME_CONFIG.BASELINE_SPEED_KNOTS,
        toll: 0,
        basePiracy: 0.005,
        baseWeather: 0.025,
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
        corridor: 'Northern Passage (11.9 kn)',
        corridorKind: 'strait',
        riskFactor: 'malacca_piracy',
        knots: Math.round(GAME_CONFIG.BASELINE_SPEED_KNOTS * GAME_CONFIG.STANCE_SPEED_MULTS[2] * 10) / 10,
        toll: 7500,
        basePiracy: 0.016,
        baseWeather: 0.012,
        waypoints: WAYPOINTS.nz_lombok,
        distanceNm: pathLengthNm(WAYPOINTS.nz_lombok),
        tags: ['malacca-piracy'],
        chokepoints: ['lombok']
      }
    ]
  };

  ROUTES_BY_COUNTRY.uk.forEach(function (r) { r.chokepoints = r.chokepoints.concat(['dover']); });
  ROUTES_BY_COUNTRY.germany.forEach(function (r) { r.chokepoints = r.chokepoints.concat(['dover']); });
  ROUTES_BY_COUNTRY.russia.forEach(function (r) { r.chokepoints = r.chokepoints.concat(['dover', 'danish']); });

  // =========================================================================
  // 4. DETERMINISTIC SEEDED PRNG, MATH & DISTRIBUTIONS
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
    if (!Number.isFinite(val)) return min;
    return val < min ? min : val > max ? max : val;
  }

  function randNormal(rng) {
    var u1 = Math.max(1e-7, rng());
    var u2 = rng();
    return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  }

  // Student-t with df degrees of freedom (df=3 or 4 -> heavy tails, finite variance)
  function randStudentT(df, rng) {
    var z = randNormal(rng);
    var chi2 = 0;
    for (var i = 0; i < df; i++) {
      var n = randNormal(rng);
      chi2 += n * n;
    }
    return z / Math.sqrt(Math.max(0.05, chi2) / df);
  }

  function cholesky(matrix) {
    var n = matrix.length;
    var L = new Array(n);
    for (var i = 0; i < n; i++) {
      L[i] = new Array(n);
      for (var j = 0; j < n; j++) L[i][j] = 0;
      for (var j2 = 0; j2 <= i; j2++) {
        var sum = 0;
        for (var k = 0; k < j2; k++) sum += L[i][k] * L[j2][k];
        if (i === j2) {
          var diag = Math.max(1e-6, matrix[i][i] - sum);
          L[i][j2] = Math.sqrt(diag);
        } else {
          L[i][j2] = (matrix[i][j2] - sum) / Math.max(1e-6, L[j2][j2]);
        }
      }
    }
    return L;
  }

  // Smooth strictly decreasing saturation curve S(u), no kinks:
  function saturationCurve(u) {
    var x = Math.max(0, Number(u) || 0);
    return 0.25 + 0.80 / (1 + 0.095 * Math.pow(x, 2.0));
  }

  function intelErrorMultiplier(intelSpend) {
    if (!GAME_CONFIG.ENABLE_MARKET_INTEL) return 1.0;
    var spend = clamp(Number(intelSpend) || 0, 0, GAME_CONFIG.MAX_INTEL_SPEND);
    if (spend <= 0) return 1.0;
    var maxNum = 1 - Math.exp(-GAME_CONFIG.MAX_INTEL_SPEND / GAME_CONFIG.INTEL_DIMINISHING_K);
    var frac = (1 - Math.exp(-spend / GAME_CONFIG.INTEL_DIMINISHING_K)) / maxNum;
    return 1.0 - GAME_CONFIG.INTEL_MAX_REDUCTION * frac;
  }

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

  // =========================================================================
  // 5. REGIME MARKOV CHAIN, SEASONALITY & COMBINATION INTERACTION LAYER
  // =========================================================================
  function getRegimeTransitionProbs(curRegime, round) {
    var idx = REGIME_INDEX[curRegime] != null ? REGIME_INDEX[curRegime] : 0;
    var base = REGIME_TRANSITIONS[idx].slice();
    var drift = Math.max(0, (round || 1) - 1) * REGIME_CRISIS_DRIFT_PER_ROUND;
    var pCrisis = clamp(base[2] + drift, 0.01, 0.85);
    var remBase = base[0] + base[1];
    var remNew = Math.max(0.01, 1.0 - pCrisis);
    var pCalm = remBase > 0 ? (base[0] / remBase) * remNew : remNew * 0.5;
    var pTension = remBase > 0 ? (base[1] / remBase) * remNew : remNew * 0.5;
    return [pCalm, pTension, pCrisis];
  }

  function stepRegime(curRegime, round, rng) {
    var probs = getRegimeTransitionProbs(curRegime, round);
    var u = rng();
    if (u < probs[0]) return 'Calm';
    if (u < probs[0] + probs[1]) return 'Tension';
    return 'Crisis';
  }

  function buildCommodityCorrMatrix(regimeId) {
    var baseRho = REGIME_PARAMS[regimeId] ? REGIME_PARAMS[regimeId].corr : 0.10;
    var n = COMMODITIES.length;
    var mat = [];
    for (var i = 0; i < n; i++) {
      mat[i] = [];
      for (var j = 0; j < n; j++) {
        if (i === j) {
          mat[i][j] = 1.0;
        } else {
          var ci = COMMODITIES[i].id;
          var cj = COMMODITIES[j].id;
          var extra = 0;
          if ((ci === 'crude_oil' && cj === 'fertilizer') || (cj === 'crude_oil' && ci === 'fertilizer')) extra = 0.22;
          else if ((ci === 'crude_oil' && cj === 'wheat') || (cj === 'crude_oil' && ci === 'wheat')) extra = 0.14;
          else if ((ci === 'wheat' && cj === 'fertilizer') || (cj === 'wheat' && ci === 'fertilizer')) extra = 0.18;
          else if ((ci === 'textiles' && cj === 'electronics') || (cj === 'textiles' && ci === 'electronics')) extra = 0.12;
          mat[i][j] = Math.min(0.88, baseRho + extra * (1 - baseRho * 0.35));
        }
      }
    }
    return mat;
  }

  // Round seasonality factor per (commodity, country) so optimal targets rotate cleanly across rounds
  function getSeasonalFactor(commodityId, countryId, round) {
    var r = ((Number(round) || 1) - 1) % 5;
    var table = {
      'fertilizer:australia':   [1.26, 0.78, 0.90, 1.26, 0.80],
      'fertilizer:new_zealand': [0.86, 1.28, 0.86, 0.98, 1.26],
      'fertilizer:russia':      [0.88, 0.94, 1.30, 0.92, 1.28],
      'spices_tea:uk':          [1.30, 0.84, 1.20, 0.88, 0.96],
      'spices_tea:france':      [1.06, 1.32, 0.86, 1.18, 0.92],
      'crude_oil:germany':      [0.88, 1.02, 1.32, 0.86, 1.28],
      'crude_oil:usa':          [0.88, 1.22, 0.96, 1.32, 1.08],
      'crude_oil:australia':    [0.90, 1.16, 0.94, 1.16, 0.90],
      'wheat:russia':           [0.86, 1.26, 1.28, 1.18, 1.32],
      'wheat:france':           [1.02, 0.90, 1.30, 1.04, 1.12],
      'textiles:usa':           [1.26, 1.24, 0.94, 0.80, 1.12],
      'textiles:uk':            [0.96, 1.22, 1.02, 1.30, 1.04],
      'electronics:germany':    [1.18, 1.32, 0.86, 1.30, 0.90],
      'electronics:usa':        [1.30, 0.94, 1.28, 1.08, 0.88],
      'electronics:australia':  [0.86, 1.00, 1.24, 0.88, 1.18]
    };
    var row = table[commodityId + ':' + countryId];
    if (row) return row[r];
    return 1.0;
  }

  // Pair scores in [0.40, 1.50] + Triple Weakest-Link Multiplier + 15 Hand-Coded Special Cases
  function evaluateTripleCombination(stanceIndex, commodityId, countryId, regimeId, context) {
    var ctx = context || {};
    var round = ctx.round || 1;
    var activeFlags = ctx.flags || {};
    var route = ROUTES_BY_COUNTRY[countryId][clamp(Number(stanceIndex) || 0, 0, 2)];
    var notes = [];

    // 1. F_rk (Route x Commodity in [0.40, 1.50])
    var F_rk = 1.0;
    if (commodityId === 'spices_tea') {
      if (stanceIndex === 0) F_rk = regimeId === 'Calm' ? 1.28 : (regimeId === 'Tension' ? 0.92 : 0.72);
      else if (stanceIndex === 1) F_rk = regimeId === 'Calm' ? 1.08 : (regimeId === 'Tension' ? 0.98 : 0.80);
      else F_rk = 0.66; // Special Case #1: perishables on slow Cape/strait drag
    } else if (commodityId === 'wheat') {
      if (stanceIndex === 0) F_rk = regimeId === 'Calm' ? 0.90 : 0.76;
      else if (stanceIndex === 1) F_rk = regimeId === 'Tension' ? 1.18 : 0.98;
      else F_rk = regimeId === 'Crisis' ? 1.26 : (regimeId === 'Tension' ? 1.02 : 0.88); // Special Case #7
    } else if (commodityId === 'fertilizer') {
      if (stanceIndex === 0) F_rk = 0.68; // Special Case #13: heavy bulk on fast route burns steep fuel
      else if (stanceIndex === 1) F_rk = regimeId === 'Tension' ? 1.18 : (regimeId === 'Calm' ? 0.90 : 0.98);
      else F_rk = regimeId === 'Calm' ? 0.88 : (regimeId === 'Tension' ? 0.98 : 1.26); // Special Case #7
    } else if (commodityId === 'crude_oil') {
      if (route.corridorKind === 'suez') {
        if (regimeId === 'Crisis') F_rk = 0.60; // Special Case #5: Crude via Red Sea in Crisis
        else if (regimeId === 'Tension') F_rk = stanceIndex === 0 ? 0.76 : 1.12;
        else F_rk = stanceIndex === 0 ? 0.84 : 0.98;
      } else {
        if (stanceIndex === 2) F_rk = regimeId === 'Crisis' ? 1.28 : (regimeId === 'Tension' ? 1.04 : 0.88); // Special Case #15
        else F_rk = stanceIndex === 0 ? 0.74 : 1.00;
      }
    } else if (commodityId === 'textiles') {
      if (stanceIndex === 0) F_rk = regimeId === 'Calm' ? 1.12 : 0.82;
      else if (stanceIndex === 1) F_rk = regimeId === 'Tension' ? 1.22 : (regimeId === 'Calm' ? 1.02 : 0.86);
      else F_rk = regimeId === 'Calm' ? 0.86 : 0.96;
    } else if (commodityId === 'electronics') {
      if (stanceIndex === 0) F_rk = regimeId === 'Calm' ? 1.30 : (regimeId === 'Tension' ? 0.96 : 0.68); // Special Case #6/#11
      else if (stanceIndex === 1) F_rk = regimeId === 'Crisis' ? 0.80 : 1.04;
      else F_rk = 0.66; // Special Case #14: capital tied up + decay on slow route
    }

    // 2. D_kc (Commodity x Country in [0.40, 1.50])
    var D_kc = 1.0;
    var season = getSeasonalFactor(commodityId, countryId, round);
    D_kc *= (0.48 + 0.52 * season);

    if (countryId === 'russia' && commodityId === 'electronics') {
      if (activeFlags.russiaTechBan || round >= 3) {
        D_kc = 0.50; // Special Case #2: Electronics to Russia under sanctions
        notes.push('Sanctioned tech lane: heavy confiscation risk');
      } else {
        D_kc = regimeId === 'Calm' ? 1.12 : 0.92;
      }
    } else if (countryId === 'russia' && commodityId === 'crude_oil') {
      D_kc = 0.58; // Special Case #9: Russia is energy exporter
      notes.push('Energy exporter market: weak crude spread');
    } else if (countryId === 'australia' && commodityId === 'wheat') {
      D_kc = 0.62; // Special Case #10: Australia wheat surplus
      notes.push('Local grain surplus compresses wheat price');
    } else if (countryId === 'new_zealand' && commodityId === 'wheat') {
      D_kc = 0.70;
    } else if (countryId === 'usa' && commodityId === 'textiles' && (activeFlags.usTexTariff || round === 4)) {
      D_kc = 0.64; // Special Case #3: US Textile Tariff
      notes.push('Tariff barrier drags US textile margin');
    } else if ((countryId === 'australia' || countryId === 'new_zealand') && commodityId === 'fertilizer') {
      D_kc *= (regimeId === 'Calm' ? 0.90 : (regimeId === 'Tension' ? 1.10 : 1.18)); // Special Case #4
      notes.push('Planting season boost for fertilizer');
    } else if (countryId === 'germany' && commodityId === 'electronics') {
      D_kc *= (regimeId === 'Calm' ? 1.18 : (regimeId === 'Tension' ? 0.98 : 0.80)); // Special Case #6
    } else if ((countryId === 'uk' || countryId === 'france') && commodityId === 'spices_tea') {
      D_kc *= (regimeId === 'Calm' ? 1.20 : (regimeId === 'Tension' ? 1.02 : 0.84)); // Special Case #8
    } else if (countryId === 'russia' && (commodityId === 'wheat' || commodityId === 'fertilizer')) {
      D_kc *= (regimeId === 'Crisis' ? 1.22 : (regimeId === 'Tension' ? 1.12 : 0.92));
    } else if (countryId === 'usa' && commodityId === 'crude_oil') {
      D_kc *= (regimeId === 'Crisis' ? 1.24 : (regimeId === 'Tension' ? 1.08 : 0.90));
    } else if ((countryId === 'uk' || countryId === 'france') && commodityId === 'textiles') {
      D_kc *= (regimeId === 'Tension' ? 1.18 : (regimeId === 'Calm' ? 1.02 : 0.90)); // Special Case #12
    } else if (countryId === 'usa' && commodityId === 'electronics') {
      D_kc *= (regimeId === 'Calm' ? 1.18 : (regimeId === 'Tension' ? 1.02 : 0.78));
    } else if (countryId === 'germany' && commodityId === 'crude_oil') {
      D_kc *= (regimeId === 'Crisis' ? 1.22 : (regimeId === 'Tension' ? 1.16 : 0.90));
    } else if (countryId === 'france' && commodityId === 'wheat') {
      D_kc *= (regimeId === 'Tension' ? 1.16 : (regimeId === 'Crisis' ? 1.14 : 0.92));
    }

    // 3. G_rc (Route x Country in [0.40, 1.50])
    var G_rc = 1.0;
    if (countryId === 'usa' || countryId === 'uk' || countryId === 'germany' || countryId === 'russia') {
      if (stanceIndex === 2) {
        G_rc = regimeId === 'Crisis' ? 1.24 : (regimeId === 'Tension' ? 0.96 : 0.78);
        if (commodityId === 'spices_tea' || commodityId === 'electronics') {
          G_rc *= 0.84; // Special Case #1/#14 far Cape drag for time-sensitive cargo
          notes.push('Perishable/time-sensitive cargo on far Cape detour');
        }
      } else if (stanceIndex === 0) {
        G_rc = regimeId === 'Calm' ? 1.20 : (regimeId === 'Tension' ? 0.92 : 0.64);
      } else {
        G_rc = regimeId === 'Crisis' ? 0.76 : (regimeId === 'Tension' ? 1.16 : 1.00);
      }
      if (countryId === 'russia' && stanceIndex === 0 && regimeId !== 'Calm') {
        G_rc *= 0.80;
      }
      if (countryId === 'germany' && stanceIndex === 0 && activeFlags.hamburgStrike) {
        G_rc *= 0.78;
        notes.push('Express Germany timing breaks if Hamburg strikes');
      }
    } else if (countryId === 'france') {
      if (stanceIndex === 2) {
        G_rc = regimeId === 'Crisis' ? 1.16 : 0.72;
        if (commodityId === 'spices_tea') notes.push('Cape detour severely delays Marseille spices');
      } else if (stanceIndex === 0) {
        G_rc = regimeId === 'Calm' ? 1.22 : (regimeId === 'Tension' ? 0.94 : 0.68);
      } else {
        G_rc = regimeId === 'Crisis' ? 0.78 : (regimeId === 'Tension' ? 1.18 : 1.04);
      }
    } else {
      // Australia & New Zealand
      if (stanceIndex === 0) {
        G_rc = regimeId === 'Calm' ? 1.16 : (regimeId === 'Tension' ? 0.90 : 0.68);
        if (activeFlags.indianCyclone) G_rc *= 0.82;
      } else if (stanceIndex === 1) {
        G_rc = regimeId === 'Tension' ? 1.14 : (regimeId === 'Calm' ? 0.98 : 0.86);
      } else {
        G_rc = regimeId === 'Crisis' ? 1.18 : (regimeId === 'Tension' ? 0.96 : 0.84);
      }
    }

    F_rk = clamp(F_rk, 0.45, 1.45);
    D_kc = clamp(D_kc, 0.45, 1.45);
    G_rc = clamp(G_rc, 0.45, 1.45);

    var geoMean = Math.cbrt(F_rk * D_kc * G_rc);
    var weakLink = Math.min(F_rk, D_kc, G_rc);
    var weakMult = weakLink < GAME_CONFIG.WEAKEST_LINK_THRESHOLD
      ? Math.pow(weakLink / GAME_CONFIG.WEAKEST_LINK_THRESHOLD, GAME_CONFIG.WEAKEST_LINK_EXPONENT)
      : 1.0;

    // Seasonal timing rotates best combos across rounds without clipping peak rounds flat
    var seasonPulse = 0.88 + 0.12 * season;
    var tripleMult = clamp(geoMean * weakMult * seasonPulse, 0.91, 1.15);

    // Extra round-rotating regime-dependent triple synergy notes
    if (countryId === 'germany' && commodityId === 'electronics' && stanceIndex === 0 && regimeId === 'Calm') {
      tripleMult = Math.min(1.15, tripleMult * 1.02);
      notes.push('Hamburg express electronics synergy');
    }
    if (countryId === 'france' && commodityId === 'spices_tea' && stanceIndex <= 1 && regimeId === 'Calm') {
      notes.push('Marseille spice corridor bonus');
    }
    if ((countryId === 'usa' || countryId === 'germany') && commodityId === 'crude_oil' && stanceIndex === 2 && regimeId === 'Crisis') {
      tripleMult = Math.min(1.15, tripleMult * 1.02);
      notes.push('Cape tanker bypass protects crisis oil margin');
    }
    if (commodityId === 'crude_oil' && route.corridorKind === 'suez' && regimeId === 'Crisis') {
      notes.push('Crude in Red Sea during Crisis: war-risk spike');
    }
    if ((commodityId === 'wheat' || commodityId === 'fertilizer') && stanceIndex === 2 && regimeId !== 'Calm') {
      notes.push('Bulk cargo on Safe corridor: steady resilience');
    }

    return {
      F_rk: F_rk,
      D_kc: D_kc,
      G_rc: G_rc,
      geoMean: geoMean,
      weakLink: weakLink,
      weakMult: weakMult,
      tripleMult: tripleMult,
      notes: notes
    };
  }

  // =========================================================================
  // 6. PLAN NORMALIZATION & SHIP-LEVEL TRIPLE ALLOCATION
  // =========================================================================
  // Largest-remainder rounding from percentages [0..100] -> whole integer counts summing to totalCount
  function largestRemainderAllocate(pctMap, keys, totalCount) {
    var out = {};
    keys.forEach(function (k) { out[k] = 0; });
    if (totalCount <= 0 || !keys.length) return out;

    var sumPct = 0;
    var raw = keys.map(function (k) {
      var p = Math.max(0, Number(pctMap && pctMap[k]) || 0);
      sumPct += p;
      return { id: k, pct: p };
    });

    if (sumPct <= 0) {
      out[keys[0]] = totalCount;
      return out;
    }

    var assigned = 0;
    raw.forEach(function (item) {
      var exact = (item.pct / sumPct) * totalCount;
      item.floor = Math.floor(exact);
      item.rem = exact - item.floor;
      assigned += item.floor;
    });

    var remaining = totalCount - assigned;
    raw.sort(function (a, b) {
      if (Math.abs(b.rem - a.rem) > 1e-9) return b.rem - a.rem;
      if (b.pct !== a.pct) return b.pct - a.pct;
      return a.id < b.id ? -1 : 1;
    });
    for (var i = 0; i < remaining; i++) {
      raw[i % raw.length].floor += 1;
    }
    raw.forEach(function (item) { out[item.id] = item.floor; });
    return out;
  }

  function allocateShipsFromPct(countryPct, fleetSize) {
    var ids = COUNTRIES.map(function (c) { return c.id; });
    return largestRemainderAllocate(countryPct, ids, fleetSize);
  }

  function allocateCommoditiesToShips(commodityPct, shipCount) {
    var ids = COMMODITIES.map(function (c) { return c.id; });
    return largestRemainderAllocate(commodityPct, ids, shipCount);
  }

  function createEmptyPlan() {
    var countryPct = {};
    COUNTRIES.forEach(function (c) { countryPct[c.id] = 0; });
    var commodityPct = {};
    COMMODITIES.forEach(function (c) { commodityPct[c.id] = 0; });
    var routeStance = {};
    COUNTRIES.forEach(function (c) { routeStance[c.id] = null; });
    return {
      countryPct: countryPct,
      commodityPct: commodityPct,
      commodityPctByCountry: null,
      routeStance: routeStance,
      intelSpend: 0
    };
  }

  function createDefaultPlan(closedTags, unlockedCountries) {
    var countryPct = {};
    COUNTRIES.forEach(function (c) { countryPct[c.id] = 0; });
    if (unlockedCountries && unlockedCountries.length) {
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
    return {
      countryPct: countryPct,
      commodityPct: commodityPct,
      commodityPctByCountry: null,
      routeStance: routeStance,
      intelSpend: 0
    };
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
    for (var i = options.length - 1; i >= 0; i--) {
      if (!isRouteClosed(options[i], closedTags)) return i;
    }
    return options.length - 1;
  }

  function normalizePercentages(obj, keys) {
    var out = {};
    var sum = 0;
    for (var i = 0; i < keys.length; i++) {
      var v = Math.max(0, Math.min(100, Number(obj && obj[keys[i]]) || 0));
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

    var commodityPctByCountry = null;
    if (plan && plan.commodityPctByCountry && typeof plan.commodityPctByCountry === 'object') {
      var hasCustom = false;
      var customMap = {};
      cKeys.forEach(function (cid) {
        var rawMap = plan.commodityPctByCountry[cid];
        if (rawMap && typeof rawMap === 'object') {
          var s = 0;
          mKeys.forEach(function (mk) { s += Math.max(0, Number(rawMap[mk]) || 0); });
          if (s > 0) {
            customMap[cid] = normalizePercentages(rawMap, mKeys);
            hasCustom = true;
          }
        }
      });
      if (hasCustom) commodityPctByCountry = customMap;
    }

    var routeStance = {};
    for (var i = 0; i < cKeys.length; i++) {
      var cid = cKeys[i];
      var rawStance = (plan && plan.routeStance && plan.routeStance[cid] != null) ? plan.routeStance[cid] : 1;
      routeStance[cid] = sanitizeRouteStance(cid, rawStance, closedTags);
    }

    var intelSpend = GAME_CONFIG.ENABLE_MARKET_INTEL
      ? clamp(Math.round((Number(plan && plan.intelSpend) || 0) / 25000) * 25000, 0, GAME_CONFIG.MAX_INTEL_SPEND)
      : 0;

    return {
      countryPct: countryPct,
      commodityPct: commodityPct,
      commodityPctByCountry: commodityPctByCountry,
      routeStance: routeStance,
      intelSpend: intelSpend,
      shipTriples: plan && Array.isArray(plan.shipTriples) ? plan.shipTriples.slice() : null
    };
  }

  function expandPlanToShipTriples(plan, fleetSize, closedTags, unlockedCountries) {
    var norm = validateAndNormalizePlan(plan, closedTags, unlockedCountries);
    if (norm.shipTriples && norm.shipTriples.length === fleetSize) {
      return norm.shipTriples.map(function (t, idx) {
        var cid = getCountryById(t.countryId) ? t.countryId : (unlockedCountries && unlockedCountries[0]) || 'germany';
        if (unlockedCountries && unlockedCountries.length && unlockedCountries.indexOf(cid) === -1) {
          cid = unlockedCountries[0];
        }
        var kid = getCommodityById(t.commodityId) ? t.commodityId : 'spices_tea';
        var st = sanitizeRouteStance(cid, t.stanceIndex, closedTags);
        return {
          shipIndex: idx,
          countryId: cid,
          commodityId: kid,
          stanceIndex: st,
          route: ROUTES_BY_COUNTRY[cid][st]
        };
      });
    }

    var shipAlloc = allocateShipsFromPct(norm.countryPct, fleetSize);
    var triples = [];
    var idx = 0;
    COUNTRIES.forEach(function (co) {
      var count = shipAlloc[co.id] || 0;
      if (count <= 0) return;
      var st = sanitizeRouteStance(co.id, norm.routeStance[co.id], closedTags);
      var route = ROUTES_BY_COUNTRY[co.id][st];
      var mix = (norm.commodityPctByCountry && norm.commodityPctByCountry[co.id])
        ? norm.commodityPctByCountry[co.id]
        : norm.commodityPct;
      var commCounts = allocateCommoditiesToShips(mix, count);
      COMMODITIES.forEach(function (cm) {
        var cNum = commCounts[cm.id] || 0;
        for (var s = 0; s < cNum; s++) {
          triples.push({
            shipIndex: idx++,
            countryId: co.id,
            commodityId: cm.id,
            stanceIndex: st,
            route: route
          });
        }
      });
    });
    return triples;
  }

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
  // 7. NOISY BRIEFINGS, LATENT SIGNALS & CONTRACTS
  // =========================================================================
  var SURPRISE_POOL = [
    {
      id: 'surprise_port_backlog',
      title: 'Container Yard Bottleneck',
      desc: 'Unexpected customs backlog slows arrivals in Northern Europe (+2.4 days, +$16k port fee).',
      targetType: 'routeTag',
      target: 'north-atlantic-storm',
      delayDays: 2.4,
      feeAdd: 16000,
      severity: 'warn'
    },
    {
      id: 'surprise_spice_festival',
      title: 'European Culinary Boom',
      desc: 'Sudden spike in European demand surges Spices & Tea prices.',
      targetType: 'commodity',
      target: 'spices_tea',
      priceShock: 0.20,
      severity: 'good'
    },
    {
      id: 'surprise_cyber_port',
      title: 'Maritime Terminal Outage',
      desc: 'Automated cranes stall in USA and UK (+2.2 days delay, +$14k handling).',
      targetType: 'countries',
      target: ['usa', 'uk'],
      delayDays: 2.2,
      feeAdd: 14000,
      severity: 'warn'
    },
    {
      id: 'surprise_fert_subsidy',
      title: 'Southern Hemisphere Planting Drive',
      desc: 'Agricultural subsidies lift Fertilizer demand in Australia & NZ (+24%).',
      targetType: 'countryCommodity',
      countries: ['australia', 'new_zealand'],
      commodity: 'fertilizer',
      demandMult: 1.24,
      severity: 'good'
    },
    {
      id: 'surprise_bunker_squeeze',
      title: 'Bunker Fuel Refinery Fire',
      desc: 'Marine fuel costs jump mid-voyage across all routes.',
      targetType: 'global',
      fuelMult: 1.26,
      severity: 'bad'
    },
    {
      id: 'surprise_piracy_skiff',
      title: 'Strait Escort Alert',
      desc: 'Increased piracy patrols add insurance & escort risk along Sunda/Lombok.',
      targetType: 'routeTag',
      target: 'malacca-piracy',
      feeAdd: 15000,
      piracyAdd: 0.035,
      severity: 'warn'
    },
    {
      id: 'surprise_oil_glut',
      title: 'Strategic Reserve Release',
      desc: 'Emergency crude release drops global Crude Oil benchmark.',
      targetType: 'commodity',
      target: 'crude_oil',
      priceShock: -0.22,
      severity: 'bad'
    },
    {
      id: 'surprise_oil_embargo',
      title: 'Refinery & Tanker Bottleneck',
      desc: 'Sudden tanker squeeze surges global Crude Oil prices.',
      targetType: 'commodity',
      target: 'crude_oil',
      priceShock: 0.24,
      severity: 'good'
    },
    {
      id: 'surprise_chip_shortage',
      title: 'Semiconductor Fab Outage',
      desc: 'Wafer fab power outage lifts global Electronics benchmark.',
      targetType: 'commodity',
      target: 'electronics',
      priceShock: 0.22,
      severity: 'good'
    },
    {
      id: 'surprise_grain_bumper',
      title: 'Surprise Bumper Harvest',
      desc: 'Record grain yields push global Wheat and Fertilizer down.',
      targetType: 'commodities',
      commodities: { wheat: -0.18, fertilizer: -0.12 },
      severity: 'warn'
    },
    {
      id: 'surprise_textile_surge',
      title: 'Retail Apparel Restock Wave',
      desc: 'Department stores rush-order Textiles in USA, UK & France (+22% demand).',
      targetType: 'countryCommodity',
      countries: ['usa', 'uk', 'france'],
      commodity: 'textiles',
      demandMult: 1.22,
      severity: 'good'
    },
    {
      id: 'surprise_fert_crunch',
      title: 'Ammonia Plant Shutdown',
      desc: 'Gas feedstock crunch spikes global Fertilizer prices.',
      targetType: 'commodity',
      target: 'fertilizer',
      priceShock: 0.24,
      severity: 'good'
    },
    {
      id: 'surprise_canal_fog',
      title: 'Suez & Red Sea Convoy Pileup',
      desc: 'Naval escort checks add +2.8 days and +$18k fee on Suez lanes.',
      targetType: 'routeTag',
      target: 'suez',
      delayDays: 2.8,
      feeAdd: 18000,
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
      desc: 'Strong tailwinds trim global fuel burn -12% and lift Wheat.',
      targetType: 'global',
      fuelMult: 0.88,
      commodities: { wheat: 0.14 },
      severity: 'good'
    }
  ];

  function pickSurprise(rng, excludeIds) {
    var pool = SURPRISE_POOL.filter(function (s) { return excludeIds.indexOf(s.id) === -1; });
    var idx = Math.floor(rng() * pool.length);
    return Object.assign({}, pool[idx]);
  }

  function buildNoisyWireSignals(round, regime, rng) {
    // 60-80% accuracy signal card hinting at latent world state without revealing R_t
    var acc = GAME_CONFIG.SIGNAL_ACCURACY_MIN + (GAME_CONFIG.SIGNAL_ACCURACY_MAX - GAME_CONFIG.SIGNAL_ACCURACY_MIN) * (1 - (round - 1) * 0.15);
    var truthful = rng() < acc;
    var perceived = truthful ? regime : REGIMES[(REGIME_INDEX[regime] + 1 + Math.floor(rng() * 2)) % 3];
    var signalCard;
    if (perceived === 'Calm') {
      signalCard = {
        id: 'signal_regime_calm_' + round,
        title: 'Maritime Wire: Steady Freight Flows',
        desc: 'Underwriters report subdued war-risk premiums and stable fuel forwards (' + Math.round(acc * 100) + '% signal confidence).',
        probability: acc,
        guaranteed: false,
        severity: 'calm',
        signalRegimeHint: 'Calm',
        effects: {}
      };
    } else if (perceived === 'Tension') {
      signalCard = {
        id: 'signal_regime_tension_' + round,
        title: 'Maritime Wire: Elevated Strait Friction',
        desc: 'Intelligence chatter points to tighter chokepoint escorts and firmer bunker spreads (' + Math.round(acc * 100) + '% signal confidence).',
        probability: acc,
        guaranteed: false,
        severity: 'warn',
        signalRegimeHint: 'Tension',
        effects: {}
      };
    } else {
      signalCard = {
        id: 'signal_regime_crisis_' + round,
        title: 'Maritime Wire: Systemic Shock Warning',
        desc: 'Lloyd\'s desks warn of correlated commodity spikes and steep war-risk surcharges (' + Math.round(acc * 100) + '% signal confidence).',
        probability: acc,
        guaranteed: false,
        severity: 'bad',
        signalRegimeHint: 'Crisis',
        effects: {}
      };
    }
    return { signalCard: signalCard, perceivedRegime: perceived, accuracy: acc };
  }

  function generateRoundBriefing(round, seed, priceIndex, unlockedCountries, regime) {
    var rng = mulberry32(seed ^ (round * 2654435761));
    var actualRegime = regime || 'Calm';
    var uncertainty = round;
    var events = [];
    var surprises = [];
    var closedTags = [];
    var unlocked = (unlockedCountries && unlockedCountries.length)
      ? unlockedCountries.slice()
      : COUNTRIES.map(function (c) { return c.id; });

    var wire = buildNoisyWireSignals(round, actualRegime, rng);
    events.push(wire.signalCard);

    if (round === 1) {
      events.push({
        id: 'r1_calm',
        title: 'Monsoon Fuel Drift',
        desc: 'Global lanes are open. Light fuel drift (+4%) and express route inspection risk (22%).',
        probability: 1.0,
        guaranteed: true,
        severity: 'calm',
        effects: { fuelMult: 1.04 }
      });
      events.push({
        id: 'r1_high_risk_blockade',
        title: 'Express Corridor Inspection Alert',
        desc: 'Fast & Risky lanes carry a 22% chance of sudden naval hold (safe detour +2.5d, +$18k).',
        probability: 0.22,
        guaranteed: false,
        severity: 'warn',
        effects: { blockHighRisk: true, diversionDelay: 2.5, diversionFee: 18000 }
      });
      surprises.push(pickSurprise(rng, []));
    } else if (round === 2) {
      events.push({
        id: 'r2_redsea_piracy',
        title: 'Red Sea Piracy Surge',
        desc: 'War-risk surcharge hits Red Sea transits (+1.8% cargo risk, +1.4d convoy escort).',
        probability: 1.0,
        guaranteed: true,
        severity: 'warn',
        targetTag: 'redsea',
        hotspot: { lon: 43.4, lat: 12.6, label: 'Red Sea Piracy' },
        effects: { tag: 'redsea', insuranceAdd: 0.018, piracyAdd: 0.030, delayDays: 1.4 }
      });
      events.push({
        id: 'r2_wheat_tight',
        title: 'Black Sea Harvest Shortfall',
        desc: 'Tighter export forecasts push global Wheat upward (+12%).',
        probability: 1.0,
        guaranteed: true,
        severity: 'good',
        targetCommodity: 'wheat',
        effects: { commodity: 'wheat', priceShock: 0.12 }
      });
      events.push({
        id: 'r2_high_risk_blockade',
        title: 'Fast Corridor Blockade Alert',
        desc: 'Fast & Risky corridors face a 25% chance of emergency blockade (+2.8d detour, +$20k).',
        probability: 0.25,
        guaranteed: false,
        severity: 'bad',
        effects: { blockHighRisk: true, diversionDelay: 2.8, diversionFee: 20000 }
      });
      events.push({
        id: 'r2_suez_congestion',
        title: 'Suez Convoy Toll Hike',
        desc: 'Canal authority may impose a +$18k transit surcharge.',
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
        desc: 'Electronics to Russia are BANNED (dumped at 40% cost + $95k fine + delay!). Other Russia cargo +$18k inspection.',
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
        desc: 'Marine fuel jumps +20% and Crude Oil rallies.',
        probability: 1.0,
        guaranteed: true,
        severity: 'warn',
        targetCommodity: 'crude_oil',
        effects: { fuelMult: 1.20, commodity: 'crude_oil', priceShock: 0.15 }
      });
      events.push({
        id: 'r3_high_risk_blockade',
        title: 'Express Blockade Alert',
        desc: 'Fast & Risky lanes carry a 26% risk of mid-voyage blockade (+3.0d detour, +$22k).',
        probability: 0.26,
        guaranteed: false,
        severity: 'bad',
        effects: { blockHighRisk: true, diversionDelay: 3.0, diversionFee: 22000 }
      });
      events.push({
        id: 'r3_hamburg_strike',
        title: 'Hamburg Dockers Strike',
        desc: 'Potential port walkout in Germany adds +3.2d delay and +$18k demurrage.',
        probability: 0.65,
        guaranteed: false,
        severity: 'warn',
        targetCountry: 'germany',
        hotspot: { lon: 9.97, lat: 53.54, label: 'Hamburg Strike (65%)' },
        effects: { country: 'germany', delayDays: 3.2, feeAdd: 18000 }
      });
      var r3s1 = pickSurprise(rng, []);
      var r3s2 = pickSurprise(rng, [r3s1.id]);
      surprises.push(r3s1, r3s2);
    } else if (round === 4) {
      closedTags.push('suez');
      events.push({
        id: 'r4_suez_closed',
        title: 'Suez Canal Blockage — CLOSED',
        desc: 'Grounded vessel closes the Suez Canal. Europe/USA routes must detour via the Cape of Good Hope.',
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
        desc: 'New 25% tariff hits Textiles bound for New York.',
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
        title: 'Express Blockade Alert',
        desc: 'Fast & Risky lanes carry a 28% chance of sudden blockage (+3.2d detour, +$24k).',
        probability: 0.28,
        guaranteed: false,
        severity: 'bad',
        effects: { blockHighRisk: true, diversionDelay: 3.2, diversionFee: 24000 }
      });
      events.push({
        id: 'r4_indian_cyclone',
        title: 'Indian Ocean Cyclone',
        desc: 'Severe cyclone tracks across direct routes to Australia & southern NZ (+3.0d delay, hull risk).',
        probability: 0.70,
        guaranteed: false,
        severity: 'bad',
        targetTag: 'indian-cyclone',
        hotspot: { lon: 92.0, lat: -18.0, label: 'Indian Cyclone (70%)' },
        effects: { tag: 'indian-cyclone', delayDays: 3.0, weatherAdd: 0.055, repairCost: 34000 }
      });
      var s1 = pickSurprise(rng, []);
      var s2 = pickSurprise(rng, [s1.id]);
      surprises.push(s1, s2);
      if (rng() > 0.45) surprises.push(pickSurprise(rng, [s1.id, s2.id]));
    } else if (round === 5) {
      closedTags.push('redsea');
      closedTags.push('suez');
      events.push({
        id: 'r5_redsea_closed',
        title: 'Red Sea & Suez — CLOSED',
        desc: 'Naval blockade closes Bab-el-Mandeb & Suez. All Europe/Russia/USA fleets must sail via the Cape.',
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
        desc: 'Panic stockpiling surges Wheat and Fertilizer demand globally.',
        probability: 1.0,
        guaranteed: true,
        severity: 'good',
        effects: { commodities: { wheat: 0.22, fertilizer: 0.24 } }
      });
      events.push({
        id: 'r5_high_risk_blockade',
        title: 'Express Blockade Alert',
        desc: 'Remaining Fast & Risky lanes carry a 30% chance of sudden blockage (+3.4d detour, +$26k).',
        probability: 0.30,
        guaranteed: false,
        severity: 'bad',
        effects: { blockHighRisk: true, diversionDelay: 3.4, diversionFee: 26000 }
      });
      events.push({
        id: 'r5_perfect_storm',
        title: 'North Atlantic Bomb Cyclone & Fuel +32%',
        desc: 'Bunker fuel jumps +32%. North Atlantic storms threaten UK, Germany, Russia & USA routes (+3.0d).',
        probability: 0.75,
        guaranteed: false,
        severity: 'bad',
        targetTag: 'north-atlantic-storm',
        hotspot: { lon: -25.0, lat: 47.0, label: 'N. Atlantic Storm (75%)' },
        effects: { tag: 'north-atlantic-storm', fuelMult: 1.32, delayDays: 3.0, weatherAdd: 0.055 }
      });
      events.push({
        id: 'r5_trade_war',
        title: 'Global Trade War Escalation',
        desc: 'Retaliatory tariffs (+14%) hit Textiles & Electronics; Russia Electronics sanctions strictly enforced.',
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

    var contracts = generateContracts(round, rng, closedTags, unlocked);

    return {
      round: round,
      uncertainty: uncertainty,
      perceivedRegime: wire.perceivedRegime,
      signalAccuracy: wire.accuracy,
      events: events,
      surprises: surprises,
      closedTags: closedTags,
      unlockedCountries: unlocked,
      contracts: contracts
    };
  }

  function generateContracts(round, rng, closedTags, unlockedCountries) {
    var specs = [
      { countryId: 'germany', commodityId: 'crude_oil', targetUnits: 1200, bonusPool: 130000 },
      { countryId: 'uk', commodityId: 'spices_tea', targetUnits: 1000, bonusPool: 115000 },
      { countryId: 'usa', commodityId: 'electronics', targetUnits: 1200, bonusPool: 140000 },
      { countryId: 'france', commodityId: 'textiles', targetUnits: 1000, bonusPool: 115000 },
      { countryId: 'australia', commodityId: 'fertilizer', targetUnits: 950, bonusPool: 120000 },
      { countryId: 'new_zealand', commodityId: 'fertilizer', targetUnits: 900, bonusPool: 115000 },
      { countryId: 'russia', commodityId: 'wheat', targetUnits: 1100, bonusPool: 125000 }
    ];
    if (unlockedCountries && unlockedCountries.length) {
      var filtered = specs.filter(function (s) { return unlockedCountries.indexOf(s.countryId) !== -1; });
      if (filtered.length > 0) specs = filtered;
    }
    var i1 = Math.floor(rng() * specs.length);
    var i2 = specs.length > 1 ? (i1 + 1 + Math.floor(rng() * (specs.length - 1))) % specs.length : i1;
    var scale = 1 + (round - 1) * 0.22;
    var picked = (round >= 3 && specs.length > 1) ? [specs[i1], specs[i2]] : [specs[i1]];
    return picked.map(function (c, idx) {
      var co = getCountryById(c.countryId);
      var cm = getCommodityById(c.commodityId);
      var units = Math.round((c.targetUnits * scale) / 50) * 50;
      var bonus = Math.round((c.bonusPool * (1 + (round - 1) * 0.12)) / 5000) * 5000;
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
  // 8. MATCH INITIALIZATION & LOG-PRICE / REGIME EVOLUTION
  // =========================================================================
  function createMatchState(playersConfig, seed, options) {
    var matchSeed = (seed != null ? seed : Math.floor(Math.random() * 0x7fffffff)) >>> 0;
    var opts = options || {};
    var initRng = mulberry32((matchSeed ^ 0x517CC1B7) >>> 0);

    var initialRegime = opts.initialRegime || (initRng() < 0.62 ? 'Calm' : (initRng() < 0.85 ? 'Tension' : 'Crisis'));

    var logPrices = {};
    var priceIndex = {};
    var priceHistory = {};
    var forecastBias = {};
    COMMODITIES.forEach(function (c) {
      logPrices[c.id] = 0.0;
      priceIndex[c.id] = 1.0;
      priceHistory[c.id] = [1.0];
      forecastBias[c.id] = (initRng() * 2 - 1) * 0.04;
    });

    var demandDrift = {};
    var portBacklogs = {};
    COUNTRIES.forEach(function (co) {
      portBacklogs[co.id] = 0;
      demandDrift[co.id] = {};
      COMMODITIES.forEach(function (cm) {
        demandDrift[co.id][cm.id] = 1.0;
      });
    });
    Object.keys(CHOKEPOINTS).forEach(function (ch) {
      portBacklogs['choke:' + ch] = 0;
    });

    var players = playersConfig.map(function (p, idx) {
      var rep = {};
      COUNTRIES.forEach(function (co) { rep[co.id] = GAME_CONFIG.REP_INIT; });
      var shipWear = [];
      for (var w = 0; w < 7; w++) shipWear.push(0);
      return {
        id: p.id || ('p' + idx),
        name: p.name || ('Captain ' + (idx + 1)),
        color: p.color || '#13A89E',
        isBot: !!p.isBot,
        botStyle: p.botStyle || 'Adaptive',
        cash: GAME_CONFIG.STARTING_CASH,
        prevCash: GAME_CONFIG.STARTING_CASH,
        debt: 0,
        seized: false,
        seizedRound: null,
        rank: idx + 1,
        prevRank: idx + 1,
        worstRoundLoss: 0,
        reputation: rep,
        shipWear: shipWear,
        laneExp: {},
        laneLastUsed: {},
        roundProfits: [],
        lastPlan: null
      };
    });

    var countryUnlockOrder = buildCountryUnlockOrder(matchSeed);
    var unlockedR1 = getUnlockedCountryIds(countryUnlockOrder, 1);

    var state = {
      seed: matchSeed,
      round: 1,
      regime: initialRegime,
      regimeHistory: [initialRegime],
      fuelShock: 1.0,
      countryUnlockOrder: countryUnlockOrder,
      logPrices: logPrices,
      priceIndex: priceIndex,
      priceHistory: priceHistory,
      forecastBias: forecastBias,
      demandDrift: demandDrift,
      portBacklogs: portBacklogs,
      players: players,
      briefing: null,
      history: [],
      fastSim: !!opts.fastSim
    };
    state.briefing = generateRoundBriefing(1, matchSeed, state.priceIndex, unlockedR1, state.regime);
    state.briefing.newlyUnlockedCountries = unlockedR1.slice();
    return state;
  }

  function evolveMarketPrices(state, roundRng, rolledEvents, surprises) {
    var regP = REGIME_PARAMS[state.regime] || REGIME_PARAMS.Calm;
    var n = COMMODITIES.length;

    // Event log-shocks
    var evLogShocks = {};
    COMMODITIES.forEach(function (c) { evLogShocks[c.id] = 0; });
    var allActive = rolledEvents.concat(surprises || []);
    allActive.forEach(function (ev) {
      if (!ev) return;
      var ef = ev.effects || {};
      if (ef.commodity && ef.priceShock) evLogShocks[ef.commodity] += ef.priceShock;
      if (ef.commodity && ef.priceMult) evLogShocks[ef.commodity] += Math.log(Math.max(0.4, ef.priceMult));
      if (ev.targetType === 'commodity' && ev.target) {
        if (ev.priceShock && evLogShocks[ev.target] != null) evLogShocks[ev.target] += ev.priceShock;
        else if (ev.priceMult && evLogShocks[ev.target] != null) evLogShocks[ev.target] += Math.log(Math.max(0.4, ev.priceMult));
      }
      var cObj = ef.commodities || ev.commodities;
      if (cObj) {
        Object.keys(cObj).forEach(function (cid) {
          if (evLogShocks[cid] != null) {
            var val = cObj[cid];
            evLogShocks[cid] += val > 0.45 ? Math.log(val) : val;
          }
        });
      }
    });

    // Cholesky correlated normal vector L_R * e
    var corrMat = buildCommodityCorrMatrix(state.regime);
    var L_R = cholesky(corrMat);
    var eVec = [];
    for (var i = 0; i < n; i++) eVec.push(randNormal(roundRng));

    // Shared systemic regime factor so Crisis shocks hit together
    var commonJumpTrigger = roundRng() < regP.jumpIntensity * 0.55;
    var commonJumpDir = randStudentT(4, roundRng) * 0.09;

    var minLog = Math.log(0.78);
    var maxLog = Math.log(1.30);
    var nextIndex = {};

    for (var idx = 0; idx < n; idx++) {
      var cm = COMMODITIES[idx];
      var corrShock = 0;
      for (var k = 0; k <= idx; k++) corrShock += L_R[idx][k] * eVec[k];

      var curX = state.logPrices[cm.id] || 0;
      var mu = regP.id === 'Crisis' && (cm.id === 'crude_oil' || cm.id === 'wheat' || cm.id === 'fertilizer') ? 0.04 : 0.0;
      var diffusion = cm.sigma * GAME_CONFIG.VOLATILITY_SCALE * regP.volMult * corrShock * 0.68;

      var jump = 0;
      if (roundRng() < regP.jumpIntensity) {
        jump = cm.jumpScale * GAME_CONFIG.VOLATILITY_SCALE * randStudentT(4, roundRng) * 0.55;
      }
      if (commonJumpTrigger) {
        jump += commonJumpDir * (cm.id === 'electronics' || cm.id === 'textiles' ? -0.45 : 0.65);
      }

      var nextX = curX + cm.theta * (mu - curX) + diffusion + jump + evLogShocks[cm.id] * 0.68;
      nextX = clamp(nextX, minLog, maxLog);
      state.logPrices[cm.id] = nextX;
      var pRatio = clamp(Math.exp(nextX), 0.78, 1.30);
      nextIndex[cm.id] = pRatio;
      state.priceHistory[cm.id].push(Math.round(pRatio * 1000) / 1000);
    }
    state.priceIndex = nextIndex;

    // Fuel shock (heavy-tailed under Tension/Crisis)
    var rawFuelShock = 1.0 + (regP.id === 'Crisis' ? 0.10 : 0) + 0.045 * regP.volMult * randStudentT(4, roundRng);
    state.fuelShock = clamp(rawFuelShock, 0.86, 1.32);

    // Forecast bias drift + country macro demand drift
    COMMODITIES.forEach(function (cm) {
      state.forecastBias[cm.id] = clamp(state.forecastBias[cm.id] * 0.65 + randNormal(roundRng) * 0.04, -0.14, 0.14);
    });
    var macroShock = randNormal(roundRng) * 0.032 * regP.volMult;
    COUNTRIES.forEach(function (co) {
      var coShock = macroShock * regP.corr + randNormal(roundRng) * 0.038 * regP.volMult;
      COMMODITIES.forEach(function (cm) {
        var curD = state.demandDrift[co.id][cm.id] || 1.0;
        var nextD = curD + (1.0 - curD) * 0.45 + coShock + randNormal(roundRng) * 0.025 * regP.volMult;
        state.demandDrift[co.id][cm.id] = clamp(nextD, 0.88, 1.16);
      });
    });
  }

  // =========================================================================
  // 9. ROBUST FLEET & VOYAGE RESOLUTION ENGINE
  // =========================================================================
  function getRouteForCountry(countryId, stanceIndex, closedTags) {
    var idx = sanitizeRouteStance(countryId, stanceIndex, closedTags);
    return ROUTES_BY_COUNTRY[countryId][idx];
  }

  function rollBriefingOutcomes(briefing, roundRng, regime) {
    var regP = REGIME_PARAMS[regime] || REGIME_PARAMS.Calm;
    var rolledEvents = [];
    briefing.events.forEach(function (ev) {
      if (ev.guaranteed) {
        rolledEvents.push(Object.assign({}, ev, { triggered: true }));
      } else if (ev.signalRegimeHint) {
        // Wire signal card does not trigger direct mechanical penalty
      } else {
        var adjProb = clamp(ev.probability * (regime === 'Crisis' ? 1.25 : (regime === 'Calm' ? 0.78 : 1.0)), 0.05, 0.95);
        if (roundRng() < adjProb) {
          var magMult = clamp(1 + 0.18 * regP.volMult * Math.abs(randStudentT(4, roundRng)), 0.85, 1.75);
          rolledEvents.push(Object.assign({}, ev, { triggered: true, magMult: magMult }));
        }
      }
    });
    return {
      rolledEvents: rolledEvents,
      surprises: briefing.surprises.slice()
    };
  }

  function computeFleetInteractions(ships) {
    var count = ships.length;
    var distinctTriples = {};
    var laneCounts = {}; // stance:country -> count
    var countryComms = {}; // country -> set of commodities
    var riskCounts = {}; // riskFactor -> count
    var hasSuez = false;
    var hasCape = false;

    ships.forEach(function (sh) {
      var tripleKey = sh.stanceIndex + ':' + sh.countryId + ':' + sh.commodityId;
      distinctTriples[tripleKey] = true;

      var laneKey = sh.stanceIndex + ':' + sh.countryId;
      laneCounts[laneKey] = (laneCounts[laneKey] || 0) + 1;

      if (!countryComms[sh.countryId]) countryComms[sh.countryId] = {};
      countryComms[sh.countryId][sh.commodityId] = true;

      var rf = sh.route.riskFactor || 'general';
      riskCounts[rf] = (riskCounts[rf] || 0) + 1;

      if (sh.route.corridorKind === 'suez') hasSuez = true;
      if (sh.route.corridorKind === 'cape') hasCape = true;
    });

    var riskHHI = 0;
    if (count > 0) {
      Object.keys(riskCounts).forEach(function (rf) {
        var share = riskCounts[rf] / count;
        riskHHI += share * share;
      });
    }

    var nDistinct = Object.keys(distinctTriples).length;
    var totalComplexity = GAME_CONFIG.COMPLEXITY_ALPHA * GAME_CONFIG.COMPLEXITY_SCALE * Math.pow(Math.max(1, nDistinct), GAME_CONFIG.COMPLEXITY_EXPONENT);

    return {
      nDistinct: nDistinct,
      totalComplexity: totalComplexity,
      complexityPerShip: count > 0 ? totalComplexity / count : 0,
      laneCounts: laneCounts,
      countryComms: countryComms,
      riskCounts: riskCounts,
      riskHHI: riskHHI,
      hasSuezCapeHedge: hasSuez && hasCape
    };
  }

  function resolveRound(state, plansByPlayerId) {
    var round = state.round;
    var fleetSize = GAME_CONFIG.FLEET_SCHEDULE[round - 1];
    var playerCount = state.players.length;
    var activePlayersCount = Math.max(1, state.players.filter(function (p) { return !p.seized; }).length);
    var roundRng = mulberry32(state.seed ^ (round * 1597334677));
    var briefing = state.briefing;
    var regime = state.regime;
    var regP = REGIME_PARAMS[regime] || REGIME_PARAMS.Calm;

    // 1. Roll events & surprises
    var outcome = rollBriefingOutcomes(briefing, roundRng, regime);
    var activeEvents = outcome.rolledEvents.concat(outcome.surprises);

    var closedTags = briefing.closedTags.slice();
    var highRiskBlocked = false;
    var highRiskDiversionDelay = 0;
    var highRiskDiversionFee = 0;
    var globalFuelMult = 1.0;
    var tagMods = {};
    var countryMods = {};
    var countryCommodityMods = {};
    var globalTariffMods = {};
    var flags = {
      russiaTechBan: false,
      usTexTariff: false,
      hamburgStrike: false,
      indianCyclone: false,
      redSeaAlert: false
    };

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
      var mag = ev.magMult || 1.0;
      var targetType = ev.targetType;
      if (ef.closeTag && closedTags.indexOf(ef.closeTag) === -1) closedTags.push(ef.closeTag);
      if (ef.blockHighRisk) {
        highRiskBlocked = true;
        highRiskDiversionDelay = Math.max(highRiskDiversionDelay, (ef.diversionDelay || 2.8) * mag);
        highRiskDiversionFee = Math.max(highRiskDiversionFee, (ef.diversionFee || 22000) * mag);
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
        tm.delayDays += (ef.delayDays || 0) * mag;
        tm.feeAdd += (ef.feeAdd || 0) * mag;
        tm.tollAdd += (ef.tollAdd || 0) * mag;
        tm.insuranceAdd += (ef.insuranceAdd || 0);
        tm.piracyAdd += (ef.piracyAdd || 0);
        tm.weatherAdd += (ef.weatherAdd || 0);
        tm.repairCost += (ef.repairCost || 0) * mag;
        if (ef.tag === 'redsea') flags.redSeaAlert = true;
        if (ef.tag === 'indian-cyclone') flags.indianCyclone = true;
      }
      if (targetType === 'routeTag' && ev.target) {
        var st = ensureTag(ev.target);
        st.delayDays += (ev.delayDays || 0) * mag;
        st.feeAdd += (ev.feeAdd || 0) * mag;
        st.piracyAdd += (ev.piracyAdd || 0);
      }
      if (ef.country) {
        if (ef.commodity && ef.tariffAdd) {
          var key = ef.country + ':' + ef.commodity;
          countryCommodityMods[key] = countryCommodityMods[key] || { tariffAdd: 0, demandMult: 1 };
          countryCommodityMods[key].tariffAdd += ef.tariffAdd;
          if (ef.country === 'usa' && ef.commodity === 'textiles') flags.usTexTariff = true;
        } else {
          var cm = ensureCountry(ef.country);
          cm.delayDays += (ef.delayDays || 0) * mag;
          cm.feeAdd += (ef.feeAdd || 0) * mag;
          if (ef.country === 'germany' && (ef.delayDays || 0) >= 2) flags.hamburgStrike = true;
          if (ef.bannedCommodity) {
            cm.banned[ef.bannedCommodity] = true;
            cm.fines[ef.bannedCommodity] = ef.finePerShip || 95000;
            if (ef.country === 'russia' && ef.bannedCommodity === 'electronics') flags.russiaTechBan = true;
          }
        }
      }
      if (targetType === 'countries' && ev.target) {
        ev.target.forEach(function (cid) {
          var cmod = ensureCountry(cid);
          cmod.delayDays += (ev.delayDays || 0) * mag;
          cmod.feeAdd += (ev.feeAdd || 0) * mag;
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

    // 2. Evolve log-prices & macro demand drift
    evolveMarketPrices(state, roundRng, outcome.rolledEvents, outcome.surprises);

    // 3. Expand each active player's plan into ship triples (r, k, c)
    var normalizedPlans = {};
    var mumbaiDemandUnits = {};
    COMMODITIES.forEach(function (cm) { mumbaiDemandUnits[cm.id] = 0; });

    var playerShips = {};
    var playerInteractions = {};
    var portArrivals = {};
    var chokeArrivals = {};
    COUNTRIES.forEach(function (co) { portArrivals[co.id] = 0; });
    Object.keys(CHOKEPOINTS).forEach(function (ch) { chokeArrivals[ch] = 0; });

    var unlockedCountries = (briefing && briefing.unlockedCountries) || getUnlockedCountryIds(state.countryUnlockOrder, round);

    state.players.forEach(function (pl) {
      if (pl.seized) {
        playerShips[pl.id] = [];
        playerInteractions[pl.id] = computeFleetInteractions([]);
        normalizedPlans[pl.id] = pl.lastPlan || createEmptyPlan();
        return;
      }

      var rawPlan = plansByPlayerId[pl.id] || pl.lastPlan || createDefaultPlan(closedTags, unlockedCountries);
      var plan = validateAndNormalizePlan(rawPlan, closedTags, unlockedCountries);
      normalizedPlans[pl.id] = plan;
      pl.lastPlan = plan;

      var triples = expandPlanToShipTriples(plan, fleetSize, closedTags, unlockedCountries);
      var ships = [];

      triples.forEach(function (tr) {
        var cargoUnits = {};
        COMMODITIES.forEach(function (cm) { cargoUnits[cm.id] = cm.id === tr.commodityId ? GAME_CONFIG.SHIP_CAPACITY : 0; });
        var laneKey = tr.stanceIndex + ':' + tr.countryId + ':' + tr.commodityId;
        var sh = {
          shipIndex: tr.shipIndex,
          countryId: tr.countryId,
          commodityId: tr.commodityId,
          stanceIndex: tr.stanceIndex,
          route: tr.route,
          laneKey: laneKey,
          cargoUnits: cargoUnits,
          loadFactor: 1.0
        };
        ships.push(sh);
        mumbaiDemandUnits[tr.commodityId] += GAME_CONFIG.SHIP_CAPACITY;
        portArrivals[tr.countryId] += 1;
        tr.route.chokepoints.forEach(function (ch) {
          chokeArrivals[ch] = (chokeArrivals[ch] || 0) + 1;
        });
      });

      playerShips[pl.id] = ships;
      playerInteractions[pl.id] = computeFleetInteractions(ships);
    });

    // 4. Shared Mumbai Sourcing Pressure: P_buy = P_k * (1 - base_margin_k) * (Q_total / supply_depth_k)^0.5
    var supplyDepth = GAME_CONFIG.SOURCING_SUPPLY_DEPTH_PER_PLAYER * Math.max(1, activePlayersCount) * (0.55 + 0.35 * fleetSize);
    var mumbaiBuyPrice = {};
    COMMODITIES.forEach(function (cm) {
      var qTot = mumbaiDemandUnits[cm.id] || 0;
      var pk = cm.baseSellPrice * state.priceIndex[cm.id];
      var depthMult = Math.pow(clamp(qTot / Math.max(1000, supplyDepth * 0.45), 0.86, 1.34), 0.5);
      var rawBaseM = cm.baseMargin || GAME_CONFIG.SOURCING_BASE_MARGIN_DEFAULT;
      // Split structural freight baseline (0.095) from tunable margin spread so +/-20% MARGIN_SCALE is realistic
      var effMargin = clamp(0.095 + (rawBaseM - 0.14) * GAME_CONFIG.MARGIN_SCALE, 0.07, 0.30);
      var rawBuy = pk * (1 - effMargin) * depthMult;
      mumbaiBuyPrice[cm.id] = Math.max(80, rawBuy);
    });

    // 5. Finance, Overdraft & Upfront Cargo Loading Cap
    var playerFinance = {};
    state.players.forEach(function (pl) {
      if (pl.seized) {
        playerFinance[pl.id] = { intelSpend: 0, newBorrow: 0, interestCost: 0 };
        return;
      }
      var plan = normalizedPlans[pl.id];
      var intelSpend = GAME_CONFIG.ENABLE_MARKET_INTEL ? clamp(plan.intelSpend || 0, 0, GAME_CONFIG.MAX_INTEL_SPEND) : 0;
      var ships = playerShips[pl.id];

      var netWorth = pl.cash - (pl.debt || 0);
      var maxOverdraft = Math.max(0, netWorth * GAME_CONFIG.OVERDRAFT_LIMIT_RATIO);
      var availFunds = Math.max(0, pl.cash - intelSpend) + Math.max(0, maxOverdraft - (pl.debt || 0));

      var totalCargoPurchase = 0;
      ships.forEach(function (sh) {
        totalCargoPurchase += GAME_CONFIG.SHIP_CAPACITY * mumbaiBuyPrice[sh.commodityId];
      });

      if (totalCargoPurchase > 0 && availFunds < totalCargoPurchase) {
        var factor = clamp(availFunds / totalCargoPurchase, 0.20, 1.0);
        ships.forEach(function (sh) {
          sh.loadFactor = factor;
          sh.cargoUnits[sh.commodityId] = Math.floor(GAME_CONFIG.SHIP_CAPACITY * factor);
        });
        totalCargoPurchase *= factor;
      }

      var cashAfterIntel = pl.cash - intelSpend;
      var newBorrow = Math.max(0, totalCargoPurchase - Math.max(0, cashAfterIntel));
      var totalDebt = (pl.debt || 0) + newBorrow;
      var debtRatio = totalDebt / Math.max(100000, netWorth);
      var interestRate = GAME_CONFIG.DEBT_BASE_INTEREST + GAME_CONFIG.DEBT_CONVEX_KAPPA * debtRatio * debtRatio;
      var interestCost = totalDebt * interestRate;

      playerFinance[pl.id] = {
        intelSpend: intelSpend,
        newBorrow: newBorrow,
        totalDebt: totalDebt,
        interestCost: interestCost
      };
    });

    // 6. Shared Country-Commodity Saturation & Demand Depth
    var marketSupply = {};
    COUNTRIES.forEach(function (co) {
      COMMODITIES.forEach(function (cm) {
        marketSupply[co.id + ':' + cm.id] = 0;
      });
    });
    state.players.forEach(function (pl) {
      playerShips[pl.id].forEach(function (sh) {
        var cMod = countryMods[sh.countryId];
        if (cMod && cMod.banned[sh.commodityId]) return;
        marketSupply[sh.countryId + ':' + sh.commodityId] += sh.cargoUnits[sh.commodityId];
      });
    });

    var avgRepByCountry = {};
    COUNTRIES.forEach(function (co) {
      var rSum = 0;
      var rCnt = 0;
      state.players.forEach(function (pl) {
        if (!pl.seized) {
          rSum += (pl.reputation[co.id] != null ? pl.reputation[co.id] : GAME_CONFIG.REP_INIT);
          rCnt++;
        }
      });
      avgRepByCountry[co.id] = rCnt > 0 ? rSum / rCnt : GAME_CONFIG.REP_INIT;
    });

    var marketPriceMult = {};
    var saturationRatio = {};
    COUNTRIES.forEach(function (co) {
      COMMODITIES.forEach(function (cm) {
        var key = co.id + ':' + cm.id;
        var season = getSeasonalFactor(cm.id, co.id, round);
        var macro = state.demandDrift[co.id][cm.id] || 1.0;
        var repFactor = 0.85 + 0.30 * avgRepByCountry[co.id];
        var d0 = co.demandDepthPerPlayer * activePlayersCount * (0.45 + 0.20 * fleetSize) * GAME_CONFIG.DEPTH_SCALE;
        var depth = Math.max(900, d0 * season * repFactor * macro);
        var sup = marketSupply[key];
        var ratio = sup / depth;
        saturationRatio[key] = ratio;
        marketPriceMult[key] = saturationCurve(ratio);
      });
    });

    // 7. Congestion & Carried Port Backlogs: smooth convex M/M/1 queue without infinite blowup
    var portQueueDays = {};
    var nextBacklogs = {};
    COUNTRIES.forEach(function (co) {
      var cap = Math.max(2.0, (co.portCapacity / 3.4) * activePlayersCount * (0.55 + 0.32 * fleetSize));
      var backlog = state.portBacklogs[co.id] || 0;
      var load = portArrivals[co.id] + backlog;
      var rho = load / cap;
      var qRaw = rho <= 0.85
        ? GAME_CONFIG.CONGESTION_D0_DAYS * rho / (1 - rho)
        : GAME_CONFIG.CONGESTION_D0_DAYS * ((0.85 / 0.15) + 4.5 * (rho - 0.85));
      portQueueDays[co.id] = clamp(qRaw * GAME_CONFIG.CONGESTION_SCALE, 0, 5.5);
      nextBacklogs[co.id] = Math.min(cap * 0.35, Math.max(0, load - cap * 0.90) * GAME_CONFIG.CONGESTION_BACKLOG_CARRY);
    });

    var chokeQueueDays = {};
    Object.keys(CHOKEPOINTS).forEach(function (ch) {
      var cap = Math.max(2.5, (CHOKEPOINTS[ch].baseCap / 4.2) * activePlayersCount * (0.65 + 0.40 * fleetSize));
      var bKey = 'choke:' + ch;
      var backlog = state.portBacklogs[bKey] || 0;
      var load = (chokeArrivals[ch] || 0) + backlog;
      var rho = load / cap;
      var qRaw = rho <= 0.85
        ? GAME_CONFIG.CONGESTION_D0_DAYS * 0.45 * rho / (1 - rho)
        : GAME_CONFIG.CONGESTION_D0_DAYS * 0.45 * ((0.85 / 0.15) + 4.5 * (rho - 0.85));
      chokeQueueDays[ch] = clamp(qRaw * GAME_CONFIG.CONGESTION_SCALE, 0, 2.2);
      nextBacklogs[bKey] = Math.min(cap * 0.30, Math.max(0, load - cap * 0.90) * GAME_CONFIG.CONGESTION_BACKLOG_CARRY);
    });
    state.portBacklogs = nextBacklogs;

    var fuelPricePerTon = GAME_CONFIG.FUEL_PRICE_PER_TON_BASE
      * Math.pow(Math.max(0.35, state.priceIndex.crude_oil), 0.80)
      * globalFuelMult
      * (state.fuelShock || 1.0);

    // 8. Resolve every ship voyage
    var playerReports = {};
    var contractDeliveries = {};
    briefing.contracts.forEach(function (ct) { contractDeliveries[ct.id] = {}; });

    state.players.forEach(function (pl) {
      if (pl.seized) {
        playerReports[pl.id] = {
          playerId: pl.id,
          seized: true,
          roundProfit: 0,
          contractBonus: 0,
          revenue: 0,
          costs: 0,
          ships: [],
          highlights: ['Fleet seized in an earlier round due to insolvency.'],
          newCash: pl.cash,
          debt: pl.debt,
          cumulativeProfit: pl.cash - pl.debt - GAME_CONFIG.STARTING_CASH
        };
        return;
      }

      var ships = playerShips[pl.id];
      var fin = playerFinance[pl.id];
      var inter = playerInteractions[pl.id];
      var totalProfit = 0;
      var totalRevenue = 0;
      var totalCosts = 0;
      var shipBreakdowns = [];
      var relScoreSum = 0;
      var failScoreSum = 0;
      var countriesServed = {};
      var usedLaneKeys = {};

      ships.forEach(function (sh) {
        var co = getCountryById(sh.countryId);
        var cm = getCommodityById(sh.commodityId);
        var route = sh.route;
        var units = sh.cargoUnits[cm.id];
        usedLaneKeys[sh.laneKey] = true;
        if (!countriesServed[co.id]) countriesServed[co.id] = { total: 0, onTime: 0, failed: 0 };
        countriesServed[co.id].total += 1;

        var cMod = countryMods[co.id] || { delayDays: 0, feeAdd: 0, banned: {}, fines: {} };
        var rep = pl.reputation[co.id] != null ? pl.reputation[co.id] : GAME_CONFIG.REP_INIT;

        // High-risk blockade (stanceIndex 0)
        var wasHighRiskBlocked = false;
        if (highRiskBlocked && route.stanceIndex === 0) {
          wasHighRiskBlocked = true;
          var safeOpts = ROUTES_BY_COUNTRY[co.id];
          route = safeOpts[safeOpts.length - 1];
        }

        // Transit & Queue Days
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

        var portQ = portQueueDays[co.id] || 0;
        var chokeQ = 0;
        route.chokepoints.forEach(function (ch) { chokeQ += (chokeQueueDays[ch] || 0); });
        var qDays = portQ + Math.min(3.5, chokeQ);
        delayDays += qDays;

        // Per-ship wear & deterministic incident rolls
        var wearBefore = pl.shipWear[sh.shipIndex] || 0;
        var speedMult = GAME_CONFIG.STANCE_SPEED_MULTS[sh.stanceIndex] || 1.0;
        var shipRng = mulberry32(state.seed ^ (round * 104729) ^ hashString(pl.id) ^ (sh.shipIndex * 7919));

        var breakdownHazard = GAME_CONFIG.BREAKDOWN_H0 * Math.exp(GAME_CONFIG.BREAKDOWN_BETA_WEAR * wearBefore) * Math.pow(speedMult, 1.8) * (0.85 + 0.35 * regP.riskFactor);
        var breakdownProb = 1 - Math.exp(-breakdownHazard);
        var hadBreakdown = shipRng() < breakdownProb;
        var hadPiracy = shipRng() < clamp((route.basePiracy + extraPiracy) * (1 + 0.5 * regP.riskFactor), 0, 0.55);
        var hadStorm = shipRng() < clamp((route.baseWeather + extraWeather) * (1 + 0.55 * regP.riskFactor), 0, 0.55);

        // Concentration shock amplifier (1 + kappa * H_f)
        var rf = route.riskFactor || 'general';
        var h_f = (inter.riskCounts[rf] || 1) / Math.max(1, ships.length);
        var shockAmp = 1 + GAME_CONFIG.SHOCK_KAPPA_HHI * h_f;

        var repairCost = 0;
        if (hadBreakdown) {
          var bdDays = GAME_CONFIG.BREAKDOWN_DELAY_MIN + Math.floor(shipRng() * (GAME_CONFIG.BREAKDOWN_DELAY_MAX - GAME_CONFIG.BREAKDOWN_DELAY_MIN + 1));
          delayDays += bdDays;
          repairCost += GAME_CONFIG.BREAKDOWN_REPAIR_COST * shockAmp;
        }
        if (hadStorm) {
          delayDays += 1.5 * shockAmp;
          repairCost += (extraWeatherRepair > 0 ? extraWeatherRepair : 22000) * shockAmp;
        }

        // Update ship wear W_i(t+1) = 0.9 W_i + w(v) * sailingDays
        var wRate = GAME_CONFIG.WEAR_RATE_BY_STANCE[sh.stanceIndex] || 0.022;
        pl.shipWear[sh.shipIndex] = clamp(wearBefore * GAME_CONFIG.WEAR_DECAY_PER_ROUND + wRate * baseDays, 0, 2.5);

        var tau = baseDays + delayDays;
        var contractWindow = baseDays + GAME_CONFIG.LATENESS_WINDOW_SLACK_DAYS;
        var laneN = pl.laneExp[sh.laneKey] || 0;
        var expCostMult = Math.max(GAME_CONFIG.EXP_FLOOR_MULT, Math.exp(-GAME_CONFIG.EXP_DECAY_RATE * laneN));

        // Combination Triple Interaction (route x commodity x country x regime)
        var combo = evaluateTripleCombination(sh.stanceIndex, cm.id, co.id, regime, {
          round: round,
          flags: flags
        });

        // Upfront cargo purchase (l)
        var buyUnit = mumbaiBuyPrice[cm.id];
        var cargoPurchase = units * buyUnit;

        // Revenue (c) & Value Decay + Lateness Convexity (d)
        var netRevenue = 0;
        var tariffsFines = 0;
        var isBanned = !!(cMod.banned[cm.id]);
        var isLate = tau > contractWindow + 0.4;

        if (isBanned) {
          // Sanctioned cargo dumped at 40% of cost + fine + delay
          netRevenue = cargoPurchase * 0.40;
          tariffsFines += cMod.fines[cm.id] || 95000;
          tau += 2.0;
          countriesServed[co.id].failed += 1.0;
        } else {
          var key = co.id + ':' + cm.id;
          var ccMod = countryCommodityMods[key] || { tariffAdd: 0, demandMult: 1 };
          var repDemandBoost = 0.94 + rep * 0.14;
          var sellPrice = cm.baseSellPrice
            * state.priceIndex[cm.id]
            * co.demand[cm.id]
            * (state.demandDrift[co.id][cm.id] || 1.0)
            * ccMod.demandMult
            * co.exchangeRate
            * repDemandBoost
            * marketPriceMult[key]
            * combo.tripleMult;

          var decayV = Math.exp(-cm.spoilagePerDay * tau);
          var grossRev = units * decayV * sellPrice;

          if (hadPiracy) {
            var pirLoss = 0.12 * shockAmp * GAME_CONFIG.INCIDENT_DEDUCTIBLE_RATE;
            grossRev *= Math.max(0.65, 1.0 - pirLoss);
          }

          // Suez + Cape hedge softens negative voyage variance slightly
          if (inter.hasSuezCapeHedge && (hadStorm || hadPiracy || wasHighRiskBlocked)) {
            grossRev *= (1 + GAME_CONFIG.SUEZ_CAPE_HEDGE_FACTOR * 0.18);
          }

          var latenessDays = Math.max(0, tau - contractWindow);
          var latenessPen = (cm.latenessAlpha || GAME_CONFIG.LATENESS_ALPHA) * Math.pow(latenessDays, 1.5) * grossRev;
          latenessPen = Math.min(grossRev * 0.45, latenessPen);
          netRevenue = grossRev - latenessPen;

          var tariffRate = co.baseTariff * cm.tariffSensitivity
            + (globalTariffMods[cm.id] || 0)
            + ccMod.tariffAdd;
          tariffsFines += Math.max(0, netRevenue * tariffRate);

          // Special contract deliveries
          briefing.contracts.forEach(function (ct) {
            if (ct.countryId === co.id && ct.commodityId === cm.id) {
              contractDeliveries[ct.id][pl.id] = (contractDeliveries[ct.id][pl.id] || 0) + units;
            }
          });

          if (!isLate && !hadBreakdown && !wasHighRiskBlocked) {
            countriesServed[co.id].onTime += 1.0;
          } else if (hadBreakdown || latenessDays > 2.5) {
            countriesServed[co.id].failed += 0.55;
          }
        }

        // Fuel (e): burn/day = b0 * (v / v0)^3 * (1 + 0.25 * w_k)
        var fuelTons = baseDays * GAME_CONFIG.FUEL_BASE_TONS_PER_DAY * Math.pow(speedMult, 3) * (1 + 0.25 * cm.weightClass);
        var fuelCost = fuelTons * fuelPricePerTon;

        // Tolls & Port fees * (1 + queue) (f) with reputation & experience relief
        var tolls = route.toll + extraTolls;
        var repFeeDiscount = 1.12 - rep * 0.24;
        var portFees = (co.portFee * repFeeDiscount * (1 + 0.055 * qDays) + cMod.feeAdd + extraTagFees) * expCostMult;

        // Crew & Maintenance (k)
        var crewCost = tau * GAME_CONFIG.CREW_COST_PER_DAY * expCostMult;
        var maintenance = tau * GAME_CONFIG.WEAR_COST_PER_DAY_BASE * Math.pow(speedMult, 2.2) + repairCost;

        // Insurance (g): r0_route * exp(beta * risk_f) * (1 + kappa * H_f^2) * convoyDiscount
        var r0 = GAME_CONFIG.INSURANCE_BASE_BY_STANCE[sh.stanceIndex] || 0.015;
        var laneKeyRC = sh.stanceIndex + ':' + sh.countryId;
        var convoyN = inter.laneCounts[laneKeyRC] || 1;
        var convoyDiscount = 1 - GAME_CONFIG.CONVOY_INS_DISCOUNT_STEP * Math.min(GAME_CONFIG.CONVOY_INS_MAX_EXTRA_SHIPS, Math.max(0, convoyN - 1));
        var cargoVal = Math.max(cargoPurchase, 180000);
        var insRate = (r0 * GAME_CONFIG.INSURANCE_SCALE * Math.exp(GAME_CONFIG.INSURANCE_BETA_RISK * regP.riskFactor) + extraInsurance)
          * (1 + GAME_CONFIG.INSURANCE_KAPPA_HHI * h_f * h_f)
          * convoyDiscount;
        var insurance = cargoVal * insRate;

        // Complexity share (h), Interest share (m), Overhead, Intel share
        var complexityShare = inter.complexityPerShip;
        var interestShare = fin.interestCost / Math.max(1, ships.length);
        var intelShare = fin.intelSpend / Math.max(1, ships.length);
        var overhead = GAME_CONFIG.FIXED_OVERHEAD_PER_SHIP * expCostMult;

        var totalShipCost = cargoPurchase + fuelCost + tolls + portFees + crewCost + insurance + maintenance + tariffsFines + complexityShare + interestShare + overhead + intelShare;
        var shipProfit = netRevenue - totalShipCost;

        totalRevenue += netRevenue;
        totalCosts += totalShipCost;
        totalProfit += shipProfit;

        var notes = [];
        if (!state.fastSim) {
          if (sh.loadFactor < 0.99) notes.push('Sailed ' + Math.round(sh.loadFactor * 100) + '% loaded (credit cap)');
          if (wasHighRiskBlocked) notes.push('Express lane blocked: forced detour (+' + highRiskDiversionDelay.toFixed(1) + 'd)');
          if (isBanned) notes.push('Sanctioned cargo dumped at 40% cost + fine');
          if (hadBreakdown) notes.push('Mechanical breakdown (+repair & delay)');
          if (hadStorm) notes.push('Heavy storm damage (+repair & delay)');
          if (hadPiracy) notes.push('Piracy incident (-deductible cargo loss)');
          if (qDays > 1.2) notes.push('Port/chokepoint queue (+' + qDays.toFixed(1) + 'd)');
          if (convoyN >= 2) notes.push('Convoy security discount (' + convoyN + ' ships)');
          combo.notes.forEach(function (cn) { if (notes.length < 5) notes.push(cn); });
        }

        shipBreakdowns.push({
          shipIndex: sh.shipIndex + 1,
          countryId: co.id,
          countryName: co.name,
          portName: co.portName,
          commodityId: cm.id,
          commodityName: cm.name,
          stanceIndex: sh.stanceIndex,
          routeId: route.id,
          routeLabel: route.label,
          distanceNm: route.distanceNm,
          knots: route.knots,
          transitDays: Math.round(tau * 10) / 10,
          queueDays: Math.round(qDays * 10) / 10,
          loadFactor: sh.loadFactor,
          comboMult: Math.round(combo.tripleMult * 100) / 100,
          revenue: Math.round(netRevenue),
          cargoPurchase: Math.round(cargoPurchase),
          fuelCost: Math.round(fuelCost),
          tolls: Math.round(tolls),
          portFees: Math.round(portFees),
          crewCost: Math.round(crewCost),
          insurance: Math.round(insurance),
          maintenance: Math.round(maintenance),
          tariffsFines: Math.round(tariffsFines),
          handling: Math.round(complexityShare),
          overhead: Math.round(overhead),
          taxes: Math.round(interestShare + intelShare),
          profit: Math.round(shipProfit),
          notes: notes
        });
      });

      // Decay unused ship wear slots
      for (var wIdx = ships.length; wIdx < 7; wIdx++) {
        pl.shipWear[wIdx] = (pl.shipWear[wIdx] || 0) * GAME_CONFIG.WEAR_DECAY_PER_ROUND;
      }

      // Update lane experience (n decays if unused for 2 rounds)
      Object.keys(usedLaneKeys).forEach(function (lk) {
        pl.laneExp[lk] = (pl.laneExp[lk] || 0) + 1;
        pl.laneLastUsed[lk] = round;
      });
      Object.keys(pl.laneExp).forEach(function (lk) {
        if (!usedLaneKeys[lk]) {
          var gap = round - (pl.laneLastUsed[lk] || 0);
          if (gap >= GAME_CONFIG.EXP_UNUSED_ROUNDS_DECAY) {
            pl.laneExp[lk] = Math.max(0, pl.laneExp[lk] * 0.65 - 0.5);
          }
        }
      });

      // Update reputation: rho_c(t+1) = clip(0.85 rho_c + 0.25 reliability - 0.6 failures)
      COUNTRIES.forEach(function (co) {
        var curRep = pl.reputation[co.id] != null ? pl.reputation[co.id] : GAME_CONFIG.REP_INIT;
        var srv = countriesServed[co.id];
        if (srv && srv.total > 0) {
          var divBonus = (inter.countryComms[co.id] && Object.keys(inter.countryComms[co.id]).length >= 2) ? 0.12 : 0;
          var reliability = clamp(srv.onTime / srv.total + divBonus, 0, 1.15);
          var failures = clamp(srv.failed / srv.total, 0, 1.5);
          pl.reputation[co.id] = clamp(
            GAME_CONFIG.REP_RETAIN * curRep + GAME_CONFIG.REP_RELIABILITY_GAIN * reliability - GAME_CONFIG.REP_FAILURE_PENALTY * failures,
            GAME_CONFIG.REP_MIN,
            GAME_CONFIG.REP_MAX
          );
        } else {
          pl.reputation[co.id] = clamp(GAME_CONFIG.REP_RETAIN * curRep + 0.05, GAME_CONFIG.REP_MIN, GAME_CONFIG.REP_MAX);
        }
      });

      playerReports[pl.id] = {
        playerId: pl.id,
        seized: false,
        roundProfit: Math.round(totalProfit),
        contractBonus: 0,
        revenue: Math.round(totalRevenue),
        costs: Math.round(totalCosts),
        complexityCost: Math.round(inter.totalComplexity),
        interestCost: Math.round(fin.interestCost),
        intelSpend: Math.round(fin.intelSpend),
        hhi: Math.round(inter.riskHHI * 100) / 100,
        ships: shipBreakdowns,
        highlights: []
      };
    });

    // 9. Special Contract Bonus Payouts
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
        if (bonus > 0 && playerReports[pid] && !playerReports[pid].seized) {
          playerReports[pid].contractBonus += bonus;
          playerReports[pid].roundProfit += bonus;
          if (!state.fastSim) {
            playerReports[pid].highlights.push('Contract bonus: +$' + bonus.toLocaleString() + ' (' + ct.label.split(' needs')[0] + ')');
          }
        }
      });
    });

    // 10. Settle Cash, Debt, Fleet Seizure & Rankings
    state.players.forEach(function (pl) {
      var rep = playerReports[pl.id];
      if (pl.seized) return;
      pl.prevCash = pl.cash;
      var endNetWorth = Math.round((pl.cash - (pl.debt || 0)) + rep.roundProfit);
      if (endNetWorth < 0) {
        pl.debt = Math.abs(endNetWorth);
        pl.cash = 0;
      } else {
        pl.debt = 0;
        pl.cash = endNetWorth;
      }
      if (rep.roundProfit < pl.worstRoundLoss) {
        pl.worstRoundLoss = rep.roundProfit;
      }
      pl.roundProfits.push(rep.roundProfit);

      // Seizure cliff: net worth < 20% of starting capital
      if (endNetWorth < GAME_CONFIG.STARTING_CASH * GAME_CONFIG.SEIZURE_NET_WORTH_RATIO) {
        pl.seized = true;
        pl.seizedRound = round;
        rep.seized = true;
        if (!state.fastSim) {
          rep.highlights.unshift('FLEET SEIZED: Net worth fell below 20% ($400k). Run ended early.');
        }
      } else if (!state.fastSim) {
        if (rep.roundProfit > 160000) rep.highlights.push('Strong fleet margin across tough sea lanes.');
        else if (rep.roundProfit < 0) rep.highlights.push('Combined costs and shocks erased voyage revenue.');
      }

      rep.newCash = endNetWorth;
      rep.debt = pl.debt;
      rep.cumulativeProfit = endNetWorth - GAME_CONFIG.STARTING_CASH;
    });

    var sorted = state.players.slice().sort(function (a, b) {
      var aNw = a.cash - (a.debt || 0);
      var bNw = b.cash - (b.debt || 0);
      if (a.seized !== b.seized) return a.seized ? 1 : -1;
      if (bNw !== aNw) return bNw - aNw;
      return b.worstRoundLoss - a.worstRoundLoss;
    });
    sorted.forEach(function (pl, idx) {
      pl.prevRank = pl.rank;
      pl.rank = idx + 1;
    });

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
      regime: regime,
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

    // 11. Advance Markov Regime & Next Round Briefing
    if (round < GAME_CONFIG.ROUNDS) {
      state.round = round + 1;
      state.regime = stepRegime(state.regime, state.round, roundRng);
      state.regimeHistory.push(state.regime);
      var nextUnlocked = getUnlockedCountryIds(state.countryUnlockOrder, state.round);
      state.briefing = generateRoundBriefing(state.round, state.seed, state.priceIndex, nextUnlocked, state.regime);
      state.briefing.newlyUnlockedCountries = getNewlyUnlockedCountryIds(state.countryUnlockOrder, state.round);
    } else {
      state.finished = true;
    }

    return roundSummary;
  }

  // =========================================================================
  // 10. PAR-BASED SCORING, RANKS & NOISY ANALYZER / COMBO MATRIX
  // =========================================================================
  function getScoreIndex(profit, isSeized) {
    if (isSeized) return 0;
    var par = GAME_CONFIG.PAR_PROFIT;
    var floor = GAME_CONFIG.FLOOR_PROFIT;
    var denom = Math.max(1, par - floor);
    return Math.round(100 * (profit - floor) / denom);
  }

  function getRankTitle(profitOrNetWorth, isSeized) {
    if (isSeized) return 'Deckhand';
    var idx = getScoreIndex(profitOrNetWorth, isSeized);
    var title = GAME_CONFIG.RANKS[0].title;
    for (var i = 0; i < GAME_CONFIG.RANKS.length; i++) {
      if (idx >= GAME_CONFIG.RANKS[i].minIndex) title = GAME_CONFIG.RANKS[i].title;
    }
    return title;
  }

  function estimateLatentRegimeBelief(state) {
    // Infer noisy belief over Calm/Tension/Crisis from briefing signal + round without peeking at state.regime
    var briefing = state.briefing || {};
    var perceived = briefing.perceivedRegime || 'Calm';
    var acc = briefing.signalAccuracy || 0.70;
    var r = state.round || 1;
    var priorCrisis = clamp(0.05 + (r - 1) * 0.08, 0.05, 0.45);
    var priorTension = clamp(0.25 + (r - 1) * 0.04, 0.25, 0.42);
    var priorCalm = Math.max(0.10, 1 - priorCrisis - priorTension);
    var priors = { Calm: priorCalm, Tension: priorTension, Crisis: priorCrisis };

    var post = {};
    var sum = 0;
    REGIMES.forEach(function (rg) {
      var likelihood = rg === perceived ? acc : (1 - acc) * 0.5;
      post[rg] = priors[rg] * likelihood;
      sum += post[rg];
    });
    REGIMES.forEach(function (rg) { post[rg] = sum > 0 ? post[rg] / sum : 1 / 3; });
    return post;
  }

  function getNoisyComboMatrix(state, playerState, countryId, intelSpend) {
    var round = state.round || 1;
    var briefing = state.briefing || {};
    var closedTags = briefing.closedTags || [];
    var belief = estimateLatentRegimeBelief(state);
    var intelMult = intelErrorMultiplier(intelSpend);
    var noiseSigma = 0.09 * (1 + GAME_CONFIG.FORECAST_ROUND_NOISE_STEP * (round - 1)) * intelMult;

    var flags = {
      russiaTechBan: false,
      usTexTariff: false,
      hamburgStrike: false,
      indianCyclone: false,
      redSeaAlert: false
    };
    (briefing.events || []).forEach(function (ev) {
      var ef = ev.effects || {};
      if (ef.country === 'russia' && ef.bannedCommodity === 'electronics') flags.russiaTechBan = true;
      if (ef.country === 'usa' && ef.commodity === 'textiles') flags.usTexTariff = true;
      if (ef.country === 'germany' && (ef.delayDays || 0) >= 2) flags.hamburgStrike = true;
      if (ef.tag === 'indian-cyclone') flags.indianCyclone = true;
      if (ef.tag === 'redsea') flags.redSeaAlert = true;
    });

    var grid = {};
    COMMODITIES.forEach(function (cm) {
      grid[cm.id] = [];
      for (var st = 0; st < 3; st++) {
        var rt = ROUTES_BY_COUNTRY[countryId][st];
        if (isRouteClosed(rt, closedTags)) {
          grid[cm.id].push({ signal: 'closed', label: 'Closed', score: 0 });
          continue;
        }
        var expMult = 0;
        REGIMES.forEach(function (rg) {
          var res = evaluateTripleCombination(st, cm.id, countryId, rg, { round: round, flags: flags });
          expMult += belief[rg] * res.tripleMult;
        });
        var rng = mulberry32((state.seed ^ (round * 4999) ^ hashString(countryId + ':' + cm.id + ':' + st)) >>> 0);
        var noisyScore = expMult + randNormal(rng) * noiseSigma;
        var sig = 'neutral';
        var lbl = '~';
        if (noisyScore >= 1.18) { sig = 'strong_plus'; lbl = '++'; }
        else if (noisyScore >= 1.04) { sig = 'plus'; lbl = '+'; }
        else if (noisyScore <= 0.72) { sig = 'strong_minus'; lbl = '--'; }
        else if (noisyScore <= 0.89) { sig = 'minus'; lbl = '-'; }
        grid[cm.id].push({ signal: sig, label: lbl, score: noisyScore });
      }
    });
    return { countryId: countryId, belief: belief, grid: grid };
  }

  function analyzePlan(state, playerState, rawPlan) {
    var round = state.round || 1;
    var fleetSize = GAME_CONFIG.FLEET_SCHEDULE[round - 1];
    var briefing = state.briefing;
    var unlockedCountries = (briefing && briefing.unlockedCountries) || getUnlockedCountryIds(state.countryUnlockOrder, round);
    var closedTags = (briefing && briefing.closedTags) || [];
    var plan = validateAndNormalizePlan(rawPlan, closedTags, unlockedCountries);
    var triples = expandPlanToShipTriples(plan, fleetSize, closedTags, unlockedCountries);
    var inter = computeFleetInteractions(triples);

    var flags = {
      russiaTechBan: false,
      usTexTariff: false,
      hamburgStrike: false,
      indianCyclone: false,
      redSeaAlert: false
    };
    var estFuelMult = 1.0;
    (briefing.events || []).forEach(function (ev) {
      var ef = ev.effects || {};
      if (ef.fuelMult && ev.guaranteed) estFuelMult *= ef.fuelMult;
      if (ef.country === 'russia' && ef.bannedCommodity === 'electronics') flags.russiaTechBan = true;
      if (ef.country === 'usa' && ef.commodity === 'textiles') flags.usTexTariff = true;
      if (ef.country === 'germany' && (ef.delayDays || 0) >= 2) flags.hamburgStrike = true;
      if (ef.tag === 'indian-cyclone') flags.indianCyclone = true;
      if (ef.tag === 'redsea') flags.redSeaAlert = true;
    });

    var belief = estimateLatentRegimeBelief(state);
    var intelMult = intelErrorMultiplier(plan.intelSpend || 0);
    var roundNoiseMult = (1 + GAME_CONFIG.FORECAST_ROUND_NOISE_STEP * (round - 1)) * intelMult;

    // Sample 24 deterministic noisy scenarios across regime belief + shocks for p5 downside & loss probability
    var scenarioProfits = [];
    var nScen = 24;
    var scenRng = mulberry32((state.seed ^ (round * 13337) ^ hashString(JSON.stringify(plan.countryPct))) >>> 0);
    var activeCount = Math.max(1, (state.players || []).filter(function (p) { return !p.seized; }).length);

    for (var s = 0; s < nScen; s++) {
      var uReg = (s + 0.5) / nScen;
      var rg = uReg < belief.Calm ? 'Calm' : (uReg < belief.Calm + belief.Tension ? 'Tension' : 'Crisis');
      var regP = REGIME_PARAMS[rg];
      var fuelNoise = 1 + 0.08 * regP.volMult * randNormal(scenRng) * roundNoiseMult;
      var fuelP = GAME_CONFIG.FUEL_PRICE_PER_TON_BASE * Math.pow(state.priceIndex.crude_oil || 1, 0.8) * estFuelMult * Math.max(0.7, fuelNoise);

      var scenProf = -(plan.intelSpend || 0);
      var ownSupply = {};
      triples.forEach(function (tr) {
        var k = tr.countryId + ':' + tr.commodityId;
        ownSupply[k] = (ownSupply[k] || 0) + GAME_CONFIG.SHIP_CAPACITY;
      });

      triples.forEach(function (tr) {
        var co = getCountryById(tr.countryId);
        var cm = getCommodityById(tr.commodityId);
        var rt = tr.route;
        var days = rt.distanceNm / (rt.knots * 24);
        var speedMult = GAME_CONFIG.STANCE_SPEED_MULTS[tr.stanceIndex] || 1.0;
        var rep = (playerState && playerState.reputation && playerState.reputation[co.id]) || GAME_CONFIG.REP_INIT;

        var priceShock = clamp(Math.exp(cm.sigma * regP.volMult * randNormal(scenRng) * 0.65 * roundNoiseMult), 0.55, 1.85);
        var idxEst = (state.priceIndex[cm.id] || 1.0) * (1 + (state.forecastBias && state.forecastBias[cm.id] ? state.forecastBias[cm.id] : 0)) * priceShock;
        var buyP = cm.baseSellPrice * (state.priceIndex[cm.id] || 1) * (1 - cm.baseMargin * GAME_CONFIG.MARGIN_SCALE);
        var buyCost = GAME_CONFIG.SHIP_CAPACITY * buyP;

        if (co.id === 'russia' && cm.id === 'electronics' && flags.russiaTechBan) {
          scenProf += (buyCost * 0.40 - buyCost - 95000 - rt.toll - co.portFee - GAME_CONFIG.FIXED_OVERHEAD_PER_SHIP);
          return;
        }

        var combo = evaluateTripleCombination(tr.stanceIndex, cm.id, co.id, rg, { round: round, flags: flags });
        var key = co.id + ':' + cm.id;
        var depth = co.demandDepthPerPlayer * activeCount * (0.45 + 0.14 * fleetSize) * GAME_CONFIG.DEPTH_SCALE;
        var sat = saturationCurve((ownSupply[key] || 1000) / Math.max(700, depth));
        var delayEst = (rt.stanceIndex === 0 && scenRng() < 0.24) ? 2.8 : (0.5 + scenRng() * 1.4 * regP.riskFactor);
        var tau = days + delayEst;
        var decayV = Math.exp(-cm.spoilagePerDay * tau);
        var sellP = cm.baseSellPrice * idxEst * co.demand[cm.id] * co.exchangeRate * (0.94 + rep * 0.14) * sat * combo.tripleMult;
        var rev = GAME_CONFIG.SHIP_CAPACITY * decayV * sellP;

        var fuel = days * GAME_CONFIG.FUEL_BASE_TONS_PER_DAY * Math.pow(speedMult, 3) * (1 + 0.25 * cm.weightClass) * fuelP;
        var crew = tau * GAME_CONFIG.CREW_COST_PER_DAY;
        var rf = rt.riskFactor || 'general';
        var h_f = (inter.riskCounts[rf] || 1) / Math.max(1, triples.length);
        var r0 = GAME_CONFIG.INSURANCE_BASE_BY_STANCE[tr.stanceIndex] || 0.015;
        var laneN = inter.laneCounts[tr.stanceIndex + ':' + tr.countryId] || 1;
        var convoyDisc = 1 - GAME_CONFIG.CONVOY_INS_DISCOUNT_STEP * Math.min(2, Math.max(0, laneN - 1));
        var ins = Math.max(buyCost, 180000) * r0 * Math.exp(GAME_CONFIG.INSURANCE_BETA_RISK * regP.riskFactor) * (1 + GAME_CONFIG.INSURANCE_KAPPA_HHI * h_f * h_f) * convoyDisc;
        var maint = tau * GAME_CONFIG.WEAR_COST_PER_DAY_BASE * Math.pow(speedMult, 2.2);
        var tariff = rev * (co.baseTariff * cm.tariffSensitivity + (co.id === 'usa' && cm.id === 'textiles' && flags.usTexTariff ? 0.25 : 0));

        scenProf += rev - buyCost - fuel - rt.toll - co.portFee - crew - ins - maint - tariff - inter.complexityPerShip - GAME_CONFIG.FIXED_OVERHEAD_PER_SHIP;
      });
      scenarioProfits.push(scenProf);
    }

    scenarioProfits.sort(function (a, b) { return a - b; });
    var sumP = 0;
    var losses = 0;
    scenarioProfits.forEach(function (v) { sumP += v; if (v < 0) losses++; });
    var expected = Math.round(sumP / nScen);
    var p5 = Math.round(scenarioProfits[Math.max(0, Math.floor(nScen * 0.05))]);
    var p95 = Math.round(scenarioProfits[Math.min(nScen - 1, Math.floor(nScen * 0.90))]);
    var lossProb = losses / nScen;

    // Qualitative chips per ship / fleet (no exact formulas exposed)
    var chips = [];
    var seenChip = {};
    function pushChip(type, text) {
      if (seenChip[text] || chips.length >= 6) return;
      seenChip[text] = true;
      chips.push({ type: type, text: text });
    }

    triples.forEach(function (tr) {
      var co = getCountryById(tr.countryId);
      var cm = getCommodityById(tr.commodityId);
      if (co.id === 'russia' && cm.id === 'electronics' && flags.russiaTechBan) {
        pushChip('bad', 'Sanctioned tech to Russia: confiscation hazard');
      }
      if ((cm.id === 'spices_tea' || cm.id === 'wheat') && tr.stanceIndex === 2 && (co.id === 'usa' || co.id === 'uk' || co.id === 'germany' || co.id === 'france' || co.id === 'russia')) {
        pushChip('bad', 'Perishable on long route: strong drag');
      }
      if (cm.id === 'fertilizer' && tr.stanceIndex === 0) {
        pushChip('warn', 'Heavy bulk on Express speed: steep fuel burn');
      }
      if (cm.id === 'crude_oil' && tr.route.corridorKind === 'suez' && (flags.redSeaAlert || belief.Crisis > 0.22)) {
        pushChip('warn', 'Crude in Red Sea corridor: elevated war-risk');
      }
      if ((co.id === 'australia' || co.id === 'new_zealand') && cm.id === 'fertilizer') {
        pushChip('good', co.name + ' fertilizer: seasonal demand alignment');
      }
      if (co.id === 'germany' && cm.id === 'electronics' && tr.stanceIndex === 0 && belief.Calm > 0.40) {
        pushChip('good', 'Hamburg Express tech: strong timing upside');
      }
      if ((cm.id === 'wheat' || cm.id === 'fertilizer') && tr.stanceIndex === 2) {
        pushChip('good', 'Slow & Safe bulk haul: low spoilage & blockade proof');
      }
    });

    Object.keys(inter.laneCounts).forEach(function (lk) {
      if (inter.laneCounts[lk] >= 2) {
        pushChip('good', 'Same-lane convoy: insurance relief');
      }
    });
    if (inter.hasSuezCapeHedge) {
      pushChip('good', 'Suez + Cape split: partial corridor hedge');
    }
    if (inter.riskHHI >= 0.72 && triples.length >= 3) {
      pushChip('warn', 'Concentrated fleet exposure: amplified tail risk');
    }
    if (inter.nDistinct >= 4) {
      pushChip('warn', 'Many distinct lanes: higher admin complexity');
    }

    return {
      expected: expected,
      low: p5,
      high: p95,
      p5Downside: p5,
      lossProb: lossProb,
      hhi: inter.riskHHI,
      nDistinct: inter.nDistinct,
      uncertainty: briefing.uncertainty,
      triples: triples,
      chips: chips
    };
  }

  function estimatePlanProfitRange(state, playerState, rawPlan) {
    var a = analyzePlan(state, playerState, rawPlan);
    return {
      expected: a.expected,
      low: a.low,
      high: a.high,
      uncertainty: a.uncertainty
    };
  }

  // =========================================================================
  // 11. POST-MORTEM COUNTERFACTUAL ANALYZER (Top 3 Mistakes & Top 2 Wise Calls)
  // =========================================================================
  function cloneStateShallow(st) {
    return JSON.parse(JSON.stringify(st));
  }

  function replayAllRoundsWithOverride(seed, playersCfg, basePlansByRound, targetPlayerId, overrideRound, shipIdx, newTriple) {
    var st = createMatchState(playersCfg, seed, { fastSim: true });
    for (var r = 1; r <= GAME_CONFIG.ROUNDS; r++) {
      var plans = {};
      var rPlans = basePlansByRound[r - 1] || {};
      st.players.forEach(function (pl) {
        var p = rPlans[pl.id] ? JSON.parse(JSON.stringify(rPlans[pl.id])) : createDefaultPlan(st.briefing.closedTags, st.briefing.unlockedCountries);
        if (pl.id === targetPlayerId && r === overrideRound) {
          var fleetSize = GAME_CONFIG.FLEET_SCHEDULE[r - 1];
          var triples = expandPlanToShipTriples(p, fleetSize, st.briefing.closedTags, st.briefing.unlockedCountries);
          if (triples[shipIdx]) {
            triples[shipIdx] = Object.assign({}, triples[shipIdx], newTriple);
            p.shipTriples = triples;
          }
        }
        plans[pl.id] = p;
      });
      resolveRound(st, plans);
    }
    var target = st.players.find(function (p) { return p.id === targetPlayerId; });
    return target ? (target.cash - (target.debt || 0) - GAME_CONFIG.STARTING_CASH) : 0;
  }

  function computePostMortem(matchState, targetPlayerId) {
    if (!matchState || !matchState.history || !matchState.history.length) {
      return { mistakes: [], wiseCalls: [] };
    }
    var playersCfg = matchState.players.map(function (p) {
      return { id: p.id, name: p.name, color: p.color, isBot: p.isBot, botStyle: p.botStyle };
    });
    var basePlansByRound = matchState.history.map(function (h) { return h.plans || {}; });
    var targetPl = matchState.players.find(function (p) { return p.id === targetPlayerId; });
    if (!targetPl) return { mistakes: [], wiseCalls: [] };

    var baseFinalProfit = (targetPl.cash - (targetPl.debt || 0)) - GAME_CONFIG.STARTING_CASH;
    var candidates = [];

    for (var rIdx = 0; rIdx < matchState.history.length; rIdx++) {
      var h = matchState.history[rIdx];
      var rep = h.playerReports && h.playerReports[targetPlayerId];
      if (!rep || rep.seized || !rep.ships || !rep.ships.length) continue;

      var unlocked = getUnlockedCountryIds(matchState.countryUnlockOrder, h.round);
      var closedTags = h.closedTags || [];
      // Test swaps on up to 2 representative ships per round to stay instant in browser
      var step = rep.ships.length > 3 ? 2 : 1;
      for (var sIdx = 0; sIdx < rep.ships.length; sIdx += step) {
        var sh = rep.ships[sIdx];
        // 1. Route swaps
        for (var st = 0; st < 3; st++) {
          if (st === sh.stanceIndex) continue;
          var rt = ROUTES_BY_COUNTRY[sh.countryId][st];
          if (isRouteClosed(rt, closedTags)) continue;
          var altProfit = replayAllRoundsWithOverride(matchState.seed, playersCfg, basePlansByRound, targetPlayerId, h.round, sIdx, { stanceIndex: st });
          candidates.push({
            round: h.round,
            shipIndex: sh.shipIndex,
            kind: 'route',
            fromLabel: sh.countryName + ' · ' + sh.commodityName + ' (' + ROUTES_BY_COUNTRY[sh.countryId][sh.stanceIndex].stanceLabel + ')',
            toLabel: rt.stanceLabel + ' (' + rt.label + ')',
            delta: Math.round(altProfit - baseFinalProfit)
          });
        }
        // 2. Commodity swaps (test 3 diverse commodities)
        var testComms = ['spices_tea', 'crude_oil', 'fertilizer', 'electronics', 'wheat'].filter(function (c) { return c !== sh.commodityId; }).slice(0, 3);
        testComms.forEach(function (cid) {
          var altProfit = replayAllRoundsWithOverride(matchState.seed, playersCfg, basePlansByRound, targetPlayerId, h.round, sIdx, { commodityId: cid });
          candidates.push({
            round: h.round,
            shipIndex: sh.shipIndex,
            kind: 'commodity',
            fromLabel: sh.countryName + ' · ' + sh.commodityName,
            toLabel: getCommodityById(cid).name,
            delta: Math.round(altProfit - baseFinalProfit)
          });
        });
        // 3. Country swaps (test up to 2 unlocked countries)
        var testCountries = unlocked.filter(function (c) { return c !== sh.countryId; }).slice(0, 2);
        testCountries.forEach(function (cid) {
          var altSt = sanitizeRouteStance(cid, sh.stanceIndex, closedTags);
          var altProfit = replayAllRoundsWithOverride(matchState.seed, playersCfg, basePlansByRound, targetPlayerId, h.round, sIdx, { countryId: cid, stanceIndex: altSt });
          candidates.push({
            round: h.round,
            shipIndex: sh.shipIndex,
            kind: 'country',
            fromLabel: sh.countryName + ' · ' + sh.commodityName,
            toLabel: getCountryById(cid).name,
            delta: Math.round(altProfit - baseFinalProfit)
          });
        });
      }
    }

    // Positive delta means the swap would have earned MORE -> original choice was a mistake
    var mistakes = candidates.filter(function (c) { return c.delta > 8000; })
      .sort(function (a, b) { return b.delta - a.delta; })
      .slice(0, 3)
      .map(function (c) {
        return {
          round: c.round,
          text: 'R' + c.round + ' Ship #' + c.shipIndex + ': ' + c.fromLabel + ' -> swapping to ' + c.toLabel,
          impact: -c.delta
        };
      });

    // Negative delta means swapping away would have LOST money -> original choice was a wise call
    var wiseCalls = candidates.filter(function (c) { return c.delta < -5000; })
      .sort(function (a, b) { return a.delta - b.delta; })
      .slice(0, 2)
      .map(function (c) {
        return {
          round: c.round,
          text: 'R' + c.round + ' Ship #' + c.shipIndex + ': kept ' + c.fromLabel + ' instead of ' + c.toLabel,
          impact: -c.delta
        };
      });

    return { mistakes: mistakes, wiseCalls: wiseCalls };
  }

  // =========================================================================
  // 12. AI STRATEGY ZOO (10 Strategies Including Adaptive & Oracle)
  // =========================================================================
  function buildStrategyPlan(strategyName, state, playerState, rng) {
    var briefing = state.briefing;
    var closedTags = briefing.closedTags || [];
    var round = state.round;
    var fleetSize = GAME_CONFIG.FLEET_SCHEDULE[round - 1];
    var cIds = COUNTRIES.map(function (c) { return c.id; });
    var unlockedIds = (briefing && briefing.unlockedCountries && briefing.unlockedCountries.length)
      ? briefing.unlockedCountries.slice()
      : getUnlockedCountryIds(state.countryUnlockOrder, round);
    var mIds = COMMODITIES.map(function (c) { return c.id; });

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
      return { countryPct: cp, commodityPct: mp, routeStance: rs, intelSpend: 0 };
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

    if (strategyName === 'all-highest-margin-today') {
      // Naively chases highest raw spot margin (sell - buy) & highest country exchange*demand on Fast route
      var bestComm = mIds[0];
      var bestMargin = -Infinity;
      mIds.forEach(function (mid) {
        var cm = getCommodityById(mid);
        var idx = state.priceIndex[mid] || 1;
        var margin = cm.baseSellPrice * idx - cm.baseSellPrice * idx * (1 - cm.baseMargin);
        if (margin > bestMargin) { bestMargin = margin; bestComm = mid; }
      });
      var bestC = unlockedIds[0];
      var bestCScore = -Infinity;
      unlockedIds.forEach(function (cid) {
        var co = getCountryById(cid);
        var sc = co.demand[bestComm] * co.exchangeRate * (state.demandDrift[cid][bestComm] || 1);
        if (sc > bestCScore) { bestCScore = sc; bestC = cid; }
      });
      var cpM = emptyMap(cIds);
      cpM[bestC] = 100;
      var mpM = emptyMap(mIds);
      mpM[bestComm] = 100;
      var rsM = {};
      cIds.forEach(function (id) { rsM[id] = sanitizeRouteStance(id, 0, closedTags); });
      return validateAndNormalizePlan({ countryPct: cpM, commodityPct: mpM, routeStance: rsM }, closedTags, unlockedIds);
    }

    if (strategyName === 'always-fastest-route' || strategyName === 'always-fastest') {
      var rsFast = {};
      cIds.forEach(function (id) { rsFast[id] = sanitizeRouteStance(id, 0, closedTags); });
      return validateAndNormalizePlan({
        countryPct: { germany: 20, uk: 15, france: 15, russia: 10, usa: 20, australia: 10, new_zealand: 10 },
        commodityPct: { crude_oil: 20, wheat: 15, fertilizer: 15, spices_tea: 18, textiles: 17, electronics: 15 },
        routeStance: rsFast
      }, closedTags, unlockedIds);
    }

    if (strategyName === 'always-safest-route' || strategyName === 'always-safest') {
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
        countryPct: { germany: 16, uk: 14, france: 14, russia: 12, usa: 16, australia: 14, new_zealand: 14 },
        commodityPct: { crude_oil: 17, wheat: 17, fertilizer: 17, spices_tea: 17, textiles: 16, electronics: 16 },
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
      var rusPct = round >= 3 ? 0 : 8;
      return validateAndNormalizePlan({
        countryPct: { germany: 18, uk: 16, france: 16, russia: rusPct, usa: 18, australia: 16, new_zealand: 16 },
        commodityPct: { crude_oil: 20, wheat: 22, fertilizer: 26, spices_tea: 12, textiles: 12, electronics: 8 },
        routeStance: rsC
      }, closedTags, unlockedIds);
    }

    if (strategyName === 'greedy-last-round-winner' || strategyName === 'Greedy') {
      if (state.history && state.history.length > 0) {
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
      return validateAndNormalizePlan({
        countryPct: { germany: 25, uk: 10, france: 10, russia: 30, usa: 25, australia: 0, new_zealand: 0 },
        commodityPct: { crude_oil: 10, wheat: 5, fertilizer: 5, spices_tea: 15, textiles: 15, electronics: 50 },
        routeStance: { germany: 0, uk: 0, france: 0, russia: 0, usa: 0, australia: 0, new_zealand: 0 }
      }, closedTags, unlockedIds);
    }

    // ADAPTIVE vs ORACLE
    var isOracle = (strategyName === 'oracle' || strategyName === 'Oracle');
    var belief = isOracle
      ? { Calm: state.regime === 'Calm' ? 1 : 0, Tension: state.regime === 'Tension' ? 1 : 0, Crisis: state.regime === 'Crisis' ? 1 : 0 }
      : estimateLatentRegimeBelief(state);

    var flags = {
      russiaTechBan: false,
      usTexTariff: false,
      hamburgStrike: false,
      indianCyclone: false,
      redSeaAlert: false
    };
    var knownPriceBonus = {};
    mIds.forEach(function (mid) { knownPriceBonus[mid] = 1.0; });

    var intelList = isOracle
      ? briefing.events.concat(briefing.surprises || [])
      : briefing.events;

    var knownCountryCommMult = {};
    var knownCountryDelay = {};
    var knownCountryFee = {};
    var knownTagDelay = {};
    var knownTagFee = {};
    var knownFuelMult = 1.0;
    var oracleHighRiskBlocked = false;

    if (isOracle) {
      var oracleRollRng = mulberry32(state.seed ^ (round * 1597334677));
      var oracleOutcome = rollBriefingOutcomes(briefing, oracleRollRng, state.regime);
      intelList = oracleOutcome.rolledEvents.concat(oracleOutcome.surprises || []);
    }

    intelList.forEach(function (ev) {
      var ef = ev.effects || {};
      var mag = ev.magMult || 1.0;
      if (ef.blockHighRisk) oracleHighRiskBlocked = true;
      if (ef.country === 'russia' && ef.bannedCommodity === 'electronics') flags.russiaTechBan = true;
      if (ef.country === 'usa' && ef.commodity === 'textiles') flags.usTexTariff = true;
      if (ef.country === 'germany' && (ef.delayDays || 0) >= 2) flags.hamburgStrike = true;
      if (ef.tag === 'indian-cyclone') flags.indianCyclone = true;
      if (ef.tag === 'redsea') flags.redSeaAlert = true;
      if (isOracle || ev.guaranteed) {
        if (ef.commodity && ef.priceShock) knownPriceBonus[ef.commodity] *= Math.exp(ef.priceShock * 0.90);
        if (ev.targetType === 'commodity' && ev.target && ev.priceShock) knownPriceBonus[ev.target] *= Math.exp(ev.priceShock * 0.90);
        var cObj = ef.commodities || ev.commodities;
        if (cObj) {
          Object.keys(cObj).forEach(function (cid) {
            if (knownPriceBonus[cid] != null) {
              var shock = cObj[cid] > 0.45 ? Math.log(cObj[cid]) : cObj[cid];
              knownPriceBonus[cid] *= Math.exp(shock * 0.90);
            }
          });
        }
        if (isOracle) {
          if (ev.fuelMult) knownFuelMult *= ev.fuelMult;
          if (ef.fuelMult) knownFuelMult *= ef.fuelMult;
          if (ef.country && !ef.commodity) {
            knownCountryDelay[ef.country] = (knownCountryDelay[ef.country] || 0) + (ef.delayDays || 0) * mag;
            knownCountryFee[ef.country] = (knownCountryFee[ef.country] || 0) + (ef.feeAdd || 0) * mag;
          }
          if (ef.tag) {
            knownTagDelay[ef.tag] = (knownTagDelay[ef.tag] || 0) + (ef.delayDays || 0) * mag;
            knownTagFee[ef.tag] = (knownTagFee[ef.tag] || 0) + (ef.feeAdd || 0) * mag + (ef.tollAdd || 0) * mag;
          }
          if (ev.targetType === 'countryCommodity' && ev.countries && ev.commodity && ev.demandMult) {
            ev.countries.forEach(function (cid) {
              var k = cid + ':' + ev.commodity;
              knownCountryCommMult[k] = (knownCountryCommMult[k] || 1) * ev.demandMult;
            });
          }
          if (ev.targetType === 'countries' && ev.target) {
            ev.target.forEach(function (cid) {
              knownCountryDelay[cid] = (knownCountryDelay[cid] || 0) + (ev.delayDays || 0) * mag;
              knownCountryFee[cid] = (knownCountryFee[cid] || 0) + (ev.feeAdd || 0) * mag;
            });
          }
          if (ev.targetType === 'routeTag' && ev.target) {
            knownTagDelay[ev.target] = (knownTagDelay[ev.target] || 0) + (ev.delayDays || 0) * mag;
            knownTagFee[ev.target] = (knownTagFee[ev.target] || 0) + (ev.feeAdd || 0) * mag;
          }
        }
      }
    });

    // Score every valid triple (r, k, c) under expected regime belief (or exact regime + outcomes for Oracle)
    var candidateTriples = [];
    unlockedIds.forEach(function (cid) {
      var co = getCountryById(cid);
      var rep = (playerState && playerState.reputation && playerState.reputation[cid]) != null
        ? playerState.reputation[cid] : GAME_CONFIG.REP_INIT;

      for (var st = 0; st < 3; st++) {
        var rt = ROUTES_BY_COUNTRY[cid][st];
        if (isRouteClosed(rt, closedTags)) continue;
        if (isOracle && oracleHighRiskBlocked && st === 0) continue;

        mIds.forEach(function (mid) {
          if (cid === 'russia' && mid === 'electronics' && (flags.russiaTechBan || round >= 3)) return;

          var cm = getCommodityById(mid);
          var curIdx = state.priceIndex[mid] || 1.0;
          var expIdx = curIdx * Math.exp(cm.theta * (0 - (state.logPrices[mid] || 0))) * knownPriceBonus[mid];
          if (!isOracle) {
            var biasNoise = (state.forecastBias && state.forecastBias[mid]) ? state.forecastBias[mid] * 0.95 : 0;
            var estNoise = rng ? randNormal(rng) * 0.115 : 0;
            expIdx *= (1 + biasNoise + estNoise);
          }

          var days = rt.distanceNm / (rt.knots * 24);
          var speedMult = GAME_CONFIG.STANCE_SPEED_MULTS[st] || 1.0;
          var expectedVal = 0;

          REGIMES.forEach(function (rg) {
            var wReg = belief[rg];
            if (wReg <= 0) return;
            var regP = REGIME_PARAMS[rg];
            var combo = evaluateTripleCombination(st, mid, cid, rg, { round: round, flags: flags });
            var extraDelay = isOracle ? (knownCountryDelay[cid] || 0) : 0;
            var extraFee = isOracle ? (knownCountryFee[cid] || 0) : 0;
            if (isOracle) rt.tags.forEach(function (t) {
              extraDelay += (knownTagDelay[t] || 0);
              extraFee += (knownTagFee[t] || 0);
            });
            var estDelay = (st === 0 ? 0.75 : 0.35) + regP.riskFactor * 0.95 + extraDelay;
            var tau = days + estDelay;
            var decayV = Math.exp(-cm.spoilagePerDay * tau);
            var effM = clamp(0.095 + (cm.baseMargin - 0.14) * GAME_CONFIG.MARGIN_SCALE, 0.07, 0.30);
            var buyP = cm.baseSellPrice * curIdx * (1 - effM);
            var surpriseMult = knownCountryCommMult[cid + ':' + mid] || 1.0;
            var dDrift = state.demandDrift[cid][mid] || 1;
            var estDemandDrift = isOracle ? dDrift : (1 + (dDrift - 1) * 0.30);
            var sellP = cm.baseSellPrice * expIdx * co.demand[mid] * estDemandDrift * surpriseMult * co.exchangeRate * (0.94 + rep * 0.14) * combo.tripleMult;
            var rev = GAME_CONFIG.SHIP_CAPACITY * decayV * sellP;
            var buyCost = GAME_CONFIG.SHIP_CAPACITY * buyP;
            var fuelP = GAME_CONFIG.FUEL_PRICE_PER_TON_BASE * Math.pow(state.priceIndex.crude_oil || 1, 0.8) * knownFuelMult * (rg === 'Crisis' ? 1.15 : 1.0);
            var fuel = days * GAME_CONFIG.FUEL_BASE_TONS_PER_DAY * Math.pow(speedMult, 3) * (1 + 0.25 * cm.weightClass) * fuelP;
            var crew = tau * GAME_CONFIG.CREW_COST_PER_DAY;
            var ins = Math.max(buyCost, 180000) * GAME_CONFIG.INSURANCE_BASE_BY_STANCE[st] * Math.exp(GAME_CONFIG.INSURANCE_BETA_RISK * regP.riskFactor);
            var maint = tau * GAME_CONFIG.WEAR_COST_PER_DAY_BASE * Math.pow(speedMult, 2.2);
            var tariff = rev * (co.baseTariff * cm.tariffSensitivity + (cid === 'usa' && mid === 'textiles' && flags.usTexTariff ? 0.25 : 0));
            var net = rev - buyCost - fuel - rt.toll - co.portFee - extraFee - crew - ins - maint - tariff - GAME_CONFIG.FIXED_OVERHEAD_PER_SHIP;

            // Oracle knows exact contract bonuses & event penalties
            if (isOracle) {
              if (co.id === 'usa' && cm.id === 'textiles' && flags.usTexTariff) net -= 18000;
              if (co.id === 'germany' && st === 0 && flags.hamburgStrike) net -= 28000;
              if (flags.indianCyclone && (co.id === 'australia' || co.id === 'new_zealand') && st < 2) net -= 36000;
              briefing.contracts.forEach(function (ct) {
                if (ct.countryId === cid && ct.commodityId === mid) net += ct.bonusPool * 1.15;
              });
            }
            expectedVal += wReg * net;
          });

          // Lane experience bonus & contract awareness for Adaptive
          var laneN = (playerState && playerState.laneExp && playerState.laneExp[st + ':' + cid + ':' + mid]) || 0;
          expectedVal += laneN * 4000;
          if (!isOracle) {
            briefing.contracts.forEach(function (ct) {
              if (ct.countryId === cid && ct.commodityId === mid) expectedVal += ct.bonusPool * 0.20;
            });
          }

          candidateTriples.push({
            countryId: cid,
            commodityId: mid,
            stanceIndex: st,
            route: rt,
            score: expectedVal
          });
        });
      }
    });

    candidateTriples.sort(function (a, b) { return b.score - a.score; });

    // Greedy fleet builder accounting for saturation, HHI concentration, convoy & complexity cost!
    var chosenTriples = [];
    var usedCountryComm = {};
    var usedCountryCount = {};
    var usedRiskCount = {};
    var maxDistinct = isOracle ? Math.min(4, Math.max(1, fleetSize)) : (fleetSize <= 2 ? 1 : (fleetSize <= 4 ? 2 : 3));

    for (var sIdx = 0; sIdx < fleetSize; sIdx++) {
      var bestChoice = null;
      var bestMarginal = -Infinity;

      var limit = Math.min(candidateTriples.length, isOracle ? 35 : 22);
      for (var cIdx = 0; cIdx < limit; cIdx++) {
        var cand = candidateTriples[cIdx];
        var marginal = cand.score;

        // Self-saturation penalty on same (k, c)
        var kcKey = cand.countryId + ':' + cand.commodityId;
        var priorKC = usedCountryComm[kcKey] || 0;
        marginal -= priorKC * (isOracle ? 38000 : 48000);

        // Country congestion penalty
        var priorC = usedCountryCount[cand.countryId] || 0;
        marginal -= priorC * 14000;

        // HHI risk concentration penalty
        var rf = cand.route.riskFactor || 'general';
        var priorRF = usedRiskCount[rf] || 0;
        marginal -= (priorRF / Math.max(1, fleetSize)) * 36000;

        // Complexity penalty for adding a new distinct triple
        var isNewTriple = !chosenTriples.some(function (t) {
          return t.countryId === cand.countryId && t.commodityId === cand.commodityId && t.stanceIndex === cand.stanceIndex;
        });
        var curDistinct = chosenTriples.reduce(function (acc, t) {
          var tk = t.stanceIndex + ':' + t.countryId + ':' + t.commodityId;
          acc[tk] = true;
          return acc;
        }, {});
        var distinctNum = Object.keys(curDistinct).length;
        if (isNewTriple) {
          if (distinctNum >= maxDistinct && chosenTriples.length > 0) {
            marginal -= 65000;
          } else {
            marginal -= 15000;
          }
        } else {
          // Convoy discount bonus!
          marginal += 11000;
        }

        if (marginal > bestMarginal) {
          bestMarginal = marginal;
          bestChoice = cand;
        }
      }

      if (bestChoice) {
        chosenTriples.push({
          shipIndex: sIdx,
          countryId: bestChoice.countryId,
          commodityId: bestChoice.commodityId,
          stanceIndex: bestChoice.stanceIndex,
          route: bestChoice.route
        });
        var kck = bestChoice.countryId + ':' + bestChoice.commodityId;
        usedCountryComm[kck] = (usedCountryComm[kck] || 0) + 1;
        usedCountryCount[bestChoice.countryId] = (usedCountryCount[bestChoice.countryId] || 0) + 1;
        var rfk = bestChoice.route.riskFactor || 'general';
        usedRiskCount[rfk] = (usedRiskCount[rfk] || 0) + 1;
      }
    }

    // Build compatible countryPct, commodityPct, commodityPctByCountry, routeStance AND exact shipTriples
    var cpOut = emptyMap(cIds);
    var mpOut = emptyMap(mIds);
    var rsOut = {};
    var byCountry = {};

    chosenTriples.forEach(function (tr) {
      cpOut[tr.countryId] += 100 / fleetSize;
      mpOut[tr.commodityId] += 100 / fleetSize;
      rsOut[tr.countryId] = tr.stanceIndex;
      if (!byCountry[tr.countryId]) byCountry[tr.countryId] = emptyMap(mIds);
      byCountry[tr.countryId][tr.commodityId] += 100;
    });
    cIds.forEach(function (cid) {
      if (rsOut[cid] == null) rsOut[cid] = sanitizeRouteStance(cid, 1, closedTags);
    });

    var norm = validateAndNormalizePlan({
      countryPct: cpOut,
      commodityPct: mpOut,
      commodityPctByCountry: Object.keys(byCountry).length > 1 ? byCountry : null,
      routeStance: rsOut,
      intelSpend: 0,
      shipTriples: chosenTriples
    }, closedTags, unlockedIds);

    return norm;
  }

  function getCaptainsHint(state, playerState) {
    var rng = mulberry32((state.seed ^ (state.round * 9973)) >>> 0);
    var plan = buildStrategyPlan('adaptive', state, playerState, rng);
    var reasons = [];
    (state.briefing.events || []).forEach(function (ev) {
      if (ev.id === 'r3_russia_sanctions') reasons.push('Avoid shipping Electronics to Russia (sanctioned).');
      if (ev.id === 'r4_us_tariff') reasons.push('Trim Textiles to USA due to the +25% tariff.');
      if (ev.id === 'r4_suez_closed' || ev.id === 'r5_redsea_closed') reasons.push('Route Europe & USA fleets via the Cape.');
      if (ev.id === 'r2_redsea_piracy') reasons.push('Consider Cape bypass or convoy discipline around Red Sea piracy.');
      if (ev.id === 'r5_agri_spike') reasons.push('Lean into Wheat & Fertilizer during global shortages.');
    });
    if (state.briefing.contracts && state.briefing.contracts.length > 0) {
      reasons.push('Target contract bonus: ' + state.briefing.contracts[0].label + '.');
    }
    if (reasons.length === 0) {
      reasons.push('Pair cargo decay and route speed carefully; avoid overloading one chokepoint.');
    }
    return { plan: plan, reasons: reasons };
  }

  return {
    GAME_CONFIG: GAME_CONFIG,
    REGIMES: REGIMES,
    REGIME_PARAMS: REGIME_PARAMS,
    PORTS: PORTS,
    CHOKEPOINTS: CHOKEPOINTS,
    COUNTRIES: COUNTRIES,
    COMMODITIES: COMMODITIES,
    ROUTES_BY_COUNTRY: ROUTES_BY_COUNTRY,
    mulberry32: mulberry32,
    saturationCurve: saturationCurve,
    intelErrorMultiplier: intelErrorMultiplier,
    getSeasonalFactor: getSeasonalFactor,
    evaluateTripleCombination: evaluateTripleCombination,
    allocateShipsFromPct: allocateShipsFromPct,
    allocateCommoditiesToShips: allocateCommoditiesToShips,
    expandPlanToShipTriples: expandPlanToShipTriples,
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
    analyzePlan: analyzePlan,
    estimatePlanProfitRange: estimatePlanProfitRange,
    getNoisyComboMatrix: getNoisyComboMatrix,
    computePostMortem: computePostMortem,
    getScoreIndex: getScoreIndex,
    getRankTitle: getRankTitle,
    buildStrategyPlan: buildStrategyPlan,
    getCaptainsHint: getCaptainsHint,
    getCountryById: getCountryById,
    getCommodityById: getCommodityById
  };
}));
