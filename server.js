const express = require("express");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

const API_KEY = process.env.TWELVE_DATA_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Scan every 15 minutes by default.
const POLL_MS = Math.max(
  300000,
  Number(process.env.POLL_MS || 900000)
);

// Strict minimum score.
const MIN_SCORE = 7;

const INSTRUMENTS = [
  {
    symbol: "USD/CAD",
    label: "USDCAD",
    decimals: 5
  },
  {
    symbol: "EUR/CHF",
    label: "EURCHF",
    decimals: 5
  },
  {
    symbol: "XAU/USD",
    label: "XAUUSD",
    decimals: 2
  }
];

/*
=========================================================
SUPPORTED TWELVE DATA TIMEFRAMES
=========================================================

Twelve Data does NOT support 12h.

We therefore request 4h and combine every 3 x 4h
candles into a synthetic 12h candle.

12H = 3 x 4H
*/
const API_TIMEFRAMES = [
  "4h",
  "1h",
  "15min",
  "5min"
];

const DISPLAY_TIMEFRAMES = [
  "12h",
  "4h",
  "1h",
  "15min",
  "5min"
];

const state = {
  updatedAt: null,
  scanning: false,
  pairs: {},
  lastAlertKey: {}
};

/*
=========================================================
HELPERS
=========================================================
*/

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 5) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(decimals));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/*
=========================================================
TWELVE DATA
=========================================================
*/

async function twelveData(endpoint, params) {
  if (!API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY is missing"
    );
  }

  const query = new URLSearchParams({
    ...params,
    apikey: API_KEY
  });

  const url =
    `https://api.twelvedata.com/${endpoint}?${query.toString()}`;

  const response = await fetch(url);

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(
      `Twelve Data returned invalid JSON (${response.status})`
    );
  }

  if (
    !response.ok ||
    data.status === "error" ||
    data.code
  ) {
    throw new Error(
      data.message ||
      `Twelve Data HTTP ${response.status}`
    );
  }

  return data;
}

/*
=========================================================
GET CANDLES
=========================================================
*/

async function getCandles(
  symbol,
  interval,
  outputsize = 150
) {
  const data = await twelveData(
    "time_series",
    {
      symbol,
      interval,
      outputsize: String(outputsize),
      order: "ASC",
      timezone: "UTC"
    }
  );

  if (
    !Array.isArray(data.values) ||
    data.values.length < 30
  ) {
    throw new Error(
      `Not enough ${interval} candles for ${symbol}`
    );
  }

  return data.values
    .map(candle => ({
      time: candle.datetime,
      open: num(candle.open),
      high: num(candle.high),
      low: num(candle.low),
      close: num(candle.close),
      volume: num(candle.volume) || 0
    }))
    .filter(candle =>
      [
        candle.open,
        candle.high,
        candle.low,
        candle.close
      ].every(Number.isFinite)
    );
}

/*
=========================================================
BUILD SYNTHETIC 12H CANDLES
=========================================================

3 x 4H candles = 12H candle.

We align groups using the UTC hour:

00-12
12-24

This gives us a consistent 12H structure without
requesting an unsupported 12h interval from Twelve Data.
=========================================================
*/

function build12HCandles(candles4h) {
  if (!Array.isArray(candles4h)) {
    return [];
  }

  const groups = new Map();

  for (const candle of candles4h) {
    const date = new Date(
      candle.time.replace(" ", "T") + "Z"
    );

    if (Number.isNaN(date.getTime())) {
      continue;
    }

    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const day = date.getUTCDate();
    const hour = date.getUTCHours();

    const blockHour =
      hour < 12 ? 0 : 12;

    const key =
      `${year}-${month}-${day}-${blockHour}`;

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(candle);
  }

  const result = [];

  for (const group of groups.values()) {
    group.sort(
      (a, b) =>
        new Date(
          a.time.replace(" ", "T") + "Z"
        ) -
        new Date(
          b.time.replace(" ", "T") + "Z"
        )
    );

    if (group.length < 2) {
      continue;
    }

    const first = group[0];
    const last = group[group.length - 1];

    result.push({
      time: first.time,
      open: first.open,
      high: Math.max(
        ...group.map(c => c.high)
      ),
      low: Math.min(
        ...group.map(c => c.low)
      ),
      close: last.close,
      volume: group.reduce(
        (sum, c) => sum + c.volume,
        0
      )
    });
  }

  return result;
}

/*
=========================================================
EMA
=========================================================
*/

function ema(values, period) {
  if (!values.length) {
    return null;
  }

  if (values.length < period) {
    return values.at(-1);
  }

  const multiplier =
    2 / (period + 1);

  let result =
    values
      .slice(0, period)
      .reduce(
        (sum, value) =>
          sum + value,
        0
      ) / period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    result =
      values[i] * multiplier +
      result * (1 - multiplier);
  }

  return result;
}

/*
=========================================================
RSI
=========================================================
*/

function rsi(values, period = 14) {
  if (values.length < period + 1) {
    return 50;
  }

  let gain = 0;
  let loss = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {
    const change =
      values[i] -
      values[i - 1];

    if (change >= 0) {
      gain += change;
    } else {
      loss -= change;
    }
  }

  let averageGain =
    gain / period;

  let averageLoss =
    loss / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const change =
      values[i] -
      values[i - 1];

    averageGain =
      (
        averageGain *
          (period - 1) +
        Math.max(change, 0)
      ) / period;

    averageLoss =
      (
        averageLoss *
          (period - 1) +
        Math.max(-change, 0)
      ) / period;
  }

  if (averageLoss === 0) {
    return 100;
  }

  const rs =
    averageGain /
    averageLoss;

  return (
    100 -
    100 / (1 + rs)
  );
}

/*
=========================================================
ATR
=========================================================
*/

function atr(candles, period = 14) {
  if (
    candles.length <
    period + 1
  ) {
    return null;
  }

  const trueRanges = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const current =
      candles[i];

    const previous =
      candles[i - 1];

    const tr =
      Math.max(
        current.high -
          current.low,

        Math.abs(
          current.high -
            previous.close
        ),

        Math.abs(
          current.low -
            previous.close
        )
      );

    trueRanges.push(tr);
  }

  const recent =
    trueRanges.slice(-period);

  return (
    recent.reduce(
      (sum, value) =>
        sum + value,
      0
    ) / recent.length
  );
}

/*
=========================================================
TREND
=========================================================
*/

function getTrend(candles) {
  const closes =
    candles.map(
      c => c.close
    );

  const ema20 =
    ema(closes, 20);

  const ema50 =
    ema(closes, 50);

  const last =
    closes.at(-1);

  if (
    last > ema20 &&
    ema20 > ema50
  ) {
    return "BULLISH";
  }

  if (
    last < ema20 &&
    ema20 < ema50
  ) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

/*
=========================================================
MARKET STRUCTURE / BOS
=========================================================
*/

function getStructure(candles) {
  if (candles.length < 20) {
    return "NEUTRAL";
  }

  const last =
    candles.at(-1);

  const previous =
    candles.at(-2);

  const reference =
    candles.slice(-17, -2);

  const previousHigh =
    Math.max(
      ...reference.map(
        c => c.high
      )
    );

  const previousLow =
    Math.min(
      ...reference.map(
        c => c.low
      )
    );

  if (
    last.close >
      previousHigh &&
    last.close >
      previous.close
  ) {
    return "BULLISH BOS";
  }

  if (
    last.close <
      previousLow &&
    last.close <
      previous.close
  ) {
    return "BEARISH BOS";
  }

  if (
    last.close >
    previous.close
  ) {
    return "BULLISH";
  }

  if (
    last.close <
    previous.close
  ) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

/*
=========================================================
LIQUIDITY SWEEP
=========================================================
*/

function detectLiquidity(candles) {
  if (candles.length < 20) {
    return "NONE";
  }

  const last =
    candles.at(-1);

  const previousRange =
    candles.slice(-17, -2);

  const rangeHigh =
    Math.max(
      ...previousRange.map(
        c => c.high
      )
    );

  const rangeLow =
    Math.min(
      ...previousRange.map(
        c => c.low
      )
    );

  // Sell-side liquidity sweep:
  // price breaks below lows but closes back above.
  if (
    last.low < rangeLow &&
    last.close > rangeLow
  ) {
    return "SELL-SIDE SWEEP";
  }

  // Buy-side liquidity sweep:
  // price breaks above highs but closes back below.
  if (
    last.high > rangeHigh &&
    last.close < rangeHigh
  ) {
    return "BUY-SIDE SWEEP";
  }

  return "NONE";
}

/*
=========================================================
FAIR VALUE GAP
=========================================================
*/

function detectFVG(candles) {
  if (candles.length < 4) {
    return {
      type: "NONE",
      zone: null,
      distance: null,
      near: false
    };
  }

  const a =
    candles.at(-3);

  const b =
    candles.at(-2);

  const c =
    candles.at(-1);

  const price =
    c.close;

  /*
  Bullish FVG:
  Candle A high < Candle C low
  */
  if (
    a.high < c.low
  ) {
    const low =
      a.high;

    const high =
      c.low;

    const inside =
      price >= low &&
      price <= high;

    const distance =
      inside
        ? 0
        : Math.min(
            Math.abs(price - low),
            Math.abs(price - high)
          );

    const gapSize =
      high - low;

    const near =
      inside ||
      distance <=
        gapSize * 1.5;

    return {
      type: "BULLISH FVG",
      zone: [
        low,
        high
      ],
      distance,
      near
    };
  }

  /*
  Bearish FVG:
  Candle A low > Candle C high
  */
  if (
    a.low > c.high
  ) {
    const low =
      c.high;

    const high =
      a.low;

    const inside =
      price >= low &&
      price <= high;

    const distance =
      inside
        ? 0
        : Math.min(
            Math.abs(price - low),
            Math.abs(price - high)
          );

    const gapSize =
      high - low;

    const near =
      inside ||
      distance <=
        gapSize * 1.5;

    return {
      type: "BEARISH FVG",
      zone: [
        low,
        high
      ],
      distance,
      near
    };
  }

  return {
    type: "NONE",
    zone: null,
    distance: null,
    near: false
  };
}

/*
=========================================================
ORDER BLOCK
=========================================================
*/

function detectOrderBlock(
  candles,
  side
) {
  const lookback =
    candles.slice(-15, -2);

  if (side === "BUY") {
    const bearish =
      [...lookback]
        .reverse()
        .find(
          c =>
            c.close <
            c.open
        );

    if (!bearish) {
      return null;
    }

    return {
      type:
        "BULLISH ORDER BLOCK",
      low: bearish.low,
      high: bearish.high
    };
  }

  const bullish =
    [...lookback]
      .reverse()
      .find(
        c =>
          c.close >
          c.open
      );

  if (!bullish) {
    return null;
  }

  return {
    type:
      "BEARISH ORDER BLOCK",
    low: bullish.low,
    high: bullish.high
  };
}

/*
=========================================================
TIMEFRAME ANALYSIS
=========================================================
*/

function analyzeTimeframe(
  candles
) {
  const closes =
    candles.map(
      c => c.close
    );

  return {
    trend:
      getTrend(candles),

    structure:
      getStructure(candles),

    rsi:
      round(
        rsi(closes),
        1
      ),

    ema20:
      round(
        ema(closes, 20),
        8
      ),

    ema50:
      round(
        ema(closes, 50),
        8
      ),

    atr:
      round(
        atr(candles),
        8
      ),

    last:
      candles.at(-1).close
  };
}

/*
=========================================================
TOP-DOWN ALIGNMENT
=========================================================
*/

function getHTFAlignment(
  t12,
  t4,
  t1
) {
  const bullish =
    t12.trend === "BULLISH" &&
    t4.trend === "BULLISH" &&
    t1.trend !== "BEARISH";

  const bearish =
    t12.trend === "BEARISH" &&
    t4.trend === "BEARISH" &&
    t1.trend !== "BULLISH";

  return {
    bullish,
    bearish
  };
}

/*
=========================================================
PULLBACK / LATE ENTRY PROTECTION
=========================================================
*/

function checkPullbackProtection(
  candles,
  side,
  atrValue,
  ema20,
  rsiValue
) {
  const last =
    candles.at(-1);

  const previous =
    candles.at(-2);

  if (!last || !previous) {
    return {
      safe: false,
      reason:
        "Not enough candles"
    };
  }

  const safeATR =
    Math.max(
      atrValue || 0,
      Math.abs(
        last.high -
          last.low
      ),
      last.close * 0.0005
    );

  const distanceFromEMA =
    Math.abs(
      last.close -
        ema20
    );

  const extension =
    distanceFromEMA /
    safeATR;

  /*
  Do not chase candles that are too far
  from the 20 EMA.
  */
  if (extension > 1.35) {
    return {
      safe: false,
      reason:
        "Price too extended from EMA20"
    };
  }

  /*
  Avoid buying extreme overbought conditions.
  */
  if (
    side === "BUY" &&
    rsiValue > 70
  ) {
    return {
      safe: false,
      reason:
        "BUY RSI too overextended"
    };
  }

  /*
  Avoid selling extreme oversold conditions.
  */
  if (
    side === "SELL" &&
    rsiValue < 30
  ) {
    return {
      safe: false,
      reason:
        "SELL RSI too overextended"
    };
  }

  /*
  Large impulse candle protection.
  */
  const candleBody =
    Math.abs(
      last.close -
        last.open
    );

  if (
    candleBody >
    safeATR * 1.5
  ) {
    return {
      safe: false,
      reason:
        "Entry candle is too large"
    };
  }

  /*
  If price just made a large move in the
  signal direction, wait for pullback.
  */
  const recent =
    candles.slice(-6);

  const recentMove =
    recent.at(-1).close -
    recent[0].close;

  if (
    side === "BUY" &&
    recentMove >
      safeATR * 2.5
  ) {
    return {
      safe: false,
      reason:
        "BUY move already extended"
    };
  }

  if (
    side === "SELL" &&
    recentMove <
      -safeATR * 2.5
  ) {
    return {
      safe: false,
      reason:
        "SELL move already extended"
    };
  }

  return {
    safe: true,
    reason:
      "Entry timing acceptable"
  };
}

/*
=========================================================
SIGNAL BUILDER
=========================================================
*/

function buildSignal(
  all,
  meta
) {
  const t12 =
    analyzeTimeframe(
      all["12h"]
    );

  const t4 =
    analyzeTimeframe(
      all["4h"]
    );

  const t1 =
    analyzeTimeframe(
      all["1h"]
    );

  const t15 =
    analyzeTimeframe(
      all["15min"]
    );

  const t5 =
    analyzeTimeframe(
      all["5min"]
    );

  const candles5 =
    all["5min"];

  const last =
    candles5.at(-1);

  const currentATR =
    t5.atr ||
    Math.abs(
      last.high -
        last.low
    ) ||
    last.close * 0.001;

  const liquidity =
    detectLiquidity(
      candles5
    );

  const fvg =
    detectFVG(
      candles5
    );

  const bullishOB =
    detectOrderBlock(
      candles5,
      "BUY"
    );

  const bearishOB =
    detectOrderBlock(
      candles5,
      "SELL"
    );

  const alignment =
    getHTFAlignment(
      t12,
      t4,
      t1
    );

  const checks = [];

  /*
  1. HTF TREND
  */
  checks.push({
    name:
      "HTF Trend",
    buy:
      alignment.bullish,
    sell:
      alignment.bearish,
    detail:
      `${t12.trend} / ${t4.trend} / ${t1.trend}`
  });

  /*
  2. LIQUIDITY
  */
  checks.push({
    name:
      "Liquidity Grab",
    buy:
      liquidity ===
      "SELL-SIDE SWEEP",
    sell:
      liquidity ===
      "BUY-SIDE SWEEP",
    detail:
      liquidity
  });

  /*
  3. MARKET STRUCTURE
  */
  checks.push({
    name:
      "Market Structure / BOS",
    buy:
      t5.structure.includes(
        "BULLISH"
      ),
    sell:
      t5.structure.includes(
        "BEARISH"
      ),
    detail:
      t5.structure
  });

  /*
  4. FVG
  */
  checks.push({
    name:
      "Fair Value Gap",
    buy:
      fvg.type ===
        "BULLISH FVG" &&
      fvg.near,
    sell:
      fvg.type ===
        "BEARISH FVG" &&
      fvg.near,
    detail:
      fvg.near
        ? `${fvg.type} · PRICE NEAR ZONE`
        : fvg.type
  });

  /*
  5. SMC / ORDER BLOCK
  */
  checks.push({
    name:
      "SMC / Order Block",
    buy:
      Boolean(
        bullishOB
      ) &&
      alignment.bullish,
    sell:
      Boolean(
        bearishOB
      ) &&
      alignment.bearish,
    detail:
      alignment.bullish
        ? (
            bullishOB?.type ||
            "NONE"
          )
        : alignment.bearish
        ? (
            bearishOB?.type ||
            "NONE"
          )
        : "NO HTF ALIGNMENT"
  });

  /*
  6. MOMENTUM / RSI
  */
  checks.push({
    name:
      "Momentum / RSI",
    buy:
      t5.rsi >= 52 &&
      t5.rsi <= 68,
    sell:
      t5.rsi <= 48 &&
      t5.rsi >= 32,
    detail:
      `RSI ${t5.rsi}`
  });

  /*
  7. ENTRY TIMEFRAME
  */
  checks.push({
    name:
      "Entry Timeframe",
    buy:
      t15.trend ===
        "BULLISH" &&
      t5.trend ===
        "BULLISH",
    sell:
      t15.trend ===
        "BEARISH" &&
      t5.trend ===
        "BEARISH",
    detail:
      `${t15.trend} → ${t5.trend}`
  });

  /*
  Determine preliminary side.
  */
  const preliminaryBuy =
    checks.filter(
      c => c.buy
    ).length;

  const preliminarySell =
    checks.filter(
      c => c.sell
    ).length;

  let provisionalSide;

  if (
    preliminaryBuy >
    preliminarySell
  ) {
    provisionalSide =
      "BUY";
  } else if (
    preliminarySell >
    preliminaryBuy
  ) {
    provisionalSide =
      "SELL";
  } else {
    provisionalSide =
      alignment.bullish
        ? "BUY"
        : alignment.bearish
        ? "SELL"
        : "WAIT";
  }

  const orderBlock =
    provisionalSide === "BUY"
      ? bullishOB
      : bearishOB;

  const entry =
    last.close;

  let stopLoss;
  let takeProfit;

  /*
  BUY PLAN
  */
  if (
    provisionalSide ===
    "BUY"
  ) {
    stopLoss =
      orderBlock
        ? Math.min(
            last.low -
              currentATR * 0.20,
            orderBlock.low -
              currentATR * 0.10
          )
        : last.low -
          currentATR * 0.40;

    const risk =
      entry -
      stopLoss;

    takeProfit =
      entry +
      risk * 2;
  }

  /*
  SELL PLAN
  */
  else if (
    provisionalSide ===
    "SELL"
  ) {
    stopLoss =
      orderBlock
        ? Math.max(
            last.high +
              currentATR * 0.20,
            orderBlock.high +
              currentATR * 0.10
          )
        : last.high +
          currentATR * 0.40;

    const risk =
      stopLoss -
      entry;

    takeProfit =
      entry -
      risk * 2;
  }

  else {
    stopLoss =
      entry;

    takeProfit =
      entry;
  }

  const risk =
    Math.abs(
      entry -
        stopLoss
    );

  const reward =
    Math.abs(
      takeProfit -
        entry
    );

  const rr =
    risk > 0
      ? reward / risk
      : 0;

  /*
  8. RISK / REWARD
  */
  checks.push({
    name:
      "Risk / Reward",
    buy:
      provisionalSide ===
        "BUY" &&
      rr >= 2,
    sell:
      provisionalSide ===
        "SELL" &&
      rr >= 2,
    detail:
      `R:R 1:${round(
        rr,
        2
      )}`
  });

  /*
  9. PULLBACK PROTECTION
  */
  const pullback =
    checkPullbackProtection(
      candles5,
      provisionalSide,
      currentATR,
      t5.ema20,
      t5.rsi
    );

  checks.push({
    name:
      "Pullback Protection",
    buy:
      provisionalSide ===
        "BUY" &&
      pullback.safe,
    sell:
      provisionalSide ===
        "SELL" &&
      pullback.safe,
    detail:
      pullback.reason
  });

  /*
  FINAL SCORE
  */
  const buyScore =
    checks.filter(
      c => c.buy
    ).length;

  const sellScore =
    checks.filter(
      c => c.sell
    ).length;

  const score =
    Math.max(
      buyScore,
      sellScore
    );

  const finalSide =
    buyScore >
    sellScore
      ? "BUY"
      : sellScore >
        buyScore
      ? "SELL"
      : provisionalSide;

  const finalAlignment =
    finalSide ===
      "BUY"
      ? alignment.bullish
      : finalSide ===
        "SELL"
      ? alignment.bearish
      : false;

  const finalPullback =
    finalSide ===
      "BUY" ||
    finalSide ===
      "SELL"
      ? pullback.safe
      : false;

  /*
  STRICT VALIDATION

  Signal must:
  - score at least 7/9
  - have HTF alignment
  - have R:R >= 1:2
  - pass pullback protection
  */
  const valid =
    finalSide !==
      "WAIT" &&
    score >=
      MIN_SCORE &&
    finalAlignment &&
    rr >= 2 &&
    finalPullback;

  const result =
    valid
      ? finalSide
      : "WAIT";

  let grade =
    "WAIT";

  if (
    result !==
    "WAIT"
  ) {
    if (
      score >= 9
    ) {
      grade =
        "ELITE";
    } else if (
      score >= 8
    ) {
      grade =
        "STRONG";
    } else {
      grade =
        "VALID";
    }
  }

  return {
    result,

    grade,

    score,

    confidence:
      Math.round(
        clamp(
          (score / 9) *
            100,
          0,
          100
        )
      ),

    side:
      result ===
        "WAIT"
        ? finalSide
        : result,

    entry:
      result ===
        "WAIT"
        ? null
        : round(
            entry,
            meta.decimals
          ),

    stopLoss:
      result ===
        "WAIT"
        ? null
        : round(
            stopLoss,
            meta.decimals
          ),

    takeProfit:
      result ===
        "WAIT"
        ? null
        : round(
            takeProfit,
            meta.decimals
          ),

    rr:
      round(
        rr,
        2
      ),

    trend: {
      "12h":
        t12.trend,

      "4h":
        t4.trend,

      "1h":
        t1.trend,

      "15min":
        t15.trend,

      "5min":
        t5.trend
    },

    timeframes: {
      "12h":
        t12,

      "4h":
        t4,

      "1h":
        t1,

      "15min":
        t15,

      "5min":
        t5
    },

    liquidity,

    fvg,

    orderBlock,

    structure:
      t5.structure,

    pullback,

    checks,

    lastPrice:
      round(
        last.close,
        meta.decimals
      ),

    scannedAt:
      new Date()
        .toISOString()
  };
}

/*
=========================================================
TELEGRAM
=========================================================
*/

async function sendTelegram(
  message
) {
  if (
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_CHAT_ID
  ) {
    return;
  }

  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const response =
    await fetch(
      url,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            chat_id:
              TELEGRAM_CHAT_ID,

            text:
              message
          })
      }
    );

  if (!response.ok) {
    throw new Error(
      `Telegram HTTP ${response.status}`
    );
  }
}

/*
=========================================================
TELEGRAM SIGNAL NOTIFICATION
=========================================================
*/

async function notifySignal(
  meta,
  signal
) {
  if (
    signal.result ===
    "WAIT"
  ) {
    return;
  }

  const key =
    [
      meta.label,
      signal.result,
      signal.entry,
      signal.stopLoss,
      signal.takeProfit
    ].join("|");

  if (
    state.lastAlertKey[
      meta.label
    ] === key
  ) {
    return;
  }

  state.lastAlertKey[
    meta.label
  ] = key;

  const emoji =
    signal.result ===
      "BUY"
      ? "🟢"
      : "🔴";

  const title =
    signal.grade ===
      "ELITE"
      ? "🚨 ELITE"
      : signal.grade ===
        "STRONG"
      ? "🚨 STRONG"
      : "⚡ VALID";

  const message =
    [
      `${title} ${signal.result}: ${meta.label}`,

      "",

      `📍 Entry: ${signal.entry}`,

      `🛑 Stop Loss: ${signal.stopLoss}`,

      `🎯 Take Profit: ${signal.takeProfit}`,

      `⭐ Score: ${signal.score}/9`,

      `💪 Confidence: ${signal.confidence}%`,

      `📊 R:R: 1:${signal.rr}`,

      "",

      `${emoji} 12H: ${signal.trend["12h"]}`,

      `${emoji} 4H: ${signal.trend["4h"]}`,

      `${emoji} 1H: ${signal.trend["1h"]}`,

      `${emoji} 15M: ${signal.trend["15min"]}`,

      `${emoji} 5M: ${signal.trend["5min"]}`,

      "",

      `💧 Liquidity: ${signal.liquidity}`,

      `📐 FVG: ${signal.fvg.type}`,

      `🏦 SMC: ${
        signal.orderBlock?.type ||
        "NONE"
      }`,

      `📈 Structure: ${signal.structure}`,

      `🛡 Pullback: ${
        signal.pullback?.reason ||
        "OK"
      }`,

      "",

      "VANTA•9 — Strict Entry System"
    ].join("\n");

  try {
    await sendTelegram(
      message
    );
  } catch (error) {
    console.error(
      "Telegram error:",
      error.message
    );
  }
}

/*
=========================================================
SCAN ONE INSTRUMENT
=========================================================
*/

async function scanInstrument(
  meta
) {
  const all = {};

  /*
  Fetch only supported API timeframes.
  */
  for (
    const timeframe of
      API_TIMEFRAMES
  ) {
    try {
      all[timeframe] =
        await getCandles(
          meta.symbol,
          timeframe,
          150
        );

      await sleep(300);
    } catch (error) {
      throw new Error(
        `${meta.label} ${timeframe}: ${error.message}`
      );
    }
  }

  /*
  Build synthetic 12H.
  */
  all["12h"] =
    build12HCandles(
      all["4h"]
    );

  if (
    all["12h"].length <
    30
  ) {
    throw new Error(
      `${meta.label}: Not enough synthetic 12H candles`
    );
  }

  return buildSignal(
    all,
    meta
  );
}

/*
=========================================================
SCAN ALL
=========================================================
*/

async function scanAll() {
  if (
    state.scanning
  ) {
    return;
  }

  state.scanning =
    true;

  try {
    for (
      const meta of
        INSTRUMENTS
    ) {
      try {
        const signal =
          await scanInstrument(
            meta
          );

        state.pairs[
          meta.label
        ] = signal;

        await notifySignal(
          meta,
          signal
        );

        await sleep(700);
      } catch (error) {
        console.error(
          `${meta.label}:`,
          error.message
        );

        state.pairs[
          meta.label
        ] = {
          result:
            "OFFLINE",

          error:
            error.message,

          scannedAt:
            new Date()
              .toISOString()
        };
      }
    }

    state.updatedAt =
      new Date()
        .toISOString();

  } finally {
    state.scanning =
      false;
  }
}

/*
=========================================================
HEALTH
=========================================================
*/

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,

      service:
        "VANTA-9 Trading Bot",

      time:
        new Date()
          .toISOString()
    });
  }
);

/*
=========================================================
STATUS
=========================================================
*/

app.get(
  "/api/status",
  (req, res) => {
    res.json({
      ok: true,

      scanning:
        state.scanning,

      updatedAt:
        state.updatedAt,

      instruments:
        INSTRUMENTS.map(
          x => x.label
        ),

      pairs:
        state.pairs,

      pollMs:
        POLL_MS,

      minScore:
        MIN_SCORE,

      displayTimeframes:
        DISPLAY_TIMEFRAMES,

      apiTimeframes:
        API_TIMEFRAMES,

      synthetic12h:
        true
    });
  }
);

/*
=========================================================
START SERVER
=========================================================
*/

app.listen(
  PORT,
  () => {
    console.log(
      `VANTA•9 running on port ${PORT}`
    );

    console.log(
      `Monitoring: ${INSTRUMENTS
        .map(x => x.label)
        .join(", ")}`
    );

    console.log(
      `Display Timeframes: ${DISPLAY_TIMEFRAMES.join(
        ", "
      )}`
    );

    console.log(
      `API Timeframes: ${API_TIMEFRAMES.join(
        ", "
      )}`
    );

    console.log(
      `12H: built from 4H candles`
    );

    console.log(
      `Minimum score: ${MIN_SCORE}/9`
    );

    console.log(
      `Scan interval: ${
        POLL_MS / 60000
      } minutes`
    );

    if (!API_KEY) {
      console.warn(
        "WARNING: TWELVE_DATA_API_KEY is missing"
      );
    }

    if (
      !TELEGRAM_BOT_TOKEN ||
      !TELEGRAM_CHAT_ID
    ) {
      console.warn(
        "Telegram variables are not configured."
      );
    }

    /*
    Initial scan.
    */
    scanAll();

    /*
    Repeated scans.
    */
    setInterval(
      scanAll,
      POLL_MS
    );
  }
);
