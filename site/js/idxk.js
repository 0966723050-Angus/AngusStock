/* 首頁：點選加權／櫃買指數時開啟近半年日 K（SMA5/10/20/50/100/200、布林），可放大縮小 */
(function () {
  "use strict";

  const OPT_KEY = "angus.idxk.lines";
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const fmt = (v, d = 2) => (v == null || !isFinite(v) ? "--" : Number(v).toLocaleString("zh-TW", { minimumFractionDigits: d, maximumFractionDigits: d }));
  const LINES = [
    { key: "s5", n: 5, label: "SMA5", color: "#7b7bf0" },
    { key: "s10", n: 10, label: "SMA10", color: "#3fc8e8" },
    { key: "s20", n: 20, label: "SMA20", color: "#e8b64a" },
    { key: "s50", n: 50, label: "SMA50", color: "#cf6fcf" },
    { key: "s100", n: 100, label: "SMA100", color: "#2e9e3e" },
    { key: "s200", n: 200, label: "SMA200", color: "#8d6e63" },
    { key: "boll", label: "布林", color: "#ef5fa0" },
  ];

  const sma = (a, n) => {
    const out = Array(a.length).fill(null);
    let s = 0;
    a.forEach((x, i) => { s += x; if (i >= n) s -= a[i - n]; if (i >= n - 1) out[i] = s / n; });
    return out;
  };
  function boll(c, n = 20, k = 2) {
    const mid = sma(c, n), up = Array(c.length).fill(null), lo = Array(c.length).fill(null);
    for (let i = n - 1; i < c.length; i++) {
      const sd = Math.sqrt(c.slice(i - n + 1, i + 1).reduce((s, x) => s + (x - mid[i]) ** 2, 0) / n);
      up[i] = mid[i] + k * sd; lo[i] = mid[i] - k * sd;
    }
    return { mid, up, lo };
  }
  // 由最新日期往前 6 個月的起始索引
  function sixMonthStart(dates) {
    const [y, m, dd] = dates[dates.length - 1].split("-").map(Number);
    let yy = y, mm = m - 6;
    if (mm < 1) { mm += 12; yy -= 1; }
    const maxd = new Date(yy, mm, 0).getDate(); // 該月天數（無此日時取月底）
    const p2 = (n) => String(n).padStart(2, "0");
    const cut = `${yy}-${p2(mm)}-${p2(Math.min(dd, maxd))}`;
    const i = dates.findIndex((x) => x >= cut);
    return i < 0 ? 0 : i;
  }
  const loadOn = () => {
    const def = Object.fromEntries(LINES.map((x) => [x.key, true]));
    try { return { ...def, ...JSON.parse(localStorage.getItem(OPT_KEY) || "{}") }; } catch (e) { return def; }
  };

  function open(title, rows) {
    if (!rows || rows.length < 2) { App.toast("尚無指數日 K 資料"); return; }
    const t = {
      d: rows.map((r) => r[0]), o: rows.map((r) => r[1]), h: rows.map((r) => r[2]),
      l: rows.map((r) => r[3]), c: rows.map((r) => r[4]), v: rows.map((r) => r[5]),
    };
    LINES.forEach((x) => { if (x.n) t[x.key] = sma(t.c, x.n); });
    t.boll = boll(t.c);
    const on = loadOn();
    const last = t.d.length - 1;

    const el = document.createElement("div");
    el.className = "sheet";
    el.innerHTML = `
      <header class="sheet-head">
        <button type="button" class="sheet-btn" data-act="close">‹ 返回</button>
        <h2>${title} 日K</h2>
        <span></span>
      </header>
      <div class="sheet-body idxk-body">
        <div class="card idxk-card">
          <div class="ta-head">
            <span class="ta-badge">${title}</span>
            <span class="ta-zoom">
              <button type="button" class="zbtn zin" data-z="in" aria-label="放大">＋</button>
              <button type="button" class="zbtn zout" data-z="out" aria-label="縮小">－</button>
            </span>
          </div>
          <div class="ta-info idxk-info"></div>
          <div class="chart idxk-chart"></div>
          <div class="ta-checks">${LINES.map((x) => `<label><input type="checkbox" data-k="${x.key}" ${on[x.key] ? "checked" : ""}> ${x.label}</label>`).join("")}</div>
        </div>
        <p class="muted small note">預設顯示最新日期往前 6 個月，可用 ＋／－ 或下方拖曳條調整；成交量為成交金額（億元）。布林：20 日 ±2 標準差。</p>
      </div>`;
    document.body.appendChild(el);
    document.body.classList.add("no-scroll");
    const box = el.querySelector(".idxk-chart"), info = el.querySelector(".idxk-info");
    let chart = null, win = [sixMonthStart(t.d), last];

    const setInfo = (i) => {
      i = Math.max(0, Math.min(last, i));
      const pct = i > 0 ? ((t.c[i] - t.c[i - 1]) / t.c[i - 1]) * 100 : null;
      const pc = pct == null ? "" : pct >= 0 ? "up" : "down";
      const chip = (label, v, color) => (v == null ? "" : `<span class="ti"><i style="background:${color}"></i>${label} <b>${fmt(v)}</b></span>`);
      info.innerHTML = `<span class="ti-date">${t.d[i]}</span>` +
        `<span class="ti">開 <b>${fmt(t.o[i])}</b></span><span class="ti">高 <b>${fmt(t.h[i])}</b></span>` +
        `<span class="ti">低 <b>${fmt(t.l[i])}</b></span><span class="ti">收 <b class="${pc}">${fmt(t.c[i])}</b>` +
        (pct == null ? "" : ` <b class="${pc}">${pct >= 0 ? "+" : ""}${fmt(pct)}%</b>`) + `</span>` +
        `<span class="ti">成交 <b>${fmt(t.v[i])}</b> 億</span>` +
        LINES.filter((x) => x.n && on[x.key]).map((x) => chip(x.label, t[x.key][i], x.color)).join("") +
        (on.boll ? chip("布林上", t.boll.up[i], "#ef5fa0") + chip("布林下", t.boll.lo[i], "#ef5fa0") : "");
    };

    function draw() {
      if (chart) chart.dispose();
      chart = echarts.init(box);
      const up = css("--up"), down = css("--down"), muted = { color: css("--muted"), fontSize: 10 };
      const line = (name, data, color, extra = {}) => ({ name, type: "line", data, symbol: "none", showSymbol: false, emphasis: { disabled: true },
        smooth: true, connectNulls: false, lineStyle: { width: 1.2, color, ...(extra.lineStyle || {}) }, itemStyle: { color } });
      const S = [{
        name: "K線", type: "custom", data: t.d.map((_, i) => [i, t.o[i], t.c[i], t.l[i], t.h[i]]), encode: { x: 0, y: [1, 2, 3, 4] }, clip: true, z: 2,
        renderItem: (params, api) => {
          const i = api.value(0), o = api.value(1), c = api.value(2), l = api.value(3), h = api.value(4);
          const dpr = window.devicePixelRatio || 1;
          const x = (Math.round(api.coord([i, c])[0] * dpr) + 0.5) / dpr;
          const w = Math.max(1, Math.min(18, api.size([1, 0])[0] * 0.7));
          const yO = api.coord([i, o])[1], yC = api.coord([i, c])[1];
          const color = c > o ? up : c < o ? down : (i > 0 && c < t.c[i - 1] ? down : up);
          return { type: "group", children: [
            { type: "line", shape: { x1: x, y1: api.coord([i, h])[1], x2: x, y2: api.coord([i, l])[1] }, style: { stroke: color, lineWidth: dpr >= 2 ? 1.5 / dpr : 1 } },
            { type: "rect", shape: { x: x - w / 2, y: Math.min(yO, yC), width: w, height: Math.max(1 / dpr, Math.abs(yO - yC)) }, style: { fill: color } },
          ] };
        },
      }];
      LINES.filter((x) => x.n && on[x.key]).forEach((x) => S.push(line(x.label, t[x.key], x.color)));
      if (on.boll) {
        S.push(line("布林上", t.boll.up, "#ef5fa0", { lineStyle: { type: "dotted", width: 1.4 } }));
        S.push(line("布林中", t.boll.mid, "#ef5fa0", { lineStyle: { type: "dashed", width: 0.8 } }));
        S.push(line("布林下", t.boll.lo, "#ef5fa0", { lineStyle: { type: "dotted", width: 1.4 } }));
      }
      S.push({ name: "成交金額", type: "bar", xAxisIndex: 1, yAxisIndex: 1, barWidth: "70%", barMaxWidth: 18,
        data: t.v.map((v, i) => ({ value: v, itemStyle: { color: i > 0 && t.c[i] < t.c[i - 1] ? down : up } })) });
      chart.setOption({
        animation: false,
        grid: [{ left: 8, right: 60, top: 12, height: "64%" }, { left: 8, right: 60, top: "77%", bottom: 50 }],
        axisPointer: { link: [{ xAxisIndex: "all" }] },
        tooltip: { trigger: "axis", showContent: false, axisPointer: { type: "cross", label: { backgroundColor: "#555" } } },
        xAxis: [
          { type: "category", data: t.d, gridIndex: 0, axisLabel: { show: false }, axisTick: { show: false }, axisLine: { lineStyle: { color: css("--border") } } },
          { type: "category", data: t.d, gridIndex: 1, axisTick: { show: false }, axisLine: { lineStyle: { color: css("--border") } },
            axisLabel: { ...muted, formatter: (v) => `${+v.slice(5, 7)}/${+v.slice(8)}` } },
        ],
        yAxis: [
          { type: "value", scale: true, position: "right", splitNumber: 5, axisLabel: { ...muted, formatter: (v) => fmt(v, v >= 1000 ? 0 : 1) }, splitLine: { lineStyle: { color: css("--grid") } } },
          { type: "value", gridIndex: 1, position: "right", splitNumber: 2, axisLabel: { ...muted, formatter: (v) => fmt(v, 0) + "億" }, splitLine: { lineStyle: { color: css("--grid") } } },
        ],
        dataZoom: [{ type: "slider", xAxisIndex: [0, 1], startValue: win[0], endValue: win[1], height: 18, bottom: 4, brushSelect: false,
          borderColor: css("--border"), textStyle: { color: css("--muted"), fontSize: 10 } }],
        series: S,
      });
      chart.on("updateAxisPointer", (e) => {
        const ax = (e.axesInfo || []).find((a) => a.axisDim === "x");
        if (ax && ax.value != null) setInfo(ax.value);
      });
      chart.on("datazoom", () => { const z = chart.getOption().dataZoom[0]; win = [z.startValue, z.endValue]; });
      chart.getZr().on("globalout", () => setInfo(last));
      setInfo(last);
    }
    draw();

    const onResize = () => chart && chart.resize();
    window.addEventListener("resize", onResize);
    const close = () => {
      window.removeEventListener("resize", onResize);
      if (chart) chart.dispose();
      el.remove();
      if (!document.querySelector(".sheet")) document.body.classList.remove("no-scroll");
    };
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-act=close]")) close();
      const z = e.target.closest("[data-z]")?.dataset.z;
      if (z) {
        const [s, end] = win, span = end - s + 1;
        const next = z === "in" ? Math.max(20, Math.round(span * 0.7)) : Math.min(t.d.length, Math.round(span / 0.7));
        win = [Math.max(0, end - next + 1), end];
        chart.dispatchAction({ type: "dataZoom", startValue: win[0], endValue: win[1] });
      }
    });
    el.querySelector(".ta-checks").addEventListener("change", (e) => {
      const k = e.target.dataset.k;
      if (!k) return;
      on[k] = e.target.checked;
      try { localStorage.setItem(OPT_KEY, JSON.stringify(on)); } catch (err) { /* ignore */ }
      draw();
    });
  }

  window.IdxK = { open };
})();
