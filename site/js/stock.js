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

  const SERIES = [
    { i: 1, title: "外資買賣超", tag: "t1" },
    { i: 2, title: "投信買賣超", tag: "t2" },
    { i: 3, title: "自營商買賣超", tag: "t3" },
    // 累積買賣超：自圖表起始日起逐日加總
    { i: 1, title: "外資累積買賣超", tag: "t1", cum: true, color: "#ff3fa0" },
    { i: 2, title: "投信累積買賣超", tag: "t2", cum: true, color: "#f5b800" },
  ];

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
    const pmin = Math.min(...pxv), pmax = Math.max(...pxv), pad = (pmax - pmin) * 0.1 || 1;
    const muted = { color: css("--muted"), fontSize: 11 };
    c.setOption({
      animation: false,
      grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
      tooltip: {
        trigger: "axis", confine: true, axisPointer: { type: "shadow" },
        backgroundColor: css("--surface"), borderColor: css("--border"), textStyle: { color: css("--text"), fontSize: 12 },
        formatter: (ps) => {
          const i = ps[0].dataIndex;
          return `<b>${dates[i]}</b><br>${x.cum ? "累積買賣超" : "買賣超"} <b style="color:${vals[i] >= 0 ? up : down}">${sgn(vals[i], 0)}</b> 張<br>收盤價 <b>${fmt(px[i])}</b>`;
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
          ? { name: "累積買賣超", type: "line", data: vals, smooth: true, symbol: "none", emphasis: { disabled: true }, lineStyle: { width: 2, color: x.color }, itemStyle: { color: x.color } }
          : { name: "買賣超", type: "bar", data: vals.map((v) => ({ value: v, itemStyle: { color: v >= 0 ? up : down } })), barMaxWidth: 8 },
        { name: "股價", type: "line", yAxisIndex: 1, data: px, smooth: true, symbol: "none", emphasis: { disabled: true }, lineStyle: { width: 2, color: line }, itemStyle: { color: line } },
      ],
    });
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
      <div class="stock-grid">
        ${infoCard(s, code)}
        <div class="stock-charts">
          ${SERIES.map((x, k) => `
            <article class="card">
              <div class="chart-title"><span class="tag ${x.tag}">${x.title}</span><span class="muted small">單位：張｜藍線：收盤價${x.cum ? `｜自 ${s.chart.length ? s.chart[0][0].slice(5).replace("-", "/") : ""} 起累計` : ""}</span></div>
              <div class="chart inst-chart" data-k="${k}"></div>
            </article>`).join("")}
        </div>
      </div>
      <p class="muted small note">資料時間 ${esc(data.updated)}。投信、自營商持股比率官方未公布；EPS(Y) 為近四季合計；量增幅為與前一交易日成交量比較；買賣超與累積買賣超為近半年（約 125 個交易日）。</p>`;
    view.querySelectorAll(".inst-chart").forEach((el) => {
      if (s.chart.length) drawChart(el, s.chart, SERIES[+el.dataset.k]);
      else el.outerHTML = '<div class="empty">尚無買賣超歷史資料</div>';
    });
  }

  window.addEventListener("resize", () => charts.forEach((c) => c.resize()));
  App.register({ id: "stock", title: "個股資訊", icon: "📄", hidden: true, menu: "watch", render });
})();
