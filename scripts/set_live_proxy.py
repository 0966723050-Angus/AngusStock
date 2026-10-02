"""設定網頁即時報價使用的 Google Apps Script 中轉網址（加密後存成 site/data/live.enc.json）。

用法：python scripts/set_live_proxy.py https://script.google.com/macros/s/xxxx/exec
DATA_KEY 取自環境變數，若無則讀取 ../secrets/DATA_KEY.txt
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import update_data as u  # noqa: E402

if not os.environ.get("DATA_KEY"):
    os.environ["DATA_KEY"] = (u.ROOT.parent / "secrets" / "DATA_KEY.txt").read_text("utf-8").strip()
if len(sys.argv) != 2 or not sys.argv[1].startswith("https://script.google.com/macros/s/"):
    sys.exit(__doc__)
url = sys.argv[1].strip()
r = u.S.get(url, params={"t": "mis", "ex_ch": "tse_t00.tw"}, timeout=60)
print("測試中轉：", r.status_code, r.text[:200])
u.save_json(u.ROOT / "site" / "data" / "live.enc.json", u.encrypt_json({"url": url}, u.data_key()))
print("已產生 site/data/live.enc.json")
