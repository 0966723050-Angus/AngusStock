"""財經新聞：重要財經新聞（鉅亨網台股、台灣總經）與自選股相關新聞（Google 新聞＋鉅亨網個股標記），最近 3 天。

排程：每小時（GitHub Actions，見 update.yml 的 news 模式）；網頁可按「立即更新新聞」。
輸出：site/data/news.enc.json
  {updated, headline: [item...], stocks: {code: [item...]}, names: {code: 名稱}}
  item = {t: 標題, u: 連結, s: 來源, ts: 發布時間（epoch 秒）, c: [相關股票代號]}
"""
import datetime as dt
import html
import json
import re
import sys
import time
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import update_data as u  # noqa: E402

OUT_FILE = u.ROOT / "site" / "data" / "news.enc.json"
DAYS = 3
PER_STOCK = 15
CNYES = "https://api.cnyes.com/media/api/v1/newslist/category/"


def cnyes(category, since, pages=15):
    """鉅亨網分類新聞（每頁最多 30 則，依時間區間逐頁取完）"""
    out = []
    for page in range(1, pages + 1):
        try:
            j = u.S.get(CNYES + category, params={"limit": 30, "page": page, "startAt": int(since), "endAt": int(time.time())},
                        timeout=30).json()
        except Exception as e:  # noqa: BLE001
            print(f"  ! 鉅亨網 {category} 失敗：", e)
            break
        data = (j.get("items") or {}).get("data") or []
        for x in data:
            if x.get("publishAt", 0) < since:
                continue
            out.append({"t": html.unescape(x.get("title", "")).strip(), "u": f"https://news.cnyes.com/news/id/{x['newsId']}",
                        "s": "鉅亨網", "ts": x["publishAt"],
                        "c": [m["code"] for m in (x.get("market") or []) if re.fullmatch(r"\d{4}", str(m.get("code", "")))]})
        if page >= ((j.get("items") or {}).get("last_page") or 1):
            break
        time.sleep(0.5)
    return out


def google(query, since, limit):
    try:
        r = u.S.get("https://news.google.com/rss/search", timeout=30,
                    params={"q": query, "hl": "zh-TW", "gl": "TW", "ceid": "TW:zh-Hant"})
        items = ET.fromstring(r.content).findall("./channel/item")
    except Exception as e:  # noqa: BLE001
        print(f"  ! Google 新聞「{query}」失敗：", e)
        return []
    out = []
    for i in items:
        try:
            ts = int(parsedate_to_datetime(i.findtext("pubDate")).timestamp())
        except Exception:  # noqa: BLE001
            continue
        if ts < since:
            continue
        src = i.find("source")
        title = html.unescape(i.findtext("title") or "").strip()
        s = src.text.strip() if src is not None and src.text else ""
        if s and title.endswith(" - " + s):  # Google 新聞標題後綴「 - 來源」
            title = title[: -len(s) - 3].strip()
        out.append({"t": title, "u": i.findtext("link"), "s": s, "ts": ts, "c": []})
        if len(out) >= limit:
            break
    return out


def dedup(items):
    seen, out = set(), []
    for x in sorted(items, key=lambda x: -x["ts"]):
        k = re.sub(r"\W", "", x["t"])[:40]
        if not x["t"] or k in seen:
            continue
        seen.add(k)
        out.append(x)
    return out


def main():
    key = u.data_key()
    since = time.time() - DAYS * 86400
    # 自選股（上市櫃股票；指數、期貨略過）
    items = u.DEFAULT_WATCH
    wf = u.ROOT / "site" / "data" / "watchlist.enc.json"
    if wf.exists():
        items = u.decrypt_json(json.loads(wf.read_text("utf-8")), key).get("items") or items
    quotes = u.decrypt_json(json.loads(u.QUOTES_FILE.read_text("utf-8")), key)["rows"] if u.QUOTES_FILE.exists() else {}
    names = {c: quotes[c][0] for c in items
             if c in quotes and c not in u.INDEX_ITEMS and quotes[c][1] in ("tse", "otc")}

    tw = cnyes("tw_stock", since)
    macro = cnyes("tw_macro", since)
    head = cnyes("headline", since)  # 頭條（含國際），只用於比對自選股標記
    headline = dedup(tw + macro)
    pool = tw + macro + head
    stocks = {}
    for code, name in names.items():
        short = re.sub(r"[*＊]|-KY$|-創$", "", name)
        g = google(f'"{short}" when:{DAYS}d', since, PER_STOCK)
        tagged = [x for x in pool if code in x["c"]]
        stocks[code] = dedup(tagged + g)[:PER_STOCK + 5]
        time.sleep(0.4)
    data = {"updated": dt.datetime.now(u.TZ).strftime("%Y-%m-%d %H:%M"), "days": DAYS,
            "headline": headline, "stocks": stocks, "names": names}
    u.save_json(OUT_FILE, u.encrypt_json(data, key))
    print(f"  財經新聞已更新：重要 {len(headline)} 則、自選股 {len(stocks)} 檔共 {sum(len(v) for v in stocks.values())} 則")


if __name__ == "__main__":
    main()
