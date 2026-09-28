"""國際股市行情：以 Yahoo Finance 報價更新 site/data/intl.enc.json。

排程：台北 21:00～05:00、08:00～14:00 每半小時（GitHub Actions，見 update.yml）；網頁可手動立即更新。
清單：site/data/intl_list.enc.json（網頁加密後經 workflow 輸入 INTL_BLOB 傳入）= {v, items: [代號...], ts}
輸出：{updated, catalog: [[代號, 名稱, 類別]...], rows: {代號: [名稱, 成交, 漲跌, 高, 低, 量, 前收, 報價時間(台北), 幣別]}}
漲跌：與前一交易日收盤比較（Yahoo chart API range=1d 的 chartPreviousClose）。
"""
import datetime as dt
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import update_data as u  # noqa: E402

LIST_FILE = u.ROOT / "site" / "data" / "intl_list.enc.json"
OUT_FILE = u.ROOT / "site" / "data" / "intl.enc.json"
API = "https://query1.finance.yahoo.com/v8/finance/chart/"

# 可加入的商品（Yahoo 代號、中文名稱、類別）；清單外的 Yahoo 代號也可自行輸入
CATALOG = [
    ("^DJI", "道瓊工業", "美國"), ("^VIX", "VIX 恐慌指數", "美國"), ("^SOX", "費城半導體", "美國"),
    ("^GSPC", "S&P 500", "美國"), ("^IXIC", "那斯達克", "美國"), ("^NDX", "那斯達克 100", "美國"),
    ("^RUT", "羅素 2000", "美國"), ("^N225", "日經 225", "亞洲"), ("^KS11", "韓國 KOSPI", "亞洲"),
    ("^TWII", "台灣加權", "亞洲"), ("^HSI", "香港恆生", "亞洲"), ("000001.SS", "上證指數", "亞洲"),
    ("399001.SZ", "深證成指", "亞洲"), ("000300.SS", "滬深 300", "亞洲"), ("^STI", "新加坡 STI", "亞洲"),
    ("^BSESN", "印度 SENSEX", "亞洲"), ("^NSEI", "印度 NIFTY 50", "亞洲"), ("^AXJO", "澳洲 S&P/ASX 200", "亞洲"),
    ("^FTSE", "英國富時 100", "歐洲"), ("^GDAXI", "德國 DAX", "歐洲"), ("^FCHI", "法國 CAC 40", "歐洲"),
    ("^STOXX50E", "歐洲 STOXX 50", "歐洲"),
    ("ES=F", "S&P 500 期貨", "期貨"), ("NQ=F", "那斯達克 100 期貨", "期貨"), ("YM=F", "道瓊期貨", "期貨"),
    ("RTY=F", "羅素 2000 期貨", "期貨"), ("CL=F", "WTI 原油", "商品"), ("BZ=F", "布蘭特原油", "商品"),
    ("GC=F", "黃金", "商品"), ("SI=F", "白銀", "商品"), ("HG=F", "銅", "商品"),
    ("^TNX", "美債 10 年殖利率", "利率"), ("DX-Y.NYB", "美元指數", "匯率"), ("TWD=X", "美元／新台幣", "匯率"),
    ("JPY=X", "美元／日圓", "匯率"), ("EURUSD=X", "歐元／美元", "匯率"), ("BTC-USD", "比特幣", "加密貨幣"),
]
NAMES = {c: n for c, n, _ in CATALOG}
DEFAULT = ["^DJI", "^VIX", "^SOX", "^GSPC", "^IXIC", "^N225", "^KS11"]


def fetch(symbol):
    r = u.S.get(API + symbol, params={"range": "1d", "interval": "1d"}, timeout=30,
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36"})
    m = r.json()["chart"]["result"][0]["meta"]
    price, prev = m.get("regularMarketPrice"), m.get("chartPreviousClose") or m.get("previousClose")
    if price is None:
        return None
    t = m.get("regularMarketTime")
    when = dt.datetime.fromtimestamp(t, u.TZ).strftime("%Y-%m-%d %H:%M") if t else None
    chg = round(price - prev, 4) if prev is not None else None
    return [NAMES.get(symbol) or m.get("shortName") or m.get("longName") or symbol, price, chg,
            m.get("regularMarketDayHigh"), m.get("regularMarketDayLow"), m.get("regularMarketVolume") or None,
            prev, when, m.get("currency")]


def main():
    key = u.data_key()
    blob = os.environ.get("INTL_BLOB", "").strip()
    if blob.startswith("{"):  # 網頁送來新的清單
        b = json.loads(blob)
        lst = u.decrypt_json(b, key)
        if not isinstance(lst.get("items"), list):
            raise ValueError("國際股市清單格式錯誤")
        u.save_json(LIST_FILE, b)
        print(f"  已儲存國際股市清單（{len(lst['items'])} 項）")
    items = DEFAULT
    if LIST_FILE.exists():
        items = u.decrypt_json(json.loads(LIST_FILE.read_text("utf-8")), key).get("items") or DEFAULT
    old = u.decrypt_json(json.loads(OUT_FILE.read_text("utf-8")), key) if OUT_FILE.exists() else {"rows": {}}
    rows = {}
    for s in items:
        try:
            q = fetch(s)
            if q:
                rows[s] = q
        except Exception as e:  # noqa: BLE001
            print(f"  ! {s} 取得失敗：", e)
            if s in old["rows"]:
                rows[s] = old["rows"][s]
        time.sleep(0.4)
    catalog = [list(x) for x in CATALOG]
    if rows == old.get("rows") and old.get("catalog") == catalog and not blob:
        print("  國際股市報價無變動，不更新檔案")
        return
    u.save_json(OUT_FILE, u.encrypt_json({"updated": dt.datetime.now(u.TZ).strftime("%Y-%m-%d %H:%M"),
                                          "catalog": catalog, "rows": rows}, key))
    print(f"  國際股市已更新：{len(rows)}／{len(items)} 項")


if __name__ == "__main__":
    main()
