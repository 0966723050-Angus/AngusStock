/* 首頁：大盤指數、三大法人買賣超統計、法人買賣超排行 */
(function () {
  "use strict";

  const charts = [];
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const fmt = (v, d = 2) => (v == null || isNaN(v) ? "--" : Number(v).toLocaleString("zh-TW", { minimumFractionDigits: d, maximumFractionDigits: d }));
  const sgn = (v, d = 2) => (v == null ? "--" : (v > 0 ? "+" : "") + fmt(v, d));
  const cls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
  const md = (iso) => (iso ? `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}` : "");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function disposeCharts() {
    while (charts.length) charts.pop().dispose();
  }
  function mkChart(el) {
    const c = echarts.init(el, null, { renderer: "canvas" });
    charts.push(c);
    return c;
  }
  const baseText = () => ({ color: css("--muted"), fontSize: 11 });
  const tooltipStyle = () => ({
    backgroundColor: css("--surface"), borderColor: css("--border"),
    textStyle: { color: css("--text"), fontSize: 12 }, confine: true,
  });

  // ------------------------------------------------------------ 指數卡
  function indexCard(title, d) {
    if (!d) return `<article class="card"><div class="card-head"><h3>${title}</h3></div><div class="empty">尚無資料</div></article>`;
    const b = d.breadth || {};
    const chg = d.chg || [null, null];
    const rel = (a) => (a ? `<small class="${cls(a[0])}">${sgn(a[0])} / ${sgn(a[1])}%</small>` : "");
    return `
    <article class="card">
      <div class="card-head"><h3>${title} ${md(d.date)}</h3><span class="muted small">昨收 ${fmt(d.prev)}</span></div>
      <div class="card-body">
        <div class="quote">
          <span class="price ${cls(chg[0])}">${fmt(d.close)}</span>
          <span class="chg ${cls(chg[0])}">${chg[0] > 0 ? "▲" : chg[0] < 0 ? "▼" : ""} ${sgn(chg[0])} (${sgn(chg[1])}%)</span>
        </div>
        <div class="chart tall" data-chart="${title}"></div>
        <dl class="kv">
          <div><dt>最高</dt><dd class="v">${fmt(d.high)} ${rel(d.high_chg)}</dd></div>
          <div><dt>最低</dt><dd class="v">${fmt(d.low)} ${rel(d.low_chg)}</dd></div>
          <div><dt>開盤</dt><dd class="v">${fmt(d.open)}</dd></div>
          <div><dt>連續漲跌</dt><dd class="v ${/漲/.test(d.streak) ? "up" : /跌/.test(d.streak) ? "down" : ""}">${d.streak || "--"}</dd></div>
          <div><dt>成交金額</dt><dd class="v">${fmt(d.value)} 億元</dd></div>
          <div><dt>成交張數</dt><dd class="v">${fmt(d.volume, 0)} 張</dd></div>
          <div><dt>成交筆數</dt><dd class="v">${fmt(d.count, 0)} 筆</dd></div>
        </dl>
        <div class="breadth" aria-label="漲跌家數">
          <div class="lu"><span class="h">漲停</span><span class="n up">${b.limit_up ?? "--"}</span></div>
          <div class="ld"><span class="h">跌停</span><span class="n down">${b.limit_down ?? "--"}</span></div>
          <div><span class="h up">上漲</span><span class="n up">${b.up ?? "--"}</span></div>
          <div><span class="h">平盤</span><span class="n">${b.flat ?? "--"}</span></div>
          <div><span class="h down">下跌</span><span class="n down">${b.down ?? "--"}</span></div>
        </div>
      </div>
    </article>`;
  }

  function drawIndexChart(el, d) {
    if (!el) return;
    if (!d.series || !d.series.length) {
      el.outerHTML = '<div class="empty">盤中走勢資料尚未提供</div>';
      return;
    }
    // 完整交易時段 09:01~13:30 作為 X 軸
    const times = [];
    for (let m = 9 * 60 + 1; m <= 13 * 60 + 30; m++) times.push(String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"));
    const map = new Map(d.series.map((r) => [r[0], r]));
    const price = times.map((t) => (map.has(t) ? map.get(t)[1] : null));
    const vol = times.map((t) => (map.has(t) ? map.get(t)[2] : null));
    const prev = d.prev;
    const vals = price.filter((v) => v != null).concat(prev != null ? [prev] : []);
    const lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.08 || 1;
    const up = css("--up"), down = css("--down");
    const unit = d.unit || "張";
    const c = mkChart(el);
    c.setOption({
      animation: false,
      grid: [
        { left: 8, right: 56, top: 12, height: "58%" },
        { left: 8, right: 56, top: "74%", bottom: 22 },
      ],
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      tooltip: {
        trigger: "axis", ...tooltipStyle(),
        axisPointer: { type: "line", lineStyle: { color: css("--muted"), type: "dashed" } },
        formatter: (ps) => {
          const i = ps[0].dataIndex;
          if (price[i] == null) return times[i];
          const diff = prev != null ? price[i] - prev : null;
          return `<b>${times[i]}</b><br>指數 <b>${fmt(price[i])}</b> <span style="color:${diff >= 0 ? up : down}">${sgn(diff)}</span><br>`
            + `成交${unit === "億" ? "額" : "量"} ${fmt(vol[i], unit === "億" ? 2 : 0)} ${unit}`;
        },
      },
      xAxis: [
        { type: "category", data: times, gridIndex: 0, boundaryGap: false, axisLabel: { show: false }, axisTick: { show: false }, axisLine: { lineStyle: { color: css("--border") } } },
        {
          type: "category", data: times, gridIndex: 1, boundaryGap: false,
          axisLabel: { ...baseText(), interval: (i, v) => /:00$/.test(v), formatter: (v) => v },
          axisTick: { show: false }, axisLine: { lineStyle: { color: css("--border") } },
        },
      ],
      yAxis: [
        { type: "value", gridIndex: 0, position: "right", min: +(lo - pad).toFixed(2), max: +(hi + pad).toFixed(2), scale: true, splitNumber: 4,
          axisLabel: { ...baseText(), formatter: (v) => fmt(v, v > 1000 ? 0 : 1) }, splitLine: { lineStyle: { color: css("--grid") } } },
        { type: "value", gridIndex: 1, position: "right", splitNumber: 2, name: unit, nameTextStyle: baseText(), nameGap: 4,
          axisLabel: { ...baseText(), formatter: (v) => (v >= 10000 ? v / 10000 + "萬" : v) }, splitLine: { lineStyle: { color: css("--grid") } } },
      ],
      series: [
        {
          name: "指數", type: "line", data: price, xAxisIndex: 0, yAxisIndex: 0, showSymbol: false, connectNulls: false,
          lineStyle: { width: 2, color: css("--line") }, itemStyle: { color: css("--line") },
          markLine: prev != null ? {
            silent: true, symbol: "none", label: { show: true, position: "insideStartTop", formatter: "昨收 " + fmt(prev), color: css("--prevline"), fontSize: 10 },
            lineStyle: { color: css("--prevline"), type: "dashed", width: 1 }, data: [{ yAxis: prev }],
          } : undefined,
        },
        {
          name: "成交", type: "bar", data: vol, xAxisIndex: 1, yAxisIndex: 1, barWidth: "70%",
          itemStyle: { color: (p) => { const i = p.dataIndex; const a = price[i], b = i > 0 ? price[i - 1] ?? prev : prev; return a != null && b != null && a < b ? down : up; } },
        },
      ],
    });
  }

  // ------------------------------------------------------------ 三大法人
  function instCard(label, mkt, d) {
    if (!d) return `<article class="card"><div class="card-head"><h3>${label}</h3></div><div class="empty">尚無資料</div></article>`;
    const last = d.series[d.series.length - 1] || [];
    const rows = d.rows.map((r) => `
      <tr>
        <td class="c">${r.name}</td>
        <td class="num">${fmt(r.buy)}</td>
        <td class="num">${fmt(r.sell)}</td>
        <td class="num ${cls(r.net)}">${sgn(r.net)}</td>
        <td class="c ${/買$/.test(r.streak) ? "up" : /賣$/.test(r.streak) ? "down" : ""}">${r.streak}</td>
        <td class="num ${cls(r.streak_amt)}">${sgn(r.streak_amt)}</td>
      </tr>`).join("");
    return `
    <article class="card">
      <div class="card-head"><h3>${label}</h3><span class="muted small">資料日 ${d.date}｜單位：億元</span></div>
      <div class="card-body">
        <div class="chips">
          <span class="chip"><i class="dot" style="background:var(--s1)"></i>外資 <b class="${cls(last[1])}">${sgn(last[1])}</b></span>
          <span class="chip"><i class="dot" style="background:var(--s2)"></i>投信 <b class="${cls(last[2])}">${sgn(last[2])}</b></span>
          <span class="chip"><i class="dot" style="background:var(--s3)"></i>自營商 <b class="${cls(last[3])}">${sgn(last[3])}</b></span>
          <span class="chip"><i class="dot" style="background:var(--area)"></i>累計買賣超（下圖）</span>
        </div>
        <div class="chart tall" data-inst="${mkt}"></div>
        <div class="tbl-wrap">
          <table class="tbl">
            <thead><tr><th>${label.replace("三大法人", "")}（${md(d.date)}）</th><th>買進</th><th>賣出</th><th>買賣超</th><th>連買賣日數</th><th>連買賣金額</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    </article>`;
  }

  function drawInstChart(el, d) {
    if (!el || !d || !d.series.length) return;
    const dates = d.series.map((r) => r[0]);
    const f = d.series.map((r) => r[1]), t = d.series.map((r) => r[2]), dl = d.series.map((r) => r[3]);
    let acc = 0;
    const cum = d.series.map((r) => +(acc += r[1] + r[2] + r[3]).toFixed(2));
    const start = Math.max(0, 100 - (60 / dates.length) * 100);
    const bar = (name, data, color) => ({
      name, type: "bar", stack: "net", data, xAxisIndex: 0, yAxisIndex: 0, barMaxWidth: 10,
      itemStyle: { color, borderColor: css("--surface"), borderWidth: 0.5 }, emphasis: { focus: "series" },
    });
    const c = mkChart(el);
    c.setOption({
      animation: false,
      grid: [
        { left: 8, right: 56, top: 24, height: "52%" },
        { left: 8, right: 56, top: "72%", bottom: 46 },
      ],
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      tooltip: {
        trigger: "axis", ...tooltipStyle(),
        axisPointer: { type: "shadow" },
        formatter: (ps) => {
          const i = ps[0].dataIndex;
          const row = (n, v, col) => `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${col};margin-right:6px"></span>${n} <b style="float:right;margin-left:16px">${sgn(v)}</b><br>`;
          return `<b>${dates[i]}</b><br>` + row("外資", f[i], css("--s1")) + row("投信", t[i], css("--s2")) + row("自營商", dl[i], css("--s3"))
            + `合計 <b style="float:right">${sgn(f[i] + t[i] + dl[i])}</b><br>累計 <b style="float:right">${sgn(cum[i])}</b>`;
        },
      },
      dataZoom: [
        { type: "slider", xAxisIndex: [0, 1], start, end: 100, height: 18, bottom: 4, borderColor: css("--border"),
          textStyle: baseText(), fillerColor: "rgba(85,152,231,.15)", dataBackground: { lineStyle: { color: css("--area") }, areaStyle: { color: css("--area") } } },
      ],
      xAxis: [
        { type: "category", data: dates, gridIndex: 0, axisLabel: { show: false }, axisTick: { show: false }, axisLine: { lineStyle: { color: css("--border") } } },
        { type: "category", data: dates, gridIndex: 1, axisLabel: { ...baseText(), formatter: (v) => v.slice(5).replace("-", "/") }, axisTick: { show: false }, axisLine: { lineStyle: { color: css("--border") } } },
      ],
      yAxis: [
        { type: "value", gridIndex: 0, position: "right", name: "億", nameTextStyle: baseText(), axisLabel: baseText(), splitLine: { lineStyle: { color: css("--grid") } } },
        { type: "value", gridIndex: 1, position: "right", splitNumber: 2, name: "累計", nameTextStyle: baseText(), axisLabel: { ...baseText(), formatter: (v) => (Math.abs(v) >= 10000 ? +(v / 10000).toFixed(2) + "兆" : v + "億") }, splitLine: { lineStyle: { color: css("--grid") } } },
      ],
      series: [
        bar("外資", f, css("--s1")),
        bar("投信", t, css("--s2")),
        bar("自營商", dl, css("--s3")),
        { name: "累計買賣超", type: "line", data: cum, xAxisIndex: 1, yAxisIndex: 1, showSymbol: false,
          lineStyle: { width: 2, color: css("--muted") }, itemStyle: { color: css("--muted") }, areaStyle: { color: css("--area"), opacity: 0.5 } },
      ],
    });
  }

  // ------------------------------------------------------------ 排行
  const RANK = [
    ["f_buy", "外資買超", "buy"], ["t_buy", "投信買超", "buy"], ["d_buy", "自營商買超", "buy"],
    ["f_sell", "外資賣超", "sell"], ["t_sell", "投信賣超", "sell"], ["d_sell", "自營商賣超", "sell"],
  ];

  function rankList(list) {
    if (!list || !list.length) return '<div class="empty">無資料</div>';
    return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>股票</th><th>代號</th><th>張數</th></tr></thead><tbody>${
      list.map((r, i) => `<tr><td class="rk">${i + 1}</td><td>${esc(r[0])}</td><td class="muted">${r[1]}</td><td class="num ${cls(r[2])}">${fmt(r[2], 0)}</td></tr>`).join("")
    }</tbody></table></div>`;
  }

  function rankWide(lists) {
    const n = Math.max(...RANK.map(([k]) => (lists[k] || []).length));
    let body = "";
    for (let i = 0; i < n; i++) {
      body += `<tr><td class="rk">${i + 1}</td>` + RANK.map(([k], j) => {
        const r = (lists[k] || [])[i];
        const sep = j === 3 ? " sep" : "";
        return r ? `<td class="${sep.trim()}" title="${r[1]}">${esc(r[0])}</td><td class="num ${cls(r[2])}">${fmt(r[2], 0)}</td>` : `<td class="${sep.trim()}"></td><td></td>`;
      }).join("") + "</tr>";
    }
    return `<div class="tbl-wrap"><table class="tbl">
      <thead>
        <tr><th rowspan="2">#</th>${RANK.map(([, t, s], j) => `<th colspan="2" class="${s}${j === 3 ? " sep" : ""}">${t}</th>`).join("")}</tr>
        <tr>${RANK.map((_, j) => `<th class="${j === 3 ? "sep" : ""}">股票</th><th>張數</th>`).join("")}</tr>
      </thead><tbody>${body}</tbody></table></div>`;
  }

  function rankCard(top) {
    if (!top) return '<article class="card"><div class="empty">尚無資料</div></article>';
    let sel = "f_buy";
    try { sel = localStorage.getItem("angus.rank") || sel; } catch (e) { /* ignore */ }
    return `
    <article class="card" id="rankCard">
      <div class="rank-narrow">
        <div class="seg" role="group" aria-label="排行類別">${RANK.map(([k, t]) => `<button type="button" data-k="${k}" aria-pressed="${k === sel}">${t}</button>`).join("")}</div>
        <div class="card-body" id="rankBody">${rankList(top.lists[sel])}</div>
      </div>
      <div class="rank-wide card-body">${rankWide(top.lists)}</div>
    </article>`;
  }

  // ------------------------------------------------------------ 頁面
  async function render(view) {
    disposeCharts();
    const d = await App.loadData("home");
    App.setUpdated(d.updated);
    view.innerHTML = `
      <div class="section-title"><h2>大盤指數</h2><span class="muted small">更新時間 ${d.updated || "--"}</span></div>
      <div class="grid-2 stack">
        ${indexCard("加權指數", d.tse)}
        ${indexCard("櫃買指數", d.otc)}
      </div>

      <div class="section-title"><h2>三大法人買賣超統計</h2></div>
      <div class="grid-2 stack">
        ${instCard("上市三大法人", "tse", d.inst_tse)}
        ${instCard("上櫃三大法人", "otc", d.inst_otc)}
      </div>

      <div class="section-title"><h2>法人買賣超排行</h2><span class="muted small">${d.top ? "資料日 " + d.top.date + "｜上市＋上櫃普通股｜單位：張" : ""}</span></div>
      <div class="stack">${rankCard(d.top)}</div>
    `;
    drawIndexChart(view.querySelector('[data-chart="加權指數"]'), d.tse || {});
    drawIndexChart(view.querySelector('[data-chart="櫃買指數"]'), d.otc || {});
    drawInstChart(view.querySelector('[data-inst="tse"]'), d.inst_tse);
    drawInstChart(view.querySelector('[data-inst="otc"]'), d.inst_otc);

    const rc = view.querySelector("#rankCard .seg");
    if (rc) rc.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      rc.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      view.querySelector("#rankBody").innerHTML = rankList(d.top.lists[b.dataset.k]);
      try { localStorage.setItem("angus.rank", b.dataset.k); } catch (err) { /* ignore */ }
    });
  }

  window.addEventListener("resize", () => charts.forEach((c) => c.resize()));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (location.hash === "" || location.hash.startsWith("#/home")) window.dispatchEvent(new HashChangeEvent("hashchange"));
  });

  App.register({ id: "home", title: "首頁", icon: "🏠", render });
  App.upcoming("技術分析");
})();
