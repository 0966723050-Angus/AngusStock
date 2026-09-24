/* Angus 股市 — 登入、選單、路由、資料解密 */
(function () {
  "use strict";

  const KEY_STORE = "angus.stock.key";
  const $ = (s, el = document) => el.querySelector(s);

  // ------------------------------------------------------------ 加解密
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

  function storeGet() {
    try { return sessionStorage.getItem(KEY_STORE) || localStorage.getItem(KEY_STORE); } catch (e) { return null; }
  }
  function storeSet(v, remember) {
    try { (remember ? localStorage : sessionStorage).setItem(KEY_STORE, v); } catch (e) { /* 無痕模式 */ }
  }
  function storeClear() {
    try { sessionStorage.removeItem(KEY_STORE); localStorage.removeItem(KEY_STORE); } catch (e) { /* ignore */ }
  }

  let dataKey = null;   // CryptoKey
  let rawKeyB64 = null;

  async function importDataKey(rawB64) {
    return crypto.subtle.importKey("raw", b64(rawB64), { name: "AES-GCM" }, false, ["decrypt"]);
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

  async function loadData(name) {
    const blob = await fetch(`data/${name}.enc.json?t=${Date.now()}`, { cache: "no-store" }).then((r) => {
      if (!r.ok) throw new Error("資料讀取失敗 (" + r.status + ")");
      return r.json();
    });
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(blob.iv) }, dataKey, b64(blob.ct));
    return JSON.parse(new TextDecoder().decode(pt));
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
    pages.forEach((p) => {
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
    const id = (location.hash.replace(/^#\/?/, "") || pages[0].id).split("?")[0];
    const page = pages.find((p) => p.id === id) || pages[0];
    current = page;
    $("#pageTitle").textContent = page.title;
    document.title = page.title + "｜Angus 股市";
    document.querySelectorAll("#menuList a").forEach((a) => a.classList.toggle("active", a.dataset.id === page.id));
    const view = $("#view");
    view.innerHTML = '<div class="skeleton"></div>';
    try {
      await page.render(view);
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
    if (run.conclusion !== "success") throw new Error("更新失敗（" + run.conclusion + "）");
  }

  async function runUpdate(resumeSince) {
    if (updating) return;
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
          body: JSON.stringify({ ref: "main", inputs: { force: "true" } }),
        });
        try { sessionStorage.setItem(RUN_STORE, String(since)); } catch (e) { /* ignore */ }
      }
      await watchRun(cfg, since);
      bar("更新完成，重新載入資料…", "ok");
      await new Promise((r) => setTimeout(r, 4000)); // 等待 Pages CDN 生效
      await route();
      bar("資料已更新完成", "ok");
      setTimeout(() => bar(""), 4000);
    } catch (e) {
      bar(e.message || String(e), "err");
      setTimeout(() => bar(""), 8000);
    } finally {
      try { sessionStorage.removeItem(RUN_STORE); } catch (e) { /* ignore */ }
      updating = false;
      btn.disabled = false;
    }
  }

  // ------------------------------------------------------------ 啟動
  function showLogin(msg) {
    $("#app").hidden = true;
    $("#login").hidden = false;
    $("#loginMsg").textContent = msg || "";
    $("#loginUser").focus();
  }

  async function enterApp() {
    $("#login").hidden = true;
    $("#app").hidden = false;
    await route();
    // 若更新進行中時重新整理了頁面，繼續追蹤
    let pending = null;
    try { pending = sessionStorage.getItem(RUN_STORE); } catch (e) { /* ignore */ }
    if (pending) runUpdate(Number(pending));
  }

  async function onLogin(e) {
    e.preventDefault();
    const btn = $("#loginBtn");
    btn.disabled = true;
    $("#loginMsg").textContent = "";
    try {
      rawKeyB64 = await unwrap($("#loginUser").value.trim(), $("#loginPwd").value);
      dataKey = await importDataKey(rawKeyB64);
      storeSet(rawKeyB64, $("#loginRemember").checked);
      $("#loginPwd").value = "";
      await enterApp();
    } catch (err) {
      $("#loginMsg").textContent = err.message === "net" ? "無法連線，請稍後再試" : "帳號或密碼錯誤";
    } finally {
      btn.disabled = false;
    }
  }

  async function start() {
    buildMenu();
    $("#loginForm").addEventListener("submit", onLogin);
    $("#menuBtn").addEventListener("click", () => openMenu(!$("#drawer").classList.contains("open")));
    $("#scrim").addEventListener("click", () => openMenu(false));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") openMenu(false); });
    $("#logoutBtn").addEventListener("click", () => {
      storeClear(); dataKey = null; openMenu(false); showLogin("已登出");
    });
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

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }

    const saved = storeGet();
    if (saved) {
      try {
        dataKey = await importDataKey(saved);
        await enterApp();
        return;
      } catch (e) { storeClear(); }
    }
    showLogin();
  }

  window.App = { start, register, upcoming: upcomingItem, loadData, toast, setUpdated: (t) => { $("#drawerUpdated").textContent = t ? "資料更新：" + t : ""; } };
})();
