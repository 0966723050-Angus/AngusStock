"""主力買賣超（買超前 15 名券商分點合計 − 賣超前 15 名券商分點合計，單位：張）。

資料來源：富邦 e-Broker 個股「主力進出」頁（可指定日期，免驗證碼）
  https://fubon-ebrokerdj.fbs.com.tw/z/zc/zco/zco.djhtm?a=<代號>&e=<日期>&f=<日期>

快取（Actions cache，不進 git）：cache/major/<代號>.json = {日期: 淨買賣超}
僅處理自選股：每日補當天；新加入的股票自動回補近 6 個月。
"""
import datetime as dt
import json
import re
import time

import update_data as u

MAJOR = u.ROOT / "cache" / "major"
URL = "https://fubon-ebrokerdj.fbs.com.tw/z/zc/zco/zco.djhtm"
MAX_REQUESTS = 2200  # 單次執行上限（約 14 檔 × 6 個月的首次回補）


def fetch(code, day: dt.date):
    """回傳該日主力淨買賣超（張）；資料尚未公布或非該日資料時回傳 None"""
    ds = f"{day.year}-{day.month}-{day.day}"
    for i in range(3):
        try:
            r = u.S.get(URL, params={"a": code, "e": ds, "f": ds}, timeout=30)
            r.encoding = "big5"
            t = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", r.text))
            d = re.search(r"(\d{4})/(\d{1,2})/(\d{1,2})", t)
            m = re.search(r"合計買超張數\s*([\d,\-]+)\s*合計賣超張數\s*([\d,\-]+)", t)
            if not d or not m or dt.date(*map(int, d.groups())) != day:
                return None
            buy, sell = (int(x.replace(",", "")) for x in m.groups())
            return buy - sell
        except Exception as e:  # noqa: BLE001
            print(f"  ! 主力 {code} {ds} 失敗({i + 1}): {e}")
            time.sleep(3 * (i + 1))
    return None


def update(codes, trading_days, cutoff):
    """補齊 codes 在 cutoff 之後各交易日的主力資料"""
    MAJOR.mkdir(parents=True, exist_ok=True)
    days = [d for d in trading_days if d >= cutoff]
    n = 0
    for code in codes:
        f = MAJOR / f"{code}.json"
        data = json.loads(f.read_text("utf-8")) if f.exists() else {}
        missing = [d for d in days if d not in data]
        if len(missing) > 5:
            print(f"  主力回補 {code}：{len(missing)} 日")
        for iso in reversed(missing):  # 由新到舊，確保最新資料優先
            if n >= MAX_REQUESTS:
                break
            v = fetch(code, dt.date.fromisoformat(iso))
            n += 1
            time.sleep(0.6)
            if v is not None:
                data[iso] = v
        data = {d: v for d, v in data.items() if d >= cutoff}
        f.write_text(json.dumps(data, separators=(",", ":")), "utf-8")
    print(f"  主力買賣超：{len(codes)} 檔，本次查詢 {n} 次")


def load(code):
    f = MAJOR / f"{code}.json"
    return json.loads(f.read_text("utf-8")) if f.exists() else {}
