import io
import json
import sqlite3
import unittest
import zipfile
from datetime import date

import vidas


def make_db():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript(
        """
        CREATE TABLE apuracao_runs (
            id TEXT PRIMARY KEY, competencia TEXT, competencia_label TEXT, mode TEXT, status TEXT,
            started_at TEXT, finished_at TEXT, error TEXT, total_rows INTEGER, total_empresas INTEGER,
            pagas INTEGER, file_path TEXT, created_by TEXT, timings TEXT
        );
        CREATE TABLE apuracao_rows (
            id TEXT, run_id TEXT, grupo_mae TEXT, grupo_empresa TEXT, empresa TEXT, documento TEXT,
            vidas TEXT, vencimento TEXT, valor REAL, data_pagamento TEXT, valor_recebido REAL,
            pago INTEGER, tipo_pagamento TEXT, competencia TEXT, nf TEXT, nf_url TEXT
        );
        CREATE TABLE vendas_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT, start_date TEXT, end_date TEXT, checked_at TEXT,
            fingerprint TEXT, payload TEXT
        );
        """
    )
    db.execute("INSERT INTO apuracao_runs VALUES ('nov','Novembro/2026','Novembro/2026','manual','done','2026-11-13T15:00:00+00:00','2026-11-13T15:05:00+00:00',NULL,3,3,0,NULL,NULL,NULL)")
    db.execute("INSERT INTO apuracao_runs VALUES ('out','Outubro/2026','Outubro/2026','manual','done','2026-11-11T12:52:00+00:00','2026-11-11T12:53:00+00:00',NULL,3,3,0,NULL,NULL,NULL)")
    db.execute("INSERT INTO apuracao_runs VALUES ('set','Setembro/2026','Setembro/2026','manual','done','2026-11-11T12:54:00+00:00','2026-11-11T12:55:00+00:00',NULL,1,1,0,NULL,NULL,NULL)")
    db.execute("INSERT INTO apuracao_runs VALUES ('err','Novembro/2026','Novembro/2026','auto','error','2026-11-13T16:00:00+00:00','2026-11-13T16:01:00+00:00','falha',0,0,0,NULL,NULL,NULL)")
    db.executemany(
        "INSERT INTO apuracao_rows (run_id, grupo_mae, grupo_empresa, empresa, vidas) VALUES (?,?,?,?,?)",
        [
            ("nov", "SINTEG", "SINTEG-SEAC", "2471 - EXEMPLAR SERVICOS E LIMPEZA LTDA", "100"),
            ("nov", "CARGA CCT-ACT ESP.", "SINDICATO CARGA RIO CCT", "5529 - NOGUEIRA ARAUJO", "50"),
            ("nov", "SINTEG", "SINTEG-SEAC", "9999 - EMPRESA NOVA", "10"),
            ("out", "SINTEG", "SINTEG-SEAC", "2471 - EXEMPLAR SERVICOS E LIMPEZA LTDA", "90"),
            ("out", "CARGA CCT-ACT ESP.", "SINDICATO CARGA RIO CCT", "5529 - NOGUEIRA ARAUJO", "60"),
            ("out", "SINTEG", "SINTEG-SEAC", "8888 - EMPRESA QUE SAIU", "7"),
            ("set", "SINTEG", "SINTEG-SEAC", "2471 - EXEMPLAR SERVICOS E LIMPEZA LTDA", "80"),
        ],
    )
    payload = {
        "rows": [
            {"kind": "sale", "client": "ANA MARIA", "company": "EXEMPLAR SERVICOS E LIMPEZA LTDA", "registeredAt": "03/11/2026",
             "seller": "ANA VENDEDORA", "team": "EQUIPE A", "reason": "", "plan": "", "value": "27,00", "cancelledAt": "",
             "responsible": "731940 - ANA MARIA", "batch": "8272", "signatureDate": "02/11/2026"},
            {"kind": "sale", "client": "JOAO SOUZA", "company": "Empresa Nova", "registeredAt": "04/11/2026",
             "seller": "ANA VENDEDORA", "team": "EQUIPE A", "reason": "", "plan": "", "value": "27,00", "cancelledAt": ""},
            {"kind": "cancelled", "client": "CARLOS LIMA", "company": "NOGUEIRA ARAUJO", "registeredAt": "",
             "seller": "", "team": "EQUIPE B", "reason": "RESCISAO", "plan": "CARGA", "value": "27,00", "cancelledAt": "06/11/2026"},
            {"kind": "sale", "client": "MARIA PREFEITURA", "company": "PREFEITURA DO MUNICIPIO X", "registeredAt": "05/11/2026",
             "seller": "BIA VENDEDORA", "team": "EQUIPE B", "reason": "", "plan": "", "value": "50,00", "cancelledAt": ""},
        ],
        "teams": [],
        "breakdowns": {},
    }
    db.execute(
        "INSERT INTO vendas_snapshots (start_date, end_date, checked_at, fingerprint, payload) VALUES (?,?,?,?,?)",
        ("2026-11-01", "2026-11-12", "2026-11-12T11:08:00+00:00", "x", json.dumps(payload)),
    )
    vidas.ensure_schema(db)
    return db


class Runs(unittest.TestCase):
    def test_one_done_run_per_competencia_ignoring_errors(self):
        db = make_db()
        runs = vidas.done_runs(db)
        self.assertEqual([run["label"] for run in runs], ["Novembro/2026", "Outubro/2026", "Setembro/2026"])
        self.assertEqual(runs[0]["id"], "nov")


class Attribution(unittest.TestCase):
    def test_exact_and_unique_partial_match(self):
        index = vidas.run_companies(make_db(), "nov")
        self.assertEqual(vidas.attribute("exemplar servicos e limpeza ltda", index), "EXEMPLAR SERVICOS E LIMPEZA LTDA")
        self.assertEqual(vidas.attribute("Nogueira Araujo", index), "NOGUEIRA ARAUJO")
        self.assertIsNone(vidas.attribute("EMPRESA", index))
        self.assertIsNone(vidas.attribute("PREFEITURA DO MUNICIPIO X", index))


class Overview(unittest.TestCase):
    def setUp(self):
        self.db = make_db()
        self.start, self.end = date(2026, 11, 1), date(2026, 11, 12)

    def test_totals_daily_and_comparison(self):
        data = vidas.overview(self.db, self.start, self.end)
        totals = data["totais"]
        self.assertEqual(totals["entradas"], 3)
        self.assertEqual(totals["saidas"], 1)
        self.assertEqual(totals["saldo"], 2)
        self.assertEqual(totals["naoAtribuidas"], 1)
        self.assertEqual(totals["vidasAntes"], 157)
        self.assertEqual(totals["vidasAgora"], 160)
        self.assertEqual(totals["variacao"], 3)
        self.assertEqual(totals["empresasFora"], 1)
        self.assertEqual(totals["vidasFora"], 7)
        self.assertEqual(len(data["diario"]), 12)
        self.assertEqual(data["diario"][0], {"dia": "2026-11-01", "entradas": 0, "saidas": 0, "saldo": 0, "acumulado": 0})
        self.assertEqual(data["diario"][2]["entradas"], 1)
        self.assertEqual(data["apuracao"]["atual"]["competencia"], "Novembro/2026")
        self.assertEqual(data["apuracao"]["anterior"]["competencia"], "Outubro/2026")
        self.assertEqual(data["vendedores"][0]["nome"], "ANA VENDEDORA")
        self.assertEqual(data["vendedores"][0]["entradas"], 2)

    def test_company_rows_include_new_and_unknown(self):
        data = vidas.overview(self.db, self.start, self.end)
        empresas = {row["nome"]: row for row in data["empresas"]}
        self.assertEqual(empresas["EMPRESA NOVA"]["vidasAntes"], 0)
        self.assertEqual(empresas["EMPRESA NOVA"]["vidasAgora"], 10)
        self.assertEqual(empresas["EMPRESA NOVA"]["entradas"], 1)
        self.assertEqual(empresas["PREFEITURA DO MUNICIPIO X"]["centro"], vidas.UNKNOWN)
        self.assertEqual(empresas["PREFEITURA DO MUNICIPIO X"]["entradas"], 1)

    def test_filter_by_centro_and_grupo(self):
        carga = vidas.overview(self.db, self.start, self.end, "CARGA CCT-ACT ESP.")
        self.assertEqual(carga["totais"]["entradas"], 0)
        self.assertEqual(carga["totais"]["saidas"], 1)
        self.assertEqual(carga["totais"]["vidasAntes"], 60)
        self.assertEqual(carga["totais"]["vidasAgora"], 50)

        sinteg = vidas.overview(self.db, self.start, self.end, "SINTEG", "SINTEG-SEAC")
        self.assertEqual(sinteg["totais"]["entradas"], 2)
        self.assertEqual(sinteg["totais"]["saidas"], 0)
        self.assertEqual(sinteg["totais"]["naoAtribuidas"], 0)

        unknown = vidas.overview(self.db, self.start, self.end, vidas.UNKNOWN)
        self.assertEqual(unknown["totais"]["entradas"], 1)
        self.assertEqual(unknown["totais"]["vidasAgora"], 0)

    def test_filter_lists_keep_all_cost_centers(self):
        data = vidas.overview(self.db, self.start, self.end, "SINTEG")
        self.assertIn("CARGA CCT-ACT ESP.", data["filtros"]["centros"])
        self.assertIn("SINDICATO CARGA RIO CCT", data["filtros"]["grupos"])

    def test_aggregates_and_extra_fields(self):
        data = vidas.overview(self.db, self.start, self.end)
        totals = data["totais"]
        self.assertEqual(totals["valorEntradas"], 104.0)
        self.assertEqual(totals["valorSaidas"], 27.0)
        self.assertEqual(totals["ticketMedio"], 34.67)
        self.assertEqual(totals["taxaSaida"], 0.6)
        self.assertEqual(data["diario"][2]["acumulado"], 1)
        self.assertEqual(data["diario"][-1]["acumulado"], 2)
        self.assertEqual(data["motivos"], [{"nome": "RESCISAO", "saidas": 1}])
        self.assertEqual([row["nome"] for row in data["equipes"]], ["EQUIPE A", "EQUIPE B"])
        self.assertEqual(data["equipes"][0]["saldo"], 2)
        self.assertEqual(data["grupos"][0]["nome"], "SINTEG-SEAC")
        self.assertEqual(data["grupos"][0]["vidasAgora"], 110)
        unknown = {row["nome"]: row for row in data["centros"]}[vidas.UNKNOWN]
        self.assertEqual(unknown["empresas"], 1)
        rows = vidas.movements(self.db, self.start, self.end)
        self.assertEqual(len(rows), 4)
        self.assertEqual(rows[0]["cliente"], "ANA MARIA")
        self.assertEqual(rows[0]["codigoCliente"], "731940")
        self.assertEqual(rows[0]["lote"], "8272")
        self.assertEqual(rows[0]["assinatura"], "2026-11-02")
        self.assertEqual(rows[0]["valorNum"], 27.0)
        unknown = [row for row in rows if not row["atribuida"]]
        self.assertEqual(unknown[0]["codigoEmpresa"], "")
        self.assertEqual(len(vidas.movements(self.db, self.start, self.end, "CARGA CCT-ACT ESP.")), 1)

    def test_money_parsing(self):
        self.assertEqual(vidas._money("23,70"), 23.7)
        self.assertEqual(vidas._money("1.234,56"), 1234.56)
        self.assertEqual(vidas._money("R$ 27.00"), 27.0)
        self.assertEqual(vidas._money(""), 0.0)
        self.assertEqual(vidas._money("abc"), 0.0)

    def test_report_builds_xlsx_with_every_sheet(self):
        body = vidas.report(self.db, self.start, self.end)
        self.assertTrue(body.startswith(b"PK"))
        with zipfile.ZipFile(io.BytesIO(body)) as package:
            workbook = package.read("xl/workbook.xml").decode("utf-8")
            for title in ("Resumo", "Movimentações", "Empresas", "Centros de custo", "Grupos", "Vendedores", "Equipes", "Motivos de saída", "Movimento diário"):
                self.assertIn(title, workbook)
            movements = package.read("xl/worksheets/sheet2.xml").decode("utf-8")
            self.assertIn("Código do cliente no S4E", movements)
            self.assertIn("ANA MARIA", movements)
            self.assertIn("731940", movements)
            self.assertEqual(movements.count("<row "), 5)
            resumo = package.read("xl/worksheets/sheet1.xml").decode("utf-8")
            self.assertIn("Taxa de saída sobre as vidas de antes", resumo)

    def test_filtered_report_keeps_only_scope(self):
        body = vidas.report(self.db, self.start, self.end, "CARGA CCT-ACT ESP.")
        with zipfile.ZipFile(io.BytesIO(body)) as package:
            movements = package.read("xl/worksheets/sheet2.xml").decode("utf-8")
            self.assertEqual(movements.count("<row "), 2)
            self.assertIn("CARLOS LIMA", movements)
            self.assertNotIn("ANA MARIA", movements)

    def test_without_snapshot_returns_empty_movement(self):
        db = make_db()
        db.execute("DELETE FROM vendas_snapshots")
        data = vidas.overview(db, self.start, self.end)
        self.assertIsNone(data["movimentacao"]["consultaId"])
        self.assertEqual(data["totais"]["entradas"], 0)
        self.assertEqual(len(data["diario"]), 12)


HEADER = ["USUÁRIO", "EMPRESA", "SITUAÇÃO ATUAL", "VALOR", "DATA", "NOME DA MÃE", "PARENTESCO",
          "DATA DE NASCIMENTO", "NOME RESPONSÁVEL", "VENCIMENTO", "CONTRATO", "CPF", "PLANO"]


def relatorio(rows, header=HEADER):
    grid = [["RELATÓRIO DE USUÁRIOS POR PERÍODO/SITUAÇÃO"], ["Sindicato: SINTEG"], header, *rows]
    cells = {(r, c): str(value) for r, row in enumerate(grid) for c, value in enumerate(row) if value not in ("", None)}
    return ("RELATORIOUSUARIOSPERIODOSITUACAO", cells, len(grid), len(header))


ROWS = [
    ["ANA MARIA", "EXEMPLAR SERVICOS E LIMPEZA LTDA", "ATIVO", "23,70", "01/10/2026", "MAE DA ANA",
     "TITULAR", "10/05/1990", "ANA MARIA", "10", "123456", "123.456.789-00", "AUXILIO SAÚDE"],
    ["FILHO DA ANA", "EXEMPLAR SERVICOS E LIMPEZA LTDA", "ATIVO", "8,00", "01/10/2026", "ANA MARIA",
     "FILHO", "02/02/2015", "ANA MARIA", "10", "123457", "", "AUXILIO SAÚDE"],
    ["CARLOS LIMA", "NOGUEIRA ARAUJO", "CANCELADO", "24,90", "05/10/2026", "MAE DO CARLOS",
     "TITULAR", "", "", "20", "778899", "987.654.321-00", "CARGA"],
]


class Importacao(unittest.TestCase):
    def setUp(self):
        self.db = make_db()
        vidas.ensure_schema(self.db)

    def store(self, rows=ROWS, arquivo="ativos.xlsx"):
        parsed = vidas.parse_relatorio([relatorio(rows)])
        return vidas.store_relatorio(self.db, parsed, arquivo, "admin")

    def test_parse_finds_header_and_normalizes_fields(self):
        parsed = vidas.parse_relatorio([relatorio(ROWS)])
        self.assertEqual(parsed["aba"], "RELATORIOUSUARIOSPERIODOSITUACAO")
        self.assertEqual((parsed["ativos"], parsed["cancelados"]), (2, 1))
        ana = parsed["rows"][0]
        self.assertEqual(ana["nome"], "ANA MARIA")
        self.assertEqual(ana["situacao"], "ATIVO")
        self.assertEqual(ana["cpf"], "123.456.789-00")
        self.assertEqual(ana["parentesco"], "TITULAR")
        self.assertEqual(ana["valor"], 23.7)
        self.assertEqual(ana["data"], "2026-10-01")
        self.assertEqual(ana["nascimento"], "1990-05-10")
        self.assertEqual(ana["nomeMae"], "MAE DA ANA")
        self.assertEqual(ana["responsavel"], "ANA MARIA")
        self.assertEqual(ana["vencimento"], "10")
        self.assertEqual(ana["contrato"], "123456")
        self.assertEqual(ana["centro"], "AUXILIO SAÚDE")
        self.assertEqual(ana["chave"], "12345678900|123456")

    def test_parse_rejects_unknown_sheet(self):
        with self.assertRaises(ValueError):
            vidas.parse_relatorio([("Planilha1", {(0, 0): "x"}, 1, 1)])

    def test_store_and_people_aggregate(self):
        summary = self.store()
        self.assertEqual(summary["linhas"], 3)
        data = vidas.people(self.db)
        self.assertEqual(data["totais"], {
            "pessoas": 3, "ativos": 2, "cancelados": 1, "titulares": 2, "dependentes": 1, "semCentro": 0,
        })
        self.assertEqual([row["arquivo"] for row in data["importacoes"]], ["ativos.xlsx"])
        self.assertEqual(data["importacoes"][0]["origem"], "arquivo")
        self.assertEqual(data["job"], {"running": False, "start": "", "end": "", "escopo": "", "message": "",
                                       "done": 0, "total": 0, "error": "", "startedAt": None, "finishedAt": None})
        pessoas = {row["nome"]: row for row in data["pessoas"]}
        self.assertEqual(pessoas["FILHO DA ANA"]["centro"], "SINTEG")
        self.assertEqual(pessoas["FILHO DA ANA"]["grupo"], "SINTEG-SEAC")
        self.assertEqual(pessoas["CARLOS LIMA"]["centro"], "CARGA CCT-ACT ESP.")
        self.assertEqual(pessoas["FILHO DA ANA"]["contrato"], "123457")

    def test_people_filters(self):
        self.store()
        self.assertEqual(vidas.people(self.db, busca="ana")["filtrados"], 2)
        self.assertEqual(vidas.people(self.db, situacao="ATIVO")["filtrados"], 2)
        self.assertEqual(vidas.people(self.db, parentesco="FILHO")["filtrados"], 1)
        self.assertEqual(vidas.people(self.db, centro="CARGA CCT-ACT ESP.")["filtrados"], 1)
        self.assertEqual(vidas.people(self.db, busca="98765432100")["filtrados"], 1)
        data = vidas.people(self.db, situacao="ATIVO")
        self.assertEqual(data["filtros"]["situacoes"], ["ATIVO", "CANCELADO"])
        self.assertEqual(data["aplicados"]["situacao"], "ATIVO")

    def test_reimport_replaces_same_file(self):
        self.store()
        updated = [row[:] for row in ROWS]
        updated[0][3] = "27,00"
        self.store(updated)
        data = vidas.people(self.db)
        self.assertEqual(len(data["importacoes"]), 1)
        self.assertEqual(data["totais"]["pessoas"], 3)
        ana = [row for row in data["pessoas"] if row["nome"] == "ANA MARIA"][0]
        self.assertEqual(ana["valor"], 27.0)

    def test_newer_import_wins_for_same_person(self):
        self.store()
        newer = [["ANA MARIA", "EXEMPLAR SERVICOS E LIMPEZA LTDA", "CANCELADO", "27,00", "06/10/2026",
                  "MAE DA ANA", "TITULAR", "10/05/1990", "ANA MARIA", "10", "999999", "123.456.789-00", "CARGA"]]
        self.store(newer, "inativos.xlsx")
        data = vidas.people(self.db)
        self.assertEqual(data["totais"]["pessoas"], 4)
        ana = [row for row in data["pessoas"] if row["cpf"] == "123.456.789-00"][0]
        self.assertEqual(ana["situacao"], "ATIVO")
        self.assertEqual(len(data["importacoes"]), 2)

    def test_remove_import(self):
        summary = self.store()
        self.assertTrue(vidas.remove_import(self.db, summary["id"]))
        self.assertEqual(vidas.people(self.db)["totais"]["pessoas"], 0)
        self.assertEqual(vidas.imports(self.db), [])
        self.assertFalse(vidas.remove_import(self.db, "nao-existe"))

    S4E_HEADER = ["Código", "Usuário", "Empresa", "Grupo de faturamento", "Situação atual", "Valor", "Situação",
                  "Data", "Colaborador", "Utilização 30/60/90", "E-mail", "Telefone", "Nome da Mãe", "Parentesco",
                  "Data de Nascimento", "Nome Responsável", "Vencimento", "Contrato", "CPF", "Plano", "UF",
                  "Municipio", "Bairro", "Tipo Logradouro", "Endereço", "Complemento", "Numero", "CEP"]

    def s4e_row(self, nome, empresa, contrato, cpf, situacao, centro="SINTEG", grupo=""):
        row = [""] * len(self.S4E_HEADER)
        row[0], row[1], row[2], row[3], row[4] = contrato, nome, empresa, grupo, situacao
        row[5], row[6], row[7] = "R$ 23,70", situacao, "01/10/2026"
        row[13], row[17], row[18], row[19] = "TITULAR", contrato, cpf, centro
        return row

    def test_s4e_columns_use_plano_as_centro_and_current_situation(self):
        rows = [self.s4e_row("ANA MARIA", "EXEMPLAR SERVICOS E LIMPEZA LTDA", "730129", "041.304.673-79", "ATIVO")]
        parsed = vidas.parse_relatorio([relatorio(rows, self.S4E_HEADER)])
        ana = parsed["rows"][0]
        self.assertEqual(ana["centro"], "SINTEG")
        self.assertEqual(ana["situacao"], "ATIVO")
        self.assertEqual(ana["contrato"], "730129")
        self.assertEqual(ana["cpf"], "041.304.673-79")

    def test_sync_replaces_previous_s4e_rows(self):
        first = vidas.parse_relatorio([relatorio([self.s4e_row("ANA MARIA", "EXEMPLAR SERVICOS E LIMPEZA LTDA", "730129", "041.304.673-79", "ATIVO")], self.S4E_HEADER)])
        vidas.store_relatorio(self.db, first, "S4E · 01/10/2026 a 31/10/2026", "admin", origem="s4e",
                              inicio="2026-10-01", fim="2026-10-31", escopo="all")
        second = vidas.parse_relatorio([relatorio([self.s4e_row("CARLOS LIMA", "EMPRESA FORA DA APURACAO", "730130", "987.654.321-00", "CANCELADO", "NOVA IGUACU")], self.S4E_HEADER)])
        summary = vidas.store_relatorio(self.db, second, "S4E · 01/11/2026 a 30/11/2026", "admin", origem="s4e",
                                        inicio="2026-11-01", fim="2026-11-30", escopo="ATIVO")
        data = vidas.people(self.db)
        self.assertEqual(summary["origem"], "s4e")
        self.assertEqual([row["nome"] for row in data["pessoas"]], ["CARLOS LIMA"])
        self.assertEqual(len(data["importacoes"]), 1)
        self.assertEqual(data["importacoes"][0]["escopo"], "ATIVO")
        self.assertEqual(data["importacoes"][0]["inicio"], "2026-11-01")
        self.assertEqual(data["pessoas"][0]["centro"], "NOVA IGUACU")

    def test_report_adds_people_sheet(self):
        self.store()
        body = vidas.report(self.db, date(2026, 11, 1), date(2026, 11, 12))
        with zipfile.ZipFile(io.BytesIO(body)) as package:
            workbook = package.read("xl/workbook.xml").decode("utf-8")
            self.assertIn("Pessoas (vidas)", workbook)
            sheet = package.read("xl/worksheets/sheet6.xml").decode("utf-8")
            self.assertIn("Nome da mãe", sheet)
            self.assertIn("123.456.789-00", sheet)
            self.assertIn("FILHO DA ANA", sheet)


if __name__ == "__main__":
    unittest.main(verbosity=2)
