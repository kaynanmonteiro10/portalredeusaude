"""Testes locais da geração de recibos. Não acessam o S4E nem o banco real."""

import sqlite3
import struct
import sys
import unittest
import zlib
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import portal_server as portal
import recibos_pdf
import s4e_connector as s4e


def tiny_png():
    def chunk(kind, payload):
        return (
            struct.pack(">I", len(payload)) + kind + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        )
    header = struct.pack(">IIBBBBB", 2, 2, 8, 6, 0, 0, 0)
    raw = b"".join(b"\x00" + bytes([0, 128, 0, 255]) * 2 for _ in range(2))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


class Helpers(unittest.TestCase):
    def test_safe_folder_name(self):
        self.assertEqual(portal._recibos_safe("SIND/RO: A*B?"), "SIND RO A B")
        self.assertEqual(portal._recibos_safe("", "Sem grupo"), "Sem grupo")
        self.assertEqual(portal._recibos_safe("x" * 200), "x" * 90)
        self.assertEqual(portal._recibos_safe("../evil"), "evil")

    def test_value(self):
        self.assertEqual(portal._recibos_value("R$ 68,00"), 68.0)
        self.assertEqual(portal._recibos_value("R$ 1.234,56"), 1234.56)
        self.assertEqual(portal._recibos_value("R$ 0,00"), 0.0)
        self.assertEqual(portal._recibos_value(""), 0.0)

    def test_day(self):
        self.assertEqual(portal._recibos_day("2026-11-13").isoformat(), "2026-11-13")
        self.assertEqual(portal._recibos_day("13/11/2026").isoformat(), "2026-11-13")
        with self.assertRaises(s4e.ConnectorError):
            portal._recibos_day("13-11-2026")

    def test_period_limits(self):
        with self.assertRaises(s4e.ConnectorError):
            portal.recibos_start_run("2026-11-30", "2026-11-01")
        with self.assertRaises(s4e.ConnectorError):
            portal.recibos_start_run("2026-01-01", "2026-06-01")


SAMPLE = """
<span id="LBL_Numero1">320195</span>
<span id="LBL_Valor1">R$ 68,00</span>
<span id="LBL_Nome1">VIDRART</span>
<span id="LBL_ValorExtenso1">(SESSENTA E OITO REAIS)</span>
<span id="LBL_Historico1">parcela 320195 vencimento em 10/11/2026</span>
<input name="lbl_data1" type="text" value="10 de Novembro de 2026" maxlength="40" id="lbl_data1">
<span id="LBL_hora1">09:39</span>
<span id="LBL_Logo"><img src="/SYS/Licenca/ABC/Imagens/LogoSuperior.png" /></span>
"""


class ReceiptParsing(unittest.TestCase):
    def test_parse(self):
        fields = s4e.parse_receipt(SAMPLE)
        self.assertEqual(fields["numero"], "320195")
        self.assertEqual(fields["nome"], "VIDRART")
        self.assertEqual(fields["valor"], "R$ 68,00")
        self.assertEqual(fields["data"], "10 de Novembro de 2026")
        self.assertEqual(fields["hora"], "09:39")
        self.assertEqual(fields["logo"], "/SYS/Licenca/ABC/Imagens/LogoSuperior.png")

    def test_blank_template(self):
        with self.assertRaises(s4e.ConnectorError):
            s4e.parse_receipt('<span id="LBL_Numero1"></span>')


class PdfGeneration(unittest.TestCase):
    def test_pdf_structure_and_accents(self):
        fields = s4e.parse_receipt(SAMPLE)
        fields["nome"] = "CONCEIÇÃO"
        pdf = recibos_pdf.build_receipt_pdf(fields, tiny_png())
        self.assertTrue(pdf.startswith(b"%PDF-1.4"))
        self.assertTrue(pdf.endswith(b"%%EOF\n"))
        start = int(pdf.rsplit(b"startxref\n", 1)[1].split(b"\n", 1)[0])
        self.assertEqual(pdf[start:start + 4], b"xref")
        self.assertIn(b"/Type /Page", pdf)
        self.assertIn(b"/XObject", pdf)
        self.assertIn(b"CONCEI\xc7\xc3O", pdf)
        self.assertIn(b"320195", pdf)

    def test_pdf_without_logo(self):
        fields = s4e.parse_receipt(SAMPLE)
        pdf = recibos_pdf.build_receipt_pdf(fields)
        self.assertNotIn(b"/XObject", pdf)
        self.assertIn(b"VIDRART", pdf)


def _overview_db():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript(
        """
        CREATE TABLE recibo_runs (
            id TEXT PRIMARY KEY, period_start TEXT, period_end TEXT, centro_custo TEXT, grupo TEXT,
            status TEXT, phase TEXT, message TEXT, total INTEGER, gerados INTEGER, ignorados INTEGER,
            erros INTEGER, empresas INTEGER, folder TEXT, zip_path TEXT, created_by TEXT,
            started_at TEXT, finished_at TEXT, error TEXT
        );
        CREATE TABLE apuracao_map (id TEXT, grupo TEXT, tipo_pagamento TEXT, grupo_mae TEXT);
        CREATE TABLE apuracao_runs (id TEXT, status TEXT, started_at TEXT, finished_at TEXT);
        CREATE TABLE apuracao_rows (
            run_id TEXT, grupo_mae TEXT, grupo_empresa TEXT, empresa TEXT,
            vencimento TEXT, valor_recebido REAL, pago INTEGER
        );
        """
    )
    db.execute("INSERT INTO apuracao_map VALUES ('1', 'CCT SINDIMOTOS', '', 'SINDIMOTOS')")
    db.execute("INSERT INTO apuracao_runs VALUES ('run1', 'done', '2026-11-13T10:00:00+00:00', '2026-11-13T10:05:00+00:00')")
    db.execute("INSERT INTO apuracao_rows VALUES ('run1', 'SINTEG', 'SINTEG-SEAC', 'EMPRESA A', '05/11/2026', 100.0, 1)")
    db.execute("INSERT INTO apuracao_rows VALUES ('run1', 'SINTEG', 'SINTEG-SEAC', 'EMPRESA B', '05/11/2026', 50.0, 0)")
    return db


class Overview(unittest.TestCase):
    def test_cost_center_tree_and_summary(self):
        db = _overview_db()
        db.execute(
            "INSERT INTO recibo_runs VALUES ('r1','2026-11-01','2026-11-13','','','done','fim',"
            "'3 recibos em PDF.',3,3,0,0,2,'pasta','pasta.zip','KAYNAN',"
            "'2026-11-13T10:00:00+00:00','2026-11-13T10:05:00+00:00',NULL)"
        )
        data = portal.recibos_overview(db)
        centros = {item["nome"]: item["grupos"] for item in data["centros"]}
        self.assertIn("SINDIMOTOS", centros)
        self.assertIn("Ceará", centros)
        self.assertIn("CCT SINDIMOTOS", centros["SINDIMOTOS"])
        self.assertIn("SINTEG-SEAC", centros["SINTEG"])
        self.assertEqual(data["base"]["runId"], "run1")
        self.assertEqual(data["base"]["pagas"], 1)
        self.assertEqual(data["runs"][0]["gerados"], 3)
        self.assertTrue(data["runs"][0]["hasZip"])


class Previa(unittest.TestCase):
    def test_counts_only_paid_rows_inside_period_and_filters(self):
        db = _overview_db()
        start = date(2026, 11, 1)
        end = date(2026, 11, 30)
        tudo = portal.recibos_previa(db, start, end)
        self.assertEqual(tudo["parcelas"], 1)
        self.assertEqual(tudo["empresas"], 1)
        self.assertEqual(tudo["valor"], 100.0)
        self.assertEqual(tudo["centros"], 1)
        self.assertEqual(tudo["base"]["runId"], "run1")

        self.assertEqual(portal.recibos_previa(db, start, end, centro="SINTEG")["parcelas"], 1)
        self.assertEqual(portal.recibos_previa(db, start, end, centro="SINDIMOTOS")["parcelas"], 0)
        self.assertEqual(portal.recibos_previa(db, start, end, grupo="SINTEG-SEAC")["parcelas"], 1)
        self.assertEqual(portal.recibos_previa(db, start, end, grupo="OUTRO")["parcelas"], 0)
        self.assertEqual(portal.recibos_previa(db, date(2026, 12, 1), end)["parcelas"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
