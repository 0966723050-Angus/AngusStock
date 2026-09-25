/* 股票篩選：以資料庫（今天／昨天日線＋當月月線）比較條件；上方勾選條件、下方列出符合的股票 */
(function () {
  "use strict";

  const SEL_KEY = "angus.screen.sel";
  const MODE_KEY = "angus.screen.mode";
  const fmt = (v, d = 2) => (v == null || !isFinite(v) ? "--" : Number(v).toLocaleString("zh-TW", { minimumFractionDigits: d, maximumFractionDigits: d }));
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const cls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");

  // 資料庫欄位索引（與 scripts/market_db.py FIELDS 相同順序）
  const F = { p: 0, chg: 1, pct: 2, vol: 3, val: 4, amp: 5, s5: 6, s10: 7, s20: 8, s60: 9, s100: 10,
    dif: 11, macd: 12, osc: 13, bu: 14, bm: 15, bl: 16, bw: 17, r6: 18, r12: 19, k: 20, d: 21, j: 22 };
  const ok = (...v) => v.every((x) => x != null && isFinite(x));
  const spread = (a) => (ok(a.s5, a.s10, a.s20, a.s60) ? ((Math.max(a.s5, a.s10, a.s20, a.s60) - Math.min(a.s5, a.s10, a.s20, a.s60)) / Math.min(a.s5, a.s10, a.s20, a.s60)) * 100 : null);
  const tangled = (a) => { const s = spread(a); return s != null && s <= 5; };
  const monthKey = (mo) => (mo ? (mo[1] + mo[2]) / 2 : null); // 月關鍵價 =（月最高 + 月最低）÷ 2

  // 條件：test(t 今天, y 昨天, row) → 是否符合；show → 表格顯示值；sort → 排序用數值
  const GROUPS = [
    { title: "KD", items: [
      { id: "kd_gold", label: "KD 黃金交叉", note: "昨天 K≦D，今天 K＞D",
        test: (t, y) => ok(t.k, t.d, y.k, y.d) && y.k <= y.d && t.k > t.d, show: (t) => `K ${fmt(t.k, 1)}／D ${fmt(t.d, 1)}`, sort: (t) => t.k - t.d },
      { id: "kd_dead", label: "KD 死亡交叉", note: "昨天 K≧D，今天 K＜D",
        test: (t, y) => ok(t.k, t.d, y.k, y.d) && y.k >= y.d && t.k < t.d, show: (t) => `K ${fmt(t.k, 1)}／D ${fmt(t.d, 1)}`, sort: (t) => t.d - t.k },
      { id: "k_up70", label: "K 穿越上限", note: "昨天 K≦70，今天 K＞70",
        test: (t, y) => ok(t.k, y.k) && y.k <= 70 && t.k > 70, show: (t, y) => `${fmt(y.k, 1)} → ${fmt(t.k, 1)}`, sort: (t) => t.k },
      { id: "k_up30", label: "K 穿越下限", note: "昨天 K≦30，今天 K＞30",
        test: (t, y) => ok(t.k, y.k) && y.k <= 30 && t.k > 30, show: (t, y) => `${fmt(y.k, 1)} → ${fmt(t.k, 1)}`, sort: (t) => t.k },
    ] },
    { title: "J 值", items: [
      { id: "j_neg", label: "J 值小於 0", note: "今天 J＜0",
        test: (t) => ok(t.j) && t.j < 0, show: (t) => fmt(t.j, 1), sort: (t) => -t.j },
      { id: "j_up0", label: "J 向上穿越 0 軸", note: "昨天 J≦0，今天 J＞0",
        test: (t, y) => ok(t.j, y.j) && y.j <= 0 && t.j > 0, show: (t, y) => `${fmt(y.j, 1)} → ${fmt(t.j, 1)}`, sort: (t) => t.j },
      { id: "j_dn0", label: "J 向下穿越 0 軸", note: "昨天 J≧0，今天 J＜0",
        test: (t, y) => ok(t.j, y.j) && y.j >= 0 && t.j < 0, show: (t, y) => `${fmt(y.j, 1)} → ${fmt(t.j, 1)}`, sort: (t) => -t.j },
    ] },
    { title: "均線排列", items: [
      { id: "ma_bull", label: "多頭排列", note: "SMA5＞SMA10＞SMA20＞SMA60＞SMA100",
        test: (t) => ok(t.s5, t.s10, t.s20, t.s60, t.s100) && t.s5 > t.s10 && t.s10 > t.s20 && t.s20 > t.s60 && t.s60 > t.s100,
        show: (t) => `SMA5 ${fmt(t.s5)}／SMA100 ${fmt(t.s100)}`, sort: (t) => (t.s5 / t.s100 - 1) * 100 },
      { id: "ma_bear", label: "空頭排列", note: "SMA5＜SMA10＜SMA20＜SMA60＜SMA100",
        test: (t) => ok(t.s5, t.s10, t.s20, t.s60, t.s100) && t.s5 < t.s10 && t.s10 < t.s20 && t.s20 < t.s60 && t.s60 < t.s100,
        show: (t) => `SMA5 ${fmt(t.s5)}／SMA100 ${fmt(t.s100)}`, sort: (t) => (t.s100 / t.s5 - 1) * 100 },
      { id: "ma_tangle", label: "均線糾結", note: "SMA5～SMA60 最高與最低相差 5% 以內",
        test: (t) => tangled(t), show: (t) => `相差 ${fmt(spread(t))}%`, sort: (t) => -spread(t) },
      { id: "ma_break", label: "突破均線", note: "昨天均線糾結，今天價格比昨天高 5% 以上",
        test: (t, y) => tangled(y) && ok(t.p, y.p) && t.p >= y.p * 1.05, show: (t, y) => `${fmt(y.p)} → ${fmt(t.p)}（+${fmt((t.p / y.p - 1) * 100)}%）`, sort: (t, y) => t.p / y.p },
    ] },
    { title: "股價位置", items: [
      { id: "p_s5", label: "股價＞SMA5", note: "今天價格＞5 日均線",
        test: (t) => ok(t.p, t.s5) && t.p > t.s5, show: (t) => `${fmt(t.p)}／${fmt(t.s5)}`, sort: (t) => t.p / t.s5 },
      { id: "p_s10", label: "股價＞SMA10", note: "今天價格＞10 日均線",
        test: (t) => ok(t.p, t.s10) && t.p > t.s10, show: (t) => `${fmt(t.p)}／${fmt(t.s10)}`, sort: (t) => t.p / t.s10 },
    ] },
    { title: "MACD", items: [
      { id: "macd_gold", label: "黃金交叉", note: "昨天快線≦慢線，今天快線＞慢線",
        test: (t, y) => ok(t.dif, t.macd, y.dif, y.macd) && y.dif <= y.macd && t.dif > t.macd, show: (t) => `快 ${fmt(t.dif)}／慢 ${fmt(t.macd)}`, sort: (t) => t.dif - t.macd },
      { id: "macd_dead", label: "死亡交叉", note: "昨天快線≧慢線，今天快線＜慢線",
        test: (t, y) => ok(t.dif, t.macd, y.dif, y.macd) && y.dif >= y.macd && t.dif < t.macd, show: (t) => `快 ${fmt(t.dif)}／慢 ${fmt(t.macd)}`, sort: (t) => t.macd - t.dif },
      { id: "macd_up0", label: "快線向上穿越 0 軸", note: "昨天快線≦0，今天快線＞0",
        test: (t, y) => ok(t.dif, y.dif) && y.dif <= 0 && t.dif > 0, show: (t, y) => `${fmt(y.dif)} → ${fmt(t.dif)}`, sort: (t) => t.dif },
      { id: "macd_dn0", label: "快線向下穿越 0 軸", note: "昨天快線≧0，今天快線＜0",
        test: (t, y) => ok(t.dif, y.dif) && y.dif >= 0 && t.dif < 0, show: (t, y) => `${fmt(y.dif)} → ${fmt(t.dif)}`, sort: (t) => -t.dif },
    ] },
    { title: "RSI（快線 6 日）", items: [
      { id: "rsi_80", label: "RSI＞80", note: "今天 RSI6＞80",
        test: (t) => ok(t.r6) && t.r6 > 80, show: (t) => fmt(t.r6, 1), sort: (t) => t.r6 },
      { id: "rsi_20", label: "RSI＜20", note: "今天 RSI6＜20",
        test: (t) => ok(t.r6) && t.r6 < 20, show: (t) => fmt(t.r6, 1), sort: (t) => -t.r6 },
      { id: "rsi_up50", label: "RSI 快線向上穿越 50", note: "昨天 RSI6≦50，今天 RSI6＞50",
        test: (t, y) => ok(t.r6, y.r6) && y.r6 <= 50 && t.r6 > 50, show: (t, y) => `${fmt(y.r6, 1)} → ${fmt(t.r6, 1)}`, sort: (t) => t.r6 },
      { id: "rsi_dn50", label: "RSI 快線向下穿越 50", note: "昨天 RSI6≧50，今天 RSI6＜50",
        test: (t, y) => ok(t.r6, y.r6) && y.r6 >= 50 && t.r6 < 50, show: (t, y) => `${fmt(y.r6, 1)} → ${fmt(t.r6, 1)}`, sort: (t) => -t.r6 },
    ] },
    { title: "好球", items: [
      { id: "vol_x2", label: "成交量倍數＞2", note: "今天成交量 ÷ 昨天成交量＞2",
        test: (t, y) => ok(t.vol, y.vol) && y.vol > 0 && t.vol / y.vol > 2, show: (t, y) => `${fmt(t.vol / y.vol)} 倍`, sort: (t, y) => t.vol / y.vol },
      { id: "p_mkey", label: "成交價＞月關鍵價", note: "月關鍵價 =（當月最高價＋當月最低價）÷ 2",
        test: (t, y, r) => ok(t.p, monthKey(r.mo)) && t.p > monthKey(r.mo), show: (t, y, r) => `${fmt(t.p)}／${fmt(monthKey(r.mo))}`, sort: (t, y, r) => t.p / monthKey(r.mo) },
    ] },
  ];
  const ALL = GROUPS.flatMap((g) => g.items);

  const obj = (arr) => (arr ? Object.fromEntries(Object.entries(F).map(([k, i]) => [k, arr[i]])) : {});
  const readSel = () => { try { return JSON.parse(localStorage.getItem(SEL_KEY) || "[]"); } catch (e) { return []; } };
  const readMode = () => { try { return localStorage.getItem(MODE_KEY) || "all"; } catch (e) { return "all"; } };

  let db = null, sortBy = null, sortDir = -1;

  function results(sel, mode) {
    const conds = ALL.filter((c) => sel.includes(c.id));
    if (!conds.length) return { conds, rows: [] };
    const rows = [];
    for (const [code, r] of Object.entries(db.rows)) {
      const t = obj(r.t), y = obj(r.y);
      const hits = conds.map((c) => { try { return c.test(t, y, r); } catch (e) { return false; } });
      if (mode === "all" ? hits.every(Boolean) : hits.some(Boolean)) rows.push({ code, r, t, y, hits });
    }
    const key = sortBy && conds.find((c) => c.id === sortBy);
    rows.sort((a, b) => {
      if (key) {
        const va = a.hits[conds.indexOf(key)] ? key.sort(a.t, a.y, a.r) : -Infinity;
        const vb = b.hits[conds.indexOf(key)] ? key.sort(b.t, b.y, b.r) : -Infinity;
        const d = sortDir < 0 ? vb - va : va - vb; // 預設由大到小
        return (isNaN(d) ? 0 : d) || a.code.localeCompare(b.code);
      }
      return (b.t.pct ?? -99) - (a.t.pct ?? -99); // 預設依今天漲幅排序
    });
    return { conds, rows };
  }

  function renderResults(view) {
    const sel = readSel(), mode = readMode();
    const box = view.querySelector("#scrResult");
    const { conds, rows } = results(sel, mode);
    const go = view.querySelector(".scr-go");
    go.hidden = !conds.length;
    go.textContent = `查看結果（${rows.length} 檔）`;
    if (!conds.length) { box.innerHTML = '<div class="card empty">請勾選上方篩選條件</div>'; return; }
    const MAX = 300;
    box.innerHTML = `
      <div class="section-title"><h2>符合條件：${rows.length} 檔</h2><span class="muted small">${rows.length > MAX ? `僅顯示前 ${MAX} 檔｜` : ""}點股票名稱開啟技術分析；點欄位標題排序</span></div>
      <article class="card"><div class="tbl-wrap">
        <table class="tbl scr-tbl">
          <thead><tr><th class="stk">股票</th>${conds.map((c) => `<th data-sort="${c.id}" title="${esc(c.note)}" class="${sortBy === c.id ? "sorted" : ""}">${esc(c.label)}${sortBy === c.id ? (sortDir < 0 ? " ▼" : " ▲") : ""}</th>`).join("")}</tr></thead>
          <tbody>${rows.slice(0, MAX).map(({ code, r, t, y, hits }) => `
            <tr>
              <td class="stk"><a href="#/tech?code=${code}"><b>${esc(r.n)}</b></a><small>${code}・${fmt(t.p)} <span class="${cls(t.pct)}">${t.pct > 0 ? "+" : ""}${fmt(t.pct)}%</span></small></td>
              ${conds.map((c, i) => `<td class="${hits[i] ? "hit" : "miss"}">${hits[i] ? esc(c.show(t, y, r)) : "—"}</td>`).join("")}
            </tr>`).join("") || `<tr><td colspan="${conds.length + 1}" class="empty">沒有符合的股票</td></tr>`}
          </tbody>
        </table>
      </div></article>`;
  }

  async function render(view) {
    db = await App.loadData("screen");
    App.setUpdated(db.updated);
    const sel = readSel(), mode = readMode();
    const md = (iso) => `${+iso.slice(5, 7)}/${+iso.slice(8)}`;
    view.innerHTML = `
      <div class="scr-status card">
        <div>
          <b>資料庫</b>　今天 ${md(db.today)}${db.provisional ? "（盤後暫定）" : ""}／昨天 ${md(db.yesterday)}
          <small>上市櫃一般股票 ${Object.keys(db.rows).length} 檔（不含 ETF、存託憑證）｜更新時間 ${esc(db.updated)}</small>
        </div>
        <button type="button" class="btn-primary scr-update">立即更新資料庫</button>
      </div>
      <div class="section-title"><h2>篩選條件</h2></div>
      <article class="card scr-panel">
        <div class="scr-mode" role="radiogroup" aria-label="多個條件的組合方式">
          <label><input type="radio" name="scrMode" value="all" ${mode === "all" ? "checked" : ""}> 符合全部勾選條件</label>
          <label><input type="radio" name="scrMode" value="any" ${mode === "any" ? "checked" : ""}> 符合任一條件</label>
          <button type="button" class="btn-ghost scr-clear">清除勾選</button>
        </div>
        <div class="scr-groups">
          ${GROUPS.map((g) => `
            <fieldset class="scr-group"><legend>${esc(g.title)}</legend>
              ${g.items.map((c) => `<label class="scr-item" title="${esc(c.note)}"><input type="checkbox" value="${c.id}" ${sel.includes(c.id) ? "checked" : ""}>
                <span>${esc(c.label)}<small>${esc(c.note)}</small></span></label>`).join("")}
            </fieldset>`).join("")}
        </div>
        <button type="button" class="btn-primary scr-go" hidden>查看結果</button>
      </article>
      <div id="scrResult"></div>
      <p class="muted small note">資料庫每日 13:40（盤後暫定）與 22:00（官方收盤）自動更新，也可按上方「立即更新資料庫」或頁首 ☁ 按鈕手動更新。指標公式與技術分析頁相同：KD 9 日、RSI 6／12 日、MACD 12／26／9、布林 20 日 ±2 標準差。</p>`;

    view.querySelector(".scr-groups").addEventListener("change", () => {
      const s = [...view.querySelectorAll(".scr-item input:checked")].map((i) => i.value);
      try { localStorage.setItem(SEL_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
      if (sortBy && !s.includes(sortBy)) sortBy = null;
      renderResults(view);
    });
    view.querySelector(".scr-mode").addEventListener("change", (e) => {
      if (e.target.name !== "scrMode") return;
      try { localStorage.setItem(MODE_KEY, e.target.value); } catch (err) { /* ignore */ }
      renderResults(view);
    });
    view.querySelector(".scr-clear").addEventListener("click", () => {
      view.querySelectorAll(".scr-item input").forEach((i) => { i.checked = false; });
      try { localStorage.setItem(SEL_KEY, "[]"); } catch (e) { /* ignore */ }
      sortBy = null;
      renderResults(view);
    });
    view.querySelector(".scr-update").addEventListener("click", () => {
      if (App.isUpdating()) { App.toast("已有更新在進行中，請稍候"); return; }
      if (confirm("要立即向交易所抓取最新資料並更新資料庫嗎？\n（約需 3～5 分鐘；收盤前為前一交易日資料，13:30 收盤後為盤後暫定，官方收盤資料約傍晚公布）")) App.runUpdate();
    });
    view.querySelector(".scr-go").addEventListener("click", () => view.querySelector("#scrResult").scrollIntoView({ behavior: "smooth", block: "start" }));
    view.querySelector("#scrResult").addEventListener("click", (e) => {
      const th = e.target.closest("th[data-sort]");
      if (!th) return;
      if (sortBy === th.dataset.sort) sortDir = -sortDir; else { sortBy = th.dataset.sort; sortDir = -1; }
      renderResults(view);
    });
    renderResults(view);
  }

  App.register({ id: "screen", title: "股票篩選", icon: "🔍", render });
})();
