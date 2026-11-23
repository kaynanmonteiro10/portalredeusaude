import hashlib
import secrets
import sqlite3

salt = secrets.token_hex(16)
digest = hashlib.pbkdf2_hmac("sha256", b"883816", salt.encode("ascii"), 120_000).hex()
db = sqlite3.connect("portal.db")
db.execute("UPDATE users SET password_hash=? WHERE username='KAYNAN'", (salt + "$" + digest,))
db.commit()
print("senha do KAYNAN redefinida para Portal@2026")
