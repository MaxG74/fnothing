// fnothing — Global Scanner PRO (GitHub Actions, Node 20)
// Stocks (Yahoo 1D), Crypto (Binance 1h), advanced indicators computed locally,
// multi-source news (Google News + Yahoo Finance RSS), numeric pre-score,
// OpenAI judge → OneSignal push, Quiet Hours, De-Dupe, JSON-Reports.
//
// Env Secrets: OPENAI_API_KEY, ONESIGNAL_REST_KEY, ONESIGNAL_APP_ID
// Optional Env Vars: SCORE_THRESHOLD, QUIET_TZ, QUIET_START, QUIET_END, DEDUPE_HOURS, CONCURRENCY, MAX_HEADLINES
// Files: universe.json, config.json

import fs from "fs";

// ---- config / env ----
const conf = JSON.parse(fs.readFileSync(new URL("./config.json", import.meta.url)));
const SCORE_THRESHOLD = Number(process.env.SCORE_THRESHOLD || conf.scoreThreshold || 70);
const QUIET_TZ       = process.env.QUIET_TZ   || conf.quiet?.tz   || "Europe/Berlin";
const QUIET_START    = Number(process.env.QUIET_START || conf.quiet?.start || 23);
const QUIET_END      = Number(process.env.QUIET_END   || conf.quiet?.end   || 6);
const DEDUPE_HOURS   = Number(process.env.DEDUPE_HOURS || conf.dedupeHours || 6);
const CONCURRENCY    = Number(process.env.CONCURRENCY || conf.concurrency  || 4);
const MAX_HEADLINES  = Number(process.env.MAX_HEADLINES || conf.maxHeadlines || 4);

const OPENAI_API_KEY     = process.env.OPENAI_API_KEY;
const ONESIGNAL_REST_KEY = process.env.ONESIGNAL_REST_KEY;
const ONESIGNAL_APP_ID   = process.env.ONESIGNAL_APP_ID;
if (!OPENAI_API_KEY || !ONESIGNAL_REST_KEY || !ONESIGNAL_APP_ID) {
  console.error("Missing one of: OPENAI_API_KEY, ONESIGNAL_REST_KEY, ONESIGNAL_APP_ID");
  process.exit(1);
}

const universe  = JSON.parse(fs.readFileSync(new URL("./universe.json", import.meta.url)));
const statePath = new URL("./state.json", import.meta.url);
let state = {}; try { state = JSON.parse(fs.readFileSync(statePath)); } catch { state = {}; }
const report = { startedAt: new Date().toISOString(), items: [] };

// ---- math helpers ----
const avg = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0;
const std = a => { const m=avg(a); return Math.sqrt(avg(a.map(v => (v-m)*(v-m)))); };
function seriesEMA(arr, n){ const out=[]; const k=2/(n+1); let e=arr[0];
  for (let i=0;i<arr.length;i++){ const v=arr[i]; e = (i===0? v : v*k + e*(1-k)); out.push(e); }
  return out;
}
function rsi(arr, p=14){
  const d=[]; for (let i=1;i<arr.length;i++) d.push(arr[i]-arr[i-1]);
  const gains=d.map(x=>Math.max(x,0)), losses=d.map(x=>Math.max(-x,0));
  let ag=avg(gains.slice(0,p)), al=avg(losses.slice(0,p));
  for (let i=p; i<d.length; i++){ ag=(ag*(p-1)+gains[i])/p; al=(al*(p-1)+losses[i])/p; }
  const rs = al ? ag/al : 1e9; return 100 - 100/(1+rs);
}
function atr(high, low, close, p=14){
  const trs=[]; for (let i=1;i<close.length;i++){ const hl=high[i]-low[i], hc=Math.abs(high[i]-close[i-1]), lc=Math.abs(low[i]-close[i-1]); trs.push(Math.max(hl,hc,lc)); }
  let a=avg(trs.slice(0,p)); for (let i=p;i<trs.length;i++) a=(a*(p-1)+trs[i])/p; return a;
}
function linSlope(arr, n){ const a=arr.slice(-n); const m=avg(a); const xs=Array.from({length:a.length},(_,i)=>i+1);
  const xm=avg(xs); let num=0, den=0; for (let i=0;i<a.length;i++){ num+=(xs[i]-xm)*(a[i]-m); den+=(xs[i]-xm)**2; } return num/(den||1);
}
const num = x => Math.round((x??0)*100)/100;
const pct = (a,b) => b ? (100*(a-b)/b) : 0;
function inQuietHours(){ const hour = new Date(new Date().toLocaleString("en-US",{ timeZone: QUIET_TZ })).getHours();
  return (QUIET_START <= QUIET_END) ? (hour>=QUIET_START && hour<QUIET_END) : (hour>=QUIET_START || hour<QUIET_END); }

// ---- fetch helpers ----
async function fetchJSON(url, headers={}){ const r=await fetch(url,{headers}); if(!r.ok) throw new Error(`HTTP ${r.status} for ${url}`); return r.json(); }
async function fetchText(url, headers={}){ const r=await fetch(url,{headers}); if(!r.ok) throw new Error(`HTTP ${r.status} for ${url}`); return r.text(); }

// ---- data sources ----
async function yahooChart(symbol){
  return fetchJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`);
}
async function yahooQuoteSummary(symbol){
  try { return await fetchJSON(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=defaultKeyStatistics,financialData`); }
  catch { return null; }
}
async function binanceKlines1h(pair){
  const sym = pair.replace(/^BINANCE:/,"");
  return fetchJSON(`https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(sym)}&interval=1h&limit=300`);
}
async function newsFor(q){
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
  // uniq by title
  const seen = new Set(); const out=[];
  for (const t of titles){ const k=t.split(" — ")[0]; if(!seen.has(k)){ seen.add(k); out.push(t); } }
  return out.slice(0, MAX_HEADLINES);
}

// ---- benchmarks for relative strength ----
let benchSPY=null, benchBTC=null;
async function loadBenchmarks(){
  try { const j = await yahooChart("SPY"); benchSPY = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(x=>typeof x==="number")||null; } catch {}
  try { const j = await binanceKlines1h("BINANCE:BTCUSDT"); benchBTC = j?.map(k=>Number(k[4])).filter(Number.isFinite)||null; } catch {}
}

// ---- feature builders ----
function stockFeatures(chartJson){
  const r = chartJson?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0] || {};
  const closes = (q.close||[]).filter(v=>typeof v==="number");
  const highs  = (q.high ||[]).filter(v=>typeof v==="number");
  const lows   = (q.low  ||[]).filter(v=>typeof v==="number");
  const vols   = (q.volume||[]).filter(v=>typeof v==="number");
  const recent = closes.slice(-220);
  const price  = recent.at(-1);

  const sma20  = avg(recent.slice(-20));
  const sma50  = avg(recent.slice(-50));
  const sma200 = avg(recent.slice(-200));
  const ema12v = seriesEMA(recent,12); const ema26v = seriesEMA(recent,26);
  const macdSeries = ema12v.map((v,i)=> v - ema26v[i]);
  const macdLine   = macdSeries.at(-1);
  const macdSignal = seriesEMA(macdSeries.slice(-35), 9).at(-1);
  const rsi14 = rsi(recent,14);
  const a14   = (highs.length&&lows.length) ? atr(highs.slice(-221), lows.slice(-221), closes.slice(-221), 14) : null;
  const std20 = std(recent.slice(-20)); const bbUpper = sma20 + 2*std20, bbLower = sma20 - 2*std20;
  const hi52  = Math.max(...recent), lo52 = Math.min(...recent);
  const proximityHi = pct(price, hi52);
  const proximityLo = pct(price, lo52);
  const vol20 = avg(vols.slice(-20)); const volSpike = vols.at(-1)&&vol20 ? vols.at(-1)/vol20 : null;
  const slope50 = linSlope(recent.slice(-60), 60);

  // RS vs SPY (20d)
  let rs20 = null;
  if (benchSPY && benchSPY.length>20 && recent.length>20){
    const rAsset = recent.at(-1) / recent[-21];
    const rSpy   = benchSPY.at(-1) / benchSPY[-21];
    rs20 = rAsset - rSpy;
  }
  return { price, sma20, sma50, sma200, macdLine, macdSignal, rsi14, atr14:a14, bbUpper, bbLower, proximityHi, proximityLo, volSpike, slope50, rs20 };
}

function cryptoFeatures(klines){
  const closes = klines.map(k=>Number(k[4])).filter(Number.isFinite);
  const recent = closes.slice(-220);
  const price  = recent.at(-1);
  const sma20  = avg(recent.slice(-20));
  const sma50  = avg(recent.slice(-50));
  const sma200 = avg(recent.slice(-200));
  const ema12v = seriesEMA(recent,12); const ema26v = seriesEMA(recent,26);
  const macdSeries = ema12v.map((v,i)=> v - ema26v[i]);
  const macdLine   = macdSeries.at(-1);
  const macdSignal = seriesEMA(macdSeries.slice(-35), 9).at(-1);
  const rsi14 = rsi(recent,14);
  const std20 = std(recent.slice(-20)); const bbUpper = sma20 + 2*std20, bbLower = sma20 - 2*std20;
  const hi = Math.max(...recent), lo = Math.min(...recent);
  const proximityHi = pct(price, hi), proximityLo = pct(price, lo);
  const slope50 = linSlope(recent.slice(-60), 60);

  // RS vs BTC (20h)
  let rs20 = null;
  if (benchBTC && benchBTC.length>20 && recent.length>20){
    const rAsset = recent.at(-1) / recent[-21];
    const rBtc   = benchBTC.at(-1) / benchBTC[-21];
    rs20 = rAsset - rBtc;
  }
  return { price, sma20, sma50, sma200, macdLine, macdSignal, rsi14, bbUpper, bbLower, proximityHi, proximityLo, slope50, rs20 };
}

// numeric pre-score helps reduce LLM noise
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

// ---- AI judge ----
async function judge(type, symbol, features, fundamentals, headlines){
  const sys = "You are an investment research assistant. Decide if this is a timely opportunity. Consider technicals, trend, relative strength and news. Be concise, no financial advice. Return strict JSON only: {\"decision\":\"push|hold\",\"score\":0-100,\"confidence\":0-1,\"risk\":\"low|medium|high\",\"reason\":\"<=300 chars\",\"tags\":[...]}";
  const user = { type, symbol, features, fundamentals: fundamentals||null, preScore: preScore(features), headlines: headlines||[] };
  const r = await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{ "Authorization":`Bearer ${OPENAI_API_KEY}`, "Content-Type":"application/json" },
    body: JSON.stringify({ model:"gpt-4o-mini", temperature:0.2, messages:[ {role:"system",content:sys}, {role:"user",content:JSON.stringify(user)} ] })
  });
  if (!r.ok) throw new Error("OpenAI "+r.status);
  const j = await r.json();
  const txt = j?.choices?.[0]?.message?.content || "{}";
  try { return JSON.parse(txt); } catch { return { decision:"hold", score:0, confidence:0.1, risk:"medium", reason:"AI parse fail", tags:[] }; }
}

// ---- Push ----
async function push(symbol, ai){
  const body = {
    app_id: ONESIGNAL_APP_ID,
    filters: [{ field:"tag", key:"signals", relation:"=", value:"true" }],
    headings: { en: `Opportunity: ${symbol} — ${ai.score}` },
    contents: { en: ai.reason },
    url: "https://fnothing.com/"
  };
  const r = await fetch("https://onesignal.com/api/v1/notifications",{
    method:"POST",
    headers:{ "Authorization":`Basic ${ONESIGNAL_REST_KEY}`, "Content-Type":"application/json" },
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

// ---- fundamentals (best effort via Yahoo) ----
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

// ---- tasks ----
async function processStock(symbol){
  try{
    const chart      = await yahooChart(symbol);
    const features   = stockFeatures(chart);
    const fundamentals = await fetchFundamentals(symbol);
    const headlines  = await newsFor(symbol+" stock");
    const ai         = await judge("stock", symbol, features, fundamentals, headlines);
    report.items.push({ type:"stock", symbol, features, fundamentals, ai });
    await maybePush(symbol, ai);
  }catch(e){
    report.items.push({ type:"stock", symbol, error: String(e) });
  }
}
async function processCrypto(symbol){
  try{
    const klines   = await binanceKlines1h(symbol);
    const features = cryptoFeatures(klines);
    const ai       = await judge("crypto", symbol, features, null, []);
    report.items.push({ type:"crypto", symbol, features, ai });
    await maybePush(symbol, ai);
  }catch(e){
    report.items.push({ type:"crypto", symbol, error: String(e) });
  }
}

// ---- runner ----
async function pRun(tasks, limit){
  const q = tasks.slice();
  const workers = Array.from({length: Math.min(limit, q.length)}, async () => {
    while(q.length){
      const fn = q.shift();
      try { await fn(); } catch(e){ console.error(e); }
    }
  });
  await Promise.all(workers);
}

async function main(){
  await loadBenchmarks();
  const tasks=[];
  for (const s of universe.stocks) tasks.push(()=>processStock(s));
  for (const c of universe.crypto) tasks.push(()=>processCrypto(c));
  await pRun(tasks, CONCURRENCY);

  const stamp = new Date().toISOString().replace(/[:.]/g,"-");
  fs.writeFileSync(new URL(`./reports/run-${stamp}.json`, import.meta.url), JSON.stringify(report, null, 2));
  fs.writeFileSync(new URL(`./reports/latest.json`, import.meta.url), JSON.stringify(report, null, 2));
  console.log("scan done");
}
await main();
