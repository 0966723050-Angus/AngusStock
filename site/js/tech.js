/* 技術分析：K 線（均線／EMA13／布林／SAR）＋成交量、MACD、KD、J、RSI、E-Ray；左上角下拉選擇自選股 */
(function () {
  "use strict";

  const GROUP = "ta";
  const OPT_KEY = "angus.ta.overlays";
  const PER_KEY = "angus.ta.period";
  const PERIODS = [["d", "日K"], ["w", "週K"], ["m", "月K"]];
  // 預設顯示根數：日 K 手機約 3 個月、桌機約半年；週 K 約 1～2 年；月 K 約 4～5 年
  const DEFAULT_SPAN = (per) => (window.innerWidth < 700 ? { d: 60, w: 52, m: 48 } : { d: 125, w: 104, m: 60 })[per || "d"];
  const charts = [];
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const fmt = (v, d = 2) => (v == null || !isFinite(v) ? "--" : Number(v).toLocaleString("zh-TW", { minimumFractionDigits: d, maximumFractionDigits: d }));
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ------------------------------------------------------------ 指標計算
  const TA = {
    sma(a, n) {
      const out = Array(a.length).fill(null);
      let s = 0;
      for (let i = 0; i < a.length; i++) {
        s += a[i];
        if (i >= n) s -= a[i - n];
        if (i >= n - 1) out[i] = s / n;
      }
      return out;
    },
    // EMA：以第一筆收盤為起始值（與參考數據一致）
    ema(a, n) {
      const k = 2 / (n + 1), out = [];
      a.forEach((x, i) => out.push(i === 0 || out[i - 1] == null ? x : out[i - 1] + k * (x - out[i - 1])));
      return out;
    },
    // 布林：20 日、母體標準差 ×2
    boll(c, n = 20, k = 2) {
      const mid = TA.sma(c, n), sd = Array(c.length).fill(null);
      for (let i = n - 1; i < c.length; i++) {
        const w = c.slice(i - n + 1, i + 1), m = mid[i];
        sd[i] = Math.sqrt(w.reduce((s, x) => s + (x - m) ** 2, 0) / n);
      }
      return { mid, sd, up: mid.map((m, i) => (m == null ? null : m + k * sd[i])), lo: mid.map((m, i) => (m == null ? null : m - k * sd[i])) };
    },
    macd(c) {
      const e12 = TA.ema(c, 12), e26 = TA.ema(c, 26);
      const dif = e12.map((x, i) => x - e26[i]);
      const sig = TA.ema(dif, 9);
      return { dif, sig, hist: dif.map((x, i) => x - sig[i]) };
    },
    // KD：RSV 9 日，K、D 以 1/3 平滑，起始 50；J = 3K − 2D
    kd(h, l, c, n = 9) {
      let K = 50, D = 50;
      const k = [], d = [], j = [];
      for (let i = 0; i < c.length; i++) {
        if (i >= n - 1) {
          const hh = Math.max(...h.slice(i - n + 1, i + 1)), ll = Math.min(...l.slice(i - n + 1, i + 1));
          const rsv = hh > ll ? ((c[i] - ll) / (hh - ll)) * 100 : 50;
          K = (K * 2) / 3 + rsv / 3;
          D = (D * 2) / 3 + K / 3;
        }
        k.push(K); d.push(D); j.push(3 * K - 2 * D);
      }
      return { k, d, j };
    },
    // RSI：Wilder 平滑
    rsi(c, n) {
      const out = Array(c.length).fill(null);
      let g = 0, l = 0;
      for (let i = 1; i < c.length; i++) {
        const ch = c[i] - c[i - 1], up = Math.max(ch, 0), dn = Math.max(-ch, 0);
        if (i <= n) { g += up / n; l += dn / n; } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; }
        if (i >= n) out[i] = g + l ? (100 * g) / (g + l) : 50;
      }
      return out;
    },
    // 拋物線 SAR（AF 0.02 起、每次 +0.02、上限 0.2）
    sar(h, l, c, step = 0.02, max = 0.2) {
      const n = c.length, sar = Array(n).fill(null), up = Array(n).fill(null);
      if (n < 3) return { sar, up };
      let isUp = c[1] >= c[0], af = step, ep = isUp ? Math.max(h[0], h[1]) : Math.min(l[0], l[1]);
      let s = isUp ? Math.min(l[0], l[1]) : Math.max(h[0], h[1]);
      for (let i = 2; i < n; i++) {
        s = s + af * (ep - s);
        if (isUp) {
          s = Math.min(s, l[i - 1], l[i - 2]);
          if (l[i] < s) { isUp = false; s = ep; ep = l[i]; af = step; }
          else if (h[i] > ep) { ep = h[i]; af = Math.min(af + step, max); }
        } else {
          s = Math.max(s, h[i - 1], h[i - 2]);
          if (h[i] > s) { isUp = true; s = ep; ep = h[i]; af = step; }
          else if (l[i] < ep) { ep = l[i]; af = Math.min(af + step, max); }
        }
        sar[i] = s; up[i] = isUp;
      }
      return { sar, up };
    },
  };

  function compute(rows) {
    const d = rows.map((r) => r[0]), o = rows.map((r) => r[1]), h = rows.map((r) => r[2]),
      l = rows.map((r) => r[3]), c = rows.map((r) => r[4]), v = rows.map((r) => r[5]);
    const e13 = TA.ema(c, 13);
    const s = TA.sar(h, l, c);
    // DMA：SMA20 向後位移 5 日；AMA = 收盤 − DMA；另計 AMA 的 5 日平均
    const ma20 = TA.sma(c, 20);
    const dma = c.map((_, i) => (i >= 5 ? ma20[i - 5] : null));
    const ama = c.map((x, i) => (dma[i] == null ? null : x - dma[i]));
    const amaMa5 = ama.map((_, i) => (i >= 4 && ama.slice(i - 4, i + 1).every((x) => x != null) ? ama.slice(i - 4, i + 1).reduce((a, b) => a + b, 0) / 5 : null));
    return {
      d, o, h, l, c, v, chg: rows.map((r) => (r[6] == null ? null : r[6])),
      ma5: TA.sma(c, 5), ma10: TA.sma(c, 10), ma20, ma50: TA.sma(c, 50), ma100: TA.sma(c, 100), dma, ama, amaMa5,
      vma5: TA.sma(v, 5), e12: TA.ema(c, 12), e26: TA.ema(c, 26), e13,
      boll: TA.boll(c), macd: TA.macd(c), kd: TA.kd(h, l, c), rsi6: TA.rsi(c, 6), rsi12: TA.rsi(c, 12),
      sarUp: s.sar.map((x, i) => (s.up[i] ? x : null)), sarDn: s.sar.map((x, i) => (s.up[i] === false ? x : null)),
      bull: h.map((x, i) => x - e13[i]), bear: l.map((x, i) => x - e13[i]),
    };
  }

  // ------------------------------------------------------------ 資料（快取＋證交所即時補當月）
  async function liveMonth(code) {
    const now = new Date(Date.now() + 8 * 3600e3); // 台北日期
    const ym = now.toISOString().slice(0, 7).replace("-", "");
    const key = `angus.ta.live.${code}.${ym}`;
    try {
      const hit = JSON.parse(sessionStorage.getItem(key) || "null");
      if (hit && Date.now() - hit.t < 10 * 60e3) return hit.rows;
    } catch (e) { /* ignore */ }
    const r = await fetch(`https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${ym}01&stockNo=${encodeURIComponent(code)}`, { cache: "no-store" });
    const j = await r.json();
    if (j.stat !== "OK") return [];
    const n = (x) => { const v = parseFloat(String(x).replace(/[,X+]/g, "")); return isFinite(v) ? v : null; };
    const rows = j.data.map((x) => {
      const [y, m, dd] = x[0].split("/");
      return [`${+y + 1911}-${m}-${dd}`, n(x[3]), n(x[4]), n(x[5]), n(x[6]), Math.round((n(x[1]) || 0) / 1000), n(x[7])];
    }).filter((x) => x[4] != null);
    try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), rows })); } catch (e) { /* ignore */ }
    return rows;
  }

  // ------------------------------------------------------------ 圖表
  const LINES = [
    { key: "up", label: "上布林" }, { key: "lo", label: "下布林" }, { key: "ma5", label: "MA5" }, { key: "ma10", label: "MA10" },
    { key: "ma20", label: "MA20" }, { key: "ma50", label: "MA50" }, { key: "sarUp", label: "SAR多" }, { key: "sarDn", label: "SAR空" }, { key: "ema", label: "EMA" },
    { key: "vp", label: "成交量分佈" },
  ];
  // ------------------------------------------------------------ 斐波那契回調（Fibonacci Retracement）
  // localStorage "angus.fib"：{ ratios: [23.6, ...], lines: { 代號: { a: { d, p }, b: { d, p } } } }
  // a＝起點、b＝終點（以日期記錄，價格已對齊該日最高或最低價）；各比例價位＝b －（b － a）× 比例
  const FIB_KEY = "angus.fib";
  const FIB_DEF = [23.6, 38.2, 50, 61.8, 78.6, 100];
  const FIB_COLORS = ["#8a8a8a", "#e53935", "#fb8c00", "#2e9d4f", "#1e88e5", "#8e24aa", "#6d4c41", "#00897b", "#c2185b"];
  function fibLoad() {
    try {
      const v = JSON.parse(localStorage.getItem(FIB_KEY) || "{}");
      return { ratios: Array.isArray(v.ratios) && v.ratios.length ? v.ratios : FIB_DEF.slice(), lines: v.lines || {} };
    } catch (e) { return { ratios: FIB_DEF.slice(), lines: {} }; }
  }
  const fibSave = (f) => { try { localStorage.setItem(FIB_KEY, JSON.stringify(f)); } catch (e) { /* ignore */ } };
  // 繪製用：{ ia, pa, ib?, pb?, levels: [[比例, 價格]] }（以目前資料的索引表示）
  function fibPlan(t, line, ratios) {
    if (!line || !line.a) return null;
    // 週／月 K：找日期所在的那一根（各根日期為該期最後交易日）
    const at = (d) => t.d.findIndex((x) => x >= d);
    const ia = at(line.a.d);
    if (ia < 0) return null;
    const out = { ia, pa: line.a.p };
    if (line.b) {
      const ib = at(line.b.d);
      if (ib < 0) return null;
      Object.assign(out, { ib, pb: line.b.p });
      out.levels = [0, ...ratios].map((r) => [r, line.b.p - (line.b.p - line.a.p) * r / 100]);
    }
    return out;
  }

  // ------------------------------------------------------------ 週 K／月 K
  // 日 K 依週（週一起算）或月合併：日期標為該期最後交易日；漲跌（期貨）為各日漲跌合計
  const iso = (dt) => dt.toISOString().slice(0, 10);
  const weekKey = (d) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return iso(x); };
  const perKey = (per, d) => (per === "w" ? weekKey(d) : d.slice(0, 7));
  function aggregate(rows, per) {
    const out = [];
    let cur = null;
    for (const r of rows) {
      const k = perKey(per, r[0]);
      if (!cur || cur.k !== k) {
        cur = { k, r: [r[0], r[1], r[2], r[3], r[4], r[5], r[6]] };
        out.push(cur);
      } else {
        const a = cur.r;
        a[0] = r[0]; a[2] = Math.max(a[2], r[2]); a[3] = Math.min(a[3], r[3]); a[4] = r[4];
        a[5] = a[5] == null || r[5] == null ? null : +(a[5] + r[5]).toFixed(2);
        a[6] = a[6] == null || r[6] == null ? null : +(a[6] + r[6]).toFixed(2);
      }
    }
    return out;
  }
  // 較早的週／月 K 由 Yahoo Finance 補齊（經 Apps Script；同一工作階段快取 6 小時）
  async function history(code, meta, per) {
    const sym = code === "t00" ? "^TWII" : code === "o00" ? "^TWOII"
      : meta.market === "tse" ? `${code}.TW` : meta.market === "otc" ? `${code}.TWO` : null;
    if (!sym || !(await App.hasLive())) return [];
    const key = `angus.ta.k.${sym}.${per}`;
    try {
      const hit = JSON.parse(sessionStorage.getItem(key) || "null");
      if (hit && Date.now() - hit.t < 6 * 3600e3) return hit.rows;
    } catch (e) { /* ignore */ }
    const j = await App.live({ t: "kline", s: sym, i: per === "w" ? "1wk" : "1mo" }, 2);
    const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
    const idx = meta.market === "idx";
    const rows = (j.rows || []).map((r) => [r[0], r2(r[1]), r2(r[2]), r2(r[3]), r2(r[4]), idx || r[5] == null ? null : Math.round(r[5] / 1000)]);
    try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), rows })); } catch (e) { /* ignore */ }
    return rows;
  }
  async function periodRows(rows, code, meta, per) {
    const local = aggregate(rows, per);
    if (!local.length) return { rows: [], note: "" };
    let older = [];
    try { older = await history(code, meta, per); } catch (e) { /* 舊版中轉程式或連線失敗：只用網站資料 */ }
    const first = local[0].k;
    // 網站資料的第一期可能不完整（資料由期中開始），有 Yahoo 資料時改用 Yahoo 的該期
    const old = older.filter((r) => perKey(per, r[0]) <= first && r[4] != null).map((r) => {
      const k = perKey(per, r[0]), d = new Date(k + (per === "w" ? "" : "-01") + "T00:00:00Z");
      if (per === "w") d.setUTCDate(d.getUTCDate() + 4); else { d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); }
      return { k, r: [iso(d), r[1], r[2], r[3], r[4], r[5], null] };
    });
    const ks = new Set(old.map((x) => x.k));
    const merged = old.concat(local.filter((x) => !ks.has(x.k)));
    const name = PERIODS.find((p) => p[0] === per)[1];
    return { rows: merged.map((x) => x.r), note: `${name} ${merged.length} 根` + (old.length ? "（較早資料來源：Yahoo Finance）" : "") };
  }
  // 日期顯示：月 K 只顯示年月
  const dLabel = (t, d) => (t.per === "m" ? d.slice(0, 7) : d);

  // ------------------------------------------------------------ 乖離率（BIAS）＝（收盤 − 均線）÷ 均線 × 100%
  // localStorage "angus.ta.bias"：{ ma: 5｜20｜50, range: { 5: 5, 20: 10, 50: 15 } }（range 為正負範圍 %）
  const BIAS_KEY = "angus.ta.bias";
  const BIAS_MA = [5, 20, 50];
  const BIAS_DEF = { 5: 5, 20: 10, 50: 15 };
  function biasLoad() {
    try {
      const v = JSON.parse(localStorage.getItem(BIAS_KEY) || "{}");
      return { ma: BIAS_MA.includes(v.ma) ? v.ma : 20, range: { ...BIAS_DEF, ...(v.range || {}) } };
    } catch (e) { return { ma: 20, range: { ...BIAS_DEF } }; }
  }
  const biasSave = (b) => { try { localStorage.setItem(BIAS_KEY, JSON.stringify(b)); } catch (e) { /* ignore */ } };
  const bias = (t, n) => { const m = t[`ma${n}`]; return t.c.map((c, i) => (m[i] == null ? null : ((c - m[i]) / m[i]) * 100)); };
  const perUnit = (t) => ({ d: "日", w: "週", m: "月" })[t.per || "d"];

  function loadOverlays() {
    const def = Object.fromEntries(LINES.map((x) => [x.key, x.key !== "vp"])); // 成交量分佈預設不顯示
    try { return { ...def, ...JSON.parse(localStorage.getItem(OPT_KEY) || "{}") }; } catch (e) { return def; }
  }

  const palette = () => ({
    up: css("--up"), down: css("--down"), text: css("--muted"), grid: css("--grid"), border: css("--border"),
    ma5: "#7b7bf0", ma10: "#3fc8e8", ma20: "#e8b64a", ma50: "#cf6fcf", ema: css("--ta-ema") || "#0b3d2e",
    boll: "#ef5fa0", sarUp: "#ff2a2a", sarDn: "#22c55e", vma: "#2250e0", dif: "#2d3be0", sig: "#f08a4b",
  });

  function baseOpt(t, P, extra) {
    return {
      animation: false,
      tooltip: { trigger: "axis", showContent: false, axisPointer: { type: "cross", label: { backgroundColor: "#555" } } },
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      ...extra,
    };
  }
  const xCat = (t, P, gridIndex = 0, show = true) => ({
    type: "category", data: t.d, gridIndex, boundaryGap: true, axisTick: { show: false },
    axisLine: { lineStyle: { color: P.border } },
    axisLabel: show ? { color: P.text, fontSize: 10, formatter: (v) => (t.per === "m" ? `${v.slice(2, 4)}/${+v.slice(5, 7)}` : `${+v.slice(5, 7)}/${+v.slice(8)}`) } : { show: false },
  });
  const yVal = (P, extra = {}) => ({ type: "value", scale: true, position: "right", splitNumber: 4,
    axisLabel: { color: P.text, fontSize: 10 }, splitLine: { lineStyle: { color: P.grid } }, ...extra });
  // symbol: "none"＋停用 emphasis：滑動十字線時不在線上顯示小圓圈
  const line = (name, data, color, extra = {}) => ({ name, type: "line", data, symbol: "none", showSymbol: false, emphasis: { disabled: true }, smooth: true, connectNulls: false,
    lineStyle: { width: 1.2, color, ...(extra.lineStyle || {}) }, itemStyle: { color }, ...extra });

  function zoomOpt(t, span, show) {
    const n = t.d.length;
    return [{ type: "slider", show, xAxisIndex: "all", startValue: Math.max(0, n - span), endValue: n - 1, height: 18, bottom: 4,
      borderColor: css("--border"), textStyle: { color: css("--muted"), fontSize: 10 }, brushSelect: false }];
  }

  function klineChart(el, t, name, ov, span, fib) {
    const P = palette();
    const c = echarts.init(el, null, { renderer: "canvas" });
    c.group = GROUP;
    const candles = t.d.map((_, i) => [i, t.o[i], t.c[i], t.l[i], t.h[i]]);
    const volColor = (i) => (i > 0 && t.c[i] < t.c[i - 1] ? P.down : P.up);
    const S = [
      // 自繪 K 棒：影線與實體共用同一個中心 x，確保影線位於實體正中間
      { name: "K線", type: "custom", data: candles, encode: { x: 0, y: [1, 2, 3, 4] }, clip: true, z: 2,
        renderItem: (params, api) => {
          const i = api.value(0), o = api.value(1), c = api.value(2), l = api.value(3), h = api.value(4);
          if ([o, c, l, h].some((v) => v == null || isNaN(v))) return null;
          const dpr = window.devicePixelRatio || 1;
          const snap = (v) => (Math.round(v * dpr) + 0.5) / dpr; // 對齊實體像素，1px 線不糊
          const x = snap(api.coord([i, c])[0]);
          const band = api.size([1, 0])[0];
          const w = Math.max(1, Math.min(18, band * 0.7));
          // 影線約 1.5 個實體像素（高解析度螢幕上約 0.5px），比實體細很多
          const wick = dpr >= 2 ? 1.5 / dpr : 1;
          const yO = api.coord([i, o])[1], yC = api.coord([i, c])[1], yH = api.coord([i, h])[1], yL = api.coord([i, l])[1];
          const color = c > o ? P.up : c < o ? P.down : (i > 0 && c < t.c[i - 1] ? P.down : P.up);
          const top = Math.min(yO, yC), bh = Math.max(1 / dpr, Math.abs(yO - yC));
          return { type: "group", children: [
            { type: "line", shape: { x1: x, y1: yH, x2: x, y2: yL }, style: { stroke: color, lineWidth: wick } },
            { type: "rect", shape: { x: x - w / 2, y: top, width: w, height: bh }, style: { fill: color } },
          ] };
        } },
    ];
    if (ov.ma5) S.push(line("MA5", t.ma5, P.ma5));
    if (ov.ma10) S.push(line("MA10", t.ma10, P.ma10));
    if (ov.ma20) S.push(line("MA20", t.ma20, P.ma20));
    if (ov.ma50) S.push(line("MA50", t.ma50, P.ma50));
    if (ov.ema) S.push(line("EMA13", t.e13, P.ema, { lineStyle: { width: 1.6 } }));
    if (ov.up) S.push(line("上布林", t.boll.up, P.boll, { lineStyle: { type: "dotted", width: 1.4 } }));
    if (ov.lo) S.push(line("下布林", t.boll.lo, P.boll, { lineStyle: { type: "dotted", width: 1.4 } }));
    if (ov.sarUp) S.push(line("SAR多", t.sarUp, P.sarUp, { smooth: false, lineStyle: { width: 1.5 } }));
    if (ov.sarDn) S.push(line("SAR空", t.sarDn, P.sarDn, { smooth: false, lineStyle: { width: 1.5 } }));
    // 成交量分佈：在 K 棒右側（或左側）保留專用空間，價格刻度移到分佈外側
    let vpL = null, vpRight = true;
    if (ov.vp && window.VP) {
      const n = t.d.length, cfg = VP.load();
      vpRight = cfg.placement !== "left";
      vpL = VP.layout(cfg, el.clientWidth || 360, span);
      S.push(...VP.attach(c, t, VP.load, Math.max(0, n - span), n - 1, (v) => fmt(v, v >= 100 ? 1 : 2), vpL));
    }
    // 斐波那契標籤放在最後一根 K 棒右側的專用空間（成交量分佈在右側時，改放在線段末端內側）
    const fibSide = !!(fib && fib.levels) && !(ov.vp && window.VP && VP.load().placement !== "left");
    const fibExtra = fibSide ? 78 : 0;
    if (fib) {
      const n = t.d.length;
      const pts = [{ coord: [fib.ia, fib.pa] }].concat(fib.ib != null ? [{ coord: [fib.ib, fib.pb] }] : []);
      const marks = [];
      if (fib.levels) {
        const x0 = Math.min(fib.ia, fib.ib);
        fib.levels.forEach(([r, v], k) => {
          const color = FIB_COLORS[k % FIB_COLORS.length];
          marks.push([{ coord: [x0, v], lineStyle: { color, type: r === 0 || r === 100 ? "solid" : "dashed", width: 1 },
            label: { show: true, position: fibSide ? "end" : "insideEndTop", color, fontSize: 10, distance: fibSide ? 4 : 2,
              formatter: `${+r.toFixed(2)}%  ${fmt(v, v >= 100 ? 1 : 2)}` } }, { coord: [n - 1, v] }]);
        });
        // 起點到終點的趨勢線
        marks.push([{ coord: [fib.ia, fib.pa], lineStyle: { color: "#8a8a8a", type: "dotted", width: 1 }, label: { show: false } }, { coord: [fib.ib, fib.pb] }]);
      }
      S.push({ name: "斐波那契", type: "line", data: [], silent: true, z: 3,
        markLine: { silent: true, symbol: "none", animation: false, data: marks },
        markPoint: { silent: true, symbol: "circle", symbolSize: 7, animation: false, label: { show: false },
          itemStyle: { color: "#fff", borderColor: "#1e88e5", borderWidth: 2 }, data: pts } });
    }
    const padR = 52 + fibExtra + (vpL && vpRight ? vpL.extra : 0), padL = 8 + (vpL && !vpRight ? vpL.extra : 0);
    const yOff = fibExtra + (vpL && vpRight ? vpL.extra : 0);
    S.push({ name: "成交量", type: "bar", xAxisIndex: 1, yAxisIndex: 1, barWidth: "70%", barMaxWidth: 18,
      data: t.v.map((v, i) => ({ value: v, itemStyle: { color: volColor(i) } })) });
    S.push(line("量MA5", t.vma5, P.vma, { xAxisIndex: 1, yAxisIndex: 1, smooth: true, lineStyle: { width: 1.2 } }));
    c.setOption(baseOpt(t, P, {
      grid: [{ left: padL, right: padR, top: 12, height: "62%" }, { left: padL, right: padR, top: "74%", bottom: 50 }],
      xAxis: [xCat(t, P, 0, false), xCat(t, P, 1, true)],
      yAxis: [yVal(P, { offset: yOff }), yVal(P, { gridIndex: 1, offset: yOff, splitNumber: 2, axisLabel: { color: P.text, fontSize: 10, formatter: (v) => (v >= 1e4 ? +(v / 1e4).toFixed(1) + "萬" : v) } })],
      dataZoom: zoomOpt(t, span, true),
      series: S,
    }));
    // 資訊列：日期、開高低收、成交量與各線數值
    c.__info = (i) => {
      // 期貨：漲跌依期交所公布值（與前一結算價比較）；其他：與前一日收盤比較
      const pct = t.useChg && t.chg[i] != null ? (t.chg[i] / (t.c[i] - t.chg[i])) * 100
        : i > 0 ? ((t.c[i] - t.c[i - 1]) / t.c[i - 1]) * 100 : null;
      const pc = pct == null ? "" : pct >= 0 ? "up" : "down";
      return `<span class="ti-date">${dLabel(t, t.d[i])}</span>` +
        `<span class="ti">開 <b>${fmt(t.o[i])}</b></span><span class="ti">高 <b>${fmt(t.h[i])}</b></span>` +
        `<span class="ti">低 <b>${fmt(t.l[i])}</b></span><span class="ti">收 <b class="${pc}">${fmt(t.c[i])}</b>` +
        (pct == null ? "" : ` <b class="${pc}">${pct >= 0 ? "+" : ""}${fmt(pct)}%</b>`) + `</span>` +
        `<span class="ti">量 <b>${fmt(t.v[i], 0)}</b> ${name.unit}</span>` + chips(S.filter((x) => x.type === "line"), i);
    };
    return c;
  }

  function subChart(el, t, span, build) {
    const P = palette();
    const c = echarts.init(el);
    c.group = GROUP;
    const { series, yAxis = {}, marks, legend } = build(P);
    c.setOption(baseOpt(t, P, {
      grid: { left: Array.isArray(yAxis) ? 48 : 8, right: 52, top: 12, bottom: 26 },
      xAxis: xCat(t, P),
      yAxis: Array.isArray(yAxis) ? yAxis.map((y) => yVal(P, y)) : yVal(P, yAxis),
      dataZoom: zoomOpt(t, span, false),
      series: series.concat(marks ? [{ type: "line", data: [], markLine: { silent: true, symbol: "none", label: { show: false }, data: marks } }] : []),
      tooltip: { trigger: "axis", showContent: false, axisPointer: { type: "line" } },
    }));
    c.__info = (i) => `<span class="ti-date">${dLabel(t, t.d[i])}</span>` + chips(series, i);
    return c;
  }
  // 資訊列中每個數列的「色塊＋名稱＋數值」
  function chips(series, i) {
    return series.filter((s) => s.name).map((s) => {
      const d = s.data[i];
      const v = d != null && typeof d === "object" && !Array.isArray(d) ? d.value : d;
      if (v == null) return "";
      const color = (d && d.itemStyle && d.itemStyle.color) || (s.lineStyle && s.lineStyle.color) || (s.itemStyle && s.itemStyle.color);
      return `<span class="ti"><i style="background:${color}"></i>${esc(s.name)} <b>${fmt(v, Math.abs(v) >= 1e4 ? 0 : 2)}</b></span>`;
    }).join("");
  }
  const hline = (y, color, type = "dotted", width = 2) => ({ yAxis: y, lineStyle: { color, type, width } });

  // ------------------------------------------------------------ 左側指標表
  // day：日 K 指標（52 週最高／最低一律以日 K 計算）
  function panel(t, meta, day) {
    const i = t.d.length - 1, p = i - 1;
    const b = t.boll, pos = b.sd[i] ? ((t.c[i] - b.mid[i]) / (b.up[i] - b.mid[i])) * 100 : null;
    const bbw = b.lo[i] ? ((b.up[i] - b.lo[i]) / b.lo[i]) * 100 : null;
    const n250 = Math.max(0, day.d.length - 250);
    const hi52 = Math.max(...day.h.slice(n250)), lo52 = Math.min(...day.l.slice(n250));
    const turnover = meta.shares && meta.market !== "idx" ? (t.v[i] * 1000 / meta.shares) * 100 : null;
    const r = (label, cls, a, bb = "", c2 = "") => `<tr><th class="${cls}">${label}</th><td class="${c2}">${a}</td><td>${bb}</td></tr>`;
    const sg = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
    // 依今日數值由大到小排列（無值者置底）
    const sorted = (rows) => rows.slice().sort((x, y) => (y.v ?? -Infinity) - (x.v ?? -Infinity)).map((x) => x.html).join("");
    const item = (v, label, cls, bb = "", c2 = "") => ({ v, html: r(label, cls, fmt(v), bb, c2) });
    const posTxt = pos == null ? "" : `<b class="${sg(pos)}">${fmt(pos, 0)}%</b>`;
    return `
      <table class="ta-tbl">
        <thead><tr><th class="ta-date">${esc(dLabel(t, t.d[i]))}</th><th>${{ d: "今日", w: "本週", m: "本月" }[t.per]}</th><th>${{ d: "前日", w: "上週", m: "上月" }[t.per]}</th></tr></thead>
        <tbody>
          ${sorted([item(t.macd.dif[i], "MACD-快", "m1", "", sg(t.macd.dif[i])), item(t.macd.sig[i], "MACD-慢", "m2", "", sg(t.macd.sig[i]))])}
          ${r("柱狀體", "m3", fmt(t.macd.hist[i]), fmt(t.macd.hist[p]))}
          ${sorted([item(t.kd.k[i], "K-快", "k1"), item(t.kd.d[i], "D-慢", "k2")])}
          ${r("J", "k3", fmt(t.kd.j[i]), fmt(t.kd.j[p]))}
          ${sorted([item(t.rsi6[i], "RSI-快", "r1"), item(t.rsi12[i], "RSI-慢", "r2")])}
          <tr class="gap"><td colspan="3"></td></tr>
          ${sorted([item(t.c[i], "股價", "p0"), item(t.ma5[i], "SMA5", "s5"), item(t.ma10[i], "SMA10", "s10"),
                    item(t.ma20[i], "SMA20", "s20"), item(t.ma50[i], "SMA50", "s60"), item(t.ma100[i], "SMA100", "s120")])}
          ${r("Vol-MA5", "v5", fmt(t.vma5[i], 0))}
          ${r("EMA12", "e1", fmt(t.e12[i]))}
          ${r("EMA26", "e1", fmt(t.e26[i]))}
          ${r("EMA13", "e1", fmt(t.e13[i]))}
          <tr class="gap"><td colspan="3"></td></tr>
          ${sorted([item(b.up[i], "上布林", "b1"), item(t.c[i], "股價", "p0", posTxt), item(b.mid[i], "中線", "b2"), item(b.lo[i], "下布林", "b1")])}
          ${r("標準差", "b3", fmt(b.sd[i]))}
          ${r("BBW", "b3", bbw == null ? "--" : fmt(bbw) + "%")}
          ${r("52週最高價", "w1", fmt(hi52))}
          ${r("52週最低價", "w1", fmt(lo52))}
          ${r("DMA", "w2", fmt(t.dma[i]))}
          ${r("AMA", "w2", fmt(t.ama[i]), "", sg(t.ama[i]))}
          ${r("SAR", "w2", fmt(t.sarUp[i] ?? t.sarDn[i]), t.sarUp[i] != null ? '<b class="up">多</b>' : '<b class="down">空</b>')}
          ${r("周轉率", "w2", turnover == null ? "--" : fmt(turnover) + "%")}
          <tr class="gap"><td colspan="3"></td></tr>
          ${BIAS_MA.map((n) => { const b = bias(t, n); return r(`乖離率(${n})`, "w1", b[i] == null ? "--" : fmt(b[i]) + "%", b[p] == null ? "--" : fmt(b[p]) + "%", sg(b[i])); }).join("")}
        </tbody>
      </table>`;
  }

  // ------------------------------------------------------------ 頁面
  // K 線圖左上名稱：名稱較長時在括號或「-」處分成兩行（例：台指期近月／(日盤)），避免擠壓右側按鈕
  function badgeName(name) {
    const n = String(name || "");
    const m = n.match(/^(.{2,}?)([（(].*|-KY|-創)$/);
    if (n.length > 5 && m) return `${esc(m[1])}<small>${esc(m[2])}</small>`;
    return esc(n);
  }

  let renderSeq = 0; // 連續切換（週期、股票）時，只保留最後一次的繪製
  async function render(view, params) {
    const seq = ++renderSeq;
    while (charts.length) charts.pop().dispose();
    echarts.disconnect(GROUP);
    const [data, wl] = await Promise.all([App.loadData("ohlc"), App.loadData("watchlist").catch(() => null)]);
    const list = ((wl && wl.items) || Object.keys(data.stocks)).filter((c) => data.stocks[c]);
    let code = params.get("code") || "";
    if (!data.stocks[code]) code = code.toUpperCase();
    // 非自選股（例如由股票篩選點入）：載入全市場個股日 K 檔，並放在下拉選單最上方
    if (code && !data.stocks[code]) {
      try { data.stocks[code] = await App.loadData(`hist/${code}`); list.unshift(code); } catch (e) { /* 無此股票 */ }
    }
    if (!data.stocks[code]) code = list.find((c) => c !== "t00" && c !== "o00") || list[0];
    if (!code) { view.innerHTML = '<div class="card empty">尚無自選股資料</div>'; return; }
    const meta = data.stocks[code];
    meta.unit = meta.vol_unit;

    // 開啟時向證交所下載當月最新成交資訊（上市股票；上櫃因櫃買中心限制使用網站資料）
    let rows = meta.rows.slice(), liveNote = "";
    if (meta.market === "tse") {
      try {
        const live = await liveMonth(code);
        if (live.length) {
          const map = new Map(rows.map((r) => [r[0], r]));
          live.forEach((r) => map.set(r[0], r));
          rows = [...map.keys()].sort().map((k) => map.get(k));
          liveNote = `已由證交所更新至 ${live[live.length - 1][0]}`;
        }
      } catch (e) { liveNote = "證交所連線失敗，使用網站資料"; }
    } else if (meta.market === "otc") {
      liveNote = "上櫃資料來源：櫃買中心（網站排程更新）";
    } else if (meta.market === "fut") {
      liveNote = code === "TXF1N"
        ? "期交所近月連續日K（夜盤；日期為夜盤開始日，漲跌與前一結算價比較）"
        : "期交所近月連續日K（日盤；漲跌與前一結算價比較）";
    }
    let per = "d";
    try { per = localStorage.getItem(PER_KEY) || "d"; } catch (e) { /* ignore */ }
    if (!PERIODS.some((p) => p[0] === per)) per = "d";
    const day = compute(rows);
    let t = day;
    if (per !== "d") {
      const pr = await periodRows(rows, code, meta, per);
      if (pr.rows.length >= 2) { t = compute(pr.rows); liveNote = pr.note + (liveNote ? "；" + liveNote : ""); } else per = "d";
    }
    if (seq !== renderSeq || !view.isConnected) return;
    t.per = per; day.per = "d";
    t.useChg = meta.market === "fut";
    let span = Math.min(DEFAULT_SPAN(per), t.d.length);
    let biasCfg = biasLoad();
    const ov = loadOverlays();

    const tech = document.createElement("a");
    tech.className = "action-btn";
    tech.href = `#/stock?code=${encodeURIComponent(code)}`;
    tech.innerHTML = "<span>個股<span class=\"lg\">資訊</span></span>";
    const acts = document.createElement("span");
    acts.className = "action-group";
    if (meta.market === "tse" || meta.market === "otc") acts.appendChild(tech);
    const star = document.createElement("button");
    star.type = "button";
    star.className = "action-btn";
    const setStar = (inList) => {
      star.disabled = inList;
      star.innerHTML = inList ? "<span>★ 已自選</span>" : "<span>＋ 自選</span>";
      star.title = inList ? "已在自選股中" : "加入自選股";
    };
    Watch.list().then((w) => setStar(w.items.includes(code))).catch(() => setStar(list.includes(code) && !!wl));
    star.addEventListener("click", async () => {
      if (App.isUpdating()) { App.toast("資料更新中，請稍候再加入"); return; }
      star.disabled = true;
      try {
        const added = await Watch.add(code);
        setStar(true);
        App.toast(added ? `已將 ${meta.name} 加入自選股` : `${meta.name} 已在自選股中`);
      } catch (e) { star.disabled = false; App.toast("加入失敗：" + (e.message || e)); }
    });
    acts.appendChild(star);
    App.setAction(acts);
    App.setUpdated(data.updated);
    document.title = `${meta.name} 技術分析｜Angus 股市`;

    view.innerHTML = `
      <div class="ta-top">
        <label class="ta-select"><span class="sr-only">選擇自選股</span>
          <select id="taStock">${list.map((c) => `<option value="${esc(c)}" ${c === code ? "selected" : ""}>${esc(data.stocks[c].name)}${c.length === 3 ? "" : " " + esc(c)}</option>`).join("")}</select>
        </label>
        <span class="seg ta-per" role="group" aria-label="K 線週期">${PERIODS.map(([k, n]) => `<button type="button" data-per="${k}" aria-pressed="${k === per}">${n}</button>`).join("")}</span>
        <span class="muted small">${esc(liveNote)}</span>
      </div>
      <div class="ta-grid">
        <aside class="card ta-panel"><div class="ta-name">${esc(meta.name)}</div>${panel(t, meta, day)}</aside>
        <article class="card ta-main">
          <div class="ta-head">
            <span class="ta-badge">${badgeName(meta.name)}</span>
            <span class="ta-tools">
              <button type="button" class="fib-btn" data-fib="draw" aria-pressed="false" title="斐波那契回調：在 K 線圖上依序點選起點與終點">斐波那契</button>
              <button type="button" class="fib-btn fib-gear" data-fib="set" aria-label="斐波那契設定" title="比例設定／清除">⚙</button>
            </span>
            <span class="ta-zoom">
              <button type="button" class="zbtn zin" data-z="in" aria-label="放大">＋</button>
              <button type="button" class="zbtn zout" data-z="out" aria-label="縮小">－</button>
            </span>
          </div>
          <div class="fib-hint" hidden></div>
          <div class="ta-info" data-for="0"></div>
          <div class="chart ta-k" id="taK"></div>
          <div class="ta-checks">${LINES.map((x) => `<label><input type="checkbox" data-k="${x.key}" ${ov[x.key] ? "checked" : ""}> ${x.label}</label>` +
            (x.key === "vp" ? '<button type="button" class="vp-gear" aria-label="成交量分佈參數設定">⚙ 設定</button>' : "")).join("")}</div>
        </article>
      </div>
      <div class="ta-subs">
        ${[["MACD", "taMacd"], ["KD", "taKd"], ["J", "taJ"], ["RSI", "taRsi"], ["DMA", "taDma"], ["E-Ray Index", "taEray"]].map(([n, id]) => `
          <article class="card"><div class="chart-title"><span class="tag t1">${n}</span></div><div class="ta-info" data-id="${id}"></div><div class="chart ta-sub" id="${id}"></div></article>`).join("")}
        <article class="card"><div class="chart-title"><span class="tag t1">乖離率</span>
          <span class="bias-tools"><span class="seg bias-ma" role="group" aria-label="乖離率均線">${BIAS_MA.map((n) => `<button type="button" data-ma="${n}" aria-pressed="${n === biasCfg.ma}">${n}${perUnit(t)}</button>`).join("")}</span>
          <button type="button" class="fib-btn fib-gear bias-gear" aria-label="乖離率範圍設定" title="正負範圍設定">⚙</button></span></div>
          <div class="ta-info" data-id="taBias"></div><div class="chart ta-sub" id="taBias"></div></article>
      </div>
      <p class="muted small note">K 線可切換日K／週K／月K（週 K 以週一起算，各根日期為該期最後交易日；所有指標依所選週期計算，52 週最高／最低一律以日 K 計算）。日 K 預設顯示近 3 個月（手機）／半年（電腦）；點選圖表可在上方資訊列查看該日數值，可用 ＋／－ 或下方拖曳條調整區間（所有圖表同步）。EMA 週期 13；布林 20 日 ±2 標準差；KD 9 日；RSI 6／12 日；DMA 為 SMA20 向後位移 5 日，AMA = 收盤 − DMA；E-Ray 為 Elder Ray（最高／最低價 − EMA13）；乖離率 =（收盤 − 均線）÷ 均線 × 100%，可選 5／20／50 均線，虛線為設定的正負範圍。</p>`;

    const kEl = view.querySelector("#taK");
    // 斐波那契：mode 0＝一般、1＝等待點選起點、2＝等待點選終點
    let fibCfg = fibLoad(), fibMode = 0, fibTmp = null;
    const fibNow = () => fibPlan(t, fibMode === 2 ? { a: fibTmp } : fibCfg.lines[code], fibCfg.ratios);
    const hint = view.querySelector(".fib-hint"), fibBtn = view.querySelector('[data-fib="draw"]');
    const setMode = (m) => {
      fibMode = m;
      fibBtn.setAttribute("aria-pressed", String(m > 0));
      hint.hidden = m === 0;
      hint.textContent = m === 1 ? "斐波那契：請在 K 線圖上點選起點（例如波段最低點）" : m === 2 ? "請點選終點（例如波段最高點）" : "";
    };
    // K 線圖點選：換算成第幾根 K 棒，價格對齊該根的最高或最低價（取較接近點選位置者）
    const bindFib = (c) => {
      c.getZr().on("click", (e) => {
        if (!fibMode || !c.containPixel({ gridIndex: 0 }, [e.offsetX, e.offsetY])) return;
        const [x] = c.convertFromPixel({ gridIndex: 0 }, [e.offsetX, e.offsetY]);
        const i = Math.max(0, Math.min(t.d.length - 1, Math.round(x)));
        const yH = c.convertToPixel({ gridIndex: 0 }, [i, t.h[i]])[1], yL = c.convertToPixel({ gridIndex: 0 }, [i, t.l[i]])[1];
        const pt = { d: t.d[i], p: Math.abs(e.offsetY - yH) <= Math.abs(e.offsetY - yL) ? t.h[i] : t.l[i] };
        if (fibMode === 1) { fibTmp = pt; setMode(2); redrawK(); return; }
        if (pt.d === fibTmp.d && pt.p === fibTmp.p) return; // 同一點不成立
        fibCfg = fibLoad();
        fibCfg.lines[code] = { a: fibTmp, b: pt };
        fibSave(fibCfg);
        fibTmp = null;
        setMode(0);
        redrawK();
      });
    };
    const draw = () => {
      while (charts.length) charts.pop().dispose();
      charts.push(klineChart(kEl, t, meta, ov, span, fibNow()));
      bindFib(charts[0]);
      charts.push(subChart(view.querySelector("#taMacd"), t, span, (P) => ({
        legend: true,
        series: [
          { name: "柱狀體", type: "bar", barWidth: "70%", barMaxWidth: 16, itemStyle: { color: "#ff2020" }, data: t.macd.hist.map((v, i) => {
            const prev = i > 0 ? t.macd.hist[i - 1] : v;
            const style = v >= 0 ? { color: P.up } : v < prev ? { color: "#2e7d32" } : { color: css("--surface"), borderColor: css("--text-2"), borderWidth: 1 };
            return { value: v, itemStyle: style };
          }) },
          line("MACD-快", t.macd.dif, P.dif, { markPoint: { symbol: "circle", symbolSize: 10, itemStyle: { color: "#4caf28" }, label: { show: false },
            data: t.macd.dif.map((v, i) => (i > 0 && t.macd.dif[i - 1] <= t.macd.sig[i - 1] && v > t.macd.sig[i] ? { coord: [i, v] } : null)).filter(Boolean) } }),
          line("MACD-慢", t.macd.sig, P.sig),
        ],
        marks: [hline(0, css("--text"), "solid", 1.5)],
      })));
      charts.push(subChart(view.querySelector("#taKd"), t, span, (P) => ({
        legend: true, yAxis: { min: 0, max: 100, scale: false },
        series: [line("K-快", t.kd.k, "#1f3fe0"), line("D-慢", t.kd.d, "#f5b800")],
        marks: [hline(80, "#e02020"), hline(20, "#e02020")],
      })));
      charts.push(subChart(view.querySelector("#taJ"), t, span, () => ({
        series: [line("J", t.kd.j, "#ff3fa0")], marks: [hline(0, "#1f3fe0")],
      })));
      charts.push(subChart(view.querySelector("#taRsi"), t, span, () => ({
        legend: true, yAxis: { min: 0, max: 100, scale: false },
        series: [
          line("RSI-快(6)", t.rsi6, "#1f1fe0", { markArea: { silent: true, data: [
            [{ yAxis: 50, itemStyle: { color: "rgba(255,105,180,.15)" } }, { yAxis: 80 }],
            [{ yAxis: 20, itemStyle: { color: "rgba(50,205,50,.13)" } }, { yAxis: 50 }]] } }),
          line("RSI-慢(12)", t.rsi12, "#f5a000"),
        ],
        marks: [hline(70, "#e02020"), hline(50, "#1f3fe0"), hline(30, "#d05050")],
      })));
      charts.push(subChart(view.querySelector("#taDma"), t, span, (P) => ({
        legend: true,
        yAxis: [{ position: "left" }, { position: "right", splitLine: { show: false } }],
        series: [
          { name: "AMA", type: "bar", yAxisIndex: 1, barWidth: "70%", barMaxWidth: 16, itemStyle: { color: "#ff2020" }, data: t.ama.map((v) => (v == null ? null : { value: v, itemStyle: { color: v >= 0 ? "#ff2020" : "#18e018" } })) },
          line("DMA", t.dma, "#f5b800", { lineStyle: { width: 1.4 } }),
          line("股價", t.c, "#a0309a", { lineStyle: { width: 1.4 } }),
          line("AMA 5日均", t.amaMa5, "#1f3fe0", { yAxisIndex: 1, lineStyle: { type: "dotted", width: 1.6 } }),
        ],
      })));
      charts.push(subChart(view.querySelector("#taEray"), t, span, (P) => ({
        legend: true,
        series: [
          { name: "多方力道", type: "bar", barWidth: "70%", barMaxWidth: 16, itemStyle: { color: "#ff2020" }, data: t.bull.map((v) => ({ value: v, itemStyle: { color: v >= 0 ? "#ff2020" : "#0a9f4a" } })) },
          { name: "空方力道", type: "bar", barGap: "-100%", itemStyle: { color: "#3cf03c" }, barWidth: "70%", barMaxWidth: 16, data: t.bear.map((v) => ({ value: v < 0 ? v : null, itemStyle: { color: "#3cf03c" } })) },
        ],
        marks: [hline(0, css("--text"), "solid", 1)],
      })));
      charts.push(biasChart());
      echarts.connect(GROUP);
      bindInfo();
    };
    // 乖離率：0 軸＋正負範圍虛線
    const biasChart = () => {
      const n = biasCfg.ma, rg = Math.abs(Number(biasCfg.range[n]) || BIAS_DEF[n]), b = bias(t, n);
      return subChart(view.querySelector("#taBias"), t, span, (P) => ({
        legend: true,
        series: [line(`乖離率(${n}${perUnit(t)})`, b, "#1f3fe0", { smooth: false })],
        marks: [hline(0, css("--text"), "solid", 1), { ...hline(rg, P.up, "dashed", 1.2), label: { show: true, position: "insideEndTop", formatter: `+${rg}%`, color: P.up, fontSize: 10 } },
          { ...hline(-rg, P.down, "dashed", 1.2), label: { show: true, position: "insideEndBottom", formatter: `−${rg}%`, color: P.down, fontSize: 10 } }],
        yAxis: { axisLabel: { color: P.text, fontSize: 10, formatter: (v) => v + "%" } },
      }));
    };
    const redrawBias = () => {
      const k = charts.findIndex((c) => c.getDom().id === "taBias");
      if (k < 0) return;
      const cur = charts[0].getOption().dataZoom[0];
      charts[k].dispose();
      charts[k] = biasChart();
      charts[k].dispatchAction({ type: "dataZoom", startValue: cur.startValue, endValue: cur.endValue });
      echarts.connect(GROUP);
      bindInfo();
    };
    const last = t.d.length - 1;
    const setInfo = (i) => {
      charts.forEach((c) => {
        const box = c.getDom() === kEl ? view.querySelector('.ta-info[data-for="0"]') : view.querySelector(`.ta-info[data-id="${c.getDom().id}"]`);
        if (box && c.__info) box.innerHTML = c.__info(Math.max(0, Math.min(last, i)));
      });
    };
    const bindInfo = () => {
      charts.forEach((c) => {
        if (c.__bound) return;
        c.__bound = true;
        c.on("updateAxisPointer", (e) => {
          const ax = (e.axesInfo || []).find((a) => a.axisDim === "x");
          if (ax && ax.value != null) setInfo(ax.value);
        });
        c.getZr().on("globalout", () => setInfo(last));
      });
      setInfo(last);
    };
    draw();

    // 切換週期：重新繪製整頁（指標依新週期重算）
    view.querySelector(".ta-per").addEventListener("click", (e) => {
      const k = e.target.closest("[data-per]")?.dataset.per;
      if (!k || k === per) return;
      try { localStorage.setItem(PER_KEY, k); } catch (err) { /* ignore */ }
      view.querySelectorAll(".ta-per button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.per === k)));
      render(view, params);
    });
    view.querySelector(".bias-ma").addEventListener("click", (e) => {
      const n = +e.target.closest("[data-ma]")?.dataset.ma;
      if (!n || n === biasCfg.ma) return;
      biasCfg = { ...biasLoad(), ma: n };
      biasSave(biasCfg);
      view.querySelectorAll(".bias-ma button").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.ma === n)));
      redrawBias();
    });
    view.querySelector(".bias-gear").addEventListener("click", () => {
      const el = document.createElement("div");
      el.className = "sheet";
      el.innerHTML = `
        <header class="sheet-head">
          <button type="button" class="sheet-btn" data-act="cancel">取消</button>
          <h2>乖離率範圍</h2>
          <button type="button" class="sheet-btn strong" data-act="save">儲存</button>
        </header>
        <div class="sheet-body"><form class="lg-form" autocomplete="off">
          ${BIAS_MA.map((n) => `<label>${n} 均線 正負範圍（%）<input name="r${n}" type="number" inputmode="decimal" step="0.5" min="0.5" max="100" value="${biasCfg.range[n]}"></label>`).join("")}
          <button type="button" class="btn-ghost" data-act="reset">恢復預設（${BIAS_MA.map((n) => "±" + BIAS_DEF[n]).join("／")}）</button>
          <p class="muted small">乖離率圖上的虛線為 ±範圍；超過正範圍代表股價高於均線過多（過熱），低於負範圍代表低於均線過多（超跌）。</p>
        </form></div>`;
      document.body.appendChild(el);
      document.body.classList.add("no-scroll");
      const close = () => { el.remove(); if (!document.querySelector(".sheet")) document.body.classList.remove("no-scroll"); };
      el.addEventListener("click", (ev) => {
        const a = ev.target.closest("[data-act]")?.dataset.act;
        if (a === "cancel") close();
        if (a === "reset") BIAS_MA.forEach((n) => { el.querySelector(`[name=r${n}]`).value = BIAS_DEF[n]; });
        if (a === "save") {
          const range = {};
          for (const n of BIAS_MA) {
            const v = Math.abs(parseFloat(el.querySelector(`[name=r${n}]`).value));
            if (!isFinite(v) || v <= 0 || v > 100) { App.toast(`${n} 均線的範圍請輸入 0～100 之間的數字`); return; }
            range[n] = v;
          }
          biasCfg = { ...biasLoad(), range };
          biasSave(biasCfg);
          close();
          redrawBias();
        }
      });
    });
    view.querySelector("#taStock").addEventListener("change", (e) => { location.hash = `#/tech?code=${encodeURIComponent(e.target.value)}`; });
    const redrawK = () => {
      const cur = charts[0].getOption().dataZoom[0];
      span = cur.endValue - cur.startValue + 1;
      charts[0].dispose(); charts[0] = klineChart(kEl, t, meta, ov, span, fibNow());
      bindFib(charts[0]);
      charts[0].dispatchAction({ type: "dataZoom", startValue: cur.startValue, endValue: cur.endValue });
      echarts.connect(GROUP);
      bindInfo();
    };
    view.querySelector(".ta-checks").addEventListener("change", (e) => {
      const k = e.target.dataset.k;
      if (!k) return;
      ov[k] = e.target.checked;
      try { localStorage.setItem(OPT_KEY, JSON.stringify(ov)); } catch (err) { /* ignore */ }
      redrawK();
    });
    view.querySelector(".vp-gear").addEventListener("click", () => VP.openSettings(() => {
      if (!ov.vp) { ov.vp = true; view.querySelector('[data-k="vp"]').checked = true; try { localStorage.setItem(OPT_KEY, JSON.stringify(ov)); } catch (err) { /* ignore */ } }
      redrawK();
    }));
    view.querySelector(".ta-tools").addEventListener("click", (e) => {
      const act = e.target.closest("[data-fib]")?.dataset.fib;
      if (act === "draw") {
        if (fibMode) { fibTmp = null; setMode(0); redrawK(); return; } // 再按一次取消
        setMode(1);
      }
      if (act === "set") openFibSettings();
    });
    // 比例設定、清除目前股票的斐波那契線
    const openFibSettings = () => {
      const el = document.createElement("div");
      el.className = "sheet";
      el.innerHTML = `
        <header class="sheet-head">
          <button type="button" class="sheet-btn" data-act="cancel">取消</button>
          <h2>斐波那契回調</h2>
          <button type="button" class="sheet-btn strong" data-act="save">儲存</button>
        </header>
        <div class="sheet-body"><form class="lg-form fib-form" autocomplete="off">
          <label class="full">回調比例（%，以逗號分隔）<input name="ratios" value="${fibCfg.ratios.join(", ")}" inputmode="decimal">
            <small>預設：${FIB_DEF.join("、")}；0% 線一律顯示。價位＝終點 －（終點 － 起點）× 比例</small></label>
          <button type="button" class="btn-ghost" data-act="reset">恢復預設比例</button>
          <button type="button" class="btn-danger" data-act="clear"${fibCfg.lines[code] ? "" : " disabled"}>清除 ${esc(meta.name)} 的斐波那契線</button>
          <p class="muted small">使用方式：按 K 線圖右上「斐波那契」，在圖上依序點選起點與終點（自動對齊該日最高或最低價），即畫出各比例價位；再按一次「斐波那契」可取消點選。每檔股票各自保存。</p>
        </form></div>`;
      document.body.appendChild(el);
      document.body.classList.add("no-scroll");
      const close = () => { el.remove(); if (!document.querySelector(".sheet")) document.body.classList.remove("no-scroll"); };
      el.addEventListener("click", (ev) => {
        const a = ev.target.closest("[data-act]")?.dataset.act;
        if (a === "cancel") close();
        if (a === "reset") el.querySelector("[name=ratios]").value = FIB_DEF.join(", ");
        if (a === "clear") { fibCfg = fibLoad(); delete fibCfg.lines[code]; fibSave(fibCfg); close(); redrawK(); App.toast("已清除斐波那契線"); }
        if (a === "save") {
          const r = [...new Set(el.querySelector("[name=ratios]").value.split(/[,，、\s]+/).map(Number).filter((x) => isFinite(x) && x > 0 && x <= 500))].sort((x, y) => x - y);
          if (!r.length) { App.toast("請輸入至少一個比例"); return; }
          fibCfg = fibLoad(); fibCfg.ratios = r; fibSave(fibCfg);
          close(); redrawK();
        }
      });
    };
    view.querySelector(".ta-zoom").addEventListener("click", (e) => {
      const z = e.target.closest("[data-z]")?.dataset.z;
      if (!z) return;
      const cur = charts[0].getOption().dataZoom[0];
      const n = t.d.length, end = cur.endValue;
      const s = cur.endValue - cur.startValue + 1;
      const next = z === "in" ? Math.max(20, Math.round(s * 0.7)) : Math.min(n, Math.round(s / 0.7));
      charts[0].dispatchAction({ type: "dataZoom", startValue: Math.max(0, end - next + 1), endValue: end });
    });
  }

  window.addEventListener("resize", () => charts.forEach((c) => c.resize()));
  App.register({ id: "tech", title: "技術分析", icon: "📈", render });
})();
