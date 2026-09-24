"""設定網頁「立即更新」按鈕使用的 GitHub 權杖（加密後存成 site/data/dispatch.enc.json）。

權杖請使用 Fine-grained personal access token：
  Repository access：Only select repositories → AngusStock
  Permissions：Actions → Read and write（其餘不需要）

用法（權杖以隱藏輸入方式貼上，不會顯示在畫面）：
  python scripts/set_dispatch_token.py          （終端機隱藏輸入）
  python scripts/set_dispatch_token.py --gui    （跳出視窗貼上）
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


def ask_token_gui():
    """跳出視窗讓使用者貼上權杖（輸入以 * 顯示）"""
    import tkinter as tk

    result = {"token": ""}
    root = tk.Tk()
    root.title("AngusStock - 設定更新權杖")
    root.attributes("-topmost", True)
    root.resizable(False, False)
    frm = tk.Frame(root, padx=20, pady=16)
    frm.pack()
    tk.Label(frm, text="請貼上 GitHub 權杖（github_pat_ 開頭）", font=("Microsoft JhengHei", 11)).pack(anchor="w")
    tk.Label(frm, text="點一下輸入框，按 Ctrl + V 貼上，再按「確定」", fg="#666",
             font=("Microsoft JhengHei", 9)).pack(anchor="w", pady=(2, 8))
    ent = tk.Entry(frm, show="*", width=48, font=("Consolas", 11))
    ent.pack(fill="x")
    ent.focus_force()

    def ok(_=None):
        result["token"] = ent.get().strip()
        root.destroy()

    btns = tk.Frame(frm, pady=12)
    btns.pack(fill="x")
    tk.Button(btns, text="確定", width=10, command=ok).pack(side="right")
    tk.Button(btns, text="取消", width=10, command=root.destroy).pack(side="right", padx=8)
    root.bind("<Return>", ok)
    root.eval("tk::PlaceWindow . center")
    root.mainloop()
    return result["token"]


def show_message(msg, error=False):
    try:
        import tkinter as tk
        from tkinter import messagebox
        r = tk.Tk()
        r.withdraw()
        r.attributes("-topmost", True)
        (messagebox.showerror if error else messagebox.showinfo)("AngusStock", msg)
        r.destroy()
    except Exception:  # noqa: BLE001
        pass


def main():
    if not os.environ.get("DATA_KEY"):
        key_file = u.ROOT.parent / "secrets" / "DATA_KEY.txt"
        if not key_file.exists():
            sys.exit(f"找不到 DATA_KEY（環境變數或 {key_file}）")
        os.environ["DATA_KEY"] = key_file.read_text().strip()
    key = u.data_key()

    if sys.stdin and sys.stdin.isatty() and "--gui" not in sys.argv:
        token = getpass.getpass("請貼上 GitHub 權杖（輸入不會顯示）：").strip()
    else:
        token = ask_token_gui()
    if not token:
        sys.exit("未輸入權杖")

    r = requests.get(f"https://api.github.com/repos/{REPO}/actions/workflows/{WORKFLOW}",
                     headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}, timeout=30)
    if r.status_code != 200:
        msg = f"權杖驗證失敗（HTTP {r.status_code}）：請確認已授權 AngusStock 的 Actions 讀寫權限"
        show_message(msg, error=True)
        sys.exit(msg)

    u.save_json(OUT, u.encrypt_json({"token": token, "repo": REPO, "workflow": WORKFLOW}, key))
    print("權杖驗證成功，已加密儲存：", OUT)
    show_message("權杖驗證成功，已加密儲存！\n請回到 Claude 告知已完成。")


if __name__ == "__main__":
    main()
