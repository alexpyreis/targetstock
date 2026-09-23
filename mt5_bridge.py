"""
Target Stock's — MetaTrader 5 Real-Time WebSocket Bridge
=========================================================
Streams live B3 tick data (zero delay) from a connected MT5 terminal
to the Target Stock's React app via a local WebSocket server.

Requirements:
  - MetaTrader 5 terminal installed and logged in to a broker account
    that supports B3 assets (e.g., XP, Clear, BTG, Genial, Toro).
  - pip install MetaTrader5 websockets numpy

Run this script BEFORE opening the app in the browser:
  py mt5_bridge.py

Then in the app, click "Sobre o app" -> toggle "MT5 Tempo Real"
The app will connect to ws://localhost:8765 and receive live ticks.
"""

import asyncio
import json
import time
import logging
import sys
from datetime import datetime, timezone

try:
    import MetaTrader5 as mt5
except ImportError:
    print("ERROR: MetaTrader5 not installed. Run: py -m pip install MetaTrader5")
    sys.exit(1)

try:
    import websockets
    from websockets.asyncio.server import serve
except ImportError:
    print("ERROR: websockets not installed. Run: py -m pip install websockets")
    sys.exit(1)

# ── Configuration ─────────────────────────────────────────────────────────────
HOST = "localhost"
PORT = 8765
REFRESH_INTERVAL = 2.0   # seconds between snapshots
MAX_SYMBOLS = 30          # how many top-volume B3 symbols to track

# Top B3 symbols to track by default (can be overridden by the frontend)
DEFAULT_SYMBOLS = [
    "PETR4", "VALE3", "BBAS3", "BBDC4", "ITUB4",
    "B3SA3", "ABEV3", "WEGE3", "RENT3", "MGLU3",
    "CIEL3", "GGBR4", "CSNA3", "PRIO3", "RAIZ4",
    "VBBR3", "BEEF3", "MRFG3", "JBSS3", "BRFS3",
    "SUZB3", "KLBN11", "PETR3", "BOVA11", "SMAL11",
    "COGN3", "YDUQ3", "HAPV3", "RDOR3", "FLRY3",
]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("mt5_bridge")

connected_clients: set = set()

# ── MT5 Helpers ───────────────────────────────────────────────────────────────

def init_mt5() -> bool:
    """Initialize the MT5 connection. Returns True on success."""
    if not mt5.initialize():
        log.error("MT5 initialize() failed — is MetaTrader 5 running and logged in?")
        log.error("MT5 error: %s", mt5.last_error())
        return False
    info = mt5.terminal_info()
    acc  = mt5.account_info()
    if info and acc:
        log.info("Connected to MT5 terminal: %s  (build %s)", info.name, info.build)
        log.info("Account: %s  |  Broker: %s", acc.login, acc.company)
    return True


def get_symbol_mt5_name(symbol: str) -> str:
    """
    Tries to find the correct MT5 symbol name for a B3 ticker.
    Different brokers suffix symbols differently (e.g. PETR4, PETR4F, WIN$N).
    """
    candidates = [symbol, f"{symbol}F", f"{symbol}.SA"]
    for name in candidates:
        info = mt5.symbol_info(name)
        if info is not None:
            if not info.visible:
                mt5.symbol_select(name, True)  # add to MarketWatch
            return name
    return symbol  # fallback — may not exist on broker


def fetch_snapshot(symbols: list[str]) -> list[dict]:
    """
    Fetches the latest tick + 1-minute candle for each symbol.
    Returns a list of dicts ready to be JSON-serialized and sent to the frontend.
    """
    results = []
    now_ts = int(time.time())

    for sym in symbols:
        mt5_sym = get_symbol_mt5_name(sym)

        tick = mt5.symbol_info_tick(mt5_sym)
        info = mt5.symbol_info(mt5_sym)

        if tick is None or info is None:
            continue

        # Last price (use last if available, otherwise bid)
        last_price = tick.last if tick.last > 0 else tick.bid

        # Day OHLCV from the daily candle
        daily = mt5.copy_rates_from_pos(mt5_sym, mt5.TIMEFRAME_D1, 0, 2)
        if daily is not None and len(daily) > 0:
            today  = daily[-1]
            open_  = float(today["open"])
            high   = float(today["high"])
            low    = float(today["low"])
            volume = int(today["tick_volume"])
            change_pct = ((last_price - open_) / open_ * 100) if open_ > 0 else 0
        else:
            open_  = last_price
            high   = last_price
            low    = last_price
            volume = int(tick.volume)
            change_pct = 0.0

        flow = last_price * volume

        results.append({
            "stock":      sym,
            "name":       info.description or sym,
            "close":      round(last_price, 2),
            "bid":        round(float(tick.bid), 2),
            "ask":        round(float(tick.ask), 2),
            "open":       round(open_, 2),
            "high":       round(high, 2),
            "low":        round(low, 2),
            "volume":     volume,
            "change":     round(change_pct, 2),
            "flow":       round(flow, 2),
            "spread":     round(float(tick.ask - tick.bid), 4),
            "tick_time":  int(tick.time),
            "server_ts":  now_ts,
            "source":     "mt5_realtime",
        })

    # Sort by financial flow descending
    results.sort(key=lambda x: x["flow"], reverse=True)
    return results


# ── WebSocket Server ───────────────────────────────────────────────────────────

async def broadcast(message: str) -> None:
    """Send a message to all connected clients."""
    if not connected_clients:
        return
    dead = set()
    for ws in connected_clients:
        try:
            await ws.send(message)
        except Exception:
            dead.add(ws)
    connected_clients.difference_update(dead)


async def feed_loop(symbols: list[str]) -> None:
    """
    Continuously fetches snapshots from MT5 and broadcasts to all clients.
    Runs as a background task alongside the WebSocket server.
    """
    log.info("Feed loop started — tracking %d symbols every %.1fs", len(symbols), REFRESH_INTERVAL)
    while True:
        try:
            snapshot = fetch_snapshot(symbols)
            payload = json.dumps({
                "type":    "snapshot",
                "ts":      int(time.time() * 1000),
                "count":   len(snapshot),
                "stocks":  snapshot,
            })
            await broadcast(payload)
            if snapshot:
                top = snapshot[0]
                log.info(
                    "Broadcast: %d assets | Leader: %s R$ %.2f (%+.2f%%)",
                    len(snapshot), top["stock"], top["close"], top["change"]
                )
        except Exception as exc:
            log.warning("Feed error: %s", exc)

        await asyncio.sleep(REFRESH_INTERVAL)


async def handler(websocket) -> None:
    """Handle a new WebSocket client connection."""
    addr = websocket.remote_address
    log.info("Client connected: %s", addr)
    connected_clients.add(websocket)

    # Send current market status immediately on connect
    is_open = is_b3_open()
    await websocket.send(json.dumps({
        "type":     "market_status",
        "is_open":  is_open,
        "status":   "B3 ABERTA" if is_open else "B3 FECHADA",
        "message":  "Pregão em andamento — dados em tempo real (MT5)." if is_open
                    else "Pregão encerrado. Dados do último fechamento.",
    }))

    try:
        async for message in websocket:
            # Allow client to request a specific symbol list
            try:
                data = json.loads(message)
                if data.get("type") == "subscribe" and "symbols" in data:
                    log.info("Client %s subscribed to: %s", addr, data["symbols"])
            except Exception:
                pass
    except Exception:
        pass
    finally:
        connected_clients.discard(websocket)
        log.info("Client disconnected: %s", addr)


def is_b3_open() -> bool:
    """Returns True if B3 is currently in regular trading session."""
    from zoneinfo import ZoneInfo
    brt = ZoneInfo("America/Sao_Paulo")
    now = datetime.now(tz=brt)
    if now.weekday() >= 5:   # Saturday=5, Sunday=6
        return False
    t = now.hour * 100 + now.minute
    return 1000 <= t < 1800


# ── Entry Point ───────────────────────────────────────────────────────────────

async def main() -> None:
    log.info("=" * 58)
    log.info("  Target Stock's — MT5 Real-Time Bridge")
    log.info("=" * 58)

    if not init_mt5():
        log.error(
            "\nCould not connect to MetaTrader 5.\n"
            "Steps to fix:\n"
            "  1. Download and install MetaTrader 5 from your broker:\n"
            "     - XP: https://xpinvestimentos.com.br/plataformas/\n"
            "     - Clear: https://clear.com.br\n"
            "     - BTG: https://btgpactualdigital.com\n"
            "  2. Log in to your broker account inside MT5.\n"
            "  3. Make sure B3 symbols appear in the MarketWatch window.\n"
            "  4. Run this script again.\n"
        )
        sys.exit(1)

    symbols = DEFAULT_SYMBOLS[:MAX_SYMBOLS]

    # Verify at least some symbols are available
    available = []
    for sym in symbols:
        mt5_sym = get_symbol_mt5_name(sym)
        if mt5.symbol_info(mt5_sym) is not None:
            available.append(sym)
    
    if not available:
        log.warning("No B3 symbols found in MT5 MarketWatch.")
        log.warning("Open MT5 → View → MarketWatch → right-click → Show All")
        available = symbols  # try anyway

    log.info("Tracking %d symbols: %s...", len(available), ", ".join(available[:5]))
    log.info("WebSocket server starting on ws://%s:%d", HOST, PORT)
    log.info("Open Target Stock's in browser and click 'Sobre o app' → toggle MT5")
    log.info("-" * 58)

    # Run WebSocket server + feed loop concurrently
    async with serve(handler, HOST, PORT):
        await feed_loop(available)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Bridge stopped by user.")
        mt5.shutdown()
