"""台指期近月（TXF1）：一般＋夜盤合併的日 K 與最新報價。

期交所規則：「盤後」資料屬於下一個交易日（D 日盤後 = D-1 日 15:00 ～ D 日 05:00）。
合併日 K（交易日 D）：開＝D 日夜盤開盤、高低＝兩時段合計、收＝D 日一般時段收盤、量＝兩時段合計。
夜盤進行中時，以夜盤資料暫列下一交易日的 K 棒。
近月：該交易日掛牌的月契約中到期月份最小者（結算後自動換月）。

資料來源：
  歷史：https://www.taifex.com.tw/cht/3/futDataDown（期交所每日行情下載，可指定日期區間）
  最新：https://mis.taifex.com.tw/futures/api/getQuoteList（一般 MarketType=0、盤後 MarketType=1）
快取：cache/futures/tx.json = {日期: {"一般"|"盤後": [月份, 開, 高, 低, 收, 量]}}
"""
import csv
import datetime as dt
import io
import json
import re

import update_data as u

CODE, NAME = "TXF1", "台指期近月"
FUT = u.ROOT / "cache" / "futures"
FILE = FUT / "tx.json"
KEEP_MONTHS = 18
MIS = "https://mis.taifex.com.tw/futures/api/getQuoteList"
DAY, NIGHT = "一般", "盤後"


def _load():
    return json.loads(FILE.read_text("utf-8")) if FILE.exists() else {}


def _save(raw):
    FUT.mkdir(parents=True, exist_ok=True)
    FILE.write_text(json.dumps(raw, ensure_ascii=False, separators=(",", ":")), "utf-8")


def download(start: dt.date, end: dt.date):
    """期交所每日行情（TX）→ {日期: {時段: [月份, 開, 高, 低, 收, 量]}}，只保留每日近月"""
    r = u.S.get("https://www.taifex.com.tw/cht/3/futDataDown", timeout=90, params={
        "down_type": "1", "commodity_id": "TX",
        "queryStartDate": start.strftime("%Y/%m/%d"), "queryEndDate": end.strftime("%Y/%m/%d")})
    r.encoding = "big5"
    rows = list(csv.reader(io.StringIO(r.text)))
    by_date = {}
    for x in rows[1:]:
        if len(x) < 18:
            continue
        month = x[2].strip()
        if not re.fullmatch(r"\d{6}", month):  # 排除週契約與價差
            continue
        o, h, l, c, v = (u.num(x[i]) for i in (3, 4, 5, 6, 9))
        if c is None:
            continue
        d = x[0].strip().replace("/", "-")
        sess = DAY if "一般" in x[17] else NIGHT
        by_date.setdefault(d, []).append((month, sess, [month, o, h, l, c, int(v or 0)]))
    out = {}
    for d, items in by_date.items():
        near = min(m for m, _, _ in items)
        out[d] = {s: rec for m, s, rec in items if m == near}
    return out


def _mis(market_type):
    try:
        r = u.S.post(MIS, timeout=30, json={"MarketType": market_type, "SymbolType": "F", "KindID": "1", "CID": "TXF",
                                            "ExpireMonth": "", "RowSize": "全部", "PageNo": "", "SortColumn": "", "AscDesc": "A"})
        q = [x for x in r.json()["RtData"]["QuoteList"] if x["SymbolID"].endswith(("-F", "-M"))]
        return q[0] if q else None  # 依到期排序，第一筆即近月
    except Exception as e:  # noqa: BLE001
        print("  ! 期貨即時報價失敗：", e)
        return None


def _month_of(symbol, ref_date):
    """TXFJ6-F → 202610（J=10 月，6=年尾數）"""
    m = re.match(r"TXF([A-L])(\d)", symbol)
    if not m:
        return None
    mon = ord(m.group(1)) - 64
    y = ref_date.year - ref_date.year % 10 + int(m.group(2))
    if y < ref_date.year - 1:
        y += 10
    return f"{y}{mon:02d}"


def update():
    """補齊歷史並合併最新（含夜盤進行中）報價"""
    raw = _load()
    today = dt.datetime.now(u.TZ).date()
    start = today - dt.timedelta(days=KEEP_MONTHS * 31) if len(raw) < 200 else today - dt.timedelta(days=14)
    s = start
    while s <= today:  # 期交所查詢區間過長會回傳空白，每次下載 14 天
        e = min(today, s + dt.timedelta(days=13))
        try:
            raw.update({d: v for d, v in download(s, e).items() if v})
        except Exception as ex:  # noqa: BLE001
            print(f"  ! 期貨歷史 {s}~{e} 失敗：", ex)
        u.polite()
        s = e + dt.timedelta(days=1)
    # 最新：一般（MarketType=0）與盤後（MarketType=1），各自依 CDate 歸入所屬交易日
    for mt, sess in (("0", DAY), ("1", NIGHT)):
        q = _mis(mt)
        if not q or not q.get("CLastPrice") or not q.get("CDate"):
            continue
        d = f"{q['CDate'][:4]}-{q['CDate'][4:6]}-{q['CDate'][6:]}"
        month = _month_of(q["SymbolID"], dt.date.fromisoformat(d))
        rec = [month, u.num(q["COpenPrice"]), u.num(q["CHighPrice"]), u.num(q["CLowPrice"]), u.num(q["CLastPrice"]),
               int(u.num(q["CTotalVolume"]) or 0)]
        if None in rec[1:5]:
            continue
        day = raw.setdefault(d, {})
        # 官方下載資料優先；即時資料只補缺或更新同契約
        if sess not in day or day[sess][0] == month:
            day[sess] = rec
    cutoff = (today - dt.timedelta(days=KEEP_MONTHS * 31)).isoformat()
    raw = {d: v for d, v in raw.items() if d >= cutoff}
    _save(raw)
    print(f"  台指期近月：{len(raw)} 個交易日，最新 {max(raw) if raw else None}")
    return raw


def series(raw=None):
    """合併日 K：[[日期, 開, 高, 低, 收, 量(口), 漲跌]]"""
    raw = raw if raw is not None else _load()
    out, prev = [], None
    for d in sorted(raw):
        day, night = raw[d].get(DAY), raw[d].get(NIGHT)
        # 換月當日兩時段契約不同時，以一般時段為準
        if day and night and day[0] != night[0]:
            night = None
        parts = [p for p in (night, day) if p]
        if not parts:
            continue
        o = parts[0][1]
        h = max(p[2] for p in parts)
        l = min(p[3] for p in parts)
        c = parts[-1][4]
        v = sum(p[5] for p in parts)
        out.append([d, o, h, l, c, v, None if prev is None else round(c - prev, 2)])
        prev = c
    return out


def quote(rows=None):
    """自選股行情用：[名稱, 'fut', 成交, 漲跌, 高, 低, 量, 參考價, 日期]"""
    rows = rows if rows is not None else series()
    if not rows:
        return None
    last = rows[-1]
    prev = rows[-2][4] if len(rows) > 1 else None
    return [NAME, "fut", last[4], None if prev is None else round(last[4] - prev, 2), last[2], last[3], last[5], prev, last[0]]
