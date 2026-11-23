import contextlib
import os
import sqlite3
import tempfile
import unittest
from datetime import date

import s4e_notas


def title(nf="", parcela="100", lote="", valor=100.0, pago=0.0, pagamento="", emissao="",
          documento="11.111.111/0001-11", competencia="Novembro/2026", tipo="PLANO",
          empresa="EMPRESA TESTE", situacao="ATIVO"):
    return {
        "cliente": empresa, "empresa": empresa, "documento": documento, "grupo": "",
        "departamento": "", "situacao": situacao, "gerado": "01/11/2026",
        "cdAssociado": "1", "vencimento": "10/11/2026", "valor": valor, "acrescimo": 0.0,
        "desconto": 0.0, "imposto": 0.0, "titulo": valor, "taxa": 0.0, "dataCredito": "",
        "dataPagamento": pagamento, "multa": 0.0, "acrescimoAvulso": 0.0,
        "descontoPagamento": 0.0, "valorRecebido": pago, "tarifa": 0.0, "tipoParcela": tipo,
        "tipoRecebimento": "", "tipoPagamento": "BOLETO", "competencia": competencia,
        "parcela": parcela, "nfLote": lote, "nf": nf, "emissao": emissao, "vlPlano": valor,
        "vlOrto": 0.0, "vlProRata": 0.0, "vendedor": "", "vidas": "1",
    }


class BuildGroups(unittest.TestCase):
    def test_repeated_note_is_confirmed_and_keeps_paid_title(self):
        rows = [
            title(nf="500", parcela="100", lote="7", pago=100.0, pagamento="05/11/2026"),
            title(nf="500", parcela="101", lote="7"),
        ]
        groups = s4e_notas.build_groups(rows)
        s4e_notas.annotate(rows, groups)
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["classificacao"], "confirmada")
        self.assertIn("500", groups[0]["motivos"][0])
        self.assertEqual([row["papel"] for row in rows], ["correta", "duplicada"])

    def test_same_charge_without_note_is_suspicion(self):
        rows = [title(parcela="100"), title(parcela="101")]
        groups = s4e_notas.build_groups(rows)
        self.assertEqual(groups[0]["classificacao"], "suspeita")
        self.assertEqual(groups[0]["valorRisco"], 200.0)

    def test_both_paid_is_probable_and_has_no_correct_title(self):
        rows = [
            title(parcela="100", pago=100.0, pagamento="05/11/2026"),
            title(parcela="101", pago=100.0, pagamento="06/11/2026"),
        ]
        groups = s4e_notas.build_groups(rows)
        self.assertEqual(groups[0]["classificacao"], "provavel")
        self.assertEqual(groups[0]["correta"], "")
        self.assertIn("pagamento", groups[0]["justificativa"])

    def test_one_paid_one_open_points_to_correct(self):
        rows = [
            title(parcela="100", pago=100.0, pagamento="05/11/2026"),
            title(parcela="101"),
        ]
        groups = s4e_notas.build_groups(rows)
        self.assertEqual(groups[0]["classificacao"], "provavel")
        self.assertEqual(groups[0]["correta"], "100")
        self.assertEqual(groups[0]["valorRisco"], 100.0)

    def test_zero_value_titles_do_not_form_groups(self):
        rows = [title(parcela="100", valor=0.0), title(parcela="101", valor=0.0)]
        self.assertEqual(s4e_notas.build_groups(rows), [])

    def test_same_parcela_in_two_lots_is_confirmed(self):
        rows = [
            title(nf="700", parcela="100", lote="10"),
            title(nf="700", parcela="100", lote="11"),
        ]
        groups = s4e_notas.build_groups(rows)
        self.assertEqual(groups[0]["classificacao"], "confirmada")
        self.assertTrue(any("lotes" in reason for reason in groups[0]["motivos"]))

    def test_different_type_or_value_are_not_duplicates(self):
        rows = [title(parcela="100", tipo="PLANO"), title(parcela="101", tipo="ORTO")]
        self.assertEqual(s4e_notas.build_groups(rows), [])


LOTE = """<table><tr><td>X</td><td>Mensalidade</td><td>NF</td><td>Cliente</td><td>Vencimento</td>
<td>FATURA</td><td>REF IMP</td><td>COFINS</td><td>COFINS RET</td><td>CSLL</td><td>CSLL RET</td>
<td>INSS</td><td>INSS RET</td><td>IR</td><td>IR RET</td><td>ISS</td><td>ISS RET</td><td>PIS</td>
<td>PIS RET</td><td>Plano</td><td>Orto</td></tr>
<tr><td></td><td>322683</td><td>900</td><td>5401 - ALLPARK</td><td>25/11/2026</td><td>60,00</td>
<td>60,00</td><td>1,80</td><td>0,00</td><td>0,60</td><td>0,00</td><td>0,00</td><td>0,00</td>
<td>0,90</td><td>0,00</td><td>1,20</td><td>0,00</td><td>0,39</td><td>0,00</td><td>60,00</td><td>0,00</td></tr></table>"""


class Lote(unittest.TestCase):
    def test_parse_lote_reads_taxes_and_links(self):
        parsed = s4e_notas.parse_lote(LOTE)
        detail = parsed["tributos"]["322683"]
        self.assertEqual(detail["cofins"], 1.8)
        self.assertEqual(detail["iss"], 1.2)
        self.assertEqual(detail["fatura"], 60.0)
        self.assertEqual(parsed["links"], [])

    def test_apply_lotes_matches_by_parcela(self):
        rows = [title(parcela="322683", lote="4152")]
        s4e_notas._apply_lotes(rows, {"4152": s4e_notas.parse_lote(LOTE)})
        self.assertEqual(rows[0]["tributos"]["cofins"], 1.8)

    def test_apply_lotes_finds_parcela_without_lot_number(self):
        rows = [title(parcela="322683", lote="")]
        s4e_notas._apply_lotes(rows, {"4152": s4e_notas.parse_lote(LOTE)})
        self.assertEqual(rows[0]["tributos"]["cofins"], 1.8)
        self.assertEqual(rows[0]["nfUrl"], "")


class FakeSession:
    def __init__(self, get_page, post_page):
        self.get_page = get_page
        self.post_page = post_page
        self.fields = None

    def get(self, path, timeout=0):
        return self.get_page.encode("ascii"), {}

    def post(self, path, fields, timeout=0):
        self.fields = fields
        return self.post_page.encode("ascii"), {}


class LotListing(unittest.TestCase):
    GET_PAGE = """<html><body><form method="post" action="./Lotes.aspx">
        <input type="hidden" name="__VIEWSTATE" value="abc" />
        <input type="text" name="TXT_DataInicial" value="" />
        <input type="text" name="TXT_DataFinal" value="" />
        <input type="submit" name="BTN_Avancar" value="Buscar" />
        </form></body></html>"""

    POST_PAGE = """<table>
        <tr><td><a href="Lote.aspx?ID=4152&amp;Modal=1">4152</a></td></tr>
        <tr><td><a href="Lote.aspx?ID=4151&Modal=1">4151</a></td></tr>
        <tr><td><a href="Lote.aspx?ID=4152&Modal=1">4152</a></td></tr>
        </table>"""

    def test_search_posts_period_and_reads_unique_lots(self):
        session = FakeSession(self.GET_PAGE, self.POST_PAGE)
        ids = s4e_notas.s4e.fetch_nfse_lot_ids(session, date(2026, 11, 1), date(2026, 11, 13))
        self.assertEqual(ids, ["4152", "4151"])
        self.assertEqual(session.fields["TXT_DataInicial"], "01/11/2026")
        self.assertEqual(session.fields["TXT_DataFinal"], "13/11/2026")
        self.assertEqual(session.fields["CMB_TipoBusca"], "1")
        self.assertEqual(session.fields["BTN_Avancar"], "Buscar")

    def test_search_fails_without_lot_form(self):
        session = FakeSession("<html><body>sem formulario</body></html>", self.POST_PAGE)
        with self.assertRaises(s4e_notas.s4e.ConnectorError):
            s4e_notas.s4e.fetch_nfse_lot_ids(session, date(2026, 11, 1), date(2026, 11, 13))


class Period(unittest.TestCase):
    def test_valid_period(self):
        start, end = s4e_notas.parse_period({"start": "2026-11-01", "end": "2026-11-13"})
        self.assertEqual((start, end), (date(2026, 11, 1), date(2026, 11, 13)))

    def test_rejects_inverted_and_too_long(self):
        with self.assertRaises(ValueError):
            s4e_notas.parse_period({"start": "2026-11-13", "end": "2026-11-01"})
        with self.assertRaises(ValueError):
            s4e_notas.parse_period({"start": "2025-01-01", "end": "2026-11-01"})
        with self.assertRaises(ValueError):
            s4e_notas.parse_period({})


class Storage(unittest.TestCase):
    def setUp(self):
        self.path = os.path.join(tempfile.mkdtemp(), "notas.db")

        @contextlib.contextmanager
        def connection():
            db = sqlite3.connect(self.path, timeout=30)
            db.row_factory = sqlite3.Row
            try:
                yield db
            finally:
                db.close()

        self.connection = connection
        with connection() as db:
            s4e_notas.ensure_schema(db)
            db.execute(
                "INSERT INTO notas_runs(id, inicio, fim, status, started_at, created_by) VALUES (?, ?, ?, 'done', ?, ?)",
                ("run-1", "2026-11-01", "2026-11-13", "2026-11-13T10:00:00+00:00", "admin"),
            )
            db.commit()

    def test_store_overview_and_export(self):
        rows = [
            title(nf="900", parcela="100", lote="7", pago=100.0, pagamento="05/11/2026"),
            title(nf="900", parcela="101", lote="7"),
        ]
        groups = s4e_notas.build_groups(rows)
        s4e_notas.annotate(rows, groups)
        stats = s4e_notas.store_run(self.connection, "run-1", rows, groups)
        with self.connection() as db:
            db.execute(
                "UPDATE notas_runs SET total_titulos = ?, total_notas = ?, grupos = ?, confirmadas = ?, "
                "provaveis = ?, suspeitas = ?, valor_risco = ?, valor_total = ? WHERE id = 'run-1'",
                (stats["totalTitulos"], stats["totalNotas"], stats["grupos"], stats["confirmadas"],
                 stats["provaveis"], stats["suspeitas"], stats["valorRisco"], stats["valorTotal"]),
            )
            db.commit()
            data = s4e_notas.overview(db, "run-1")
        self.assertEqual(data["resumo"]["totalTitulos"], 2)
        self.assertEqual(data["resumo"]["grupos"], 1)
        self.assertEqual(data["grupos"][0]["classificacao"], "confirmada")
        self.assertEqual(len(data["grupos"][0]["itens"]), 2)
        with self.connection() as db:
            body, filename = s4e_notas.export_xlsx(db, "run-1")
        self.assertTrue(body.startswith(b"PK"))
        self.assertEqual(filename, "conferencia_notas_2026-11-01_a_2026-11-13.xlsx")


if __name__ == "__main__":
    unittest.main(verbosity=2)
