import ast
import sqlite3
import unittest
from pathlib import Path
from contextlib import nullcontext
from datetime import date, timedelta
from unittest.mock import patch

import retornos
import s4e_retornos


class ReturnTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        retornos.ensure_schema(self.db)
        self.file = {'id': '11346', 'service': 'CNAB 240 - WS P4X', 'type': 'P4X SINDIMOTOS CCT 2026',
                     'processedAt': '11/11/2026 09:00:23', 'nsa': '130', 'agreement': '1000059',
                     'quantity': '', 'value': '', 'filename': 'COBFB_1000059_130_11112026.TXT', 'status': 'Rejeitado'}
        self.line = {'line': '37', 'installment': '320352', 'ourNumber': '10498077',
                     'client': '3909 - MERCANTIL DA ECONOMIA CEARENSE', 'occurrence': 'NOSSO NUMERO EXCLUIDO',
                     'occurrenceCode': '102', 'severity': 'error'}
        self.details = {'headers': [], 'rows': [self.line], 'totals': {}}
        self.processed = {**self.file, 'status': 'Processado'}
        self.success = {**self.line, 'severity': 'success', 'occurrence': 'DEBITO EFETUADO', 'occurrenceCode': '6'}

    def tearDown(self):
        self.db.close()

    def states(self):
        return [i['state'] for i in retornos.detail(self.db, '11346')['incidents']]

    def test_schema_idempotent(self):
        retornos.ensure_schema(self.db)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM retornos_control').fetchone()[0], 1)

    def test_return_api_requires_admin_or_explicit_assignment(self):
        source = ast.parse((Path(__file__).resolve().parent.parent / 'portal_server.py').read_text(encoding='utf-8'))
        helper = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == 'require_retornos')
        module = ast.fix_missing_locations(ast.Module(body=[helper], type_ignores=[]))
        self.db.execute('CREATE TABLE user_screens(user_id TEXT, screen_id TEXT)')
        user = {'id': 'synthetic', 'role': 'user', 'management': True}
        namespace = {'require_user': lambda db, handler: user}
        exec(compile(module, 'isolated-return-access', 'exec'), namespace)
        class Handler:
            def send_json(self, data, status):
                self.status = status
        handler = Handler()
        self.assertIsNone(namespace['require_retornos'](self.db, handler))
        self.assertEqual(handler.status, 403)
        self.db.execute("INSERT INTO user_screens VALUES ('synthetic', 'retornosScreen')")
        self.assertEqual(namespace['require_retornos'](self.db, handler), user)
        self.db.execute('DELETE FROM user_screens')
        user['role'] = 'admin'
        self.assertEqual(namespace['require_retornos'](self.db, handler), user)
        namespace['require_user'] = lambda db, handler: None
        self.assertIsNone(namespace['require_retornos'](self.db, handler))

    def test_history_and_incidents_deduplicate(self):
        retornos.store(self.db, self.file, self.details)
        retornos.store(self.db, self.file, self.details)
        detail = retornos.detail(self.db, '11346')
        self.assertEqual(len(detail['history']), 1)
        self.assertEqual(self.states(), ['open', 'open'])

    def test_timeout_preserves_details_and_incidents(self):
        retornos.store(self.db, self.file, self.details)
        retornos.store(self.db, self.processed, error='timeout')
        detail = retornos.detail(self.db, '11346')
        self.assertEqual(detail['details'], self.details)
        self.assertEqual(detail['file']['detailError'], 'timeout')
        self.assertEqual(self.states(), ['open', 'open'])

    def test_processed_with_errors_not_resolved(self):
        retornos.store(self.db, self.file, self.details)
        retornos.store(self.db, self.processed, self.details)
        self.assertEqual(self.states(), ['open', 'open'])

    def test_missing_row_not_resolved(self):
        retornos.store(self.db, self.file, self.details)
        retornos.store(self.db, self.processed, {**self.details, 'rows': []})
        self.assertEqual(self.states(), ['open', 'open'])

    def test_unknown_client_not_resolved(self):
        line = {**self.line, 'client': ''}
        retornos.store(self.db, self.file, {**self.details, 'rows': [line]})
        retornos.store(self.db, self.processed, {**self.details, 'rows': [{**line, 'severity': 'success'}]})
        self.assertIn('open', self.states())

    def test_warning_blocks_resolution(self):
        retornos.store(self.db, self.file, self.details)
        retornos.store(self.db, self.processed, {**self.details, 'rows': [self.success, {**self.line, 'severity': 'warning'}]})
        self.assertEqual(self.states(), ['open', 'open'])

    def test_other_lote_does_not_resolve(self):
        retornos.store(self.db, self.file, self.details)
        retornos.store(self.db, {**self.processed, 'id': '11347'}, {**self.details, 'rows': [self.success]})
        self.assertEqual(self.states(), ['open', 'open'])

    def cross_lote(self):
        amounts = {'dueDate': '10/11/2026', 'paymentDate': '10/11/2026', 'value': '687,30',
                   'paid': '687,30', 'fine': '0,00', 'discount': '0,00', 'fee': '1,83'}
        original = {**self.line, **amounts}
        corrected = {**self.success, **amounts, 'installment': '322581'}
        later = {**self.processed, 'id': '11365', 'processedAt': '11/11/2026 15:56:01'}
        retornos.store(self.db, self.file, {**self.details, 'rows': [original]})
        return original, corrected, later

    def test_cross_lote_changed_installment_resolved_with_evidence(self):
        original, corrected, later = self.cross_lote()
        retornos.store(self.db, later, {**self.details, 'rows': [corrected]})
        retornos.reconcile(self.db, at='2026-11-11T19:10:00+00:00')
        self.assertEqual(self.states(), ['resolved', 'resolved'])
        result = retornos.overview(self.db, date(2026, 11, 11), date(2026, 11, 11))
        self.assertEqual(len(result['incidents']), 1)
        incident = result['incidents'][0]
        self.assertEqual(incident['line'], original)
        self.assertEqual(incident['resolution']['loteId'], '11365')
        self.assertEqual(incident['resolution']['line']['installment'], '322581')
        self.assertEqual(retornos.detail(self.db, '11346')['history'][0]['details']['rows'], [original])
        retornos.store(self.db, self.file, {**self.details, 'rows': [original]})
        retornos.reconcile(self.db)
        self.assertEqual(self.states(), ['resolved', 'resolved'])
        self.assertEqual(retornos.overview(self.db, date(2026, 11, 11), date(2026, 11, 11))['incidents'][0]['resolvedAt'], incident['resolvedAt'])

    def test_cross_lote_requires_matching_family(self):
        original, corrected, later = self.cross_lote()
        for key in ('filename', 'service', 'type', 'nsa', 'agreement'):
            with self.subTest(key=key):
                retornos.store(self.db, {**later, 'id': str(12000 + len(key)), key: 'other'}, {**self.details, 'rows': [corrected]})
                retornos.reconcile(self.db)
                self.assertEqual(self.states(), ['open', 'open'])

    def test_cross_lote_requires_complete_matching_title(self):
        original, corrected, later = self.cross_lote()
        retornos.store(self.db, later, {**self.details, 'rows': [{**corrected, 'value': 'different', 'paid': 'different'}]})
        retornos.reconcile(self.db)
        self.assertEqual(self.states(), ['resolved', 'resolved'])

    def test_cross_lote_requires_later_processing(self):
        original, corrected, later = self.cross_lote()
        for when in ('10/11/2026 15:56:01', self.file['processedAt']):
            self.db.execute("DELETE FROM retornos_files WHERE id='11365'")
            retornos.store(self.db, {**later, 'processedAt': when}, {**self.details, 'rows': [corrected]})
            retornos.reconcile(self.db)
            self.assertEqual(self.states(), ['open', 'open'])

    def test_cross_lote_latest_failure_blocks_older_success(self):
        original, corrected, later = self.cross_lote()
        retornos.store(self.db, later, {**self.details, 'rows': [corrected]})
        newer = {**later, 'id': '11366', 'processedAt': '11/11/2026 16:00:00'}
        retornos.store(self.db, newer, error='timeout')
        retornos.reconcile(self.db)
        self.assertEqual(self.states(), ['open', 'open'])

    def test_cross_lote_ambiguous_rows_or_warnings_block_resolution(self):
        original, corrected, later = self.cross_lote()
        for severity in ('success', 'error', 'warning', 'info'):
            retornos.store(self.db, later, {**self.details, 'rows': [corrected, {**corrected, 'severity': severity, 'installment': 'other'}]})
            retornos.reconcile(self.db)
            self.assertEqual(self.states(), ['open', 'open'])
        retornos.store(self.db, self.file, {**self.details, 'rows': [original, {**original, 'installment': 'other'}]})
        retornos.store(self.db, later, {**self.details, 'rows': [corrected]})
        retornos.reconcile(self.db)
        self.assertTrue(all(state == 'open' for state in self.states()))

    def test_cross_lote_does_not_use_stale_details_after_metadata_change(self):
        original, corrected, later = self.cross_lote()
        retornos.store(self.db, {**later, 'processedAt': '10/11/2026 15:56:01'}, {**self.details, 'rows': [corrected]})
        retornos.store(self.db, later)
        retornos.reconcile(self.db)
        self.assertEqual(self.states(), ['open', 'open'])
        self.assertTrue(retornos.detail(self.db, later['id'])['file']['detailError'])

    def test_cross_lote_independent_of_storage_order(self):
        original, corrected, later = self.cross_lote()
        self.db.execute('DELETE FROM retornos_incidents')
        retornos.store(self.db, later, {**self.details, 'rows': [corrected]})
        retornos.store(self.db, self.file, {**self.details, 'rows': [original]})
        retornos.reconcile(self.db)
        self.assertEqual(self.states(), ['resolved', 'resolved'])

    def test_cross_lote_equal_timestamp_candidates_are_ambiguous(self):
        original, corrected, later = self.cross_lote()
        retornos.store(self.db, later, {**self.details, 'rows': [corrected]})
        retornos.store(self.db, {**later, 'id': '11366'}, {**self.details, 'rows': [corrected]})
        retornos.reconcile(self.db)
        self.assertEqual(self.states(), ['open', 'open'])

    def test_cross_lote_preserves_error_after_new_failure_in_original(self):
        original, corrected, later = self.cross_lote()
        retornos.store(self.db, later, {**self.details, 'rows': [corrected]})
        retornos.reconcile(self.db)
        retornos.store(self.db, {**self.file, 'processedAt': '11/11/2026 17:00:00'}, {**self.details, 'rows': [original]})
        retornos.reconcile(self.db)
        self.assertEqual(self.states(), ['open', 'open'])

    def test_resolution_and_reopening_preserve_original_snapshot(self):
        retornos.store(self.db, self.file, self.details, at='2026-11-11T10:00:00+00:00')
        retornos.store(self.db, self.processed, {**self.details, 'rows': [self.success]}, at='2026-11-11T10:05:00+00:00')
        self.assertEqual(self.states(), ['resolved', 'resolved'])
        detail = retornos.detail(self.db, '11346')
        self.assertTrue(all(i['resolvedAt'] for i in detail['incidents']))
        self.assertEqual(detail['history'][-1]['details'], self.details)
        retornos.store(self.db, self.file, self.details, at='2026-11-11T10:10:00+00:00')
        self.assertEqual(self.states(), ['open', 'open'])
        self.assertEqual(len(retornos.detail(self.db, '11346')['history']), 3)

    def test_lote_identity_change_rejected(self):
        retornos.store(self.db, self.file, self.details)
        with self.assertRaises(s4e_retornos.s4e.ConnectorError):
            retornos.store(self.db, {**self.file, 'agreement': 'other'}, self.details)
        self.assertEqual(retornos.detail(self.db, '11346')['file']['agreement'], '1000059')

    def test_period_boundary(self):
        start, end = retornos.period({})
        self.assertEqual((end - start).days, 0)
        for payload in [[], {'start': 'bad'}, {'end': (date.today() + timedelta(days=1)).isoformat()},
                        {'start': (date.today() - timedelta(days=31)).isoformat()}]:
            with self.assertRaises((ValueError, TypeError)):
                retornos.period(payload)

    def test_detail_parser_preserves_all_columns(self):
        names = ['Linha', 'Parcela', 'Vencimento', 'Pagamento', 'Valor', 'Multa', 'Desconto', 'Tarifa', 'Pago',
                 'Nosso Número/Cliente', 'Ocorrência', 'Auxiliar']
        header = '<tr><td></td>' + ''.join(f'<td>{n}</td>' for n in names) + '</tr>'
        cells = ['37', '320352', '10/11/2026', '10/11/2026', '687,30', '0,00', '0,00', '1,83', '687,30',
                 '10498077<br/>3909 - MERCANTIL DA ECONOMIA CEARENSE', 'NOSSO NUMERO EXCLUIDO', 'observação']
        first = '<style>ignored</style><table><tr><td><img src="/SYS/imagens/ico_negativo_03_off.gif"/></td></tr></table>'
        row = '<tr><td>' + first + '</td>' + ''.join(f'<td>{v}</td>' for v in cells) + '</tr>'
        page = '<option value="102">NOSSO NUMERO EXCLUIDO</option><table id="GRD_RetornoInstituicaoFinanceiraModal">' + header + row + '</table>'
        details = s4e_retornos.parse_details(page)
        self.assertEqual(len(details['rows']), 1)
        line = details['rows'][0]
        self.assertEqual(line['ourNumber'], '10498077')
        self.assertEqual(line['client'], self.line['client'])
        self.assertEqual(line['severity'], 'error')
        self.assertEqual(line['occurrenceCode'], '102')
        self.assertEqual(line['auxiliary'], 'observação')
        self.assertEqual(line['fee'], '1,83')
        for icon, expected in [('ico_positivo_03.gif', 'success'), ('ico_positivo_05.gif', 'success'), ('ico_negativo_03_on.gif', 'warning')]:
            with self.subTest(icon=icon):
                result = s4e_retornos.parse_details(page.replace('ico_negativo_03_off.gif', icon))
                self.assertEqual(result['rows'][0]['severity'], expected)

    def test_changed_schema_and_paging_rejected(self):
        with self.assertRaises(s4e_retornos.s4e.ConnectorError):
            s4e_retornos.parse_details('<table id="GRD_RetornoInstituicaoFinanceiraModal"><tr><td>Unknown</td></tr></table>')
        header = ['','', 'Serviço', 'Tipo', 'Processamento', 'NSA', 'Convênio', 'Quantidade', 'Valor', 'Arquivo', 'Situação']
        page = '<table id="GRD_RetornoInstituicaoFinanceira"><tr>' + ''.join(f'<td>{x}</td>' for x in header) + '</tr></table>'
        self.assertEqual(s4e_retornos.parse_files(page), [])
        with self.assertRaises(s4e_retornos.s4e.ConnectorError):
            s4e_retornos.parse_files(page + '<a href="Page$2">next</a>')

    def empty_search_page(self):
        return '''COLABORADOR: TESTE [Retorno de Instituição Financeira]
        <form action="./RetornoInstituicaoFinanceira.aspx">
        <input name="TXT_DataInicial" value="12/11/2026">
        <input name="TXT_DataFinal" value="12/11/2026">
        <input name="TXT_Convenio" value=""><input name="BTN_Busca" value="Pesquisar">
        <select name="CMB_TipoPagamento"><option selected="selected" value="-1">--Selecione--</option></select>
        <select name="CMB_Servico"><option selected="selected" value="-1">--Selecione--</option></select>
        <select name="CMB_Situacao"><option selected="selected" value="-1">--Selecione--</option></select>
        <span id="LBL_Arquivos"></span></form>'''

    def test_official_empty_search_without_grid_is_valid(self):
        page = self.empty_search_page()
        self.assertEqual(s4e_retornos.parse_files(page, date(2026, 11, 12), date(2026, 11, 12)), [])
        with self.assertRaises(s4e_retornos.s4e.ConnectorError):
            s4e_retornos.parse_files(page)

    def test_missing_table_requires_all_empty_search_markers(self):
        page = self.empty_search_page()
        changes = [
            ('COLABORADOR:', 'LOGIN:'), ('LBL_Arquivos', 'LBL_Desconhecido'),
            ('./RetornoInstituicaoFinanceira.aspx', './OutraPagina.aspx'),
            ('value="12/11/2026"', 'value="11/11/2026"'),
            ('name="TXT_Convenio" value=""', 'name="TXT_Convenio" value="999"'),
            ('value="Pesquisar"', 'value="Avançar"'),
            ('value="-1"', 'value="1"'), ('<span id="LBL_Arquivos"></span>', '<span id="LBL_Arquivos">Falha</span>'),
            ('name="CMB_Servico"', 'name="OutroControle"'),
        ]
        for old, new in changes:
            with self.subTest(old=old), self.assertRaises(s4e_retornos.s4e.ConnectorError):
                s4e_retornos.parse_files(page.replace(old, new), date(2026, 11, 12), date(2026, 11, 12))

    def test_empty_marker_cannot_hide_bad_grid_login_or_pagination(self):
        page = self.empty_search_page()
        for extra in ('<table id="GRD_RetornoInstituicaoFinanceira"><tr><td>Alterado</td></tr></table>',
                      '<input name="TXT_Senha">', '<a href="Page$2">Próxima</a>'):
            with self.subTest(extra=extra), self.assertRaises(s4e_retornos.s4e.ConnectorError):
                s4e_retornos.parse_files(page + extra, date(2026, 11, 12), date(2026, 11, 12))

    def test_empty_current_day_preserves_existing_incidents_and_checks_previous_days(self):
        retornos.store(self.db, self.file, self.details)
        self.db.commit()
        calls = []
        def files(http, start, end):
            calls.append((start, end))
            return [] if start == date(2026, 11, 12) else [self.file]
        with patch.object(retornos, '_connection', lambda: nullcontext(self.db)), \
             patch.object(retornos, '_busy', lambda: False), \
             patch.object(retornos, '_http', object()), \
             patch.object(retornos, '_state', {'running': True}), \
             patch.object(retornos.source, 'fetch_files', side_effect=files), \
             patch.object(retornos.source, 'fetch_details', return_value=self.details):
            retornos._worker(date(2026, 11, 12), date(2026, 11, 12))
            self.assertEqual(calls, [(date(2026, 11, 12), date(2026, 11, 12)), (date(2026, 11, 11), date(2026, 11, 11))])
            self.assertEqual(self.states(), ['open', 'open'])
            result = retornos.overview(self.db, date(2026, 11, 12), date(2026, 11, 12))
            self.assertIsNotNone(result['period']['checkedAt'])
            self.assertEqual(result['monitor']['error'], '')

    def test_period_filters_only_errors_without_duplicate_file_alert(self):
        retornos.store(self.db, self.file, self.details)
        other = {**self.processed, 'id': '11347', 'type': 'Outra instituição', 'processedAt': '10/11/2026 09:00:00'}
        retornos.store(self.db, other, self.details)
        good = {**self.processed, 'id': '11348', 'type': 'Sem erro'}
        retornos.store(self.db, good, {**self.details, 'rows': [self.success]})
        result = retornos.overview(self.db, date(2026, 11, 11), date(2026, 11, 11))
        self.assertEqual(len(result['incidents']), 1)
        self.assertEqual(result['incidents'][0]['loteId'], '11346')
        self.assertNotIn('files', result)
        self.assertIn('Sem erro', result['institutions'])
        self.assertEqual(result['globalOpen'], 2)
        both = retornos.overview(self.db, date(2026, 11, 10), date(2026, 11, 11))
        self.assertEqual(len(both['incidents']), 2)

    def test_resolved_error_stays_in_original_period(self):
        retornos.store(self.db, self.file, self.details)
        later = {**self.processed, 'processedAt': '12/11/2026 09:00:00'}
        retornos.store(self.db, later, {**self.details, 'rows': [self.success]})
        original = retornos.overview(self.db, date(2026, 11, 11), date(2026, 11, 11))
        self.assertEqual(len(original['incidents']), 1)
        self.assertEqual(original['incidents'][0]['state'], 'resolved')
        self.assertEqual(original['incidents'][0]['processedAt'], self.file['processedAt'])

    def test_worker_reads_all_institutions_not_only_rejected_file(self):
        files = [self.file, {**self.processed, 'id': '11347', 'type': 'Outra instituição'}, {**self.processed, 'id': '11348', 'type': 'Sem erro'}]
        def details(http, lote_id):
            return self.details if lote_id != '11348' else {**self.details, 'rows': [self.success]}
        with patch.object(retornos, '_connection', lambda: nullcontext(self.db)), \
             patch.object(retornos, '_busy', lambda: False), \
             patch.object(retornos, '_http', object()), \
             patch.object(retornos, '_state', {'running': True}), \
             patch.object(retornos.source, 'fetch_files', return_value=files), \
             patch.object(retornos.source, 'fetch_details', side_effect=details) as fetch:
            retornos._worker(date(2026, 11, 11), date(2026, 11, 11))
            self.assertEqual(fetch.call_count, 3)
            result = retornos.overview(self.db, date(2026, 11, 11), date(2026, 11, 11))
            self.assertEqual(len(result['incidents']), 2)
            self.assertIsNotNone(result['period']['checkedAt'])

    def test_scheduler_enabled_and_busy(self):
        for enabled, busy, expected_calls in [(1, False, 1), (0, False, 0), (1, True, 0)]:
            self.db.execute('UPDATE retornos_control SET enabled=? WHERE id=1', (enabled,))
            with self.subTest(enabled=enabled, busy=busy), \
                 patch.object(retornos, '_connection', lambda: nullcontext(self.db)), \
                 patch.object(retornos, '_busy', lambda: busy), \
                 patch.object(retornos, '_state', {'running': False, 'nextCheck': None}), \
                 patch.object(retornos, 'start_sync') as start, \
                 patch.object(retornos.time, 'sleep', side_effect=[None, KeyboardInterrupt]):
                with self.assertRaises(KeyboardInterrupt):
                    retornos.scheduler()
                self.assertEqual(start.call_count, expected_calls)

    def test_admin_only(self):
        import portal_server
        class Handler:
            def send_json(self, payload, status):
                self.status = status
        handler = Handler()
        with patch.object(portal_server, 'require_user', return_value={'role': 'member'}):
            self.assertIsNone(portal_server.require_admin(self.db, handler))
        self.assertEqual(handler.status, 403)
        with patch.object(portal_server, 'require_user', return_value={'role': 'admin'}):
            self.assertEqual(portal_server.require_admin(self.db, handler)['role'], 'admin')

    def test_query_only_submits_search_fields(self):
        class Fake:
            def get(self, path, timeout):
                return b'<input name="TXT_DataInicial"><input name="BTN_Busca"><input name="TXT_Acao" value="4"><input name="GRD_CHK_ID" value="11346"><input name="__EVENTTARGET" value="BTN_Acao">', {}

            def post(self, path, fields, timeout):
                self.fields = fields
                return b'<table id="GRD_RetornoInstituicaoFinanceira"></table>', {}
        http = Fake()
        with patch.object(s4e_retornos, 'parse_files', return_value=[]):
            s4e_retornos.fetch_files(http, date.today(), date.today())
        self.assertNotIn('TXT_Acao', http.fields)
        self.assertNotIn('GRD_CHK_ID', http.fields)
        self.assertEqual(http.fields['__EVENTTARGET'], '')
        self.assertEqual(http.fields['BTN_Busca'], 'Pesquisar')


if __name__ == '__main__':
    unittest.main()
