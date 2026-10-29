/**
 * AngusStock 即時報價中轉（Google Apps Script 網頁應用程式）
 *
 * 用途：網頁無法直接讀取證交所／期交所／Yahoo（瀏覽器跨網站限制），由此程式代為查詢並回傳 JSON。
 * 只允許下列查詢，不能當成一般用途的中轉站（另含定時觸發 GitHub 更新，見檔案最後）：
 *   ?t=mis&ex_ch=tse_2330.tw|otc_6488.tw|tse_t00.tw   證交所 MIS 即時報價（上市、上櫃、指數）
 *   ?t=tw&s=2330.TW,6488.TWO,^TWII,^TWOII                Yahoo 奇摩股市即時報價（備援；格式同 mis）
 *   ?t=intraday&s=2313.TW                               Yahoo 奇摩股市個股當日每分鐘走勢（上市 .TW／上櫃 .TWO）
 *   ?t=ohlc&m=TSE                                       證交所 MIS 大盤盤中每分鐘走勢（TSE＝加權、OTC＝櫃買）
 *   ?t=taifex&mt=0                                      期交所台指期即時報價（0＝日盤、1＝夜盤）
 *   ?t=yahoo&s=^DJI,^SOX,GC=F                           Yahoo Finance 國際行情
 *   ?t=kline&s=2313.TW&i=1wk                            Yahoo Finance 週 K（1wk，近 5 年）／月 K（1mo，近 10 年）歷史
 *   ?t=breadth&d=20261029                               證交所／櫃買中心盤後漲跌家數（上市「股票」、上櫃股票；尚未公布則為 null）
 *   ?t=split&s=2330.TW,6488.TWO                         Yahoo 奇摩股市個股分時量：09:30～11:40、11:41～13:20 的成交量（隔日沖選股；最多 200 檔）
 *
 * 部署：script.google.com → 新專案 → 貼上本檔 → 部署 → 新增部署作業 → 類型「網頁應用程式」
 *       執行身分：我　／　誰可以存取：所有人 → 部署 → 複製「網頁應用程式網址」
 * 更新程式：貼上新版後 → 部署 → 管理部署作業 → 編輯（鉛筆）→ 版本選「新版本」→ 部署（網址不變）
 */
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36';

function doGet(e) {
  var p = (e && e.parameter) || {};
  var out;
  try {
    if (p.t === 'mis') out = mis(p.ex_ch);
    else if (p.t === 'tw') out = tw(p.s);
    else if (p.t === 'ohlc') out = ohlc(p.m);
    else if (p.t === 'intraday') out = intraday(p.s);
    else if (p.t === 'taifex') out = taifex(p.mt);
    else if (p.t === 'yahoo') out = yahoo(p.s);
    else if (p.t === 'kline') out = kline(p.s, p.i);
    else if (p.t === 'split') out = split(p.s);
    else if (p.t === 'breadth') out = breadth(p.d);
    else out = { error: 'unknown type' };
  } catch (err) {
    out = { error: String(err) };
  }
  out.ts = Date.now();
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// 連線失敗（證交所偶爾拒絕 Google 主機）時重試，最多 4 次
function fetchRetry(req) {
  for (var i = 0; i < 4; i++) {
    try { return UrlFetchApp.fetch(req.url, { headers: req.headers, muteHttpExceptions: true }); }
    catch (err) { if (i === 3) throw err; Utilities.sleep(250); }
  }
}

// 證交所 MIS 大盤每分鐘走勢：c＝指數、s＝該分鐘成交金額（百萬元）；staticObj：tz 成交金額（元）、tv 成交量（張）、tr 成交筆數
function ohlc(m) {
  var mk = m === 'OTC' ? 'OTC' : 'TSE';
  var r = fetchRetry({ url: 'https://mis.twse.com.tw/stock/data/mis_ohlc_' + mk + '.txt', headers: { 'User-Agent': UA }, muteHttpExceptions: true });
  var j = JSON.parse(r.getContentText()), st = j.staticObj || {};
  return { key: st.key, tz: st.tz, tv: st.tv, tr: st.tr,
    rows: (j.ohlcArray || []).map(function (a) { return [a.ts, a.c, a.s]; }) };
}

// 證交所 MIS：每次最多 50 檔，多批同時查詢
function mis(exch) {
  if (!exch || !/^[a-z0-9_.|]+$/i.test(exch)) return { error: 'bad ex_ch' };
  var list = exch.split('|').slice(0, 300), reqs = [];
  for (var i = 0; i < list.length; i += 50) {
    reqs.push({
      url: 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch=' + encodeURIComponent(list.slice(i, i + 50).join('|')),
      headers: { 'User-Agent': UA, Referer: 'https://mis.twse.com.tw/stock/index.jsp' }, muteHttpExceptions: true,
    });
  }
  var rows = [], resps;
  try { resps = UrlFetchApp.fetchAll(reqs); } catch (err) { resps = reqs.map(fetchRetry); } // 同時查詢失敗時逐批重試
  resps.forEach(function (r) {
    try {
      (JSON.parse(r.getContentText()).msgArray || []).forEach(function (m) {
        rows.push({ c: m.c, n: m.n, ex: m.ex, z: m.z, y: m.y, o: m.o, h: m.h, l: m.l, v: m.v, b: m.b, a: m.a, d: m.d, t: m.t });
      });
    } catch (err) { /* 略過失敗的批次 */ }
  });
  return { rows: rows };
}

// Yahoo 奇摩股市即時報價（證交所 MIS 連線不穩時的備援）；回傳欄位與 mis 相同（v 為張數），另含 inM 內盤、outM 外盤、pv 昨日成交量（張）、amt 成交金額（百萬元）
function tw(s) {
  if (!s || !/^[\^A-Za-z0-9.,]+$/.test(s)) return { error: 'bad symbols' };
  var syms = s.split(',').slice(0, 300), reqs = [], rows = [];
  for (var i = 0; i < syms.length; i += 50) {
    reqs.push({ url: 'https://tw.stock.yahoo.com/_td-stock/api/resource/StockServices.stockList;fields=avgPrice;symbols=' +
      encodeURIComponent(syms.slice(i, i + 50).join(',')), headers: { 'User-Agent': UA }, muteHttpExceptions: true });
  }
  var resps;
  try { resps = UrlFetchApp.fetchAll(reqs); } catch (err) { resps = reqs.map(fetchRetry); }
  var raw = function (x) { return x && x.raw != null && x.raw !== '-' ? x.raw : null; };
  resps.forEach(function (r) {
    try {
      JSON.parse(r.getContentText()).forEach(function (x) {
        var code = x.symbol === '^TWII' ? 't00' : x.symbol === '^TWOII' ? 'o00' : x.systexId;
        // 當日無成交的股票 regularMarketTime 為「-」，不可轉成日期（否則整批 50 檔都會失敗）
        var ms = x.regularMarketTime ? new Date(x.regularMarketTime).getTime() : NaN;
        var t = isFinite(ms) ? new Date(ms + 8 * 3600e3).toISOString() : '';
        rows.push({ c: code, z: raw(x.price), y: raw(x.regularMarketPreviousClose), o: raw(x.regularMarketOpen), h: raw(x.regularMarketDayHigh),
          l: raw(x.regularMarketDayLow), v: x.volume ? String(Math.round(Number(x.volume) / 1000)) : null,
          d: t.slice(0, 10).replace(/-/g, ''), t: t.slice(11, 19), src: 'yahoo',
          inM: x.inMarket != null ? x.inMarket : null, outM: x.outMarket != null ? x.outMarket : null, pv: x.previousVolumeK != null ? x.previousVolumeK : null,
          amt: x.turnoverM != null ? x.turnoverM : null });
      });
    } catch (err) { /* 略過 */ }
  });
  return { rows: rows };
}

// 個股當日每分鐘走勢：rows＝[[時間 HH:MM, 收盤, 成交量(張), 最高, 最低]]
function intraday(s) {
  if (!s || !/^[0-9A-Z]{4,6}\.(TW|TWO)$/.test(s)) return { error: 'bad symbol' };
  var r = fetchRetry({ url: 'https://tw.stock.yahoo.com/_td-stock/api/resource/FinanceChartService.ApacLibraCharts;symbols=' +
    encodeURIComponent('["' + s + '"]') + ';type=tick', headers: { 'User-Agent': UA } });
  var c = JSON.parse(r.getContentText())[0].chart, m = c.meta || {}, q = (c.indicators.quote || [{}])[0], rows = [];
  (c.timestamp || []).forEach(function (t, i) {
    if (q.close[i] == null) return;
    var d = new Date(t * 1000 + 8 * 3600e3);
    rows.push([('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2), q.close[i], q.volume[i] || 0,
      q.high[i] != null ? q.high[i] : q.close[i], q.low[i] != null ? q.low[i] : q.close[i]]);
  });
  var day = m.regularMarketTime ? new Date(m.regularMarketTime * 1000 + 8 * 3600e3).toISOString().slice(0, 10) : '';
  return { sym: s, day: day, price: m.regularMarketPrice, prev: m.previousClose, up: m.limitUpPrice, down: m.limitDownPrice, rows: rows };
}

// 分時量（隔日沖選股）：每次 50 檔同時查詢當日每分鐘走勢，只回傳區間量（張）
// rows＝[[代號, 09:30～11:40 成交量, 11:41～13:20 成交量（未到 13:20 則到最新一分鐘）, 最新一分鐘 HH:MM, 日期 YYYY-MM-DD]]
function split(s) {
  if (!s || !/^[0-9A-Z.,]+$/.test(s)) return { error: 'bad symbols' };
  var syms = s.split(',').filter(function (x) { return /^[0-9A-Z]{4,6}\.(TW|TWO)$/.test(x); }).slice(0, 200), reqs = [], rows = [];
  for (var i = 0; i < syms.length; i += 50) {
    reqs.push({ url: 'https://tw.stock.yahoo.com/_td-stock/api/resource/FinanceChartService.ApacLibraCharts;symbols=' +
      encodeURIComponent(JSON.stringify(syms.slice(i, i + 50))) + ';type=tick', headers: { 'User-Agent': UA }, muteHttpExceptions: true });
  }
  var resps;
  try { resps = UrlFetchApp.fetchAll(reqs); } catch (err) { resps = reqs.map(fetchRetry); }
  resps.forEach(function (r) {
    try {
      JSON.parse(r.getContentText()).forEach(function (x) {
        var c = x.chart, q = (c.indicators.quote || [{}])[0], am = 0, pm = 0, last = '', day = '';
        (c.timestamp || []).forEach(function (t, i) {
          var d = new Date(t * 1000 + 8 * 3600e3), hm = d.toISOString().slice(11, 16), v = q.volume[i] || 0;
          if (hm >= '09:30' && hm <= '11:40') am += v;
          else if (hm >= '11:41' && hm <= '13:20') pm += v;
          if (q.close[i] != null && hm > last) { last = hm; day = d.toISOString().slice(0, 10); }
        });
        rows.push([String(c.meta.symbol || '').split('.')[0], am, pm, last, day]);
      });
    } catch (err) { /* 略過失敗的批次 */ }
  });
  return { rows: rows };
}

// 週／月 K 歷史：rows＝[[期間起始日 YYYY-MM-DD, 開, 高, 低, 收, 成交量(股)]]
function kline(s, iv) {
  if (!s || !/^\^?[0-9A-Z]{2,6}(\.(TW|TWO))?$/.test(s)) return { error: 'bad symbol' };
  var wk = iv !== '1mo';
  var r = fetchRetry({ url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(s) + '?range=' + (wk ? '5y' : '10y') +
    '&interval=' + (wk ? '1wk' : '1mo'), headers: { 'User-Agent': UA } });
  var c = JSON.parse(r.getContentText()).chart.result[0], q = c.indicators.quote[0], rows = [];
  (c.timestamp || []).forEach(function (t, i) {
    if (q.close[i] == null || q.open[i] == null) return;
    rows.push([new Date(t * 1000 + 8 * 3600e3).toISOString().slice(0, 10), q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i]]);
  });
  return { sym: s, rows: rows };
}

// 盤後漲跌家數（與 scripts/update_data.py fetch_tse_breadth／fetch_otc_breadth 相同）：
// { tse: {up, limit_up, flat, down, limit_down}｜null, otc: 同上｜null }；尚未公布的市場為 null
function breadth(d) {
  if (!/^\d{8}$/.test(d || '')) return { error: 'bad date' };
  var num = function (x) { return parseInt(String(x || '0').replace(/,/g, ''), 10) || 0; };
  var pair = function (x) { var m = /([\d,]+)\(([\d,]+)\)/.exec(x || ''); return m ? [num(m[1]), num(m[2])] : [num(x), 0]; };
  var err = [];
  // 各來源分開查詢：一邊逾時或尚未公布不影響另一邊；失敗原因放在 err 方便除錯
  var get = function (url) {
    try {
      var r = UrlFetchApp.fetch(url, { headers: { 'User-Agent': UA }, muteHttpExceptions: true });
      if (r.getResponseCode() !== 200) { err.push(r.getResponseCode() + ' ' + url); return null; }
      return JSON.parse(r.getContentText());
    } catch (e) { err.push(String(e).slice(0, 120)); return null; }
  };
  var tse = null, otc = null;
  var q = 'response=json&type=MS&date=' + d;
  ['https://www.twse.com.tw/exchangeReport/MI_INDEX?' + q, 'https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?' + q].some(function (url) {
    var j = get(url);
    if (!j) return false;
    if (j.date !== d) { err.push('twse ' + (j.stat || j.date)); return false; }
    (j.tables || []).forEach(function (t) {
      if (t.title !== '漲跌證券數合計') return;
      var m = {};
      t.data.forEach(function (r) { m[r[0]] = r[2]; }); // 「股票」欄
      var u = pair(m['上漲(漲停)']), w = pair(m['下跌(跌停)']);
      tse = { up: u[0], limit_up: u[1], flat: num(m['持平']), down: w[0], limit_down: w[1] };
    });
    return !!tse;
  });
  var h = get('https://www.tpex.org.tw/www/zh-tw/afterTrading/highlight?response=json&date=' + d.slice(0, 4) + '/' + d.slice(4, 6) + '/' + d.slice(6));
  try {
    var t = h && h.tables && h.tables[0];
    if (t) {
      var roc = String(t.date).split('/');
      if (String(+roc[0] + 1911) + roc[1] + roc[2] === d) {
        var r = {};
        t.fields.forEach(function (f, i) { r[f] = t.data[0][i]; });
        otc = { up: num(r['上漲家數']), limit_up: num(r['漲停家數']), flat: num(r['平盤家數']), down: num(r['下跌家數']), limit_down: num(r['跌停家數']) };
      }
    }
  } catch (e) { err.push('tpex ' + String(e).slice(0, 80)); }
  return { date: d, tse: tse, otc: otc, err: err };
}

// 期交所：台指期（日盤／夜盤）全部月份，近月由網頁端判斷
function taifex(mt) {
  var r = UrlFetchApp.fetch('https://mis.taifex.com.tw/futures/api/getQuoteList', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { 'User-Agent': UA },
    payload: JSON.stringify({ MarketType: mt === '1' ? '1' : '0', SymbolType: 'F', KindID: '1', CID: 'TXF', ExpireMonth: '',
      RowSize: '全部', PageNo: '', SortColumn: '', AscDesc: 'A' }),
  });
  var q = (JSON.parse(r.getContentText()).RtData || {}).QuoteList || [];
  return { rows: q.filter(function (x) { return /-(F|M)$/.test(x.SymbolID); }).map(function (x) {
    return { id: x.SymbolID, p: x.CLastPrice, chg: x.CDiff, o: x.COpenPrice, h: x.CHighPrice, l: x.CLowPrice, v: x.CTotalVolume, d: x.CDate, t: x.CTime };
  }) };
}

// Yahoo Finance：最多 40 個代號，同時查詢
function yahoo(s) {
  if (!s || !/^[\^A-Za-z0-9.=,\-]+$/.test(s)) return { error: 'bad symbols' };
  var syms = s.split(',').slice(0, 40);
  var res = UrlFetchApp.fetchAll(syms.map(function (x) {
    return { url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(x) + '?range=1d&interval=1d',
      headers: { 'User-Agent': UA }, muteHttpExceptions: true };
  }));
  var rows = {};
  res.forEach(function (r, i) {
    try {
      var m = JSON.parse(r.getContentText()).chart.result[0].meta;
      rows[syms[i]] = { p: m.regularMarketPrice, prev: m.chartPreviousClose || m.previousClose, h: m.regularMarketDayHigh,
        l: m.regularMarketDayLow, v: m.regularMarketVolume, time: m.regularMarketTime, cur: m.currency, name: m.shortName };
    } catch (err) { /* 略過 */ }
  });
  return { rows: rows };
}

// ================================================================ 定時觸發 GitHub 更新
// GitHub 內建排程常延遲或整段略過，改由 Apps Script 計時器每 10 分鐘檢查一次，到時段就呼叫 GitHub 執行更新。
// 設定：專案設定（齒輪）→ 指令碼屬性 → 新增 GITHUB_TOKEN（權杖需 AngusStock 的 Actions：讀寫）
//       然後在編輯器上方選擇函式 installTriggers → 執行（只需一次）
var REPO = '0966723050-Angus/AngusStock';
// 台北時間（週一～五）：時段開始後 10 分鐘內觸發一次；網站端另會檢查是否為開盤日、同時段是否已更新
var SLOTS = [
  { at: '13:40', inputs: { scheduled: 'true' } },  // 盤後暫定資料
  { at: '14:20', inputs: { scheduled: 'true' } },  // 備援（已更新則自動略過）
  { at: '21:30', inputs: { fund_only: 'true' } },  // 個股基本面
  { at: '22:00', inputs: { scheduled: 'true' } },  // 官方收盤資料
  { at: '22:40', inputs: { scheduled: 'true' } },  // 備援
];

function scheduledTick() {
  var now = new Date();
  var wd = Number(Utilities.formatDate(now, 'Asia/Taipei', 'u')); // 1＝週一 … 7＝週日
  if (wd > 5) return;
  var day = Utilities.formatDate(now, 'Asia/Taipei', 'yyyy-MM-dd');
  var mins = Number(Utilities.formatDate(now, 'Asia/Taipei', 'H')) * 60 + Number(Utilities.formatDate(now, 'Asia/Taipei', 'm'));
  var props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).forEach(function (k) { // 清除前幾天的觸發紀錄
    if (k.indexOf('done_') === 0 && k.indexOf('done_' + day) !== 0) props.deleteProperty(k);
  });
  SLOTS.forEach(function (s) {
    var p = s.at.split(':'), start = Number(p[0]) * 60 + Number(p[1]);
    var key = 'done_' + day + '_' + s.at;
    if (mins >= start && mins < start + 10 && !props.getProperty(key)) {
      if (dispatch_(s.inputs)) props.setProperty(key, '1');
    }
  });
}

function dispatch_(inputs) {
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) throw new Error('尚未設定指令碼屬性 GITHUB_TOKEN');
  var r = UrlFetchApp.fetch('https://api.github.com/repos/' + REPO + '/actions/workflows/update.yml/dispatches', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    payload: JSON.stringify({ ref: 'main', inputs: inputs }),
  });
  if (r.getResponseCode() !== 204) console.error('GitHub 觸發失敗 ' + r.getResponseCode() + ' ' + r.getContentText());
  return r.getResponseCode() === 204;
}

// 執行一次：建立每 10 分鐘的計時器，並清除舊的同名計時器與過期紀錄
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'scheduledTick') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('scheduledTick').timeBased().everyMinutes(10).create();
  var props = PropertiesService.getScriptProperties(), all = props.getProperties();
  Object.keys(all).forEach(function (k) { if (k.indexOf('done_') === 0) props.deleteProperty(k); });
  console.log('已建立計時器：每 10 分鐘檢查一次');
}

// 測試用：立即觸發一次一般更新（會檢查是否為開盤日）
function testDispatch() {
  console.log(dispatch_({ scheduled: 'true' }) ? '觸發成功，請到 GitHub Actions 查看' : '觸發失敗，請檢查 GITHUB_TOKEN');
}
