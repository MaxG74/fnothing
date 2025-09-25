# fnothing — Global Scanner PRO (GitHub Actions)
- Läuft alle 30 Min & manuell.
- Stocks (Yahoo 1D), Crypto (Binance 1h).
- Indikatoren: SMA20/50/200, EMA12/26, MACD(12,26,9), RSI14, ATR14, Bollinger(20,2), 52w Proximity, Volume-Spike, SMA50-Slope, RS vs SPY/BTC.
- News: Google News + Yahoo Finance RSS.
- Pre-Score + OpenAI-Urteil (JSON) → OneSignal-Push.
- Quiet Hours, De-Dupe, Reports in `reports/`, Dedupe in `state.json`.

**Hinweis:** Research-Signale, keine Anlageberatung.
