require("dotenv").config();

const WebSocket = require("ws");
const axios = require("axios");
const { DatabaseSync } = require("node:sqlite");

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PAPER_MODE = process.env.PAPER_MODE !== "false";
const MIN_TRADE_SIZE_USD = parseFloat(process.env.MIN_TRADE_SIZE || "50");
const COPY_SIZE_FIXED = parseFloat(process.env.COPY_SIZE || "25");

const WALLETS = [
  { address: "0x57ee70867b4e387de9de34fd62bc685aa02a8112", nickname: "whale1" },
  { address: "0x2a353ce9e57a51e65814d2fe7cdd4ad3f20741ce", nickname: "whale2" },
  { address: "0xde17f7144fbd0eddb2679132c10ff5e74b120988", nickname: "whale3" },
  { address: "0xda120acc74be71c7f59b4b032a3a1ccf976c6967", nickname: "whale4" },
  { address: "0xeebde7a0e019a63e6b476eb425505b7b3e6eba30", nickname: "whale5" },
  { address: "0x89b5cdaaa4866c1e738406712012a630b4078beb", nickname: "whale6" },
  { address: "0x2d8b401d2f0e6937afebf18e19e11ca568a5260a", nickname: "whale7" },
];

const WALLET_SET = new Set(WALLETS.map((w) => w.address.toLowerCase()));
const WALLET_MAP = Object.fromEntries(WALLETS.map((w) => [w.address.toLowerCase(), w]));

const WSS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const CLOB_BASE = "https://clob.polymarket.com";
const GAMMA_BASE = "https://gamma-api.polymarket.com";

// ─── STATE ───────────────────────────────────────────────────────────────────
const marketCache = new Map();   // conditionId → { question, slug, tokenIds }
const tokenToMarket = new Map(); // tokenId → conditionId
const subscribedTokens = new Set();
let ws = null;
let pingTimer = null;

// ─── DB ──────────────────────────────────────────────────────────────────────
const db = new DatabaseSync(process.env.DB_PATH || "polymarket_paper.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS seen_trades (
    id TEXT PRIMARY KEY,
    seen_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS paper_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet TEXT NOT NULL,
    nickname TEXT,
    market_id TEXT NOT NULL,
    market_question TEXT,
    outcome TEXT NOT NULL,
    side TEXT NOT NULL,
    size_usd REAL NOT NULL,
    price REAL NOT NULL,
    shares REAL NOT NULL,
    timestamp INTEGER NOT NULL,
    trade_id TEXT,
    resolved INTEGER DEFAULT 0,
    resolved_price REAL,
    pnl REAL
  );
`);
const isSeen = db.prepare("SELECT 1 FROM seen_trades WHERE id = ?");
const markSeen = db.prepare("INSERT OR IGNORE INTO seen_trades (id, seen_at) VALUES (?, ?)");
const insertPosition = db.prepare(`
  INSERT INTO paper_positions
  (wallet, nickname, market_id, market_question, outcome, side, size_usd, price, shares, timestamp, trade_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// ─── TELEGRAM (pure axios, no library) ───────────────────────────────────────
async function sendAlert(msg) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: msg,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }, { timeout: 10000 });
  } catch (e) {
    console.error("[TG]", e.response?.data?.description || e.message);
  }
}

let lastUpdateId = 0;
async function pollCommands() {
  try {
    const r = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates`, {
      params: { offset: lastUpdateId + 1, timeout: 20 },
      timeout: 25000,
    });
    for (const u of (r.data?.result || [])) {
      lastUpdateId = u.update_id;
      const text = u.message?.text || "";
      if (text.startsWith("/stats")) await cmdStats();
      if (text.startsWith("/wallets")) await cmdWallets();
      if (text.startsWith("/status")) await cmdStatus();
    }
  } catch {}
  setTimeout(pollCommands, 1000);
}

async function cmdStats() {
  const s = db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN resolved=0 THEN 1 ELSE 0 END) as open,
      SUM(CASE WHEN resolved=1 THEN 1 ELSE 0 END) as closed,
      SUM(CASE WHEN resolved=1 THEN pnl ELSE 0 END) as total_pnl,
      SUM(CASE WHEN resolved=1 AND pnl>0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN resolved=1 AND pnl<=0 THEN 1 ELSE 0 END) as losses
    FROM paper_positions
  `).get();
  const pnl = s.total_pnl || 0;
  const open = s.open || 0;
  const closed = s.closed || 0;
  const wins = s.wins || 0;
  const losses = s.losses || 0;
  const winRate = closed > 0 ? ((wins / closed) * 100).toFixed(1) + "%" : "N/A";
  await sendAlert(
    `📈 <b>PAPER STATS</b>\n━━━━━━━━━━━━━━━━━━━\n` +
    `📂 Total: ${s.total} | Open: ${open} | Closed: ${closed}\n` +
    `${pnl >= 0 ? "🟢" : "🔴"} PnL: <b>${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}</b>\n` +
    `🎯 Win rate: ${winRate} (W: ${wins} / L: ${losses})`
  );
}

async function cmdWallets() {
  const lines = WALLETS.map((w, i) =>
    `${i + 1}. <b>${w.nickname}</b>\n   <code>${w.address}</code>`
  ).join("\n\n");
  await sendAlert(`👛 <b>Tracked Wallets</b>\n━━━━━━━━━━━━━━━━━━━\n${lines}`);
}

async function cmdStatus() {
  await sendAlert(
    `⚙️ <b>Bot Status</b>\n━━━━━━━━━━━━━━━━━━━\n` +
    `🔌 WebSocket: ${ws?.readyState === 1 ? "🟢 Connected" : "🔴 Disconnected"}\n` +
    `📡 Tokens subscribed: ${subscribedTokens.size}\n` +
    `📊 Markets cached: ${marketCache.size}\n` +
    `👛 Wallets: ${WALLETS.length}\n` +
    `📋 Mode: ${PAPER_MODE ? "PAPER" : "⚡ LIVE"}`
  );
}

// ─── MARKET BOOTSTRAP ────────────────────────────────────────────────────────
async function bootstrapMarkets() {
  console.log("[INIT] Fetching active markets...");
  let offset = 0;
  const limit = 100;
  let total = 0;
  try {
    while (true) {
      const resp = await axios.get(`${GAMMA_BASE}/markets`, {
        params: { active: true, closed: false, limit, offset },
        timeout: 15000,
      });
      const markets = resp.data;
      if (!Array.isArray(markets) || markets.length === 0) break;

      for (const m of markets) {
        // Gamma API uses camelCase: conditionId, clobTokenIds
        const conditionId = m.conditionId || m.condition_id;
        const rawTokenIds = m.clobTokenIds || m.clob_token_ids;
        if (!conditionId || !rawTokenIds) continue;

        const tokenIds = Array.isArray(rawTokenIds)
          ? rawTokenIds
          : JSON.parse(rawTokenIds || "[]");

        marketCache.set(conditionId, {
          question: m.question || m.title || conditionId,
          slug: m.slug,
          tokenIds,
          endDate: m.endDate || m.end_date_iso || m.endDateIso || null,
        });
        for (const tid of tokenIds) {
          tokenToMarket.set(String(tid), conditionId);
        }
      }

      total += markets.length;
      offset += limit;
      if (markets.length < limit || total >= 500) break;
    }
    console.log(`[INIT] Loaded ${marketCache.size} markets (${tokenToMarket.size} tokens)`);
  } catch (e) {
    console.error("[INIT] Error:", e.message);
  }
}

// ─── TRADES ──────────────────────────────────────────────────────────────────
async function getLatestTrades(marketId) {
  try {
    const resp = await axios.get(`${CLOB_BASE}/trades`, {
      params: { market: marketId, limit: 10 },
      timeout: 5000,
    });
    return resp.data?.data || [];
  } catch { return []; }
}

async function processTrade(trade, marketId) {
  const tradeId = trade.id || trade.trade_id;
  if (!tradeId) return;

  const makerAddr = (trade.maker_address || "").toLowerCase();
  const takerAddr = (trade.taker_address || "").toLowerCase();
  const whaleAddr = WALLET_SET.has(makerAddr) ? makerAddr
    : WALLET_SET.has(takerAddr) ? takerAddr : null;
  if (!whaleAddr) return;

  const tradeKey = `${whaleAddr}:${tradeId}`;
  if (isSeen.get(tradeKey)) return;
  markSeen.run(tradeKey, Date.now());

  const price = parseFloat(trade.price || 0);
  const sizeShares = parseFloat(trade.size || 0);
  const sizeUsd = price * sizeShares;
  if (sizeUsd < MIN_TRADE_SIZE_USD) return;

  // Skip markets resolving in less than 24 hours
  const marketInfo24 = marketCache.get(marketId);
  if (marketInfo24?.endDate) {
    const hoursLeft = (new Date(marketInfo24.endDate) - Date.now()) / 3600000;
    if (hoursLeft < 24) {
      console.log(`[SKIP] ${marketId.slice(0, 10)}... resolves in ${hoursLeft.toFixed(1)}h — skipping`);
      return;
    }
  }

  const wallet = WALLET_MAP[whaleAddr];
  const isMaker = makerAddr === whaleAddr;
  const rawSide = (trade.side || "BUY").toUpperCase();
  const side = isMaker ? (rawSide === "BUY" ? "SELL" : "BUY") : rawSide;

  const marketInfo = marketCache.get(marketId);
  const yesTokenId = String(marketInfo?.tokenIds?.[0]);
  const outcome = String(trade.asset_id) === yesTokenId ? "YES" : "NO";
  const question = marketInfo?.question || marketId;
  const marketUrl = marketInfo?.slug
    ? `https://polymarket.com/event/${marketInfo.slug}`
    : "https://polymarket.com";

  const shares = COPY_SIZE_FIXED / price;

  insertPosition.run(
    wallet.address, wallet.nickname,
    marketId, question,
    outcome, side,
    COPY_SIZE_FIXED, price, shares,
    Math.floor(Date.now() / 1000),
    tradeId
  );

  const openPos = db.prepare(
    "SELECT COUNT(*) as cnt, SUM(size_usd) as total FROM paper_positions WHERE resolved = 0"
  ).get();

  console.log(`[COPY] ${wallet.nickname} → ${side} ${outcome} @ $${price.toFixed(3)} | ${question.substring(0, 60)}`);

  await sendAlert(
    `📋 <b>PAPER TRADE COPIED</b>\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `👤 <b>${wallet.nickname}</b>  <code>${wallet.address.slice(0, 8)}...${wallet.address.slice(-6)}</code>\n\n` +
    `${side === "BUY" ? "🟢" : "🔴"} <b>${side}</b>  ${outcome === "YES" ? "✅" : "❌"} <b>${outcome}</b>\n` +
    `💵 Their size: <b>$${sizeUsd.toFixed(2)}</b>\n` +
    `📎 Paper copy: <b>$${COPY_SIZE_FIXED.toFixed(2)}</b> → ${shares.toFixed(2)} shares\n` +
    `💲 Entry: <b>$${price.toFixed(3)}</b> (${(price * 100).toFixed(1)}¢)\n\n` +
    `📊 <b>${question}</b>\n` +
    `🔗 <a href="${marketUrl}">View on Polymarket</a>\n\n` +
    `📂 Open positions: ${openPos.cnt} ($${(openPos.total || 0).toFixed(2)})`
  );
}

// ─── WEBSOCKET ───────────────────────────────────────────────────────────────
function connectWebSocket() {
  if (ws) { try { ws.terminate(); } catch {} }
  clearInterval(pingTimer);
  console.log("[WS] Connecting...");
  ws = new WebSocket(WSS_URL);

  ws.on("open", () => {
    console.log("[WS] Connected ✓");
    const allTokenIds = [...tokenToMarket.keys()];
    if (allTokenIds.length === 0) {
      console.warn("[WS] No tokens — market bootstrap may have failed");
      return;
    }
    for (let i = 0; i < allTokenIds.length; i += 490) {
      const chunk = allTokenIds.slice(i, i + 490);
      ws.send(JSON.stringify({ assets_ids: chunk, type: "market", custom_feature_enabled: true }));
      chunk.forEach((id) => subscribedTokens.add(id));
    }
    console.log(`[WS] Subscribed to ${subscribedTokens.size} tokens`);
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("PING");
    }, 10000);
  });

  ws.on("message", async (raw) => {
    const text = raw.toString();
    if (text === "PONG") return;
    let events;
    try { events = JSON.parse(text); } catch { return; }
    const list = Array.isArray(events) ? events : [events];
    for (const event of list) {
      if (event.event_type !== "last_trade_price") continue;
      const marketId = tokenToMarket.get(String(event.asset_id));
      if (!marketId) continue;
      const trades = await getLatestTrades(marketId);
      for (const trade of trades) await processTrade(trade, marketId);
    }
  });

  ws.on("close", (code) => {
    console.log(`[WS] Closed (${code}) — reconnecting in 3s`);
    clearInterval(pingTimer);
    setTimeout(connectWebSocket, 3000);
  });

  ws.on("error", (err) => console.error("[WS] Error:", err.message));
}

// ─── REFRESH MARKETS (every 30min) ───────────────────────────────────────────
async function refreshMarkets() {
  await bootstrapMarkets();
  const newTokenIds = [...tokenToMarket.keys()].filter((id) => !subscribedTokens.has(id));
  if (newTokenIds.length > 0 && ws?.readyState === WebSocket.OPEN) {
    for (let i = 0; i < newTokenIds.length; i += 490) {
      const chunk = newTokenIds.slice(i, i + 490);
      ws.send(JSON.stringify({ assets_ids: chunk, operation: "subscribe", custom_feature_enabled: true }));
      chunk.forEach((id) => subscribedTokens.add(id));
    }
    console.log(`[REFRESH] +${newTokenIds.length} new tokens (total: ${subscribedTokens.size})`);
  }
}

// ─── RESOLUTION CHECKER ──────────────────────────────────────────────────────
async function checkResolutions() {
  const openMarkets = db.prepare("SELECT DISTINCT market_id FROM paper_positions WHERE resolved = 0").all();
  for (const row of openMarkets) {
    try {
      const resp = await axios.get(`${GAMMA_BASE}/markets`, {
        params: { conditionId: row.market_id }, timeout: 8000
      });
      const market = resp.data?.[0];
      if (!market?.closed) continue;
      const resPrice = market.outcome?.toLowerCase() === "yes" ? 1.0 : 0.0;
      const positions = db.prepare("SELECT * FROM paper_positions WHERE market_id = ? AND resolved = 0").all(row.market_id);
      let totalPnl = 0;
      for (const pos of positions) {
        const pnl = pos.side === "BUY"
          ? (resPrice - pos.price) * pos.shares
          : (pos.price - resPrice) * pos.shares;
        totalPnl += pnl;
        db.prepare("UPDATE paper_positions SET resolved=1, resolved_price=?, pnl=? WHERE id=?").run(resPrice, pnl, pos.id);
      }
      await sendAlert(
        `🏁 <b>MARKET RESOLVED</b>\n━━━━━━━━━━━━━━━━━━━\n` +
        `📊 ${market.question}\n📌 Outcome: <b>${market.outcome}</b>\n` +
        `${totalPnl >= 0 ? "🟢" : "🔴"} Paper PnL: <b>${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}</b>\n` +
        `📂 Positions closed: ${positions.length}`
      );
    } catch {}
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🚀 Polymarket Copytrade Bot — WebSocket mode");
  console.log(`📋 ${PAPER_MODE ? "PAPER TRADING" : "⚡ LIVE"} | Wallets: ${WALLETS.length} | Copy: $${COPY_SIZE_FIXED}`);

  await bootstrapMarkets();
  pollCommands();
  connectWebSocket();
  setInterval(refreshMarkets, 30 * 60 * 1000);
  setInterval(checkResolutions, 5 * 60 * 1000);

  await sendAlert(
    `🚀 <b>Polymarket Copytrade Bot Started</b>\n` +
    `📋 Mode: <b>${PAPER_MODE ? "PAPER TRADING" : "⚡ LIVE"}</b>\n` +
    `👛 Wallets: <b>${WALLETS.length}</b>\n` +
    `📡 Feed: <b>WebSocket real-time</b>\n` +
    `💵 Copy size: <b>$${COPY_SIZE_FIXED}</b>\n\n` +
    `Commands: /stats /wallets /status`
  );
}

main().catch(console.error);
