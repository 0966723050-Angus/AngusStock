/* 成交量分佈（Volume Profile）：計算、繪製於 K 線圖右側（或左側），並提供參數設定 */
(function () {
  "use strict";

  const KEY = "angus.ta.vp";
  const DEFAULTS = {
    upColor: "#9e9e9e", downColor: "#d0d0d0",          // 數值區外：上漲量／下跌量
    vaUpColor: "#5b7cf6", vaDownColor: "#f2c55c",      // 數值區內：上漲量／下跌量
    sentiment: false, bullColor: "#26a69a", bearColor: "#ef5350",
    zones: false, zoneThreshold: 15, supplyColor: "#ef9a9a", demandColor: "#90caf9",
    poc: "last", pocColor: "#e5533d", pocWidth: 2,     // none | last | developing
    valueArea: 100,
    vah: true, vahColor: "#3b5bfd", vahWidth: 1,
    val: true, valColor: "#3b5bfd", valWidth: 1,
    polarity: "bar",                                   // bar | pressure
    range: "visible", length: 360,                     // visible | fixed
    priceLevels: true, labelSize: "small",
    placement: "right", rows: 100, width: 31, offset: 4,
    vaBg: false, vaBgColor: "#5b7cf6",
    rangeBg: false, rangeBgColor: "#9e9e9e",
  };

  function load() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch (e) { return { ...DEFAULTS }; }
  }
  function save(cfg) {
    try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
  }

  const rgba = (hex, a) => {
    const h = hex.replace("#", "");
    const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ------------------------------------------------------------ 計算
  function compute(t, s, e, cfg) {
    const n = t.d.length;
    const from = cfg.range === "fixed" ? Math.max(0, n - Math.max(2, +cfg.length || 360)) : Math.max(0, s);
    const to = cfg.range === "fixed" ? n - 1 : Math.min(n - 1, e);
    let lo = Infinity, hi = -Infinity;
    for (let i = from; i <= to; i++) { lo = Math.min(lo, t.l[i]); hi = Math.max(hi, t.h[i]); }
    if (!isFinite(lo) || !isFinite(hi)) return null;
    if (hi === lo) { hi += 0.5; lo -= 0.5; }
    const R = clamp(Math.round(+cfg.rows || 100), 10, 400);
    const step = (hi - lo) / R;
    const up = Array(R).fill(0), dn = Array(R).fill(0), dpoc = [];
    const rowOf = (p) => clamp(Math.floor((p - lo) / step), 0, R - 1);
    for (let i = from; i <= to; i++) {
      const v = t.v[i];
      if (!v) continue;
      let buy, sell;
      if (cfg.polarity === "pressure" && t.h[i] > t.l[i]) {
        buy = (v * (t.c[i] - t.l[i])) / (t.h[i] - t.l[i]);
        sell = v - buy;
      } else {
        const isUp = t.c[i] > t.o[i] || (t.c[i] === t.o[i] && i > 0 && t.c[i] >= t.c[i - 1]);
        buy = isUp ? v : 0; sell = isUp ? 0 : v;
      }
      const a = t.l[i], b = t.h[i];
      if (b <= a) {
        const r = rowOf(a); up[r] += buy; dn[r] += sell;
      } else {
        for (let r = rowOf(a); r <= rowOf(b); r++) {
          const ov = Math.min(b, lo + (r + 1) * step) - Math.max(a, lo + r * step);
          if (ov > 0) { const f = ov / (b - a); up[r] += buy * f; dn[r] += sell * f; }
        }
      }
      if (cfg.poc === "developing") {
        let m = 0;
        for (let r = 1; r < R; r++) if (up[r] + dn[r] > up[m] + dn[m]) m = r;
        dpoc.push([i, lo + (m + 0.5) * step]);
      }
    }
    const tot = up.map((x, r) => x + dn[r]);
    const total = tot.reduce((a, b) => a + b, 0);
    if (!total) return null;
    let poc = 0;
    tot.forEach((x, r) => { if (x > tot[poc]) poc = r; });
    // 數值區：自 POC 向上下擴張，每次加入量較大的一側，直到達設定比例
    const target = (total * clamp(+cfg.valueArea || 70, 1, 100)) / 100;
    let vl = poc, vh = poc, acc = tot[poc];
    while (acc < target && (vl > 0 || vh < R - 1)) {
      const above = vh < R - 1 ? tot[vh + 1] : -1, below = vl > 0 ? tot[vl - 1] : -1;
      if (above >= below) { vh++; acc += above; } else { vl--; acc += below; }
    }
    const net = up.map((x, r) => x - dn[r]);
    return {
      from, to, lo, hi, step, R, up, dn, tot, net, dpoc,
      maxTot: Math.max(...tot), maxNet: Math.max(1, ...net.map(Math.abs)),
      poc, pocPrice: lo + (poc + 0.5) * step, vl, vh, vah: lo + (vh + 1) * step, val: lo + vl * step,
    };
  }

  // ------------------------------------------------------------ 版面：分佈區放在最後一根 K 棒右側（或第一根左側），不與 K 棒重疊
  // chartWidth：K 線圖寬度；span：可視 K 棒數；回傳分佈區寬度 W、與 K 棒間距 gap、需額外保留的邊界 extra（px）
  function layout(cfg, chartWidth, span) {
    // 手機（窄螢幕）時分佈寬度自動縮為 60%，讓 K 棒保有足夠空間
    const pct = clamp(+cfg.width || 31, 5, 60) * (chartWidth < 600 ? 0.6 : 1);
    const W = Math.round((chartWidth * pct) / 100);
    const plot = Math.max(80, chartWidth - 60 - W);
    const gap = Math.round(((+cfg.offset || 0) * plot) / Math.max(1, span + (+cfg.offset || 0)));
    return { W, gap, extra: W + gap + 4 };
  }

  // 分佈區在畫布上的水平位置
  function region(cs, L, right) {
    const x0 = right ? cs.x + cs.width + L.gap : cs.x - L.gap - L.W;
    return { x0, x1: x0 + L.W };
  }

  // ------------------------------------------------------------ 繪製（ECharts custom series）
  function series(t, getCfg, state) {
    return {
      id: "vp", type: "custom", xAxisIndex: 0, yAxisIndex: 0, z: 1, silent: true, clip: false,
      tooltip: { show: false }, data: [[state.end, state.mid]], encode: { x: 0, y: 1 },
      renderItem: (params, api) => {
        const P = state.profile, cfg = getCfg(), L = state.layout;
        if (!P || !L) return null;
        const cs = params.coordSys;
        const right = cfg.placement !== "left";
        const { x0, x1 } = region(cs, L, right);
        const band = api.size([1, 0])[0];
        const Yraw = (p) => api.coord([P.to, p])[1];
        const Y = (p) => clamp(Yraw(p), cs.y, cs.y + cs.height); // 不超出 K 線圖上下緣
        const xFrom = Math.max(cs.x, api.coord([P.from, P.hi])[0] - band / 2);
        const ch = [];
        const rect = (x, y, w, h, fill) => ch.push({ type: "rect", shape: { x, y, width: Math.max(0, w), height: Math.max(0, h) }, style: { fill } });

        // 背景（半透明、位於 K 棒下層）：計算範圍、數值區、供需區
        if (cfg.rangeBg) rect(xFrom, Y(P.hi), x1 - xFrom, Y(P.lo) - Y(P.hi), rgba(cfg.rangeBgColor, 0.1));
        if (cfg.vaBg) rect(xFrom, Y(P.vah), x1 - xFrom, Y(P.val) - Y(P.vah), rgba(cfg.vaBgColor, 0.12));
        if (cfg.zones) {
          const thr = (P.maxTot * clamp(+cfg.zoneThreshold || 15, 1, 100)) / 100;
          const last = t.c[P.to];
          let r = 0;
          while (r < P.R) {
            if (P.tot[r] < thr) {
              let r2 = r;
              while (r2 + 1 < P.R && P.tot[r2 + 1] < thr) r2++;
              const pLo = P.lo + r * P.step, pHi = P.lo + (r2 + 1) * P.step;
              const color = (pLo + pHi) / 2 >= last ? cfg.supplyColor : cfg.demandColor;
              rect(xFrom, Y(pHi), x1 - xFrom, Y(pLo) - Y(pHi), rgba(color, 0.22));
              r = r2 + 1;
            } else r++;
          }
        }

        // 分佈橫條：開啟情緒分佈時，分佈佔 2/3、情緒佔 1/3（靠 K 棒一側）
        const sentW = cfg.sentiment ? L.W / 3 : 0;
        const barW = L.W - sentW;
        for (let r = 0; r < P.R; r++) {
          if (!P.tot[r]) continue;
          const yTop = Yraw(P.lo + (r + 1) * P.step), yBot = Yraw(P.lo + r * P.step);
          if (yBot < cs.y || yTop > cs.y + cs.height) continue;
          const h = Math.max(1, Math.abs(yBot - yTop) - (Math.abs(yBot - yTop) > 3 ? 1 : 0));
          const inVA = r >= P.vl && r <= P.vh;
          const uc = rgba(inVA ? cfg.vaUpColor : cfg.upColor, 0.85), dc = rgba(inVA ? cfg.vaDownColor : cfg.downColor, 0.85);
          const uw = (P.up[r] / P.maxTot) * barW, dw = (P.dn[r] / P.maxTot) * barW;
          if (right) { rect(x1 - uw, yTop, uw, h, uc); rect(x1 - uw - dw, yTop, dw, h, dc); }
          else { rect(x0, yTop, uw, h, uc); rect(x0 + uw, yTop, dw, h, dc); }
          if (sentW && P.net[r]) {
            const sw = (Math.abs(P.net[r]) / P.maxNet) * (sentW - 4);
            const sc = rgba(P.net[r] > 0 ? cfg.bullColor : cfg.bearColor, 0.8);
            if (right) rect(x0, yTop, sw, h, sc); else rect(x1 - sw, yTop, sw, h, sc);
          }
        }
        return { type: "group", children: ch };
      },
    };
  }

  // POC、VAH、VAL 線與價位標籤：只畫在分佈區內，不穿過 K 棒
  function overlay(t, getCfg, state, fmt) {
    return {
      id: "vp-lines", type: "custom", xAxisIndex: 0, yAxisIndex: 0, z: 5, silent: true, clip: false,
      tooltip: { show: false }, data: [[state.end, state.mid]], encode: { x: 0, y: 1 },
      renderItem: (params, api) => {
        const P = state.profile, cfg = getCfg(), L = state.layout;
        if (!P || !L) return null;
        const cs = params.coordSys;
        const right = cfg.placement !== "left";
        const { x0, x1 } = region(cs, L, right);
        const inside = (y) => y >= cs.y && y <= cs.y + cs.height;
        const Y = (p) => api.coord([P.to, p])[1];
        const ch = [];
        const hline = (y, color, width, dashed) => { if (inside(y)) ch.push({ type: "line", shape: { x1: x0, y1: y, x2: x1, y2: y }, style: { stroke: color, lineWidth: width, lineDash: dashed ? [4, 3] : null } }); };
        const fontSize = { small: 10, normal: 12, large: 14 }[cfg.labelSize] || 10;
        const label = (y, text, color) => {
          if (!inside(y)) return;
          const above = y - fontSize - 6 >= cs.y;
          ch.push({ type: "text", x: right ? x1 - 2 : x0 + 2, y: above ? y - 2 : y + 2,
            style: { text, fill: color, font: `bold ${fontSize}px sans-serif`, align: right ? "right" : "left",
              verticalAlign: above ? "bottom" : "top", backgroundColor: "rgba(255,255,255,.85)", padding: [1, 3], borderRadius: 3 } });
        };
        const pocY = Y(cfg.poc === "developing" && P.dpoc.length ? P.dpoc[P.dpoc.length - 1][1] : P.pocPrice);
        if (cfg.poc !== "none") hline(pocY, cfg.pocColor, +cfg.pocWidth || 2, false);
        if (cfg.vah) hline(Y(P.vah), cfg.vahColor, +cfg.vahWidth || 1, true);
        if (cfg.val) hline(Y(P.val), cfg.valColor, +cfg.valWidth || 1, true);
        if (cfg.priceLevels) {
          if (cfg.poc !== "none") label(pocY, `POC ${fmt(P.pocPrice)}`, cfg.pocColor);
          if (cfg.vah) label(Y(P.vah), `VAH ${fmt(P.vah)}`, cfg.vahColor);
          if (cfg.val) label(Y(P.val), `VAL ${fmt(P.val)}`, cfg.valColor);
        }
        return { type: "group", children: ch };
      },
    };
  }

  // 綁到 K 線圖：初次計算，並於縮放／拖曳後重新計算可視範圍的分佈
  function attach(chart, t, getCfg, start, end, fmt, L) {
    const state = { profile: null, layout: L, end, mid: (t.h[end] + t.l[end]) / 2 };
    const recalc = (s, e) => {
      state.profile = compute(t, s, e, getCfg());
      state.end = e;
      state.mid = (t.h[e] + t.l[e]) / 2;
    };
    recalc(start, end);
    chart.on("datazoom", () => {
      const z = chart.getOption().dataZoom[0];
      recalc(z.startValue, z.endValue);
      chart.setOption({ series: [{ id: "vp", data: [[state.end, state.mid]] }, { id: "vp-lines", data: [[state.end, state.mid]] }] });
    });
    return [series(t, getCfg, state), overlay(t, getCfg, state, fmt)];
  }

  // ------------------------------------------------------------ 參數設定畫面
  const F = [
    ["section", "成交量分佈"],
    ["color2", "上漲量／下跌量", "upColor", "downColor"],
    ["color2", "數值區 上漲／下跌", "vaUpColor", "vaDownColor"],
    ["num", "數值區 Value Area (%)", "valueArea", 1, 100],
    ["select", "分佈極性計算 Polarity", "polarity", [["bar", "K 棒漲跌（Bar Polarity）"], ["pressure", "K 棒買賣壓（Buying/Selling Pressure）"]]],
    ["select", "計算範圍 Lookback Range", "range", [["visible", "可視範圍（Visible Range）"], ["fixed", "固定根數（Fixed Range）"]]],
    ["num", "固定根數 Lookback Length", "length", 10, 2000],
    ["num", "價位列數 Number of Rows", "rows", 10, 400],
    ["select", "位置 Placement", "placement", [["right", "右"], ["left", "左"]]],
    ["num", "寬度 Profile Width（佔圖寬 %）", "width", 5, 60],
    ["num", "與最後一根 K 棒間距 Offset（K 棒數）", "offset", 0, 50],
    ["section", "Point of Control / 數值區線"],
    ["select", "POC 顯示方式", "poc", [["last", "最後（直線）"], ["developing", "動態（Developing）"], ["none", "不顯示"]]],
    ["colornum", "POC 顏色／線寬", "pocColor", "pocWidth"],
    ["checkcolornum", "Value Area High (VAH)", "vah", "vahColor", "vahWidth"],
    ["checkcolornum", "Value Area Low (VAL)", "val", "valColor", "valWidth"],
    ["checkselect", "價位標籤 Price Levels", "priceLevels", "labelSize", [["small", "小"], ["normal", "中"], ["large", "大"]]],
    ["section", "情緒分佈 / 供需區 / 背景"],
    ["checkcolor2", "情緒分佈 Sentiment Profile（多／空）", "sentiment", "bullColor", "bearColor"],
    ["checkcolor2", "供需區 Supply & Demand Zones（供給／需求）", "zones", "supplyColor", "demandColor"],
    ["num", "供需區門檻 Threshold (%)", "zoneThreshold", 1, 100],
    ["checkcolor", "數值區背景 Value Area Background", "vaBg", "vaBgColor"],
    ["checkcolor", "計算範圍背景 Profile Range Background", "rangeBg", "rangeBgColor"],
  ];

  function formHtml(c) {
    const col = (k) => `<input type="color" data-f="${k}" value="${c[k]}">`;
    const num = (k, a, b) => `<input type="number" data-f="${k}" value="${c[k]}" min="${a}" max="${b}" inputmode="numeric">`;
    const chk = (k) => `<input type="checkbox" data-f="${k}" ${c[k] ? "checked" : ""}>`;
    const sel = (k, opts) => `<select data-f="${k}">${opts.map(([v, l]) => `<option value="${v}" ${String(c[k]) === v ? "selected" : ""}>${l}</option>`).join("")}</select>`;
    return F.map((f) => {
      const [type, label] = f;
      if (type === "section") return `<li class="vp-sec">${label}</li>`;
      let ctl = "", lab = `<span>${label}</span>`;
      if (type === "color2") ctl = col(f[2]) + col(f[3]);
      if (type === "num") ctl = num(f[2], f[3], f[4]);
      if (type === "select") ctl = sel(f[2], f[3]);
      if (type === "colornum") ctl = col(f[2]) + num(f[3], 1, 6);
      if (type === "checkcolornum") { lab = `<label>${chk(f[2])} ${label}</label>`; ctl = col(f[3]) + num(f[4], 1, 6); }
      if (type === "checkselect") { lab = `<label>${chk(f[2])} ${label}</label>`; ctl = sel(f[3], f[4]); }
      if (type === "checkcolor2") { lab = `<label>${chk(f[2])} ${label}</label>`; ctl = col(f[3]) + col(f[4]); }
      if (type === "checkcolor") { lab = `<label>${chk(f[2])} ${label}</label>`; ctl = col(f[3]); }
      return `<li class="vp-row">${lab}<span class="vp-ctl">${ctl}</span></li>`;
    }).join("");
  }

  function openSettings(onSave) {
    const cfg = load();
    const el = document.createElement("div");
    el.className = "sheet";
    el.innerHTML = `
      <header class="sheet-head">
        <button type="button" class="sheet-btn" data-act="cancel">取消</button>
        <h2>成交量分佈設定</h2>
        <button type="button" class="sheet-btn strong" data-act="done">完成</button>
      </header>
      <div class="sheet-body">
        <ul class="vp-form">${formHtml(cfg)}</ul>
        <div class="add-wrap"><button type="button" class="add-btn" data-act="reset">還原預設值</button></div>
      </div>`;
    document.body.appendChild(el);
    document.body.classList.add("no-scroll");
    const close = () => { el.remove(); if (!document.querySelector(".sheet")) document.body.classList.remove("no-scroll"); };
    el.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "cancel") close();
      if (act === "reset") el.querySelector(".vp-form").innerHTML = formHtml({ ...DEFAULTS });
      if (act === "done") {
        const next = { ...cfg };
        el.querySelectorAll("[data-f]").forEach((i) => {
          const k = i.dataset.f;
          next[k] = i.type === "checkbox" ? i.checked : i.type === "number" ? Number(i.value) : i.value;
        });
        save(next);
        close();
        onSave(next);
      }
    });
  }

  window.VP = { DEFAULTS, load, save, compute, layout, attach, openSettings };
})();
