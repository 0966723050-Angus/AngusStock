/* 國際股市行情：報價表、編輯（刪除／排序／新增），格式同自選股行情 */
(function () {
  "use strict";

  const PENDING = "angus.intl.pending";
  const DEFAULT = ["^DJI", "^VIX", "^SOX", "^GSPC", "^IXIC", "^N225", "^KS11"];
  const fmt = (v, d = 2) => (v == null || isNaN(v) ? "--" : Number(v).toLocaleString("zh-TW", { minimumFractionDigits: d, maximumFractionDigits: d }));
  const sgn = (v, d = 2) => (v == null ? "--" : (v > 0 ? "+" : "") + fmt(v, d));
  const cls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const digits = (p) => (p != null && Math.abs(p) < 100 ? (Math.abs(p) < 10 ? 3 : 2) : 2);

  let data = { rows: {}, catalog: [] };
  let items = [];

  // ------------------------------------------------------------ 清單讀寫
  function readPending() {
    try { return JSON.parse(localStorage.getItem(PENDING) || "null"); } catch (e) { return null; }
  }
  function writePending(v) {
    try { v ? localStorage.setItem(PENDING, JSON.stringify(v)) : localStorage.removeItem(PENDING); } catch (e) { /* ignore */ }
  }
  async function loadList() {
    let server = null;
    try { server = await App.loadData("intl_list"); } catch (e) {
      if (e && e.name === "OperationError") throw e;
    }
    const pending = readPending();
    if (pending && (!server || (server.ts || 0) < pending.ts)) return { items: pending.items, syncing: true };
    if (pending) writePending(null);
    return { items: (server && server.items) || DEFAULT, syncing: false };
  }
  const nameOf = (s) => (data.rows[s] && data.rows[s][0]) || (data.catalog.find((c) => c[0] === s) || [])[1] || s;

  // ------------------------------------------------------------ 報價表
  function row(sym) {
    const q = data.rows[sym];
    if (!q) return `<tr><td class="stk"><b>${esc(nameOf(sym))}</b><small>${esc(sym)}</small></td><td colspan="5" class="muted c">等待更新／查無資料</td></tr>`;
    const [name, price, chg, high, low, , prev, when] = q;
    const pct = prev ? (chg / prev) * 100 : null;
    const amp = prev && high != null && low != null ? ((high - low) / prev) * 100 : null;
    const d = digits(price);
    const t = when ? `${+when.slice(5, 7)}/${+when.slice(8, 10)}<br>${when.slice(11)}` : "--";
    return `<tr>
      <td class="stk"><b>${esc(name)}</b><small>${esc(sym)}</small></td>
      <td class="num ${cls(chg)}"><b>${fmt(price, d)}</b></td>
      <td class="num ${cls(chg)}">${chg > 0 ? "▲" : chg < 0 ? "▼" : ""}${chg == null ? "--" : fmt(Math.abs(chg), d)}</td>
      <td class="num ${cls(chg)}">${sgn(pct)}</td>
      <td class="num">${fmt(amp)}</td>
      <td class="num intl-time">${t}</td>
    </tr>`;
  }

  function renderTable(view, syncing) {
    view.innerHTML = `
      <div class="section-title"><h2>國際股市行情</h2>
        <span class="watch-meta"><span class="muted small">更新時間 ${esc(data.updated || "--")}${syncing ? "｜<b>清單同步中</b>" : ""}</span>
        <button type="button" class="btn-ghost intl-update">立即更新行情</button></span></div>
      <article class="card">
        <div class="tbl-wrap watch-scroll">
          <table class="tbl watch-tbl">
            <colgroup><col class="c-stk"><col class="c-px"><col class="c-chg"><col class="c-pct"><col class="c-amp"><col class="c-vol"></colgroup>
            <thead><tr><th>指數</th><th>成交價</th><th>漲跌</th><th>漲幅%</th><th>振幅%</th><th>報價時間</th></tr></thead>
            <tbody>${items.length ? items.map(row).join("") : '<tr><td colspan="6" class="empty">尚無項目，請按右上角「編輯」新增</td></tr>'}</tbody>
          </table>
        </div>
      </article>
      <p class="muted small note">資料來源：Yahoo Finance。開啟本頁時即時更新並每 60 秒自動刷新；網站另於每天台北時間 21:00～05:00、08:00～14:00 每半小時更新。漲跌與前一交易日收盤比較；報價時間為台北時間。</p>`;
  }

  // ------------------------------------------------------------ 即時行情（經 Google Apps Script 中轉查 Yahoo，約 1～3 秒）
  const tpe = (sec) => new Date(sec * 1000 + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
  async function liveIntl() {
    const syms = items.filter(Boolean);
    if (!syms.length) return;
    const j = await App.live({ t: "yahoo", s: syms.join(",") });
    for (const [s, r] of Object.entries(j.rows || {})) {
      if (r.p == null) continue;
      const old = data.rows[s];
      const chg = r.prev != null ? +(r.p - r.prev).toFixed(4) : null;
      data.rows[s] = [(old && old[0]) || nameOf(s) || r.name || s, r.p, chg, r.h, r.l, r.v || null, r.prev, r.time ? tpe(r.time) : null, r.cur];
    }
    data.updated = App.taipei() + "（即時）";
  }
  function paint(view) {
    const tb = view.querySelector(".watch-tbl tbody"), meta = view.querySelector(".watch-meta .muted");
    if (tb && items.length) tb.innerHTML = items.map(row).join("");
    if (meta) meta.textContent = "更新時間 " + (data.updated || "--");
  }
  let busy = false;
  async function refreshLive(view, manual) {
    if (busy) return;
    busy = true;
    const b = view.querySelector(".intl-update");
    if (b && manual) { b.disabled = true; b.textContent = "更新中…"; }
    try {
      await liveIntl();
      if (view.isConnected) paint(view);
    } catch (e) {
      if (manual) App.toast(e.message || String(e));
    } finally {
      busy = false;
      if (b && manual) { b.disabled = false; b.textContent = "立即更新行情"; }
    }
  }

  // ------------------------------------------------------------ 編輯畫面
  function sheet(html) {
    const el = document.createElement("div");
    el.className = "sheet";
    el.innerHTML = html;
    document.body.appendChild(el);
    document.body.classList.add("no-scroll");
    return el;
  }
  function closeSheet(el) {
    el.remove();
    if (!document.querySelector(".sheet")) document.body.classList.remove("no-scroll");
  }

  function openEditor(view) {
    let list = items.slice();
    const el = sheet(`
      <header class="sheet-head">
        <button type="button" class="sheet-btn" data-act="cancel">取消</button>
        <h2>國際股市</h2>
        <button type="button" class="sheet-btn strong" data-act="done">完成</button>
      </header>
      <div class="sheet-body">
        <ul class="edit-list" id="intlEdit"></ul>
        <div class="add-wrap"><button type="button" class="add-btn" data-act="add"><span aria-hidden="true">＋</span> 新增商品</button></div>
      </div>`);
    const ul = el.querySelector("#intlEdit");
    const draw = () => {
      ul.innerHTML = list.map((s) => `
        <li data-code="${esc(s)}">
          <button type="button" class="del" aria-label="刪除 ${esc(nameOf(s))}" data-del="${esc(s)}"><span></span></button>
          <span class="nm">${esc(nameOf(s))}<small>${esc(s)}</small></span>
          <span class="handle" aria-label="拖曳排序" title="拖曳排序"><i></i><i></i></span>
        </li>`).join("") || '<li class="empty">目前沒有項目</li>';
    };
    draw();
    if (window.Sortable) {
      Sortable.create(ul, { handle: ".handle", animation: 150, ghostClass: "drag-ghost",
        onEnd: () => { list = [...ul.querySelectorAll("li[data-code]")].map((li) => li.dataset.code); } });
    }
    el.addEventListener("click", async (e) => {
      const del = e.target.closest("[data-del]");
      if (del) { list = list.filter((c) => c !== del.dataset.del); draw(); return; }
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "cancel") closeSheet(el);
      if (act === "add") openSearch(list, (added) => { list = added; draw(); });
      if (act === "done") {
        closeSheet(el);
        if (list.join() !== items.join()) await save(view, list);
      }
    });
  }

  function openSearch(current, onDone) {
    const picked = current.slice();
    const el = sheet(`
      <header class="sheet-head">
        <button type="button" class="sheet-btn" data-act="cancel">取消</button>
        <h2>新增至「國際股市」</h2>
        <button type="button" class="sheet-btn strong" data-act="done">完成</button>
      </header>
      <div class="search-bar">
        <input type="search" id="intlSearch" placeholder="搜尋名稱或 Yahoo 代號…" autocomplete="off" autocapitalize="characters" enterkeyhint="search">
      </div>
      <div class="sheet-body"><ul class="result-list" id="intlResults"></ul></div>`);
    const input = el.querySelector("#intlSearch");
    const ul = el.querySelector("#intlResults");
    const item = (sym, name, kind) => {
      const on = picked.includes(sym);
      return `<li><span class="nm">${esc(name)}<small>${esc(sym)}${kind ? "・" + esc(kind) : ""}</small></span>
        <button type="button" class="pick ${on ? "on" : ""}" data-code="${esc(sym)}" aria-pressed="${on}">${on ? "✓ 已加入" : "＋ 加入"}</button></li>`;
    };
    function search() {
      const k = input.value.normalize("NFKC").trim();
      const K = k.toUpperCase();
      const hits = data.catalog.filter(([s, n, g]) => !k || s.toUpperCase().includes(K) || n.toUpperCase().includes(K) || g === k);
      let html = hits.map(([s, n, g]) => item(s, n, g)).join("");
      // 清單外的 Yahoo 代號（例如 ^HSCE、AAPL、2330.TW）
      if (k && /^[\^A-Z0-9.=\-]{1,20}$/.test(K) && !data.catalog.some((c) => c[0] === K)) html += item(K, `自訂代號 ${K}`, "Yahoo Finance");
      ul.innerHTML = html || '<li class="hint">找不到符合的項目，可直接輸入 Yahoo Finance 代號</li>';
    }
    input.addEventListener("input", search);
    search();
    el.addEventListener("click", (e) => {
      const b = e.target.closest(".pick");
      if (b) {
        const c = b.dataset.code, i = picked.indexOf(c);
        if (i >= 0) picked.splice(i, 1); else picked.push(c);
        search();
        return;
      }
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "cancel") closeSheet(el);
      if (act === "done") { closeSheet(el); onDone(picked); }
    });
  }

  // ------------------------------------------------------------ 儲存（加密後交由 GitHub Actions 寫入並抓取行情）
  async function save(view, list) {
    const ts = Date.now();
    items = list;
    writePending({ items: list, ts });
    renderTable(view, true);
    const blob = await App.encryptJSON({ v: 1, items: list, ts });
    const ok = await App.runUpdate({ inputs: { intl: JSON.stringify(blob) } });
    if (!ok) App.toast("清單已暫存於此裝置，稍後再按「編輯 → 完成」同步");
  }

  // ------------------------------------------------------------ 頁面
  async function render(view) {
    const [d, wl] = await Promise.all([App.loadData("intl").catch(() => ({ rows: {}, catalog: [] })), loadList()]);
    data = d;
    items = wl.items;
    App.setUpdated(d.updated);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "action-btn";
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg><span>編輯</span>';
    btn.addEventListener("click", () => {
      if (App.isUpdating()) { App.toast("資料更新中，請稍候再編輯"); return; }
      openEditor(view);
    });
    App.setAction(btn);
    renderTable(view, wl.syncing);
    const hasLive = await App.hasLive();
    view.addEventListener("click", (e) => {
      if (!e.target.closest(".intl-update")) return;
      if (hasLive) { refreshLive(view, true); return; }
      if (App.isUpdating()) { App.toast("已有更新在進行中，請稍候"); return; }
      App.runUpdate({ inputs: { intl: "refresh" } });
    });
    if (hasLive) {
      refreshLive(view);
      const timer = setInterval(() => {
        if (!view.isConnected) { clearInterval(timer); return; }
        if (!document.hidden) refreshLive(view);
      }, 60000);
    }
  }

  App.register({ id: "intl", title: "國際股市", icon: "🌐", render });
})();
