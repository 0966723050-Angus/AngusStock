/* 即時選股：即時擷取上市櫃全部普通股的當日成交資訊（經 Apps Script 查 Yahoo 奇摩股市），依條件列出前 50 名 */
(function () {
  "use strict";

  const TAB_KEY = "angus.rt.tab";
  const MIN_KEY = "angus.rt.dtMin";
  const TOP = 50;
  const fmt = (v, d = 2) => (v == null || !isFinite(v) ? "--" : Number(v).toLocaleString("zh-TW", { minimumFractionDigits: d, maximumFractionDigits: d }));
  const sgn = (v, d = 2) => (v == null || !isFinite(v) ? "--" : (v > 0 ? "+" : "") + fmt(v, d));
  const cls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const numv = (x) => { const v = parseFloat(String(x ?? "").replace(/,/g, "")); return isFinite(v) ? v : null; };
  const pd = (p) => (p != null && p >= 1000 && p % 1 === 0 ? 0 : 2);

  // 欄位：today 今日量、prev 昨日量、amt 成交金額（億元）、pct 漲跌幅、amp 振幅、am 09:30～11:40 量、pm 11:41～13:20 量、ratio 午盤量／早盤量
  const COLS = {
    px: { t: "價格", v: (r) => r.px, f: (r) => `<b>${fmt(r.px, pd(r.px))}</b>`, c: (r) => cls(r.pct) },
    pct: { t: "漲跌%", v: (r) => r.pct, f: (r) => sgn(r.pct), c: (r) => cls(r.pct) },
    amp: { t: "振幅%", v: (r) => r.amp, f: (r) => fmt(r.amp) },
    today: { t: "今日量", v: (r) => r.today, f: (r) => fmt(r.today, 0) },
    prev: { t: "昨日量", v: (r) => r.prev, f: (r) => fmt(r.prev, 0) },
    amt: { t: "金額(億)", v: (r) => r.amt, f: (r) => fmt(r.amt) },
    ratio: { t: "比值", v: (r) => r.ratio, f: (r) => `<b>${fmt(r.ratio)}</b>` },
    am: { t: "早盤量", v: (r) => r.am, f: (r) => fmt(r.am, 0) },
    pm: { t: "午盤量", v: (r) => r.pm, f: (r) => fmt(r.pm, 0) },
  };
  const BASE = ["px", "pct", "amp", "today", "prev", "amt"];
  const TABS = [
    { id: "vol", t: "成交量", key: "today", cols: BASE },
    { id: "amt", t: "成交金額", key: "amt", cols: BASE },
    { id: "amp", t: "振幅", key: "amp", cols: BASE },
    { id: "pct", t: "漲跌幅", key: "pct", cols: BASE },
    { id: "dt", t: "隔日沖", key: "ratio", cols: ["px", "pct", "ratio", "am", "pm", "today"] },
  ];

  // 查詢結果保留在記憶體：切換分頁或回到本頁時直接顯示，按「立即查詢」才重新擷取
  let base = null, split = null;

  // 股票清單：網站資料庫（上市櫃普通股，不含 ETF）
  async function universe() {
    const db = await App.loadData("screen");
    return Object.entries(db.rows).map(([c, r]) => ({ c, n: r.n, m: r.m, yv: r.t[3], db }));
  }
  const symOf = (s) => `${s.c}.${s.m === "otc" ? "TWO" : "TW"}`;
  const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

  // 全部股票即時報價：每次 250 檔、同時送出（Apps Script 內再分 50 檔一批）
  async function fetchBase(list) {
    const res = await Promise.all(chunks(list, 250).map((g) =>
      App.live({ t: "tw", s: g.map(symOf).join(",") }, 2).catch(() => ({ rows: [] }))));
    const by = new Map(res.flatMap((j) => j.rows || []).map((r) => [r.c, r]));
    const db = list[0] && list[0].db;
    const rows = [];
    let at = "", noAmt = true;
    for (const s of list) {
      const q = by.get(s.c);
      if (!q) continue;
      const px = numv(q.z), y = numv(q.y), h = numv(q.h), l = numv(q.l), today = numv(q.v);
      if (px == null || !y) continue;
      const d = q.d ? `${q.d.slice(0, 4)}-${q.d.slice(4, 6)}-${q.d.slice(6)}` : "";
      // 昨日量：Yahoo 提供；舊版中轉程式沒有時，以網站資料庫推算
      let prev = q.pv != null ? q.pv : null;
      if (prev == null && db) prev = d > db.today ? s.yv : db.rows[s.c].y[3];
      const amt = q.amt != null ? numv(q.amt) / 100 : null;
      if (amt != null) noAmt = false;
      rows.push({ c: s.c, n: s.n, m: s.m, px, today, prev, amt, pct: ((px - y) / y) * 100,
        amp: h != null && l != null ? ((h - l) / y) * 100 : null, d });
      const t = `${d} ${q.t || ""}`.trim();
      if (t > at) at = t;
    }
    return { rows, at, n: list.length, noAmt, ts: Date.now() };
  }

  // 隔日沖：各股分時量（每次 200 檔、同時送出）
  async function fetchSplit(list) {
    const res = await Promise.all(chunks(list, 200).map((g) =>
      App.live({ t: "split", s: g.map(symOf).join(",") }, 2)));
    const by = new Map();
    let last = "", day = "";
    for (const j of res) for (const r of j.rows || []) {
      by.set(r[0], { am: r[1], pm: r[2] });
      if (r[4] > day || (r[4] === day && r[3] > last)) { day = r[4]; last = r[3]; }
    }
    return { by, last, day, ts: Date.now() };
  }

  function rankRows(tab, minVol) {
    if (!base) return [];
    let rows = base.rows;
    if (tab.id === "dt") {
      if (!split) return [];
      rows = rows.map((r) => {
        const x = split.by.get(r.c);
        return x ? { ...r, am: x.am, pm: x.pm, ratio: x.am > 0 ? x.pm / x.am : null } : null;
      }).filter((r) => r && r.ratio != null && (r.today || 0) >= minVol);
    } else {
      rows = rows.filter((r) => COLS[tab.key].v(r) != null && (tab.id === "pct" || tab.id === "amp" || (r.today || 0) > 0));
    }
    return rows.slice().sort((a, b) => COLS[tab.key].v(b) - COLS[tab.key].v(a)).slice(0, TOP);
  }

  function table(tab, rows) {
    const cols = tab.cols;
    return `
      <div class="tbl-wrap rt-scroll">
        <table class="tbl rt-tbl">
          <thead><tr><th class="stk">股票</th>${cols.map((k) => `<th class="${k === tab.key ? "sorted" : ""}">${COLS[k].t}${k === tab.key ? " ▼" : ""}</th>`).join("")}</tr></thead>
          <tbody>${rows.length ? rows.map((r, i) => `
            <tr><td class="stk"><a href="#/tech?code=${esc(r.c)}"><b>${esc(r.n)}</b><small>${i + 1}｜${esc(r.c)}</small></a></td>${
              cols.map((k) => `<td class="num ${COLS[k].c ? COLS[k].c(r) : ""}">${COLS[k].f(r)}</td>`).join("")}</tr>`).join("")
            : `<tr><td colspan="${cols.length + 1}" class="empty">無符合條件的股票</td></tr>`}</tbody>
        </table>
      </div>`;
  }

  async function render(view) {
    let tabId = "vol";
    try { tabId = localStorage.getItem(TAB_KEY) || tabId; } catch (e) { /* ignore */ }
    if (!TABS.some((t) => t.id === tabId)) tabId = "vol";
    let minVol = 500;
    try { const v = localStorage.getItem(MIN_KEY); if (v != null && isFinite(+v)) minVol = +v; } catch (e) { /* ignore */ }
    if (!(await App.hasLive())) { view.innerHTML = '<div class="card empty">尚未設定即時報價服務（Apps Script），無法即時選股</div>'; return; }
    let list = null, busy = false, msg = "";

    const draw = () => {
      const tab = TABS.find((t) => t.id === tabId);
      const dt = tab.id === "dt";
      let body;
      if (busy) body = `<div class="card empty"><span class="spinner"></span> ${esc(msg || "擷取中…")}</div>`;
      else if (!base) body = `<div class="card empty">${esc(msg || "按「立即查詢」擷取上市櫃全部股票的即時成交資訊")}</div>`;
      else if (dt && !split) body = `<div class="card empty">${esc(msg || "按「立即查詢」計算隔日沖")}</div>`;
      else if (tab.id === "amt" && base.noAmt) body = '<div class="card empty">成交金額需要更新 Apps Script（第 9 版）後才能取得</div>';
      else body = `<article class="card">${table(tab, rankRows(tab, minVol))}</article>`;
      const range = dt && split && split.last ? `｜午盤量區間 11:41～${split.last < "13:20" ? split.last : "13:20"}` : "";
      view.innerHTML = `
        <div class="section-title"><h2>即時選股</h2>
          <span class="watch-meta"><span class="muted small">${base ? `報價時間 ${esc(base.at)}｜${base.rows.length} 檔${esc(range)}` : ""}</span>
          <button type="button" class="btn-ghost rt-go"${busy ? " disabled" : ""}>立即查詢</button></span></div>
        <div class="seg rt-tabs" role="tablist">${TABS.map((t) => `<button type="button" role="tab" data-tab="${t.id}" aria-pressed="${t.id === tabId}">${t.t}</button>`).join("")}</div>
        ${dt ? `<div class="rt-opt"><label>今日量 ≥ <input type="number" class="rt-min" inputmode="numeric" min="0" step="100" value="${minVol}"> 張</label>
          <span class="muted small">比值 = 11:41～13:20 成交量 ÷ 09:30～11:40 成交量（未到 13:20 時算到查詢當下）</span></div>` : ""}
        ${body}
        <p class="muted small note">資料來源：Yahoo 奇摩股市即時報價（上市櫃普通股，不含 ETF），每次查詢約需 5～15 秒；各分頁列出前 ${TOP} 名。漲跌幅、振幅以昨收為基準；振幅 =（最高 − 最低）÷ 昨收；成交量單位：張；金額單位：億元。隔日沖：早盤量 = 09:30～11:40、午盤量 = 11:41～13:20（13:20 前查詢則算到當下最新一分鐘），11:41 以前無法計算。點股票名稱開啟技術分析。</p>`;
    };

    const query = async () => {
      if (busy) return;
      busy = true;
      const tab = TABS.find((t) => t.id === tabId);
      try {
        msg = "載入股票清單…"; draw();
        list = list || await universe();
        msg = `擷取 ${list.length} 檔即時報價…`; draw();
        base = await fetchBase(list);
        split = null;
        msg = "";
        if (tab.id === "dt") await querySplit();
      } catch (e) {
        msg = "查詢失敗：" + (e.message || e);
      } finally { busy = false; if (view.isConnected) draw(); }
    };
    // 隔日沖：交易日 11:41 以前無法計算（收盤後或非交易日則以最近交易日計算）
    const querySplit = async () => {
      const now = App.taipei(), today = now.slice(0, 10), hm = now.slice(11, 16);
      if (base && base.at.slice(0, 10) === today && hm < "11:41") { msg = "隔日沖需 11:41 以後才能計算（午盤量區間 11:41～13:20）"; return; }
      msg = "擷取各股分時量…"; draw();
      list = list || await universe();
      const have = new Set(base.rows.map((r) => r.c));
      split = await fetchSplit(list.filter((s) => have.has(s.c)));
      msg = "";
    };

    // 已有報價但還沒有分時量（切到隔日沖分頁、或回到本頁時）：自動補查分時量
    const ensureSplit = async () => {
      if (tabId !== "dt" || !base || split || busy) return;
      busy = true;
      try { await querySplit(); } catch (err) { msg = "查詢失敗：" + (err.message || err); }
      finally { busy = false; if (view.isConnected) draw(); }
    };

    draw();
    if (!base) query(); else ensureSplit();
    view.addEventListener("click", async (e) => {
      const t = e.target.closest("[data-tab]");
      if (t) {
        tabId = t.dataset.tab;
        try { localStorage.setItem(TAB_KEY, tabId); } catch (err) { /* ignore */ }
        msg = "";
        draw();
        ensureSplit();
        return;
      }
      if (e.target.closest(".rt-go")) query();
    });
    view.addEventListener("change", (e) => {
      if (!e.target.matches(".rt-min")) return;
      minVol = Math.max(0, +e.target.value || 0);
      try { localStorage.setItem(MIN_KEY, String(minVol)); } catch (err) { /* ignore */ }
      draw();
    });
  }

  App.register({ id: "rt", title: "即時選股", icon: "⚡", render });
})();
