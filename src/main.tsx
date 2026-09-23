import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Clock, RefreshCw, Zap, Flame, ArrowRight, Search, Wifi, WifiOff } from "lucide-react";
import "./style.css";

type Asset = {
  stock: string;
  name?: string;
  close?: number;
  change?: number;
  change_abs?: number;
  volume?: number;
  market_cap?: number;
  sector?: string;
  subType?: string;
  type?: string;
  logo?: string;
  dayHigh?: number;
  dayLow?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
};

type MarketResponse = {
  stocks?: Asset[];
  totalPages?: number;
  totalCount?: number;
  hasNextPage?: boolean;
  availableSectors?: string[];
  availableSubsectors?: string[];
  availableStockTypes?: string[];
  availableSubTypeTypes?: string[];
};

type HistoryPoint = { date: number; close?: number; adjustedClose?: number };
type HistoryResponse = {
  results?: {
    symbol?: string;
    data?: { historicalDataPrice?: HistoryPoint[] };
  }[];
};
type QuoteV2Response = {
  results?: {
    data?: {
      regularMarketPrice?: number;
      regularMarketChangePercent?: number;
      regularMarketVolume?: number;
      marketCap?: number;
      regularMarketDayHigh?: number;
      regularMarketDayLow?: number;
      fiftyTwoWeekHigh?: number;
      fiftyTwoWeekLow?: number;
    };
  }[];
};
type YahooHistoryResponse = {
  chart?: {
    result?: {
      timestamp?: number[];
      indicators?: {
        adjclose?: { adjclose?: (number | null)[] }[];
        quote?: { close?: (number | null)[] }[];
      };
    }[];
  };
};
type Category = "stocks" | "units" | "fiis" | "etfs" | "bdrs";
type Sort = "value" | "volume" | "changeUp" | "changeDown" | "name";
type Range = "1y" | "3y" | "5y";

const API_URL = "https://brapi.dev/api/quote/list";
const PAGE_SIZE = 500;
const categories: {
  id: Category;
  label: string;
  type: string;
  subType: string;
  description: string;
}[] = [
  {
    id: "stocks",
    label: "Ações",
    type: "stock",
    subType: "stock",
    description: "Ações ordinárias e preferenciais",
  },
  {
    id: "units",
    label: "Units",
    type: "stock",
    subType: "unit",
    description: "Certificados de ações agrupadas",
  },
  {
    id: "fiis",
    label: "FIIs",
    type: "fund",
    subType: "fii",
    description: "Fundos imobiliários",
  },
  {
    id: "etfs",
    label: "ETFs",
    type: "fund",
    subType: "etf",
    description: "Fundos de índice",
  },
  {
    id: "bdrs",
    label: "BDRs",
    type: "bdr",
    subType: "bdr",
    description: "Recibos de ativos estrangeiros",
  },
];

function formatPrice(value?: number) {
  return value == null
    ? "--"
    : value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function formatPercent(value?: number) {
  return value == null
    ? "--"
    : `${value >= 0 ? "+" : ""}${value.toFixed(2).replace(".", ",")}%`;
}
function formatCompact(value?: number) {
  return !value
    ? "--"
    : new Intl.NumberFormat("pt-BR", {
        notation: "compact",
        maximumFractionDigits: 2,
      }).format(value);
}
function formatDate(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
}
function formatFinancialVolume(volume?: number) {
  if (!volume) return "--";
  if (volume >= 1e9) {
    return `R$ ${(volume / 1e9).toFixed(2).replace(".", ",")} Bi`;
  }
  if (volume >= 1e6) {
    return `R$ ${(volume / 1e6).toFixed(2).replace(".", ",")} Mi`;
  }
  if (volume >= 1e3) {
    return `R$ ${(volume / 1e3).toFixed(1).replace(".", ",")} mil`;
  }
  return `R$ ${volume.toFixed(2).replace(".", ",")}`;
}
function getB3MarketStatus() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    weekday: "short",
  });
  const parts = formatter.formatToParts(now);
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";

  const isWeekend = weekday === "Sat" || weekday === "Sun";
  const timeNum = hour * 100 + minute;
  // B3 regular trading session: 10:00 to 18:00 Brasília time on weekdays
  const isOpen = !isWeekend && timeNum >= 1000 && timeNum < 1800;

  return {
    isOpen,
    statusText: isOpen ? "B3 ABERTA" : "B3 FECHADA",
    badgeText: isOpen ? "PREGÃO EM ANDAMENTO" : "MERCADO FECHADO",
    subText: isOpen
      ? "Cotações com delay regulatório de ~15min (API pública)."
      : "Fora do horário de pregão (10h às 18h). Exibindo cotações do último fechamento consolidado.",
    syncNotice: isOpen ? "Ao Vivo (15s)" : "Atualizar (15s)",
  };
}
function getCategory(id: Category) {
  return categories.find((category) => category.id === id) ?? categories[0];
}

// ── MT5 Real-Time WebSocket Hook ───────────────────────────────────────────
const MT5_URL = "ws://localhost:8765";

type MT5Status = "idle" | "connecting" | "connected" | "error" | "closed";

function useMT5Feed(enabled: boolean) {
  const [mt5Stocks, setMt5Stocks] = useState<Asset[]>([]);
  const [mt5Status, setMt5Status] = useState<MT5Status>("idle");
  const [mt5LastUpdate, setMt5LastUpdate] = useState<Date | null>(null);
  const [mt5MarketOpen, setMt5MarketOpen] = useState<boolean | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    setMt5Status("connecting");
    const ws = new WebSocket(MT5_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setMt5Status("connected");
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as {
          type: string;
          stocks?: Asset[];
          is_open?: boolean;
          status?: string;
        };
        if (data.type === "snapshot" && data.stocks) {
          setMt5Stocks(data.stocks);
          setMt5LastUpdate(new Date());
        } else if (data.type === "market_status") {
          setMt5MarketOpen(data.is_open ?? null);
        }
      } catch {
        // ignore malformed messages
      }
    };

    ws.onerror = () => {
      setMt5Status("error");
    };

    ws.onclose = () => {
      setMt5Status("closed");
      wsRef.current = null;
      // Auto-reconnect after 5 seconds
      if (enabled) {
        reconnectRef.current = setTimeout(connect, 5000);
      }
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      wsRef.current?.close();
      setMt5Status("idle");
      setMt5Stocks([]);
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      return;
    }
    connect();
    return () => {
      wsRef.current?.close();
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
    };
  }, [enabled, connect]);

  return { mt5Stocks, mt5Status, mt5LastUpdate, mt5MarketOpen };
}

async function fetchAssets(category: Category, signal: AbortSignal) {
  const selected = getCategory(category);
  const assets: Asset[] = [];
  const seen = new Set<string>();
  let page = 1;
  let totalPages = 1;
  let sectors: string[] = [];
  let totalCount = 0;
  while (page <= totalPages) {
    const response = await fetch(
      `${API_URL}?type=${selected.type}&subType=${selected.subType}&sortBy=volume&sortOrder=desc&limit=${PAGE_SIZE}&page=${page}`,
      { signal },
    );
    if (!response.ok)
      throw new Error(
        "Não foi possível carregar todos os ativos desta categoria.",
      );
    const currentPage = (await response.json()) as MarketResponse;
    for (const asset of currentPage.stocks ?? []) {
      if (!seen.has(asset.stock)) {
        seen.add(asset.stock);
        assets.push(asset);
      }
    }
    sectors = currentPage.availableSectors ?? sectors;
    totalCount = currentPage.totalCount ?? totalCount;
    totalPages =
      currentPage.totalPages ?? (currentPage.hasNextPage ? page + 1 : page);
    page += 1;
  }
  if (totalCount && assets.length < totalCount)
    throw new Error(
      `A fonte retornou ${assets.length} de ${totalCount} ativos.`,
    );
  return { assets, sectors, totalCount: totalCount || assets.length };
}

async function fetchHistory(symbol: string, range: Range, signal: AbortSignal) {
  try {
    const response = await fetch(
      `https://brapi.dev/api/v2/stocks/historical?symbols=${encodeURIComponent(symbol)}&range=${range}&interval=1d&sortOrder=asc`,
      { signal },
    );
    if (response.ok) {
      const data = (await response.json()) as HistoryResponse;
      const points = data.results?.[0]?.data?.historicalDataPrice ?? [];
      if (points.length) return points;
    }
  } catch (requestError) {
    if ((requestError as Error).name === "AbortError") throw requestError;
  }
  try {
    const legacyResponse = await fetch(
      `https://brapi.dev/api/quote/${encodeURIComponent(symbol)}?range=${range}&interval=1d`,
      { signal },
    );
    if (legacyResponse.ok) {
      const legacyData = (await legacyResponse.json()) as {
        results?: { historicalDataPrice?: HistoryPoint[] }[];
      };
      const points = legacyData.results?.[0]?.historicalDataPrice ?? [];
      if (points.length) return points.sort((a, b) => a.date - b.date);
    }
  } catch (requestError) {
    if ((requestError as Error).name === "AbortError") throw requestError;
  }
  const yahooResponse = await fetch(
    `/yahoo/v8/finance/chart/${encodeURIComponent(symbol)}.SA?range=${range}&interval=1d`,
    { signal },
  );
  if (!yahooResponse.ok)
    throw new Error("Não foi possível carregar o histórico deste ativo.");
  const yahooData = (await yahooResponse.json()) as YahooHistoryResponse;
  const result = yahooData.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  const adjusted = result?.indicators?.adjclose?.[0]?.adjclose ?? [];
  const points = timestamps
    .map((date, index) => ({
      date,
      close: closes[index] ?? undefined,
      adjustedClose: adjusted[index] ?? undefined,
    }))
    .filter((point) => point.close != null);
  if (!points.length)
    throw new Error("Histórico indisponível para este ativo.");
  return points;
}

async function fetchAssetDetails(symbol: string, signal: AbortSignal) {
  const response = await fetch(
    `${API_URL}?search=${encodeURIComponent(symbol)}&limit=10`,
    { signal },
  );
  if (!response.ok)
    throw new Error("Não foi possível carregar os dados resumidos do ativo.");
  const data = (await response.json()) as MarketResponse;
  const asset = (data.stocks ?? []).find(
    (item) => item.stock.toUpperCase() === symbol.toUpperCase(),
  );
  if (!asset) throw new Error("Ativo não encontrado na fonte de dados.");
  try {
    const quoteResponse = await fetch(
      `https://brapi.dev/api/v2/stocks/quote?symbols=${encodeURIComponent(symbol)}`,
      { signal },
    );
    if (quoteResponse.ok) {
      const quote = (await quoteResponse.json()) as QuoteV2Response;
      const quoteData = quote.results?.[0]?.data;
      if (quoteData)
        return {
          ...asset,
          close: quoteData.regularMarketPrice ?? asset.close,
          change: quoteData.regularMarketChangePercent ?? asset.change,
          volume: quoteData.regularMarketVolume ?? asset.volume,
          market_cap: quoteData.marketCap ?? asset.market_cap,
          dayHigh: quoteData.regularMarketDayHigh,
          dayLow: quoteData.regularMarketDayLow,
          fiftyTwoWeekHigh: quoteData.fiftyTwoWeekHigh,
          fiftyTwoWeekLow: quoteData.fiftyTwoWeekLow,
        };
    }
  } catch (requestError) {
    if ((requestError as Error).name === "AbortError") throw requestError;
  }
  return asset;
}

function Chart({ points }: { points: HistoryPoint[] }) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const valid = points.filter((point) => point.close != null);
  if (!valid.length)
    return (
      <div className="chart-empty">Histórico indisponível para este ativo.</div>
    );
  const values = valid.map((point) => point.adjustedClose ?? point.close ?? 0);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const width = 900;
  const height = 310;
  const chartPoints = values.map((value, index) => ({
    value,
    x: (index / Math.max(values.length - 1, 1)) * width,
    y: height - ((value - min) / Math.max(max - min, 0.01)) * (height - 24) - 12,
  }));
  const path = chartPoints.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  const first = values[0];
  const last = values[values.length - 1];
  const variation = first ? ((last - first) / first) * 100 : 0;
  return (
    <div className="chart-wrap">
      <div
        className={`chart-result ${variation >= 0 ? "positive-text" : "negative-text"}`}
      >
        {formatPercent(variation)} no período
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Gráfico histórico de preços"
      >
        <path
          className="chart-area"
          d={`${path} L ${width} ${height} L 0 ${height} Z`}
        />
        <path className="chart-line" d={path} />
        {hoveredIndex != null && (() => {
          const point = chartPoints[hoveredIndex];
          const tooltipX = Math.min(Math.max(point.x - 80, 8), width - 168);
          return <g className="chart-tooltip"><line x1={point.x} y1="0" x2={point.x} y2={height} /><circle cx={point.x} cy={point.y} r="5" /><rect x={tooltipX} y="10" width="160" height="48" rx="3" /><text x={tooltipX + 10} y="29">{formatDate(valid[hoveredIndex].date)}</text><text x={tooltipX + 10} y="47">{formatPrice(point.value)}</text></g>;
        })()}
        {chartPoints.map((point, index) => <circle key={valid[index].date} className="chart-hit-area" cx={point.x} cy={point.y} r="12" onMouseEnter={() => setHoveredIndex(index)} onMouseLeave={() => setHoveredIndex(null)} onFocus={() => setHoveredIndex(index)} onBlur={() => setHoveredIndex(null)} tabIndex={0} aria-label={`${formatDate(valid[index].date)}: ${formatPrice(point.value)}`} />)}
      </svg>
      <div className="chart-axis">
        <span>{formatDate(valid[0].date)}</span>
        <span>{formatDate(valid[Math.floor(valid.length / 2)].date)}</span>
        <span>{formatDate(valid[valid.length - 1].date)}</span>
      </div>
    </div>
  );
}

function DetailPage({
  symbol,
  onBack,
}: {
  symbol: string;
  onBack: () => void;
}) {
  const [range, setRange] = useState<Range>("1y");
  const [points, setPoints] = useState<HistoryPoint[]>([]);
  const [asset, setAsset] = useState<Asset | undefined>();
  const [historyLoading, setHistoryLoading] = useState(true);
  const [assetLoading, setAssetLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [assetError, setAssetError] = useState("");
  const historyRequestId = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    const currentRequest = historyRequestId.current + 1;
    historyRequestId.current = currentRequest;
    setHistoryLoading(true);
    setHistoryError("");
    void fetchHistory(symbol, range, controller.signal)
      .then((history) => {
        if (currentRequest === historyRequestId.current) setPoints(history);
      })
      .catch((requestError) => {
        if (
          (requestError as Error).name !== "AbortError" &&
          currentRequest === historyRequestId.current
        )
          setHistoryError("Não foi possível carregar o histórico deste ativo.");
      })
      .finally(() => {
        if (currentRequest === historyRequestId.current)
          setHistoryLoading(false);
      });
    return () => controller.abort();
  }, [symbol, range]);
  useEffect(() => {
    const controller = new AbortController();
    setAssetLoading(true);
    setAssetError("");
    void fetchAssetDetails(symbol, controller.signal)
      .then((nextAsset) => setAsset(nextAsset))
      .catch((requestError) => {
        if ((requestError as Error).name !== "AbortError")
          setAssetError("Resumo indisponível no momento.");
      })
      .finally(() => setAssetLoading(false));
    return () => controller.abort();
  }, [symbol]);
  return (
    <main className="detail-page">
      <header className="detail-header">
        <button className="back-button" onClick={onBack}>
          ← Mercado
        </button>
        <span className="detail-source">Histórico diário · Brapi</span>
      </header>
      <section className="detail-heading">
        <div>
          <p className="eyebrow">DETALHE DO ATIVO</p>
          <h1>{symbol}</h1>
          <p>
            {assetLoading
              ? "Carregando informações..."
              : (asset?.name ?? assetError)}
          </p>
        </div>
        <div className="detail-price">
          <strong>{formatPrice(asset?.close)}</strong>
          <span
            className={
              (asset?.change ?? 0) >= 0 ? "positive-text" : "negative-text"
            }
          >
            {formatPercent(asset?.change)}
          </span>
        </div>
      </section>
      <div className="detail-stats">
        <div>
          <span>ÚLTIMO PREÇO</span>
          <strong>{formatPrice(asset?.close)}</strong>
        </div>
        <div>
          <span>VARIAÇÃO DO DIA</span>
          <strong
            className={
              (asset?.change ?? 0) >= 0 ? "positive-text" : "negative-text"
            }
          >
            {formatPercent(asset?.change)}
          </strong>
        </div>
        <div>
          <span>VOLUME NEGOCIADO</span>
          <strong>{formatCompact(asset?.volume)}</strong>
        </div>
        <div>
          <span>VALOR NEGOCIADO</span>
          <strong>
            R$ {formatCompact((asset?.close ?? 0) * (asset?.volume ?? 0))}
          </strong>
        </div>
        <div>
          <span>MÁXIMA / MÍNIMA DO DIA</span>
          <strong>
            {formatPrice(asset?.dayHigh)} / {formatPrice(asset?.dayLow)}
          </strong>
        </div>
        <div>
          <span>FAIXA DE 52 SEMANAS</span>
          <strong>
            {formatPrice(asset?.fiftyTwoWeekLow)} -{" "}
            {formatPrice(asset?.fiftyTwoWeekHigh)}
          </strong>
        </div>
        <div>
          <span>VALOR DE MERCADO</span>
          <strong>{formatCompact(asset?.market_cap)}</strong>
        </div>
        <div>
          <span>SETOR</span>
          <strong>{asset?.sector ?? "--"}</strong>
        </div>
      </div>
      <section className="history-panel">
        <div className="history-toolbar">
          <div>
            <h2>Histórico de preços</h2>
            <p>Fechamento ajustado quando fornecido pela fonte.</p>
          </div>
          <div className="range-tabs">
            {(["1y", "3y", "5y"] as Range[]).map((option) => (
              <button
                key={option}
                className={range === option ? "selected" : ""}
                onClick={() => setRange(option)}
              >
                {option
                  .replace("y", " ano")
                  .replace("1 ano", "1 ano")
                  .replace("3 ano", "3 anos")
                  .replace("5 ano", "5 anos")}
              </button>
            ))}
          </div>
        </div>
        {historyLoading ? (
          <div className="loading-state">
            <span className="loader" /> Carregando histórico...
          </div>
        ) : historyError ? (
          <div className="notice" role="alert">
            {historyError}
          </div>
        ) : (
          <Chart points={points} />
        )}
      </section>
    </main>
  );
}

function MarketPage({ onSelect }: { onSelect: (symbol: string) => void }) {
  const [category, setCategory] = useState<Category>("stocks");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [sectors, setSectors] = useState<string[]>([]);
  const [sector, setSector] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("value");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  const selectedCategory = getCategory(category);

  const loadAssets = async (nextCategory: Category) => {
    const currentRequest = requestId.current + 1;
    requestId.current = currentRequest;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    try {
      const result = await fetchAssets(nextCategory, controller.signal);
      if (currentRequest === requestId.current) {
        setAssets(result.assets);
        setSectors(result.sectors);
        setSector("");
      }
    } catch (requestError) {
      if (
        (requestError as Error).name !== "AbortError" &&
        currentRequest === requestId.current
      )
        setError("Não foi possível atualizar esta categoria.");
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  };
  useEffect(() => {
    void loadAssets(category);
  }, [category]);

  const filteredAssets = useMemo(() => {
    const term = query.toLowerCase().trim();
    return [...assets]
      .filter(
        (asset) =>
          (!sector || asset.sector === sector) &&
          (!term ||
            `${asset.stock} ${asset.name ?? ""} ${asset.sector ?? ""}`
              .toLowerCase()
              .includes(term)),
      )
      .sort((a, b) => {
        if (sort === "volume") return (b.volume ?? 0) - (a.volume ?? 0);
        if (sort === "changeUp")
          return (b.change ?? -Infinity) - (a.change ?? -Infinity);
        if (sort === "changeDown")
          return (a.change ?? Infinity) - (b.change ?? Infinity);
        if (sort === "name")
          return (a.name ?? a.stock).localeCompare(b.name ?? b.stock);
        return (
          (b.close ?? 0) * (b.volume ?? 0) - (a.close ?? 0) * (a.volume ?? 0)
        );
      });
  }, [assets, query, sector, sort]);

  const stats = useMemo(
    () => ({
      positive: assets.filter((asset) => (asset.change ?? 0) > 0).length,
      negative: assets.filter((asset) => (asset.change ?? 0) < 0).length,
      traded: assets.reduce(
        (total, asset) => total + (asset.close ?? 0) * (asset.volume ?? 0),
        0,
      ),
    }),
    [assets],
  );
  const marketStatus = useMemo(() => getB3MarketStatus(), []);

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#mercado" aria-label="Target Stock's início">
          <span className="brand-mark">
            <span />
          </span>
          <span>
            TARGET <strong>STOCK'S</strong>
          </span>
        </a>
        <nav className="top-nav" aria-label="Navegação principal">
          <a className="active" href="#mercado">
            Mercado
          </a>
          <a href="#rankings">Rankings</a>
          <a className="live-nav-link" href="#sobre">
            Sobre o app <span className="nav-live-badge">LIVE</span>
          </a>
        </nav>
        <div className={`market-status ${marketStatus.isOpen ? "" : "closed"}`}>
          <span className={`status-dot ${marketStatus.isOpen ? "" : "closed"}`}></span>
          {marketStatus.statusText}
        </div>
      </header>
      <section className="market-intro" id="top">
        <div>
          <p className="eyebrow">TARGET STOCK'S · SCREENER DE MERCADO</p>
          <h1>
            Mercado brasileiro,
            <br />
            <em>sem ruído.</em>
          </h1>
          <p className="hero-description">
            Compare liquidez em quantidade de papéis e em dinheiro movimentado.
            Escolha a classe correta do ativo antes de analisar.
          </p>
        </div>
        <div className="intro-note">
          <span>Fonte</span>
          <strong>Dados fornecidos pela Brapi</strong>
          <small>
            Atualizações dependem do mercado e dos limites da fonte.
          </small>
        </div>
      </section>
      <section className="content-section" id="mercado">
        <div className="category-bar">
          <div>
            <p className="eyebrow">CLASSE DO ATIVO</p>
            <h2>{selectedCategory.label}</h2>
          </div>
          <div className="category-tabs" role="tablist">
            {categories.map((item) => (
              <button
                key={item.id}
                className={category === item.id ? "selected" : ""}
                onClick={() => setCategory(item.id)}
                role="tab"
                aria-selected={category === item.id}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <p className="category-description">
        </p>
        {error && (
          <div className="notice" role="alert">
            {error}
          </div>
        )}
        <div className="market-overview">
          <div>
            <span>ATIVOS NA CATEGORIA</span>
            <strong>{assets.length || "--"}</strong>
          </div>
          <div>
            <span>EM ALTA</span>
            <strong className="positive-text">{stats.positive || "--"}</strong>
          </div>
          <div>
            <span>EM BAIXA</span>
            <strong className="negative-text">{stats.negative || "--"}</strong>
          </div>
          <div>
            <span>VALOR NEGOCIADO</span>
            <strong>R$ {formatCompact(stats.traded)}</strong>
          </div>
        </div>
        <div className="filter-panel">
          <label className="search-box">
            <span>⌕</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar ticker ou empresa"
              aria-label="Buscar ticker ou empresa"
            />
          </label>
          <label className="select-field">
            <span>Setor</span>
            <select
              value={sector}
              onChange={(event) => setSector(event.target.value)}
            >
              <option value="">Todos os setores fornecidos</option>
              {sectors.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <div className="sort-field">
            <span>Ordenar por</span>
            <div className="sort-buttons" role="group" aria-label="Ordenar ativos">
              {([
                ["value", "Valor (R$)"],
                ["volume", "Quantidade"],
                ["changeUp", "Maiores altas"],
                ["changeDown", "Maiores baixas"],
                ["name", "Nome"],
              ] as [Sort, string][]).map(([value, label]) => (
                <button key={value} className={sort === value ? "selected" : ""} onClick={() => setSort(value)} aria-pressed={sort === value}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="ranking-note">
          <span>
            {filteredAssets.length} resultado
            {filteredAssets.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="table-wrap">
          <div className="stock-table header-row">
            <span># · ATIVO</span>
            <span>PREÇO</span>
            <span>VARIAÇÃO</span>
            <span>QTD. NEGOCIADA</span>
            <span>VALOR NEGOCIADO</span>
            <span>SETOR</span>
          </div>
          {loading ? (
            <div className="loading-state">
              <span className="loader" /> Consultando{" "}
              {selectedCategory.label.toLowerCase()}...
            </div>
          ) : (
            filteredAssets.map((asset, index) => (
              <button
                className="stock-row"
                key={asset.stock}
                onClick={() => onSelect(asset.stock)}
              >
                <span className="stock-identity">
                  <span className="rank">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  {asset.logo ? (
                    <img className="ticker-icon" src={asset.logo} alt="" />
                  ) : (
                    <span className="ticker-icon">
                      {asset.stock.slice(0, 2)}
                    </span>
                  )}
                  <span>
                    <strong>{asset.stock}</strong>
                    <small>
                      {asset.name && asset.name !== asset.stock
                        ? asset.name
                        : "Ativo listado"}
                    </small>
                  </span>
                </span>
                <strong className="price">{formatPrice(asset.close)}</strong>
                <span
                  className={`change ${(asset.change ?? 0) >= 0 ? "positive" : "negative"}`}
                >
                  {formatPercent(asset.change)}
                </span>
                <span className="volume">{formatCompact(asset.volume)}</span>
                <span className="market-cap">
                  R$ {formatCompact((asset.close ?? 0) * (asset.volume ?? 0))}
                </span>
                <span className="sector">
                  {asset.sector ?? "Não informado"}
                </span>
              </button>
            ))
          )}
          {!loading && !filteredAssets.length && (
            <div className="empty-state">
              Nenhum ativo encontrado com esses filtros.
            </div>
          )}
        </div>
        <p className="disclaimer">
          Fonte: Brapi. Valor negociado é uma estimativa calculada com
          fechamento × volume informado pela fonte. Cotações podem ter atraso e
          não constituem recomendação.
        </p>
      </section>
      <footer id="rodape">
        <span>TARGET STOCK'S © 2026</span>
        <span>Dados fornecidos pela Brapi</span>
        <span>Informação para acompanhamento</span>
      </footer>
    </main>
  );
}

function LiveOverviewPage({
  onSelect,
}: {
  onSelect: (symbol: string) => void;
}) {
  const [stocks, setStocks] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [query, setQuery] = useState("");
  const [selectedType, setSelectedType] = useState<string>("all");
  const [sortKey, setSortKey] = useState<"flow" | "volume" | "gainers" | "losers">("flow");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [countdown, setCountdown] = useState(15);
  const marketStatus = useMemo(() => getB3MarketStatus(), []);

  const loadData = async (isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const response = await fetch(
        `${API_URL}?sortBy=volume&sortOrder=desc&limit=60`
      );
      if (!response.ok) throw new Error("Erro ao carregar dados do mercado ao vivo.");
      const data = (await response.json()) as MarketResponse;
      setStocks(data.stocks ?? []);
      setLastUpdated(new Date());
      setError("");
      setCountdown(15);
    } catch {
      if (!stocks.length) setError("Não foi possível carregar as negociações em tempo real da B3.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = window.setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          void loadData(false);
          return 15;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [autoRefresh]);

  const filteredStocks = useMemo(() => {
    let result = stocks.filter((stock) => {
      const q = query.trim().toLowerCase();
      const matchesQuery =
        !q ||
        stock.stock.toLowerCase().includes(q) ||
        (stock.name ?? "").toLowerCase().includes(q);
      if (!matchesQuery) return false;

      if (selectedType === "stocks") return stock.type === "stock" && stock.subType === "stock";
      if (selectedType === "fiis") return stock.subType === "fii";
      if (selectedType === "etfs") return stock.subType === "etf";
      if (selectedType === "bdrs") return stock.type === "bdr" || stock.subType === "bdr";
      return true;
    });

    return result.sort((a, b) => {
      const flowA = (a.close ?? 0) * (a.volume ?? 0);
      const flowB = (b.close ?? 0) * (b.volume ?? 0);
      if (sortKey === "flow") return flowB - flowA;
      if (sortKey === "volume") return (b.volume ?? 0) - (a.volume ?? 0);
      if (sortKey === "gainers") return (b.change ?? 0) - (a.change ?? 0);
      if (sortKey === "losers") return (a.change ?? 0) - (b.change ?? 0);
      return 0;
    });
  }, [stocks, query, selectedType, sortKey]);

  const kpis = useMemo(() => {
    const totalFlow = stocks.reduce(
      (sum, s) => sum + (s.close ?? 0) * (s.volume ?? 0),
      0
    );
    const sortedByFlow = [...stocks].sort(
      (a, b) => (b.close ?? 0) * (b.volume ?? 0) - (a.close ?? 0) * (a.volume ?? 0)
    );
    const withChange = stocks.filter((s) => s.change != null);
    const sortedByChange = [...withChange].sort(
      (a, b) => (b.change ?? 0) - (a.change ?? 0)
    );

    return {
      totalFlow,
      leader: sortedByFlow[0],
      topGainer: sortedByChange[0],
      topLoser: sortedByChange[sortedByChange.length - 1],
      count: stocks.length,
    };
  }, [stocks]);

  const top3 = useMemo(() => {
    return [...stocks]
      .sort((a, b) => (b.close ?? 0) * (b.volume ?? 0) - (a.close ?? 0) * (a.volume ?? 0))
      .slice(0, 3);
  }, [stocks]);

  return (
    <main className="live-page">
      <header className="topbar">
        <a className="brand" href="#mercado" aria-label="Target Stock's início">
          <span className="brand-mark">
            <span />
          </span>
          <span>
            TARGET <strong>STOCK'S</strong>
          </span>
        </a>
        <nav className="top-nav" aria-label="Navegação principal">
          <a href="#mercado">Mercado</a>
          <a href="#rankings">Rankings</a>
          <a className="active live-nav-link" href="#sobre">
            Sobre o app <span className="nav-live-badge">LIVE</span>
          </a>
        </nav>
        <div className={`market-status ${marketStatus.isOpen ? "" : "closed"}`}>
          <span className={`status-dot ${marketStatus.isOpen ? "" : "closed"}`}></span>
          {marketStatus.statusText}
        </div>
      </header>

      <section className="live-header-section">
        <div>
          <div className={`live-badge-wrap ${marketStatus.isOpen ? "" : "closed"}`}>
            <span className={marketStatus.isOpen ? "live-pulse-dot" : "live-closed-dot"}></span>
            <span>{marketStatus.badgeText}</span>
          </div>
          <h1>
            Ações Mais Negociadas <em>{marketStatus.isOpen ? "no Momento" : "(Último Fechamento)"}</em>
          </h1>
          <p className="hero-description">
            {marketStatus.isOpen
              ? "Monitore o fluxo financeiro em tempo de pregão e descubra quais papéis estão liderando as negociações na Bolsa agora."
              : "O pregão da B3 está encerrado no momento (horário regular: 10h às 18h). Exibindo o ranking de liquidez apurado no último fechamento da sessão."}
          </p>
        </div>

        <div className="live-sync-panel">
          <div className="live-sync-info">
            <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
              <Clock size={13} color={marketStatus.isOpen ? "#ffe600" : "#a1a1aa"} />
              {lastUpdated
                ? `Sincronizado às ${lastUpdated.toLocaleTimeString("pt-BR")}`
                : "Sincronizando..."}
            </span>
            <span>
              {autoRefresh ? `Próxima em ${countdown}s` : "Pausado"}
            </span>
          </div>

          <div className="live-sync-actions">
            <button
              className={`live-btn ${refreshing ? "loading" : ""}`}
              onClick={() => void loadData(true)}
              title="Atualizar dados agora"
            >
              <RefreshCw
                size={13}
                style={{
                  animation: refreshing ? "spin .8s linear infinite" : "none",
                }}
              />
              Atualizar
            </button>
            <button
              className={`live-btn ${autoRefresh ? (marketStatus.isOpen ? "primary" : "") : ""}`}
              onClick={() => setAutoRefresh((prev) => !prev)}
              title="Alternar sincronização automática"
            >
              <Zap size={13} />
              {autoRefresh ? (marketStatus.isOpen ? "Ao Vivo (15s)" : "Auto (15s)") : "Pausado"}
            </button>
          </div>
        </div>
      </section>

      <div className={`market-session-alert ${marketStatus.isOpen ? "" : "closed"}`}>
        <span style={{ fontSize: "14px" }}>{marketStatus.isOpen ? "⚡" : "🌙"}</span>
        <div>
          <strong>{marketStatus.statusText} · </strong>
          {marketStatus.subText}
        </div>
      </div>

      {/* KPI Cards */}
      <section className="live-kpi-grid">
        <div className="live-kpi-card">
          <span>VOLUME ESTIMADO MOVIMENTADO</span>
          <strong>{formatFinancialVolume(kpis.totalFlow)}</strong>
          <small>Soma do fluxo nos 60 ativos líderes</small>
        </div>
        <div className="live-kpi-card">
          <span>LÍDER EM VOLUME ({marketStatus.isOpen ? "AGORA" : "SESSÃO"})</span>
          <strong style={{ color: "#ffe600" }}>{kpis.leader?.stock ?? "--"}</strong>
          <small>
            {kpis.leader
              ? formatFinancialVolume((kpis.leader.close ?? 0) * (kpis.leader.volume ?? 0))
              : "--"}
          </small>
        </div>
        <div className="live-kpi-card">
          <span>MAIOR ALTA ({marketStatus.isOpen ? "DO MOMENTO" : "DA SESSÃO"})</span>
          <strong className="positive-text">
            {kpis.topGainer ? `${kpis.topGainer.stock} ${formatPercent(kpis.topGainer.change)}` : "--"}
          </strong>
          <small>{kpis.topGainer ? formatPrice(kpis.topGainer.close) : "--"}</small>
        </div>
        <div className="live-kpi-card">
          <span>MAIOR BAIXA ({marketStatus.isOpen ? "DO MOMENTO" : "DA SESSÃO"})</span>
          <strong className="negative-text">
            {kpis.topLoser ? `${kpis.topLoser.stock} ${formatPercent(kpis.topLoser.change)}` : "--"}
          </strong>
          <small>{kpis.topLoser ? formatPrice(kpis.topLoser.close) : "--"}</small>
        </div>
      </section>

      {/* Spotlight Top 3 */}
      {top3.length > 0 && (
        <section className="live-spotlight-wrap">
          <div className="live-spotlight-title">
            <Flame size={14} color="#ffe600" />
            <span>DESTAQUES DE LIQUIDEZ · TOP 3 MAIS NEGOCIADAS</span>
          </div>
          <div className="live-spotlight-grid">
            {top3.map((item, idx) => {
              const flow = (item.close ?? 0) * (item.volume ?? 0);
              return (
                <div
                  key={item.stock}
                  className="live-spotlight-card"
                  onClick={() => onSelect(item.stock)}
                  role="button"
                  tabIndex={0}
                >
                  <span className="live-spotlight-rank">#{idx + 1} MAIS NEGOCIADA</span>
                  <div className="spotlight-header">
                    <span className="ticker-icon">{item.stock.slice(0, 4)}</span>
                    <div>
                      <div className="spotlight-ticker">{item.stock}</div>
                      <div className="spotlight-name">{item.name ?? "Ação B3"}</div>
                    </div>
                  </div>
                  <div className="spotlight-price-row">
                    <span className="spotlight-price">{formatPrice(item.close)}</span>
                    <span
                      className={
                        (item.change ?? 0) >= 0 ? "positive-text" : "negative-text"
                      }
                      style={{ font: "13px 'DM Mono', monospace", fontWeight: 700 }}
                    >
                      {formatPercent(item.change)}
                    </span>
                  </div>
                  <div className="spotlight-flow">
                    <span>Fluxo Negociado:</span>
                    <strong>{formatFinancialVolume(flow)}</strong>
                  </div>
                  <div className="spotlight-cta">
                    Ver gráfico e histórico <ArrowRight size={12} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Controls & Table */}
      <section className="content-section" style={{ padding: "40px 0 0" }}>
        <div className="filter-panel" style={{ margin: "0 0 20px" }}>
          <div className="search-box">
            <Search size={16} />
            <input
              type="text"
              placeholder="Filtrar por código ou nome (ex: PETR4, VALE3)..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="sort-field">
            <span>CLASSE DO ATIVO</span>
            <div className="sort-buttons">
              {[
                { id: "all", label: "Todas" },
                { id: "stocks", label: "Ações" },
                { id: "fiis", label: "FIIs" },
                { id: "etfs", label: "ETFs" },
                { id: "bdrs", label: "BDRs" },
              ].map((tab) => (
                <button
                  key={tab.id}
                  className={selectedType === tab.id ? "selected" : ""}
                  onClick={() => setSelectedType(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="sort-field">
            <span>ORDENAR POR</span>
            <div className="sort-buttons">
              {[
                { id: "flow", label: "Volume R$" },
                { id: "volume", label: "Qtd Papéis" },
                { id: "gainers", label: "Maiores Altas" },
                { id: "losers", label: "Maiores Baixas" },
              ].map((opt) => (
                <button
                  key={opt.id}
                  className={sortKey === opt.id ? "selected" : ""}
                  onClick={() => setSortKey(opt.id as any)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Table */}
        <div className="table-wrap">
          <div className="live-header-row">
            <span>ATIVO</span>
            <span>PREÇO</span>
            <span>VARIAÇÃO</span>
            <span>VOLUME FINANCEIRO (R$)</span>
            <span>QTD NEGOCIADA</span>
            <span>SETOR</span>
          </div>

          {loading ? (
            <div className="loading-state">
              <span className="loader" /> Carregando negociações ao vivo da B3...
            </div>
          ) : error ? (
            <div className="empty-state">{error}</div>
          ) : filteredStocks.length === 0 ? (
            <div className="empty-state">
              Nenhuma ação encontrada com os filtros selecionados.
            </div>
          ) : (
            filteredStocks.map((stock, index) => {
              const flow = (stock.close ?? 0) * (stock.volume ?? 0);
              return (
                <button
                  key={stock.stock}
                  className="live-stock-row"
                  onClick={() => onSelect(stock.stock)}
                >
                  <div className="stock-identity">
                    <span className="rank">{index + 1}</span>
                    <span className="ticker-icon">{stock.stock.slice(0, 4)}</span>
                    <span>
                      <strong>{stock.stock}</strong>
                      <small>{stock.name ?? "--"}</small>
                    </span>
                  </div>

                  <span className="price">{formatPrice(stock.close)}</span>

                  <span
                    className={
                      (stock.change ?? 0) >= 0 ? "positive" : "negative"
                    }
                  >
                    {formatPercent(stock.change)}
                  </span>

                  <span className="financial-flow-col">
                    {formatFinancialVolume(flow)}
                  </span>

                  <span className="volume">
                    {formatCompact(stock.volume)} papéis
                  </span>

                  <span className="sector">{stock.sector ?? "Geral"}</span>
                </button>
              );
            })
          )}
        </div>
      </section>

      {/* About App Info Section */}
      <section className="about-section-wrap" id="sobre-info">
        <div className="about-header">
          <p className="eyebrow">TARGET STOCK'S · INFORMAÇÕES</p>
          <h3>Sobre o app e o monitoramento do mercado</h3>
          <p>Entenda como as cotações e o ranking de liquidez são calculados no Target Stock's.</p>
        </div>

        <div className="about-grid">
          <div className="about-card">
            <strong>Monitoramento com atualização automática</strong>
            <p>
              O Target Stock's acompanha os ativos mais líquidos da B3 e os ordena pelo fluxo financeiro estimado (preço informado pela fonte multiplicado pelo volume do pregão).
            </p>
          </div>
          <div className="about-card">
            <strong>Fonte de Dados Confiável</strong>
            <p>
              As cotações e métricas são obtidas pela API da brapi. O painel consulta a fonte a cada 15 segundos ou sob demanda; isso não elimina o atraso da própria fonte.
            </p>
          </div>
          <div className="about-card">
            <strong>Horário de Pregão B3</strong>
            <p>
              O pregão regular opera de segunda a sexta, das 10h00 às 17h00 / 18h00. Fora deste horário, os valores exibidos correspondem ao fechamento consolidado mais recente.
            </p>
          </div>
        </div>
      </section>

      <footer>
        <span>TARGET STOCK'S © 2026 · MONITOR AO VIVO</span>
        <a href="#mercado" style={{ color: "#ffe600", textDecoration: "underline" }}>
          ← Voltar para a Visão Geral de Mercado
        </a>
        <span>Dados fornecidos por Brapi</span>
      </footer>
    </main>
  );
}

function App() {
  const [route, setRoute] = useState<{
    page: "market" | "live" | "detail";
    symbol: string;
  }>(() => {
    const hash = window.location.hash;
    if (hash.startsWith("#acao/")) {
      return { page: "detail", symbol: hash.slice(6).toUpperCase() };
    }
    if (hash === "#sobre" || hash === "#aovivo" || hash === "#live") {
      return { page: "live", symbol: "" };
    }
    return { page: "market", symbol: "" };
  });

  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash;
      if (hash.startsWith("#acao/")) {
        setRoute({ page: "detail", symbol: hash.slice(6).toUpperCase() });
      } else if (hash === "#sobre" || hash === "#aovivo" || hash === "#live") {
        setRoute({ page: "live", symbol: "" });
      } else {
        setRoute({ page: "market", symbol: "" });
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const openDetail = (symbol: string) => {
    window.location.hash = `acao/${symbol}`;
  };

  const backToMarket = () => {
    window.location.hash = "mercado";
  };

  if (route.page === "detail") {
    return <DetailPage symbol={route.symbol} onBack={backToMarket} />;
  }
  if (route.page === "live") {
    return <LiveOverviewPage onSelect={openDetail} />;
  }
  return <MarketPage onSelect={openDetail} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
