'use strict';

const Engine = require('./public/engine.js');

const STRATEGIES = [
  'all-ships-one-country',
  'all-one-commodity',
  'always-fastest-route',
  'always-safest-route',
  'random',
  'greedy-last-round-winner',
  'diversified-static',
  'adaptive'
];

const NAIVE_STRATEGIES = [
  'all-ships-one-country',
  'all-one-commodity',
  'always-fastest-route',
  'always-safest-route',
  'random',
  'greedy-last-round-winner'
];

function runSim(numMatches = 10000) {
  const stats = {};
  STRATEGIES.forEach(s => {
    stats[s] = {
      matches: 0,
      wins: 0,
      sumProfit: 0,
      sumSqProfit: 0,
      profits: [],
      adaptiveBeatsCount: 0,
      adaptiveCompareTotal: 0
    };
  });

  // Track profit by commodity and country across diversified runs to check dominance
  const commProfits = {};
  const countryProfits = {};
  Engine.COMMODITIES.forEach(c => { commProfits[c.id] = { sum: 0, count: 0 }; });
  Engine.COUNTRIES.forEach(c => { countryProfits[c.id] = { sum: 0, count: 0 }; });

  const startTime = Date.now();

  for (let m = 0; m < numMatches; m++) {
    const seed = (m * 2654435761 + 1234567) >>> 0;
    const matchRng = Engine.mulberry32(seed);
    const playersCfg = STRATEGIES.map((strat, idx) => ({
      id: 'p_' + strat,
      name: strat,
      isBot: true,
      botStyle: strat
    }));

    const state = Engine.createMatchState(playersCfg, seed);

    for (let r = 1; r <= Engine.GAME_CONFIG.ROUNDS; r++) {
      const plans = {};
      state.players.forEach((pl, idx) => {
        const stratRng = Engine.mulberry32((seed ^ (r * 977) ^ (idx * 6133)) >>> 0);
        plans[pl.id] = Engine.buildStrategyPlan(pl.botStyle, state, pl, stratRng);
      });
      const summary = Engine.resolveRound(state, plans);

      // Sample per-ship country profit on diversified-static to verify no country dominates
      const divRep = summary.playerReports['p_diversified-static'];
      if (divRep) {
        divRep.ships.forEach(sh => {
          countryProfits[sh.countryId].sum += sh.profit;
          countryProfits[sh.countryId].count += 1;
        });
      }
      // Sample single-commodity strategy to check no single commodity dominates
      const oneCommPlan = plans['p_all-one-commodity'];
      const oneCommRep = summary.playerReports['p_all-one-commodity'];
      if (oneCommPlan && oneCommRep) {
        const chosenComm = Object.keys(oneCommPlan.commodityPct).find(k => oneCommPlan.commodityPct[k] === 100);
        if (chosenComm) {
          commProfits[chosenComm].sum += oneCommRep.roundProfit / summary.fleetSize;
          commProfits[chosenComm].count += 1;
        }
      }
    }

    // Score match
    let bestCash = -Infinity;
    let bestWorstLoss = -Infinity;
    let winnerId = null;

    const profitByStrat = {};
    state.players.forEach(pl => {
      const profit = pl.cash - Engine.GAME_CONFIG.STARTING_CASH;
      profitByStrat[pl.botStyle] = profit;
      const st = stats[pl.botStyle];
      st.matches += 1;
      st.sumProfit += profit;
      st.sumSqProfit += profit * profit;

      if (pl.cash > bestCash || (pl.cash === bestCash && pl.worstRoundLoss > bestWorstLoss)) {
        bestCash = pl.cash;
        bestWorstLoss = pl.worstRoundLoss;
        winnerId = pl.botStyle;
      }
    });
    if (winnerId) stats[winnerId].wins += 1;

    // Pairwise Adaptive vs each naive strategy
    const adaptProfit = profitByStrat['adaptive'];
    NAIVE_STRATEGIES.forEach(ns => {
      stats[ns].adaptiveCompareTotal += 1;
      if (adaptProfit > profitByStrat[ns]) {
        stats[ns].adaptiveBeatsCount += 1;
      }
    });
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\nTideline Balance Simulation: ${numMatches.toLocaleString()} matches completed in ${elapsed}s\n`);

  const rows = STRATEGIES.map(s => {
    const st = stats[s];
    const mean = st.sumProfit / st.matches;
    const variance = Math.max(0, st.sumSqProfit / st.matches - mean * mean);
    const std = Math.sqrt(variance);
    const winRate = (st.wins / st.matches) * 100;
    const adaptBeat = st.adaptiveCompareTotal > 0 ? (st.adaptiveBeatsCount / st.adaptiveCompareTotal) * 100 : null;
    return {
      strategy: s,
      mean: Math.round(mean),
      std: Math.round(std),
      winRate: winRate,
      adaptBeat: adaptBeat
    };
  });

  console.log('Strategy                    | Mean Profit  | Std Dev     | Win Rate | Adaptive Beats');
  console.log('----------------------------+--------------+-------------+----------+---------------');
  rows.forEach(r => {
    const mStr = ('$' + r.mean.toLocaleString()).padStart(12);
    const sStr = ('$' + r.std.toLocaleString()).padStart(11);
    const wStr = (r.winRate.toFixed(2) + '%').padStart(8);
    const aStr = r.adaptBeat != null ? (r.adaptBeat.toFixed(1) + '%').padStart(13) : '          ---';
    console.log(`${r.strategy.padEnd(27)} | ${mStr} | ${sStr} | ${wStr} | ${aStr}`);
  });

  // Check the 5 balance invariants
  const maxNaiveWin = Math.max(...rows.filter(r => NAIVE_STRATEGIES.includes(r.strategy)).map(r => r.winRate));
  const staticList = ['always-fastest-route', 'always-safest-route', 'diversified-static'];
  const staticMeans = rows.filter(r => staticList.includes(r.strategy)).map(r => r.mean).sort((a, b) => b - a);
  const top3SpreadPct = ((staticMeans[0] - staticMeans[2]) / Math.max(1, staticMeans[0])) * 100;

  const fastRow = rows.find(r => r.strategy === 'always-fastest-route');
  const safeRow = rows.find(r => r.strategy === 'always-safest-route');
  const fastSafeGapPct = (Math.abs(fastRow.mean - safeRow.mean) / Math.max(fastRow.mean, safeRow.mean, 1)) * 100;

  const minAdaptBeat = Math.min(...rows.filter(r => r.adaptBeat != null).map(r => r.adaptBeat));

  console.log('\n--- Commodity Mean Profit / Ship (from single-commodity runs) ---');
  const commAvgs = [];
  Engine.COMMODITIES.forEach(c => {
    const avg = Math.round(commProfits[c.id].sum / Math.max(1, commProfits[c.id].count));
    commAvgs.push({ name: c.name, avg });
    console.log(`  ${c.name.padEnd(14)}: $${avg.toLocaleString()}/ship`);
  });

  console.log('\n--- Country Mean Profit / Ship (from diversified-static runs) ---');
  const countryAvgs = [];
  Engine.COUNTRIES.forEach(c => {
    const avg = Math.round(countryProfits[c.id].sum / Math.max(1, countryProfits[c.id].count));
    countryAvgs.push({ name: c.name, avg });
    console.log(`  ${c.name.padEnd(14)}: $${avg.toLocaleString()}/ship`);
  });

  console.log('\n--- Balance Assertions ---');
  console.log(`1. Max naive strategy win rate <= 20%:       ${maxNaiveWin.toFixed(2)}%  [${maxNaiveWin <= 20 ? 'PASS' : 'FAIL'}]`);
  console.log(`2. Top 3 static mean spread <= ~15%:         ${top3SpreadPct.toFixed(2)}%  [${top3SpreadPct <= 16 ? 'PASS' : 'FAIL'}]`);
  console.log(`3. Fast vs Safe EV gap (risk vs reward):     ${fastSafeGapPct.toFixed(2)}%  (Fast std=$${fastRow.std.toLocaleString()} vs Safe std=$${safeRow.std.toLocaleString()}) [${fastSafeGapPct <= 12 ? 'PASS' : 'FAIL'}]`);
  console.log(`4. Adaptive beats every naive >= 65%:        ${minAdaptBeat.toFixed(2)}%  [${minAdaptBeat >= 65 ? 'PASS' : 'FAIL'}]`);
  const commSpread = (Math.max(...commAvgs.map(x => x.avg)) - Math.min(...commAvgs.map(x => x.avg))) / Math.max(...commAvgs.map(x => x.avg)) * 100;
  const cntSpread = (Math.max(...countryAvgs.map(x => x.avg)) - Math.min(...countryAvgs.map(x => x.avg))) / Math.max(...countryAvgs.map(x => x.avg)) * 100;
  console.log(`5. No dominant commodity/country:            Comm spread=${commSpread.toFixed(1)}%, Country spread=${cntSpread.toFixed(1)}%`);
}

runSim(Number(process.argv[2]) || 10000);
