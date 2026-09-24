# AngusStock

台灣股市交易資訊與技術指標查詢（個人網站，需登入）。

- 網站：GitHub Pages（RWD + PWA，可加入手機主畫面）
- 資料來源：臺灣證券交易所（TWSE / MIS）、證券櫃檯買賣中心（TPEx）
- 更新排程：開盤日 13:35、22:00（台北時間，GitHub Actions；排程可能延遲數分鐘）

## 資料保護

所有股市資料皆以 AES-256-GCM 加密後才發布：

- `DATA_KEY`（資料金鑰）只存在 GitHub Secrets，供 Actions 加密資料。
- `site/data/keywrap.json` 以「帳號 + 密碼」經 PBKDF2 衍生的金鑰包裝 `DATA_KEY`；
  瀏覽器登入時在本機解開，帳密本身不存在於任何檔案中。
- 更換帳密：`DATA_KEY=... python scripts/make_keywrap.py <新帳號> <新密碼>`，提交 `keywrap.json` 即可。

## 結構

```
site/                 網站（部署到 Pages）
  index.html          App 殼層、登入、漢堡選單
  js/app.js           登入解密、路由、頁面註冊 App.register()
  js/home.js          首頁
  data/*.enc.json     加密資料
state/                加密的歷史資料（指數、三大法人）
scripts/update_data.py 抓資料 / 回補（--backfill）/ 強制（--force）
.github/workflows/update.yml 排程更新 + 部署
```

## 新增分頁

建立 `site/js/<page>.js`，呼叫：

```js
App.register({ id: "tech", title: "個股技術指標", icon: "📈", render: async (el) => { ... } });
```

並在 `index.html` 引入、`sw.js` 的快取清單加入該檔。
