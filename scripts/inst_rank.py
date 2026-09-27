"""首頁「投信買最多」與「外資／投信一直買」（以官方每日法人買賣超計算，定義同 Goodinfo）。

來源：cache/daily/YYYY-MM-DD.json.gz（stock_info.ensure_daily 維護，近 6 個月）
      = {code: [外資, 投信, 自營商(張), 收盤, 成交量(張)]}
      發行股數：cache/fund.json（stock_info.load_fund）
輸出：site/data/instrank.enc.json
  trust：投信買超佔發行張數比例(%)：當日、2 日、3 日、5 日、10 日、1 個月、3 個月、半年，外加投信連續買超日數（篩選用）
  sync ：外資與投信同時連續買超（皆 ≥ 2 日）：連續日數、累計張數、佔同期成交量(%)、佔發行量(%)
範圍：上市櫃普通股（有發行股數者；ETF 無發行股數資料，不列入）
"""
import datetime as dt

import update_data as u
from stock_info import months_before

OUT_FILE = u.ROOT / "site" / "data" / "instrank.enc.json"
DAYS = (1, 2, 3, 5, 10)
MONTHS = (1, 3, 6)


def streak(vals):
    """由最新一日往前連續買超（> 0）的日數"""
    n = 0
    for v in reversed(vals):
        if v is None or v <= 0:
            break
        n += 1
    return n


def compute(daily, fund, names):
    dates = sorted(daily)
    if not dates:
        return None
    last = dates[-1]
    # 日數：最近 N 個交易日；月數：由最新日期往前 N 個月
    starts = [dates[-min(n, len(dates))] for n in DAYS] + [months_before(last, m) for m in MONTHS]
    trust, sync = [], []
    for code, (name, mkt) in names.items():
        shares = (fund.get(code) or {}).get("shares")
        if not shares or code not in daily[last]:
            continue
        lots = shares / 1000  # 發行張數
        f = [(daily[d].get(code) or [None] * 5) for d in dates]
        tv = [r[1] for r in f]
        sums = []
        for s in starts:  # 由起始日（含）累計至最新一日
            tot = sum(v or 0 for d, v in zip(dates, tv) if d >= s)
            sums.append(round(tot / lots * 100, 2) + 0.0)  # + 0.0：避免 -0.0
        ts = streak(tv)
        if any(sums) or ts:
            trust.append([code, name, *sums, ts])
        fs = streak([r[0] for r in f])
        if fs >= 2 and ts >= 2:
            row = [code, name]
            for n, col in ((fs, 0), (ts, 1)):
                seg = f[-n:]
                net = sum(r[col] for r in seg)
                vol = sum(r[4] or 0 for r in seg)
                row += [n, net, round(net / vol * 100, 2) if vol else None, round(net / lots * 100, 2) + 0.0]
            sync.append(row)
    trust.sort(key=lambda r: -r[9])  # 依半年排序
    sync.sort(key=lambda r: r[0])
    return {"date": last, "trust": trust, "sync": sync}


def build(key, daily, fund, quote_rows):
    names = {c: (q[0], q[1]) for c, q in quote_rows.items()
             if len(c) == 4 and c[0] != "0" and q[1] in ("tse", "otc") and not str(q[0]).endswith("-DR")}
    data = compute(daily, fund, names)
    if not data:
        return
    data["updated"] = dt.datetime.now(u.TZ).strftime("%Y-%m-%d %H:%M")
    u.save_json(OUT_FILE, u.encrypt_json(data, key))
    print(f"  投信買最多 {len(data['trust'])} 檔、外資投信一直買 {len(data['sync'])} 檔（資料日 {data['date']}）")
