"""抓取台股資料並產生加密的網站資料檔。

用法：
  python scripts/update_data.py            # 一般更新（非開盤日自動略過）
  python scripts/update_data.py --backfill # 回補歷史資料（首次建置用）
  python scripts/update_data.py --force    # 不檢查是否開盤，強制更新

環境變數 DATA_KEY：32 bytes 資料金鑰（base64），存放於 GitHub Secrets。
"""
import argparse
import base64
import datetime as dt
import json
import os
import re
import sys
import time
from pathlib import Path


import requests
from Crypto.Cipher import AES

TZ = dt.timezone(dt.timedelta(hours=8), "Asia/Taipei")  # 台灣無日光節約時間
ROOT = Path(__file__).resolve().parents[1]
STATE_FILE = ROOT / "state" / "history.enc.json"
OUT_FILE = ROOT / "site" / "data" / "home.enc.json"
WATCH_FILE = ROOT / "site" / "data" / "watchlist.enc.json"
QUOTES_FILE = ROOT / "site" / "data" / "quotes.enc.json"
INDEX_ITEMS = {"t00": ("加權指數", "tse"), "o00": ("櫃買指數", "otc")}
DEFAULT_WATCH = ["t00", "2330", "3105", "8150", "6182", "2409", "3481", "2313",
                 "6239", "2408", "2344", "2421", "2481"]
HISTORY_DAYS = 130  # 法人買賣超圖表保留的交易日數

S = requests.Session()
S.headers.update({"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AngusStock/1.0"})


# ---------------------------------------------------------------- 加解密
def data_key() -> bytes:
    k = os.environ.get("DATA_KEY", "").strip()
    if not k:
        sys.exit("缺少環境變數 DATA_KEY")
    key = base64.b64decode(k)
    if len(key) != 32:
        sys.exit("DATA_KEY 長度錯誤（需 32 bytes）")
    return key


def encrypt_json(obj, key: bytes) -> dict:
    iv = os.urandom(12)
    c = AES.new(key, AES.MODE_GCM, nonce=iv)
    body, tag = c.encrypt_and_digest(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode())
    ct = body + tag  # 與 WebCrypto AES-GCM 相同格式（密文 + 16 bytes tag）
    return {"v": 1, "iv": base64.b64encode(iv).decode(), "ct": base64.b64encode(ct).decode()}


def decrypt_json(blob: dict, key: bytes):
    raw = base64.b64decode(blob["ct"])
    c = AES.new(key, AES.MODE_GCM, nonce=base64.b64decode(blob["iv"]))
    pt = c.decrypt_and_verify(raw[:-16], raw[-16:])
    return json.loads(pt)


def load_state(key):
    if STATE_FILE.exists():
        return decrypt_json(json.loads(STATE_FILE.read_text("utf-8")), key)
    return {}


def save_json(path: Path, blob):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(blob, ensure_ascii=False), "utf-8")


# ---------------------------------------------------------------- 工具
def num(s):
    """'1,234.5' / '+12' / '--' -> float|None"""
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return float(s)
    s = str(s).replace(",", "").replace("+", "").strip()
    m = re.match(r"^-?\d+(\.\d+)?", s)
    return float(m.group(0)) if m else None


def roc_to_iso(s):
    """'115/09/23' 或 '2026/09/23' -> '2026-09-23'"""
    y, m, d = [int(x) for x in s.strip().split("/")]
    if y < 1911:
        y += 1911
    return f"{y:04d}-{m:02d}-{d:02d}"


def get_json(url, params=None, retries=3):
    for i in range(retries):
        try:
            r = S.get(url, params=params, timeout=30)
            r.raise_for_status()
            txt = r.text.strip()
            return json.loads(txt) if txt else None
        except Exception as e:  # noqa: BLE001
            print(f"  ! {url} {params} 失敗({i + 1}): {e}")
            time.sleep(3 * (i + 1))
    return None


def polite():
    time.sleep(2.5)  # TWSE/TPEx 有流量限制


# ---------------------------------------------------------------- 指數日資料
def fetch_tse_index_month(day: dt.date):
    j = get_json("https://www.twse.com.tw/indicesReport/MI_5MINS_HIST",
                 {"response": "json", "date": day.strftime("%Y%m%d")})
    out = {}
    if j and j.get("stat") == "OK":
        for r in j.get("data", []):
            out[roc_to_iso(r[0])] = [num(r[1]), num(r[2]), num(r[3]), num(r[4])]
    return out


def fetch_otc_index_month(day: dt.date):
    j = get_json("https://www.tpex.org.tw/www/zh-tw/indexInfo/inx",
                 {"date": day.strftime("%Y/%m/%d"), "response": "json"})
    out = {}
    try:
        for r in j["tables"][0]["data"]:
            out[roc_to_iso(r[0])] = [num(r[1]), num(r[2]), num(r[3]), num(r[4])]
    except Exception:  # noqa: BLE001
        pass
    return out


def fetch_tse_market_month(day: dt.date):
    """成交股數、成交金額、筆數"""
    j = get_json("https://www.twse.com.tw/exchangeReport/FMTQIK",
                 {"response": "json", "date": day.strftime("%Y%m%d")})
    out = {}
    if j and j.get("stat") == "OK":
        for r in j.get("data", []):
            out[roc_to_iso(r[0])] = {"vol": num(r[1]) / 1000, "val": num(r[2]) / 1e8, "cnt": num(r[3])}
    return out


def fetch_otc_market_month(day: dt.date):
    j = get_json("https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingIndex",
                 {"date": day.strftime("%Y/%m/%d"), "response": "json"})
    out = {}
    try:
        for r in j["tables"][0]["data"]:
            # 成交張數(千股), 成交金額(千元), 筆數
            out[roc_to_iso(r[0])] = {"vol": num(r[1]), "val": num(r[2]) / 1e5, "cnt": num(r[3])}
    except Exception:  # noqa: BLE001
        pass
    return out


# ---------------------------------------------------------------- 漲跌家數
def fetch_tse_breadth(day: dt.date):
    j = get_json("https://www.twse.com.tw/exchangeReport/MI_INDEX",
                 {"response": "json", "date": day.strftime("%Y%m%d"), "type": "MS"})
    if not j:
        return None
    for t in j.get("tables", []):
        if t.get("title") == "漲跌證券數合計":
            d = {r[0]: r[2] for r in t["data"]}  # 取「股票」欄

            def split(s):
                m = re.match(r"([\d,]+)\(([\d,]+)\)", s)
                return (int(num(m.group(1))), int(num(m.group(2)))) if m else (int(num(s) or 0), 0)

            up, lu = split(d.get("上漲(漲停)", "0(0)"))
            dn, ld = split(d.get("下跌(跌停)", "0(0)"))
            return {"up": up, "limit_up": lu, "flat": int(num(d.get("持平", "0")) or 0), "down": dn, "limit_down": ld}
    return None


def fetch_otc_breadth(day: dt.date):
    j = get_json("https://www.tpex.org.tw/www/zh-tw/afterTrading/highlight",
                 {"date": day.strftime("%Y/%m/%d"), "response": "json"})
    try:
        t = j["tables"][0]
        if roc_to_iso(t["date"]) != day.isoformat():
            return None
        r = dict(zip(t["fields"], t["data"][0]))
        return {"up": int(num(r["上漲家數"])), "limit_up": int(num(r["漲停家數"])), "flat": int(num(r["平盤家數"])),
                "down": int(num(r["下跌家數"])), "limit_down": int(num(r["跌停家數"]))}
    except Exception:  # noqa: BLE001
        return None


# ---------------------------------------------------------------- 盤中走勢
def fetch_mis(market: str, day: dt.date):
    """MIS 盤中每分鐘資料；market = 'TSE' | 'OTC'。回傳 (quote, series[[hhmm, close, 成交金額億]], 累計成交金額億)"""
    ch = "tse_t00.tw" if market == "TSE" else "otc_o00.tw"
    q = get_json("https://mis.twse.com.tw/stock/api/getStockInfo.jsp", {"ex_ch": ch, "json": 1, "delay": 0})
    o = get_json(f"https://mis.twse.com.tw/stock/data/mis_ohlc_{market}.txt")
    quote, series, value = None, [], None
    try:
        m = q["msgArray"][0]
        if m.get("d") == day.strftime("%Y%m%d"):
            quote = {k: num(m.get(k)) for k in ("z", "y", "o", "h", "l")}
    except Exception:  # noqa: BLE001
        pass
    try:
        if o["staticObj"]["key"].endswith(day.strftime("%Y%m%d")):
            # ohlcArray 的 s 為該分鐘成交金額（百萬元；加總即為 staticObj.tz），換算為億元
            series = [[a["ts"][:2] + ":" + a["ts"][2:4], num(a["c"]), round((num(a["s"]) or 0) / 100, 2)] for a in o["ohlcArray"]]
            value = num(o["staticObj"]["tz"]) / 1e8
    except Exception:  # noqa: BLE001
        pass
    return quote, series, value


def fetch_tse_intraday_twse(day: dt.date):
    """TWSE 每 5 秒指數 + 累積成交金額，彙整成每分鐘（成交金額：億）"""
    ymd = day.strftime("%Y%m%d")
    a = get_json("https://www.twse.com.tw/exchangeReport/MI_5MINS_INDEX", {"response": "json", "date": ymd})
    polite()
    b = get_json("https://www.twse.com.tw/exchangeReport/MI_5MINS", {"response": "json", "date": ymd})
    if not a or a.get("stat") != "OK" or not a.get("data"):
        return []
    idx = {r[0][:5]: num(r[1]) for r in a["data"]}  # 同一分鐘取最後一筆
    cum = {}
    if b and b.get("stat") == "OK":
        for r in b["data"]:
            cum[r[0][:5]] = num(r[7])  # 百萬元
    out, prev = [], 0.0
    for hm in sorted(idx):
        if hm == "09:00":
            continue
        c = cum.get(hm)
        vol = None
        if c is not None:
            vol = round((c - prev) / 100, 2)  # 百萬 -> 億
            prev = c
        out.append([hm, idx[hm], vol])
    return out


# ---------------------------------------------------------------- 三大法人
def fetch_tse_inst(day: dt.date):
    j = get_json("https://www.twse.com.tw/fund/BFI82U",
                 {"response": "json", "dayDate": day.strftime("%Y%m%d"), "type": "day"})
    if not j or j.get("stat") != "OK" or not j.get("data"):
        return None
    d = {r[0]: [num(r[1]), num(r[2]), num(r[3])] for r in j["data"]}

    def add(*names):
        return [sum(d.get(n, [0, 0, 0])[i] for n in names) / 1e8 for i in range(3)]

    return {
        "f": add("外資及陸資(不含外資自營商)", "外資自營商"),
        "t": add("投信"),
        "d": add("自營商(自行買賣)", "自營商(避險)"),
        "s": add("合計"),
    }


def fetch_otc_inst(day: dt.date):
    j = get_json("https://www.tpex.org.tw/www/zh-tw/insti/summary",
                 {"type": "Daily", "date": day.strftime("%Y/%m/%d"), "response": "json"})
    try:
        t = j["tables"][0]
        if roc_to_iso(t["date"]) != day.isoformat() or not t["data"]:
            return None
        d = {r[0].strip().replace("　", ""): [num(r[1]) / 1e8, num(r[2]) / 1e8, num(r[3]) / 1e8] for r in t["data"]}
        return {"f": d["外資及陸資合計"], "t": d["投信"], "d": d["自營商合計"], "s": d["三大法人合計*"]}
    except Exception:  # noqa: BLE001
        return None


def fetch_top(day: dt.date):
    """上市 + 上櫃個股法人買賣超（張），僅含普通股"""
    rows = {}
    j = get_json("https://www.twse.com.tw/fund/T86",
                 {"response": "json", "date": day.strftime("%Y%m%d"), "selectType": "ALLBUT0999"})
    ok_tse = bool(j and j.get("stat") == "OK" and j.get("data"))
    if ok_tse:
        for r in j["data"]:
            code = r[0].strip()
            if re.fullmatch(r"[1-9]\d{3}", code):
                rows[code] = [r[1].strip(), num(r[4]) / 1000, num(r[10]) / 1000, num(r[11]) / 1000]
    polite()
    j = get_json("https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade",
                 {"type": "Daily", "sect": "EW", "date": day.strftime("%Y/%m/%d"), "response": "json"})
    ok_otc = False
    try:
        t = j["tables"][0]
        if roc_to_iso(t["date"]) == day.isoformat() and t["data"]:
            ok_otc = True
            for r in t["data"]:
                code = r[0].strip()
                if re.fullmatch(r"[1-9]\d{3}", code):
                    rows[code] = [r[1].strip(), num(r[4]) / 1000, num(r[13]) / 1000, num(r[22]) / 1000]
    except Exception:  # noqa: BLE001
        pass
    if not (ok_tse and ok_otc):
        return None

    def rank(i, desc):
        lst = [(v[0], c, round(v[i])) for c, v in rows.items() if (v[i] > 0 if desc else v[i] < 0)]
        lst.sort(key=lambda x: x[2], reverse=desc)
        return [list(x) for x in lst[:40]]

    return {
        "date": day.isoformat(),
        "lists": {
            "f_buy": rank(1, True), "t_buy": rank(2, True), "d_buy": rank(3, True),
            "f_sell": rank(1, False), "t_sell": rank(2, False), "d_sell": rank(3, False),
        },
    }


# ---------------------------------------------------------------- 計算
def streak_text(values):
    """依序（舊->新）的買賣超，回傳 (連買賣文字, 當前連續金額)"""
    vals = [v for v in values if v is not None]
    if not vals:
        return "--", 0

    def sign(v):
        return 1 if v > 0 else (-1 if v < 0 else 0)

    runs = []  # [(sign, count, amount)]
    for v in vals:
        s = sign(v)
        if runs and runs[-1][0] == s:
            runs[-1] = (s, runs[-1][1] + 1, runs[-1][2] + v)
        else:
            runs.append((s, 1, v))
    s, n, amt = runs[-1]

    def word(s):
        return "買" if s > 0 else ("賣" if s < 0 else "平")

    cur = word(s) if n == 1 else f"{n}{word(s)}"
    if n >= 4 or len(runs) == 1:
        return (f"連{n}{word(s)}" if n > 1 else word(s)), amt
    ps, pn, _ = runs[-2]
    prev = f"連{pn}{word(ps)}" if pn > 1 else word(ps)
    return f"{prev}→{cur}", amt


def index_streak(closes):
    diffs = [b - a for a, b in zip(closes, closes[1:])]
    if not diffs:
        return ""
    last = 1 if diffs[-1] > 0 else (-1 if diffs[-1] < 0 else 0)
    if last == 0:
        return "平盤"
    n = 0
    for d in reversed(diffs):
        if (d > 0 and last > 0) or (d < 0 and last < 0):
            n += 1
        else:
            break
    w = "漲" if last > 0 else "跌"
    return f"連{n}{w}" if n > 1 else f"首日{'上漲' if last > 0 else '下跌'}"


def trading_days(state, key):
    return sorted(state.get(key, {}))


def prune(d: dict, keep: int):
    for k in sorted(d)[:-keep]:
        del d[k]


# ---------------------------------------------------------------- 主流程
def is_trading_day(day: dt.date) -> bool:
    ymd = day.strftime("%Y%m%d")
    o = get_json("https://mis.twse.com.tw/stock/data/mis_ohlc_TSE.txt")
    try:
        if o["staticObj"]["key"].endswith(ymd) and o["ohlcArray"]:
            return True
    except Exception:  # noqa: BLE001
        pass
    j = get_json("https://www.twse.com.tw/exchangeReport/MI_5MINS_INDEX", {"response": "json", "date": ymd})
    if j and j.get("stat") == "OK" and j.get("data"):
        return True
    return day.isoformat() in fetch_tse_index_month(day)


def update_index_history(state, day: dt.date, months: int):
    """更新指數與成交量值的日資料"""
    for key in ("tse_idx", "otc_idx", "tse_mkt", "otc_mkt"):
        state.setdefault(key, {})
    first = day.replace(day=1)
    months_list = []
    m = first
    for _ in range(months):
        months_list.append(m)
        m = (m - dt.timedelta(days=1)).replace(day=1)
    for m in months_list:
        ref = min(day, (m.replace(day=28) + dt.timedelta(days=4)).replace(day=1) - dt.timedelta(days=1))
        print(f"  指數月資料 {ref:%Y-%m}")
        state["tse_idx"].update(fetch_tse_index_month(ref)); polite()
        state["otc_idx"].update(fetch_otc_index_month(ref)); polite()
        state["tse_mkt"].update(fetch_tse_market_month(ref)); polite()
        state["otc_mkt"].update(fetch_otc_market_month(ref)); polite()


# ---------------------------------------------------------------- 融資融券
def fetch_tse_margin(day: dt.date):
    """上市信用交易統計：融資金額(億)、融資(張)、融券(張)"""
    j = get_json("https://www.twse.com.tw/exchangeReport/MI_MARGN",
                 {"response": "json", "date": day.strftime("%Y%m%d"), "selectType": "MS"})
    if not j or j.get("stat") != "OK":
        return None
    for t in j.get("tables", []):
        rows = {r[0]: r for r in t.get("data", [])}
        if "融資金額(仟元)" in rows:
            return {"amt": num(rows["融資金額(仟元)"][5]) / 1e5,
                    "fin": num(rows["融資(交易單位)"][5]), "short": num(rows["融券(交易單位)"][5])}
    return None


def fetch_otc_margin(day: dt.date):
    """上櫃融資融券餘額合計"""
    j = get_json("https://www.tpex.org.tw/www/zh-tw/margin/balance",
                 {"date": day.strftime("%Y/%m/%d"), "response": "json"})
    try:
        t = j["tables"][0]
        if roc_to_iso(t["date"]) != day.isoformat():
            return None
        sm = {r[1]: r for r in t["summary"]}
        lots, amt = sm["合計(張)"], sm["融資金(仟元)"]
        return {"amt": num(amt[6]) / 1e5, "fin": num(lots[6]), "short": num(lots[14])}
    except Exception:  # noqa: BLE001
        return None


def update_margin_history(state, days):
    for mkt, fn in (("tse", fetch_tse_margin), ("otc", fetch_otc_margin)):
        store = state.setdefault(f"{mkt}_margin", {})
        for iso in days:
            if iso in store:
                continue
            print(f"  {'上市' if mkt == 'tse' else '上櫃'}融資融券 {iso}")
            v = fn(dt.date.fromisoformat(iso))
            polite()
            if v:
                store[iso] = v


def margin_streak(values):
    """餘額逐日增減 → 「連增7日」「連3增→連3減」「連2減→增」"""
    diffs = [b - a for a, b in zip(values, values[1:])]
    runs = []
    for d in diffs:
        sgn = 1 if d > 0 else (-1 if d < 0 else 0)
        if runs and runs[-1][0] == sgn:
            runs[-1][1] += 1
        else:
            runs.append([sgn, 1])
    if not runs:
        return "--"
    word = {1: "增", -1: "減", 0: "平"}
    s, n = runs[-1]
    if n >= 4 or len(runs) == 1:
        return f"連{word[s]}{n}日" if n > 1 else word[s]
    ps, pn = runs[-2]
    return (f"連{pn}{word[ps]}" if pn > 1 else word[ps]) + "→" + (f"連{n}{word[s]}" if n > 1 else word[s])


def build_margin(state, mkt):
    m = state.get(f"{mkt}_margin", {})
    dates = sorted(m)[-HISTORY_DAYS:]
    if len(dates) < 2:
        return None
    cur, prev = m[dates[-1]], m[dates[-2]]

    def row(key, digits):
        chg = cur[key] - prev[key]
        return {"bal": round(cur[key], digits), "chg": round(chg, digits),
                "pct": round(chg / prev[key] * 100, 2) if prev[key] else None,
                "streak": margin_streak([m[d][key] for d in dates])}

    return {
        "date": dates[-1],
        "fin": row("amt", 2), "short": row("short", 0),
        "ratio": round(cur["short"] / cur["fin"] * 100, 2) if cur["fin"] else None,
        "ratio_chg": round(cur["short"] / cur["fin"] * 100 - prev["short"] / prev["fin"] * 100, 2) if cur["fin"] and prev["fin"] else None,
        "series": [[d, round(m[d]["amt"], 2), int(m[d]["short"]), round(m[d]["short"] / m[d]["fin"] * 100, 2) if m[d]["fin"] else None]
                   for d in dates],
    }


def update_inst_history(state, days):
    state.setdefault("tse_inst", {})
    state.setdefault("otc_inst", {})
    for iso in days:
        d = dt.date.fromisoformat(iso)
        if iso not in state["tse_inst"]:
            print(f"  上市法人 {iso}")
            v = fetch_tse_inst(d); polite()
            if v:
                state["tse_inst"][iso] = v
        if iso not in state["otc_inst"]:
            print(f"  上櫃法人 {iso}")
            v = fetch_otc_inst(d); polite()
            if v:
                state["otc_inst"][iso] = v


def build_index_card(state, mkt, day, quote, series, unit, breadth, live_value):
    idx = state[f"{mkt}_idx"]
    iso = day.isoformat()
    dates = sorted(idx)
    prev_dates = [d for d in dates if d < iso]
    prev_close = idx[prev_dates[-1]][3] if prev_dates else None
    if iso in idx:
        o, h, l, c = idx[iso]
    elif quote:
        o, h, l, c = quote["o"], quote["h"], quote["l"], quote["z"]
        prev_close = quote["y"] or prev_close
    else:
        return None
    closes = [idx[d][3] for d in prev_dates[-30:]] + [c]
    mk = state[f"{mkt}_mkt"].get(iso, {})
    value = mk.get("val", live_value)
    ref = prev_close or c

    def ch(x):
        return None if x is None or ref is None else [round(x - ref, 2), round((x - ref) / ref * 100, 2)]

    return {
        "date": iso, "close": c, "open": o, "high": h, "low": l, "prev": prev_close,
        "chg": ch(c), "high_chg": ch(h), "low_chg": ch(l),
        "streak": index_streak(closes),
        "value": value, "volume": mk.get("vol"), "count": mk.get("cnt"),
        "breadth": breadth, "series": series, "unit": unit,
    }


def build_inst(state, mkt):
    inst = state.get(f"{mkt}_inst", {})
    dates = sorted(inst)[-HISTORY_DAYS:]
    if not dates:
        return None
    last = inst[dates[-1]]
    rows = []
    for k, name in (("f", "外資"), ("t", "投信"), ("d", "自營商"), ("s", "合計")):
        txt, amt = streak_text([inst[d][k][2] for d in dates])
        b, s, n = last[k]
        rows.append({"name": name, "buy": round(b, 2), "sell": round(s, 2), "net": round(n, 2),
                     "streak": txt, "streak_amt": round(amt, 2)})
    series = [[d, round(inst[d]["f"][2], 2), round(inst[d]["t"][2], 2), round(inst[d]["d"][2], 2)] for d in dates]
    return {"date": dates[-1], "rows": rows, "series": series}


# ---------------------------------------------------------------- 自選股
def fetch_all_quotes():
    """上市 + 上櫃全部股票/ETF 最近一日收盤（OpenAPI）。回傳 {code: [名稱, 市場, 收盤, 漲跌, 最高, 最低, 張數, 昨收, 日期]}"""
    rows = {}
    ok_code = re.compile(r"^(\d{4}|00\d{2,4}[A-Z]?)$")
    j = get_json("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL") or []
    for r in j:
        code = r.get("Code", "").strip()
        if not ok_code.match(code):
            continue
        c, ch = num(r.get("ClosingPrice")), num(r.get("Change"))
        rows[code] = [r.get("Name", "").strip(), "tse", c, ch, num(r.get("HighestPrice")), num(r.get("LowestPrice")),
                      round((num(r.get("TradeVolume")) or 0) / 1000), None if c is None or ch is None else round(c - ch, 2),
                      roc_to_iso(r["Date"][:3] + "/" + r["Date"][3:5] + "/" + r["Date"][5:]) if r.get("Date") else None]
    polite()
    j = get_json("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes") or []
    for r in j:
        code = r.get("SecuritiesCompanyCode", "").strip()
        if not ok_code.match(code):
            continue
        c, ch = num(r.get("Close")), num(r.get("Change"))
        rows[code] = [r.get("CompanyName", "").strip(), "otc", c, ch, num(r.get("High")), num(r.get("Low")),
                      round((num(r.get("TradingShares")) or 0) / 1000), None if c is None or ch is None else round(c - ch, 2),
                      roc_to_iso(r["Date"][:3] + "/" + r["Date"][3:5] + "/" + r["Date"][5:]) if r.get("Date") else None]
    return rows


def fetch_mis_quotes(codes, markets):
    """MIS 最新報價（盤中/收盤）。回傳格式同 fetch_all_quotes"""
    chans = []
    for c in codes:
        if c in INDEX_ITEMS:
            chans.append(f"{INDEX_ITEMS[c][1]}_{c}.tw")
        elif markets.get(c):
            chans.append(f"{markets[c]}_{c}.tw")
    out = {}
    for i in range(0, len(chans), 40):
        j = get_json("https://mis.twse.com.tw/stock/api/getStockInfo.jsp",
                     {"ex_ch": "|".join(chans[i:i + 40]), "json": 1, "delay": 0})
        polite()
        for m in (j or {}).get("msgArray", []):
            code = m.get("c")
            y = num(m.get("y"))
            price = num(m.get("z"))
            if price is None:  # 最近一筆未成交：以買價近似
                price = num((m.get("b") or "").split("_")[0])
            if price is None or y is None:
                continue
            d = m.get("d", "")
            name = INDEX_ITEMS[code][0] if code in INDEX_ITEMS else m.get("n", "")
            vol = None if code in INDEX_ITEMS else int(num(m.get("v")) or 0)
            out[code] = [name, m.get("ex", ""), price, round(price - y, 2), num(m.get("h")), num(m.get("l")),
                         vol, y, f"{d[:4]}-{d[4:6]}-{d[6:]}" if len(d) == 8 else None]
    return out


def update_watch(key, blob_text=None, full=False):
    """更新自選股清單（若有新清單）與報價檔"""
    if blob_text:
        blob = json.loads(blob_text)
        wl = decrypt_json(blob, key)  # 驗證可解密且格式正確
        if not isinstance(wl.get("items"), list):
            raise ValueError("自選股清單格式錯誤")
        save_json(WATCH_FILE, blob)
        print(f"  已儲存自選股清單（{len(wl['items'])} 檔）")
    items = DEFAULT_WATCH
    if WATCH_FILE.exists():
        items = decrypt_json(json.loads(WATCH_FILE.read_text("utf-8")), key).get("items") or DEFAULT_WATCH
    rows = fetch_all_quotes()
    polite()
    live = fetch_mis_quotes(items, {c: v[1] for c, v in rows.items()})
    rows.update(live)
    for code, (name, _) in INDEX_ITEMS.items():  # 指數無論是否即時取得都可搜尋
        rows.setdefault(code, [name, "idx", None, None, None, None, None, None, None])
    now = dt.datetime.now(TZ)
    save_json(QUOTES_FILE, encrypt_json({"updated": now.strftime("%Y-%m-%d %H:%M"), "rows": rows}, key))
    print(f"  報價已更新：全市場 {len(rows)} 檔，自選即時 {len(live)} 檔")
    try:
        import stock_info
        days = sorted(load_state(key).get("tse_idx", {}))
        stock_info.build_stocks(key, items, rows, days, refresh_fund=full)
        stock_info.build_ohlc(key, items, rows, load_state(key))
    except Exception as e:  # noqa: BLE001  個股資訊失敗不影響其他資料
        import traceback
        traceback.print_exc()
        print("  ! 個股資訊更新失敗：", e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--date", help="指定日期 YYYY-MM-DD（測試用）")
    ap.add_argument("--watch-only", action="store_true", help="只更新自選股清單與報價")
    args = ap.parse_args()

    key = data_key()
    now = dt.datetime.now(TZ)
    day = dt.date.fromisoformat(args.date) if args.date else now.date()
    print(f"執行時間 {now:%Y-%m-%d %H:%M}，資料日 {day}")

    watch_blob = os.environ.get("WATCHLIST_BLOB", "").strip() or None
    if args.watch_only or watch_blob:
        update_watch(key, watch_blob)
        if args.watch_only:
            return

    state = load_state(key)
    # 排程備援：同一日同一時段（午盤／晚間）已成功更新過就略過
    slot = f"{day.isoformat()}-{'PM' if now.hour >= 18 else 'AM'}"
    scheduled = os.environ.get("SCHEDULED") == "true"
    if scheduled and slot in state.get("done_slots", []):
        print(f"時段 {slot} 已更新過，略過。")
        return

    if not (args.force or args.backfill) and not is_trading_day(day):
        print("今日未開盤，不更新。")
        return
    update_index_history(state, day, 7 if args.backfill else 1)
    tdays = [d for d in sorted(state["tse_idx"]) if d <= day.isoformat()]
    update_inst_history(state, tdays[-(HISTORY_DAYS if args.backfill else 5):])
    need_margin = args.backfill or len(state.get("tse_margin", {})) < 20
    update_margin_history(state, tdays[-(HISTORY_DAYS if need_margin else 5):])

    # 盤中走勢：TSE 以 TWSE 官方 5 秒資料為主，MIS 備援；OTC 使用 MIS
    tse_series, tse_unit = fetch_tse_intraday_twse(day), "億"
    polite()
    tse_quote, mis_series, tse_live_val = fetch_mis("TSE", day)
    if not tse_series:
        tse_series, tse_unit = mis_series, "億"
    otc_quote, otc_series, otc_live_val = fetch_mis("OTC", day)
    polite()
    tse_breadth = fetch_tse_breadth(day); polite()
    otc_breadth = fetch_otc_breadth(day); polite()

    home = state.get("home", {})
    tse_card = build_index_card(state, "tse", day, tse_quote, tse_series, tse_unit, tse_breadth, tse_live_val)
    otc_card = build_index_card(state, "otc", day, otc_quote, otc_series, "億", otc_breadth, otc_live_val)
    # 若盤中資料抓不到，保留前一次同日資料
    for name, card in (("tse", tse_card), ("otc", otc_card)):
        old = home.get(name)
        if card:
            if old and old.get("date") == card["date"]:
                if not card["series"]:
                    card["series"], card["unit"] = old.get("series", []), old.get("unit")
                if not card["breadth"]:
                    card["breadth"] = old.get("breadth")
            home[name] = card

    home["inst_tse"] = build_inst(state, "tse")
    home["inst_otc"] = build_inst(state, "otc")
    home["margin_tse"] = build_margin(state, "tse")
    home["margin_otc"] = build_margin(state, "otc")

    top = fetch_top(day)
    if not top and args.backfill:
        for iso in reversed(tdays[-5:]):
            top = fetch_top(dt.date.fromisoformat(iso))
            if top:
                break
    if top:
        home["top"] = top

    home["updated"] = now.strftime("%Y-%m-%d %H:%M")
    state["home"] = home

    # 全市場日資料（股票篩選資料庫、非自選股技術分析）：需約一年的交易日曆
    try:
        import market_db
        if len(state.get("tse_idx", {})) < market_db.KEEP_DAYS + 10:
            update_index_history(state, day, 14)
        mdays = [d for d in sorted(state["tse_idx"]) if d <= day.isoformat()]
        market_db.update(mdays + [day.isoformat()], day)
    except Exception as e:  # noqa: BLE001  失敗不影響其他資料
        import traceback
        traceback.print_exc()
        print("  ! 全市場日資料更新失敗：", e)

    for k in ("tse_idx", "otc_idx", "tse_mkt", "otc_mkt"):
        prune(state[k], 400)
    for k in ("tse_inst", "otc_inst", "tse_margin", "otc_margin"):
        prune(state.setdefault(k, {}), HISTORY_DAYS + 20)

    if scheduled:
        state["done_slots"] = (state.get("done_slots", []) + [slot])[-20:]
    save_json(STATE_FILE, encrypt_json(state, key))
    save_json(OUT_FILE, encrypt_json(home, key))
    print("完成：", OUT_FILE)
    if not watch_blob:
        update_watch(key, full=True)


if __name__ == "__main__":
    main()
