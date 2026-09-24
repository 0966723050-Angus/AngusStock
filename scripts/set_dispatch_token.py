"""設定網頁「立即更新」按鈕使用的 GitHub 權杖（加密後存成 site/data/dispatch.enc.json）。

權杖請使用 Fine-grained personal access token：
  Repository access：Only select repositories → AngusStock
  Permissions：Actions → Read and write（其餘不需要）

用法（權杖以隱藏輸入方式貼上，不會顯示在畫面）：
  python scripts/set_dispatch_token.py
DATA_KEY 取自環境變數，若無則讀取 ../secrets/DATA_KEY.txt
"""
import getpass
import json
import os
import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import update_data as u  # noqa: E402

REPO = "0966723050-Angus/AngusStock"
WORKFLOW = "update.yml"
OUT = u.ROOT / "site" / "data" / "dispatch.enc.json"


def main():
    if not os.environ.get("DATA_KEY"):
        key_file = u.ROOT.parent / "secrets" / "DATA_KEY.txt"
        if not key_file.exists():
            sys.exit(f"找不到 DATA_KEY（環境變數或 {key_file}）")
        os.environ["DATA_KEY"] = key_file.read_text().strip()
    key = u.data_key()

    token = getpass.getpass("請貼上 GitHub 權杖（輸入不會顯示）：").strip()
    if not token:
        sys.exit("未輸入權杖")

    r = requests.get(f"https://api.github.com/repos/{REPO}/actions/workflows/{WORKFLOW}",
                     headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}, timeout=30)
    if r.status_code != 200:
        sys.exit(f"權杖驗證失敗（HTTP {r.status_code}）：請確認已授權 AngusStock 的 Actions 讀寫權限")

    u.save_json(OUT, u.encrypt_json({"token": token, "repo": REPO, "workflow": WORKFLOW}, key))
    print("權杖驗證成功，已加密儲存：", OUT)


if __name__ == "__main__":
    main()
