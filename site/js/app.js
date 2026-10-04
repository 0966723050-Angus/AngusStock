/* Angus 股市 — 登入、選單、路由、資料解密 */
(function () {
  "use strict";

  const KEY_STORE = "angus.stock.key";
  const $ = (s, el = document) => el.querySelector(s);

  // ------------------------------------------------------------ 加解密
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const toB64 = (buf) => {
    const u8 = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };

  function storeGet() {
    try { return sessionStorage.getItem(KEY_STORE) || localStorage.getItem(KEY_STORE); } catch (e) { return null; }
  }
  function storeSet(v, remember) {
    try { (remember ? localStorage : sessionStorage).setItem(KEY_STORE, v); } catch (e) { /* 無痕模式 */ }
  }
  function storeClear() {
    try { sessionStorage.removeItem(KEY_STORE); localStorage.removeItem(KEY_STORE); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------ Face ID 解鎖（WebAuthn 平台驗證器）
  // localStorage "angus.bio"：{ id: 憑證 ID, salt, wrapped?: { iv, ct } }
  //   支援 PRF（iOS 18 以上）時，資料金鑰以 Face ID 驗證後才能取得的金鑰加密保存（wrapped），裝置上不留明文金鑰；
  //   不支援 PRF 時，僅以 Face ID 驗證作為開啟門檻（金鑰仍保存在本機）。
  const BIO_STORE = "angus.bio";
  const LOCK_AFTER = 60000; // App 在背景超過 1 分鐘，回到前景時重新鎖定
  const bioGet = () => { try { return JSON.parse(localStorage.getItem(BIO_STORE) || "null"); } catch (e) { return null; } };
  const bioSet = (v) => { try { v ? localStorage.setItem(BIO_STORE, JSON.stringify(v)) : localStorage.removeItem(BIO_STORE); } catch (e) { /* ignore */ } };
  const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
  async function bioAvailable() {
    try { return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); } catch (e) { return false; }
  }
  async function bioAssert(bio) {
    const cred = await navigator.credentials.get({ publicKey: {
      challenge: rnd(32), rpId: location.hostname, userVerification: "required", timeout: 60000,
      allowCredentials: [{ type: "public-key", id: b64(bio.id) }],
      extensions: { prf: { eval: { first: b64(bio.salt) } } } } });
    const prf = cred.getClientExtensionResults().prf;
    return prf && prf.results && prf.results.first ? prf.results.first : null;
  }
  const prfKey = (out) => crypto.subtle.importKey("raw", out, "AES-GCM", false, ["encrypt", "decrypt"]);
  async function bioEnable() {
    const salt = rnd(32);
    const cred = await navigator.credentials.create({ publicKey: {
      rp: { name: "Angus 股市", id: location.hostname },
      user: { id: rnd(16), name: "angus-stock", displayName: "Angus 股市" },
      challenge: rnd(32), timeout: 60000,
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
      extensions: { prf: { eval: { first: salt } } } } });
    const bio = { id: toB64(cred.rawId), salt: toB64(salt) };
    const ext = cred.getClientExtensionResults().prf || {};
    let out = ext.results && ext.results.first;
    if (!out && ext.enabled) { try { out = await bioAssert(bio); } catch (e) { out = null; } } // 部分系統建立時不回傳 PRF，需再驗證一次
    if (out && rawKeyB64) {
      const iv = rnd(12);
      const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await prfKey(out), new TextEncoder().encode(rawKeyB64));
      bio.wrapped = { iv: toB64(iv), ct: toB64(ct) };
      storeClear(); // 不再保存明文金鑰
    } else if (rawKeyB64) {
      storeSet(rawKeyB64, true);
    }
    bioSet(bio);
    return !!bio.wrapped;
  }
  function bioDisable() {
    if (rawKeyB64) storeSet(rawKeyB64, true);
    bioSet(null);
  }
  function showLock(msg) {
    $("#app").hidden = true;
    $("#login").hidden = true;
    $("#lock").hidden = false;
    $("#lockMsg").textContent = msg || "";
  }
  let unlocking = false;
  async function unlock(auto) {
    const bio = bioGet();
    if (!bio || unlocking) return;
    unlocking = true;
    $("#unlockBtn").disabled = true;
    $("#lockMsg").textContent = "";
    try {
      const out = await bioAssert(bio);
      let raw = null;
      if (bio.wrapped) {
        if (!out) throw new Error("此裝置無法取得 Face ID 金鑰，請改用帳號密碼登入");
        const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(bio.wrapped.iv) }, await prfKey(out), b64(bio.wrapped.ct));
        raw = new TextDecoder().decode(pt);
      } else {
        raw = storeGet();
      }
      if (!raw) throw new Error("登入資料已失效，請改用帳號密碼登入");
      rawKeyB64 = raw;
      dataKey = await importDataKey(raw);
      $("#lock").hidden = true;
      if (!$("#view").children.length || !current) await enterApp();
      else { $("#app").hidden = false; route(); }
    } catch (e) {
      // 自動啟動時若系統要求點按（NotAllowedError）就不顯示錯誤，等待使用者按「以 Face ID 解鎖」
      if (!(auto && e && e.name === "NotAllowedError")) {
        $("#lockMsg").textContent = e && e.name === "NotAllowedError" ? "未完成 Face ID 驗證，請再試一次" : (e.message || "解鎖失敗");
      }
    } finally {
      unlocking = false;
      $("#unlockBtn").disabled = false;
    }
  }
  async function refreshBioBtn() {
    const btn = $("#bioBtn");
    if (!(await bioAvailable())) { btn.hidden = true; return; }
    btn.hidden = false;
    btn.textContent = bioGet() ? "關閉 Face ID 解鎖" : "啟用 Face ID 解鎖";
  }

  let dataKey = null;   // CryptoKey
  let rawKeyB64 = null;

  async function importDataKey(rawB64) {
    return crypto.subtle.importKey("raw", b64(rawB64), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }

  // 以資料金鑰加密（格式與 Python 端相同：密文 + 16 bytes tag）
  async function encryptJSON(obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, dataKey, new TextEncoder().encode(JSON.stringify(obj)));
    return { v: 1, iv: toB64(iv), ct: toB64(ct) };
  }

  async function decryptJSON(blob) {
    let pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(blob.iv) }, dataKey, b64(blob.ct));
    if (blob.z === "gzip") pt = await new Response(new Blob([pt]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    return JSON.parse(new TextDecoder().decode(pt));
  }

  // ------------------------------------------------------------ repo 內的加密資料檔（帳務等）：透過 GitHub API 即時讀寫
  // 讀取：{ data, sha }（檔案不存在時 data 為 null）；寫入需權杖具備 Contents 寫入權限，sha 用於避免覆寫他處的新版本
  async function repoRead(path) {
    const cfg = await loadData("dispatch");
    const r = await fetch(`https://api.github.com/repos/${cfg.repo}/contents/${path}?ref=main&t=${Date.now()}`, {
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      cache: "no-store",
    });
    if (r.status === 404) return { data: null, sha: null };
    if (!r.ok) throw new Error("讀取資料失敗 (" + r.status + ")");
    const j = await r.json();
    const blob = JSON.parse(new TextDecoder().decode(b64(j.content.replace(/\s/g, ""))));
    return { data: await decryptJSON(blob), sha: j.sha };
  }
  async function repoWrite(path, obj, sha, message) {
    const cfg = await loadData("dispatch");
    const blob = await encryptJSON(obj);
    const r = await fetch(`https://api.github.com/repos/${cfg.repo}/contents/${path}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
      body: JSON.stringify({ message, branch: "main", content: btoa(JSON.stringify(blob)), ...(sha ? { sha } : {}) }),
    });
    if (r.status === 409 || r.status === 422) { const e = new Error("資料已在其他裝置更新"); e.conflict = true; throw e; }
    if (r.status === 403 || r.status === 404) throw new Error("權杖沒有寫入權限：請在 GitHub 權杖設定加上「Contents：Read and write」");
    if (!r.ok) throw new Error("儲存失敗 (" + r.status + ")");
    return (await r.json()).content.sha;
  }

  // ------------------------------------------------------------ 即時報價（Google Apps Script 中轉，網址加密存於 data/live.enc.json）
  let liveCache = null;
  async function liveCfg() {
    if (liveCache) return liveCache;
    try { liveCache = await loadData("live"); } catch (e) { return null; }
    return liveCache;
  }
  // 證交所偶爾拒絕 Google 主機連線（約三成），失敗時自動重試
  async function live(params, tries = 3) {
    for (let i = 1; ; i++) {
      try { return await liveOnce(params); } catch (e) {
        if (i >= tries || e.message === "尚未設定即時報價服務") throw e;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
  async function liveOnce(params) {
    const cfg = await liveCfg();
    if (!cfg || !cfg.url) throw new Error("尚未設定即時報價服務");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(cfg.url + "?" + new URLSearchParams(params), { cache: "no-store", signal: ctl.signal });
      if (!r.ok) throw new Error("即時報價連線失敗 (" + r.status + ")");
      const j = await r.json();
      if (j.error) throw new Error("即時報價：" + j.error);
      return j;
    } finally { clearTimeout(timer); }
  }
  // 台股即時報價：證交所 MIS 與 Yahoo 奇摩股市同時查詢，採用先成功回來的結果（list：["tse_2330.tw", "otc_o00.tw", ...]）
  const toYahoo = (ch) => ch.replace(/^tse_t00\.tw$/, "^TWII").replace(/^otc_o00\.tw$/, "^TWOII")
    .replace(/^tse_(.+)\.tw$/, "$1.TW").replace(/^otc_(.+)\.tw$/, "$1.TWO");
  async function twQuotes(list) {
    const ok = (p) => p.then((j) => { if (!(j.rows || []).length) throw new Error("即時報價無資料"); return j; });
    const once = () => Promise.any([ok(live({ t: "mis", ex_ch: list.join("|") }, 1)), ok(live({ t: "tw", s: list.map(toYahoo).join(",") }, 1))]);
    try { return await once(); } catch (e) {
      try { return await once(); } catch (e2) { throw (e2.errors || [e2])[0]; }
    }
  }
  // 台北時間（字串 YYYY-MM-DD HH:mm:ss）與台股／台指期交易時段
  const taipei = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace("T", " ");
  function marketOpen() {
    const d = new Date(Date.now() + 8 * 3600e3), wd = d.getUTCDay(), m = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (wd >= 1 && wd <= 5 && m >= 8 * 60 + 40 && m <= 13 * 60 + 50) return true;   // 日盤（含期貨 08:45 開盤）
    if (wd >= 1 && wd <= 5 && m >= 15 * 60) return true;                          // 期貨夜盤
    if (wd >= 2 && wd <= 6 && m <= 5 * 60 + 5) return true;                       // 夜盤跨日至 05:00
    return false;
  }

  async function unwrap(user, pwd) {
    const kw = await fetch("data/keywrap.json", { cache: "no-store" }).then((r) => {
      if (!r.ok) throw new Error("net");
      return r.json();
    });
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(user + "\n" + pwd), "PBKDF2", false, ["deriveKey"]);
    const kek = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: b64(kw.salt), iterations: kw.iter, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(kw.iv) }, kek, b64(kw.ct));
    return toB64(raw);
  }

  // 資料讀取：先取得部署時產生的版本清單（data/manifest.json，每次都向伺服器取最新），
  // 再以「檔名?v=版本」讀取資料檔：版本相同沿用記憶體中的資料，版本不同的網址必定是新檔，不會拿到 CDN 的舊資料
  const memo = new Map();
  let man = null, manAt = 0;
  async function manifest() {
    if (man && Date.now() - manAt < 15000) return man;
    try {
      const r = await fetch(`data/manifest.json?t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) { man = (await r.json()).files || {}; manAt = Date.now(); }
    } catch (e) { /* 離線時沿用 */ }
    return man || {};
  }
  async function loadData(name) {
    const v = (await manifest())[name];
    const hit = memo.get(name);
    if (v && hit && hit.v === v && hit.key === dataKey) return hit.data;
    const r = await fetch(`data/${name}.enc.json?` + (v ? `v=${v}` : `t=${Date.now()}`), { cache: v ? "default" : "no-store" });
    if (!r.ok) throw new Error("資料讀取失敗 (" + r.status + ")");
    const blob = await r.json();
    let pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(blob.iv) }, dataKey, b64(blob.ct));
    if (blob.z === "gzip") pt = await new Response(new Blob([pt]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    const data = JSON.parse(new TextDecoder().decode(pt));
    if (v) memo.set(name, { v, key: dataKey, data });
    return data;
  }

  // 登入後於背景預先載入其他頁面的資料，切換頁面時即可直接顯示
  function prefetch() {
    const names = ["quotes", "watchlist", "intl", "screen", "ohlc", "stocks", "instrank"];
    const run = async () => { for (const n of names) { try { await loadData(n); } catch (e) { /* 略過 */ } } };
    setTimeout(() => (window.requestIdleCallback ? requestIdleCallback(run, { timeout: 3000 }) : run()), 1500);
  }

  // ------------------------------------------------------------ 頁面註冊
  // 新增分頁：App.register({ id, title, icon, render(el) })；render 可為 async
  const pages = [];
  function register(p) { pages.push(p); }

  // 尚未開放的分頁（顯示於選單，灰色）
  const upcoming = [];
  function upcomingItem(title) { upcoming.push(title); }

  // ------------------------------------------------------------ 選單與路由
  function openMenu(open) {
    $("#drawer").classList.toggle("open", open);
    $("#scrim").hidden = !open;
    $("#menuBtn").setAttribute("aria-expanded", String(open));
  }

  function buildMenu() {
    const ul = $("#menuList");
    ul.innerHTML = "";
    pages.filter((p) => !p.hidden).forEach((p) => {
      const li = document.createElement("li");
      li.innerHTML = `<a href="#/${p.id}" data-id="${p.id}"><span aria-hidden="true">${p.icon || "•"}</span>${p.title}</a>`;
      ul.appendChild(li);
    });
    upcoming.forEach((t) => {
      const li = document.createElement("li");
      li.className = "disabled";
      li.innerHTML = `<span><span aria-hidden="true">🛠️</span>${t}<em class="soon">建置中</em></span>`;
      ul.appendChild(li);
    });
    ul.addEventListener("click", (e) => { if (e.target.closest("a")) openMenu(false); });
  }

  let current = null;
  async function route() {
    const [id0, qs] = (location.hash.replace(/^#\/?/, "") || pages[0].id).split("?");
    const id = id0;
    const params = new URLSearchParams(qs || "");
    const page = pages.find((p) => p.id === id) || pages[0];
    current = page;
    $("#pageAction").innerHTML = "";
    $("#pageTitle").textContent = page.title;
    document.title = page.title + "｜Angus 股市";
    document.querySelectorAll("#menuList a").forEach((a) => a.classList.toggle("active", a.dataset.id === (page.menu || page.id)));
    document.querySelectorAll(".sheet").forEach((s) => s.remove());
    document.body.classList.remove("no-scroll");
    // 換頁時換成新的容器，清除前一頁掛在容器上的事件處理
    const old = $("#view");
    const view = old.cloneNode(false);
    old.replaceWith(view);
    view.innerHTML = '<div class="skeleton"></div>';
    try {
      window.scrollTo(0, 0);
      await page.render(view, params);
    } catch (e) {
      console.error(e);
      if (e && e.name === "OperationError") { // 金鑰已更換，需重新登入
        storeClear(); dataKey = null; showLogin("登入已過期，請重新登入");
        return;
      }
      view.innerHTML = `<div class="card empty">載入失敗：${e.message || e}</div>`;
    }
  }

  function toast(msg) {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  // ------------------------------------------------------------ 立即更新（觸發 GitHub Actions）
  const RUN_STORE = "angus.stock.run";
  let updating = false;

  function bar(text, state) {
    const b = $("#updateBar");
    b.hidden = !text;
    b.className = "update-bar" + (state ? " " + state : "");
    $("#updateText").textContent = text || "";
  }

  async function gh(cfg, path, opts = {}) {
    const r = await fetch(`https://api.github.com/repos/${cfg.repo}${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(opts.headers || {}) },
      cache: "no-store",
    });
    if (r.status === 401 || r.status === 403) throw new Error("GitHub 權杖無效或已過期，請重新設定");
    if (!r.ok) throw new Error("GitHub 回應錯誤 (" + r.status + ")");
    return r.status === 204 ? null : r.json();
  }

  const elapsed = (t0) => {
    const s = Math.floor((Date.now() - t0) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  // 等待 since 之後由手動觸發的執行完成
  async function watchRun(cfg, since) {
    const t0 = since;
    let run = null;
    for (;;) {
      const list = await gh(cfg, `/actions/workflows/${cfg.workflow}/runs?event=workflow_dispatch&per_page=5`);
      run = (list.workflow_runs || []).find((x) => Date.parse(x.created_at) >= since - 60000) || run;
      if (run && run.status === "completed") break;
      const phase = !run ? "排隊中" : run.status === "in_progress" ? "抓取資料與部署中" : "等待執行";
      bar(`資料更新中（${phase}）… 已經過 ${elapsed(t0)}，約需 1～3 分鐘`);
      if (Date.now() - t0 > 15 * 60000) throw new Error("更新逾時，請稍後再重新整理");
      await new Promise((r) => setTimeout(r, 8000));
    }
    if (run.conclusion === "cancelled") {
      // 部署排隊時可能被較新的部署取代：資料已抓取完成即視為成功（由較新的部署上線）
      const jobs = await gh(cfg, `/actions/runs/${run.id}/jobs`);
      const upd = (jobs.jobs || []).find((j) => j.name === "update");
      if (upd && upd.conclusion === "success") { await new Promise((r) => setTimeout(r, 30000)); return; }
    }
    if (run.conclusion !== "success") throw new Error("更新失敗（" + run.conclusion + "）");
  }

  // opts.inputs：傳給 workflow 的參數；opts.resume：續追先前送出的執行
  async function runUpdate(opts = {}) {
    const resumeSince = opts.resume;
    if (updating) { toast("已有更新在進行中，請稍候"); return false; }
    updating = true;
    const btn = $("#updateBtn");
    btn.disabled = true;
    try {
      let cfg;
      try { cfg = await loadData("dispatch"); } catch (e) {
        throw new Error("尚未設定更新權杖（請執行 scripts/set_dispatch_token.py）");
      }
      let since = resumeSince;
      if (!since) {
        since = Date.now();
        bar("正在送出更新要求…");
        await gh(cfg, `/actions/workflows/${cfg.workflow}/dispatches`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ref: "main", inputs: opts.inputs || { force: "true" } }),
        });
        try { sessionStorage.setItem(RUN_STORE, String(since)); } catch (e) { /* ignore */ }
      }
      await watchRun(cfg, since);
      bar("更新完成，重新載入資料…", "ok");
      await new Promise((r) => setTimeout(r, 4000)); // 等待 Pages CDN 生效
      man = null; // 重新取得版本清單
      await route();
      bar("資料已更新完成", "ok");
      setTimeout(() => bar(""), 4000);
      return true;
    } catch (e) {
      bar(e.message || String(e), "err");
      setTimeout(() => bar(""), 8000);
      return false;
    } finally {
      try { sessionStorage.removeItem(RUN_STORE); } catch (e) { /* ignore */ }
      updating = false;
      btn.disabled = false;
    }
  }

  // ------------------------------------------------------------ 啟動
  function showLogin(msg) {
    $("#app").hidden = true;
    $("#lock").hidden = true;
    $("#login").hidden = false;
    $("#loginMsg").textContent = msg || "";
    $("#loginUser").focus();
  }

  async function enterApp() {
    $("#login").hidden = true;
    $("#lock").hidden = true;
    refreshBioBtn();
    $("#app").hidden = false;
    await route();
    prefetch();
    // 若更新進行中時重新整理了頁面，繼續追蹤
    let pending = null;
    try { pending = sessionStorage.getItem(RUN_STORE); } catch (e) { /* ignore */ }
    if (pending) runUpdate({ resume: Number(pending) });
  }

  async function onLogin(e) {
    e.preventDefault();
    const btn = $("#loginBtn");
    btn.disabled = true;
    $("#loginMsg").textContent = "";
    try {
      // 全形轉半形（中文輸入法常見）並去除前後空白
      const norm = (v) => v.normalize("NFKC").trim();
      rawKeyB64 = await unwrap(norm($("#loginUser").value), norm($("#loginPwd").value));
      dataKey = await importDataKey(rawKeyB64);
      const bio = bioGet();
      if (!(bio && bio.wrapped)) storeSet(rawKeyB64, $("#loginRemember").checked); // Face ID 加密保存時不另存明文金鑰
      $("#loginPwd").value = "";
      await enterApp();
      if (!bioGet() && await bioAvailable()) toast("可在選單中「啟用 Face ID 解鎖」");
    } catch (err) {
      $("#loginMsg").textContent = err.message === "net" ? "無法連線，請稍後再試" : "帳號或密碼錯誤";
    } finally {
      btn.disabled = false;
    }
  }

  async function start() {
    buildMenu();
    $("#loginForm").addEventListener("submit", onLogin);
    $("#showPwd").addEventListener("change", (e) => { $("#loginPwd").type = e.target.checked ? "text" : "password"; });
    $("#menuBtn").addEventListener("click", () => openMenu(!$("#drawer").classList.contains("open")));
    $("#scrim").addEventListener("click", () => openMenu(false));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") openMenu(false); });
    $("#logoutBtn").addEventListener("click", () => {
      storeClear(); bioSet(null); dataKey = null; rawKeyB64 = null; openMenu(false); showLogin("已登出");
    });
    $("#bioBtn").addEventListener("click", async () => {
      if (bioGet()) {
        if (!confirm("要關閉 Face ID 解鎖嗎？\n關閉後開啟 App 不再需要驗證。")) return;
        bioDisable();
        toast("已關閉 Face ID 解鎖");
      } else {
        try {
          const strong = await bioEnable();
          toast(strong ? "已啟用 Face ID 解鎖（金鑰已加密保存）" : "已啟用 Face ID 解鎖");
        } catch (e) {
          toast(e && e.name === "NotAllowedError" ? "已取消啟用" : "無法啟用 Face ID：" + (e.message || e));
        }
      }
      refreshBioBtn();
    });
    $("#unlockBtn").addEventListener("click", () => unlock(false));
    $("#lockPwdBtn").addEventListener("click", () => { $("#lock").hidden = true; showLogin(); });
    $("#refreshBtn").addEventListener("click", async () => {
      const b = $("#refreshBtn");
      b.classList.add("spin");
      await route();
      b.classList.remove("spin");
      toast("資料已更新");
    });
    $("#updateBtn").addEventListener("click", () => {
      if (confirm("要立即向交易所抓取最新資料並更新網站嗎？\n（約需 1～3 分鐘）")) runUpdate();
    });
    window.addEventListener("hashchange", () => { if (dataKey) route(); });
    // 主畫面 App 由背景回到前景（超過 3 分鐘）或由瀏覽器快取還原頁面時，重新載入目前頁面的資料
    let hiddenAt = 0;
    const reload = () => { if (dataKey && !updating && !document.querySelector(".sheet")) { man = null; route(); } };
    document.addEventListener("visibilitychange", () => {
      // 已啟用 Face ID：進入背景時遮住畫面，App 切換器的預覽不會顯示資料
      if (document.hidden) { hiddenAt = Date.now(); if (bioGet()) document.body.classList.add("privacy"); return; }
      document.body.classList.remove("privacy");
      const away = hiddenAt ? Date.now() - hiddenAt : 0;
      // 已啟用 Face ID：在背景超過 1 分鐘就重新鎖定（清除記憶體中的金鑰與資料）
      if (bioGet() && dataKey && away > LOCK_AFTER && !updating) {
        dataKey = null; rawKeyB64 = null; memo.clear(); man = null;
        showLock();
        return;
      }
      if (away > 180000) reload();
    });
    window.addEventListener("pageshow", (e) => { if (e.persisted) reload(); });

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }

    refreshBioBtn();
    if (bioGet()) { showLock(); unlock(true); return; } // 已啟用 Face ID：先驗證（若系統要求點按，畫面上有解鎖按鈕）
    const saved = storeGet();
    if (saved) {
      try {
        rawKeyB64 = saved;
        dataKey = await importDataKey(saved);
        await enterApp();
        return;
      } catch (e) { storeClear(); }
    }
    showLogin();
  }

  window.App = {
    start, register, upcoming: upcomingItem, loadData, encryptJSON, decryptJSON, repoRead, repoWrite, live, twQuotes, hasLive: async () => !!(await liveCfg()), taipei, marketOpen, toast, bar,
    runUpdate, isUpdating: () => updating,
    setAction: (el) => { const a = $("#pageAction"); a.innerHTML = ""; if (el) a.appendChild(el); }, setUpdated: (t) => { $("#drawerUpdated").textContent = t ? "資料更新：" + t : ""; } };
})();
