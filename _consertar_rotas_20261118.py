"""Devolve as rotas de ação ao do_POST e recupera a cauda do do_GET.

Uma edição de 18/11 juntou o corpo do do_POST dentro do do_GET: 57 rotas POST
passaram a responder 404 (ex.: /api/retornos/sync) e 20 rotas GET foram
apagadas (ex.: /api/finance/rateios, /api/contracts/events). O do_POST ficou só
com login e adesões/conferir.

A cirurgia preserva o texto atual (inclusive as adesões de hoje): move o bloco
deslocado de volta para o do_POST e reinjeta a cauda do do_GET a partir do
último commit. Grava backup antes de tocar no arquivo.
"""

import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SERVER = ROOT / "portal_server.py"
lines = SERVER.read_text(encoding="utf-8").splitlines(keepends=True)
head = subprocess.run(
    ["git", "show", "HEAD:portal_server.py"], cwd=ROOT, capture_output=True, text=True, encoding="utf-8"
).stdout.splitlines(keepends=True)

def find(text, predicate, start=0):
    for i in range(start, len(text)):
        if predicate(text[i]):
            return i
    raise SystemExit(f"Não encontrei: {predicate}")

get_start = find(lines, lambda l: l.strip().startswith("def do_GET"))
post_start = find(lines, lambda l: l.strip().startswith("def do_POST"))
put_start = find(lines, lambda l: l.strip().startswith("def do_PUT"))
orphan_start = find(lines, lambda l: l == '        if path == "/api/agent/events":\n', get_start)
serve = find(lines, lambda l: l == "        self.serve_file(self.path)\n", orphan_start)
orphan_end = serve
assert lines[orphan_start - 1].strip() == "return", "bloco deslocado não começa depois de um return"
assert post_start > orphan_end, "ordem inesperada no arquivo"
assert lines[post_start - 2].strip() == "self.serve_file(self.path)", "fim do do_GET mudou"

head_get_start = find(head, lambda l: l == '        if path == "/adesoes" or path.startswith("/adesoes?"):\n')
head_post_start = find(head, lambda l: l.strip().startswith("def do_POST"), head_get_start)
head_get_tail = head[head_get_start:head_post_start]
assert any("self.serve_file(self.path)" in line for line in head_get_tail), "cauda do do_GET do HEAD inesperada"
assert any("def _get_announcements" in line for line in head_get_tail), "auxiliares de comunicados ausentes na cauda"

orphan = lines[orphan_start:orphan_end]
needed = ['"/api/retornos/sync"', '"/api/login"', '"/api/logout"', '"/api/adesoes/importar"']
for marker in needed:
    assert any(marker in line for line in orphan), f"rota {marker} não está no bloco deslocado"
assert sum('"/api/adesoes/conferir"' in line for line in orphan) == 1, "conferir duplicado no bloco"

new_post = [
    "    def do_POST(self):\n",
    "        path = urlparse(self.path).path\n",
    "        if deny_if_locked(self, path):\n",
    "            return\n",
] + orphan + [
    '        self.send_json({"error": "Rota não encontrada"}, 404)\n',
    "\n",
]

backup = ROOT / "backups" / "portal_server.py.quebrado-20261118"
shutil.copy2(SERVER, backup)

new_lines = lines[:orphan_start] + head_get_tail + new_post + lines[put_start:]
SERVER.write_text("".join(new_lines), encoding="utf-8")
print(f"Backup: {backup.name}")
print(f"do_GET: {orphan_start} linhas mantidas + {len(head_get_tail)} da cauda recuperada")
print(f"do_POST: {len(orphan)} linhas de ação devolvidas")
print(f"Total: {len(new_lines)} linhas (antes {len(lines)})")
