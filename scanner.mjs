// fnothing — Global Scanner PRO (rate-limit safe, Yahoo crypto fallback)
// Stocks: Yahoo (1d), Crypto: Yahoo 60m fallback (umgeht Binance 451)
// Prescore gate + MAX_AI to avoid 429; retry/backoff on 429; BRK.B -> BRK-B fix.

import fs from "fs";

// ---------- Config & Env ----------
const conf = readJson("./config.json");
const SCORE_THRESHOLD = numEnv("SCORE_THRESHOLD", conf.scoreThreshold ?? 72);
const QUIET_TZ       = process.env.QUIET_TZ   || conf.quiet?.tz   || "Europe/Berlin";
const QUIET_START    = numEnv("QUIET_START",  conf.quiet?.start ?? 23);
const QUIET_END      = numEnv("QUIET_END",    conf.quiet?.end   ?? 6);
const DEDUPE_HOURS   = numEnv("DEDUPE_HOURS", conf.dedupeHours ?? 6);
const CONCURRENCY    = numEnv("CONCURRENCY",  conf.concurrency ?? 4);
const MAX_HEADLINES  = numEnv("MAX_HEADLINES",conf.maxHeadlines ?? 4);

// --- NEU: Gate & Limit für KI ---
const AI_GATE        = numEnv("AI_GATE", 58);     // min. Prescore damit KI gerufen wird
const MAX_AI         = numEnv("MAX_AI",  12);     // max. Anzahl KI-Bewertungen pro Run

const OPENAI_API_KEY     = process.env.OPENAI_API_KEY;
const ONESIGNAL_REST_KEY = process.env.ONESIGNAL_REST_KEY;
const ONESIGNAL_APP_ID   = process.env.ONESIGNAL_APP_ID;
if (!OPENAI_API_KEY || !ONESIGNAL_REST_KEY || !ONESIGNAL_APP_ID) {
  console.error("Missing one of: OPENAI_API_KEY, ONESIGNAL_REST_KEY, ONESIGNAL_APP_ID");
  process.exit(1);
}

const universe  = readJson("./universe.json");
const statePath = new URL("./state.json", import.meta.url);

// ensure reports dir exists
const reportsDir = new URL("./reports", import.meta.url);
try { fs.mkdirSync(reportsDir, { recursive: true }); } catch {}

let state = {}; try { state = JSON.parse(fs.readFileSync(statePath)); } catch { state = {}; }
const report = { startedAt: new Date().toISOString(), items: [] };

// ---------- Utils ----------
function readJson(p){ return JSON.parse(fs.readFileSync(new URL(p, import.meta.url))); }
function numEnv(name, def){ const v = process.env[name]; return v==null? def : Number(v); }
const avg = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0;
const std = a => { const m=avg(a); return Math.sqrt(avg(a.map(v => (v-m)*(v-m)))); };
function seriesEMA(arr, n){ const out=[], k=2/(n+1); let e=arr[0]; for (let i=0;i<arr.length;i++){ const v=arr[i]; e = (i? v*k + e*(1-k) : v); out.push(e);} return out; }
function rsi(arr, p=14){ const d=[]; for (let i=1;i<arr.length;i++) d.push(arr[i]-arr[i-1]);
  const gains=d.map(x=>Math.max(x,0)), losses=d.map(x=>Math.max(-x,0));
  let ag=avg(gains.slice(0,p)), al=avg(losses.slice(0,p));
  for (let i=p;i<d.length;i++){ ag=(ag*(p-1)+gains[i])/p; al=(al*(p-1)+losses[i])/p; }
  const rs = al ? ag/al : 1e9; return 100 - 100/(1+rs);
}
function linSlope(arr, n){ const a=arr.slice(-n); const m=avg(a); const xs=Array.from({length:a.length},(_,i)=>i+1);
  const xm=avg(xs); let num=0, den=0; for (let i=0;i<a.length;i++){ num+=(xs[i]-xm)*(a[i]-m); den+=(xs[i]-xm)**2; } return num/(den||1);
}
const pct = (a,b) => b ? (100*(a-b)/b) : 0;
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const num = x => Math.round((x??0)*100)/100;

function inQuietHours(){
  const hour = new Date(new Date().toLocaleString("en-US",{ timeZone: QUIET_TZ })).getHours();
  return (QUIET_START <= QUIET_END) ? (hour>=QUIET_START && hour<QUIET_END) : (hour>=QUIET_START || hour<QUIET_END);
}
async function fetchJSON(url, headers={}){ const r=await fetch(url,{headers}); if(!r.ok) throw new Error(`HTTP ${r.status} for ${url}`); return r.json(); }
async function fetchText(url, headers={}){ const r=await fetch(url,{headers}); if(!r.ok) throw new Error(`HTTP ${r.status} for ${url}`); return r.text(); }

// ---------- Data sources ----------
const PAIR_TO_YF = { // Binance → Yahoo Crypto
  BTCUSDT:"BTC-USD", ETHUSDT:"ETH-USD", SOLUSDT:"SOL-USD", BNBUSDT:"BNB-USD",
  XRPUSDT:"XRP-USD", ADAUSDT:"ADA-USD", MATICUSDT:"MATIC-USD", AVAXUSDT:"AVAX-USD",
  LINKUSDT:"LINK-USD", ATOMUSDT:"ATOM-USD", DOGEUSDT:"DOGE-USD", ARBUSDT:"ARB-USD",
  OPUSDT:"OP-USD", APTUSDT:"APT-USD", LTCUSDT:"LTC-USD"
};
const yfFix = s => s.replace(/\./g, "-"); // BRK.B -> BRK-B

async function yahooChartDaily(symbol){ // stocks 1y/1d
  const yf = yfFix(symbol);
  return fetchJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yf)}?range=1y&interval=1d`);
}
async function yahooChart60mCrypto(ySymbol){ // crypto 60m/60d
  return fetchJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySymbol)}?range=60d&interval=60m`);
}
async function yahooQuoteSummary(symbol){
  try { return await fetchJSON(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yfFix(symbol))}?modules=defaultKeyStatistics,financialData`); }
  catch { return null; }
}
async function binanceKlines1h(pair){ const sym = pair.replace(/^BINANCE:/,""); return fetchJSON(`https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(sym)}&interval=1h&limit=300`); }

async function newsFor(q){
  if (MAX_HEADLINES <= 0) return [];
  const urls = [
    `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en&gl=US&ceid=US:en`,
    `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(q)}&region=US&lang=en-US`
  ];
  let titles=[];
  for (const u of urls){
    try {
      const xml = await fetchText(u, {"User-Agent":"fnothing-bot"});
      const items = [...xml.matchAll(/<item>[\s\S]*?<title><!\[CDATA\[(.*?)\]\]><\/title>[\s\S]*?<link>(.*?)<\/link>/g)]
        .map(m => `${m[1].replace(/&amp;/g,"&")} — ${m[2]}`);
      titles.push(...items);
    } catch {}
  }
  const seen = new Set(); const out=[];
  for (const t of titles){ const k=t.split(" — ")[0]; if(!seen.has(k)){ seen.add(k); out.push(t); } }
  return out.slice(0, MAX_HEADLINES);
}

// ---------- Benchmarks (RS) ----------
let benchSPY=null, benchBTC=null;
async function loadBenchmarks(){
  try { const j = await yahooChartDaily("SPY"); benchSPY = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(x=>typeof x==="number")||null; } catch {}
  try { const j = await yahooChart60mCrypto("BTC-USD"); benchBTC = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(x=>typeof x==="number")||null; } catch {}
}

// ---------- Feature builders ----------
function stockFeatures(chartJson){
  const r = chartJson?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0] || {};
  const closes = (q.close||[]).filter(v=>typeof v==="number");
  const highs  = (q.high ||[]).filter(v=>typeof v==="number");
  const lows   = (q.low  ||[]).filter(v=>typeof v==="number");
  const vols   = (q.volume||[]).filter(v=>typeof v==="number");
  const recent = closes.slice(-220);
  const price  = recent.at(-1);
  const sma20  = avg(recent.slice(-20)),  sma50 = avg(recent.slice(-50)),  sma200 = avg(recent.slice(-200));
  const ema12v = seriesEMA(recent,12),    ema26v = seriesEMA(recent,26);
  const macdS  = ema12v.map((v,i)=> v - ema26v[i]);  const macdLine = macdS.at(-1), macdSignal = seriesEMA(macdS.slice(-35), 9).at(-1);
  const rsi14  = rsi(recent,14);
  const std20  = std(recent.slice(-20));  const bbUpper=sma20+2*std20, bbLower=sma20-2*std20;
  const hi52   = Math.max(...recent),     lo52    = Math.min(...recent);
  const proximityHi = pct(price, hi52),   proximityLo = pct(price, lo52);
  const vol20  = avg(vols.slice(-20));    const volSpike = vols.at(-1)&&vol20 ? vols.at(-1)/vol20 : null;
  const slope50= linSlope(recent.slice(-60), 60);

  // RS vs SPY
  let rs20 = null;
  if (benchSPY && benchSPY.length>20 && recent.length>20){
    const rAsset = recent.at(-1) / recent[ -21 ];
    const rSpy   = benchSPY.at(-1) / benchSPY[ -21 ];
    rs20 = rAsset - rSpy;
  }
  return { price,sma20,sma50,sma200,macdLine,macdSignal,rsi14,bbUpper,bbLower,proximityHi,proximityLo,volSpike,slope50,rs20 };
}

function cryptoFeatures(closes){
  const recent = closes.slice(-220);
  const price  = recent.at(-1);
  const sma20  = avg(recent.slice(-20)),  sma50 = avg(recent.slice(-50)),  sma200 = avg(recent.slice(-200));
  const ema12v = seriesEMA(recent,12),    ema26v = seriesEMA(recent,26);
  const macdS  = ema12v.map((v,i)=> v - ema26v[i]);  const macdLine = macdS.at(-1), macdSignal = seriesEMA(macdS.slice(-35), 9).at(-1);
  const rsi14  = rsi(recent,14);
  const std20  = std(recent.slice(-20));  const bbUpper=sma20+2*std20, bbLower=sma20-2*std20;
  const hi     = Math.max(...recent),     lo     = Math.min(...recent);
  const proximityHi = pct(price, hi),     proximityLo = pct(price, lo);
  const slope50= linSlope(recent.slice(-60), 60);

  // RS vs BTC (60m)
  let rs20 = null;
  if (benchBTC && benchBTC.length>20 && recent.length>20){
    const rAsset = recent.at(-1) / recent[ -21 ];
    const rBtc   = benchBTC.at(-1) / benchBTC[ -21 ];
    rs20 = rAsset - rBtc;
  }
  return { price,sma20,sma50,sma200,macdLine,macdSignal,rsi14,bbUpper,bbLower,proximityHi,proximityLo,slope50,rs20 };
}

function preScore(f){
  let s=0;
  if (f.price > f.sma200) s+=20; else s-=10;
  if (f.price > f.sma50)  s+=15;
  if (f.rsi14 && f.rsi14>50 && f.rsi14<70) s+=10;
  if (f.macdLine && f.macdSignal && f.macdLine>f.macdSignal) s+=10;
  if (f.proximityHi !== null && f.proximityHi>-1.5) s+=15;
  if (f.slope50 && f.slope50>0) s+=5;
  if (typeof f.volSpike === "number" && f.volSpike>1.4) s+=10;
  if (typeof f.rs20   === "number" && f.rs20>0) s+=5;
  return Math.max(0, Math.min(100, s));
}

// ---------- Data pipelines ----------
async function stockStage(symbol){
  try{
    const chart = await yahooChartDaily(symbol);
    const f = stockFeatures(chart);
    const fundamentals = await fetchFundamentals(symbol);
    const headlines = await newsFor(symbol+" stock");
    const ps = preScore(f);
    return { ok:true, type:"stock", symbol, features:f, fundamentals, headlines, preScore: ps };
  }catch(e){ return { ok:false, type:"stock", symbol, error:String(e) }; }
}

async function cryptoStage(symbol){ // symbol like BINANCE:BTCUSDT
  try{
    const pair = symbol.replace(/^BINANCE:/,"");
    const yf = PAIR_TO_YF[pair];
    let closes = [];
    if (yf){
      const j = await yahooChart60mCrypto(yf);
      closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(x=>typeof x==="number") || [];
    }
    // fallback: try binance if yahoo empty
    if (!closes.length){
      const kl = await binanceKlines1h(symbol);
      closes = kl.map(k=>Number(k[4])).filter(Number.isFinite);
    }
    const f = cryptoFeatures(closes);
    const ps = preScore(f);
    return { ok:true, type:"crypto", symbol, features:f, fundamentals:null, headlines:[], preScore: ps };
  }catch(e){ return { ok:false, type:"crypto", symbol, error:String(e) }; }
}

async function fetchFundamentals(symbol){
  try {
    const q = await yahooQuoteSummary(symbol);
    const f = q?.quoteSummary?.result?.[0] || {};
    const fin  = f.financialData || {};
    const stats= f.defaultKeyStatistics || {};
    return {
      pe: fin?.trailingPE?.raw ?? stats?.trailingPE?.raw ?? null,
      roe: fin?.returnOnEquity?.raw ?? null,
      grossMargins:  fin?.grossMargins?.raw ?? null,
      profitMargins: fin?.profitMargins?.raw ?? null,
      revenueGrowth: fin?.revenueGrowth?.raw ?? null
    };
  } catch { return null; }
}

// ---------- OpenAI judge with 429 backoff ----------
async function judgeWithRetry(payload, maxRetry=4){
  const sys = "You are an investment research assistant. Decide if this is a timely opportunity. Consider technicals, trend, relative strength and news. Be concise, no financial advice. Return strict JSON only: {\"decision\":\"push|hold\",\"score\":0-100,\"confidence\":0-1,\"risk\":\"low|medium|high\",\"reason\":\"<=300 chars\",\"tags\":[...]}";
  const body = {
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role:"system", content: sys },
      { role:"user", content: JSON.stringify(payload) }
    ]
  };

  for (let attempt=0; attempt<=maxRetry; attempt++){
    const r = await fetch("https://api.openai.com/v1/chat/completions",{
      method:"POST",
      headers:{ "Authorization":`Bearer ${OPENAI_API_KEY}`, "Content-Type":"application/json" },
      body: JSON.stringify(body)
    });
    if (r.ok){
      const j = await r.json();
      const txt = j?.choices?.[0]?.message?.content || "{}";
      try { return JSON.parse(txt); } catch { return { decision:"hold", score:0, reason:"AI parse fail", confidence:0.2, risk:"medium", tags:["parse"] }; }
    }
    if (r.status === 429 && attempt < maxRetry){
      const ra = Number(r.headers.get("retry-after") || 0);
      const delay = (ra ? ra*1000 : (800 + attempt*600));
      await sleep(delay);
      continue;
    }
    throw new Error("OpenAI "+r.status);
  }
}

// ---------- Push ----------
async function push(symbol, ai){
  const body = {
    app_id: ONESIGNAL_APP_ID,
    filters: [{ field:"tag", key:"signals", relation:"=", value:"true" }],
    headings: { en: `Opportunity: ${symbol} — ${ai.score}` },
    contents: { en: ai.reason },
    url: "https://fnothing.com/"
  };
  const rest = ONESIGNAL_REST_KEY || "";
  const authHeader = rest.startsWith("os_") ? `key ${rest}` : `Basic ${rest}`; // v2 & legacy
  const r = await fetch("https://onesignal.com/api/v1/notifications",{
    method:"POST",
    headers:{ "Authorization": authHeader, "Content-Type":"application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error("OneSignal "+r.status);
}

async function maybePush(symbol, ai){
  if (!ai || ai.decision!=="push" || (ai.score??0)<SCORE_THRESHOLD) return;
  if (inQuietHours()) return;
  const last = state[`pushed:${symbol}`] || 0;
  const now  = Date.now();
  if (now - last < DEDUPE_HOURS*3600*1000) return;
  await push(symbol, ai);
  state[`pushed:${symbol}`] = now;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// ---------- Runner ----------
async function pRun(items, limit, fn){
  const q = items.slice(); const workers = Array.from({length: Math.min(limit, q.length)}, async () => {
    while(q.length){ const x = q.shift(); try { await fn(x); } catch(e){ console.error(e); } }
  });
  await Promise.all(workers);
}

async function main(){
  await loadBenchmarks();

  // 1) STAGE 1: Features/Prescore (kein KI)
  const stageTasks = [
    ...universe.stocks.map(s => () => stockStage(s)),
    ...universe.crypto.map(c => () => cryptoStage(c))
  ];
  const stageResults = [];
  await pRun(stageTasks, CONCURRENCY, async fn => { stageResults.push(await fn()); });

  // alles in Report aufnehmen
  for (const r of stageResults){
    if (!r.ok){ report.items.push({ type:r.type, symbol:r.symbol, error:r.error }); }
    else { report.items.push({ type:r.type, symbol:r.symbol, features:r.features, fundamentals:r.fundamentals, preScore:r.preScore }); }
  }

  // 2) Filter: nur gute Prescores → KI, Top N
  const candidates = stageResults.filter(r => r.ok && r.preScore >= AI_GATE);
  candidates.sort((a,b)=> b.preScore - a.preScore);
  const selected = candidates.slice(0, MAX_AI);

  // 3) KI + Push für selected
  for (const it of selected){
    try{
      const payload = {
        type: it.type, symbol: it.symbol,
        features: it.features,
        fundamentals: it.fundamentals || null,
        headlines: it.headlines || [],
        preScore: it.preScore
      };
      const ai = await judgeWithRetry(payload);
      // Ergänze ins Report
      const idx = report.items.findIndex(x => x.symbol===it.symbol && x.type===it.type);
      if (idx>=0) report.items[idx].ai = ai;

      await maybePush(it.symbol, ai);
    }catch(e){
      const idx = report.items.findIndex(x => x.symbol===it.symbol && x.type===it.type);
      if (idx>=0) report.items[idx].error = String(e);
    }
  }

  // 4) Save reports
  const stamp = new Date().toISOString().replace(/[:.]/g,"-");
  fs.writeFileSync(new URL(`./reports/run-${stamp}.json`, import.meta.url), JSON.stringify(report, null, 2));
  fs.writeFileSync(new URL(`./reports/latest.json`, import.meta.url), JSON.stringify(report, null, 2));
  console.log("scan done", { total: stageResults.length, aiSelected: selected.length });
}

await main();
