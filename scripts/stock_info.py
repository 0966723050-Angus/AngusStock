"""個股資訊：基本面資料與法人買賣超歷史（供「個股資訊」頁面使用）。

快取放在 cache/（不進 git，由 GitHub Actions cache 保存）：
  cache/daily/YYYY-MM-DD.json.gz  每日全市場 [外資, 投信, 自營商(張), 收盤價, 成交量(張)]
  cache/fund.json                 全市場基本面（每日最多抓一次）
  cache/eps/<市場>_<年>_<季>.json   MOPS 歷史累計 EPS（已公布季別不會變動）
"""
import datetime as dt
import gzip
import json
import re

import update_data as u

CACHE = u.ROOT / "cache"
DAILY = CACHE / "daily"
FUND_FILE = CACHE / "fund.json"
EPS_DIR = CACHE / "eps"
STOCKS_FILE = u.ROOT / "site" / "data" / "stocks.enc.json"
CHART_DAYS = 40
CODE_RE = re.compile(r"^(\d{4}|00\d{2,4}[A-Z]?)$")
MOPS = "https://mopsov.twse.com.tw/mops/web/"


# ---------------------------------------------------------------- 工具
def cells(tr):
    return [re.sub(r"<[^>]+>|&nbsp;", "", x).strip() for x in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)]


def mops_post(path, data):
    for i in range(3):
        try:
            r = u.S.post(MOPS + path, data={"encodeURIComponent": 1, "step": 1, "firstin": 1, "off": 1, **data}, timeout=120)
            r.raise_for_status()
            r.encoding = "utf-8"
            return r.text
        except Exception as e:  # noqa: BLE001
            print(f"  ! MOPS {path} {data} 失敗({i + 1}): {e}")
            u.time.sleep(5 * (i + 1))
    return ""


def pct(a, b):
    return None if a is None or not b else round(a / b * 100, 2)


def roc(s):
    """'115/07/30' -> '2026-07-30'（保留民國顯示用原字串亦可）"""
    try:
        return u.roc_to_iso(s)
    except Exception:  # noqa: BLE001
        return None


# ---------------------------------------------------------------- 每日法人與收盤（全市場）
def fetch_daily(day: dt.date):
    """回傳 {code: [外資, 投信, 自營商, 收盤, 張數]}；任一來源尚未公布則回傳 None"""
    ymd, slash = day.strftime("%Y%m%d"), day.strftime("%Y/%m/%d")
    rec = {}
    j = u.get_json("https://www.twse.com.tw/fund/T86", {"response": "json", "date": ymd, "selectType": "ALLBUT0999"})
    if not (j and j.get("stat") == "OK" and j.get("data")):
        return None
    for r in j["data"]:
        c = r[0].strip()
        if CODE_RE.match(c):
            rec[c] = [round(u.num(r[4]) / 1000), round(u.num(r[10]) / 1000), round(u.num(r[11]) / 1000), None, None]
    u.polite()
    j = u.get_json("https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade",
                   {"type": "Daily", "sect": "EW", "date": slash, "response": "json"})
    try:
        t = j["tables"][0]
        if u.roc_to_iso(t["date"]) != day.isoformat() or not t["data"]:
            return None
        for r in t["data"]:
            c = r[0].strip()
            if CODE_RE.match(c):
                rec[c] = [round(u.num(r[4]) / 1000), round(u.num(r[13]) / 1000), round(u.num(r[22]) / 1000), None, None]
    except Exception:  # noqa: BLE001
        return None
    u.polite()
    j = u.get_json("https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX", {"date": ymd, "type": "ALLBUT0999", "response": "json"})
    for t in (j or {}).get("tables", []):
        if t.get("fields") and t["fields"][0] == "證券代號":
            for r in t["data"]:
                c = r[0].strip()
                if CODE_RE.match(c):
                    rec.setdefault(c, [0, 0, 0, None, None])[3:] = [u.num(r[8]), round((u.num(r[2]) or 0) / 1000)]
    u.polite()
    j = u.get_json("https://www.tpex.org.tw/www/zh-tw/afterTrading/otc", {"date": slash, "type": "EW", "response": "json"})
    try:
        for r in j["tables"][0]["data"]:
            c = r[0].strip()
            if CODE_RE.match(c):
                rec.setdefault(c, [0, 0, 0, None, None])[3:] = [u.num(r[2]), round((u.num(r[7]) or 0) / 1000)]
    except Exception:  # noqa: BLE001
        pass
    u.polite()
    return rec


def ensure_daily(days):
    """補齊最近 CHART_DAYS 個交易日的每日檔，並刪除過舊檔案"""
    DAILY.mkdir(parents=True, exist_ok=True)
    keep = set(days[-CHART_DAYS:])
    for iso in sorted(keep):
        f = DAILY / f"{iso}.json.gz"
        if f.exists():
            continue
        print(f"  個股每日資料 {iso}")
        rec = fetch_daily(dt.date.fromisoformat(iso))
        if rec:
            f.write_bytes(gzip.compress(json.dumps(rec, separators=(",", ":")).encode()))
    for f in DAILY.glob("*.json.gz"):
        if f.name[:10] not in keep and f.name[:10] < min(keep):
            f.unlink()


def load_daily():
    out = {}
    for f in sorted(DAILY.glob("*.json.gz")):
        out[f.name[:10]] = json.loads(gzip.decompress(f.read_bytes()))
    return out


# ---------------------------------------------------------------- EPS
def mops_eps(typek, year, season):
    """MOPS 綜合損益表：{code: 累計基本每股盈餘}（結果永久快取）"""
    f = EPS_DIR / f"{typek}_{year}_{season}.json"
    if f.exists():
        return json.loads(f.read_text("utf-8"))
    h = mops_post("ajax_t163sb04", {"isQuery": "Y", "TYPEK": typek, "year": str(year), "season": f"{season:02d}"})
    out = {}
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", h, re.S):
        c = cells(tr)
        if len(c) > 3 and re.fullmatch(r"\d{4}", c[0]):
            v = u.num(c[-1])
            if v is not None:
                out[c[0]] = v
    if out:
        EPS_DIR.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(out), "utf-8")
    u.polite()
    return out


def latest_eps():
    """OpenAPI 最新一季累計 EPS：{code: (年, 季, eps)}"""
    out = {}
    kinds = ["ci", "basi", "bd", "fh", "ins", "mim"]
    for k in kinds:
        for url, ck in ((f"https://openapi.twse.com.tw/v1/opendata/t187ap06_L_{k}", "公司代號"),
                        (f"https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap06_O_{k}", "SecuritiesCompanyCode")):
            for r in u.get_json(url) or []:
                y, s = r.get("年度") or r.get("Year"), r.get("季別") or r.get("Season")
                v = u.num(r.get("基本每股盈餘（元）"))
                if r.get(ck) and y and s and v is not None:
                    out[r[ck].strip()] = (int(y), int(s), v)
    return out


def eps_metrics(latest, markets):
    """EPS(Q)=最近一季單季；EPS(Y)=近四季合計"""
    need = {(y, s) for y, s, _ in latest.values()}
    hist = {}
    for y, s in need:
        for pair in ((y, s - 1), (y - 1, 4), (y - 1, s)):
            if pair[1] >= 1 and pair not in hist:
                hist[pair] = {**mops_eps("sii", *pair), **mops_eps("otc", *pair)}
    out = {}
    for code, (y, s, ytd) in latest.items():
        prev = hist.get((y, s - 1), {}).get(code) if s > 1 else 0.0
        q = round(ytd - prev, 2) if prev is not None else None
        if s == 4:
            y4 = ytd
        else:
            a, b = hist.get((y - 1, 4), {}).get(code), hist.get((y - 1, s), {}).get(code)
            y4 = round(ytd + a - b, 2) if a is not None and b is not None else None
        out[code] = {"eps_q": q, "eps_y": y4, "eps_period": f"{y}Q{s}"}
    return out


# ---------------------------------------------------------------- 股利
def dividends():
    """MOPS 股利分派公告：取每家公司最近一筆。{code: {...}}"""
    out = {}
    this_year = dt.date.today().year - 1911
    for year in (this_year - 1, this_year):  # 後者覆蓋前者
        for typek in ("sii", "otc"):
            h = mops_post("ajax_t108sb27", {"TYPEK": typek, "year": str(year)})
            for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", h, re.S):
                c = cells(tr)
                if len(c) < 12 or not re.fullmatch(r"\d{4}", c[0]):
                    continue
                cash = sum(u.num(x) or 0 for x in c[7:10])
                stock = sum(u.num(x) or 0 for x in c[4:6])
                key = c[10] or c[6] or c[3]
                old = out.get(c[0])
                if old and (old["_k"] or "") > (key or ""):
                    continue
                out[c[0]] = {"_k": key, "div_period": c[2], "cash": round(cash, 4) or None, "stock": round(stock, 4) or None,
                             "ex_div": c[10] or None, "ex_right": c[6] or None, "pay_date": c[11] or None}
            u.polite()
    for v in out.values():
        v.pop("_k", None)
    return out


# ---------------------------------------------------------------- 基本面（全市場）
def fetch_fund():
    T, P = "https://openapi.twse.com.tw/v1", "https://www.tpex.org.tw/openapi/v1"
    f = {}

    def put(code, **kw):
        f.setdefault(code.strip(), {}).update({k: v for k, v in kw.items() if v is not None})

    for r in u.get_json(T + "/opendata/t187ap03_L") or []:
        put(r["公司代號"], shares=u.num(r.get("已發行普通股數或TDR原股發行股數")))
    for r in u.get_json(P + "/mopsfin_t187ap03_O") or []:
        put(r["SecuritiesCompanyCode"], shares=u.num(r.get("IssueShares")))
    for url in (T + "/opendata/t187ap05_L", P + "/mopsfin_t187ap05_O"):
        for r in u.get_json(url) or []:
            put(r["公司代號"], industry=r.get("產業別"), rev_ym=r.get("資料年月"),
                rev_mom=u.num(r.get("營業收入-上月比較增減(%)")), rev_yoy=u.num(r.get("營業收入-去年同月增減(%)")))
    for r in u.get_json(T + "/exchangeReport/BWIBBU_ALL") or []:
        put(r["Code"], pe=u.num(r.get("PEratio")), pb=u.num(r.get("PBratio")))
    for r in u.get_json(P + "/tpex_mainboard_peratio_analysis") or []:
        put(r["SecuritiesCompanyCode"], pe=u.num(r.get("PriceEarningRatio")), pb=u.num(r.get("PriceBookRatio")))
    j = None
    for back in range(8):  # 取最近一個有資料的交易日
        d = dt.date.today() - dt.timedelta(days=back)
        j = u.get_json("https://www.twse.com.tw/fund/MI_QFIIS",
                       {"response": "json", "date": d.strftime("%Y%m%d"), "selectType": "ALLBUT0999"})
        if j and j.get("stat") == "OK" and j.get("data"):
            break
        u.polite()
    for r in (j or {}).get("data", []):
        put(r[0], foreign_pct=u.num(r[7]))
    for r in u.get_json(P + "/tpex_3insti_qfii") or []:
        put(r["SecuritiesCompanyCode"], foreign_pct=u.num(r.get("PercentageOfSharesOC/FMIHeld")),
            shares=f.get(r["SecuritiesCompanyCode"], {}).get("shares") or u.num(r.get("NumberOfSharesIssued")))
    # 董監持股：董事、監察人（含獨立董事）本人目前持股
    for url in (T + "/opendata/t187ap11_L", P + "/mopsfin_t187ap11_O"):
        held = {}
        for r in u.get_json(url) or []:
            t = r.get("職稱", "")
            if ("董事" in t or "監察人" in t) and "本人" in t:
                held[r["公司代號"]] = held.get(r["公司代號"], 0) + (u.num(r.get("目前持股")) or 0)
        for c, v in held.items():
            put(c, directors_shares=v)
    # 集保人數（TDCC 集保戶股權分散表，持股分級 17 = 合計）
    try:
        r = u.S.get("https://opendata.tdcc.com.tw/getOD.ashx?id=1-5", timeout=180)
        r.encoding = "utf-8-sig"
        for line in r.text.splitlines()[1:]:
            p = line.split(",")
            if len(p) >= 4 and p[2] == "17":
                put(p[1], holders=int(u.num(p[3]) or 0), holders_date=f"{p[0][:4]}-{p[0][4:6]}-{p[0][6:8]}")
    except Exception as e:  # noqa: BLE001
        print("  ! TDCC 失敗：", e)
    # EPS 與股利
    try:
        for c, v in eps_metrics(latest_eps(), None).items():
            put(c, **v)
    except Exception as e:  # noqa: BLE001
        print("  ! EPS 失敗：", e)
    try:
        for c, v in dividends().items():
            put(c, **v)
    except Exception as e:  # noqa: BLE001
        print("  ! 股利失敗：", e)
    for v in f.values():
        if v.get("shares") and v.get("directors_shares") is not None:
            v["directors_pct"] = pct(v.pop("directors_shares"), v["shares"])
    return f


def load_fund(refresh: bool):
    today = dt.date.today().isoformat()
    if FUND_FILE.exists():
        data = json.loads(FUND_FILE.read_text("utf-8"))
        if not refresh or data.get("date") == today:
            return data["rows"]
    print("  抓取個股基本面資料…")
    rows = fetch_fund()
    CACHE.mkdir(parents=True, exist_ok=True)
    FUND_FILE.write_text(json.dumps({"date": today, "rows": rows}, ensure_ascii=False), "utf-8")
    return rows


# ---------------------------------------------------------------- 輸出
def build_stocks(key, items, quote_rows, trading_days, refresh_fund):
    """產生 stocks.enc.json：自選股的個股資訊與圖表資料"""
    ensure_daily(trading_days)
    daily = load_daily()
    fund = load_fund(refresh_fund)
    dates = sorted(daily)[-CHART_DAYS:]
    out = {}
    for code in items:
        if code in u.INDEX_ITEMS:
            continue
        q = quote_rows.get(code)
        if not q:
            continue
        name, mkt, price, chg, high, low, vol, prev, qdate = q
        fd = fund.get(code, {})
        # 前一交易日成交量（量增幅用）
        prev_vol = None
        for d in reversed(dates):
            if d < (qdate or "") and code in daily[d]:
                prev_vol = daily[d][code][4]
                break
        chart = [[d, *daily[d][code][:4]] for d in dates if code in daily[d]]
        out[code] = {
            "name": name, "market": mkt, "industry": fd.get("industry"), "date": qdate,
            "price": price, "chg": chg, "chg_pct": pct(chg, prev),
            "vol": vol, "vol_chg": round((vol / prev_vol - 1) * 100, 1) if vol and prev_vol else None,
            "turnover": pct((vol or 0) * 1000, fd.get("shares")) if vol is not None else None,
            **{k: fd.get(k) for k in ("holders", "holders_date", "directors_pct", "foreign_pct", "eps_q", "eps_y",
                                      "eps_period", "pe", "pb", "rev_ym", "rev_mom", "rev_yoy", "div_period",
                                      "cash", "stock", "ex_div", "ex_right", "pay_date")},
            "chart": chart,
        }
    u.save_json(STOCKS_FILE, u.encrypt_json({"updated": dt.datetime.now(u.TZ).strftime("%Y-%m-%d %H:%M"), "stocks": out}, key))
    print(f"  個股資訊已更新：{len(out)} 檔，圖表 {len(dates)} 個交易日")


# ---------------------------------------------------------------- 技術分析：個股日 K 歷史
HIST = CACHE / "hist"
OHLC_FILE = u.ROOT / "site" / "data" / "ohlc.enc.json"
HIST_MONTHS = 14  # 顯示半年 + SMA120／52 週所需暖身資料


def fetch_month(code, market, month: dt.date):
    """單一股票單月日成交：[[日期, 開, 高, 低, 收, 張數, 漲跌]]"""
    out = []
    if market == "tse":
        j = u.get_json("https://www.twse.com.tw/exchangeReport/STOCK_DAY",
                       {"response": "json", "date": month.strftime("%Y%m01"), "stockNo": code})
        for r in (j or {}).get("data", []) if j and j.get("stat") == "OK" else []:
            o, h, l, c = (u.num(x) for x in r[3:7])
            if c is not None:
                out.append([u.roc_to_iso(r[0]), o, h, l, c, round((u.num(r[1]) or 0) / 1000), u.num(r[7].replace("X", ""))])
    else:
        j = u.get_json("https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock",
                       {"code": code, "date": month.strftime("%Y/%m/01"), "response": "json"})
        try:
            for r in j["tables"][0]["data"]:
                o, h, l, c = (u.num(x) for x in r[3:7])
                if c is not None:
                    out.append([u.roc_to_iso(r[0].replace("＊", "").strip()), o, h, l, c, round(u.num(r[1]) or 0), u.num(r[7])])
        except Exception:  # noqa: BLE001
            pass
    u.polite()
    return out


def months_back(day: dt.date, n):
    m = day.replace(day=1)
    out = []
    for _ in range(n):
        out.append(m)
        m = (m - dt.timedelta(days=1)).replace(day=1)
    return sorted(out)


def update_hist(code, market, latest_day: str):
    """維護 cache/hist/<code>.json；新股票回補 HIST_MONTHS 個月，其後只抓當月"""
    HIST.mkdir(parents=True, exist_ok=True)
    f = HIST / f"{code}.json"
    rows = json.loads(f.read_text("utf-8")) if f.exists() else []
    today = dt.date.today()
    if not rows:
        print(f"  日K回補 {code}（{HIST_MONTHS} 個月）")
        months = months_back(today, HIST_MONTHS)
    elif rows[-1][0] >= latest_day:
        return rows
    else:
        last = dt.date.fromisoformat(rows[-1][0])
        months = [m for m in months_back(today, 3) if m >= last.replace(day=1)]
    data = {r[0]: r for r in rows}
    for m in months:
        for r in fetch_month(code, market, m):
            data[r[0]] = r
    cutoff = (today - dt.timedelta(days=HIST_MONTHS * 31)).isoformat()
    rows = [data[d] for d in sorted(data) if d >= cutoff]
    f.write_text(json.dumps(rows, separators=(",", ":")), "utf-8")
    return rows


def index_hist(state, mkt):
    """指數日 K：由既有指數歷史（無漲跌欄則自行計算）"""
    idx, mk = state.get(f"{mkt}_idx", {}), state.get(f"{mkt}_mkt", {})
    rows, prev = [], None
    for d in sorted(idx):
        o, h, l, c = idx[d]
        rows.append([d, o, h, l, c, round((mk.get(d) or {}).get("val") or 0, 2), None if prev is None else round(c - prev, 2)])
        prev = c
    return rows


def build_ohlc(key, items, quote_rows, state):
    fund = json.loads(FUND_FILE.read_text("utf-8"))["rows"] if FUND_FILE.exists() else {}
    latest = max(state.get("tse_idx", {}) or [""])
    out = {}
    for code in items:
        if code in u.INDEX_ITEMS:
            name, mkt = u.INDEX_ITEMS[code]
            out[code] = {"name": name, "market": "idx", "vol_unit": "億", "rows": index_hist(state, mkt)}
            continue
        q = quote_rows.get(code)
        if not q:
            continue
        rows = update_hist(code, q[1], latest)
        out[code] = {"name": q[0], "market": q[1], "vol_unit": "張", "shares": fund.get(code, {}).get("shares"), "rows": rows}
    u.save_json(OHLC_FILE, u.encrypt_json({"updated": dt.datetime.now(u.TZ).strftime("%Y-%m-%d %H:%M"), "stocks": out}, key))
    print(f"  技術分析日K已更新：{len(out)} 檔")
