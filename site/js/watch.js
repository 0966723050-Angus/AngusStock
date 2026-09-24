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
    const stale = date && quotes.latest && date < quotes.latest ? `<span class="stale">${+date.slice(5, 7)}/${+date.slice(8)}</span>` : "";
    return `<tr${isIdx ? "" : ` class="link" data-code="${esc(code)}" tabindex="0" role="link" aria-label="${esc(name)} 個股資訊"`}>
      <td class="stk"><b>${esc(name)}</b><small>${isIdx ? "指數" : esc(code)}${stale}</small></td>
      <td class="num ${cls(chg)}"><b>${fmt(price, priceDigits(price))}</b></td>
      <td class="num ${cls(chg)}">${chg > 0 ? "▲" : chg < 0 ? "▼" : ""}${chg == null ? "--" : fmt(Math.abs(chg), priceDigits(price) === 0 && chg % 1 === 0 ? 0 : 2)}</td>
      <td class="num ${cls(chg)}">${sgn(pct)}</td>
      <td class="num">${isIdx ? "--" : fmt(vol, 0)}</td>
      <td class="num">${fmt(amp)}</td>
    </tr>`;
  }

  function renderTable(view, syncing) {
    view.innerHTML = `
      <div class="section-title"><h2>自選股行情</h2><span class="muted small">報價時間 ${esc(quotes.updated || "--")}${syncing ? "｜<b>清單同步中</b>" : ""}</span></div>
      <article class="card">
        <div class="tbl-wrap">
          <table class="tbl watch-tbl">
            <colgroup><col class="c-stk"><col class="c-px"><col class="c-chg"><col class="c-pct"><col class="c-vol"><col class="c-amp"></colgroup>
            <thead><tr><th>股票</th><th>成交價</th><th>漲跌</th><th>漲幅%</th><th>成交量</th><th>振幅%</th></tr></thead>
            <tbody>${items.length ? items.map(row).join("") : '<tr><td colspan="6" class="empty">尚無自選股，請按右上角「編輯」新增</td></tr>'}</tbody>
          </table>
        </div>
      </article>
      <p class="muted small note">點選股票可查看個股資訊。報價於開盤日 13:35、22:00 自動更新，或按「立即更新」取得最新報價；成交量單位：張。日期標示為非當日資料。</p>`;
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
        const mkt = x.code === "t00" || x.code === "o00" ? "指數" : x.mkt === "otc" ? "上櫃" : "上市";
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
    const go = (tr) => { if (tr) location.hash = "#/stock?code=" + encodeURIComponent(tr.dataset.code); };
    view.addEventListener("click", (e) => go(e.target.closest("tr.link")));
    view.addEventListener("keydown", (e) => { if (e.key === "Enter") go(e.target.closest("tr.link")); });
  }

  App.register({ id: "watch", title: "自選股行情", icon: "⭐", render });
})();
