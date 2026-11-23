"""Aplica os endpoints novos da Conferência de Adesões no portal_server.py.

Substitui os blocos antigos (que usavam require_admin, validação fake e sorteio)
pelos handlers de adesoes_conferencia. Rodar uma vez; é idempotente.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SERVER = ROOT / "portal_server.py"
text = SERVER.read_text(encoding="utf-8")

GET_NEW = '''        if path == "/api/adesoes":
            query = parse_qs(urlparse(self.path).query)
            try:
                with connection() as db:
                    user = require_user(db, self)
                    if not user:
                        return
                    resultado = adesoes_conferencia.listar(db, query)
            except ValueError as exc:
                self.send_json({"error": str(exc)}, 400)
                return
            except Exception as exc:
                print(f"Falha ao listar adesoes: {exc}", flush=True)
                self.send_json({"error": f"Nao foi possivel ler as adesoes: {str(exc)[:160]}"}, 500)
                return
            self.send_json(resultado)
            return
        if path == "/api/adesoes/exportar":
            query = parse_qs(urlparse(self.path).query)
            try:
                with connection() as db:
                    user = require_user(db, self)
                    if not user:
                        return
                    rows = adesoes_conferencia.listar(db, query, paginar=False)["registros"]
                    body = adesoes_conferencia.planilha(rows)
            except Exception as exc:
                self.send_json({"error": f"Nao foi possivel gerar a planilha: {str(exc)[:160]}"}, 500)
                return
            filename = f"conferencia-adesoes-{date.today().strftime('%Y%m%d')}.xlsx"
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Expose-Headers", "Content-Disposition")
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/adesoes/status":
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                estado = adesoes_conferencia.job_status(db)
            self.send_json(estado)
            return
'''

POST_NEW = '''        if path == "/api/adesoes/conferir":
            try:
                payload = read_json(self)
            except ValueError:
                payload = {}
            with connection() as db:
                user = require_user(db, self)
                if not user:
                    return
                try:
                    resultado = adesoes_conferencia.conferir_agora(
                        db, payload, user["display_name"] or user["username"])
                except ValueError as exc:
                    self.send_json({"error": str(exc)}, 400)
                    return
            self.send_json(resultado)
            return
        if path == "/api/adesoes/importar":
            try:
                payload = read_json(self)
            except ValueError:
                self.send_json({"error": "Envie os dados em JSON."}, 400)
                return
            conteudo = str(payload.get("arquivo") or "")
            nome = str(payload.get("nome") or "adesoes.xlsx")
            if not conteudo:
                self.send_json({"error": "Selecione a planilha de adesoes."}, 400)
                return
            if not nome.lower().endswith((".xlsx", ".xlsm")):
                self.send_json({"error": "Envie a planilha em Excel (.xlsx)."}, 400)
                return
            try:
                dados = base64.b64decode(conteudo.split(",")[-1])
            except Exception:
                self.send_json({"error": "O arquivo enviado nao pode ser lido."}, 400)
                return
            temporario = ROOT / f".adesoes-import-{uuid.uuid4().hex}.xlsx"
            temporario.write_bytes(dados)
            try:
                with connection() as db:
                    user = require_user(db, self)
                    if not user:
                        return
                    resumo = adesoes_conferencia.importar_planilha(
                        db, temporario, user["display_name"] or user["username"])
            except ValueError as exc:
                self.send_json({"error": str(exc)}, 400)
                return
            except Exception as exc:
                self.send_json({"error": f"Nao foi possivel ler a planilha: {str(exc)[:160]}"}, 500)
                return
            finally:
                try:
                    temporario.unlink()
                except OSError:
                    pass
            self.send_json({"ok": True, "resumo": resumo})
            return
'''


def replace_block(text, start_marker, end_marker, new_text, label):
    start = text.find(start_marker)
    if start < 0:
        raise SystemExit(f"nao achei inicio do bloco {label}")
    end = text.find(end_marker, start)
    if end < 0:
        raise SystemExit(f"nao achei fim do bloco {label}")
    return text[:start] + new_text + text[end:]


# GET: do primeiro "if path == \"/api/adesoes\":" ate o "if path == \"/adesoes\"" (HTML)
first = text.find('        if path == "/api/adesoes":\n            query = parse_qs')
if first < 0:
    raise SystemExit("bloco GET /api/adesoes nao encontrado")
html_marker = '        if path == "/adesoes" or path.startswith("/adesoes?"):'
html_at = text.find(html_marker, first)
if html_at < 0:
    raise SystemExit("endpoint /adesoes (HTML) nao encontrado")
text = text[:first] + GET_NEW + text[html_at:]

# POST: do "if path == \"/api/adesoes\":" (segundo, dentro do do_POST) ate "if path == \"/api/cobranca/clear\":"
post_start = text.find('        if path == "/api/adesoes":\n            try:\n                payload = read_json(self)')
if post_start < 0:
    raise SystemExit("bloco POST /api/adesoes nao encontrado")
clear_marker = '        if path == "/api/cobranca/clear":'
clear_at = text.find(clear_marker, post_start)
if clear_at < 0:
    raise SystemExit("endpoint /api/cobranca/clear nao encontrado")
text = text[:post_start] + POST_NEW + text[clear_at:]

SERVER.write_text(text, encoding="utf-8")
print("portal_server.py atualizado")
