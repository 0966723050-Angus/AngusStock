"""以登入帳密包裝資料金鑰，產生 site/data/keywrap.json。

更換帳號密碼時執行（資料金鑰 DATA_KEY 不變，GitHub Secret 不需更動）：
  set DATA_KEY=...   (或 export DATA_KEY=...)
  python scripts/make_keywrap.py <帳號> <密碼>
"""
import base64
import hashlib
import json
import os
import sys
from pathlib import Path

from Crypto.Cipher import AES

ITERATIONS = 310_000
OUT = Path(__file__).resolve().parents[1] / "site" / "data" / "keywrap.json"


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    user, pwd = sys.argv[1], sys.argv[2]
    data_key = base64.b64decode(os.environ["DATA_KEY"])
    salt = os.urandom(16)
    kek = hashlib.pbkdf2_hmac("sha256", f"{user}\n{pwd}".encode(), salt, ITERATIONS, 32)
    iv = os.urandom(12)
    body, tag = AES.new(kek, AES.MODE_GCM, nonce=iv).encrypt_and_digest(data_key)
    ct = body + tag
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "v": 1, "iter": ITERATIONS,
        "salt": base64.b64encode(salt).decode(),
        "iv": base64.b64encode(iv).decode(),
        "ct": base64.b64encode(ct).decode(),
    }), "utf-8")
    print("已產生", OUT)


if __name__ == "__main__":
    main()
