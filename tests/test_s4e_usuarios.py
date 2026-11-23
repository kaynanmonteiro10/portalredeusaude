import unittest
from datetime import date

import s4e_usuarios
import vidas

HEADER = ["Código", "Usuário", "Empresa", "Grupo de faturamento", "Situação atual", "Valor", "Situação",
          "Data", "Colaborador", "Utilização 30/60/90", "E-mail", "Telefone", "Nome da Mãe", "Parentesco",
          "Data de Nascimento", "Nome Responsável", "Vencimento", "Contrato", "CPF", "Plano", "UF",
          "Municipio", "Bairro", "Tipo Logradouro", "Endereço", "Complemento", "Numero", "CEP"]


def person(nome, contrato, cpf, situacao="ATIVO", centro="SINTEG", empresa="EXEMPLAR SERVICOS E LIMPEZA LTDA"):
    row = ["&nbsp;"] * len(HEADER)
    row[0], row[1], row[2], row[4] = contrato, nome, empresa, situacao
    row[5], row[6], row[7] = "R$ 23,70", situacao, "01/10/2026"
    row[13], row[17], row[18], row[19] = "TITULAR", contrato, cpf, centro
    return row


def export(*rows, total=True):
    body = "".join(f"<tr>{''.join(f'<td>{value}</td>' for value in row)}</tr>" for row in rows)
    total_row = ""
    if total:
        total_row = f"<tr>{''.join('<td></td>' for _ in range(5))}<td>R$ 51.327,04</td>{''.join('<td></td>' for _ in range(22))}</tr>"
    header = "".join(f"<td>{label}</td>" for label in HEADER)
    return f'<b>Registros: 2</b><table id="GRD_Resultado"><tr>{header}</tr>{body}{total_row}</table>'


class ParseExport(unittest.TestCase):
    def test_grid_skips_totals_and_normalizes_people(self):
        page = export(
            person("ANA MARIA", "730129", "041.304.673-79", "ATIVO"),
            person("CARLOS LIMA", "730130", "987.654.321-00", "CANCELADO", "NOVA IGUACU", "NOGUEIRA ARAUJO"),
        )
        parsed = vidas.parse_relatorio(s4e_usuarios.parse_export(page))
        self.assertEqual(parsed["ativos"], 1)
        self.assertEqual(parsed["cancelados"], 1)
        nomes = {row["nome"]: row for row in parsed["rows"]}
        self.assertEqual(nomes["ANA MARIA"]["centro"], "SINTEG")
        self.assertEqual(nomes["CARLOS LIMA"]["situacao"], "CANCELADO")
        self.assertEqual(nomes["CARLOS LIMA"]["centro"], "NOVA IGUACU")
        self.assertEqual(nomes["ANA MARIA"]["contrato"], "730129")

    def test_rejects_page_without_grid(self):
        with self.assertRaises(Exception):
            s4e_usuarios.parse_export("<html><body>Nenhum registro</body></html>")


class FakeSession:
    def __init__(self, exports, delta=""):
        self.exports = exports
        self.delta = delta
        self.calls = []
        self.fields = []

    def get(self, path, timeout=60):
        form = '<input name="__VIEWSTATE" value="abc"><input name="TXT_DataInicial" value="">' \
               '<input name="BTN_Buscar" value="Buscar">'
        return form.encode("windows-1252"), {"Content-Type": "text/html; charset=windows-1252"}

    def post_ajax(self, path, fields, timeout=300):
        self.calls.append(fields["CMB_Situacao"])
        self.fields.append(dict(fields))
        body = self.delta + self.exports[fields["CMB_Situacao"]]
        return body.encode("windows-1252"), {"Content-Type": "text/html; charset=windows-1252"}


class FetchUsers(unittest.TestCase):
    def test_all_merges_both_situations(self):
        session = FakeSession({
            "1": export(person("ANA MARIA", "730129", "041.304.673-79", "ATIVO")),
            "2": export(person("CARLOS LIMA", "730130", "987.654.321-00", "CANCELADO", "NOVA IGUACU")),
        })
        result = s4e_usuarios.fetch_users(session, date(2026, 10, 1), date(2026, 10, 31))
        self.assertEqual(session.calls, ["1", "2"])
        self.assertEqual((result["ativos"], result["cancelados"]), (1, 1))
        self.assertEqual(len(result["rows"]), 2)

    def test_scope_queries_and_filters_one_situation(self):
        session = FakeSession({
            "1": export(person("ANA MARIA", "730129", "041.304.673-79", "ATIVO"),
                        person("BEATRIZ SOUZA", "730131", "111.222.333-44", "CANCELADO")),
        })
        result = s4e_usuarios.fetch_users(session, date(2026, 10, 1), date(2026, 10, 31), "ATIVO")
        self.assertEqual(session.calls, ["1"])
        self.assertEqual([row["nome"] for row in result["rows"]], ["ANA MARIA"])

    def test_invalid_scope(self):
        with self.assertRaises(ValueError):
            s4e_usuarios.fetch_users(FakeSession({}), date(2026, 10, 1), date(2026, 10, 31), "TODOS")

    def test_refreshes_hidden_fields_between_queries(self):
        session = FakeSession(
            {"1": export(person("ANA MARIA", "730129", "041.304.673-79", "ATIVO")),
             "2": export(person("CARLOS LIMA", "730130", "987.654.321-00", "CANCELADO"))},
            delta="1|5|hiddenField|__VIEWSTATE|atualizado-1|",
        )
        s4e_usuarios.fetch_users(session, date(2026, 10, 1), date(2026, 10, 31))
        self.assertEqual(session.fields[0]["__VIEWSTATE"], "abc")
        self.assertEqual(session.fields[1]["__VIEWSTATE"], "atualizado-1")

    def test_empty_export_raises(self):
        session = FakeSession({"1": '<table id="GRD_Resultado"><tr><td>Usuário</td></tr></table>', "2": '<table></table>'})
        with self.assertRaises(Exception):
            s4e_usuarios.fetch_users(session, date(2026, 10, 1), date(2026, 10, 31))


if __name__ == "__main__":
    unittest.main(verbosity=2)
