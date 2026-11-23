import copy
import json
import sqlite3
import unittest
from contextlib import nullcontext
from datetime import date, timedelta
from unittest.mock import patch

import s4e_vendas as source
import vendas


def grid(headers, rows=(), table_id='GRD_Resultado'):
    return f'<table id="{table_id}"><tr>' + ''.join(f'<th>{value}</th>' for value in headers) + '</tr>' + ''.join('<tr>' + ''.join(f'<td>{value}</td>' for value in row) + '</tr>' for row in rows) + '</table>'


def summary():
    sale = source.SELLER_PATH + '?modal=1&cd_Equipe=35&dt_ini=01/11/2026&dt_fim=11/11/2026'
    cancel = source.CANCELLED_PATH + '?modal=1&cd_Equipe=35&dt_ini=01/11/2026&dt_fim=11/11/2026'
    header = ['Equipe', 'Vidas', 'Contratos', 'Valor', 'Valor Médio', 'Vidas Canceladas', 'Valor Cancelado', 'Valor Médio Cancelado']
    row = ['Equipe teste', f'<a onclick="FF_ModalIframe(\'{sale}\',0)">1</a>', '1', '27,00', '27,00', f'<a onclick="FF_ModalIframe(\'{cancel}\',0)">1</a>', '27,00', '27,00']
    total = ['TOTAL', row[1].replace('cd_Equipe=35', 'cd_Equipe=0'), '1', '27,00', '27,00', row[5].replace('cd_Equipe=35', 'cd_Equipe=0'), '27,00', '27,00']
    page = grid(header, [row, total])
    for table_id, label in [('GRD_ResultadoPlano', 'Plano'), ('GRD_ResultadoTipoPAgamento', 'Tipo de Pagamento'),
                            ('GRD_ResumoSituacao', 'Situação no Período Informado'), ('GRD_ResumoSituacaoAtual', 'Situação Atual'),
                            ('GRD_ResultadoTipoEmpresa', 'Tipo de Empresa'), ('GRD_ResumoEstado', 'Estado'), ('GRD_ResumoCidade', 'Cidade')]:
        page += grid([label, 'Vidas', 'Valor', '%'], [['Teste', '1', '27,00', '100,00']], table_id)
    return page


def seller_page():
    link = ' RelatorioVendaContratoPorAssociado.aspx?modal=1&vendedor=123&nome=Vendedor&cd_equipe=35&dt_ini=01/11/2026&dt_fim=11/11/2026'
    return grid(['Vendedor', 'Equipe', 'Contratos', 'Vidas', 'Valor'], [[f'<a href="{link}">Vendedor</a>', 'Equipe teste', '1', '1', '27,00']])


def sales_page():
    return grid(['Data Cadastro', 'Lote', 'Responsavel', 'Cliente', 'Situação', 'Valor', 'Empresa', 'Comissao'],
                [['03/11/2026', '8272', '731940 - Responsável', 'Cliente &amp; teste', 'ATIVO', '27,00', 'Empresa teste', '<table><tr><td>Comissão Não gerada</td></tr></table>'],
                 ['VIDAS', '1', '', '', 'TOTAL', '27,00', '', '']])


def cancelled_page():
    return grid(['Vendedor', 'Responsavel', 'Cliente', 'Data Assinatura', 'Data Cancelamento', 'Valor', 'Plano', 'Empresa', 'Motivo', 'Telefone', 'Dentista'],
                [['', '731940 - Responsável', 'Cliente &amp; teste', '01/10/2026', '04/11/2026', '27,00', 'Plano teste', 'Empresa teste', 'RESCISAO DE CONTRATO', '', '']])


class SalesTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.execute('CREATE TABLE contract_companies(id TEXT PRIMARY KEY,name TEXT,cnpj TEXT,seller TEXT,monthly_value REAL)')
        self.db.execute("INSERT INTO contract_companies VALUES('company1','Empresa teste','11.111.111/0001-11','Vendedor',100)")
        self.db.execute("INSERT INTO contract_companies VALUES('company2','Empresa teste','22.222.222/0001-22','Outro',200)")
        vendas.ensure_schema(self.db)
        self.start, self.end = date(2026, 11, 1), date(2026, 11, 11)
        teams, breakdowns = source.parse_summary(summary())
        seller = source.parse_sellers(seller_page())[0]
        rows = source.parse_records(sales_page(), teams[0], seller)
        self.payload = {'teams': teams, 'breakdowns': breakdowns, 'rows': rows}

    def tearDown(self):
        self.db.close()

    def test_summary_links_and_breakdowns(self):
        self.assertEqual(len(self.payload['teams']), 1)
        self.assertEqual(self.payload['teams'][0]['teamId'], '35')
        self.assertEqual(len(self.payload['breakdowns']), 7)
        self.assertEqual(self.payload['teams'][0]['contracts'], '1')

    def test_sales_parser_preserves_official_commission_and_skips_totals(self):
        rows = self.payload['rows']
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['responsibleId'], '731940')
        self.assertEqual(rows[0]['client'], 'Cliente & teste')
        self.assertEqual(rows[0]['commission'], 'Comissão Não gerada')
        self.assertNotIn('paidCommission', rows[0])

    def test_cancelled_has_actual_cancellation_date_and_reason(self):
        record = source.parse_records(cancelled_page(), self.payload['teams'][0], cancelled=True)[0]
        self.assertEqual(record['kind'], 'cancelled')
        self.assertEqual(record['cancelledAt'], '04/11/2026')
        self.assertEqual(record['reason'], 'RESCISAO DE CONTRATO')
        self.assertEqual(record['seller'], '')
        self.assertEqual(record['linkKey'], self.payload['rows'][0]['linkKey'])

    def test_schema_changes_rejected(self):
        with self.assertRaises(source.s4e.ConnectorError):
            source.parse_records(sales_page().replace('Data Cadastro', 'Changed'), self.payload['teams'][0], {'sellerId': '1', 'seller': 'Teste'})
        with self.assertRaises(source.s4e.ConnectorError):
            source.parse_summary(summary().replace('GRD_ResumoCidade', 'Missing'))

    def test_login_and_pagination_not_treated_as_empty(self):
        for page in ['<input name="TXT_CPF">', '<a href="Page$2">2</a>']:
            with self.assertRaises(source.s4e.ConnectorError):
                source.checked_page(page.encode(), {})

    def test_link_validation_blocks_other_hosts_actions_and_duplicate_parameters(self):
        for link in ['https://evil.test' + source.CLIENT_PATH, '//evil.test' + source.CLIENT_PATH,
                     source.CLIENT_PATH + '?acao=4', source.CLIENT_PATH + '?vendedor=1&vendedor=2',
                     '/SYS/Cadastro/Delete.aspx', source.CLIENT_PATH + '#action']:
            with self.subTest(link=link), self.assertRaises(source.s4e.ConnectorError):
                source.report_link(link, source.SELLER_PATH, source.CLIENT_PATH)

    def test_period_defaults_month_and_validates_boundary(self):
        start, end = vendas.period({})
        self.assertEqual(start, date.today().replace(day=1))
        self.assertEqual(end, date.today())
        for payload in [[], {'start': 'bad'}, {'end': (date.today() + timedelta(days=1)).isoformat()},
                        {'start': '2026-09-01', 'end': '2026-10-02'}, {'start': '2026-11-11', 'end': '2026-11-10'}]:
            with self.assertRaises((ValueError, TypeError)):
                vendas.period(payload)

    def test_snapshot_history_and_period_separation(self):
        first = vendas.store(self.db, self.start, self.end, self.payload)
        self.assertEqual(vendas.store(self.db, self.start, self.end, self.payload), first)
        changed = copy.deepcopy(self.payload)
        changed['rows'][0]['status'] = 'ATRASADO'
        second = vendas.store(self.db, self.start, self.end, changed)
        self.assertNotEqual(first, second)
        self.assertEqual(json.loads(self.db.execute('SELECT payload FROM vendas_snapshots WHERE id=?', (first,)).fetchone()[0])['rows'][0]['status'], 'ATIVO')
        self.assertIsNone(vendas.overview(self.db, date(2026, 11, 10), date(2026, 11, 10))['snapshot'])

    def test_no_automatic_link_by_name(self):
        vendas.store(self.db, self.start, self.end, self.payload)
        row = vendas.overview(self.db, self.start, self.end)['snapshot']['rows'][0]
        self.assertIsNone(row['companyId'])
        self.assertIsNone(row['linkedCompany'])

    def test_confirmed_link_is_shared_by_source_identity_not_names(self):
        record = source.parse_records(cancelled_page(), self.payload['teams'][0], cancelled=True)[0]
        self.payload['rows'].append(record)
        snapshot_id = vendas.store(self.db, self.start, self.end, self.payload)
        original_contracts = [tuple(row) for row in self.db.execute('SELECT * FROM contract_companies')]
        vendas.confirm_link(self.db, {'linkKey': record['linkKey'], 'companyId': 'company1', 'snapshotId': snapshot_id}, 'admin1')
        rows = vendas.overview(self.db, self.start, self.end)['snapshot']['rows']
        self.assertTrue(all(row['companyId'] == 'company1' for row in rows))
        self.assertEqual([tuple(row) for row in self.db.execute('SELECT * FROM contract_companies')], original_contracts)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM vendas_link_history').fetchone()[0], 1)

    def test_invalid_and_stale_links_rejected(self):
        snapshot_id = vendas.store(self.db, self.start, self.end, self.payload)
        valid = {'linkKey': self.payload['rows'][0]['linkKey'], 'companyId': 'company1', 'snapshotId': snapshot_id}
        for payload in [[], {**valid, 'linkKey': 'unknown'}, {**valid, 'companyId': 'missing'}, {**valid, 'snapshotId': True}, {**valid, 'snapshotId': 9999}]:
            with self.assertRaises((ValueError, TypeError)):
                vendas.confirm_link(self.db, payload, 'admin1')
        changed = copy.deepcopy(self.payload)
        changed['rows'][0]['status'] = 'ATRASADO'
        vendas.store(self.db, self.start, self.end, changed)
        with self.assertRaises(ValueError):
            vendas.confirm_link(self.db, valid, 'admin1')

    def test_deleting_contract_keeps_link_audit_without_blocking_deletion(self):
        snapshot_id = vendas.store(self.db, self.start, self.end, self.payload)
        vendas.confirm_link(self.db, {'linkKey': self.payload['rows'][0]['linkKey'], 'companyId': 'company1', 'snapshotId': snapshot_id}, 'admin1')
        self.db.execute("DELETE FROM contract_companies WHERE id='company1'")
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM vendas_links').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM vendas_link_history').fetchone()[0], 1)

    def test_failed_worker_preserves_complete_snapshot(self):
        snapshot_id = vendas.store(self.db, self.start, self.end, self.payload)
        with patch.object(vendas, '_connection', lambda: nullcontext(self.db)), patch.object(vendas, '_credentials', lambda: ('x', 'y')), \
             patch.object(vendas, '_job', {'running': True}), patch.object(vendas.source, 'open_session', return_value=object()), \
             patch.object(vendas.source, 'fetch_sales', side_effect=TimeoutError('timeout')):
            vendas.worker(self.start, self.end)
            self.assertFalse(vendas.job_status()['running'])
            self.assertEqual(vendas.overview(self.db, self.start, self.end)['snapshot']['id'], snapshot_id)
            self.assertIn('timeout', vendas.job_status()['error'])

    def test_concurrent_query_and_busy_rejected(self):
        with patch.object(vendas, '_busy', lambda: True):
            with self.assertRaises(source.s4e.ConnectorError):
                vendas.start_query(self.start, self.end)
        with patch.object(vendas, '_busy', lambda: False), patch.object(vendas, '_job', {'running': True}):
            with self.assertRaises(source.s4e.ConnectorError):
                vendas.start_query(self.start, self.end)

    def test_search_posts_only_read_only_search_fields(self):
        class Session:
            def get(inner, path, timeout):
                if 'PorVendedor' in path:
                    return seller_page().encode(), {'Content-Type': 'text/html;charset=utf-8'}
                if 'PorAssociado' in path:
                    return sales_page().encode(), {'Content-Type': 'text/html;charset=utf-8'}
                if 'Cancelados' in path:
                    return cancelled_page().encode(), {'Content-Type': 'text/html;charset=utf-8'}
                return b'<input name="__VIEWSTATE" value="test"><input name="TXT_DataInicial"><input name="BTN_Avancar"><input name="BTN_Acao" value="Alterar"><input name="TXT_Acao" value="4"><input name="CHK_Plano$0" value="1">', {}

            def post(inner, path, fields, timeout):
                inner.fields = fields
                return summary().encode(), {'Content-Type': 'text/html;charset=utf-8'}
        session = Session()
        data = source.fetch_sales(session, self.start, self.end, lambda *args: None)
        self.assertEqual(len(data['rows']), 2)
        self.assertEqual(session.fields['BTN_Avancar'], 'Buscar')
        self.assertNotIn('BTN_Acao', session.fields)
        self.assertNotIn('TXT_Acao', session.fields)
        self.assertFalse(any(key.startswith('CHK_') for key in session.fields))
        self.assertEqual(session.fields['__EVENTTARGET'], '')

    def test_sales_routes_are_admin_only(self):
        import portal_server as portal
        class Handler:
            path = '/api/vendas?start=2026-11-01&end=2026-11-11'
            def send_json(self, payload, status=200):
                self.status = status
        handler = Handler()
        with patch.object(portal, 'connection', lambda: nullcontext(self.db)), patch.object(portal, 'deny_if_locked', return_value=False), \
             patch.object(portal, 'require_user', return_value={'role': 'member'}):
            portal.PortalHandler.do_GET(handler)
            self.assertEqual(handler.status, 403)
            handler.path = '/api/vendas/consultar'
            portal.PortalHandler.do_POST(handler)
            self.assertEqual(handler.status, 403)
            handler.path = '/api/vendas/vinculos'
            with patch.object(portal, 'read_json', return_value={}):
                portal.PortalHandler.do_PUT(handler)
                self.assertEqual(handler.status, 403)


if __name__ == '__main__':
    unittest.main()
