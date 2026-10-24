/* 個股資訊：基本資料卡 + 外資／投信／自營商買賣超（疊加股價） */
(function () {
  "use strict";

  const charts = [];
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const fmt = (v, d = 2) => (v == null || isNaN(v) ? "--" : Number(v).toLocaleString("zh-TW", { minimumFractionDigits: d, maximumFractionDigits: d }));
  const sgn = (v, d = 2) => (v == null ? "--" : (v > 0 ? "+" : "") + fmt(v, d));
  const cls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const num = (v, d = 2, suffix = "") => (v == null ? "--" : fmt(v, d) + suffix);

  function row(label, value, opt = {}) {
    return `<tr class="${opt.band || ""}"><th scope="row">${label}</th><td class="${opt.cls || ""}">${value}</td></tr>`;
  }

  const volRatio = (v, pv) => (v == null || !pv ? "--" : `<span class="${v > pv ? "hl" : ""}">${fmt(v / pv, 2)} 倍</span>`);

  function infoCard(s, code) {
    const price = s.price;
    const pd = price != null && price >= 1000 && price % 1 === 0 ? 0 : 2;
    const holders = s.holders == null ? "--" : fmt(s.holders, 0) + " 人";
    const tdcc = "https://www.tdcc.com.tw/portal/zh/smWeb/qryStock";
    const div = (v) => (v == null ? "--" : fmt(v, v % 1 === 0 ? 1 : 2).replace(/0+$/, "").replace(/\.$/, ""));
    return `
    <article class="card stock-card">
      <div class="stock-head">
        <div><span class="stock-name">${esc(s.name)}</span><span class="stock-code">${esc(code)}</span></div>
        <div class="muted small">${esc(s.industry || "")}${s.market === "otc" ? "｜上櫃" : "｜上市"}｜${esc(s.date || "")}</div>
      </div>
      <table class="info-tbl">
        <tbody>
          ${row("股價", `<b>${num(price, pd)}</b>`, { band: "b1", cls: cls(s.chg) })}
          ${row("漲跌", s.chg == null ? "--" : `${s.chg > 0 ? "▲" : s.chg < 0 ? "▼" : ""}${fmt(Math.abs(s.chg), pd === 0 && s.chg % 1 === 0 ? 0 : 2)}`, { cls: cls(s.chg) })}
          ${row("漲跌幅", s.chg_pct == null ? "--" : sgn(s.chg_pct) + "%", { band: "b1", cls: cls(s.chg_pct) })}
          ${row("量增幅", s.vol_chg == null ? "--" : sgn(s.vol_chg, 1) + "%", { cls: s.vol_chg > 0 ? "hl" : "" })}
          ${row("昨日成交量", `<span class="si-yvol">${s.prev_vol == null ? "--" : fmt(s.prev_vol, 0) + " 張"}</span>`, { band: "b1" })}
          ${row("量比（今日／昨日）", `<span class="si-vr">${volRatio(s.vol, s.prev_vol)}</span>`)}
          ${row("周轉率(%)", num(s.turnover), { band: "b1" })}
          ${row(`<a href="${tdcc}" target="_blank" rel="noopener">集保人數</a>`, holders + (s.holders_date ? `<small>${esc(s.holders_date.slice(5).replace("-", "/"))}</small>` : ""))}
          ${row("董監持股(%)", num(s.directors_pct), { band: "b2" })}
          ${row("外資持股(%)", num(s.foreign_pct))}
          ${row("投信持股(%)", '<span class="muted" title="證交所／櫃買中心未公布個股投信持股比率">未公布</span>', { band: "b2" })}
          ${row("自營商持股(%)", '<span class="muted" title="證交所／櫃買中心未公布個股自營商持股比率">未公布</span>')}
          ${row("EPS(Q)", num(s.eps_q) + (s.eps_period ? `<small>${esc(s.eps_period)}</small>` : ""), { band: "b3", cls: cls(s.eps_q) })}
          ${row("EPS(Y)", num(s.eps_y) + '<small>近四季</small>', { cls: cls(s.eps_y) })}
          ${row("本益比", num(s.pe, 1), { band: "b3" })}
          ${row("股價淨值比", num(s.pb, 1))}
          ${row("月營收月增率(%)", num(s.rev_mom) + (s.rev_ym ? `<small>${esc(s.rev_ym.slice(0, 3) + "/" + s.rev_ym.slice(3))}</small>` : ""), { band: "b4", cls: cls(s.rev_mom) })}
          ${row("月營收年增率(%)", num(s.rev_yoy), { cls: cls(s.rev_yoy) })}
          ${row("配息", div(s.cash) + (s.div_period && s.cash ? `<small>${esc(s.div_period)}</small>` : ""), { band: "b4" })}
          ${row("配股", div(s.stock))}
          ${row("除息日", esc(s.ex_div || "--"), { band: "b4" })}
          ${row("除權日", esc(s.ex_right || "--"))}
          ${row("發息日", esc(s.pay_date || "--"), { band: "b4" })}
        </tbody>
      </table>
    </article>`;
  }

  // 累積買賣超：自圖表起始日起逐日加總，緊接在當日買賣超下方
  const SERIES = [
    { i: 1, title: "外資買賣超", tag: "t1" },
    { i: 1, title: "外資累積買賣超", tag: "t1", cum: true, color: "#ff3fa0" },
    { i: 2, title: "投信買賣超", tag: "t2" },
    { i: 2, title: "投信累積買賣超", tag: "t2", cum: true, color: "#f5b800" },
    { i: 3, title: "自營商買賣超", tag: "t3" },
  ];
  // 主力（買超前 15 名分點 − 賣超前 15 名分點）；資料列轉為 [日期, 淨額, -, -, 收盤] 以共用繪圖函式
  const MAJOR = [
    { i: 1, title: "主力買賣超", tag: "t4", major: true },
    { i: 1, title: "主力累積買賣超", tag: "t4", major: true, cum: true, color: "#ff3fa0", noPrice: true },
  ];

  function majorCard(s) {
    const m = s.major_sum;
    if (!m) return '<article class="card"><div class="chart-title"><span class="tag t4">主力買賣超</span></div><div class="empty">主力資料準備中（新加入的股票會在下次更新時回補近 6 個月）</div></article>';
    const cumRow = (n, cls) => (m.cum[n] == null ? "" : `<tr class="${cls}"><th>累計${n}日</th><td class="${m.cum[n] > 0 ? "up" : m.cum[n] < 0 ? "down" : ""}">${fmt(m.cum[n], 0)}</td></tr>`);
    return `
      <article class="card major-card">
        <div class="chart-title"><span class="tag t4">主力買賣超</span><span class="muted small">資料日 ${esc(m.date)}｜單位：張｜買超前 15 名 − 賣超前 15 名分點</span></div>
        <div class="major-grid">
          <table class="info-tbl major-now">
            <tbody>
              <tr class="b1"><th>今日淨買賣超</th><td class="${m.net > 0 ? "up" : m.net < 0 ? "down" : ""}">${sgn(m.net, 0)}</td></tr>
              <tr><th>今日成交量</th><td>${fmt(m.vol, 0)}</td></tr>
              <tr class="b1"><th>比例（淨買賣超／成交量）</th><td class="${m.ratio > 0 ? "up" : m.ratio < 0 ? "down" : ""}">${m.ratio == null ? "--" : sgn(m.ratio) + "%"}</td></tr>
            </tbody>
          </table>
          <table class="info-tbl major-cum">
            <tbody>${cumRow(5, "c1")}${cumRow(10, "c2")}${cumRow(15, "c3")}${cumRow(20, "c4")}${cumRow(30, "c5")}${cumRow(60, "c6")}${cumRow(90, "c7")}</tbody>
          </table>
        </div>
      </article>`;
  }

  function drawChart(el, chart, x) {
    const idx = x.i;
    const c = echarts.init(el);
    charts.push(c);
    const dates = chart.map((r) => r[0]);
    let acc = 0;
    const vals = x.cum ? chart.map((r) => (acc += r[idx] || 0)) : chart.map((r) => r[idx]);
    const px = chart.map((r) => r[4]);
    const up = css("--up"), down = css("--down"), line = css("--line");
    const pxv = px.filter((v) => v != null);
    const pmin = pxv.length ? Math.min(...pxv) : 0, pmax = pxv.length ? Math.max(...pxv) : 1, pad = (pmax - pmin) * 0.1 || 1;
    const muted = { color: css("--muted"), fontSize: 11 };
    c.setOption({
      animation: false,
      grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
      tooltip: {
        trigger: "axis", confine: true, axisPointer: { type: "shadow" },
        backgroundColor: css("--surface"), borderColor: css("--border"), textStyle: { color: css("--text"), fontSize: 12 },
        formatter: (ps) => {
          const i = ps[0].dataIndex;
          return `<b>${dates[i]}</b><br>${x.cum ? "累積買賣超" : "買賣超"} <b style="color:${vals[i] >= 0 ? up : down}">${sgn(vals[i], 0)}</b> 張` + (x.noPrice ? "" : `<br>收盤價 <b>${fmt(px[i])}</b>`);
        },
      },
      xAxis: {
        type: "category", data: dates, axisTick: { show: false },
        axisLine: { lineStyle: { color: css("--border") } },
        axisLabel: { ...muted, rotate: 90, formatter: (v) => `${+v.slice(5, 7)}/${+v.slice(8)}` },
      },
      yAxis: [
        { type: "value", position: "left", axisLabel: { ...muted, formatter: (v) => fmt(v, 0) }, splitLine: { lineStyle: { color: css("--grid"), type: "dashed" } } },
        { type: "value", position: "right", min: +(pmin - pad).toFixed(2), max: +(pmax + pad).toFixed(2), splitLine: { show: false },
          axisLabel: { ...muted, color: line, formatter: (v) => fmt(v, v >= 100 ? 0 : 1) } },
      ],
      series: [
        x.cum
          ? { name: "累積買賣超", type: "line", data: vals, smooth: true, symbol: "none", emphasis: { disabled: true }, lineStyle: { width: 2, color: x.color }, itemStyle: { color: x.color },
              markLine: x.noPrice ? { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: css("--text"), width: 1.5, type: "solid" }, data: [{ yAxis: 0 }] } : undefined }
          : { name: "買賣超", type: "bar", data: vals.map((v) => ({ value: v, itemStyle: { color: v >= 0 ? up : down } })), barMaxWidth: 8 },
        ...(x.noPrice ? [] : [{ name: "股價", type: "line", yAxisIndex: 1, data: px, smooth: true, symbol: "none", emphasis: { disabled: true }, lineStyle: { width: 2, color: line }, itemStyle: { color: line } }]),
      ],
    });
  }

  // ------------------------------------------------------------ 即時走勢（當日每分鐘；經 Apps Script 查 Yahoo 奇摩股市）
  const TIMES = (() => { const a = []; for (let m = 9 * 60; m <= 13 * 60 + 30; m++) a.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`); return a; })();
  function liveCard() {
    return `
      <article class="card live-card">
        <div class="live-head">
          <div class="live-px"><b class="live-price">--</b><span class="live-chg"></span></div>
          <dl class="live-kv">
            <div><dt>總量</dt><dd class="lv-vol">--</dd></div><div><dt>成交值</dt><dd class="lv-val">--</dd></div>
            <div><dt>均價</dt><dd class="lv-avg">--</dd></div><div><dt>昨收</dt><dd class="lv-prev">--</dd></div>
          </dl>
        </div>
        <div class="live-sub muted small"><span class="lv-time">即時走勢載入中…</span><span class="lv-legend"><span><i class="lg-dot" style="background:#f0a020"></i> 均價</span><span class="lv-idx"><i class="lg-dot" style="background:#9b51e0"></i> 加權指數</span></span></div>
        <div class="chart live-chart"></div>
        <div class="io-bar" hidden>
          <div class="io-row"><span>內盤</span><span>外盤</span></div>
          <div class="io-row io-num"><span class="down io-in"></span><span class="up io-out"></span></div>
          <div class="io-track"><i class="io-in-bar"></i><i class="io-out-bar"></i></div>
        </div>
      </article>`;
  }
  function lineColor(hi, lo, prev, up, down) {
    if (prev >= hi) return down;
    if (prev <= lo) return up;
    const k = (hi - prev) / (hi - lo);
    return new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: up }, { offset: k, color: up }, { offset: k, color: down }, { offset: 1, color: down }]);
  }
  // idx：{ prev, rows: [[HH:MM, 指數]] }（加權指數當日每分鐘；與個股同一交易日才顯示）
  function drawLive(view, j, idx) {
    const el = view.querySelector(".live-chart");
    if (!el || !j || !j.rows || !j.rows.length) {
      const t = view.querySelector(".lv-time");
      if (t) t.textContent = "目前沒有當日走勢資料";
      return;
    }
    const prev = j.prev, up = css("--up"), down = css("--down");
    const map = new Map(j.rows.map((r) => [r[0], r]));
    let cv = 0, cq = 0;
    const price = [], avg = [], vol = [];
    for (const t of TIMES) {
      const r = map.get(t);
      if (r) { cv += r[1] * r[2]; cq += r[2]; }
      price.push(r ? r[1] : null);
      avg.push(r && cq ? +(cv / cq).toFixed(2) : null);
      vol.push(r ? r[2] : null);
    }
    const last = j.rows[j.rows.length - 1], px = j.price ?? last[1], chg = prev != null ? px - prev : null;
    // 當日最高／最低價：取每分鐘的最高、最低價（不是收盤價）；舊版中轉程式沒有分鐘高低時，改用證交所即時報價的當日高低
    let hi = Math.max(...j.rows.map((r) => (r[3] != null ? r[3] : r[1]))), lo = Math.min(...j.rows.map((r) => (r[4] != null ? r[4] : r[1])));
    if (j.dayHigh != null && j.dayHigh > hi) hi = j.dayHigh;
    if (j.dayLow != null && j.dayLow < lo) lo = j.dayLow;
    // 價格軸以昨收為中心上下對稱，刻度一定包含昨收（藍色）
    const span = Math.max(hi - prev, prev - lo, prev * 0.005) * 1.06;
    const ymax = prev + span, ymin = prev - span;
    const cls2 = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
    const set = (q, html) => { const e = view.querySelector(q); if (e) e.innerHTML = html; };
    set(".live-price", fmt(px));
    view.querySelector(".live-price").className = "live-price " + cls2(chg);
    set(".live-chg", chg == null ? "" : `<span class="${cls2(chg)}">${chg > 0 ? "▲" : chg < 0 ? "▼" : ""}${fmt(Math.abs(chg))}　${chg >= 0 ? "+" : ""}${fmt(chg / prev * 100)}%</span>`);
    set(".lv-vol", `${cq.toLocaleString("zh-TW")} 張`);
    set(".lv-val", `${(cv * 1000 / 1e8).toFixed(1)} 億`);
    set(".lv-avg", cq ? fmt(cv / cq) : "--");
    set(".lv-prev", fmt(prev));
    set(".lv-time", `${j.day ? j.day.replace(/-/g, "/") : ""} ${last[0]}（即時）`);
    // 加權指數：依「漲跌幅」與個股對齊（指數軸＝指數昨收 ×（1 ± 個股軸的百分比範圍））
    const idxMap = idx && idx.prev ? new Map(idx.rows) : null;
    const idxLine = idxMap ? TIMES.map((t) => idxMap.get(t) ?? null) : null;
    const idxLast = idxLine ? (idx.now || [...idxLine].reverse().find((v) => v != null)) : null;
    set(".lv-idx", idxLast != null
      ? `<i class="lg-dot" style="background:#9b51e0"></i> 加權 ${fmt(idxLast)} <span class="${cls2(idxLast - idx.prev)}">${idxLast >= idx.prev ? "+" : ""}${fmt((idxLast / idx.prev - 1) * 100)}%</span>`
      : "");
    // 標註位置：最高／最低價出現的那一分鐘（無分鐘高低資料時，取收盤最接近的那一分鐘）
    const near = (v, k) => { let b = -1, d = Infinity; TIMES.forEach((t, i) => { const r = map.get(t); if (!r) return; const x = Math.abs((r[k] != null ? r[k] : r[1]) - v); if (x < d - 1e-9) { d = x; b = i; } }); return b; };
    const hiI = near(hi, 3), loI = near(lo, 4);
    const old = echarts.getInstanceByDom(el);
    const c = old || echarts.init(el);
    if (!old) charts.push(c);
    const tick = (v) => (v > prev + span * 0.01 ? up : v < prev - span * 0.01 ? down : "#2a5bd7");
    c.setOption({
      animation: false,
      grid: { left: 54, right: 12, top: 10, bottom: 24 },
      tooltip: { trigger: "axis", showContent: false, axisPointer: { type: "line", lineStyle: { color: css("--muted"), type: "dashed" } } },
      xAxis: { type: "category", data: TIMES, boundaryGap: false, axisTick: { show: false }, axisLine: { lineStyle: { color: css("--border") } },
        axisLabel: { color: css("--muted"), fontSize: 11, interval: (i, v) => /:00$/.test(v), formatter: (v) => v.slice(0, 2) } },
      yAxis: [
        { type: "value", min: ymin, max: ymax, interval: span / 3, position: "left",
          axisLabel: { fontSize: 11, formatter: (v) => fmt(v, v >= 100 ? 1 : 2), color: (v) => tick(v) },
          splitLine: { lineStyle: { color: css("--grid") } } },
        { type: "value", min: 0, max: Math.max(...vol.filter((v) => v != null), 1) * 3.2, show: false },
        { type: "value", show: false, min: idxMap ? idx.prev * (1 - span / prev) : 0, max: idxMap ? idx.prev * (1 + span / prev) : 1 },
      ],
      series: [
        { name: "成交", type: "line", data: price, showSymbol: false, connectNulls: true, emphasis: { disabled: true },
          // 線段顏色：昨收以上紅、以下綠（以線條本身的最高～最低範圍換算切換位置）
          lineStyle: { width: 1.4, color: lineColor(Math.max(...j.rows.map((r) => r[1])), Math.min(...j.rows.map((r) => r[1])), prev, up, down) },
          markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: css("--muted"), type: "solid", width: 1 }, data: [{ yAxis: prev }] },
          // 最高價、最低價標註（方框）
          markPoint: { silent: true, symbol: "circle", symbolSize: 5, animation: false,
            data: [
              { coord: [hiI, hi], itemStyle: { color: up }, label: { show: true, position: hiI > TIMES.length * 0.7 ? "left" : "right", formatter: `最高 ${fmt(hi)}`,
                color: up, fontSize: 11, fontWeight: 700, backgroundColor: css("--surface"), borderColor: up, borderWidth: 1, borderRadius: 4, padding: [2, 5], distance: 6 } },
              { coord: [loI, lo], itemStyle: { color: down }, label: { show: true, position: loI > TIMES.length * 0.7 ? "left" : "right", formatter: `最低 ${fmt(lo)}`,
                color: down, fontSize: 11, fontWeight: 700, backgroundColor: css("--surface"), borderColor: down, borderWidth: 1, borderRadius: 4, padding: [2, 5], distance: 6 } },
            ] } },
        { name: "均價", type: "line", data: avg, showSymbol: false, connectNulls: true, lineStyle: { width: 1.2, color: "#f0a020" }, itemStyle: { color: "#f0a020" }, emphasis: { disabled: true } },
        { name: "量", type: "bar", yAxisIndex: 1, data: vol, barWidth: "60%", itemStyle: { color: "rgba(80,170,220,.55)" }, silent: true },
        ...(idxLine ? [{ name: "加權指數", type: "line", yAxisIndex: 2, data: idxLine, showSymbol: false, connectNulls: true, z: 1,
          lineStyle: { width: 1.2, color: "#9b51e0" }, itemStyle: { color: "#9b51e0" }, emphasis: { disabled: true } }] : []),
      ],
    });
  }

  // 即時成交量更新「昨日成交量」「量比」：即時報價日期比網站資料新時，網站資料的當日量就是昨日量
  function volLive(view, s, me, yq) {
    if (!me || !me.d || !parseFloat(me.v)) return;
    const sd = String(s.date || "").replace(/-/g, "");
    if (me.d < sd) return;
    const pv = yq && yq.d === me.d && yq.pv ? yq.pv : me.d > sd ? s.vol : s.prev_vol;
    const a = view.querySelector(".si-yvol"), b = view.querySelector(".si-vr");
    if (a) a.textContent = pv == null ? "--" : fmt(pv, 0) + " 張";
    if (b) b.innerHTML = volRatio(parseFloat(me.v), pv);
  }
  // 內／外盤（Yahoo 奇摩股市；以委賣價成交為外盤、委買價成交為內盤）
  function inOut(view, yq) {
    const box = view.querySelector(".io-bar");
    if (!box || !yq || yq.inM == null || yq.outM == null || !(yq.inM + yq.outM)) return;
    const tot = yq.inM + yq.outM, pi = (yq.inM / tot) * 100;
    box.querySelector(".io-in").innerHTML = `<b>${fmt(yq.inM, 0)}</b>(${fmt(pi)}%)`;
    box.querySelector(".io-out").innerHTML = `<b>${fmt(yq.outM, 0)}</b>(${fmt(100 - pi)}%)`;
    box.querySelector(".io-in-bar").style.flexGrow = yq.inM;
    box.querySelector(".io-out-bar").style.flexGrow = yq.outM;
    box.hidden = false;
  }

  async function render(view, params) {
    while (charts.length) charts.pop().dispose();
    const code = (params.get("code") || "").toUpperCase();
    const [data, wl] = await Promise.all([App.loadData("stocks"), App.loadData("watchlist").catch(() => null)]);
    const s = data.stocks[code];

    // 上一檔／下一檔（依自選股順序）
    const list = ((wl && wl.items) || Object.keys(data.stocks)).filter((c) => data.stocks[c]);
    const at = list.indexOf(code);
    const prev = at > 0 ? list[at - 1] : null, next = at >= 0 && at < list.length - 1 ? list[at + 1] : null;

    const tech = document.createElement("a");
    tech.className = "action-btn";
    tech.href = `#/tech?code=${encodeURIComponent(code)}`;
    tech.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z"/></svg><span>技術分析</span>';
    App.setAction(tech);

    const nav = `
      <div class="stock-nav">
        <a href="#/watch" class="back">‹ 自選股</a>
        <span class="pager">
          ${prev ? `<a href="#/stock?code=${esc(prev)}" aria-label="上一檔">‹ ${esc(data.stocks[prev].name)}</a>` : ""}
          ${next ? `<a href="#/stock?code=${esc(next)}" aria-label="下一檔">${esc(data.stocks[next].name)} ›</a>` : ""}
        </span>
      </div>`;

    if (!s) {
      view.innerHTML = nav + `<div class="card empty">尚無「${esc(code)}」的個股資訊。<br>剛加入自選股的股票，需等待更新完成（約 1～3 分鐘）後才會出現。</div>`;
      return;
    }
    App.setUpdated(data.updated);
    document.title = `${s.name} ${code}｜Angus 股市`;
    view.innerHTML = nav + `
      ${s.market === "tse" || s.market === "otc" ? liveCard() : ""}
      <div class="stock-grid">
        ${infoCard(s, code)}
        <div class="stock-charts">
          ${SERIES.map((x, k) => `
            <article class="card">
              <div class="chart-title"><span class="tag ${x.tag}">${x.title}</span><span class="muted small">單位：張｜藍線：收盤價${x.cum ? `｜自 ${s.chart.length ? s.chart[0][0].slice(5).replace("-", "/") : ""} 起累計` : ""}</span></div>
              <div class="chart inst-chart" data-k="${k}"></div>
            </article>`).join("")}
          ${majorCard(s)}
          ${s.major && s.major.length ? MAJOR.map((x, k) => `
            <article class="card">
              <div class="chart-title"><span class="tag ${x.tag}">${x.title}</span><span class="muted small">單位：張${x.noPrice ? `｜自 ${s.major[0][0].slice(5).replace("-", "/")} 起累計` : "｜藍線：收盤價"}</span></div>
              <div class="chart inst-chart" data-m="${k}"></div>
            </article>`).join("") : ""}
        </div>
      </div>
      <p class="muted small note">資料時間 ${esc(data.updated)}。投信、自營商持股比率官方未公布；EPS(Y) 為近四季合計；量增幅與量比為與前一交易日成交量比較；內／外盤來源為 Yahoo 奇摩股市；買賣超與累積買賣超期間為最新資料日往前 6 個月。</p>`;
    const majorRows = (s.major || []).map((r) => [r[0], r[1], null, null, r[2]]);
    view.querySelectorAll(".inst-chart[data-m]").forEach((el) => drawChart(el, majorRows, MAJOR[+el.dataset.m]));
    view.querySelectorAll(".inst-chart[data-k]").forEach((el) => {
      if (s.chart.length) drawChart(el, s.chart, SERIES[+el.dataset.k]);
      else el.outerHTML = '<div class="empty">尚無買賣超歷史資料</div>';
    });
    // 即時走勢：開啟時載入一次（收盤後顯示最後交易日），交易時間每 30 秒更新
    if ((s.market === "tse" || s.market === "otc") && await App.hasLive()) {
      const sym = `${code}.${s.market === "otc" ? "TWO" : "TW"}`;
      let busy = false;
      const load = async () => {
        if (busy || !view.isConnected) return;
        busy = true;
        try {
          const [j, o, q, y] = await Promise.all([App.live({ t: "intraday", s: sym }, 2),
            App.live({ t: "ohlc", m: "TSE" }, 2).catch(() => null), App.twQuotes(["tse_t00.tw", `${s.market}_${code}.tw`]).catch(() => null),
            App.live({ t: "tw", s: sym }, 1).catch(() => null)]);
          const yq = y && (y.rows || []).find((r) => r.c === code);
          let idx = null;
          const t00 = q && (q.rows || []).find((r) => r.c === "t00");
          const me = q && (q.rows || []).find((r) => r.c === code);
          if (me && j && j.day && me.d === j.day.replace(/-/g, "")) { j.dayHigh = parseFloat(me.h) || null; j.dayLow = parseFloat(me.l) || null; }
          const prevIdx = t00 && parseFloat(t00.y);
          if (o && o.rows && j && j.day && String(o.key || "").endsWith(j.day.replace(/-/g, "")) && prevIdx) {
            idx = { prev: prevIdx, rows: o.rows.map((r) => [`${r[0].slice(0, 2)}:${r[0].slice(2, 4)}`, parseFloat(r[1])]),
              now: t00.d === j.day.replace(/-/g, "") ? parseFloat(t00.z) || null : null }; // 最新／收盤指數
          }
          drawLive(view, j, idx);
          volLive(view, s, me || yq, yq);
          inOut(view, yq);
        }
        catch (e) { const t = view.querySelector(".lv-time"); if (t && t.textContent.includes("載入中")) t.textContent = "即時走勢暫時無法取得"; }
        finally { busy = false; }
      };
      load();
      const timer = setInterval(() => { if (!view.isConnected) clearInterval(timer); else if (!document.hidden && App.marketOpen()) load(); }, 30000);
    }
  }

  window.addEventListener("resize", () => charts.forEach((c) => c.resize()));
  App.register({ id: "stock", title: "個股資訊", icon: "📄", hidden: true, menu: "watch", render });
})();
