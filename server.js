const express = require("express");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

const API_KEY = process.env.TWELVE_DATA_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Default = 15 minutes.
// Increase this if Twelve Data gives HTTP 429.
const POLL_MS = Math.max(
  300000,
  Number(process.env.POLL_MS || 900000)
);

// Minimum score required.
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

const TIMEFRAMES = [
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

// =========================================================
// HELPERS
// =========================================================

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

// =========================================================
// TWELVE DATA
// =========================================================

async function twelveData(endpoint, params) {
  if (!API_KEY) {
    throw new Error("TWELVE_DATA_API_KEY is missing");
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

// =========================================================
// CANDLE DATA
// =========================================================

async function getCandles(symbol, interval, outputsize = 120) {
  const data = await twelveData("time_series", {
    symbol,
    interval,
    outputsize: String(outputsize),
    order: "ASC",
    timezone: "UTC"
  });

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

// =========================================================
// EMA
// =========================================================

function ema(values, period) {
  if (!values.length) return null;

  const multiplier = 2 / (period + 1);

  let result = values[0];

  for (let i = 1; i < values.length; i++) {
    result =
      values[i] * multiplier +
      result * (1 - multiplier);
  }

  return result;
}

// =========================================================
// RSI
// =========================================================

function rsi(values, period = 14) {
  if (values.length < period + 1) {
    return 50;
  }

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change >= 0) {
      gain += change;
    } else {
      loss -= change;
    }
  }

  let averageGain = gain / period;
  let averageLoss = loss / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const change = values[i] - values[i - 1];

    averageGain =
      ((averageGain * (period - 1)) +
        Math.max(change, 0)) /
      period;

    averageLoss =
      ((averageLoss * (period - 1)) +
        Math.max(-change, 0)) /
      period;
  }

  if (averageLoss === 0) {
    return 100;
  }

  return (
    100 -
    100 /
      (1 + averageGain / averageLoss)
  );
}

// =========================================================
// ATR
// =========================================================

function atr(candles, period = 14) {
  if (candles.length < period + 1) {
    return null;
  }

  const trueRanges = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const tr = Math.max(
      current.high - current.low,
      Math.abs(
        current.high - previous.close
      ),
      Math.abs(
        current.low - previous.close
      )
    );

    trueRanges.push(tr);
  }

  const recent = trueRanges.slice(-period);

  return (
    recent.reduce(
      (sum, value) => sum + value,
      0
    ) / recent.length
  );
}

// =========================================================
// TREND
// =========================================================

function getTrend(candles) {
  const closes = candles.map(c => c.close);

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);

  const last = closes.at(-1);

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

// =========================================================
// MARKET STRUCTURE / BOS
// =========================================================

function getStructure(candles) {
  if (candles.length < 15) {
    return "NEUTRAL";
  }

  const last = candles.at(-1);
  const previous = candles.at(-2);

  const reference = candles.slice(-14, -2);

  const previousHigh = Math.max(
    ...reference.map(c => c.high)
  );

  const previousLow = Math.min(
    ...reference.map(c => c.low)
  );

  if (
    last.close > previousHigh &&
    last.close > previous.close
  ) {
    return "BULLISH BOS";
  }

  if (
    last.close < previousLow &&
    last.close < previous.close
  ) {
    return "BEARISH BOS";
  }

  if (last.close > previous.close) {
    return "BULLISH";
  }

  if (last.close < previous.close) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

// =========================================================
// LIQUIDITY SWEEP
// =========================================================

function detectLiquidity(candles) {
  if (candles.length < 18) {
    return "NONE";
  }

  const last = candles.at(-1);

  const previousRange =
    candles.slice(-17, -2);

  const rangeHigh = Math.max(
    ...previousRange.map(c => c.high)
  );

  const rangeLow = Math.min(
    ...previousRange.map(c => c.low)
  );

  // Price swept sell-side liquidity
  // then closed back above it.
  if (
    last.low < rangeLow &&
    last.close > rangeLow
  ) {
    return "SELL-SIDE SWEEP";
  }

  // Price swept buy-side liquidity
  // then closed back below it.
  if (
    last.high > rangeHigh &&
    last.close < rangeHigh
  ) {
    return "BUY-SIDE SWEEP";
  }

  return "NONE";
}

// =========================================================
// FAIR VALUE GAP
// =========================================================

function detectFVG(candles) {
  if (candles.length < 4) {
    return {
      type: "NONE",
      zone: null,
      distance: null
    };
  }

  const a = candles.at(-3);
  const b = candles.at(-2);
  const c = candles.at(-1);

  // Bullish 3-candle imbalance.
  if (a.high < c.low) {
    return {
      type: "BULLISH FVG",
      zone: [a.high, c.low],
      distance: Math.min(
        Math.abs(c.close - a.high),
        Math.abs(c.close - c.low)
      )
    };
  }

  // Bearish 3-candle imbalance.
  if (a.low > c.high) {
    return {
      type: "BEARISH FVG",
      zone: [c.high, a.low],
      distance: Math.min(
        Math.abs(c.close - c.high),
        Math.abs(c.close - a.low)
      )
    };
  }

  return {
    type: "NONE",
    zone: null,
    distance: null
  };
}

// =========================================================
// ORDER BLOCK / SMC
// =========================================================

function detectOrderBlock(candles, side) {
  const lookback = candles.slice(-12, -2);

  if (side === "BUY") {
    const bearishCandle = [...lookback]
      .reverse()
      .find(c => c.close < c.open);

    if (!bearishCandle) {
      return null;
    }

    return {
      type: "BULLISH ORDER BLOCK",
      low: bearishCandle.low,
      high: bearishCandle.high
    };
  }

  const bullishCandle = [...lookback]
    .reverse()
    .find(c => c.close > c.open);

  if (!bullishCandle) {
    return null;
  }

  return {
    type: "BEARISH ORDER BLOCK",
    low: bullishCandle.low,
    high: bullishCandle.high
  };
}

// =========================================================
// TIMEFRAME ANALYSIS
// =========================================================

function analyzeTimeframe(candles) {
  const closes = candles.map(c => c.close);

  return {
    trend: getTrend(candles),
    structure: getStructure(candles),
    rsi: round(rsi(closes), 1),
    ema20: round(ema(closes, 20), 8),
    ema50: round(ema(closes, 50), 8),
    atr: round(atr(candles), 8),
    last: candles.at(-1).close
  };
}

// =========================================================
// SIGNAL ENGINE
// =========================================================

function buildSignal(all, meta) {
  const t12 = analyzeTimeframe(all["12h"]);
  const t4 = analyzeTimeframe(all["4h"]);
  const t1 = analyzeTimeframe(all["1h"]);
  const t15 = analyzeTimeframe(all["15min"]);
  const t5 = analyzeTimeframe(all["5min"]);

  const candles5 = all["5min"];

  const last = candles5.at(-1);

  const currentATR =
    t5.atr ||
    Math.abs(last.high - last.low) ||
    last.close * 0.001;

  const liquidity =
    detectLiquidity(candles5);

  const fvg =
    detectFVG(candles5);

  // -------------------------------------------------------
  // TOP-DOWN DIRECTION
  // -------------------------------------------------------

  const bullishHTF =
    t12.trend === "BULLISH" &&
    t4.trend === "BULLISH" &&
    t1.trend !== "BEARISH";

  const bearishHTF =
    t12.trend === "BEARISH" &&
    t4.trend === "BEARISH" &&
    t1.trend !== "BULLISH";

  // -------------------------------------------------------
  // DIRECTIONAL CHECKS
  // -------------------------------------------------------

  const buyChecks = [];
  const sellChecks = [];

  function check(
    name,
    buy,
    sell,
    detail
  ) {
    buyChecks.push(Boolean(buy));
    sellChecks.push(Boolean(sell));

    checks.push({
      name,
      buy: Boolean(buy),
      sell: Boolean(sell),
      detail
    });
  }

  const checks = [];

  // 1. HTF trend
  check(
    "HTF Trend",
    bullishHTF,
    bearishHTF,
    `${t12.trend} / ${t4.trend}`
  );

  // 2. Liquidity
  check(
    "Liquidity Grab",
    liquidity === "SELL-SIDE SWEEP",
    liquidity === "BUY-SIDE SWEEP",
    liquidity
  );

  // 3. BOS
  check(
    "Market Structure / BOS",
    t5.structure.includes("BULLISH"),
    t5.structure.includes("BEARISH"),
    t5.structure
  );

  // 4. FVG
  check(
    "Fair Value Gap",
    fvg.type === "BULLISH FVG",
    fvg.type === "BEARISH FVG",
    fvg.type
  );

  // 5. SMC / Order Block
  const bullishOB =
    detectOrderBlock(candles5, "BUY");

  const bearishOB =
    detectOrderBlock(candles5, "SELL");

  check(
    "SMC / Order Block",
    Boolean(bullishOB) && bullishHTF,
    Boolean(bearishOB) && bearishHTF,
    "Order-block context"
  );

  // 6. RSI momentum
  check(
    "Momentum / RSI",
    t5.rsi >= 52 && t5.rsi <= 68,
    t5.rsi <= 48 && t5.rsi >= 32,
    `RSI ${t5.rsi}`
  );

  // 7. Entry timeframe alignment
  check(
    "Entry Timeframe",
    t15.trend === "BULLISH" &&
      t5.trend === "BULLISH",
    t15.trend === "BEARISH" &&
      t5.trend === "BEARISH",
    `${t15.trend} → ${t5.trend}`
  );

  // -------------------------------------------------------
  // PROVISIONAL DIRECTION
  // -------------------------------------------------------

  const preliminaryBuy =
    buyChecks.filter(Boolean).length;

  const preliminarySell =
    sellChecks.filter(Boolean).length;

  const provisionalSide =
    preliminaryBuy >= preliminarySell
      ? "BUY"
      : "SELL";

  // -------------------------------------------------------
  // ORDER BLOCK
  // -------------------------------------------------------

  const orderBlock =
    provisionalSide === "BUY"
      ? bullishOB
      : bearishOB;

  // -------------------------------------------------------
  // ENTRY
  // -------------------------------------------------------

  const entry = last.close;

  let stopLoss;
  let takeProfit;

  if (provisionalSide === "BUY") {
    stopLoss = orderBlock
      ? Math.min(
          last.low - currentATR * 0.20,
          orderBlock.low -
            currentATR * 0.10
        )
      : last.low -
        currentATR * 0.40;

    const risk =
      entry - stopLoss;

    takeProfit =
      entry + risk * 2;
  } else {
    stopLoss = orderBlock
      ? Math.max(
          last.high + currentATR * 0.20,
          orderBlock.high +
            currentATR * 0.10
        )
      : last.high +
        currentATR * 0.40;

    const risk =
      stopLoss - entry;

    takeProfit =
      entry - risk * 2;
  }

  const risk =
    Math.abs(entry - stopLoss);

  const reward =
    Math.abs(takeProfit - entry);

  const rr =
    risk > 0
      ? reward / risk
      : 0;

  // -------------------------------------------------------
  // 8. R:R
  // -------------------------------------------------------

  const rrPass = rr >= 2;

  checks.push({
    name: "Risk / Reward",
    buy:
      provisionalSide === "BUY"
        ? rrPass
        : false,
    sell:
      provisionalSide === "SELL"
        ? rrPass
        : false,
    detail: `R:R 1:${round(rr, 1)}`
  });

  // -------------------------------------------------------
  // PULLBACK / LATE ENTRY PROTECTION
  // -------------------------------------------------------

  const emaDistance =
    Math.abs(
      entry - t5.ema20
    );

  const extension =
    emaDistance /
    Math.max(currentATR, 1e-9);

  const notOverextended =
    extension <= 1.35;

  const RSIOverbought =
    provisionalSide === "BUY" &&
    t5.rsi > 70;

  const RSIOversold =
    provisionalSide === "SELL" &&
    t5.rsi < 30;

  const pullbackSafe =
    notOverextended &&
    !RSIOverbought &&
    !RSIOversold;

  checks.push({
    name: "Pullback Protection",
    buy:
      provisionalSide === "BUY"
        ? pullbackSafe
        : false,
    sell:
      provisionalSide === "SELL"
        ? pullbackSafe
        : false,
    detail: pullbackSafe
      ? "Entry timing acceptable"
      : "WAIT: entry too extended"
  });

  // -------------------------------------------------------
  // FINAL SCORE
  // -------------------------------------------------------

  const buyScore =
    checks.filter(c => c.buy).length;

  const sellScore =
    checks.filter(c => c.sell).length;

  const score =
    Math.max(
      buyScore,
      sellScore
    );

  const finalSide =
    buyScore >= sellScore
      ? "BUY"
      : "SELL";

  const finalAlignment =
    finalSide === "BUY"
      ? bullishHTF
      : bearishHTF;

  const finalPullback =
    finalSide === "BUY"
      ? pullbackSafe
      : pullbackSafe;

  const valid =
    score >= MIN_SCORE &&
    finalAlignment &&
    rrPass &&
    finalPullback;

  const result =
    valid
      ? finalSide
      : "WAIT";

  // -------------------------------------------------------
  // GRADE
  // -------------------------------------------------------

  let grade = "WAIT";

  if (result !== "WAIT") {
    if (score >= 9) {
      grade = "ELITE";
    } else if (score >= 8) {
      grade = "STRONG";
    } else {
      grade = "VALID";
    }
  }

  return {
    result,

    grade,

    score,

    confidence: Math.round(
      clamp(
        (score / 9) * 100,
        0,
        100
      )
    ),

    side:
      result === "WAIT"
        ? finalSide
        : result,

    entry:
      result === "WAIT"
        ? null
        : round(
            entry,
            meta.decimals
          ),

    stopLoss:
      result === "WAIT"
        ? null
        : round(
            stopLoss,
            meta.decimals
          ),

    takeProfit:
      result === "WAIT"
        ? null
        : round(
            takeProfit,
            meta.decimals
          ),

    rr: round(rr, 2),

    trend: {
      "12h": t12.trend,
      "4h": t4.trend,
      "1h": t1.trend,
      "15min": t15.trend,
      "5min": t5.trend
    },

    timeframes: {
      "12h": t12,
      "4h": t4,
      "1h": t1,
      "15min": t15,
      "5min": t5
    },

    liquidity,

    fvg,

    orderBlock,

    structure:
      t5.structure,

    checks,

    lastPrice:
      round(
        last.close,
        meta.decimals
      ),

    scannedAt:
      new Date().toISOString()
  };
}

// =========================================================
// TELEGRAM
// =========================================================

async function sendTelegram(message) {
  if (
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_CHAT_ID
  ) {
    return;
  }

  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const response = await fetch(url, {
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
  });

  if (!response.ok) {
    throw new Error(
      `Telegram HTTP ${response.status}`
    );
  }
}

// =========================================================
// TELEGRAM SIGNAL
// =========================================================

async function notifySignal(meta, signal) {
  if (signal.result === "WAIT") {
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

  // Don't repeatedly send the exact same signal.
  if (
    state.lastAlertKey[meta.label] === key
  ) {
    return;
  }

  state.lastAlertKey[meta.label] = key;

  const emoji =
    signal.result === "BUY"
      ? "🟢"
      : "🔴";

  const title =
    signal.grade === "ELITE"
      ? "🚨 ELITE"
      : signal.grade === "STRONG"
      ? "🚨 STRONG"
      : "⚡ VALID";

  const message = [
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
    `🏦 SMC: ${signal.orderBlock?.type || "NONE"}`,
    `📈 Structure: ${signal.structure}`,
    "",
    "VANTA•9 — Strict Entry System"
  ].join("\n");

  try {
    await sendTelegram(message);
  } catch (error) {
    console.error(
      "Telegram error:",
      error.message
    );
  }
}

// =========================================================
// SCAN ONE INSTRUMENT
// =========================================================

async function scanInstrument(meta) {
  const all = {};

  for (const timeframe of TIMEFRAMES) {
    try {
      all[timeframe] =
        await getCandles(
          meta.symbol,
          timeframe,
          120
        );

      // Small delay to reduce burst requests.
      await sleep(250);
    } catch (error) {
      throw new Error(
        `${meta.label} ${timeframe}: ${error.message}`
      );
    }
  }

  return buildSignal(all, meta);
}

// =========================================================
// FULL SCAN
// =========================================================

async function scanAll() {
  if (state.scanning) {
    return;
  }

  state.scanning = true;

  try {
    for (const meta of INSTRUMENTS) {
      try {
        const signal =
          await scanInstrument(meta);

        state.pairs[meta.label] =
          signal;

        await notifySignal(
          meta,
          signal
        );

        // Delay between instruments.
        await sleep(500);
      } catch (error) {
        console.error(
          `${meta.label}:`,
          error.message
        );

        state.pairs[meta.label] = {
          result: "OFFLINE",
          error: error.message,
          scannedAt:
            new Date().toISOString()
        };
      }
    }

    state.updatedAt =
      new Date().toISOString();
  } finally {
    state.scanning = false;
  }
}

// =========================================================
// API
// =========================================================

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,
      service:
        "VANTA-9 Trading Bot",
      time:
        new Date().toISOString()
    });
  }
);

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
        MIN_SCORE
    });
  }
);

// =========================================================
// START SERVER
// =========================================================

app.listen(PORT, () => {
  console.log(
    `VANTA•9 running on port ${PORT}`
  );

  console.log(
    `Monitoring: ${INSTRUMENTS
      .map(x => x.label)
      .join(", ")}`
  );

  console.log(
    `Timeframes: ${TIMEFRAMES.join(", ")}`
  );

  console.log(
    `Minimum score: ${MIN_SCORE}/9`
  );

  console.log(
    `Scan interval: ${POLL_MS / 60000} minutes`
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

  // Initial scan.
  scanAll();

  // Continue scanning.
  setInterval(
    scanAll,
    POLL_MS
  );
});
