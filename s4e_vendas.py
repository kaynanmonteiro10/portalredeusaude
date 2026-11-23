import hashlib
import html
import json
import re
from datetime import datetime
from urllib.parse import parse_qs, quote, unquote, urljoin, urlsplit

import s4e_connector as s4e
from s4e_retornos import ReturnTableParser, normalized

LIST_PATH = '/SYS/Contratos/Venda Contrato/RelatorioVendaContrato.aspx'
SELLER_PATH = '/SYS/Contratos/Venda Contrato/RelatorioVendaContratoPorVendedor.aspx'
CLIENT_PATH = '/SYS/Contratos/Venda Contrato/RelatorioVendaContratoPorAssociado.aspx'
CANCELLED_PATH = '/SYS/Contratos/Venda Contrato/RelatorioVendaContratoCancelados.aspx'
MAX_REQUESTS = 120
MAX_ROWS = 20000


class SalesTableParser(ReturnTableParser):
    def handle_starttag(self, tag, attrs):
        super().handle_starttag(tag, attrs)
        attrs = dict(attrs)
        if tag in ('td', 'th') and self.depth == 1 and self.cell is not None:
            self.cell['links'] = []
        if tag == 'a' and self.cell is not None:
            target = attrs.get('href', '').strip()
            modal = re.search(r"FF_ModalIframe\(\s*'([^']+)'", attrs.get('onclick', ''))
            if modal:
                target = modal.group(1)
            if target and target != '#':
                self.cell['links'].append(target)


def checked_page(raw, headers):
    page = s4e._decode(raw, headers)
    if s4e._looks_logged_out(page) or 'TXT_CPF' in s4e._parse_inputs(page):
        raise s4e.ConnectorError('A sessão do S4E expirou durante a consulta de vendas.')
    if re.search(r'Page\$\d+', page):
        raise s4e.ConnectorError('O S4E paginou as vendas. Selecione um período menor para não omitir registros.')
    return page


def report_link(value, base, expected):
    value = html.unescape(value).strip()
    if value.startswith('//') or '\\' in value:
        raise s4e.ConnectorError('O S4E forneceu um endereço de relatório não reconhecido.')
    parsed = urlsplit(urljoin(base, value))
    if parsed.scheme or parsed.netloc or unquote(parsed.path) != expected or parsed.fragment:
        raise s4e.ConnectorError('O S4E forneceu um endereço de relatório não reconhecido.')
    query = parse_qs(parsed.query, keep_blank_values=True)
    allowed = {'modal', 'tipo', 'dt_ini', 'dt_fim', 'cd_Equipe', 'Equipe', 'cd_equipe', 'equipe',
               'quant', 'soma', 'quantimport', 'somaimport', 'Plano', 'TipoEmpresa', 'TipoPagamento',
               'Situacao', 'UF', 'Municipio', 'GrupoEmpresa', 'CentroCusto', 'TipoRecebimento',
               'vendedor', 'nome', 'cd_situacao', 'cd_situacao_f'}
    if not set(query).issubset(allowed) or any(len(values) != 1 for values in query.values()):
        raise s4e.ConnectorError('Os parâmetros do relatório de vendas não foram reconhecidos.')
    return expected + ('?' + parsed.query if parsed.query else '')


def table(page, table_id, expected):
    parser = SalesTableParser(table_id)
    parser.feed(page)
    rows = parser.rows
    if not rows or [normalized(cell['text']) for cell in rows[0]] != [normalized(value) for value in expected]:
        raise s4e.ConnectorError(f'As colunas do relatório de vendas ({table_id}) mudaram; os dados anteriores foram preservados.')
    return rows[1:]


def text(cell):
    return re.sub(r'\s+', ' ', cell['text']).strip()


def identifier(value):
    match = re.match(r'^\s*(\d+)\s*-\s*\S', value)
    return match.group(1) if match else ''


def source_key(values):
    return hashlib.sha256(json.dumps(values, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def parse_summary(page):
    expected = ['Equipe', 'Vidas', 'Contratos', 'Valor', 'Valor Médio', 'Vidas Canceladas', 'Valor Cancelado', 'Valor Médio Cancelado']
    teams = []
    for cells in table(page, 'GRD_Resultado', expected):
        if len(cells) != len(expected):
            raise s4e.ConnectorError('Uma linha do resumo de vendas não foi reconhecida.')
        if normalized(text(cells[0])) == 'total':
            continue
        links = [link for cell in cells for link in cell.get('links', [])]
        sale_link = next((link for link in links if SELLER_PATH in unquote(link)), '')
        cancel_link = next((link for link in links if CANCELLED_PATH in unquote(link)), '')
        if not sale_link and not cancel_link:
            continue
        sale_link = report_link(sale_link, LIST_PATH, SELLER_PATH) if sale_link else ''
        cancel_link = report_link(cancel_link, LIST_PATH, CANCELLED_PATH) if cancel_link else ''
        query = parse_qs(urlsplit(sale_link or cancel_link).query)
        team_id = (query.get('cd_Equipe') or query.get('cd_equipe') or [''])[0]
        if not team_id.isdigit():
            raise s4e.ConnectorError('A equipe de vendas não foi identificada pelo S4E.')
        keys = ['team', 'lives', 'contracts', 'value', 'averageValue', 'cancelledLives', 'cancelledValue', 'cancelledAverageValue']
        item = dict(zip(keys, map(text, cells)))
        item.update(teamId=team_id, saleLink=sale_link, cancelledLink=cancel_link)
        teams.append(item)
    breakdowns = {}
    definitions = [('plan', 'GRD_ResultadoPlano', 'Plano'), ('paymentType', 'GRD_ResultadoTipoPAgamento', 'Tipo de Pagamento'),
                   ('periodStatus', 'GRD_ResumoSituacao', 'Situação no Período Informado'),
                   ('currentStatus', 'GRD_ResumoSituacaoAtual', 'Situação Atual'),
                   ('clientType', 'GRD_ResultadoTipoEmpresa', 'Tipo de Empresa'),
                   ('state', 'GRD_ResumoEstado', 'Estado'), ('city', 'GRD_ResumoCidade', 'Cidade')]
    for key, table_id, label in definitions:
        entries = []
        for cells in table(page, table_id, [label, 'Vidas', 'Valor', '%']):
            if len(cells) != 4:
                raise s4e.ConnectorError('Uma linha dos indicadores de vendas não foi reconhecida.')
            entries.append(dict(zip(['label', 'lives', 'value', 'percent'], map(text, cells))))
        breakdowns[key] = entries
    return teams, breakdowns


def parse_sellers(page):
    result = []
    for cells in table(page, 'GRD_Resultado', ['Vendedor', 'Equipe', 'Contratos', 'Vidas', 'Valor']):
        if len(cells) != 5:
            raise s4e.ConnectorError('Uma linha do relatório por vendedor não foi reconhecida.')
        links = [link for cell in cells for link in cell.get('links', []) if 'RelatorioVendaContratoPorAssociado.aspx' in link]
        if not links:
            continue
        if len(set(links)) != 1:
            raise s4e.ConnectorError('O detalhamento de um vendedor ficou ambíguo.')
        link = report_link(links[0], SELLER_PATH, CLIENT_PATH)
        seller_id = parse_qs(urlsplit(link).query).get('vendedor', [''])[0]
        if not seller_id.isdigit():
            raise s4e.ConnectorError('O vendedor não foi identificado pelo S4E.')
        result.append({'sellerId': seller_id, 'seller': text(cells[0]), 'link': link})
    return result


def parse_records(page, team, seller=None, cancelled=False):
    expected = ['Vendedor', 'Responsavel', 'Cliente', 'Data Assinatura', 'Data Cancelamento', 'Valor', 'Plano', 'Empresa', 'Motivo', 'Telefone', 'Dentista'] if cancelled else ['Data Cadastro', 'Lote', 'Responsavel', 'Cliente', 'Situação', 'Valor', 'Empresa', 'Comissao']
    result = []
    for cells in table(page, 'GRD_Resultado', expected):
        values = list(map(text, cells))
        if len(values) != len(expected):
            raise s4e.ConnectorError('Uma linha individual de vendas não foi reconhecida.')
        if cancelled:
            if not values[2] and not values[4]:
                continue
            if not re.fullmatch(r'\d{2}/\d{2}/\d{4}', values[4]):
                raise s4e.ConnectorError('A data de um cancelamento não foi reconhecida.')
            item = dict(zip(['seller', 'responsible', 'client', 'signatureDate', 'cancelledAt', 'value', 'plan', 'company', 'reason', 'phone', 'dentist'], values))
            item.update(kind='cancelled', registeredAt='', batch='', status='Cancelado', commission='', sellerId='')
        else:
            if normalized(values[0]) in ('vidas', 'total', ''):
                continue
            if not re.fullmatch(r'\d{2}/\d{2}/\d{4}', values[0]) or not values[1].isdigit():
                raise s4e.ConnectorError('A data ou o lote de uma venda não foi reconhecido.')
            item = dict(zip(['registeredAt', 'batch', 'responsible', 'client', 'status', 'value', 'company', 'commission'], values))
            item.update(kind='sale', sellerId=seller['sellerId'], seller=seller['seller'], plan='', signatureDate='', cancelledAt='', reason='')
        item.update(teamId=team['teamId'], team=team['team'], responsibleId=identifier(item['responsible']))
        if not item['client']:
            raise s4e.ConnectorError('O cliente de um registro de vendas não foi identificado.')
        item['key'] = source_key([item['kind'], item['teamId'], item['sellerId'], item['registeredAt'], item['batch'],
                                  item['responsible'], item['client'], item['company'], item['signatureDate'], item['cancelledAt'], item['plan']])
        item['linkKey'] = source_key(['responsible', item['responsibleId'], item['company']]) if item['responsibleId'] and item['company'] else item['key']
        result.append(item)
    return result


def open_session(credentials):
    if not credentials:
        raise s4e.ConnectorError('Configure a conta do S4E antes de consultar as vendas.')
    session = s4e.S4EHttp()
    raw, headers = session.get(s4e.LOGIN_PATH, timeout=45)
    inputs = s4e._parse_inputs(s4e._decode(raw, headers))
    if 'TXT_CPF' not in inputs:
        raise s4e.ConnectorError('A tela de login do S4E não foi reconhecida.')
    inputs.update(CMB_Tipo='5', TXT_CPF=re.sub(r'\D', '', credentials[0]), TXT_Senha=credentials[1], BTN_Avancar=inputs.get('BTN_Avancar') or 'Avançar')
    raw, headers = session.post('/SYS/Login.aspx', inputs, timeout=60)
    checked_page(raw, headers)
    return session


def fetch_sales(session, start, end, progress):
    requests = 0
    records = {}

    def get(path):
        nonlocal requests
        requests += 1
        if requests > MAX_REQUESTS:
            raise s4e.ConnectorError('O período exige muitos detalhamentos. Selecione um período menor.')
        return checked_page(*session.get(quote(path, safe='/?=&%'), timeout=60))

    progress('Consultando os resultados de todas as equipes no S4E...', 0, 0)
    page = get(LIST_PATH)
    inputs = s4e._parse_inputs(page)
    if 'TXT_DataInicial' not in inputs or 'BTN_Avancar' not in inputs:
        raise s4e.ConnectorError('O formulário de acompanhamento de vendas mudou.')
    fields = {key: value for key, value in inputs.items() if key.startswith('__')}
    fields.update(__EVENTTARGET='', __EVENTARGUMENT='', TXT_DataInicial=start.strftime('%d/%m/%Y'),
                  TXT_DataFinal=end.strftime('%d/%m/%Y'), Txt_DataIniAux=start.strftime('%d/%m/%Y'),
                  Txt_DataFinAux=end.strftime('%d/%m/%Y'), CMB_EquipeVendas='-1', CMB_UF='-1', CMB_MUNICIPIO='-1',
                  TXT_TipoEmpresa='', TXT_Plano='', TXT_TipoPagamento='', TXT_Situacao='', BTN_Avancar='Buscar')
    page = checked_page(*session.post(quote(LIST_PATH, safe='/'), fields, timeout=90))
    teams, breakdowns = parse_summary(page)
    tasks = []
    for team in teams:
        if team['saleLink']:
            progress(f"Conferindo os vendedores de {team['team']}...", 0, len(teams))
            sellers = parse_sellers(get(team['saleLink']))
            tasks.extend((team, seller, seller['link'], False) for seller in sellers)
        if team['cancelledLink']:
            tasks.append((team, None, team['cancelledLink'], True))
    for index, (team, seller, link, cancelled) in enumerate(tasks):
        description = f"cancelamentos de {team['team']}" if cancelled else f"vendas de {seller['seller']} ({team['team']})"
        progress(f'Conferindo {description}...', index, len(tasks))
        for record in parse_records(get(link), team, seller, cancelled):
            key = record['key']
            if key in records:
                raise s4e.ConnectorError('O S4E retornou registros com identidade repetida; a associação foi interrompida.')
            records[key] = record
            if len(records) > MAX_ROWS:
                raise s4e.ConnectorError('O período excedeu o limite de registros. Selecione um período menor.')
        progress(f'Conferidos {index + 1} de {len(tasks)} detalhamentos.', index + 1, len(tasks))
    for team in teams:
        team.pop('saleLink')
        team.pop('cancelledLink')
    return {'teams': teams, 'breakdowns': breakdowns, 'rows': list(records.values())}
