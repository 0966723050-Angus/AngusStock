/* 帳務查詢：股票帳戶、交易明細、股票庫存、交易損益（架構依 帳務查詢.xlsx）
   資料庫：repo 的 ledger/ledger.enc.json（以資料金鑰加密，經 GitHub API 即時讀寫）
   { v, principal, settings, trades: [{ id, code, bd, bp, bq, bf?, sd?, sp?, type?, xr?, xd? }],
     transfers: [{ id, date, kind: "in"|"out", amount, note }], ts }
   xr＝除權：每股配股（元，面額 10 元）→ 配股股數＝持有股數×xr÷10（例：2 元＝每張配 200 股），配股成本為 0
   xd＝除息：每股配息（元）→ 現金股利＝持有股數（不含本次配股）×xd，無條件捨去到元，計入該筆損益
   每筆交易＝一批買進（可含賣出）；部分賣出時自動拆成「已賣出」與「持有中」兩筆 */
(function () {
  "use strict";

  const PATH = "ledger/ledger.enc.json";
  const TAB_KEY = "angus.ledger.tab";
  const DEF_SETTINGS = {
    rates: { "庫存買賣": { buy: 0.001425, sell: 0.001425, tax: 0.003 }, "現股當沖": { buy: 0.001425, sell: 0.001425, tax: 0.0015 } },
    rebate: 0.5, minFee: 20,
  };
  const TABS = [["account", "股票帳戶"], ["trades", "交易明細"], ["stock", "股票庫存"], ["pnl", "交易損益"]];

  const fmt = (v, d = 0) => (v == null || !isFinite(v) ? "--" : Number(v).toLocaleString("zh-TW", { minimumFractionDigits: d, maximumFractionDigits: d }));
  const qty = (v) => (v == null ? "--" : Number(v).toLocaleString("zh-TW", { maximumFractionDigits: 3 }));
  const sgn = (v, d = 0) => (v == null || !isFinite(v) ? "--" : (v > 0 ? "+" : "") + fmt(v, d));
  const cls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const pdig = (p) => (p != null && p % 1 !== 0 ? 2 : 0);
  const todayISO = () => { const d = new Date(Date.now() + 8 * 3600e3); return d.toISOString().slice(0, 10); };
  const md = (iso) => (iso ? (iso.slice(0, 4) === todayISO().slice(0, 4) ? "" : iso.slice(2, 4) + "/") + `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}` : "--");
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  let db = null, sha = null, quotes = { rows: {} };
  let tab = "account", pnlKind = "unreal", period = "all", custom = { from: "", to: "" };
  let tfKind = "all", tfPeriod = "all", tfCustom = { from: "", to: "" };
  const openFolds = new Set();
  const fold = (id) => `data-fold="${id}"${openFolds.has(id) ? " open" : ""}`;

  // ------------------------------------------------------------ 計算
  const S = () => ({ ...DEF_SETTINGS, ...(db.settings || {}), rates: { ...DEF_SETTINGS.rates, ...((db.settings || {}).rates || {}) } });
  const nameOf = (c) => (quotes.rows[c] && quotes.rows[c][0]) || c;
  const priceOf = (c) => { const q = quotes.rows[c]; return q && q[2] != null ? q[2] : null; };
  const fee = (amt, rate) => (amt > 0 ? Math.max(S().minFee, Math.floor(amt * rate)) : 0);
  const typeOf = (t) => t.type || (t.sd && t.sd === t.bd ? "現股當沖" : "庫存買賣");

  // 衍生欄位（與 Excel 交易明細欄位對應）
  function calc(t) {
    const st = S(), r = st.rates[typeOf(t)] || st.rates["庫存買賣"];
    const amtB = t.bp * t.bq * 1000;
    const bf = t.bf != null ? t.bf : fee(amtB, r.buy);
    const div = t.xd ? Math.floor(t.bq * 1000 * t.xd + 1e-6) : 0; // 除息現金股利（元）
    const bonus = t.xr ? Math.floor(t.bq * 1000 * t.xr / 10 + 1e-6) : 0; // 除權配股（股）
    const sh = t.bq * 1000 + bonus;                                      // 含配股的總股數
    const o = { ...t, type: typeOf(t), amtB, buyFee: bf, payable: amtB + bf, buyRebate: Math.floor(bf * st.rebate), sold: !!(t.sd && t.sp != null),
      div, bonus, sh, tq: sh / 1000 };
    // 損益兩平價格：含配股的總股數賣出後（扣手續費、證交稅）加上除息剛好收回投入成本的價格
    o.beDen = sh * (1 - r.sell - r.tax);
    o.beNum = o.payable - div;
    o.be = o.beDen > 0 ? o.beNum / o.beDen : null;
    if (o.sold) {
      const amtS = t.sp * sh;
      o.sellFee = fee(amtS, r.sell);
      o.tax = Math.floor(amtS * r.tax);
      o.sellTotal = amtS - o.sellFee - o.tax;
      o.pnl = o.sellTotal - o.payable + div;
      o.sellRebate = Math.floor(o.sellFee * st.rebate);
    } else {
      // 持有中：以現價估算淨值（扣除賣出手續費與證交稅）
      const p = priceOf(t.code);
      o.price = p;
      if (p != null) {
        const amt = p * sh;
        o.mv = amt;
        o.net = amt - fee(amt, r.sell) - Math.floor(amt * r.tax);
        o.upnl = o.net - o.payable + div;
      }
    }
    return o;
  }
  const all = () => db.trades.map(calc);
  const calcTq = (t) => +calc(t).tq.toFixed(3);

  function inPeriod(d, per = period, cus = custom) {
    if (!d) return false;
    const t = todayISO();
    if (per === "all") return true;
    if (per === "year") return d.slice(0, 4) === t.slice(0, 4);
    if (per === "today") return d === t;
    if (per === "month") return d.slice(0, 7) === t.slice(0, 7);
    if (per === "lastmonth") {
      const [y, m] = t.split("-").map(Number);
      const lm = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
      return d.slice(0, 7) === lm;
    }
    if (per === "custom") return (!cus.from || d >= cus.from) && (!cus.to || d <= cus.to);
    return true;
  }

  // ------------------------------------------------------------ 讀寫資料庫
  async function load() {
    const r = await App.repoRead(PATH);
    db = r.data || { v: 1, principal: 0, settings: DEF_SETTINGS, trades: [], ts: 0 };
    db.trades = db.trades || [];
    db.transfers = db.transfers || [];
    sha = r.sha;
  }
  // mutate(db) 修改資料後存檔；若其他裝置已先更新，重新讀取後再套用一次
  async function commit(mutate, msg) {
    for (let i = 0; i < 2; i++) {
      const next = JSON.parse(JSON.stringify(db));
      mutate(next);
      next.ts = Date.now();
      try {
        App.bar("儲存中…");
        sha = await App.repoWrite(PATH, next, sha, msg);
        db = next;
        App.bar("已儲存", "ok");
        setTimeout(() => App.bar(""), 1500);
        return true;
      } catch (e) {
        if (e.conflict && i === 0) { await load(); continue; }
        App.bar(e.message || String(e), "err");
        setTimeout(() => App.bar(""), 6000);
        return false;
      }
    }
    return false;
  }

  // ------------------------------------------------------------ 股票輸入（代碼或股名 → 代碼）
  function resolveCode(input) {
    const k = String(input || "").normalize("NFKC").trim();
    if (!k) return null;
    const m = k.match(/^([0-9A-Z]{4,6})\b/i);
    if (m && quotes.rows[m[1].toUpperCase()]) return m[1].toUpperCase();
    const hit = Object.entries(quotes.rows).find(([c, q]) => q[0] === k) || Object.entries(quotes.rows).find(([c, q]) => q[1] !== "idx" && q[1] !== "fut" && String(q[0]).startsWith(k));
    return hit ? hit[0] : null;
  }
  const stockOptions = () => Object.entries(quotes.rows)
    .filter(([, q]) => q[1] === "tse" || q[1] === "otc")
    .map(([c, q]) => `<option value="${esc(c)} ${esc(q[0])}"></option>`).join("");

  // ------------------------------------------------------------ 表單（新增／編輯／賣出）
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

  function tradeForm(view, t) {
    const isNew = !t;
    t = t || { bd: todayISO() };
    const el = sheet(`
      <header class="sheet-head">
        <button type="button" class="sheet-btn" data-act="cancel">取消</button>
        <h2>${isNew ? "新增交易" : "編輯交易"}</h2>
        <button type="button" class="sheet-btn strong" data-act="save">儲存</button>
      </header>
      <div class="sheet-body">
        <form class="lg-form" autocomplete="off">
          <label class="full">股票<input name="stock" list="lgStocks" placeholder="輸入代碼或股名，例如 2330 或 台積電" value="${t.code ? esc(t.code + " " + nameOf(t.code)) : ""}" required></label>
          <datalist id="lgStocks">${stockOptions()}</datalist>
          <fieldset><legend>買進</legend>
            <label>買進日期<input type="date" name="bd" value="${esc(t.bd || "")}" required></label>
            <label>買價<input type="number" name="bp" step="0.01" min="0" inputmode="decimal" value="${t.bp ?? ""}" required></label>
            <label>張數<input type="number" name="bq" step="0.001" min="0.001" inputmode="decimal" value="${t.bq ?? ""}" required><small>零股可輸入到小數點後三位（0.001 張＝1 股）</small></label>
          </fieldset>
          <fieldset><legend>賣出（尚未賣出請留空日期與賣價）</legend>
            <label>賣出日期<input type="date" name="sd" value="${esc(t.sd || "")}"></label>
            <label>賣價<input type="number" name="sp" step="0.01" min="0" inputmode="decimal" value="${t.sp ?? ""}"></label>
            <label>賣出張數<input type="number" name="sq" step="0.001" min="0.001" inputmode="decimal" value="${t.sd ? calcTq(t) : ""}" placeholder="預設全部"><small>含配股；少於持有張數時，剩餘保留為持有中</small></label>
            <label>除權（元／股）<input type="number" name="xr" step="0.0001" min="0" inputmode="decimal" value="${t.xr ?? ""}" placeholder="0"><small>股票股利，例：2 元＝每張配 200 股（持有中也可填）</small></label>
            <label>除息（元／股）<input type="number" name="xd" step="0.0001" min="0" inputmode="decimal" value="${t.xd ?? ""}" placeholder="0"><small>現金股利，例：3.5 元＝每張 3,500 元（持有中也可填）</small></label>
          </fieldset>
          <label class="full">交易型態<select name="type">
            <option value="">自動（同日買賣為現股當沖）</option>
            <option value="庫存買賣"${t.type === "庫存買賣" ? " selected" : ""}>庫存買賣</option>
            <option value="現股當沖"${t.type === "現股當沖" ? " selected" : ""}>現股當沖</option>
          </select></label>
          <p class="lg-preview muted small" id="lgPreview"></p>
          ${isNew ? "" : '<button type="button" class="btn-danger" data-act="delete">刪除這筆交易</button>'}
        </form>
      </div>`);
    const f = el.querySelector("form");
    const read = () => {
      const v = Object.fromEntries(new FormData(f));
      const n = (x) => (x === "" || x == null ? null : Number(x));
      return { code: resolveCode(v.stock), bd: v.bd, bp: n(v.bp), bq: n(v.bq), sd: v.sd || null, sp: n(v.sp), sq: n(v.sq), type: v.type || null, xr: n(v.xr), xd: n(v.xd) };
    };
    const preview = () => {
      const v = read();
      const box = el.querySelector("#lgPreview");
      if (!v.code || !v.bp || !v.bq) { box.textContent = v.code ? "" : "請輸入有效的股票代碼或股名"; return; }
      const tot = v.bq * (1 + (v.xr || 0) / 10); // 含配股的持有張數
      const k = v.sd && v.sq ? Math.min(v.sq, tot) / tot : 1; // 部分賣出時預覽賣出部分（除息依張數分攤）
      const c = calc({ code: v.code, bd: v.bd, bp: v.bp, bq: v.bq * k, sd: v.sd, sp: v.sp, type: v.type, xr: v.xr, xd: v.xd });
      box.innerHTML = `<b>${esc(nameOf(v.code))}</b>｜手續費(買) ${fmt(c.buyFee)}・應付 ${fmt(c.payable)}・回沖 ${fmt(c.buyRebate)}` +
        (c.bonus ? `<br>除權配股 ${fmt(c.bonus)} 股，合計 ${qty(c.tq)} 張` : "") +
        (c.div ? `<br>除息現金股利 ${fmt(c.div)} 元` : "") +
        (c.sold ? `<br>證交稅 ${fmt(c.tax)}・手續費(賣) ${fmt(c.sellFee)}・賣出總額 ${fmt(c.sellTotal)}${c.div ? `・除息 ${fmt(c.div)}` : ""}・<span class="${cls(c.pnl)}">損益 ${sgn(c.pnl)}</span>（${c.type}）` : "") +
        `<br>損益兩平價格 ${fmt(c.be, 2)}`;
    };
    f.addEventListener("input", preview);
    preview();
    el.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "cancel") closeSheet(el);
      if (act === "delete") {
        if (!confirm("確定要刪除這筆交易？")) return;
        closeSheet(el);
        if (await commit((d) => { d.trades = d.trades.filter((x) => x.id !== t.id); }, "帳務：刪除交易")) draw(view);
      }
      if (act === "save") {
        const v = read();
        if (!v.code) { App.toast("請輸入有效的股票代碼或股名"); return; }
        if (!v.bd || !(v.bp > 0) || !(v.bq > 0)) { App.toast("請填寫買進日期、買價與張數"); return; }
        if ((v.sd || v.sp != null) && !(v.sd && v.sp > 0)) { App.toast("賣出需同時填寫日期與賣價"); return; }
        if (v.sd && v.sd < v.bd) { App.toast("賣出日期不可早於買進日期"); return; }
        const tot = v.bq * (1 + (v.xr || 0) / 10); // 含配股的持有張數
        const sq = v.sd ? Math.min(v.sq || tot, tot) : null;
        closeSheet(el);
        const ok = await commit((d) => {
          const base = { code: v.code, bd: v.bd, bp: v.bp, type: v.type || undefined };
          if (v.xr) base.xr = v.xr; // 每股配股、配息為比率，拆批時兩筆相同
          if (v.xd) base.xd = v.xd;
          const list = d.trades.filter((x) => x.id !== (t && t.id));
          if (v.sd && sq < tot - 1e-9) { // 部分賣出：拆成已賣出與持有中兩筆，買進手續費、除息依張數分攤
            const k = sq / tot;
            const bfAll = fee(v.bp * v.bq * 1000, (S().rates[v.type || "庫存買賣"] || S().rates["庫存買賣"]).buy);
            const soldBf = Math.round(bfAll * k), soldBq = +(v.bq * k).toFixed(6);
            list.push({ id: (t && t.id) || uid(), ...base, bq: soldBq, bf: soldBf, sd: v.sd, sp: v.sp });
            list.push({ id: uid(), ...base, bq: +(v.bq - soldBq).toFixed(6), bf: bfAll - soldBf });
          } else {
            list.push({ id: (t && t.id) || uid(), ...base, bq: v.bq, ...(t && t.bf != null && t.bq === v.bq && t.bp === v.bp ? { bf: t.bf } : {}),
              ...(v.sd ? { sd: v.sd, sp: v.sp } : {}) });
          }
          d.trades = list;
        }, isNew ? "帳務：新增交易" : "帳務：修改交易");
        if (ok) draw(view);
      }
    });
  }

  // 由庫存賣出：依先進先出分配到各筆持有中的交易
  function sellForm(view, code) {
    const lots = all().filter((t) => !t.sold && t.code === code).sort((a, b) => (a.bd < b.bd ? -1 : 1));
    const total = +lots.reduce((s, t) => s + t.tq, 0).toFixed(3); // 含配股
    const el = sheet(`
      <header class="sheet-head">
        <button type="button" class="sheet-btn" data-act="cancel">取消</button>
        <h2>賣出 ${esc(nameOf(code))}</h2>
        <button type="button" class="sheet-btn strong" data-act="save">儲存</button>
      </header>
      <div class="sheet-body">
        <form class="lg-form" autocomplete="off">
          <p class="muted small full">庫存 ${qty(total)} 張；賣出時依買進日期先進先出。</p>
          <label>賣出日期<input type="date" name="sd" value="${todayISO()}" required></label>
          <label>賣價<input type="number" name="sp" step="0.01" min="0" inputmode="decimal" value="${priceOf(code) ?? ""}" required></label>
          <label>賣出張數<input type="number" name="sq" step="0.001" min="0.001" max="${total}" inputmode="decimal" value="${total}" required></label>
        </form>
      </div>`);
    el.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "cancel") closeSheet(el);
      if (act !== "save") return;
      const v = Object.fromEntries(new FormData(el.querySelector("form")));
      const sp = Number(v.sp), sq = Math.min(Number(v.sq), total);
      if (!v.sd || !(sp > 0) || !(sq > 0)) { App.toast("請填寫賣出日期、賣價與張數"); return; }
      closeSheet(el);
      const ok = await commit((d) => {
        let left = sq;
        for (const lot of lots) {
          if (left <= 1e-9) break;
          const t = d.trades.find((x) => x.id === lot.id);
          if (!t || v.sd < t.bd) continue;
          if (lot.tq <= left + 1e-9) {
            left -= lot.tq;
            Object.assign(t, { sd: v.sd, sp, bf: lot.buyFee });
          } else { // 拆批（依含配股張數比例；每股配股、配息兩筆相同）
            const k = left / lot.tq, part = +(t.bq * k).toFixed(6), soldBf = Math.round(lot.buyFee * k);
            const rest = { ...t, id: uid(), bq: +(t.bq - part).toFixed(6), bf: lot.buyFee - soldBf };
            d.trades.push(rest);
            Object.assign(t, { bq: part, bf: soldBf, sd: v.sd, sp });

            left = 0;
          }
        }
      }, "帳務：賣出");
      if (ok) draw(view);
    });
  }

  // ------------------------------------------------------------ 各分頁
  function holdings() {
    const g = {};
    for (const t of all().filter((x) => !x.sold)) {
      const h = g[t.code] || (g[t.code] = { code: t.code, bq: 0, amtB: 0, payable: 0, mv: 0, net: 0, priced: true, rebate: 0 });
      h.bq += t.tq; h.amtB += t.amtB; h.payable += t.payable; h.rebate += t.buyRebate;
      if (t.mv == null) h.priced = false; else { h.mv += t.mv; h.net += t.net + t.div; }
    }
    return Object.values(g).map((h) => ({ ...h, bq: +h.bq.toFixed(3), price: priceOf(h.code), avg: h.amtB / (h.bq * 1000), upnl: h.priced ? h.net - h.payable : null }));
  }

  function accountTab() {
    const T = all();
    const realized = T.filter((t) => t.sold).reduce((s, t) => s + t.pnl, 0);
    const rebates = T.reduce((s, t) => s + t.buyRebate + (t.sold ? t.sellRebate : 0), 0);
    const hold = T.filter((t) => !t.sold);
    const cost = hold.reduce((s, t) => s + t.payable, 0);
    const holdDiv = hold.reduce((s, t) => s + t.div, 0);
    const mv = holdings().reduce((s, h) => s + h.mv, 0);
    const p = db.principal || 0;
    const tin = db.transfers.filter((x) => x.kind === "in").reduce((s, x) => s + x.amount, 0);
    const tout = db.transfers.filter((x) => x.kind === "out").reduce((s, x) => s + x.amount, 0);
    const base = p + tin - tout; // 投入資金＝本金＋匯入－匯出
    const balance = base + realized + rebates + holdDiv - cost;
    const totalV = balance + mv;
    const gain = totalV - base;
    const st = S();
    const rateRow = (k) => `<tr><td>${k}</td>
      <td><input type="number" step="0.000001" data-rate="${k}.buy" value="${st.rates[k].buy}"></td>
      <td><input type="number" step="0.000001" data-rate="${k}.sell" value="${st.rates[k].sell}"></td>
      <td><input type="number" step="0.0001" data-rate="${k}.tax" value="${st.rates[k].tax}"></td></tr>`;
    return `
      <article class="card lg-account">
        <h3>Angus股票帳戶</h3>
        <dl>
          <dt>本金</dt><dd><input type="number" id="lgPrincipal" step="1" inputmode="numeric" value="${p || ""}" placeholder="輸入本金"> 元</dd>
          <dt>轉帳淨額</dt><dd><b class="${cls(tin - tout)}">${sgn(tin - tout)}</b> 元</dd>
          <dt>帳戶餘額</dt><dd><b>${fmt(balance)}</b> 元</dd>
          <dt>股票市值</dt><dd><b>${fmt(mv)}</b> 元</dd>
          <dt>帳戶總額</dt><dd><b>${fmt(totalV)}</b> 元</dd>
          <dt>交易盈虧</dt><dd><b class="${cls(gain)}">${sgn(gain)}</b> 元　<b class="${cls(gain)}">${base ? sgn(gain / base * 100, 2) : "--"}</b> %</dd>
        </dl>
        <p class="muted small">帳戶餘額＝本金＋轉帳淨額＋已實現損益＋手續費回沖＋持股除息－持股投入成本；帳戶總額＝帳戶餘額＋股票市值；交易盈虧以（本金＋轉帳淨額）為基準。</p>
      </article>
      ${transferSection()}
      <details class="card lg-fold" ${fold("rates")}>
        <summary>費率設定</summary>
        <div class="tbl-wrap"><table class="tbl lg-rates">
          <thead><tr><th>交易型態</th><th>買進手續費</th><th>賣出手續費</th><th>證交稅</th></tr></thead>
          <tbody>${rateRow("庫存買賣")}${rateRow("現股當沖")}</tbody>
        </table></div>
        <div class="lg-rate-more">
          <label>券商手續費折讓 <input type="number" step="0.01" min="0" max="1" data-set="rebate" value="${st.rebate}"></label>
          <label>最低手續費 <input type="number" step="1" min="0" data-set="minFee" value="${st.minFee}"> 元</label>
          <button type="button" class="btn-primary" data-act="saveRates">儲存費率</button>
        </div>
        <p class="muted small">手續費＝成交金額×費率（無條件捨去，未達最低手續費以最低計）；證交稅＝賣出金額×稅率；手續費回沖＝手續費×折讓。</p>
      </details>`;
  }

  // 轉帳匯入／匯出：紀錄與查詢
  function transferSection() {
    const PER = [["all", "全部"], ["month", "本月"], ["lastmonth", "上月"], ["year", "今年"], ["custom", "自訂"]];
    const list = db.transfers
      .filter((x) => (tfKind === "all" || x.kind === tfKind) && inPeriod(x.date, tfPeriod, tfCustom))
      .sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));
    const sIn = list.filter((x) => x.kind === "in").reduce((s, x) => s + x.amount, 0);
    const sOut = list.filter((x) => x.kind === "out").reduce((s, x) => s + x.amount, 0);
    const allIn = db.transfers.filter((x) => x.kind === "in").reduce((s, x) => s + x.amount, 0);
    const allOut = db.transfers.filter((x) => x.kind === "out").reduce((s, x) => s + x.amount, 0);
    return `
      <details class="card lg-fold" ${fold("transfers")}>
      <summary>轉帳紀錄<span class="lg-fold-meta">${db.transfers.length} 筆・淨額 <b class="${cls(allIn - allOut)}">${sgn(allIn - allOut)}</b></span></summary>
      <div class="lg-fold-body">
      <div class="lg-tf-bar"><button type="button" class="btn-primary lg-tf-add" data-act="addTransfer">＋ 新增轉帳</button></div>
      <div class="seg lg-tf-kind" role="group" aria-label="轉帳類型">${[["all", "全部"], ["in", "匯入"], ["out", "匯出"]]
        .map(([k, t]) => `<button type="button" data-tfkind="${k}" aria-pressed="${k === tfKind}">${t}</button>`).join("")}</div>
      <div class="seg lg-tf-period" role="group" aria-label="查詢區間">${PER.map(([k, t]) => `<button type="button" data-tfperiod="${k}" aria-pressed="${k === tfPeriod}">${t}</button>`).join("")}</div>
      ${tfPeriod === "custom" ? `<div class="lg-custom"><input type="date" id="tfFrom" value="${esc(tfCustom.from)}"> ～ <input type="date" id="tfTo" value="${esc(tfCustom.to)}"></div>` : ""}
      <div class="tbl-wrap"><table class="tbl lg-tbl lg-tf">
        <thead><tr><th>日期</th><th>類型</th><th>金額</th><th>備註</th></tr></thead>
        <tbody>${list.map((x) => `<tr class="link" data-tf="${esc(x.id)}" tabindex="0">
          <td>${esc(x.date)}</td><td><span class="lg-tf-k ${x.kind}">${x.kind === "in" ? "匯入" : "匯出"}</span></td>
          <td class="num ${x.kind === "in" ? "up" : "down"}">${x.kind === "in" ? "+" : "−"}${fmt(x.amount)}</td><td class="lg-note">${esc(x.note || "")}</td></tr>`).join("") ||
          '<tr><td colspan="4" class="empty">此區間沒有轉帳紀錄</td></tr>'}</tbody>
      </table></div>
      <div class="lg-sum"><span>匯入：<b class="up">${fmt(sIn)}</b></span><span>匯出：<b class="down">${fmt(sOut)}</b></span><span>淨額：<b class="${cls(sIn - sOut)}">${sgn(sIn - sOut)}</b></span><span class="muted">共 ${list.length} 筆</span></div>
      </div>
      </details>`;
  }

  function transferForm(view, x) {
    const isNew = !x;
    x = x || { date: todayISO(), kind: "in" };
    const el = sheet(`
      <header class="sheet-head">
        <button type="button" class="sheet-btn" data-act="cancel">取消</button>
        <h2>${isNew ? "新增轉帳" : "編輯轉帳"}</h2>
        <button type="button" class="sheet-btn strong" data-act="save">儲存</button>
      </header>
      <div class="sheet-body">
        <form class="lg-form" autocomplete="off">
          <div class="seg lg-tf-pick full" role="radiogroup">
            <label><input type="radio" name="kind" value="in"${x.kind === "in" ? " checked" : ""}> 匯入（存入帳戶）</label>
            <label><input type="radio" name="kind" value="out"${x.kind === "out" ? " checked" : ""}> 匯出（從帳戶提領）</label>
          </div>
          <label>日期<input type="date" name="date" value="${esc(x.date)}" required></label>
          <label>金額（元）<input type="number" name="amount" step="1" min="1" inputmode="numeric" value="${x.amount ?? ""}" required></label>
          <label class="full">備註<input name="note" maxlength="60" value="${esc(x.note || "")}" placeholder="例如：薪資轉入、提領"></label>
          ${isNew ? "" : '<button type="button" class="btn-danger" data-act="delete">刪除這筆轉帳</button>'}
        </form>
      </div>`);
    el.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "cancel") closeSheet(el);
      if (act === "delete") {
        if (!confirm("確定要刪除這筆轉帳？")) return;
        closeSheet(el);
        if (await commit((d) => { d.transfers = (d.transfers || []).filter((y) => y.id !== x.id); }, "帳務：刪除轉帳")) draw(view);
      }
      if (act === "save") {
        const v = Object.fromEntries(new FormData(el.querySelector("form")));
        const amount = Math.round(Number(v.amount));
        if (!v.date || !(amount > 0)) { App.toast("請填寫日期與金額"); return; }
        closeSheet(el);
        const rec = { id: x.id || uid(), date: v.date, kind: v.kind === "out" ? "out" : "in", amount, note: (v.note || "").trim() };
        if (await commit((d) => { d.transfers = (d.transfers || []).filter((y) => y.id !== rec.id).concat(rec); }, isNew ? "帳務：新增轉帳" : "帳務：修改轉帳")) draw(view);
      }
    });
  }

  function tradesTab() {
    const T = all().sort((a, b) => ((b.sd || b.bd) > (a.sd || a.bd) ? 1 : (b.sd || b.bd) < (a.sd || a.bd) ? -1 : 0));
    if (!T.length) return '<article class="card empty">尚無交易，按右上角「＋ 新增交易」開始記錄</article>';
    const rows = T.map((t) => `
      <tr data-id="${esc(t.id)}" class="link" tabindex="0">
        <td class="stk"><b>${esc(nameOf(t.code))}</b><small>${esc(t.code)}</small></td>
        <td>${esc(t.bd)}</td><td class="num">${fmt(t.bp, 2)}</td><td class="num">${qty(t.bq)}</td>
        <td class="num">${fmt(t.buyFee)}</td><td class="num">${fmt(t.payable)}</td><td class="num">${fmt(t.buyRebate)}</td>
        <td class="sep">${t.sold ? esc(t.sd) : "--"}</td><td class="num">${t.sold ? fmt(t.sp, 2) : "--"}</td><td class="num">${t.sold ? qty(t.tq) : "--"}</td>
        <td class="num">${t.sold ? fmt(t.tax) : "--"}</td><td class="num">${t.sold ? fmt(t.sellFee) : "--"}</td><td class="num">${t.sold ? fmt(t.sellTotal) : "--"}</td>
        <td class="num">${t.xr ? `${fmt(t.xr, 2)} 元<small>（+${fmt(t.bonus)} 股）</small>` : "--"}</td><td class="num">${t.xd ? `${fmt(t.xd, 2)} 元<small>（${fmt(t.div)} 元）</small>` : "--"}</td>
        <td class="num ${cls(t.pnl)}">${t.sold ? sgn(t.pnl) : "--"}</td><td class="num">${t.sold ? fmt(t.sellRebate) : "--"}</td>
        <td>${esc(t.type)}</td><td><span class="lg-st ${t.sold ? "done" : "hold"}">${t.sold ? "已賣出" : "持有中"}</span></td>
      </tr>`).join("");
    const cards = T.map((t) => `
      <li data-id="${esc(t.id)}" class="link" tabindex="0">
        <div class="lg-c-head"><b>${esc(nameOf(t.code))}</b><small>${esc(t.code)}・${esc(t.type)}</small><span class="lg-st ${t.sold ? "done" : "hold"}">${t.sold ? "已賣出" : "持有中"}</span></div>
        <div class="lg-c-row"><span class="muted">買</span><span>${md(t.bd)}　${fmt(t.bp, 2)} × ${qty(t.bq)} 張</span><span>應付 ${fmt(t.payable)}</span></div>
        <div class="lg-c-sub muted small">手續費 ${fmt(t.buyFee)}・回沖 ${fmt(t.buyRebate)}</div>
        ${t.xr || t.xd ? `<div class="lg-c-sub muted small">${t.xr ? `除權 ${fmt(t.xr, 2)} 元（配 ${fmt(t.bonus)} 股）` : ""}${t.xr && t.xd ? "・" : ""}${t.xd ? `除息 ${fmt(t.xd, 2)} 元（${fmt(t.div)} 元）` : ""}</div>` : ""}
        ${t.sold ? `<div class="lg-c-row"><span class="muted">賣</span><span>${md(t.sd)}　${fmt(t.sp, 2)} × ${qty(t.tq)} 張</span><span>收 ${fmt(t.sellTotal)}</span></div>
        <div class="lg-c-sub muted small">證交稅 ${fmt(t.tax)}・手續費 ${fmt(t.sellFee)}・回沖 ${fmt(t.sellRebate)}<b class="${cls(t.pnl)}">損益 ${sgn(t.pnl)}</b></div>` : ""}
      </li>`).join("");
    return `
      <p class="muted small note">點選交易可修改或刪除；部分賣出會自動拆成已賣出與持有中兩筆。</p>
      <ul class="lg-cards">${cards}</ul>
      <article class="card lg-wide"><div class="tbl-wrap"><table class="tbl lg-tbl">
        <thead><tr><th class="stk">股票</th><th>買進日期</th><th>買價</th><th>張數</th><th>手續費(買)</th><th>應付金額</th><th>手續費回沖(買)</th>
          <th class="sep">賣出日期</th><th>賣價</th><th>張數</th><th>證交稅</th><th>手續費(賣)</th><th>賣出總額</th><th>除權</th><th>除息</th><th>交易損益</th><th>手續費回沖(賣)</th><th>交易型態</th><th>狀態</th></tr></thead>
        <tbody>${rows}</tbody></table></div></article>`;
  }

  function stockTab() {
    const H = holdings().sort((a, b) => b.mv - a.mv);
    if (!H.length) return '<article class="card empty">目前沒有庫存</article>';
    const total = H.reduce((s, h) => s + h.mv, 0);
    return `
      <article class="card"><div class="tbl-wrap"><table class="tbl lg-tbl">
        <thead><tr><th class="stk">股票</th><th>現價</th><th>張數</th><th>市值</th><th></th></tr></thead>
        <tbody>${H.map((h) => `<tr>
          <td class="stk"><b>${esc(nameOf(h.code))}</b><small>${esc(h.code)}</small></td>
          <td class="num">${fmt(h.price, pdig(h.price))}</td><td class="num">${qty(h.bq)}</td><td class="num"><b>${fmt(h.mv)}</b></td>
          <td><button type="button" class="btn-ghost lg-sell" data-sell="${esc(h.code)}">賣出</button></td></tr>`).join("")}</tbody>
        <tfoot><tr><td colspan="3" class="num">總市值：</td><td class="num"><b>${fmt(total)}</b></td><td></td></tr></tfoot>
      </table></div></article>
      <p class="muted small note">現價取自網站最新報價（報價時間 ${esc(quotes.updated || "--")}）。</p>`;
  }

  function pnlTab() {
    const T = all();
    const PER = [["all", "全部"], ["today", "本日"], ["lastmonth", "上月"], ["month", "本月"], ["custom", "自訂"]];
    const rows = [];
    let rebate = 0;
    if (pnlKind !== "real") { // 未實現：依買進日期篩選
      const g = {};
      for (const t of T.filter((x) => !x.sold && inPeriod(x.bd))) {
        const h = g[t.code] || (g[t.code] = { kind: "未實現", code: t.code, bq: 0, amtB: 0, cost: 0, net: 0, mv: 0, ok: true, beN: 0, beD: 0 });
        h.bq += t.tq; h.amtB += t.amtB; h.cost += t.payable; rebate += t.buyRebate; h.beN += t.beNum; h.beD += t.beDen;
        if (t.net == null) h.ok = false; else { h.net += t.net + t.div; h.mv += t.mv; }
      }
      Object.values(g).forEach((h) => rows.push({ ...h, price: priceOf(h.code), avg: h.amtB / (h.bq * 1000), pnl: h.ok ? h.net - h.cost : null, be: h.beD > 0 ? h.beN / h.beD : null }));
    }
    if (pnlKind !== "unreal") { // 已實現：依賣出日期篩選
      const g = {};
      for (const t of T.filter((x) => x.sold && inPeriod(x.sd))) {
        const h = g[t.code] || (g[t.code] = { kind: "已實現", code: t.code, bq: 0, amtB: 0, amtS: 0, cost: 0, net: 0, mv: 0, ok: true, beN: 0, beD: 0 });
        h.bq += t.tq; h.amtB += t.amtB; h.amtS += t.sp * t.sh; h.cost += t.payable; h.net += t.sellTotal + t.div; rebate += t.buyRebate + t.sellRebate;
        h.beN += t.beNum; h.beD += t.beDen;
      }
      Object.values(g).forEach((h) => rows.push({ ...h, price: h.amtS / (h.bq * 1000), avg: h.amtB / (h.bq * 1000), pnl: h.net - h.cost, be: h.beD > 0 ? h.beN / h.beD : null }));
    }
    rows.sort((a, b) => (b.pnl ?? -Infinity) - (a.pnl ?? -Infinity));
    const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
    const totalPnl = sum("pnl"), totalCost = sum("cost");
    return `
      <div class="seg lg-kind" role="group" aria-label="損益類別">${[["unreal", "未實現損益"], ["real", "已實現損益"], ["all", "合併損益"]]
        .map(([k, t]) => `<button type="button" data-kind="${k}" aria-pressed="${k === pnlKind}">${t}</button>`).join("")}</div>
      <div class="seg lg-period" role="group" aria-label="查詢區間">${PER.map(([k, t]) => `<button type="button" data-period="${k}" aria-pressed="${k === period}">${t}</button>`).join("")}</div>
      ${period === "custom" ? `<div class="lg-custom"><input type="date" id="lgFrom" value="${esc(custom.from)}"> ～ <input type="date" id="lgTo" value="${esc(custom.to)}"></div>` : ""}
      <article class="card lg-sum-top"><div class="lg-sum">
        <span>總市值：<b>${fmt(sum("mv"))}</b></span>
        <span>投資損益：<b class="${cls(totalPnl)}">${sgn(totalPnl)}</b>${totalCost ? `（<span class="${cls(totalPnl)}">${sgn(totalPnl / totalCost * 100, 2)}%</span>）` : ""}</span>
        <span>手續費回沖：<b>${fmt(rebate)}</b></span>
      </div></article>
      <ul class="lg-cards lg-pnl-cards">${rows.map((r) => `
        <li>
          <div class="lg-c-head"><b>${esc(nameOf(r.code))}</b><small>${esc(r.code)}${pnlKind === "all" ? "・" + r.kind : ""}</small>
            <span class="lg-pnl-v ${cls(r.pnl)}"><b>${sgn(r.pnl)}</b><small>${r.pnl == null ? "--" : sgn(r.pnl / r.cost * 100, 2) + "%"}</small></span></div>
          <div class="lg-kv"><span>市價<b>${fmt(r.price, 2)}</b></span><span>成交均價<b>${fmt(r.avg, 2)}</b></span><span>張數<b>${qty(+r.bq.toFixed(3))}</b></span></div>
          <div class="lg-kv"><span>投入成本<b>${fmt(r.cost)}</b></span><span>淨值<b>${fmt(r.ok === false ? null : r.net)}</b></span><span>損益兩平<b>${fmt(r.be, 2)}</b></span></div>
        </li>`).join("") || '<li class="empty">此區間沒有資料</li>'}</ul>
      <article class="card lg-wide"><div class="tbl-wrap"><table class="tbl lg-tbl lg-pnl">
        <thead><tr><th class="stk">股票</th><th>市價</th><th>成交<br>均價</th><th>張數</th><th>投入<br>成本</th><th>投資<br>損益(元)</th><th>淨值</th><th>報酬率<br>(%)</th><th>損益兩平<br>價格</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td class="stk"><b>${esc(nameOf(r.code))}</b><small>${esc(r.code)}${pnlKind === "all" ? "・" + r.kind : ""}</small></td>
          <td class="num">${fmt(r.price, 2)}</td><td class="num">${fmt(r.avg, 2)}</td><td class="num">${qty(+r.bq.toFixed(3))}</td>
          <td class="num">${fmt(r.cost)}</td><td class="num ${cls(r.pnl)}"><b>${sgn(r.pnl)}</b></td><td class="num">${fmt(r.ok === false ? null : r.net)}</td>
          <td class="num ${cls(r.pnl)}">${r.pnl == null ? "--" : sgn(r.pnl / r.cost * 100, 2)}</td><td class="num">${fmt(r.be, 2)}</td></tr>`).join("") || '<tr><td colspan="9" class="empty">此區間沒有資料</td></tr>'}</tbody>
      </table></div></article>
      <p class="muted small note">${pnlKind === "unreal" ? "未實現損益依買進日期篩選，以最新報價估算（張數含除權配股；淨值已扣除預估賣出手續費與證交稅，並加計除息）；損益兩平價格＝賣出後剛好收回成本的價格" : pnlKind === "real" ? "已實現損益依賣出日期篩選；市價欄為賣出均價、淨值為賣出總額" : "合併：未實現依買進日期、已實現依賣出日期篩選"}。</p>`;
  }

  // ------------------------------------------------------------ 頁面
  function draw(view) {
    const body = tab === "account" ? accountTab() : tab === "trades" ? tradesTab() : tab === "stock" ? stockTab() : pnlTab();
    view.innerHTML = `
      <div class="seg lg-tabs" role="tablist">${TABS.map(([k, t]) => `<button type="button" role="tab" data-tab="${k}" aria-pressed="${k === tab}">${t}</button>`).join("")}</div>
      <div class="lg-body">${body}</div>`;
  }

  async function render(view) {
    try { tab = localStorage.getItem(TAB_KEY) || tab; } catch (e) { /* ignore */ }
    const [q] = await Promise.all([App.loadData("quotes").catch(() => ({ rows: {} })), load()]);
    quotes = q;
    const add = document.createElement("button");
    add.type = "button";
    add.className = "action-btn";
    add.innerHTML = "<span>＋ 新增交易</span>";
    add.addEventListener("click", () => tradeForm(view));
    App.setAction(add);
    draw(view);

    view.onclick = async (e) => {
      const tb = e.target.closest("[data-tab]");
      if (tb) { tab = tb.dataset.tab; try { localStorage.setItem(TAB_KEY, tab); } catch (err) { /* ignore */ } draw(view); return; }
      const k = e.target.closest("[data-kind]");
      if (k) { pnlKind = k.dataset.kind; draw(view); return; }
      const p = e.target.closest("[data-period]");
      if (p) { period = p.dataset.period; draw(view); return; }
      const tk = e.target.closest("[data-tfkind]");
      if (tk) { tfKind = tk.dataset.tfkind; draw(view); return; }
      const tp = e.target.closest("[data-tfperiod]");
      if (tp) { tfPeriod = tp.dataset.tfperiod; draw(view); return; }
      if (e.target.closest("[data-act=addTransfer]")) { transferForm(view); return; }
      const tf = e.target.closest("[data-tf]");
      if (tf) { const x = db.transfers.find((y) => y.id === tf.dataset.tf); if (x) transferForm(view, x); return; }
      const s = e.target.closest("[data-sell]");
      if (s) { sellForm(view, s.dataset.sell); return; }
      const tr = e.target.closest("[data-id]");
      if (tr) { const t = db.trades.find((x) => x.id === tr.dataset.id); if (t) tradeForm(view, t); return; }
      if (e.target.closest("[data-act=saveRates]")) {
        const rates = JSON.parse(JSON.stringify(S().rates));
        view.querySelectorAll("[data-rate]").forEach((i) => { const [t, f] = i.dataset.rate.split("."); rates[t][f] = Number(i.value) || 0; });
        const rebate = Number(view.querySelector("[data-set=rebate]").value) || 0;
        const minFee = Number(view.querySelector("[data-set=minFee]").value) || 0;
        if (await commit((d) => { d.settings = { rates, rebate, minFee }; }, "帳務：修改費率")) draw(view);
      }
    };
    view.addEventListener("toggle", (e) => { // toggle 事件不冒泡，以捕獲階段記錄展開狀態
      const id = e.target.dataset && e.target.dataset.fold;
      if (id) { if (e.target.open) openFolds.add(id); else openFolds.delete(id); }
    }, true);
    view.onchange = async (e) => {
      if (e.target.id === "lgPrincipal") {
        const v = Number(e.target.value) || 0;
        if (await commit((d) => { d.principal = v; }, "帳務：修改本金")) draw(view);
      }
      if (e.target.id === "tfFrom" || e.target.id === "tfTo") {
        tfCustom[e.target.id === "tfFrom" ? "from" : "to"] = e.target.value;
        draw(view);
      }
      if (e.target.id === "lgFrom" || e.target.id === "lgTo") {
        custom[e.target.id === "lgFrom" ? "from" : "to"] = e.target.value;
        draw(view);
      }
    };
  }

  App.register({ id: "ledger", title: "帳務查詢", icon: "💰", render });
})();
