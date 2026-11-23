"""Religa as rotas de leitura de Contratos e Comissões no portal.

O servidor perdeu `GET /api/contracts` e `GET /api/commissions` numa edição
anterior: as duas telas ficavam girando e caíam em "Não foi possível concluir a
ação". Aqui elas voltam, com os mesmos campos que o frontend (app.js) já usa.
"""
from pathlib import Path

ROTA = Path("portal_server.py")
MARCA = '        if path == "/api/contracts":'

NOVO = '''        if path == "/api/contracts":
            with connection() as db:
                user = require_contracts(db, self)
                if not user:
                    return
                payload = contracts_list_payload(db, user)
            self.send_json(payload)
            return
        if path == "/api/commissions":
            with connection() as db:
                user = require_commissions(db, self)
                if not user:
                    return
                payload = commissions_list_payload(db, user)
            self.send_json(payload)
            return
        if path == "/api/contracts/export":
            self.send_json({"error": "Use o botão Exportar da tela para baixar a planilha."}, 400)
            return
'''

FUNCOES = '''
# ── Contratos e comissões: listagens ────────────────────────────────────────
def _contracts_rows(db, seller_key=None):
    if seller_key is None:
        return db.execute("SELECT * FROM contract_companies ORDER BY lower(name)").fetchall()
    return [row for row in db.execute("SELECT * FROM contract_companies ORDER BY lower(name)")
            if contract_key(row["seller"]) == seller_key]


def _lives_counts(db):
    contagem = {}
    for row in db.execute(
        "SELECT company_id, COUNT(*) AS n, SUM(CASE WHEN registered = 1 THEN 1 ELSE 0 END) AS r "
        "FROM contract_lives GROUP BY company_id"
    ):
        contagem[row["company_id"]] = (row["n"] or 0, row["r"] or 0)
    return contagem


def _birthdays_month(db, mes):
    total = 0
    for row in db.execute("SELECT birth_date FROM contract_lives WHERE birth_date <> ''"):
        valor = str(row["birth_date"] or "")
        if len(valor) >= 7 and valor[5:7].isdigit() and int(valor[5:7]) == mes:
            total += 1
    return total


def contracts_list_payload(db, user):
    show_values = can_edit_contract_values(db, user)
    contagem = _lives_counts(db)
    empresas = _contracts_rows(db)
    companies = []
    for row in empresas:
        vidas, registradas = contagem.get(row["id"], (0, 0))
        companies.append(contract_company_payload(row, vidas, 0, show_values, registradas))

    total_vidas = sum(vidas for vidas, _ in contagem.values())
    cadastradas = sum(1 for row in empresas if row["registered"])
    incompletos = sum(1 for row in empresas
                      if not (row["cnpj"] and row["contact_name"] and row["phone"] and row["email"]))
    summary = {
        "companies": len(empresas),
        "companiesRegistered": cadastradas,
        "companiesPending": max(0, len(empresas) - cadastradas),
        "lives": total_vidas,
        "birthdaysMonth": _birthdays_month(db, date.today().month),
        "incomplete": incompletos,
    }
    imports = [
        {
            "id": row["id"],
            "companyId": row["company_id"],
            "companyName": row["company_name"],
            "fileName": row["file_name"],
            "userName": row["user_name"],
            "companiesCreated": row["companies_created"],
            "companiesUpdated": row["companies_updated"],
            "livesCreated": row["lives_created"],
            "livesUpdated": row["lives_updated"],
            "livesRemoved": row["lives_removed"],
            "createdAt": row["created_at"],
        }
        for row in db.execute("SELECT * FROM contract_imports ORDER BY created_at DESC LIMIT 20")
    ]
    return {
        "companies": companies,
        "summary": summary,
        "imports": imports,
        "canRegister": bool(contracts_allowed(db, user)),
        "canSeeValues": show_values,
    }


def commissions_list_payload(db, user):
    escopo = commission_scope(db, user)
    empresas = _contracts_rows(db, escopo)
    companies = []
    sellers = {}
    resumo = {"contracts": 0, "lives": 0, "revenue": 0.0, "commission": 0.0, "movements": 0,
              "companiesRegistered": 0, "companiesPending": 0}
    for row in empresas:
        item = commission_company_payload(db, row)
        companies.append(item)
        resumo["contracts"] += 1
        resumo["lives"] += item["totalLives"]
        resumo["revenue"] += item["totalRevenue"]
        resumo["commission"] += item["totalCommission"]
        resumo["movements"] += len(item["movements"])
        if item["companyRegistered"]:
            resumo["companiesRegistered"] += 1
        else:
            resumo["companiesPending"] += 1
        chave = item["seller"] or "Sem vendedor"
        vendedor = sellers.setdefault(chave, {"name": chave, "contracts": 0, "lives": 0,
                                              "revenue": 0.0, "commission": 0.0})
        vendedor["contracts"] += 1
        vendedor["lives"] += item["totalLives"]
        vendedor["revenue"] += item["totalRevenue"]
        vendedor["commission"] += item["totalCommission"]

    for vendedor in sellers.values():
        vendedor["revenue"] = round(vendedor["revenue"], 2)
        vendedor["commission"] = round(vendedor["commission"], 2)
    resumo["revenue"] = round(resumo["revenue"], 2)
    resumo["commission"] = round(resumo["commission"], 2)
    return {
        "companies": companies,
        "summary": resumo,
        "sellers": sorted(sellers.values(), key=lambda item: item["name"]),
        "rate": COMMISSION_RATE,
        "canManage": escopo is None,
        "sellerName": "" if escopo is None else user_seller_name(user),
    }


'''


def aplicar():
    texto = ROTA.read_text(encoding="utf-8")
    if MARCA in texto:
        print("rotas de contratos já estão ligadas")
        return
    alvo = '        if path == "/api/adesoes":'
    if alvo not in texto:
        raise SystemExit("não achei onde inserir as rotas")
    texto = texto.replace(alvo, NOVO + alvo, 1)
    ancora = "def require_commissions(db, handler):"
    if ancora not in texto:
        raise SystemExit("não achei onde inserir as funções")
    texto = texto.replace(ancora, FUNCOES.lstrip("\n") + ancora, 1)
    ROTA.write_text(texto, encoding="utf-8")
    print("rotas de contratos e comissões religadas")


if __name__ == "__main__":
    aplicar()
