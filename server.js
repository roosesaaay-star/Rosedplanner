const express = require("express");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

const API_KEY = process.env.TWELVE_DATA_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// =========================================================
// VANTA•9 CONFIGURATION
// =========================================================

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

// Twelve Data does NOT support 12h.
// We build 12H from 4H candles.
const API_TIMEFRAMES = ["4h", "1h", "15min", "5min"];

const DISPLAY_TIMEFRAMES = [
  "12h",
  "4h",
  "1h",
  "15min",
  "5min"
];

const OUTPUT_SIZE = 150;

// Your account currently has an 8-credit/minute limit.
// We deliberately use 7 to leave one credit of safety.
const MAX_REQUESTS_PER_MINUTE = 7;

const POLL_MS = Math.max(
  900000,
  Number(process.env.POLL_MS || 900000)
);

const REQUEST_TIMEOUT_MS = 20000;

// =========================================================
// STATE
// =========================================================

const state = {
  startedAt: new Date().toISOString(),
  lastScan: null,
  nextScan: null,
  scanning: false,
  apiRequestsLastMinute: 0,
  pairs: {},
  telegram: {
    configured: Boolean(
      TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID
    ),
    lastAlert: null
  }
};

for (const instrument of INSTRUMENTS) {
  state.pairs[instrument.label] = {
    symbol: instrument.symbol,
    label: instrument.label,
    status: "LOADING",
    price: null,
    signal: null,
    score: 0,
    confidence: null,
    timeframes: {},
    lastUpdated: null,
    error: null
  };
}

// =========================================================
// HELPERS
// =========================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function round(value, decimals = 5) {
  if (!Number.isFinite(value)) return null;

  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values) {
  const valid = values.filter(Number.isFinite);

  if (!valid.length) return null;

  return (
    valid.reduce((sum, value) => sum + value, 0) /
    valid.length
  );
}

function getLast(arr) {
  return arr && arr.length
    ? arr[arr.length - 1]
    : null;
}

// =========================================================
// TWELVE DATA RATE LIMITER
// =========================================================

const requestTimestamps = [];

function cleanupRequestTimestamps() {
  const now = Date.now();

  while (
    requestTimestamps.length &&
    now - requestTimestamps[0] >= 60000
  ) {
    requestTimestamps.shift();
  }
}

function getRequestsLastMinute() {
  cleanupRequestTimestamps();
  return requestTimestamps.length;
}

async function waitForApiSlot() {
  while (true) {
    cleanupRequestTimestamps();

    if (
      requestTimestamps.length <
      MAX_REQUESTS_PER_MINUTE
    ) {
      requestTimestamps.push(Date.now());

      state.apiRequestsLastMinute =
        requestTimestamps.length;

      return;
    }

    const oldest = requestTimestamps[0];

    const waitMs =
      Math.max(
        1000,
        60000 - (Date.now() - oldest) + 750
      );

    console.log(
      `⏳ Twelve Data limit protection: waiting ${Math.ceil(
        waitMs / 1000
      )} seconds...`
    );

    await sleep(waitMs);
  }
}

// =========================================================
// TWELVE DATA API
// =========================================================

async function twelveData(symbol, interval, retry = 0) {
  if (!API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY is missing"
    );
  }

  await waitForApiSlot();

  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${OUTPUT_SIZE}` +
    `&timezone=UTC` +
    `&apikey=${encodeURIComponent(API_KEY)}`;

  const controller =
    new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(url, {
      signal: controller.signal
    });

    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `Invalid Twelve Data response for ${symbol} ${interval}`
      );
    }

    if (
      response.status === 429 ||
      data.code === 429 ||
      String(data.status || "").toLowerCase() ===
        "error" &&
        /credit|limit|too many/i.test(
          String(data.message || "")
        )
    ) {
      if (retry < 1) {
        console.log(
          `⚠️ Twelve Data rate limit on ${symbol} ${interval}. Retrying after 65 seconds...`
        );

        await sleep(65000);

        return twelveData(
          symbol,
          interval,
          retry + 1
        );
      }

      throw new Error(
        `Twelve Data rate limit: ${
          data.message || "Too many requests"
        }`
      );
    }

    if (!response.ok) {
      throw new Error(
        `Twelve Data HTTP ${response.status}: ${
          data.message || "Request failed"
        }`
      );
    }

    if (
      data.status === "error" ||
      data.code
    ) {
      throw new Error(
        data.message ||
          `Twelve Data error for ${symbol} ${interval}`
      );
    }

    if (
      !Array.isArray(data.values) ||
      data.values.length < 20
    ) {
      throw new Error(
        `${symbol} ${interval}: insufficient candle data`
      );
    }

    const candles = data.values
      .map(candle => ({
        time: new Date(candle.datetime).getTime(),

        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close),

        volume:
          candle.volume !== undefined
            ? Number(candle.volume)
            : null
      }))
      .filter(c =>
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
      )
      .sort((a, b) => a.time - b.time);

    return candles;
  } finally {
    clearTimeout(timeout);
  }
}

// =========================================================
// BUILD SYNTHETIC 12H FROM 4H
// =========================================================

function build12HCandles(candles4h) {
  const groups = new Map();

  for (const candle of candles4h) {
    const date = new Date(candle.time);

    const hour = date.getUTCHours();

    const blockHour =
      hour < 12 ? 0 : 12;

    const start = new Date(
      Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        blockHour,
        0,
        0,
        0
      )
    );

    const key = start.getTime();

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(candle);
  }

  const result = [];

  for (const [time, group] of groups.entries()) {
    group.sort(
      (a, b) => a.time - b.time
    );

    // Only use completed 12H blocks.
    // 12H = three 4H candles.
    if (group.length < 3) {
      continue;
    }

    const first = group[0];
    const last = group[group.length - 1];

    result.push({
      time,
      open: first.open,
      high: Math.max(
        ...group.map(c => c.high)
      ),
      low: Math.min(
        ...group.map(c => c.low)
      ),
      close: last.close,
      volume: group.every(
        c => Number.isFinite(c.volume)
      )
        ? group.reduce(
            (sum, c) => sum + c.volume,
            0
          )
        : null
    });
  }

  return result.sort(
    (a, b) => a.time - b.time
  );
}

// =========================================================
// EMA
// =========================================================

function ema(values, period) {
  if (!values.length) return [];

  const result = [];

  const multiplier =
    2 / (period + 1);

  let previous = values[0];

  result.push(previous);

  for (let i = 1; i < values.length; i++) {
    previous =
      (values[i] - previous) *
        multiplier +
      previous;

    result.push(previous);
  }

  return result;
}

// =========================================================
// RSI
// =========================================================

function rsi(values, period = 14) {
  if (values.length <= period) {
    return [];
  }

  const result = new Array(
    values.length
  ).fill(null);

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const difference =
      values[i] - values[i - 1];

    if (difference >= 0) {
      gains += difference;
    } else {
      losses += Math.abs(difference);
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  result[period] =
    avgLoss === 0
      ? 100
      : 100 -
        100 /
          (1 +
            avgGain /
              avgLoss);

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const difference =
      values[i] - values[i - 1];

    const gain =
      difference > 0
        ? difference
        : 0;

    const loss =
      difference < 0
        ? Math.abs(difference)
        : 0;

    avgGain =
      (avgGain * (period - 1) +
        gain) /
      period;

    avgLoss =
      (avgLoss * (period - 1) +
        loss) /
      period;

    result[i] =
      avgLoss === 0
        ? 100
        : 100 -
          100 /
            (1 +
              avgGain /
                avgLoss);
  }

  return result;
}

// =========================================================
// ATR
// =========================================================

function atr(candles, period = 14) {
  if (candles.length < period + 1) {
    return [];
  }

  const trueRanges = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const tr = Math.max(
      current.high - current.low,

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

  const result = new Array(
    candles.length
  ).fill(null);

  let initial = 0;

  for (
    let i = 0;
    i < period;
    i++
  ) {
    initial += trueRanges[i];
  }

  let currentATR =
    initial / period;

  result[period] = currentATR;

  for (
    let i = period;
    i < trueRanges.length;
    i++
  ) {
    currentATR =
      (currentATR * (period - 1) +
        trueRanges[i]) /
      period;

    result[i + 1] = currentATR;
  }

  return result;
}

// =========================================================
// TREND
// =========================================================

function getTrend(candles) {
  if (candles.length < 50) {
    return "NEUTRAL";
  }

  const closes =
    candles.map(c => c.close);

  const ema20 = ema(
    closes,
    20
  );

  const ema50 = ema(
    closes,
    50
  );

  const lastClose =
    getLast(closes);

  const lastEMA20 =
    getLast(ema20);

  const lastEMA50 =
    getLast(ema50);

  if (
    lastClose > lastEMA20 &&
    lastEMA20 > lastEMA50
  ) {
    return "BULLISH";
  }

  if (
    lastClose < lastEMA20 &&
    lastEMA20 < lastEMA50
  ) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

// =========================================================
// MARKET STRUCTURE / BOS
// =========================================================

function getStructure(candles) {
  if (candles.length < 12) {
    return {
      direction: "NEUTRAL",
      bos: false,
      previousHigh: null,
      previousLow: null
    };
  }

  const recent =
    candles.slice(-10);

  const previous =
    candles.slice(-20, -10);

  if (!previous.length) {
    return {
      direction: "NEUTRAL",
      bos: false,
      previousHigh: null,
      previousLow: null
    };
  }

  const previousHigh =
    Math.max(
      ...previous.map(c => c.high)
    );

  const previousLow =
    Math.min(
      ...previous.map(c => c.low)
    );

  const current =
    getLast(recent);

  if (
    current.close >
    previousHigh
  ) {
    return {
      direction: "BULLISH",
      bos: true,
      previousHigh,
      previousLow
    };
  }

  if (
    current.close <
    previousLow
  ) {
    return {
      direction: "BEARISH",
      bos: true,
      previousHigh,
      previousLow
    };
  }

  const recentHigh =
    Math.max(
      ...recent.map(c => c.high)
    );

  const recentLow =
    Math.min(
      ...recent.map(c => c.low)
    );

  if (
    recentHigh >
      previousHigh &&
    current.close >
      candles[candles.length - 2]
        .close
  ) {
    return {
      direction: "BULLISH",
      bos: false,
      previousHigh,
      previousLow
    };
  }

  if (
    recentLow <
      previousLow &&
    current.close <
      candles[candles.length - 2]
        .close
  ) {
    return {
      direction: "BEARISH",
      bos: false,
      previousHigh,
      previousLow
    };
  }

  return {
    direction: "NEUTRAL",
    bos: false,
    previousHigh,
    previousLow
  };
}

// =========================================================
// LIQUIDITY SWEEP
// =========================================================

function detectLiquidity(candles) {
  if (candles.length < 12) {
    return {
      direction: "NONE",
      type: "NONE",
      level: null
    };
  }

  const recent =
    candles.slice(-7, -1);

  const current =
    getLast(candles);

  const previousHigh =
    Math.max(
      ...recent.map(c => c.high)
    );

  const previousLow =
    Math.min(
      ...recent.map(c => c.low)
    );

  // BUY liquidity grab:
  // price sweeps lows then closes back above.
  if (
    current.low < previousLow &&
    current.close > previousLow
  ) {
    return {
      direction: "BULLISH",
      type: "SELL-SIDE LIQUIDITY SWEEP",
      level: previousLow
    };
  }

  // SELL liquidity grab:
  // price sweeps highs then closes back below.
  if (
    current.high > previousHigh &&
    current.close < previousHigh
  ) {
    return {
      direction: "BEARISH",
      type: "BUY-SIDE LIQUIDITY SWEEP",
      level: previousHigh
    };
  }

  return {
    direction: "NONE",
    type: "NONE",
    level: null
  };
}

// =========================================================
// FAIR VALUE GAP
// =========================================================

function detectFVG(candles) {
  if (candles.length < 5) {
    return {
      direction: "NONE",
      low: null,
      high: null,
      active: false
    };
  }

  const current =
    getLast(candles);

  const c1 =
    candles[candles.length - 3];

  const c3 =
    candles[candles.length - 1];

  // Bullish FVG:
  // candle 3 low > candle 1 high
  if (c3.low > c1.high) {
    const gapLow = c1.high;
    const gapHigh = c3.low;

    const priceInside =
      current.close >= gapLow &&
      current.close <= gapHigh;

    return {
      direction: "BULLISH",
      low: gapLow,
      high: gapHigh,
      active: priceInside
    };
  }

  // Bearish FVG:
  // candle 3 high < candle 1 low
  if (c3.high < c1.low) {
    const gapLow = c3.high;
    const gapHigh = c1.low;

    const priceInside =
      current.close >= gapLow &&
      current.close <= gapHigh;

    return {
      direction: "BEARISH",
      low: gapLow,
      high: gapHigh,
      active: priceInside
    };
  }

  return {
    direction: "NONE",
    low: null,
    high: null,
    active: false
  };
}

// =========================================================
// ORDER BLOCK / SMC
// =========================================================

function detectOrderBlock(candles) {
  if (candles.length < 10) {
    return {
      direction: "NONE",
      low: null,
      high: null,
      active: false
    };
  }

  const current =
    getLast(candles);

  const previous =
    candles[candles.length - 2];

  const before =
    candles[candles.length - 3];

  // Bullish displacement
  const bullishMove =
    current.close >
      previous.high &&
    previous.close >
      before.high;

  if (bullishMove) {
    const source =
      before.close < before.open
        ? before
        : previous;

    const low = source.low;
    const high = source.high;

    return {
      direction: "BULLISH",
      low,
      high,
      active:
        current.close >= low &&
        current.close <= high
    };
  }

  // Bearish displacement
  const bearishMove =
    current.close <
      previous.low &&
    previous.close <
      before.low;

  if (bearishMove) {
    const source =
      before.close > before.open
        ? before
        : previous;

    const low = source.low;
    const high = source.high;

    return {
      direction: "BEARISH",
      low,
      high,
      active:
        current.close >= low &&
        current.close <= high
    };
  }

  return {
    direction: "NONE",
    low: null,
    high: null,
    active: false
  };
}

// =========================================================
// MOMENTUM
// =========================================================

function getMomentum(candles) {
  const closes =
    candles.map(c => c.close);

  const rsiValues =
    rsi(closes, 14);

  const ema20 =
    ema(closes, 20);

  const lastRSI =
    getLast(rsiValues);

  const lastEMA =
    getLast(ema20);

  const price =
    getLast(closes);

  if (
    !Number.isFinite(lastRSI) ||
    !Number.isFinite(lastEMA)
  ) {
    return {
      rsi: null,
      direction: "NEUTRAL"
    };
  }

  if (
    lastRSI >= 50 &&
    price > lastEMA
  ) {
    return {
      rsi: lastRSI,
      direction: "BULLISH"
    };
  }

  if (
    lastRSI < 50 &&
    price < lastEMA
  ) {
    return {
      rsi: lastRSI,
      direction: "BEARISH"
    };
  }

  return {
    rsi: lastRSI,
    direction: "NEUTRAL"
  };
}

// =========================================================
// PULLBACK PROTECTION
// =========================================================

function checkPullbackProtection(
  candles,
  direction
) {
  if (candles.length < 30) {
    return {
      safe: false,
      reason: "Not enough candles"
    };
  }

  const closes =
    candles.map(c => c.close);

  const ema20 =
    ema(closes, 20);

  const atrValues =
    atr(candles, 14);

  const price =
    getLast(closes);

  const currentEMA =
    getLast(ema20);

  const currentATR =
    getLast(atrValues);

  const current =
    getLast(candles);

  if (
    !Number.isFinite(currentATR) ||
    currentATR <= 0
  ) {
    return {
      safe: false,
      reason: "ATR unavailable"
    };
  }

  const distance =
    Math.abs(
      price - currentEMA
    );

  // Price too extended from EMA.
  if (
    distance >
    currentATR * 1.35
  ) {
    return {
      safe: false,
      reason: "Price too extended from EMA20"
    };
  }

  const momentum =
    getMomentum(candles);

  if (
    direction === "BUY" &&
    momentum.rsi !== null &&
    momentum.rsi > 70
  ) {
    return {
      safe: false,
      reason: "BUY RSI overextended"
    };
  }

  if (
    direction === "SELL" &&
    momentum.rsi !== null &&
    momentum.rsi < 30
  ) {
    return {
      safe: false,
      reason: "SELL RSI overextended"
    };
  }

  // Avoid huge displacement candle entries.
  const body =
    Math.abs(
      current.close -
        current.open
    );

  if (
    body >
    currentATR * 1.5
  ) {
    return {
      safe: false,
      reason: "Entry candle too large"
    };
  }

  // Check recent directional expansion.
  const lookback =
    candles.slice(-6);

  if (lookback.length >= 2) {
    const start =
      lookback[0].close;

    const end =
      lookback[lookback.length - 1]
        .close;

    const move =
      end - start;

    if (
      direction === "BUY" &&
      move >
        currentATR * 2.5
    ) {
      return {
        safe: false,
        reason: "BUY move already too extended"
      };
    }

    if (
      direction === "SELL" &&
      -move >
        currentATR * 2.5
    ) {
      return {
        safe: false,
        reason: "SELL move already too extended"
      };
    }
  }

  return {
    safe: true,
    reason: "Pullback risk acceptable"
  };
}

// =========================================================
// ENTRY LEVELS
// =========================================================

function calculateTradeLevels(
  candles,
  direction,
  decimals
) {
  const current =
    getLast(candles);

  const atrValues =
    atr(candles, 14);

  const currentATR =
    getLast(atrValues);

  if (
    !current ||
    !Number.isFinite(currentATR)
  ) {
    return null;
  }

  const entry =
    current.close;

  let stopLoss;
  let takeProfit;

  if (direction === "BUY") {
    const recentLow =
      Math.min(
        ...candles
          .slice(-8)
          .map(c => c.low)
      );

    stopLoss =
      recentLow -
      currentATR * 0.15;

    const risk =
      entry - stopLoss;

    takeProfit =
      entry + risk * 2.5;
  } else {
    const recentHigh =
      Math.max(
        ...candles
          .slice(-8)
          .map(c => c.high)
      );

    stopLoss =
      recentHigh +
      currentATR * 0.15;

    const risk =
      stopLoss - entry;

    takeProfit =
      entry - risk * 2.5;
  }

  const risk =
    direction === "BUY"
      ? entry - stopLoss
      : stopLoss - entry;

  const reward =
    direction === "BUY"
      ? takeProfit - entry
      : entry - takeProfit;

  const rr =
    risk > 0
      ? reward / risk
      : 0;

  return {
    entry: round(entry, decimals),
    stopLoss: round(
      stopLoss,
      decimals
    ),
    takeProfit: round(
      takeProfit,
      decimals
    ),
    risk: round(
      risk,
      decimals
    ),
    reward: round(
      reward,
      decimals
    ),
    rr: round(rr, 2)
  };
}

// =========================================================
// TIMEFRAME ANALYSIS
// =========================================================

function analyzeTimeframe(candles) {
  const trend =
    getTrend(candles);

  const structure =
    getStructure(candles);

  const liquidity =
    detectLiquidity(candles);

  const fvg =
    detectFVG(candles);

  const orderBlock =
    detectOrderBlock(candles);

  const momentum =
    getMomentum(candles);

  return {
    trend,
    structure,
    liquidity,
    fvg,
    orderBlock,
    momentum,
    candles
  };
}

// =========================================================
// VANTA•9 SIGNAL ENGINE
// =========================================================

function buildSignal(
  instrument,
  timeframeData
) {
  const tf12 =
    timeframeData["12h"];

  const tf4 =
    timeframeData["4h"];

  const tf1 =
    timeframeData["1h"];

  const tf15 =
    timeframeData["15min"];

  const tf5 =
    timeframeData["5min"];

  if (
    !tf12 ||
    !tf4 ||
    !tf1 ||
    !tf15 ||
    !tf5
  ) {
    return {
      signal: "WAIT",
      score: 0,
      confidence: "INSUFFICIENT DATA",
      reason: "Missing timeframe data"
    };
  }

  let buyScore = 0;
  let sellScore = 0;

  const reasonsBuy = [];
  const reasonsSell = [];

  // -------------------------------------------------------
  // 1. HTF TREND
  // -------------------------------------------------------

  const htfBullish =
    tf12.trend === "BULLISH" &&
    tf4.trend === "BULLISH";

  const htfBearish =
    tf12.trend === "BEARISH" &&
    tf4.trend === "BEARISH";

  if (htfBullish) {
    buyScore++;
    reasonsBuy.push(
      "12H + 4H bullish"
    );
  }

  if (htfBearish) {
    sellScore++;
    reasonsSell.push(
      "12H + 4H bearish"
    );
  }

  // -------------------------------------------------------
  // 2. LIQUIDITY GRAB
  // -------------------------------------------------------

  if (
    tf15.liquidity.direction ===
    "BULLISH"
  ) {
    buyScore++;
    reasonsBuy.push(
      "Sell-side liquidity swept"
    );
  }

  if (
    tf15.liquidity.direction ===
    "BEARISH"
  ) {
    sellScore++;
    reasonsSell.push(
      "Buy-side liquidity swept"
    );
  }

  // -------------------------------------------------------
  // 3. MARKET STRUCTURE / BOS
  // -------------------------------------------------------

  if (
    tf15.structure.direction ===
      "BULLISH" &&
    tf15.structure.bos
  ) {
    buyScore++;
    reasonsBuy.push(
      "Bullish BOS"
    );
  }

  if (
    tf15.structure.direction ===
      "BEARISH" &&
    tf15.structure.bos
  ) {
    sellScore++;
    reasonsSell.push(
      "Bearish BOS"
    );
  }

  // -------------------------------------------------------
  // 4. FVG
  // -------------------------------------------------------

  if (
    tf15.fvg.direction ===
      "BULLISH" &&
    tf15.fvg.active
  ) {
    buyScore++;
    reasonsBuy.push(
      "Price interacting with bullish FVG"
    );
  }

  if (
    tf15.fvg.direction ===
      "BEARISH" &&
    tf15.fvg.active
  ) {
    sellScore++;
    reasonsSell.push(
      "Price interacting with bearish FVG"
    );
  }

  // -------------------------------------------------------
  // 5. SMC / ORDER BLOCK
  // -------------------------------------------------------

  if (
    tf15.orderBlock.direction ===
      "BULLISH" &&
    tf15.orderBlock.active
  ) {
    buyScore++;
    reasonsBuy.push(
      "Bullish order block active"
    );
  }

  if (
    tf15.orderBlock.direction ===
      "BEARISH" &&
    tf15.orderBlock.active
  ) {
    sellScore++;
    reasonsSell.push(
      "Bearish order block active"
    );
  }

  // -------------------------------------------------------
  // 6. MOMENTUM / RSI
  // -------------------------------------------------------

  if (
    tf15.momentum.direction ===
    "BULLISH"
  ) {
    buyScore++;
    reasonsBuy.push(
      `Bullish momentum RSI ${round(
        tf15.momentum.rsi,
        1
      )}`
    );
  }

  if (
    tf15.momentum.direction ===
    "BEARISH"
  ) {
    sellScore++;
    reasonsSell.push(
      `Bearish momentum RSI ${round(
        tf15.momentum.rsi,
        1
      )}`
    );
  }

  // -------------------------------------------------------
  // 7. ENTRY TIMEFRAME CONFIRMATION
  // -------------------------------------------------------

  if (
    tf5.trend === "BULLISH" &&
    (
      tf5.structure.direction ===
        "BULLISH" ||
      tf5.momentum.direction ===
        "BULLISH"
    )
  ) {
    buyScore++;
    reasonsBuy.push(
      "5M confirms BUY"
    );
  }

  if (
    tf5.trend === "BEARISH" &&
    (
      tf5.structure.direction ===
        "BEARISH" ||
      tf5.momentum.direction ===
        "BEARISH"
    )
  ) {
    sellScore++;
    reasonsSell.push(
      "5M confirms SELL"
    );
  }

  // -------------------------------------------------------
  // 8. RISK / REWARD
  // -------------------------------------------------------

  const buyLevels =
    calculateTradeLevels(
      tf5.candles,
      "BUY",
      instrument.decimals
    );

  const sellLevels =
    calculateTradeLevels(
      tf5.candles,
      "SELL",
      instrument.decimals
    );

  if (
    buyLevels &&
    buyLevels.rr >= 2
  ) {
    buyScore++;
    reasonsBuy.push(
      `R:R ${buyLevels.rr}:1`
    );
  }

  if (
    sellLevels &&
    sellLevels.rr >= 2
  ) {
    sellScore++;
    reasonsSell.push(
      `R:R ${sellLevels.rr}:1`
    );
  }

  // -------------------------------------------------------
  // 9. PULLBACK PROTECTION
  // -------------------------------------------------------

  const buyPullback =
    checkPullbackProtection(
      tf5.candles,
      "BUY"
    );

  const sellPullback =
    checkPullbackProtection(
      tf5.candles,
      "SELL"
    );

  if (buyPullback.safe) {
    buyScore++;
    reasonsBuy.push(
      "Pullback protection passed"
    );
  }

  if (sellPullback.safe) {
    sellScore++;
    reasonsSell.push(
      "Pullback protection passed"
    );
  }

  // -------------------------------------------------------
  // FINAL DECISION
  // -------------------------------------------------------

  let direction = null;
  let score = 0;
  let reasons = [];
  let levels = null;
  let pullback = null;

  if (
    buyScore > sellScore
  ) {
    direction = "BUY";
    score = buyScore;
    reasons = reasonsBuy;
    levels = buyLevels;
    pullback = buyPullback;
  } else if (
    sellScore > buyScore
  ) {
    direction = "SELL";
    score = sellScore;
    reasons = reasonsSell;
    levels = sellLevels;
    pullback = sellPullback;
  } else {
    return {
      signal: "WAIT",
      score: Math.max(
        buyScore,
        sellScore
      ),
      buyScore,
      sellScore,
      confidence: "NO CLEAR EDGE",
      reason:
        "BUY and SELL confirmations are not clearly separated"
    };
  }

  // Strict HTF alignment.
  const htfAligned =
    direction === "BUY"
      ? htfBullish
      : htfBearish;

  if (!htfAligned) {
    return {
      signal: "WAIT",
      score,
      buyScore,
      sellScore,
      confidence: "HTF MISALIGNED",
      reason:
        "12H and 4H do not confirm the direction",
      reasons
    };
  }

  // Minimum 7/9.
  if (score < 7) {
    return {
      signal: "WAIT",
      score,
      buyScore,
      sellScore,
      confidence: "BELOW VANTA•9 THRESHOLD",
      reason:
        `Only ${score}/9 confirmations passed`,
      reasons
    };
  }

  // Pullback must pass.
  if (
    !pullback ||
    !pullback.safe
  ) {
    return {
      signal: "WAIT",
      score,
      buyScore,
      sellScore,
      confidence: "LATE ENTRY BLOCKED",
      reason:
        pullback
          ? pullback.reason
          : "Pullback protection failed",
      reasons
    };
  }

  // R:R must be at least 2.
  if (
    !levels ||
    levels.rr < 2
  ) {
    return {
      signal: "WAIT",
      score,
      buyScore,
      sellScore,
      confidence: "R:R FAILED",
      reason:
        "Risk/reward below 1:2",
      reasons
    };
  }

  let confidence;

  if (score >= 9) {
    confidence = "ELITE";
  } else if (score === 8) {
    confidence = "STRONG";
  } else {
    confidence = "VALID";
  }

  return {
    signal: direction,
    score,
    buyScore,
    sellScore,
    confidence,

    entry: levels.entry,
    stopLoss: levels.stopLoss,
    takeProfit: levels.takeProfit,

    risk: levels.risk,
    reward: levels.reward,
    rr: levels.rr,

    reasons,

    pullback: pullback.reason,

    htf: {
      "12h": tf12.trend,
      "4h": tf4.trend,
      "1h": tf1.trend,
      "15min": tf15.trend,
      "5min": tf5.trend
    },

    liquidity:
      tf15.liquidity,

    fvg:
      tf15.fvg,

    orderBlock:
      tf15.orderBlock,

    structure:
      tf15.structure,

    rsi:
      tf15.momentum.rsi
  };
}

// =========================================================
// DUPLICATE ALERT PROTECTION
// =========================================================

const lastSentSignals = new Map();

function signalKey(
  instrument,
  result
) {
  return [
    instrument.label,
    result.signal,
    result.entry,
    result.stopLoss,
    result.takeProfit
  ].join("|");
}

function shouldSendTelegram(
  instrument,
  result
) {
  if (
    !result ||
    result.signal === "WAIT"
  ) {
    return false;
  }

  const key =
    signalKey(
      instrument,
      result
    );

  const previous =
    lastSentSignals.get(
      instrument.label
    );

  if (previous === key) {
    return false;
  }

  lastSentSignals.set(
    instrument.label,
    key
  );

  return true;
}

// =========================================================
// TELEGRAM
// =========================================================

async function sendTelegram(
  instrument,
  result
) {
  if (
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_CHAT_ID
  ) {
    return false;
  }

  const emoji =
    result.signal === "BUY"
      ? "🟢"
      : "🔴";

  const message = [
    `${emoji} VANTA•9 ${result.confidence} ${result.signal}`,
    "",
    `📌 ${instrument.symbol}`,
    `📍 Entry: ${result.entry}`,
    `🛑 Stop Loss: ${result.stopLoss}`,
    `🎯 Take Profit: ${result.takeProfit}`,
    `📐 R:R: 1:${result.rr}`,
    `⭐ Score: ${result.score}/9`,
    "",
    `📊 12H: ${result.htf["12h"]}`,
    `📊 4H: ${result.htf["4h"]}`,
    `📊 1H: ${result.htf["1h"]}`,
    `📊 15M: ${result.htf["15min"]}`,
    `📊 5M: ${result.htf["5min"]}`,
    "",
    `💧 Liquidity: ${
      result.liquidity.type
    }`,
    `📦 FVG: ${
      result.fvg.direction
    }`,
    `🏦 SMC/OB: ${
      result.orderBlock.direction
    }`,
    `📈 Structure: ${
      result.structure.direction
    }`,
    `💪 RSI: ${
      Number.isFinite(result.rsi)
        ? round(result.rsi, 1)
        : "N/A"
    }`,
    `🛡️ Pullback: PASSED`,
    "",
    `🔎 ${result.reasons.join(
      " • "
    )}`
  ].join("\n");

  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  try {
    const response = await fetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          chat_id:
            TELEGRAM_CHAT_ID,
          text: message
        })
      }
    );

    const data =
      await response.json();

    if (!data.ok) {
      throw new Error(
        data.description ||
          "Telegram request failed"
      );
    }

    state.telegram.lastAlert =
      new Date().toISOString();

    console.log(
      `📨 Telegram alert sent: ${instrument.label} ${result.signal}`
    );

    return true;
  } catch (error) {
    console.error(
      "Telegram error:",
      error.message
    );

    return false;
  }
}

// =========================================================
// FETCH ONE INSTRUMENT
// =========================================================

async function scanInstrument(
  instrument
) {
  const label =
    instrument.label;

  console.log(
    `\n🔍 Scanning ${label}...`
  );

  const candles = {};

  try {
    // IMPORTANT:
    // Requests are SEQUENTIAL.
    // The rate limiter controls the speed.
    for (
      const timeframe of API_TIMEFRAMES
    ) {
      console.log(
        `   ↳ ${label} ${timeframe}`
      );

      candles[timeframe] =
        await twelveData(
          instrument.symbol,
          timeframe
        );

      console.log(
        `   ✓ ${timeframe}: ${candles[timeframe].length} candles`
      );
    }

    // Build synthetic 12H.
    candles["12h"] =
      build12HCandles(
        candles["4h"]
      );

    if (
      candles["12h"].length < 20
    ) {
      throw new Error(
        "Not enough completed synthetic 12H candles"
      );
    }

    const timeframeData = {};

    for (
      const timeframe of DISPLAY_TIMEFRAMES
    ) {
      timeframeData[timeframe] =
        analyzeTimeframe(
          candles[timeframe]
        );
    }

    const latest5 =
      getLast(
        candles["5min"]
      );

    const result =
      buildSignal(
        instrument,
        timeframeData
      );

    state.pairs[label] = {
      symbol: instrument.symbol,
      label,

      status:
        result.signal === "WAIT"
          ? "WAIT"
          : result.signal,

      price:
        latest5
          ? round(
              latest5.close,
              instrument.decimals
            )
          : null,

      signal:
        result.signal,

      score:
        result.score || 0,

      confidence:
        result.confidence || null,

      entry:
        result.entry || null,

      stopLoss:
        result.stopLoss || null,

      takeProfit:
        result.takeProfit || null,

      rr:
        result.rr || null,

      reason:
        result.reason || null,

      reasons:
        result.reasons || [],

      timeframes:
        result.htf || {},

      liquidity:
        result.liquidity || null,

      fvg:
        result.fvg || null,

      orderBlock:
        result.orderBlock || null,

      structure:
        result.structure || null,

      rsi:
        result.rsi || null,

      pullback:
        result.pullback || null,

      lastUpdated:
        new Date().toISOString(),

      error: null
    };

    console.log(
      `   ✅ ${label}: ${result.signal} ${result.score || 0}/9`
    );

    // Telegram only for valid signals.
    if (
      shouldSendTelegram(
        instrument,
        result
      )
    ) {
      await sendTelegram(
        instrument,
        result
      );
    }

    return result;
  } catch (error) {
    console.error(
      `❌ ${label}:`,
      error.message
    );

    state.pairs[label] = {
      ...state.pairs[label],

      status: "OFFLINE",

      error: error.message,

      lastUpdated:
        new Date().toISOString()
    };

    return null;
  }
}

// =========================================================
// FULL SCAN
// =========================================================

async function scanAll() {
  if (state.scanning) {
    console.log(
      "⏭️ Scan already running. Skipping."
    );

    return;
  }

  state.scanning = true;

  const started =
    Date.now();

  console.log(
    "\n================================================"
  );

  console.log(
    "🚀 VANTA•9 SCAN STARTED"
  );

  console.log(
    `⏱️ ${new Date().toISOString()}`
  );

  console.log(
    "================================================"
  );

  try {
    // IMPORTANT:
    // Scan instruments sequentially.
    // This prevents 12 simultaneous API calls.
    for (
      const instrument of INSTRUMENTS
    ) {
      await scanInstrument(
        instrument
      );

      // Small spacing between instruments.
      await sleep(1000);
    }

    state.lastScan =
      new Date().toISOString();

    state.nextScan =
      new Date(
        Date.now() + POLL_MS
      ).toISOString();

    state.apiRequestsLastMinute =
      getRequestsLastMinute();

    const elapsed =
      ((Date.now() - started) /
        1000).toFixed(1);

    console.log(
      `\n✅ VANTA•9 scan completed in ${elapsed}s`
    );

    console.log(
      `📡 API requests in rolling minute: ${getRequestsLastMinute()}/${MAX_REQUESTS_PER_MINUTE}`
    );

    console.log(
      "================================================\n"
    );
  } catch (error) {
    console.error(
      "Fatal scan error:",
      error.message
    );
  } finally {
    state.scanning = false;
  }
}

// =========================================================
// API ROUTES
// =========================================================

app.get(
  "/api/status",
  (req, res) => {
    state.apiRequestsLastMinute =
      getRequestsLastMinute();

    res.json({
      success: true,

      bot: "VANTA•9",

      instruments:
        INSTRUMENTS.map(
          i => i.label
        ),

      displayTimeframes:
        DISPLAY_TIMEFRAMES,

      apiTimeframes:
        API_TIMEFRAMES,

      syntheticTimeframe:
        "12h",

      pollMs:
        POLL_MS,

      apiRateLimit: {
        configured:
          MAX_REQUESTS_PER_MINUTE,

        used:
          state.apiRequestsLastMinute,

        window:
          "rolling 60 seconds"
      },

      ...state
    });
  }
);

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,

      bot: "VANTA•9",

      uptimeSeconds:
        Math.floor(
          process.uptime()
        ),

      time:
        new Date().toISOString(),

      apiConfigured:
        Boolean(API_KEY),

      telegramConfigured:
        Boolean(
          TELEGRAM_BOT_TOKEN &&
          TELEGRAM_CHAT_ID
        ),

      scanning:
        state.scanning
    });
  }
);

app.get(
  "/api/scan",
  async (req, res) => {
    if (state.scanning) {
      return res.status(409).json({
        success: false,
        message:
          "A scan is already running."
      });
    }

    scanAll();

    res.json({
      success: true,
      message:
        "VANTA•9 scan started."
    });
  }
);

// =========================================================
// ERROR HANDLER
// =========================================================

app.use(
  (err, req, res, next) => {
    console.error(err);

    res.status(500).json({
      success: false,
      error:
        "Internal server error"
    });
  }
);

// =========================================================
// START SERVER
// =========================================================

app.listen(
  PORT,
  () => {
    console.log(
      "================================================"
    );

    console.log(
      "🚀 VANTA•9 TRADING BOT ONLINE"
    );

    console.log(
      `🌐 Port: ${PORT}`
    );

    console.log(
      `📊 Instruments: ${INSTRUMENTS.map(
        i => i.label
      ).join(", ")}`
    );

    console.log(
      `⏱️ Timeframes: ${DISPLAY_TIMEFRAMES.join(
        " → "
      )}`
    );

    console.log(
      "🧠 Strategy: VANTA•9"
    );

    console.log(
      "🎯 Minimum Score: 7/9"
    );

    console.log(
      "🛡️ Pullback Protection: ON"
    );

    console.log(
      "📦 FVG: ON"
    );

    console.log(
      "💧 Liquidity Sweep: ON"
    );

    console.log(
      "🏦 SMC / Order Block: ON"
    );

    console.log(
      "📈 BOS: ON"
    );

    console.log(
      `🚦 API Safety Limit: ${MAX_REQUESTS_PER_MINUTE} requests/min`
    );

    console.log(
      `🔔 Telegram: ${
        TELEGRAM_BOT_TOKEN &&
        TELEGRAM_CHAT_ID
          ? "CONFIGURED"
          : "NOT CONFIGURED"
      }`
    );

    console.log(
      "================================================"
    );

    // First scan.
    scanAll();

    // Automatic scans.
    setInterval(
      scanAll,
      POLL_MS
    );
  }
);
