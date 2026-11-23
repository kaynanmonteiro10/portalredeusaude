import re
import unittest

import relatorio_semanal


def link(target, label):
    return f'<a href="javascript:__doPostBack(&#39;{target}&#39;,&#39;&#39;)">{label}</a>'


def window(current, total, chunk=10):
    """Janela de paginação igual à do S4E: 10 botões e setas de bloco."""
    start = max(1, ((current - 1) // chunk) * chunk + 1)
    stop = min(total, start + chunk - 1)
    parts = []
    if start > 1:
        parts.append(link(f"GRD_Resultado$prev{current}", "..."))
    for number in range(start, stop + 1):
        if number != current:
            parts.append(link(f"GRD_Resultado$page{number}", number))
    if stop < total:
        parts.append(link(f"GRD_Resultado$next{current}", "..."))
    return "".join(parts)


def page_html(number, total):
    return f"<p>p{number}</p>{window(number, total)}"


def parse(html):
    return [{"id": m.group(1), "nome": "", "data": ""} for m in re.finditer(r"<p>p(\d+)</p>", html)]


class FakeSession:
    def __init__(self, pages):
        self.pages = pages
        self.calls = []

    def post(self, path, fields, timeout=None):
        target = fields["__EVENTTARGET"]
        self.calls.append(target)
        return self.pages[target], {}


class WalkPaginationTest(unittest.TestCase):
    def setUp(self):
        self._checked = relatorio_semanal._checked
        relatorio_semanal._checked = lambda raw, headers: raw

    def tearDown(self):
        relatorio_semanal._checked = self._checked

    def run_walk(self, total, current=1):
        pages = {f"GRD_Resultado$page{n}": page_html(n, total) for n in range(2, total + 1)}
        for number in range(1, total + 1):
            nxt = number + 1 if number % 10 == 0 else min(total, number + 10)
            pages[f"GRD_Resultado$next{number}"] = page_html(nxt, total)
            pages[f"GRD_Resultado$prev{number}"] = page_html(max(1, number - 10), total)
        session = FakeSession(pages)
        rows = relatorio_semanal._walk(session, "/x", page_html(current, total), parse)
        return session, rows

    def test_visits_every_page_once(self):
        session, rows = self.run_walk(6)
        self.assertEqual(session.calls, [f"GRD_Resultado$page{n}" for n in range(2, 7)])
        self.assertEqual([r["id"] for r in rows], [str(n) for n in range(1, 7)])

    def test_does_not_revisit_first_page(self):
        session, _ = self.run_walk(3)
        self.assertNotIn("GRD_Resultado$page1", session.calls)

    def test_stops_when_only_visited_pages_remain(self):
        page = "<p>p1</p>" + link("GRD_Resultado$page1", "1")
        rows = relatorio_semanal._walk(FakeSession({}), "/x", page, parse)
        self.assertEqual(len(rows), 1)

    def test_backward_ellipsis_is_ignored(self):
        page = "<p>p12</p>" + (
            link("GRD_Resultado$prev12", "...")
            + "".join(link(f"GRD_Resultado$page{n}", n) for n in range(12, 21))
            + link("GRD_Resultado$next12", "...")
        )
        kind, number, target = relatorio_semanal._page_choice(page, set(range(1, 12)))
        self.assertEqual((kind, number, target), ("page", 12, "GRD_Resultado$page12"))

    def test_forward_ellipsis_jumps_one_block(self):
        page = "".join(link(f"GRD_Resultado$page{n}", n) for n in range(1, 10))
        page += link("GRD_Resultado$next10", "...")
        kind, number, target = relatorio_semanal._page_choice(page, set(range(1, 10)))
        self.assertEqual((kind, number, target), ("jump", None, "GRD_Resultado$next10"))

    def test_walks_past_first_block(self):
        session, rows = self.run_walk(25)
        ids = {r["id"] for r in rows}
        self.assertEqual(ids, {str(n) for n in range(1, 26)})
        self.assertTrue(any("$next" in call for call in session.calls))

    def test_stall_stops_after_one_retry(self):
        page = "<p>p1</p>" + link("GRD_Resultado$page2", "2")
        session = FakeSession({"GRD_Resultado$page2": page})
        rows = relatorio_semanal._walk(session, "/x", page, parse)
        self.assertEqual(len(session.calls), 2)
        self.assertEqual(len(rows), 1)

    def test_current_page_is_read_from_window(self):
        first = "<p>p1</p>" + "".join(link(f"GRD_Resultado$page{n}", n) for n in range(2, 11))
        self.assertEqual(relatorio_semanal._current_page(first), 1)
        last_of_block = "<p>p10</p>" + (
            "".join(link(f"GRD_Resultado$page{n}", n) for n in range(1, 10))
            + link("GRD_Resultado$next10", "...")
        )
        self.assertEqual(relatorio_semanal._current_page(last_of_block), 10)
        after_jump = "<p>p11</p>" + (
            link("GRD_Resultado$prev11", "...")
            + "".join(link(f"GRD_Resultado$page{n}", n) for n in range(12, 21))
            + link("GRD_Resultado$next11", "...")
        )
        self.assertEqual(relatorio_semanal._current_page(after_jump), 11)
        middle = "<p>p12</p>" + (
            link("GRD_Resultado$prev12", "...")
            + "".join(link(f"GRD_Resultado$page{n}", n) for n in (11, 13, 14, 15, 16, 17, 18, 19, 20))
            + link("GRD_Resultado$next12", "...")
        )
        self.assertEqual(relatorio_semanal._current_page(middle), 12)
        # No último bloco a página atual é a única que não aparece como link;
        # ela não precisa ser numerada: sem números novos e sem seta à frente,
        # a leitura termina.
        last_page = "<p>p25</p>" + (
            link("GRD_Resultado$prev25", "...")
            + "".join(link(f"GRD_Resultado$page{n}", n) for n in range(21, 25))
        )
        self.assertEqual(
            relatorio_semanal._page_choice(last_page, set(range(1, 26))), ("", None, "")
        )

    def test_landing_page_is_not_read_twice(self):
        # Regressão: após o salto, a página 11 não pode virar uma escolha de novo
        # (era o que encerrava a leitura na metade da lista).
        session, rows = self.run_walk(25)
        self.assertEqual(len(session.calls), len({call for call in session.calls}))
        self.assertEqual(len(rows), 25)


if __name__ == "__main__":
    unittest.main()
