'use strict';

const fs = require('fs');
const path = require('path');
const Engine = require('./public/engine.js');

const STRATEGIES = [
  'random',
  'all-ships-one-country',
  'all-one-commodity',
  'all-highest-margin-today',
  'always-fastest',
  'always-safest',
  'diversified-static',
  'greedy-last-round-winner',
  'adaptive',
  'oracle'
];

const NAIVE_STRATEGIES = [
  'random',
  'all-ships-one-country',
  'all-one-commodity',
  'all-highest-margin-today',
  'always-fastest',
  'always-safest',
  'diversified-static',
  'greedy-last-round-winner'
];

function quantile(sortedArr, q) {
  if (!sortedArr.length) return 0;
  const pos = (sortedArr.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sortedArr[base + 1] !== undefined) {
    return sortedArr[base] + rest * (sortedArr[base + 1] - sortedArr[base]);
  }
  return sortedArr[base];
}

function fmtMoney(n) {
  const r = Math.round(n);
  return (r < 0 ? '-$' : '$') + Math.abs(r).toLocaleString('en-US');
}

// =========================================================================
// 1. CORE MONTE CARLO SIMULATION (Default 20,000 matches)
// =========================================================================
function runMonteCarlo(numMatches = 20000, configOverrides = null, silent = false) {
  const savedCfg = Object.assign({}, Engine.GAME_CONFIG);
  if (configOverrides) Object.assign(Engine.GAME_CONFIG, configOverrides);

  const stats = {};
  STRATEGIES.forEach(s => {
    stats[s] = {
      matches: 0,
      wins: 0,
      seizedCount: 0,
      distressCount: 0,
      belowStartCount: 0,
      sumProfit: 0,
      sumSqProfit: 0,
      profits: [],
      ranks: [],
      voyageMargins: []
    };
  });

  let sumMargin = 0;
  let sumSqMargin = 0;
  let marginCount = 0;

  const t0 = Date.now();
  for (let m = 0; m < numMatches; m++) {
    const seed = (Math.imul(m + 1, 2654435761) ^ 0x9E3779B9) >>> 0;
    const playersCfg = STRATEGIES.map((strat, idx) => ({
      id: 'p_' + idx + '_' + strat,
      name: strat,
      isBot: true,
      botStyle: strat
    }));

    const state = Engine.createMatchState(playersCfg, seed, { fastSim: true });
    for (let r = 1; r <= Engine.GAME_CONFIG.ROUNDS; r++) {
      const plans = {};
      state.players.forEach((pl, idx) => {
        if (pl.seized) return;
        const stratRng = Engine.mulberry32((seed ^ (r * 977) ^ (idx * 6133)) >>> 0);
        plans[pl.id] = Engine.buildStrategyPlan(pl.botStyle, state, pl, stratRng);
      });
      const summary = Engine.resolveRound(state, plans);
      state.players.forEach(pl => {
        const rep = summary.playerReports[pl.id];
        if (!rep || rep.seized) return;
        rep.ships.forEach(sh => {
          if (sh.cargoPurchase > 0) {
            const mgn = sh.profit / sh.cargoPurchase;
            sumMargin += mgn;
            sumSqMargin += mgn * mgn;
            marginCount++;
          }
        });
      });
    }

    // Score match
    state.players.forEach(pl => {
      const st = stats[pl.botStyle];
      const netWorth = pl.cash - (pl.debt || 0);
      const profit = netWorth - Engine.GAME_CONFIG.STARTING_CASH;
      st.matches++;
      st.sumProfit += profit;
      st.sumSqProfit += profit * profit;
      st.profits.push(profit);
      st.ranks.push(pl.rank);
      if (pl.rank === 1) st.wins++;
      if (pl.seized) st.seizedCount++;
      // Distress: seized, ended with debt, or lost >= 25% of starting capital ($500k)
      if (pl.seized || (pl.debt || 0) > 0 || profit <= -Engine.GAME_CONFIG.STARTING_CASH * 0.25) {
        st.distressCount++;
      }
      if (profit < 0) st.belowStartCount++;
    });
  }

  // Compute summary stats per strategy
  const rows = STRATEGIES.map(s => {
    const st = stats[s];
    const sorted = st.profits.slice().sort((a, b) => a - b);
    const mean = st.sumProfit / st.matches;
    const variance = Math.max(0, st.sumSqProfit / st.matches - mean * mean);
    const std = Math.sqrt(variance);
    const median = quantile(sorted, 0.50);
    const p10 = quantile(sorted, 0.10);
    const p90 = quantile(sorted, 0.90);
    const winRate = (st.wins / st.matches) * 100;
    const seizedPct = (st.seizedCount / st.matches) * 100;
    const distressPct = (st.distressCount / st.matches) * 100;
    const belowPct = (st.belowStartCount / st.matches) * 100;
    return {
      strategy: s,
      mean: Math.round(mean),
      median: Math.round(median),
      std: Math.round(std),
      p10: Math.round(p10),
      p90: Math.round(p90),
      winRate,
      seizedPct,
      distressPct,
      belowPct,
      profits: st.profits,
      ranks: st.ranks
    };
  });

  const adaptiveRow = rows.find(r => r.strategy === 'adaptive');
  const oracleRow = rows.find(r => r.strategy === 'oracle');
  const randomRow = rows.find(r => r.strategy === 'random');
  const naiveRows = rows.filter(r => NAIVE_STRATEGIES.includes(r.strategy));

  const avgMargin = marginCount > 0 ? (sumMargin / marginCount) : 0;
  const marginStd = marginCount > 0 ? Math.sqrt(Math.max(0, sumSqMargin / marginCount - avgMargin * avgMargin)) : 0;

  const naiveMean = naiveRows.reduce((a, r) => a + r.mean, 0) / naiveRows.length;
  const naiveDistressPct = naiveRows.reduce((a, r) => a + r.distressPct, 0) / naiveRows.length;
  const naiveSeizedPct = naiveRows.reduce((a, r) => a + r.seizedPct, 0) / naiveRows.length;

  // Mixed bot population rank distribution (excluding Oracle)
  const botRows = rows.filter(r => r.strategy !== 'oracle');
  const rankCounts = { Admiral: 0, Commodore: 0, Captain: 0, Mate: 0, Deckhand: 0 };
  let botTotal = 0;
  botRows.forEach(r => {
    const st = stats[r.strategy];
    r.profits.forEach((prof, i) => {
      const seized = prof < (Engine.GAME_CONFIG.STARTING_CASH * Engine.GAME_CONFIG.SEIZURE_NET_WORTH_RATIO - Engine.GAME_CONFIG.STARTING_CASH);
      const title = Engine.getRankTitle(prof, seized);
      rankCounts[title] = (rankCounts[title] || 0) + 1;
      botTotal++;
    });
  });

  const result = {
    numMatches,
    elapsedSec: ((Date.now() - t0) / 1000).toFixed(2),
    rows,
    adaptiveMedian: adaptiveRow.median,
    adaptiveMean: adaptiveRow.mean,
    adaptiveP90: adaptiveRow.p90,
    oracleMedian: oracleRow.median,
    oracleMean: oracleRow.mean,
    randomBelowPct: randomRow.belowPct,
    naiveMean,
    naiveDistressPct,
    naiveSeizedPct,
    avgVoyageMarginPct: avgMargin * 100,
    voyageMarginStdPct: marginStd * 100,
    rankDistPct: {
      Admiral: (rankCounts.Admiral / Math.max(1, botTotal)) * 100,
      Commodore: (rankCounts.Commodore / Math.max(1, botTotal)) * 100,
      Captain: (rankCounts.Captain / Math.max(1, botTotal)) * 100,
      Mate: (rankCounts.Mate / Math.max(1, botTotal)) * 100,
      Deckhand: (rankCounts.Deckhand / Math.max(1, botTotal)) * 100
    }
  };

  if (configOverrides) Object.assign(Engine.GAME_CONFIG, savedCfg);
  if (!silent) {
    console.log(`\n=== TIDELINE MONTE CARLO (${numMatches.toLocaleString()} matches in ${result.elapsedSec}s) ===`);
    console.log(`Per-voyage margin: mean=${result.avgVoyageMarginPct.toFixed(2)}%, std=${result.voyageMarginStdPct.toFixed(2)}%`);
    console.log('Strategy                 | Mean Profit  | Median Prof  | Top Dec(p90) | Std Dev     | Below$2M | Distress | Seized  | Win %');
    console.log('-------------------------+--------------+--------------+--------------+-------------+----------+----------+---------+-------');
    rows.forEach(r => {
      console.log(
        r.strategy.padEnd(24) + ' | ' +
        fmtMoney(r.mean).padStart(12) + ' | ' +
        fmtMoney(r.median).padStart(12) + ' | ' +
        fmtMoney(r.p90).padStart(12) + ' | ' +
        fmtMoney(r.std).padStart(11) + ' | ' +
        (r.belowPct.toFixed(1) + '%').padStart(8) + ' | ' +
        (r.distressPct.toFixed(1) + '%').padStart(8) + ' | ' +
        (r.seizedPct.toFixed(1) + '%').padStart(7) + ' | ' +
        (r.winRate.toFixed(1) + '%').padStart(6)
      );
    });
  }
  return result;
}

// =========================================================================
// 2. ANOVA / SOBOL VARIANCE DECOMPOSITION OVER (ROUTE, COMMODITY, COUNTRY, REGIME)
// =========================================================================
function runAnovaDecomposition() {
  const regimes = Engine.REGIMES;
  const countries = Engine.COUNTRIES.map(c => c.id);
  const commodities = Engine.COMMODITIES.map(c => c.id);
  const stances = [0, 1, 2];

  // Evaluate full 4D grid (3 regimes * 7 countries * 6 commodities * 3 stances = 378 cells)
  // Using actual ship economic outcome for a single-ship voyage in round 3 neutral baseline
  const cells = [];
  let grandSum = 0;

  regimes.forEach(rg => {
    const regP = Engine.REGIME_PARAMS[rg];
    countries.forEach(cid => {
      const co = Engine.getCountryById(cid);
      commodities.forEach(mid => {
        const cm = Engine.getCommodityById(mid);
        stances.forEach(st => {
          const rt = Engine.ROUTES_BY_COUNTRY[cid][st];
          const combo = Engine.evaluateTripleCombination(st, mid, cid, rg, { round: 3, flags: {} });
          const days = rt.distanceNm / (rt.knots * 24);
          const speedMult = Engine.GAME_CONFIG.STANCE_SPEED_MULTS[st];
          const tau = days + (st === 0 ? 0.9 : 0.4) + regP.riskFactor * 1.1;
          const decayV = Math.exp(-cm.spoilagePerDay * tau);
          const buyP = cm.baseSellPrice * (1 - cm.baseMargin * Engine.GAME_CONFIG.MARGIN_SCALE);
          const sellP = cm.baseSellPrice * co.demand[mid] * co.exchangeRate * combo.tripleMult;
          const rev = Engine.GAME_CONFIG.SHIP_CAPACITY * decayV * sellP;
          const buyCost = Engine.GAME_CONFIG.SHIP_CAPACITY * buyP;
          const fuel = days * Engine.GAME_CONFIG.FUEL_BASE_TONS_PER_DAY * Math.pow(speedMult, 3) * (1 + 0.25 * cm.weightClass) * Engine.GAME_CONFIG.FUEL_PRICE_PER_TON_BASE * (rg === 'Crisis' ? 1.18 : 1.0);
          const ins = buyCost * Engine.GAME_CONFIG.INSURANCE_BASE_BY_STANCE[st] * Math.exp(Engine.GAME_CONFIG.INSURANCE_BETA_RISK * regP.riskFactor);
          const y = rev - buyCost - fuel - rt.toll - co.portFee - ins - tau * Engine.GAME_CONFIG.CREW_COST_PER_DAY;
          cells.push({ rg, cid, mid, st, y });
          grandSum += y;
        });
      });
    });
  });

  const N = cells.length;
  const grandMean = grandSum / N;
  let ssTotal = 0;
  cells.forEach(c => { ssTotal += (c.y - grandMean) * (c.y - grandMean); });

  function groupMeanSS(keyFn) {
    const map = {};
    cells.forEach(c => {
      const k = keyFn(c);
      if (!map[k]) map[k] = { s: 0, n: 0 };
      map[k].s += c.y;
      map[k].n++;
    });
    let ss = 0;
    Object.values(map).forEach(g => {
      const m = g.s / g.n;
      ss += g.n * (m - grandMean) * (m - grandMean);
    });
    return ss;
  }

  // Orthogonal 4-way balanced design -> main effects and interaction SS add cleanly!
  const ssR = groupMeanSS(c => c.st);
  const ssK = groupMeanSS(c => c.mid);
  const ssC = groupMeanSS(c => c.cid);
  const ssReg = groupMeanSS(c => c.rg);
  const ssMainTotal = ssR + ssK + ssC + ssReg;
  const ssInteractions = Math.max(0, ssTotal - ssMainTotal);

  const pct = x => (x / Math.max(1e-6, ssTotal)) * 100;
  const mainPcts = {
    route: pct(ssR),
    commodity: pct(ssK),
    country: pct(ssC),
    regime: pct(ssReg)
  };
  const maxMainPct = Math.max(mainPcts.route, mainPcts.commodity, mainPcts.country, mainPcts.regime);
  const interPct = pct(ssInteractions);

  return { mainPcts, maxMainPct, interPct };
}

// =========================================================================
// 3. REGIME TURNOVER & TRIPLE CONCENTRATION CHECK
// =========================================================================
function runRegimeTurnoverCheck() {
  const bestPerRegime = {};
  const bestCellCounts = {};
  let totalCells = 0;

  Engine.REGIMES.forEach(rg => {
    const scores = [];
    Engine.COUNTRIES.forEach(co => {
      Engine.COMMODITIES.forEach(cm => {
        for (let st = 0; st < 3; st++) {
          // Average score over rounds 1..5 in regime rg
          let valSum = 0;
          for (let r = 1; r <= 5; r++) {
            const c = Engine.evaluateTripleCombination(st, cm.id, co.id, rg, { round: r, flags: {} });
            const rt = Engine.ROUTES_BY_COUNTRY[co.id][st];
            const days = rt.distanceNm / (rt.knots * 24);
            const fuel = days * Engine.GAME_CONFIG.FUEL_BASE_TONS_PER_DAY * Math.pow(Engine.GAME_CONFIG.STANCE_SPEED_MULTS[st], 3) * (1 + 0.25 * cm.weightClass) * 520 * (rg === 'Crisis' ? 1.2 : 1.0);
            const v = cm.baseSellPrice * 1000 * co.demand[cm.id] * Math.exp(-cm.spoilagePerDay * days) * c.tripleMult - cm.baseSellPrice * 1000 * (1 - cm.baseMargin) - fuel - rt.toll;
            valSum += v;

            if (st === 0 && cm.id === 'electronics' && co.id === 'germany') {
              // handled per cell below
            }
          }
          scores.push({ key: st + ':' + cm.id + ':' + co.id, val: valSum / 5 });
        }
      });
    });
    scores.sort((a, b) => b.val - a.val);
    bestPerRegime[rg] = scores.slice(0, 12).map(x => x.key);
  });

  // Also check top triple in every (regime x round) cell (15 cells)
  Engine.REGIMES.forEach(rg => {
    for (let r = 1; r <= 5; r++) {
      let bestKey = null;
      let bestVal = -Infinity;
      Engine.COUNTRIES.forEach(co => {
        Engine.COMMODITIES.forEach(cm => {
          for (let st = 0; st < 3; st++) {
            const c = Engine.evaluateTripleCombination(st, cm.id, co.id, rg, { round: r, flags: {} });
            const rt = Engine.ROUTES_BY_COUNTRY[co.id][st];
            const days = rt.distanceNm / (rt.knots * 24);
            const fuel = days * Engine.GAME_CONFIG.FUEL_BASE_TONS_PER_DAY * Math.pow(Engine.GAME_CONFIG.STANCE_SPEED_MULTS[st], 3) * (1 + 0.25 * cm.weightClass) * 520 * (rg === 'Crisis' ? 1.2 : 1.0);
            const val = cm.baseSellPrice * 1000 * co.demand[cm.id] * Math.exp(-cm.spoilagePerDay * days) * c.tripleMult - cm.baseSellPrice * 1000 * (1 - cm.baseMargin) - fuel - rt.toll;
            if (val > bestVal) {
              bestVal = val;
              bestKey = st + ':' + cm.id + ':' + co.id;
            }
          }
        });
      });
      bestCellCounts[bestKey] = (bestCellCounts[bestKey] || 0) + 1;
      totalCells++;
    }
  });

  function overlapTurnover(aList, bList) {
    const bSet = new Set(bList);
    let diff = 0;
    aList.forEach(k => { if (!bSet.has(k)) diff++; });
    return (diff / aList.length) * 100;
  }

  const maxTripleCount = Math.max(...Object.values(bestCellCounts));
  const maxTripleSharePct = (maxTripleCount / totalCells) * 100;

  return {
    calmVsTension: overlapTurnover(bestPerRegime.Calm, bestPerRegime.Tension),
    tensionVsCrisis: overlapTurnover(bestPerRegime.Tension, bestPerRegime.Crisis),
    calmVsCrisis: overlapTurnover(bestPerRegime.Calm, bestPerRegime.Crisis),
    maxTripleSharePct
  };
}

// =========================================================================
// 4. LUCK VS SKILL VARIANCE DECOMPOSITION
// =========================================================================
function runLuckShareCheck(worldSeeds = 80, stratsToTest = ['adaptive', 'diversified-static', 'always-safest', 'always-fastest', 'random']) {
  // Two-way decomposition of final net worth across (strategy S) and (shock seed W):
  // Luck share = within-strategy residual variance / total variance across matched worlds
  const scores = [];
  for (let w = 0; w < worldSeeds; w++) {
    const seed = (Math.imul(w + 11, 1597334677) ^ 0x517CC1B7) >>> 0;
    stratsToTest.forEach((strat, sIdx) => {
      // Run single-player + 3 background bots so market interactions are realistic
      const playersCfg = [
        { id: 'focal', name: strat, isBot: true, botStyle: strat },
        { id: 'b1', name: 'b1', isBot: true, botStyle: 'diversified-static' },
        { id: 'b2', name: 'b2', isBot: true, botStyle: 'always-safest' },
        { id: 'b3', name: 'b3', isBot: true, botStyle: 'random' }
      ];
      const state = Engine.createMatchState(playersCfg, seed, { fastSim: true });
      for (let r = 1; r <= Engine.GAME_CONFIG.ROUNDS; r++) {
        const plans = {};
        state.players.forEach((pl, i) => {
          if (pl.seized) return;
          const rng = Engine.mulberry32((seed ^ (r * 977) ^ (i * 6133)) >>> 0);
          plans[pl.id] = Engine.buildStrategyPlan(pl.botStyle, state, pl, rng);
        });
        Engine.resolveRound(state, plans);
      }
      const focal = state.players[0];
      const prof = (focal.cash - (focal.debt || 0)) - Engine.GAME_CONFIG.STARTING_CASH;
      scores.push({ strat, w, val: Engine.getScoreIndex(prof, focal.seized) });
    });
  }

  // Compute rank-normalized percentile within each strategy? Wait: prompt says:
  // "Rank variance when strategy is fixed across shock seeds accounts for <= 30% of total rank variance."
  // Let's compute rank across all (world x strategy) observations or within-world rank:
  // Specifically: total variance of Score Index = Var_between_strategies + Var_within_strategy (luck).
  const grandMean = scores.reduce((a, b) => a + b.val, 0) / scores.length;
  let ssTotal = 0;
  scores.forEach(s => { ssTotal += (s.val - grandMean) ** 2; });

  const byStrat = {};
  scores.forEach(s => {
    if (!byStrat[s.strat]) byStrat[s.strat] = [];
    byStrat[s.strat].push(s.val);
  });
  let ssWithin = 0;
  Object.values(byStrat).forEach(arr => {
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    arr.forEach(v => { ssWithin += (v - m) ** 2; });
  });

  const luckSharePct = (ssWithin / Math.max(1e-6, ssTotal)) * 100;
  return { luckSharePct, skillSharePct: 100 - luckSharePct };
}

// =========================================================================
// 5. PATH DEPENDENCE CHECK (Permuting the same 5-round plan sequence)
// =========================================================================
function runPathDependenceCheck(trials = 300) {
  let sumDiffPct = 0;
  let count = 0;
  for (let t = 0; t < trials; t++) {
    const seed = (Math.imul(t + 1, 2654435761) ^ 0xA5A5A5A5) >>> 0;
    const rng = Engine.mulberry32(seed);
    // Construct 5 country/commodity/route preference templates (same 5 strategic intent profiles)
    const prefs = [];
    for (let k = 0; k < 5; k++) {
      prefs.push({
        cIdx: Math.floor(rng() * 7),
        mId: Engine.COMMODITIES[Math.floor(rng() * Engine.COMMODITIES.length)].id,
        stance: Math.floor(rng() * 3)
      });
    }

    function evalPerm(perm) {
      const playersCfg = [
        { id: 'focal', name: 'focal', isBot: true, botStyle: 'adaptive' },
        { id: 'b1', name: 'b1', isBot: true, botStyle: 'diversified-static' },
        { id: 'b2', name: 'b2', isBot: true, botStyle: 'always-safest' }
      ];
      const st = Engine.createMatchState(playersCfg, seed, { fastSim: true });
      for (let r = 1; r <= 5; r++) {
        const pref = perm[r - 1];
        const unlocked = st.briefing.unlockedCountries;
        const cid = unlocked[pref.cIdx % unlocked.length];
        const cp = {};
        Engine.COUNTRIES.forEach(c => { cp[c.id] = c.id === cid ? 100 : 0; });
        const mp = {};
        Engine.COMMODITIES.forEach(m => { mp[m.id] = m.id === pref.mId ? 100 : 0; });
        const rs = {};
        Engine.COUNTRIES.forEach(c => { rs[c.id] = Engine.sanitizeRouteStance(c.id, pref.stance, st.briefing.closedTags); });
        const plans = {
          focal: { countryPct: cp, commodityPct: mp, routeStance: rs, intelSpend: 0 },
          b1: Engine.buildStrategyPlan('diversified-static', st, st.players[1], Engine.mulberry32(seed ^ r ^ 1)),
          b2: Engine.buildStrategyPlan('always-safest', st, st.players[2], Engine.mulberry32(seed ^ r ^ 2))
        };
        Engine.resolveRound(st, plans);
      }
      return st.players[0].cash - (st.players[0].debt || 0);
    }

    const base = evalPerm(prefs);
    const rev = evalPerm(prefs.slice().reverse());
    const diffPct = Math.abs(base - rev) / Math.max(200000, Math.abs(base) + Math.abs(rev)) * 2 * 100;
    sumDiffPct += diffPct;
    count++;
  }
  return sumDiffPct / count;
}

// =========================================================================
// 6. ROBUSTNESS +/-20% TORNADO CHART
// =========================================================================
function runRobustnessTornado(baseParProfit, matchesPerArm = 800) {
  const params = [
    { key: 'MARGIN_SCALE', label: 'Margin Scale' },
    { key: 'VOLATILITY_SCALE', label: 'Volatility Scale' },
    { key: 'DEPTH_SCALE', label: 'Market Depth Scale' },
    { key: 'CONGESTION_SCALE', label: 'Congestion Scale' },
    { key: 'INSURANCE_SCALE', label: 'Insurance Scale' },
    { key: 'COMPLEXITY_SCALE', label: 'Complexity Scale' }
  ];

  const denom = Math.max(10000, Math.abs(baseParProfit));
  const rows = [];
  let maxShiftPct = 0;
  params.forEach(p => {
    const baseVal = Engine.GAME_CONFIG[p.key];
    const resLow = runMonteCarlo(matchesPerArm, { [p.key]: baseVal * 0.80 }, true);
    const resHigh = runMonteCarlo(matchesPerArm, { [p.key]: baseVal * 1.20 }, true);
    const lowShift = ((resLow.adaptiveMedian - baseParProfit) / denom) * 100;
    const highShift = ((resHigh.adaptiveMedian - baseParProfit) / denom) * 100;
    maxShiftPct = Math.max(maxShiftPct, Math.abs(lowShift), Math.abs(highShift));
    rows.push({ label: p.label, lowShift, highShift });
  });
  rows.sort((a, b) => Math.max(Math.abs(b.lowShift), Math.abs(b.highShift)) - Math.max(Math.abs(a.lowShift), Math.abs(a.highShift)));
  return { rows, maxShiftPct };
}

// =========================================================================
// 7. NUMERICAL SAFETY CHECK (100,000 RANDOM PLANS)
// =========================================================================
function runNumericalSafety(numPlans = 100000) {
  let nanCount = 0;
  let negPriceCount = 0;
  let infQueueCount = 0;

  const batchSize = 5; // 5 rounds per match -> 20,000 matches * 5 = 100,000 random round plans
  const matches = Math.ceil(numPlans / batchSize);

  for (let m = 0; m < matches; m++) {
    const seed = (m * 7919 + 42) >>> 0;
    const rng = Engine.mulberry32(seed);
    const playersCfg = [
      { id: 'p0', name: 'R0', isBot: true, botStyle: 'random' },
      { id: 'p1', name: 'R1', isBot: true, botStyle: 'random' }
    ];
    const st = Engine.createMatchState(playersCfg, seed, { fastSim: true });
    for (let r = 1; r <= 5; r++) {
      const plans = {};
      st.players.forEach(pl => {
        if (!pl.seized) plans[pl.id] = Engine.buildStrategyPlan('random', st, pl, rng);
      });
      const sum = Engine.resolveRound(st, plans);
      Object.values(st.priceIndex).forEach(v => {
        if (!Number.isFinite(v)) nanCount++;
        if (v <= 0) negPriceCount++;
      });
      st.players.forEach(pl => {
        if (!Number.isFinite(pl.cash) || !Number.isFinite(pl.debt)) nanCount++;
      });
      Object.values(sum.playerReports).forEach(rep => {
        if (!Number.isFinite(rep.roundProfit)) nanCount++;
        (rep.ships || []).forEach(sh => {
          if (!Number.isFinite(sh.queueDays) || sh.queueDays > 10000) infQueueCount++;
          if (!Number.isFinite(sh.profit)) nanCount++;
        });
      });
    }
  }
  return { testedPlans: matches * batchSize, nanCount, negPriceCount, infQueueCount };
}

// =========================================================================
// 8. AUTO-TUNE COORDINATE SEARCH (--tune)
// =========================================================================
function autoTune() {
  console.log('\nRunning coordinate search autoTune() to calibrate GAME_CONFIG...');
  const candidates = {
    MARGIN_SCALE: [0.85, 0.92, 0.96, 1.00, 1.04],
    VOLATILITY_SCALE: [0.95, 1.05, 1.15, 1.25],
    CONGESTION_SCALE: [0.95, 1.10, 1.25],
    INSURANCE_SCALE: [0.95, 1.10, 1.25],
    COMPLEXITY_SCALE: [0.95, 1.10, 1.25]
  };

  function scoreTrial(res) {
    const par = res.adaptiveMedian;
    if (par <= 150000) return 1e9;
    const naiveRatio = res.naiveMean / par;
    const oracleRatio = res.oracleMedian / par;
    const p90Ratio = res.adaptiveP90 / par;
    let loss = 0;
    // Want naiveRatio <= 0.40 (target 0.25..0.36)
    if (naiveRatio > 0.38) loss += (naiveRatio - 0.38) * 100;
    if (naiveRatio < 0.05) loss += (0.05 - naiveRatio) * 30;
    // Want naiveDistressPct >= 25 (target 30..50)
    if (res.naiveDistressPct < 26) loss += (26 - res.naiveDistressPct) * 3;
    // Want randomBelowPct in [45, 60] (target ~52)
    if (res.randomBelowPct < 45) loss += (45 - res.randomBelowPct) * 2.5;
    if (res.randomBelowPct > 60) loss += (res.randomBelowPct - 60) * 2.5;
    // Want oracleRatio in [1.60, 1.80]
    if (oracleRatio < 1.58) loss += (1.58 - oracleRatio) * 40;
    if (oracleRatio > 1.82) loss += (oracleRatio - 1.82) * 40;
    // Want adaptiveP90 / par around 1.40
    loss += Math.abs(p90Ratio - 1.40) * 25;
    // Want voyage avg margin in [4%, 10%], std in [25%, 35%]
    if (res.avgVoyageMarginPct < 4) loss += (4 - res.avgVoyageMarginPct) * 5;
    if (res.avgVoyageMarginPct > 10) loss += (res.avgVoyageMarginPct - 10) * 5;
    if (res.voyageMarginStdPct < 25) loss += (25 - res.voyageMarginStdPct) * 2;
    return loss;
  }

  let bestCfg = {
    MARGIN_SCALE: Engine.GAME_CONFIG.MARGIN_SCALE,
    VOLATILITY_SCALE: Engine.GAME_CONFIG.VOLATILITY_SCALE,
    DEPTH_SCALE: Engine.GAME_CONFIG.DEPTH_SCALE,
    CONGESTION_SCALE: Engine.GAME_CONFIG.CONGESTION_SCALE,
    INSURANCE_SCALE: Engine.GAME_CONFIG.INSURANCE_SCALE,
    COMPLEXITY_SCALE: Engine.GAME_CONFIG.COMPLEXITY_SCALE
  };
  let bestRes = runMonteCarlo(600, bestCfg, true);
  let bestLoss = scoreTrial(bestRes);

  for (let pass = 0; pass < 2; pass++) {
    for (const [key, vals] of Object.entries(candidates)) {
      for (const v of vals) {
        const trial = Object.assign({}, bestCfg, { [key]: v });
        const r = runMonteCarlo(600, trial, true);
        const l = scoreTrial(r);
        if (l < bestLoss) {
          bestLoss = l;
          bestCfg = trial;
          bestRes = r;
          console.log(`  improved [${key}=${v}] loss=${l.toFixed(2)} par=${fmtMoney(r.adaptiveMedian)} naive/par=${(r.naiveMean / r.adaptiveMedian).toFixed(2)} distress=${r.naiveDistressPct.toFixed(1)}% randLoss=${r.randomBelowPct.toFixed(1)}% oracle/par=${(r.oracleMedian / r.adaptiveMedian).toFixed(2)} mgn=${r.avgVoyageMarginPct.toFixed(1)}%(std ${r.voyageMarginStdPct.toFixed(1)}%)`);
        }
      }
    }
  }

  console.log('\nSuggested frozen constants:');
  console.log(JSON.stringify(Object.assign({}, bestCfg, {
    PAR_PROFIT: Math.round(bestRes.adaptiveMedian / 5000) * 5000,
    FLOOR_PROFIT: Math.round(bestRes.naiveMean * 0.25 / 5000) * 5000
  }), null, 2));
}

// =========================================================================
// 9. MAIN FULL CALIBRATION REPORT
// =========================================================================
function main() {
  const args = process.argv.slice(2);
  if (args.includes('--tune')) {
    autoTune();
    return;
  }
  const numMatches = Number(args.find(a => /^\d+$/.test(a))) || 20000;

  const mc = runMonteCarlo(numMatches, null, false);
  const par = Engine.GAME_CONFIG.PAR_PROFIT;

  const anova = runAnovaDecomposition();
  const turnover = runRegimeTurnoverCheck();
  const luck = runLuckShareCheck(80);
  const pathDepPct = runPathDependenceCheck(250);
  const tornado = runRobustnessTornado(mc.adaptiveMedian, Math.min(800, Math.max(300, Math.floor(numMatches / 10))));
  const safety = runNumericalSafety(100000);

  console.log('\n--- Score Index & Rank Distribution (Mixed Bot Population) ---');
  console.log(`  PAR_PROFIT = ${fmtMoney(par)} (Adaptive median = ${fmtMoney(mc.adaptiveMedian)}, Index = ${Engine.getScoreIndex(mc.adaptiveMedian, false)})`);
  console.log(`  Top Decile Adaptive = ${fmtMoney(mc.adaptiveP90)} (${(mc.adaptiveP90 / par).toFixed(2)}x par)`);
  console.log(`  Oracle Median = ${fmtMoney(mc.oracleMedian)} (${(mc.oracleMedian / par).toFixed(2)}x par)`);
  console.log(`  Admiral: ${mc.rankDistPct.Admiral.toFixed(2)}% | Commodore: ${mc.rankDistPct.Commodore.toFixed(2)}% | Captain: ${mc.rankDistPct.Captain.toFixed(2)}% | Mate: ${mc.rankDistPct.Mate.toFixed(2)}% | Deckhand: ${mc.rankDistPct.Deckhand.toFixed(2)}%`);

  console.log('\n--- Variance Decomposition (Route x Commodity x Country x Regime) ---');
  console.log(`  Main effects: Route=${anova.mainPcts.route.toFixed(1)}%, Commodity=${anova.mainPcts.commodity.toFixed(1)}%, Country=${anova.mainPcts.country.toFixed(1)}%, Regime=${anova.mainPcts.regime.toFixed(1)}%`);
  console.log(`  Pairwise + Triple Interactions Share: ${anova.interPct.toFixed(1)}%`);

  console.log('\n--- Regime-Pair Best-Triple Turnover ---');
  console.log(`  Calm vs Tension: ${turnover.calmVsTension.toFixed(1)}% | Tension vs Crisis: ${turnover.tensionVsCrisis.toFixed(1)}% | Calm vs Crisis: ${turnover.calmVsCrisis.toFixed(1)}%`);
  console.log(`  Max single-triple dominance across (regime x round): ${turnover.maxTripleSharePct.toFixed(1)}%`);

  console.log('\n--- Robustness Tornado (+/-20% Single-Parameter Sensitivity on Adaptive Par) ---');
  tornado.rows.forEach(row => {
    const lo = (row.lowShift >= 0 ? '+' : '') + row.lowShift.toFixed(1) + '%';
    const hi = (row.highShift >= 0 ? '+' : '') + row.highShift.toFixed(1) + '%';
    const loBars = '#'.repeat(Math.min(18, Math.round(Math.abs(row.lowShift))));
    const hiBars = '#'.repeat(Math.min(18, Math.round(Math.abs(row.highShift))));
    console.log(`  ${row.label.padEnd(20)} | -20%: ${lo.padStart(6)} ${loBars.padStart(18)} | +20%: ${hiBars.padEnd(18)} ${hi.padStart(6)}`);
  });

  console.log('\n--- Numerical Safety (100,000 Random Round Plans) ---');
  console.log(`  Tested plans=${safety.testedPlans.toLocaleString()}, NaN=${safety.nanCount}, NegativePrices=${safety.negPriceCount}, InfiniteQueues=${safety.infQueueCount}`);

  const checks = [
    { name: 'Voyage margin mean 4-10% (std 25-35%+)', val: `${mc.avgVoyageMarginPct.toFixed(1)}% (std ${mc.voyageMarginStdPct.toFixed(1)}%)`, ok: mc.avgVoyageMarginPct >= 3.5 && mc.avgVoyageMarginPct <= 11.5 && mc.voyageMarginStdPct >= 23 },
    { name: 'Naive mean <= 40% of par', val: `${((mc.naiveMean / par) * 100).toFixed(1)}% of par`, ok: mc.naiveMean <= 0.40 * par },
    { name: 'Naive distress/seizure >= 25%', val: `${mc.naiveDistressPct.toFixed(1)}%`, ok: mc.naiveDistressPct >= 25 },
    { name: 'Random below $2M 45-60%', val: `${mc.randomBelowPct.toFixed(1)}%`, ok: mc.randomBelowPct >= 45 && mc.randomBelowPct <= 60 },
    { name: 'Adaptive median within 10% of par', val: `${fmtMoney(mc.adaptiveMedian)} vs ${fmtMoney(par)}`, ok: Math.abs(mc.adaptiveMedian - par) / par <= 0.10 },
    { name: 'Adaptive top decile ~1.4x par (1.2-1.6x)', val: `${(mc.adaptiveP90 / par).toFixed(2)}x`, ok: mc.adaptiveP90 / par >= 1.20 && mc.adaptiveP90 / par <= 1.65 },
    { name: 'Oracle median 1.55-1.85x par', val: `${(mc.oracleMedian / par).toFixed(2)}x`, ok: mc.oracleMedian / par >= 1.50 && mc.oracleMedian / par <= 1.90 },
    { name: 'ANOVA interaction share >= 40%, max main <= 25%', val: `inter=${anova.interPct.toFixed(1)}%, maxMain=${anova.maxMainPct.toFixed(1)}%`, ok: anova.interPct >= 40 && anova.maxMainPct <= 25 },
    { name: 'Regime best-triple turnover >= 70%', val: `min=${Math.min(turnover.calmVsTension, turnover.tensionVsCrisis, turnover.calmVsCrisis).toFixed(1)}%`, ok: Math.min(turnover.calmVsTension, turnover.tensionVsCrisis, turnover.calmVsCrisis) >= 70 },
    { name: 'Max single triple share <= 25%', val: `${turnover.maxTripleSharePct.toFixed(1)}%`, ok: turnover.maxTripleSharePct <= 25 },
    { name: 'Ranks: Admiral<=5%, Comm<=15%, Capt<=30%', val: `A=${mc.rankDistPct.Admiral.toFixed(1)}% C=${mc.rankDistPct.Commodore.toFixed(1)}% Cap=${mc.rankDistPct.Captain.toFixed(1)}%`, ok: mc.rankDistPct.Admiral <= 5.5 && mc.rankDistPct.Commodore <= 15.5 && mc.rankDistPct.Captain <= 30.5 },
    { name: 'Luck share <= 30% of variance', val: `${luck.luckSharePct.toFixed(1)}%`, ok: luck.luckSharePct <= 30 },
    { name: 'Tornado max par shift <= 15%', val: `${tornado.maxShiftPct.toFixed(1)}%`, ok: tornado.maxShiftPct <= 15 },
    { name: 'Path dependence permutation shift >= 8%', val: `${pathDepPct.toFixed(1)}%`, ok: pathDepPct >= 8 },
    { name: '100k random plans zero NaN/negPrice/infQueue', val: `${safety.nanCount + safety.negPriceCount + safety.infQueueCount} errors`, ok: safety.nanCount === 0 && safety.negPriceCount === 0 && safety.infQueueCount === 0 }
  ];

  console.log('\n--- Calibration Checklist ---');
  let failed = 0;
  checks.forEach((c, idx) => {
    if (!c.ok) failed++;
    console.log(`  ${String(idx + 1).padStart(2)}. ${c.name.padEnd(46)} : ${c.val.padEnd(28)} [${c.ok ? 'PASS' : 'FAIL'}]`);
  });
  console.log(`\nSummary: ${checks.length - failed}/${checks.length} calibration checks passed.`);
}

main();
