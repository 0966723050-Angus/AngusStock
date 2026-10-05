/* 財經新聞：重要財經新聞、自選股相關新聞（最近 3 天，每小時更新） */
(function () {
  "use strict";

  const TAB_KEY = "angus.news.tab";
  const PAGE = 30;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  let tab = "headline", stock = "all", shown = PAGE;

  // 發布時間：1 小時內顯示「N 分鐘前」，今天顯示時間，其餘顯示日期與時間（台北時間）
  function when(ts) {
    const diff = Date.now() / 1000 - ts;
    if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))} 分鐘前`;
    const d = new Date(ts * 1000 + 8 * 3600e3), now = new Date(Date.now() + 8 * 3600e3);
    const hm = d.toISOString().slice(11, 16);
    return d.toISOString().slice(0, 10) === now.toISOString().slice(0, 10) ? `今天 ${hm}` : `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hm}`;
  }
  const item = (x, names) => `
    <li><a href="${esc(x.u)}" target="_blank" rel="noopener noreferrer">
      <span class="nw-t">${esc(x.t)}</span>
      <span class="nw-m"><span>${esc(x.s || "")}</span><span>${when(x.ts)}</span>${(x.c || []).filter((c) => names[c]).slice(0, 3)
        .map((c) => `<span class="nw-tag">${esc(names[c])}</span>`).join("")}</span>
    </a></li>`;

  function body(d) {
    const names = d.names || {};
    let list;
    let chips = "";
    if (tab === "headline") {
      list = d.headline || [];
    } else {
      const codes = Object.keys(d.stocks || {});
      chips = `<div class="seg nw-stocks" role="group" aria-label="篩選股票">
        <button type="button" data-stock="all" aria-pressed="${stock === "all"}">全部</button>
        ${codes.map((c) => `<button type="button" data-stock="${esc(c)}" aria-pressed="${stock === c}">${esc(names[c] || c)}<small>${(d.stocks[c] || []).length}</small></button>`).join("")}
      </div>`;
      if (stock === "all") {
        const seen = new Set();
        list = [];
        for (const c of codes) for (const x of d.stocks[c]) if (!seen.has(x.u)) { seen.add(x.u); list.push({ ...x, c: [...new Set([c, ...(x.c || [])])] }); }
        list.sort((a, b) => b.ts - a.ts);
      } else {
        list = (d.stocks[stock] || []).map((x) => ({ ...x, c: [...new Set([stock, ...(x.c || [])])] }));
      }
    }
    const more = list.length > shown ? `<button type="button" class="btn-ghost nw-more">顯示更多（還有 ${list.length - shown} 則）</button>` : "";
    return `${chips}
      <ul class="nw-list">${list.slice(0, shown).map((x) => item(x, names)).join("") || '<li class="empty">最近 3 天沒有相關新聞</li>'}</ul>${more}`;
  }

  async function render(view) {
    try { tab = localStorage.getItem(TAB_KEY) || tab; } catch (e) { /* ignore */ }
    let d;
    try { d = await App.loadData("news"); } catch (e) { d = null; }
    App.setUpdated(d && d.updated);
    const draw = () => {
      view.innerHTML = `
        <div class="section-title"><h2>財經新聞</h2>
          <span class="watch-meta"><span class="muted small">更新時間 ${esc((d && d.updated) || "--")}</span>
          <button type="button" class="btn-ghost nw-update">立即更新新聞</button></span></div>
        <div class="seg nw-tabs" role="tablist">
          <button type="button" role="tab" data-tab="headline" aria-pressed="${tab === "headline"}">重要財經新聞${d ? `<small>${d.headline.length}</small>` : ""}</button>
          <button type="button" role="tab" data-tab="stocks" aria-pressed="${tab === "stocks"}">自選股新聞</button>
        </div>
        ${d ? body(d) : '<div class="card empty">尚無新聞資料（每小時自動更新，或按「立即更新新聞」）</div>'}
        <p class="muted small note">最近 3 天的台股新聞，每小時自動更新。重要財經新聞來源：鉅亨網台股、台灣總經；自選股新聞來源：Google 新聞、鉅亨網個股標記。點標題開啟原文。</p>`;
    };
    draw();
    view.addEventListener("click", (e) => {
      const t = e.target.closest("[data-tab]");
      if (t) { tab = t.dataset.tab; shown = PAGE; try { localStorage.setItem(TAB_KEY, tab); } catch (err) { /* ignore */ } draw(); return; }
      const s = e.target.closest("[data-stock]");
      if (s) { stock = s.dataset.stock; shown = PAGE; draw(); return; }
      if (e.target.closest(".nw-more")) { shown += PAGE; draw(); return; }
      if (e.target.closest(".nw-update")) {
        if (App.isUpdating()) { App.toast("已有更新在進行中，請稍候"); return; }
        App.runUpdate({ inputs: { news: "true" } });
      }
    });
  }

  App.register({ id: "news", title: "財經新聞", icon: "📰", render });
})();
