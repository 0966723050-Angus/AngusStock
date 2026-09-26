"""台指期近月：日盤（TXF1）與夜盤（TXF1N）分開，漲跌依期交所算法（與前一結算價比較）。

日期：
  日盤：交易日期（8:45～13:45）。
  夜盤：以「夜盤開始的日期」表示，例如 9/24 夜盤 = 9/24 15:00 ～ 9/25 05:00。
        （期交所下載檔將夜盤列在下一個交易日，這裡換算回開始日期；即時行情的 CDate 即為開始日期）
漲跌：採用期交所公布值（日盤、夜盤皆相對於前一日盤結算價）。
近月：該交易日掛牌的月契約中到期月份最小者（結算後自動換月）。

資料來源：
  歷史：https://www.taifex.com.tw/cht/3/futDataDown（每日行情下載，查詢區間需短，這裡每次 14 天）
  最新：https://mis.taifex.com.tw/futures/api/getQuoteList（MarketType 0 日盤、1 夜盤）
快取：cache/futures/tx2.json = {"day": {日期: rec}, "night": {開始日期: rec}}，rec = [月份, 開, 高, 低, 收, 量, 漲跌]
"""
import csv
import datetime as dt
import io
import json
import re

import update_data as u

ITEMS = {"TXF1": ("台指期近月(日盤)", "day"), "TXF1N": ("台指期近月(夜盤)", "night")}
FUT = u.ROOT / "cache" / "futures"
FILE = FUT / "tx2.json"
KEEP_MONTHS = 18
MIS = "https://mis.taifex.com.tw/futures/api/getQuoteList"


def _load():
    return json.loads(FILE.read_text("utf-8")) if FILE.exists() else {"day": {}, "night": {}}


def _save(raw):
    FUT.mkdir(parents=True, exist_ok=True)
    FILE.write_text(json.dumps(raw, ensure_ascii=False, separators=(",", ":")), "utf-8")


def download(start: dt.date, end: dt.date):
    """期交所每日行情（TX）→ {交易日: {"一般"|"盤後": rec}}，只保留該日近月"""
    r = u.S.get("https://www.taifex.com.tw/cht/3/futDataDown", timeout=90, params={
        "down_type": "1", "commodity_id": "TX",
        "queryStartDate": start.strftime("%Y/%m/%d"), "queryEndDate": end.strftime("%Y/%m/%d")})
    r.encoding = "big5"
    by_date = {}
    for x in list(csv.reader(io.StringIO(r.text)))[1:]:
        if len(x) < 18:
            continue
        month = x[2].strip()
        if not re.fullmatch(r"\d{6}", month):  # 排除週契約與價差
            continue
        o, h, l, c, chg, v = (u.num(x[i]) for i in (3, 4, 5, 6, 7, 9))
        if c is None:
            continue
        sess = "一般" if "一般" in x[17] else "盤後"
        by_date.setdefault(x[0].strip().replace("/", "-"), []).append((month, sess, [month, o, h, l, c, int(v or 0), chg]))
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
    y = ref_date.year - ref_date.year % 10 + int(m.group(2))
    if y < ref_date.year - 1:
        y += 10
    return f"{y}{ord(m.group(1)) - 64:02d}"


def update():
    raw = _load()
    today = dt.datetime.now(u.TZ).date()
    full = len(raw["day"]) < 200
    start = today - dt.timedelta(days=KEEP_MONTHS * 31 if full else 21)
    trade = {}
    s = start
    while s <= today:
        e = min(today, s + dt.timedelta(days=13))
        try:
            trade.update(download(s, e))
        except Exception as ex:  # noqa: BLE001
            print(f"  ! 期貨歷史 {s}~{e} 失敗：", ex)
        u.polite()
        s = e + dt.timedelta(days=1)
    # 日盤：依交易日；夜盤：交易日 D 的盤後 → 開始日期為 D 的前一個交易日
    known = sorted(set(trade) | set(raw["day"]))
    for d, sess in trade.items():
        if "一般" in sess:
            raw["day"][d] = sess["一般"]
        if "盤後" in sess:
            prev = [x for x in known if x < d]
            if prev:
                raw["night"][prev[-1]] = sess["盤後"]
    # 最新（即時）：日盤 CDate = 交易日；夜盤 CDate = 夜盤開始日期
    for mt, key in (("0", "day"), ("1", "night")):
        q = _mis(mt)
        if not q or not q.get("CLastPrice") or not q.get("CDate"):
            continue
        d = f"{q['CDate'][:4]}-{q['CDate'][4:6]}-{q['CDate'][6:]}"
        rec = [_month_of(q["SymbolID"], dt.date.fromisoformat(d)), u.num(q["COpenPrice"]), u.num(q["CHighPrice"]),
               u.num(q["CLowPrice"]), u.num(q["CLastPrice"]), int(u.num(q["CTotalVolume"]) or 0), u.num(q["CDiff"])]
        if None in rec[1:5]:
            continue
        old = raw[key].get(d)
        if not old or old[0] == rec[0]:  # 官方下載資料與即時同契約時以最新為準
            raw[key][d] = rec
    cutoff = (today - dt.timedelta(days=KEEP_MONTHS * 31)).isoformat()
    for key in ("day", "night"):
        raw[key] = {d: v for d, v in raw[key].items() if d >= cutoff}
    _save(raw)
    print(f"  台指期近月：日盤 {len(raw['day'])} 日（最新 {max(raw['day'], default=None)}）、"
          f"夜盤 {len(raw['night'])} 日（最新 {max(raw['night'], default=None)}）")
    return raw


def series(code, raw=None):
    """日 K：[[日期, 開, 高, 低, 收, 量(口), 漲跌]]"""
    raw = raw if raw is not None else _load()
    data = raw[ITEMS[code][1]]
    return [[d, *data[d][1:6], data[d][6]] for d in sorted(data)]


def quote(code, raw=None):
    """自選股行情用：[名稱, 'fut', 成交, 漲跌, 高, 低, 量, 參考價(前一結算), 日期]"""
    rows = series(code, raw)
    if not rows:
        return None
    d, o, h, l, c, v, chg = rows[-1]
    ref = None if chg is None else round(c - chg, 2)
    return [ITEMS[code][0], "fut", c, chg, h, l, v, ref, d]
