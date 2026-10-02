/**
 * AngusStock 即時報價中轉（Google Apps Script 網頁應用程式）
 *
 * 用途：網頁無法直接讀取證交所／期交所／Yahoo（瀏覽器跨網站限制），由此程式代為查詢並回傳 JSON。
 * 只允許下列三種查詢，不能當成一般用途的中轉站：
 *   ?t=mis&ex_ch=tse_2330.tw|otc_6488.tw|tse_t00.tw   證交所 MIS 即時報價（上市、上櫃、指數）
 *   ?t=tw&s=2330.TW,6488.TWO,^TWII,^TWOII                Yahoo 奇摩股市即時報價（備援；格式同 mis）
 *   ?t=ohlc&m=TSE                                       證交所 MIS 大盤盤中每分鐘走勢（TSE＝加權、OTC＝櫃買）
 *   ?t=taifex&mt=0                                      期交所台指期即時報價（0＝日盤、1＝夜盤）
 *   ?t=yahoo&s=^DJI,^SOX,GC=F                           Yahoo Finance 國際行情
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
    else if (p.t === 'taifex') out = taifex(p.mt);
    else if (p.t === 'yahoo') out = yahoo(p.s);
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

// Yahoo 奇摩股市即時報價（證交所 MIS 連線不穩時的備援）；回傳欄位與 mis 相同（v 為張數）
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
        var t = x.regularMarketTime ? new Date(new Date(x.regularMarketTime).getTime() + 8 * 3600e3).toISOString() : '';
        rows.push({ c: code, z: raw(x.price), y: raw(x.regularMarketPreviousClose), o: raw(x.regularMarketOpen), h: raw(x.regularMarketDayHigh),
          l: raw(x.regularMarketDayLow), v: x.volume ? String(Math.round(Number(x.volume) / 1000)) : null,
          d: t.slice(0, 10).replace(/-/g, ''), t: t.slice(11, 19), src: 'yahoo' });
      });
    } catch (err) { /* 略過 */ }
  });
  return { rows: rows };
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
