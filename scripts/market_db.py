"""全市場資料庫：供「股票篩選」頁面與非自選股的技術分析使用。

快取（GitHub Actions cache，不進 git）：
  cache/market/YYYY-MM-DD.json.gz      官方每日收盤：{code: [名稱, 市場, 開, 高, 低, 收, 張數, 成交額(百萬), 漲跌]}
  cache/market/YYYY-MM-DD.mis.json.gz  盤後 13:40 由 MIS 取得的暫定收盤（官方資料公布後刪除）

輸出（部署時產生，不進 git）：
  site/data/screen.enc.json        今天／昨天日線指標＋當月月線（資料庫）
  site/data/hist/<code>.enc.json   個股近一年日 K（技術分析頁使用）

用法：
  python scripts/market_db.py --build    只由快取產生輸出檔（部署時使用，不連網）
"""
import argparse
import datetime as dt
import gzip
import json
import math
import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import update_data as u  # noqa: E402

MARKET = u.ROOT / "cache" / "market"
SCREEN_FILE = u.ROOT / "site" / "data" / "screen.enc.json"
HIST_DIR = u.ROOT / "site" / "data" / "hist"
KEEP_DAYS = 260
STOCK_RE = re.compile(r"^[1-9]\d{3}$")          # 普通股（資料庫範圍）
ANY_RE = re.compile(r"^(\d{4}|00\d{2,4}[A-Z]?)$")  # 含 ETF（月線資料）

# 資料庫欄位（今天、昨天各一組）
FIELDS = ["價格", "漲跌價", "漲跌幅", "成交張數", "成交額(百萬)", "振幅(%)",
          "5日均線", "10日均線", "20日均線", "60日均線", "100日均線",
          "MACD-快", "MACD-慢", "柱狀體(OSC)", "布林上軌", "布林中軌", "布林下軌", "布林帶寬",
          "RSI6(日)", "RSI12(日)", "K", "D", "J"]


# ---------------------------------------------------------------- 抓取
def signed_change(sign_html, diff):
    v = u.num(diff) or 0.0
    return -v if "-" in re.sub(r"<[^>]+>", "", sign_html or "") else v


def fetch_official(day: dt.date):
    """官方每日收盤（上市＋上櫃）；任一市場尚未公布則回傳 None"""
    ymd, slash = day.strftime("%Y%m%d"), day.strftime("%Y/%m/%d")
    out = {}
    j = u.get_json("https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX", {"date": ymd, "type": "ALLBUT0999", "response": "json"})
    ok = False
    for t in (j or {}).get("tables", []):
        if t.get("fields") and t["fields"][0] == "證券代號" and t.get("data") and (j.get("date") == ymd):
            ok = True
            for r in t["data"]:
                c = r[0].strip()
                if ANY_RE.match(c) and u.num(r[8]) is not None:
                    out[c] = [r[1].strip(), "tse", u.num(r[5]), u.num(r[6]), u.num(r[7]), u.num(r[8]),
                              round((u.num(r[2]) or 0) / 1000), round((u.num(r[4]) or 0) / 1e6, 2), signed_change(r[9], r[10])]
    if not ok:
        return None
    u.polite()
    j = u.get_json("https://www.tpex.org.tw/www/zh-tw/afterTrading/otc", {"date": slash, "type": "EW", "response": "json"})
    try:
        t = j["tables"][0]
        if u.roc_to_iso(t["date"]) != day.isoformat() or not t["data"]:
            return None
        for r in t["data"]:
            c = r[0].strip()
            if ANY_RE.match(c) and u.num(r[2]) is not None:
                out[c] = [r[1].strip(), "otc", u.num(r[4]), u.num(r[5]), u.num(r[6]), u.num(r[2]),
                          round((u.num(r[7]) or 0) / 1000), round((u.num(r[8]) or 0) / 1e6, 2), u.num(r[3]) or 0.0]
    except Exception:  # noqa: BLE001
        return None
    u.polite()
    return out


def fetch_mis_snapshot(day: dt.date, ref: dict):
    """盤後暫定收盤：以 MIS 批次查詢全部股票（ref 提供代號與市場）"""
    codes = [(c, v[1]) for c, v in ref.items() if STOCK_RE.match(c)]
    out = {}
    for i in range(0, len(codes), 50):
        chunk = codes[i:i + 50]
        j = u.get_json("https://mis.twse.com.tw/stock/api/getStockInfo.jsp",
                       {"ex_ch": "|".join(f"{m}_{c}.tw" for c, m in chunk), "json": 1, "delay": 0})
        u.time.sleep(1.2)
        for m in (j or {}).get("msgArray", []):
            if m.get("d") != day.strftime("%Y%m%d"):
                continue
            z, y = u.num(m.get("z")), u.num(m.get("y"))
            if z is None:
                z = u.num((m.get("b") or "").split("_")[0])
            if z is None or y is None:
                continue
            vol = int(u.num(m.get("v")) or 0)
            out[m["c"]] = [ref[m["c"]][0], m.get("ex", ref[m["c"]][1]), u.num(m.get("o")) or z, u.num(m.get("h")) or z,
                           u.num(m.get("l")) or z, z, vol, round(vol * z / 1000, 2), round(z - y, 2)]
    return out


def write_day(path: Path, rec):
    path.write_bytes(gzip.compress(json.dumps(rec, ensure_ascii=False, separators=(",", ":")).encode()))


def read_day(path: Path):
    return json.loads(gzip.decompress(path.read_bytes()))


def update(days, today: dt.date):
    """補齊最近 KEEP_DAYS 個交易日；今天若官方尚未公布，改存 MIS 暫定資料"""
    MARKET.mkdir(parents=True, exist_ok=True)
    days = sorted(set(days))[-KEEP_DAYS:]
    iso_today = today.isoformat()
    for iso in days:
        f = MARKET / f"{iso}.json.gz"
        if f.exists():
            continue
        print(f"  全市場日資料 {iso}")
        rec = fetch_official(dt.date.fromisoformat(iso))
        if rec:
            write_day(f, rec)
            (MARKET / f"{iso}.mis.json.gz").unlink(missing_ok=True)
        elif iso == iso_today:
            prev = sorted(MARKET.glob("????-??-??.json.gz"))
            if prev:
                snap = fetch_mis_snapshot(today, read_day(prev[-1]))
                if len(snap) > 500:
                    write_day(MARKET / f"{iso}.mis.json.gz", snap)
                    print(f"  今日暫定資料（MIS）{len(snap)} 檔")
    keep = set(days)
    for f in MARKET.glob("*.json.gz"):
        if f.name[:10] not in keep and f.name[:10] < min(keep):
            f.unlink()


def load_market():
    """{date: rec}，同日有官方資料時優先使用官方"""
    out = {}
    for f in sorted(MARKET.glob("*.json.gz")):
        d = f.name[:10]
        if f.name.endswith(".mis.json.gz") and (MARKET / f"{d}.json.gz").exists():
            continue
        out[d] = read_day(f)
    return out, {f.name[:10] for f in MARKET.glob("*.mis.json.gz") if not (MARKET / f"{f.name[:10]}.json.gz").exists()}


# ---------------------------------------------------------------- 指標（與技術分析頁相同公式）
def sma(a, n):
    out, s = [None] * len(a), 0.0
    for i, x in enumerate(a):
        s += x
        if i >= n:
            s -= a[i - n]
        if i >= n - 1:
            out[i] = s / n
    return out


def ema(a, n):
    k, out = 2 / (n + 1), []
    for i, x in enumerate(a):
        out.append(x if i == 0 else out[-1] + k * (x - out[-1]))
    return out


def rsi(c, n):
    out, g, l = [None] * len(c), 0.0, 0.0
    for i in range(1, len(c)):
        ch = c[i] - c[i - 1]
        up, dn = max(ch, 0), max(-ch, 0)
        if i <= n:
            g += up / n; l += dn / n
        else:
            g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n
        if i >= n:
            out[i] = 100 * g / (g + l) if g + l else 50.0
    return out


def kdj(h, l, c, n=9):
    K = D = 50.0
    ks, ds, js = [], [], []
    for i in range(len(c)):
        if i >= n - 1:
            hh, ll = max(h[i - n + 1:i + 1]), min(l[i - n + 1:i + 1])
            rsv = (c[i] - ll) / (hh - ll) * 100 if hh > ll else 50.0
            K = K * 2 / 3 + rsv / 3
            D = D * 2 / 3 + K / 3
        ks.append(K); ds.append(D); js.append(3 * K - 2 * D)
    return ks, ds, js


def indicators(rows):
    """rows：依日期排序的 [o,h,l,c,vol,value,chg]；回傳最後兩日的欄位值（FIELDS 順序）"""
    o = [r[0] for r in rows]; h = [r[1] for r in rows]; l = [r[2] for r in rows]; c = [r[3] for r in rows]
    s5, s10, s20, s60, s100 = sma(c, 5), sma(c, 10), sma(c, 20), sma(c, 60), sma(c, 100)
    e12, e26 = ema(c, 12), ema(c, 26)
    dif = [a - b for a, b in zip(e12, e26)]
    sig = ema(dif, 9)
    r6, r12 = rsi(c, 6), rsi(c, 12)
    ks, ds, js = kdj(h, l, c)

    def at(i):
        if i < 0:
            return None
        prev_c = c[i] - rows[i][6] if rows[i][6] is not None else (c[i - 1] if i > 0 else None)
        up = lo = bw = None
        if s20[i] is not None:
            sd = math.sqrt(sum((x - s20[i]) ** 2 for x in c[i - 19:i + 1]) / 20)
            up, lo = s20[i] + 2 * sd, s20[i] - 2 * sd
            bw = (up - lo) / s20[i] if s20[i] else None
        vals = [c[i], rows[i][6], (rows[i][6] / prev_c * 100) if prev_c else None, rows[i][4], rows[i][5],
                ((h[i] - l[i]) / prev_c * 100) if prev_c else None,
                s5[i], s10[i], s20[i], s60[i], s100[i], dif[i], sig[i], dif[i] - sig[i], up, s20[i], lo, bw,
                r6[i], r12[i], ks[i], ds[i], js[i]]
        return [None if v is None else round(v, 4 if isinstance(v, float) and abs(v) < 1 else 2) for v in vals]

    return at(len(rows) - 1), at(len(rows) - 2)


# ---------------------------------------------------------------- 輸出
def build(key):
    market, provisional = load_market()
    dates = sorted(market)
    if len(dates) < 2:
        print("  全市場資料不足，略過資料庫")
        return
    today, yday = dates[-1], dates[-2]
    names, series = {}, {}
    for d in dates:
        for code, r in market[d].items():
            names[code] = (r[0], r[1])
            if r[5] is not None and r[2] is not None:
                series.setdefault(code, []).append([d, r[2], r[3], r[4], r[5], r[6], r[7], r[8]])
    ym = today[:7]
    db_rows = {}
    for code, rows in series.items():
        if not STOCK_RE.match(code) or rows[-1][0] != today or len(rows) < 2:
            continue
        t, y = indicators([r[1:] for r in rows])
        month = [r for r in rows if r[0].startswith(ym)]
        mo = [month[-1][4], max(r[2] for r in month), min(r[3] for r in month)] if month else None
        db_rows[code] = {"n": names[code][0], "m": names[code][1], "t": t, "y": y, "mo": mo}
    db = {
        "updated": dt.datetime.now(u.TZ).strftime("%Y-%m-%d %H:%M"),
        "today": today, "yesterday": yday, "provisional": today in provisional,
        "month": f"{today[2:4]}M{today[5:7]}", "fields": FIELDS, "rows": db_rows,
    }
    u.save_json(SCREEN_FILE, u.encrypt_json(db, key))
    print(f"  資料庫：{len(db_rows)} 檔（今天 {today}{'，暫定' if db['provisional'] else ''}／昨天 {yday}）")

    # 個股近一年日 K（技術分析頁用）
    if HIST_DIR.exists():
        shutil.rmtree(HIST_DIR)
    HIST_DIR.mkdir(parents=True)
    n = 0
    for code, rows in series.items():
        if not STOCK_RE.match(code) or rows[-1][0] != today:
            continue
        u.save_json(HIST_DIR / f"{code}.enc.json", u.encrypt_json({
            "name": names[code][0], "market": names[code][1], "vol_unit": "張",
            "rows": [[r[0], r[1], r[2], r[3], r[4], r[5], r[7]] for r in rows]}, key))
        n += 1
    print(f"  個股日 K 檔：{n} 檔")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", action="store_true", help="只由快取產生資料庫與個股日 K 檔")
    args = ap.parse_args()
    key = u.data_key()
    if args.build:
        build(key)


if __name__ == "__main__":
    main()
