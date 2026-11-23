"""Testes sintéticos da conferência de adesões (sem portal.db, sem S4E ao vivo)."""
import io
import json
import sqlite3
import tempfile
import unittest
import zipfile
from pathlib import Path

import adesoes_conferencia as ad


DIA = "2026-11-03"
ADESAO = "2026-11-10"


def venda(lote, empresa, dia, vidas, valor, equipe="COMERCIAL PJ EQUIPE PROPRIA", situacao="ATIVO"):
    return [{
        "kind": "sale", "batch": lote, "company": empresa, "registeredAt": dia,
        "value": valor, "team": equipe, "status": situacao,
        "key": f"{dia}|{lote}|{empresa}|{indice}",
    } for indice in range(vidas)]


def fatura(codigo, nome, vencimento, vidas, valor, competencia="Novembro/2026",
           pago=True, situacao="ATIVO"):
    linha = {
        "cliente": f"{codigo} - {nome}", "cdAssociado": codigo,
        "vencimento": vencimento, "gerado": "05/11/2026", "valor": valor,
        "vidas": str(vidas), "tipoParcela": "PLANO", "parcela": f"P{codigo}",
        "competencia": competencia, "nf": "1", "nfLote": "9", "situacao": situacao,
    }
    if pago:
        linha["dataPagamento"] = vencimento
        linha["dataCredito"] = vencimento
        linha["valorRecebido"] = round(valor * 0.985, 2)
    return linha


def banco(caminho_cache):
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript("""
        CREATE TABLE vendas_snapshots(id INTEGER PRIMARY KEY, start_date TEXT, end_date TEXT,
                                      checked_at TEXT, payload TEXT);
        CREATE TABLE contract_companies(id TEXT PRIMARY KEY, name TEXT, cnpj TEXT,
                                        registered INTEGER, registered_at TEXT, registered_by TEXT,
                                        initial_lives INTEGER, value_per_life REAL,
                                        monthly_value REAL, contract_start TEXT, status TEXT);
        CREATE TABLE contract_lives(id TEXT PRIMARY KEY, company_id TEXT, registered INTEGER);
        CREATE TABLE vidas_importacoes(id TEXT PRIMARY KEY, arquivo TEXT, importado_em TEXT,
                                       inicio TEXT, fim TEXT, origem TEXT);
        CREATE TABLE vidas_usuarios(id TEXT PRIMARY KEY, import_id TEXT, nome TEXT, empresa TEXT,
                                    situacao TEXT, data TEXT, contrato TEXT, cpf TEXT);
    """)
    db.execute(
        "INSERT INTO vendas_snapshots(start_date, end_date, checked_at, payload) VALUES (?, ?, ?, ?)",
        ("2026-11-01", "2026-11-18", "2026-11-18T08:00:00-03:00",
         json.dumps({"rows": (
             venda("8278", "SEGURPRO VIGILANCIA", DIA, 7, 99.9 * 7)
             + venda("8282", "RM TERCEIRIZACAO", DIA, 1, 99.9, "APP")
             + venda("8279", "RM TERCEIRIZACAO", DIA, 4, 99.9 * 4)
         )})),
    )
    db.execute(
        "INSERT INTO vidas_importacoes(id, arquivo, importado_em, inicio, fim, origem) "
        "VALUES ('imp1', 'movimentacao.xlsx', '2026-11-18T09:00:00-03:00', '2026-01-01', '2026-11-18', 's4e')"
    )
    for indice in range(7):
        db.execute(
            "INSERT INTO vidas_usuarios(id, import_id, nome, empresa, situacao, data) "
            "VALUES (?, 'imp1', ?, 'SEGURPRO VIGILANCIA', 'ATIVO', ?)",
            (f"seg{indice}", f"VIGIA {indice}", DIA),
        )
    for indice in range(5):
        db.execute(
            "INSERT INTO vidas_usuarios(id, import_id, nome, empresa, situacao, data) "
            "VALUES (?, 'imp1', ?, 'RM TERCEIRIZACAO', 'ATIVO', ?)",
            (f"rm{indice}", f"AUXILIAR {indice}", DIA),
        )
    Path(caminho_cache).write_text(json.dumps({
        "inicio": "2025-12-01", "fim": "2026-11-18", "linhas": [
            fatura("5129", "SEGURPRO VIGILANCIA", ADESAO, 420, 41958.0),
            fatura("2440", "RM TERCEIRIZACAO", ADESAO, 57, 5694.3),
        ],
    }), encoding="utf-8")
    return db


class AdesoesS4E(unittest.TestCase):
    def setUp(self):
        self.pasta = tempfile.TemporaryDirectory()
        self.cache = str(Path(self.pasta.name) / "faturamento.json")
        ad.FATURAMENTO_CACHE = Path(self.cache)
        ad._VENDAS_CACHE = None
        ad._CLIENTES_CACHE = None
        self.db = banco(self.cache)

    def tearDown(self):
        self.db.close()
        self.pasta.cleanup()
        ad._VENDAS_CACHE = None
        ad._CLIENTES_CACHE = None

    def test_gera_adesoes_com_codigo_e_parcela(self):
        resumo = ad.montar_do_s4e(self.db)
        self.assertEqual(resumo["geradas"], 3)
        self.assertEqual(resumo["semCodigo"], 0)
        self.assertEqual(resumo["semParcela"], 0)
        linhas = {row["lote"]: row for row in self.db.execute("SELECT * FROM adesoes")}
        self.assertEqual(linhas["8278"]["codigo"], "5129")
        self.assertTrue(linhas["8278"]["empresa"].startswith("SEGURPRO"))
        self.assertEqual(linhas["8278"]["data_adesao"], ADESAO)
        self.assertEqual(linhas["8278"]["parcela"], "P5129")
        self.assertEqual(linhas["8282"]["tipo"], "WEB")
        self.assertEqual(linhas["8279"]["tipo"], "CRM")

    def test_conferencia_fecha_lote_vidas_e_parcela(self):
        ad.montar_do_s4e(self.db)
        adesoes = [dict(row) for row in self.db.execute(
            "SELECT * FROM adesoes ORDER BY lote")]
        resumo = ad.conferir_lote(self.db, adesoes)
        self.assertEqual(resumo["total"], 3)
        self.assertEqual(resumo["divergente"], 0, resumo)
        self.assertEqual(resumo["conferido"], 3, resumo)
        adesao = next(row for row in adesoes if row["lote"] == "8278")
        status, resultado = ad.conferir(adesao, ad.Fontes(self.db))
        self.assertEqual(status, "conferido")
        pagamento = next(c for c in resultado["checks"] if c["fonte"] == "pagamento")
        self.assertTrue(pagamento["ok"])
        self.assertIn("paga em", pagamento["detalhe"])

    def _fatura_sem_pagamento(self, codigo, situacao="ATIVO"):
        dados = json.loads(Path(self.cache).read_text(encoding="utf-8"))
        dados["linhas"] = [
            fatura("5129", "SEGURPRO VIGILANCIA", ADESAO, 420, 41958.0,
                   pago=False, situacao=situacao)
            if linha.get("cdAssociado") == codigo else linha
            for linha in dados["linhas"]
        ]
        Path(self.cache).write_text(json.dumps(dados), encoding="utf-8")
        ad._CLIENTES_CACHE = None

    def test_parcela_sem_pagamento_fica_pendente(self):
        self._fatura_sem_pagamento("5129")
        ad.montar_do_s4e(self.db)
        adesoes = [dict(row) for row in self.db.execute(
            "SELECT * FROM adesoes ORDER BY lote")]
        resumo = ad.conferir_lote(self.db, adesoes)
        self.assertEqual(resumo["pendente"], 1, resumo)
        self.assertEqual(resumo["conferido"], 2, resumo)
        adesao = next(row for row in adesoes if row["lote"] == "8278")
        status, resultado = ad.conferir(adesao, ad.Fontes(self.db))
        self.assertEqual(status, "pendente")
        pagamento = next(c for c in resultado["checks"] if c["fonte"] == "pagamento")
        self.assertIsNone(pagamento["ok"])
        self.assertIn("P5129", pagamento["detalhe"])
        self.assertEqual(resultado["fontes"]["pagamento"]["situacao"], "em_aberto")

    def test_parcela_cancelada_fica_divergente(self):
        self._fatura_sem_pagamento("5129", situacao="CANCELADO")
        ad.montar_do_s4e(self.db)
        adesao = dict(self.db.execute(
            "SELECT * FROM adesoes WHERE lote = '8278'").fetchone())
        status, resultado = ad.conferir(adesao, ad.Fontes(self.db))
        self.assertEqual(status, "divergente")
        self.assertIn("CANCELADO", resultado["motivo"])

    def test_divergencia_de_vidas_aparece_no_motivo(self):
        ad.montar_do_s4e(self.db)
        self.db.execute("UPDATE adesoes SET vidas = 9 WHERE lote = '8278'")
        adesao = dict(self.db.execute("SELECT * FROM adesoes WHERE lote = '8278'").fetchone())
        status, resultado = ad.conferir(adesao, ad.Fontes(self.db))
        self.assertEqual(status, "divergente")
        self.assertIn("x 9 na ades", resultado["motivo"])

    def test_parcela_projetada_quando_o_mes_ainda_nao_faturou(self):
        dados = json.loads(Path(self.cache).read_text(encoding="utf-8"))
        dados["linhas"].append(fatura("1153", "ALLPARK", "2026-10-25", 60, 6000.0,
                                      "Outubro/2026"))
        Path(self.cache).write_text(json.dumps(dados), encoding="utf-8")
        ad._CLIENTES_CACHE = None
        self.db.execute(
            "INSERT INTO vidas_usuarios(id, import_id, nome, empresa, situacao, data) "
            "VALUES ('ap1', 'imp1', 'RECEPCIONISTA', 'ALLPARK', 'ATIVO', '2026-11-04')"
        )
        self.db.execute(
            "INSERT INTO vendas_snapshots(start_date, end_date, checked_at, payload) "
            "VALUES ('2026-11-01', '2026-11-18', '2026-11-18T10:00:00-03:00', ?)",
            (json.dumps({"rows": venda("8284", "ALLPARK", "2026-11-04", 1, 99.9)}),),
        )
        ad._VENDAS_CACHE = None
        resumo = ad.montar_do_s4e(self.db, "2026-11-04", "2026-11-04")
        self.assertEqual(resumo["geradas"], 1)
        linha = self.db.execute("SELECT * FROM adesoes WHERE lote = '8284'").fetchone()
        self.assertEqual(linha["data_adesao"], "2026-11-25")
        self.assertEqual(linha["parcela"], "")
        adesao = dict(linha)
        status, resultado = ad.conferir(adesao, ad.Fontes(self.db))
        self.assertEqual(status, "pendente")
        self.assertIn("projetada", resultado["motivo"])

    def test_lote_inventado_e_corrigido_sem_duplicar(self):
        ad.ensure_schema(self.db)
        self.db.execute(
            "INSERT INTO adesoes(id, lote, empresa, data_entrada, data_adesao, vidas, valor, tipo, "
            "situacao, conferencia_status) VALUES ('a1', '17001', 'SEGURPRO VIGILANCIA', ?, ?, 7, ?, 'CRM', '', 'pendente')",
            (DIA, ADESAO, 99.9 * 7),
        )
        resumo = ad.montar_do_s4e(self.db)
        self.assertGreaterEqual(resumo["lotesCorrigidos"], 1)
        linha = self.db.execute("SELECT * FROM adesoes WHERE id = 'a1'").fetchone()
        self.assertEqual(linha["lote"], "8278")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM adesoes").fetchone()[0], 3)

    def test_mesmo_lote_em_outro_mes_nao_move_a_linha_antiga(self):
        ad.ensure_schema(self.db)
        self.db.execute(
            "INSERT INTO adesoes(id, lote, empresa, data_entrada, data_adesao, vidas, valor, tipo, "
            "situacao, conferencia_status) VALUES ('old', '8278', 'SEGURPRO VIGILANCIA', "
            "'2026-04-17', '2026-05-10', 1, 60.0, 'CRM', '', 'pendente')"
        )
        ad.montar_do_s4e(self.db, "2026-11-01", "2026-11-30")
        antiga = self.db.execute("SELECT * FROM adesoes WHERE id = 'old'").fetchone()
        self.assertEqual(antiga["data_entrada"], "2026-04-17")
        self.assertEqual(antiga["lote"], "8278")
        nova = self.db.execute(
            "SELECT * FROM adesoes WHERE lote = '8278' AND data_entrada = ?", (DIA,)
        ).fetchone()
        self.assertIsNotNone(nova)
        self.assertEqual(nova["vidas"], 7)

    def test_lote_com_varias_empresas_nao_troca_os_valores(self):
        extra = venda("8324", "GOMES TEIXEIRA", DIA, 1, 27.0) \
            + venda("8324", "NOVA GW RIO VEICULOS", DIA, 1, 5.5) \
            + venda("8324", "RIO MPS SERVICOS TECNICOS", DIA, 11, 5.5)
        self.db.execute(
            "INSERT INTO vendas_snapshots(start_date, end_date, checked_at, payload) "
            "VALUES ('2026-11-01', '2026-11-18', '2026-11-18T11:00:00-03:00', ?)",
            (json.dumps({"rows": extra}),),
        )
        ad._VENDAS_CACHE = None
        ad.montar_do_s4e(self.db)
        linhas = {row["empresa_venda"]: row for row in self.db.execute(
            "SELECT * FROM adesoes WHERE lote = '8324'"
        )}
        self.assertEqual(len(linhas), 3, linhas.keys())
        self.assertEqual((linhas["GOMES TEIXEIRA"]["vidas"], linhas["GOMES TEIXEIRA"]["valor"]), (1, 27.0))
        self.assertEqual((linhas["NOVA GW RIO VEICULOS"]["vidas"], linhas["NOVA GW RIO VEICULOS"]["valor"]), (1, 5.5))
        self.assertEqual((linhas["RIO MPS SERVICOS TECNICOS"]["vidas"], linhas["RIO MPS SERVICOS TECNICOS"]["valor"]), (11, 60.5))

    def test_equipe_vem_da_entrada_de_contratos_e_filtra(self):
        self.db.execute(
            "INSERT INTO vendas_snapshots(start_date, end_date, checked_at, payload) "
            "VALUES ('2026-11-01', '2026-11-18', '2026-11-18T12:00:00-03:00', ?)",
            (json.dumps({"rows": venda("8290", "JOAO PESSOA SERVICOS", DIA, 2, 60.0, "JOÃO PESSOA")}),),
        )
        ad._VENDAS_CACHE = None
        ad.montar_do_s4e(self.db)
        linhas = {row["lote"]: row for row in self.db.execute("SELECT * FROM adesoes")}
        self.assertEqual(linhas["8290"]["equipe"], "JOÃO PESSOA")
        self.assertEqual(linhas["8282"]["equipe"], "WEB", "APP vira WEB como na tela dela")
        self.assertEqual(linhas["8278"]["equipe"], "COMERCIAL PJ EQUIPE PROPRIA")

        so_joao = ad.listar(self.db, {"equipe": ["JOÃO PESSOA"]}, paginar=False)
        self.assertEqual([item["lote"] for item in so_joao["registros"]], ["8290"])
        self.assertIn("JOÃO PESSOA", so_joao["resumo"]["equipes"])
        self.assertIn("WEB", so_joao["resumo"]["equipes"])

        # Ao gerar de novo, o CRM/WEB acompanha a equipe do lote.
        self.db.execute("UPDATE adesoes SET tipo = 'CRM' WHERE lote = '8282'")
        ad.montar_do_s4e(self.db)
        self.assertEqual(self.db.execute(
            "SELECT tipo FROM adesoes WHERE lote = '8282'").fetchone()[0], "WEB")

    def test_filtro_por_periodo_de_datas(self):
        ad.montar_do_s4e(self.db)
        self.db.execute(
            "INSERT INTO vendas_snapshots(start_date, end_date, checked_at, payload) "
            "VALUES ('2026-11-01', '2026-11-18', '2026-11-18T13:00:00-03:00', ?)",
            (json.dumps({"rows": venda("8299", "OUTRA EMPRESA", "2026-11-12", 2, 60.0)}),),
        )
        ad._VENDAS_CACHE = None
        ad.montar_do_s4e(self.db)

        todos = ad.listar(self.db, {}, paginar=False)["registros"]
        self.assertEqual(len(todos), 4)

        dentro = ad.listar(self.db, {"inicio": ["03/11/2026"], "fim": ["03/11/2026"]},
                           paginar=False)["registros"]
        self.assertEqual(sorted(item["lote"] for item in dentro), ["8278", "8279", "8282"])

        depois = ad.listar(self.db, {"inicio": ["2026-11-04"]}, paginar=False)["registros"]
        self.assertEqual([item["lote"] for item in depois], ["8299"])

        antes = ad.listar(self.db, {"fim": ["2026-11-02"]}, paginar=False)["registros"]
        self.assertEqual(antes, [])

        with self.assertRaises(ValueError):
            ad.listar(self.db, {"inicio": ["2026-11-10"], "fim": ["2026-11-03"]}, paginar=False)

    def test_filtro_por_varias_equipes(self):
        ad.montar_do_s4e(self.db)
        duas = ad.listar(self.db, {"equipe": ["WEB", "COMERCIAL PJ EQUIPE PROPRIA"]},
                         paginar=False)["registros"]
        self.assertEqual(sorted(item["lote"] for item in duas), ["8278", "8279", "8282"])

        so_uma = ad.listar(self.db, {"equipe": ["WEB"]}, paginar=False)["registros"]
        self.assertEqual([item["lote"] for item in so_uma], ["8282"])

        where, params = ad.filtro({"equipe": "WEB"})
        self.assertIn("equipe IN (?)", where)
        self.assertEqual(params, ["WEB"])

    def test_planilha_uma_aba_por_mes(self):
        ad.montar_do_s4e(self.db)
        registros = ad.listar(self.db, {}, paginar=False)["registros"]
        plano = dict(self.db.execute("SELECT * FROM adesoes WHERE lote = '8278'").fetchone())
        linha = ad._linha_planilha(plano)
        self.assertEqual(linha[3], round(plano["valor"], 2), "TOTAL VIDAS é o valor do lote")
        livro = ad.planilha(registros, ad.situacao_fontes(self.db))
        self.assertTrue(livro.startswith(b"PK"))
        with zipfile.ZipFile(io.BytesIO(livro)) as pacote:
            indice = pacote.read("xl/workbook.xml").decode("utf-8")
            aba = pacote.read("xl/worksheets/sheet1.xml").decode("utf-8")
        self.assertIn("Novembro-2026", indice)
        self.assertIn("Resumo", indice)
        self.assertIn("QUANTIDADE VIDAS", aba)
        self.assertIn("P5129", aba)

    def test_colunas_novas_sao_adicionadas_em_tabela_antiga(self):
        self.db.execute(
            "CREATE TABLE adesoes(id TEXT PRIMARY KEY, lote TEXT NOT NULL, empresa TEXT NOT NULL, "
            "data_entrada TEXT NOT NULL, data_adesao TEXT NOT NULL, vidas INTEGER NOT NULL, "
            "valor REAL NOT NULL, tipo TEXT NOT NULL, situacao TEXT, conferencia_status TEXT, "
            "conferencia_resultado TEXT, notas_conferencia TEXT, conferido_em TEXT, "
            "conferido_por TEXT, criado_em TEXT, atualizado_em TEXT)"
        )
        ad.ensure_schema(self.db)
        colunas = {row[1] for row in self.db.execute("PRAGMA table_info(adesoes)")}
        self.assertTrue({"origem", "codigo", "parcela", "empresa_venda"} <= colunas)


if __name__ == "__main__":
    unittest.main()
