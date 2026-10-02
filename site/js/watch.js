/* 自選股行情：報價表、編輯（刪除/排序）、新增商品（名稱或代碼搜尋） */
(function () {
  "use strict";

  const PENDING = "angus.watch.pending";
  const DEFAULT = ["t00", "2330", "3105", "8150", "6182", "2409", "3481", "2313", "6239", "2408", "2344", "2421", "2481"];
  const fmt = (v, d = 2) => (v == null || isNaN(v) ? "--" : Number(v).toLocaleString("zh-TW", { minimumFractionDigits: d, maximumFractionDigits: d }));
  const sgn = (v, d = 2) => (v == null ? "--" : (v > 0 ? "+" : "") + fmt(v, d));
  const cls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const priceDigits = (p) => (p == null ? 2 : p >= 1000 && p % 1 === 0 ? 0 : 2);

  // 漲跌停價：前一日收盤 ±10%，依升降單位取到有效價格（漲停向下取、跌停向上取）
  const tick = (p) => (p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5);
  function limits(prev) {
    const snap = (raw, dir) => {
      let p = raw;
      for (let i = 0; i < 2; i++) { // 跨越升降單位級距時以新價位的單位再取一次
        const t = tick(p);
        p = (dir < 0 ? Math.floor(raw / t + 1e-9) : Math.ceil(raw / t - 1e-9)) * t;
      }
      return Math.round(p * 100) / 100;
    };
    return { up: snap(prev * 1.1, -1), dn: snap(prev * 0.9, 1) };
  }

  let quotes = { rows: {} };
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
    try { server = await App.loadData("watchlist"); } catch (e) {
      if (e && e.name === "OperationError") throw e;
    }
    const pending = readPending();
    if (pending && (!server || (server.ts || 0) < pending.ts)) return { items: pending.items, syncing: true };
    if (pending) writePending(null); // 伺服器已是最新
    return { items: (server && server.items) || DEFAULT, syncing: false };
  }

  // ------------------------------------------------------------ 報價表
  function row(code) {
    const q = quotes.rows[code];
    if (!q) return `<tr><td class="stk"><b>${esc(code)}</b></td><td colspan="5" class="muted c">查無資料</td></tr>`;
    const [name, , price, chg, high, low, vol, prev, date] = q;
    const pct = prev ? (chg / prev) * 100 : null;
    const amp = prev && high != null && low != null ? ((high - low) / prev) * 100 : null;
    const isIdx = code === "t00" || code === "o00";
    const isFut = q[1] === "fut";
    let lim = "";
    if (!isIdx && !isFut && prev && price != null) {
      const L = limits(prev);
      lim = price >= L.up - 1e-9 ? " lim-up" : price <= L.dn + 1e-9 ? " lim-dn" : "";
    }
    const stale = date && quotes.latest && date < quotes.latest ? `<span class="stale">${+date.slice(5, 7)}/${+date.slice(8)}</span>` : "";
    // 期貨沒有個股資訊，點選直接開啟技術分析
    return `<tr${isIdx ? "" : ` class="link" data-code="${esc(code)}" data-page="${isFut ? "tech" : "stock"}" tabindex="0" role="link" aria-label="${esc(name)} ${isFut ? "技術分析" : "個股資訊"}"`}>
      <td class="stk"><b>${esc(name)}</b><small>${isIdx ? "指數" : isFut ? (code === "TXF1N" ? "期貨・夜盤" : "期貨・日盤") : esc(code)}${stale}</small></td>
      <td class="num ${cls(chg)}"><b class="${lim.trim()}" ${lim ? `title="${lim.includes("up") ? "漲停" : "跌停"}"` : ""}>${fmt(price, priceDigits(price))}</b></td>
      <td class="num ${cls(chg)}">${chg > 0 ? "▲" : chg < 0 ? "▼" : ""}${chg == null ? "--" : fmt(Math.abs(chg), priceDigits(price) === 0 && chg % 1 === 0 ? 0 : 2)}</td>
      <td class="num ${cls(chg)}">${sgn(pct)}</td>
      <td class="num">${isIdx ? "--" : fmt(vol, 0)}</td>
      <td class="num">${fmt(amp)}</td>
    </tr>`;
  }

  function renderTable(view, syncing) {
    view.innerHTML = `
      <div class="section-title"><h2>自選股行情</h2>
        <span class="watch-meta"><span class="muted small">報價時間 ${esc(quotes.updated || "--")}${syncing ? "｜<b>清單同步中</b>" : ""}</span>
        <button type="button" class="btn-ghost watch-update">立即更新報價</button></span></div>
      <article class="card">
        <div class="tbl-wrap watch-scroll">
          <table class="tbl watch-tbl">
            <colgroup><col class="c-stk"><col class="c-px"><col class="c-chg"><col class="c-pct"><col class="c-vol"><col class="c-amp"></colgroup>
            <thead><tr><th>股票</th><th>成交價</th><th>漲跌</th><th>漲幅%</th><th>成交量</th><th>振幅%</th></tr></thead>
            <tbody>${items.length ? items.map(row).join("") : '<tr><td colspan="6" class="empty">尚無自選股，請按右上角「編輯」新增</td></tr>'}</tbody>
          </table>
        </div>
      </article>
      <p class="muted small note">點選股票可查看個股資訊。交易時間開啟本頁會每 30 秒自動更新即時報價（證交所／期交所），也可按「立即更新報價」；成交量單位：張。日期標示為非當日資料。</p>`;
  }

  // ------------------------------------------------------------ 即時報價（經 Google Apps Script 中轉，不經 GitHub，約 1～3 秒）
  const numv = (x) => { const v = parseFloat(String(x ?? "").replace(/,/g, "")); return isFinite(v) ? v : null; };
  const isoOf = (d) => (d && String(d).length === 8 ? `${String(d).slice(0, 4)}-${String(d).slice(4, 6)}-${String(d).slice(6)}` : null);
  async function liveQuotes() {
    const ch = [], fut = [];
    for (const c of items) {
      if (c === "t00") ch.push("tse_t00.tw");
      else if (c === "o00") ch.push("otc_o00.tw");
      else if (c === "TXF1" || c === "TXF1N") fut.push(c);
      else { const q = quotes.rows[c]; if (q && (q[1] === "tse" || q[1] === "otc")) ch.push(`${q[1]}_${c}.tw`); }
    }
    const jobs = [];
    if (ch.length) jobs.push(App.twQuotes(ch).then((j) => {
      for (const m of j.rows || []) {
        const code = m.c, old = quotes.rows[code];
        if (!old) continue;
        let p = numv(m.z);
        if (p == null) p = numv(String(m.b || "").split("_")[0]); // 最近一筆未成交：以買價近似
        const y = numv(m.y);
        if (p == null || y == null) continue; // 開盤前尚無成交
        const isIdx = code === "t00" || code === "o00";
        quotes.rows[code] = [old[0], old[1], p, +(p - y).toFixed(2), numv(m.h) ?? p, numv(m.l) ?? p,
          isIdx ? old[6] : (numv(m.v) ?? old[6]), y, isoOf(m.d) || old[8]];
      }
    }));
    for (const f of fut) jobs.push(App.live({ t: "taifex", mt: f === "TXF1N" ? "1" : "0" }).then((j) => {
      const r = (j.rows || [])[0], old = quotes.rows[f]; // 依到期排序，第一筆為近月
      if (!r || !old) return;
      const p = numv(r.p), chg = numv(r.chg);
      if (p == null) return;
      quotes.rows[f] = [old[0], old[1], p, chg, numv(r.h) ?? p, numv(r.l) ?? p, numv(r.v) ?? old[6],
        chg == null ? old[7] : +(p - chg).toFixed(2), isoOf(r.d) || old[8]];
    }));
    const res = await Promise.allSettled(jobs);
    if (res.length && res.every((x) => x.status === "rejected")) throw res[0].reason;
    quotes.latest = Object.values(quotes.rows).reduce((m, r) => (r[8] && r[8] > m ? r[8] : m), "");
    quotes.updated = App.taipei() + "（即時）";
  }
  // 只更新表格內容與時間，保留捲動位置
  function paint(view) {
    const tb = view.querySelector(".watch-tbl tbody"), meta = view.querySelector(".watch-meta .muted");
    if (tb && items.length) tb.innerHTML = items.map(row).join("");
    if (meta) meta.textContent = "報價時間 " + (quotes.updated || "--");
  }
  let busy = false;
  async function refreshLive(view, manual) {
    if (busy) return;
    busy = true;
    const b = view.querySelector(".watch-update");
    if (b && manual) { b.disabled = true; b.textContent = "更新中…"; }
    try {
      await liveQuotes();
      if (view.isConnected) paint(view);
    } catch (e) {
      if (manual) App.toast(e.message || String(e));
    } finally {
      busy = false;
      if (b && manual) { b.disabled = false; b.textContent = "立即更新報價"; }
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

  function nameOf(code) {
    const q = quotes.rows[code];
    return q ? q[0] : code;
  }

  function openEditor(view) {
    let list = items.slice();
    const el = sheet(`
      <header class="sheet-head">
        <button type="button" class="sheet-btn" data-act="cancel">取消</button>
        <h2>自選股 <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg></h2>
        <button type="button" class="sheet-btn strong" data-act="done">完成</button>
      </header>
      <div class="sheet-body">
        <ul class="edit-list" id="editList"></ul>
        <div class="add-wrap"><button type="button" class="add-btn" data-act="add"><span aria-hidden="true">＋</span> 新增商品</button></div>
      </div>`);
    const ul = el.querySelector("#editList");

    function draw() {
      ul.innerHTML = list.map((c) => `
        <li data-code="${esc(c)}">
          <button type="button" class="del" aria-label="刪除 ${esc(nameOf(c))}" data-del="${esc(c)}"><span></span></button>
          <span class="nm">${esc(nameOf(c))}<small>${c === "t00" || c === "o00" ? "指數" : esc(c)}</small></span>
          <span class="handle" aria-label="拖曳排序" title="拖曳排序"><i></i><i></i></span>
        </li>`).join("") || '<li class="empty">目前沒有自選股</li>';
    }
    draw();

    if (window.Sortable) {
      Sortable.create(ul, {
        handle: ".handle", animation: 150, ghostClass: "drag-ghost",
        onEnd: () => { list = [...ul.querySelectorAll("li[data-code]")].map((li) => li.dataset.code); },
      });
    }

    el.addEventListener("click", async (e) => {
      const del = e.target.closest("[data-del]");
      if (del) {
        list = list.filter((c) => c !== del.dataset.del);
        draw();
        return;
      }
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
        <h2>新增至「自選股」</h2>
        <button type="button" class="sheet-btn strong" data-act="done">完成</button>
      </header>
      <div class="search-bar">
        <input type="search" id="stockSearch" placeholder="搜尋商品名稱或代碼…" autocomplete="off" enterkeyhint="search">
      </div>
      <div class="sheet-body"><ul class="result-list" id="results"></ul></div>`);
    const input = el.querySelector("#stockSearch");
    const ul = el.querySelector("#results");
    const all = Object.entries(quotes.rows).map(([code, q]) => ({ code, name: q[0], mkt: q[1] }));

    function search() {
      const k = input.value.normalize("NFKC").trim().toUpperCase();
      if (!k) {
        ul.innerHTML = '<li class="hint">輸入股票名稱或代碼搜尋，例如「台積電」或「2330」</li>';
        return;
      }
      const hits = all
        .filter((x) => x.code.startsWith(k) || x.name.toUpperCase().includes(k))
        .sort((a, b) => (b.code.startsWith(k) - a.code.startsWith(k)) || (b.name.startsWith(k) - a.name.startsWith(k)) || a.code.length - b.code.length || a.code.localeCompare(b.code))
        .slice(0, 50);
      ul.innerHTML = hits.map((x) => {
        const on = picked.includes(x.code);
        const mkt = x.code === "t00" || x.code === "o00" ? "指數" : x.mkt === "fut" ? "期貨" : x.mkt === "otc" ? "上櫃" : "上市";
        return `<li><span class="nm">${esc(x.name)}<small>${x.code.length === 3 ? "" : esc(x.code) + "・"}${mkt}</small></span>
          <button type="button" class="pick ${on ? "on" : ""}" data-code="${esc(x.code)}" aria-pressed="${on}">${on ? "✓ 已加入" : "＋ 加入"}</button></li>`;
      }).join("") || '<li class="hint">找不到符合的股票</li>';
    }
    input.addEventListener("input", search);
    search();
    setTimeout(() => input.focus(), 50);

    el.addEventListener("click", (e) => {
      const b = e.target.closest(".pick");
      if (b) {
        const c = b.dataset.code;
        const i = picked.indexOf(c);
        if (i >= 0) picked.splice(i, 1); else picked.push(c);
        search();
        return;
      }
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "cancel") closeSheet(el);
      if (act === "done") { closeSheet(el); onDone(picked); }
    });
  }

  // ------------------------------------------------------------ 儲存（加密後交由 GitHub Actions 寫入並抓取報價）
  async function save(view, list) {
    const ts = Date.now();
    items = list;
    writePending({ items: list, ts });
    renderTable(view, true);
    const blob = await App.encryptJSON({ v: 1, items: list, ts });
    const ok = await App.runUpdate({ inputs: { watchlist: JSON.stringify(blob) } });
    if (!ok) App.toast("清單已暫存於此裝置，稍後再按「編輯 → 完成」同步");
  }

  // ------------------------------------------------------------ 頁面
  async function render(view) {
    const [q, wl] = await Promise.all([App.loadData("quotes"), loadList()]);
    quotes = q;
    quotes.latest = Object.values(q.rows).reduce((m, r) => (r[8] && r[8] > m ? r[8] : m), "");
    items = wl.items;
    App.setUpdated(q.updated);

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
    const go = (tr) => { if (tr) location.hash = `#/${tr.dataset.page || "stock"}?code=` + encodeURIComponent(tr.dataset.code); };
    // 立即更新報價：有即時報價服務時直接查詢（約 1～3 秒）；未設定時改由 GitHub 更新（約 1～2 分鐘）
    const hasLive = await App.hasLive();
    view.addEventListener("click", async (e) => {
      if (!e.target.closest(".watch-update")) return;
      if (hasLive) { refreshLive(view, true); return; }
      if (App.isUpdating()) { App.toast("已有更新在進行中，請稍候"); return; }
      const blob = await App.encryptJSON({ v: 1, items, ts: Date.now() });
      App.runUpdate({ inputs: { watchlist: JSON.stringify(blob) } });
    });
    // 交易時間：開啟即更新，之後每 30 秒自動更新（離開本頁或畫面隱藏時暫停）
    if (hasLive) {
      if (App.marketOpen()) refreshLive(view);
      const timer = setInterval(() => {
        if (!view.isConnected) { clearInterval(timer); return; }
        if (!document.hidden && App.marketOpen()) refreshLive(view);
      }, 30000);
    }
    view.addEventListener("click", (e) => go(e.target.closest("tr.link")));
    view.addEventListener("keydown", (e) => { if (e.key === "Enter") go(e.target.closest("tr.link")); });
  }

  // 由其他頁面加入自選股（技術分析「加入自選」）：暫存於此裝置並觸發同步
  async function add(code) {
    const wl = await loadList();
    if (wl.items.includes(code)) return false;
    const list = [...wl.items, code];
    const ts = Date.now();
    writePending({ items: list, ts });
    const blob = await App.encryptJSON({ v: 1, items: list, ts });
    const ok = await App.runUpdate({ inputs: { watchlist: JSON.stringify(blob) } });
    if (!ok) App.toast("已暫存於此裝置，稍後到自選股「編輯 → 完成」同步");
    return true;
  }
  window.Watch = { list: loadList, add };

  App.register({ id: "watch", title: "自選股行情", icon: "⭐", render });
})();
