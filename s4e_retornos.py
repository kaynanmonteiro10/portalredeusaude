import html
import re
import unicodedata
from html.parser import HTMLParser

import s4e_connector as s4e

LIST_PATH = '/SYS/Faturamento/RetornoInstituicaoFinanceira.aspx'
DETAIL_PATH = '/SYS/Faturamento/RetornoInstituicaoFinanceiraModal.aspx'


def normalized(value):
    return ''.join(c for c in unicodedata.normalize('NFD', str(value)) if not unicodedata.combining(c)).casefold().strip()


class ReturnTableParser(HTMLParser):
    def __init__(self, table_id):
        super().__init__(convert_charrefs=True)
        self.table_id = table_id
        self.depth = 0
        self.row = None
        self.cell = None
        self.rows = []
        self.ignore = 0
        self.found = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'table':
            if self.depth:
                self.depth += 1
            elif attrs.get('id') == self.table_id:
                self.depth = 1
                self.found = True
        if not self.depth:
            return
        if tag in ('script', 'style'):
            self.ignore += 1
        elif tag == 'tr' and self.depth == 1:
            self.row = []
        elif tag in ('td', 'th') and self.depth == 1 and self.row is not None:
            self.cell = {'text': '', 'images': [], 'title': ''}
        elif tag == 'br' and self.cell is not None:
            self.cell['text'] += '\n'
        elif tag == 'img' and self.cell is not None:
            self.cell['images'].append(attrs.get('src', '').rsplit('/', 1)[-1])
        elif tag == 'label' and self.cell is not None:
            self.cell['title'] = attrs.get('title', '')

    def handle_endtag(self, tag):
        if not self.depth:
            return
        if tag in ('script', 'style'):
            self.ignore = max(0, self.ignore - 1)
        elif tag in ('td', 'th') and self.depth == 1 and self.cell is not None:
            self.row.append(self.cell)
            self.cell = None
        elif tag == 'tr' and self.depth == 1 and self.row is not None:
            self.rows.append(self.row)
            self.row = None
        elif tag == 'table':
            self.depth -= 1

    def handle_data(self, data):
        if self.cell is not None and not self.ignore:
            self.cell['text'] += data


def _texts(cells):
    return [re.sub(r'\s+', ' ', cell['text']).strip() for cell in cells]


def _checked_page(raw, headers):
    page = s4e._decode(raw, headers)
    if s4e._looks_logged_out(page) or 'TXT_CPF' in s4e._parse_inputs(page):
        raise s4e.ConnectorError('A sessão do S4E expirou. A consulta será repetida sem alterar os retornos.')
    return page


def _confirmed_empty_files(page, start, end):
    if start is None or end is None or not s4e._session_name(page) or s4e._looks_logged_out(page):
        return False
    inputs = s4e._parse_inputs(page)
    if inputs.get('TXT_DataInicial') != start.strftime('%d/%m/%Y') or inputs.get('TXT_DataFinal') != end.strftime('%d/%m/%Y'):
        return False
    if inputs.get('BTN_Busca') != 'Pesquisar' or inputs.get('TXT_Convenio') != '':
        return False
    forms = re.findall(r'<form\b[^>]*\baction=["\']([^"\']+)["\']', page, re.I)
    if './RetornoInstituicaoFinanceira.aspx' not in forms:
        return False
    if not re.search(r'<span\b[^>]*\bid=["\']LBL_Arquivos["\'][^>]*>\s*</span>', page, re.I):
        return False
    for name in ('CMB_TipoPagamento', 'CMB_Servico', 'CMB_Situacao'):
        select = re.search(r'<select\b[^>]*\bname=["\']' + name + r'["\'][^>]*>(.*?)</select>', page, re.I | re.S)
        if not select:
            return False
        selected = re.findall(r'<option\b[^>]*\bselected\s*=\s*["\']selected["\'][^>]*>', select.group(1), re.I)
        if len(selected) != 1 or not re.search(r'\bvalue=["\']-1["\']', selected[0], re.I):
            return False
    return True


def parse_files(page, start=None, end=None):
    parser = ReturnTableParser('GRD_RetornoInstituicaoFinanceira')
    parser.feed(page)
    header = False
    files = []
    expected = ['servico', 'tipo', 'processamento', 'nsa', 'convenio', 'quantidade', 'valor', 'arquivo', 'situacao']
    for cells in parser.rows:
        texts = _texts(cells)
        if len(texts) == 11 and [normalized(x) for x in texts[2:]] == expected:
            header = True
            continue
        if len(texts) != 11 or not texts[1].isdigit():
            continue
        if not header:
            raise s4e.ConnectorError('As colunas da lista de retornos do S4E não foram reconhecidas.')
        keys = ['id', 'service', 'type', 'processedAt', 'nsa', 'agreement', 'quantity', 'value', 'filename', 'status']
        item = dict(zip(keys, texts[1:]))
        item['filename'] = cells[9]['title'] or item['filename']
        files.append(item)
    if re.search(r'Page\$\d+', page):
        raise s4e.ConnectorError('O S4E paginou a consulta de retornos. Selecione um período menor para não omitir arquivos.')
    if not header:
        if not parser.found and _confirmed_empty_files(page, start, end):
            return []
        raise s4e.ConnectorError('O S4E não devolveu a tabela de retornos esperada; os dados anteriores foram preservados.')
    return files


def parse_details(page):
    parser = ReturnTableParser('GRD_RetornoInstituicaoFinanceiraModal')
    parser.feed(page)
    header = None
    rows = []
    totals = {}
    codes = {}
    for value, text in re.findall(r'<option\b[^>]*value=["\']([^"\']*)["\'][^>]*>([^<]*)</option>', page, re.I):
        codes[normalized(html.unescape(text))] = value
    expected = ['linha', 'parcela', 'vencimento', 'pagamento', 'valor', 'multa', 'desconto', 'tarifa', 'pago', 'nosso numero/cliente', 'ocorrencia', 'auxiliar']
    for cells in parser.rows:
        texts = _texts(cells)
        if len(texts) == 13 and [normalized(x) for x in texts[1:]] == expected:
            header = texts[1:]
            continue
        if len(texts) != 13:
            continue
        if not header:
            raise s4e.ConnectorError('As colunas dos detalhes do retorno não foram reconhecidas.')
        if not texts[1].isdigit():
            if not texts[1] and texts[5]:
                totals = dict(zip(['value', 'fine', 'discount', 'fee', 'paid'], texts[5:10]))
            continue
        keys = ['line', 'installment', 'dueDate', 'paymentDate', 'value', 'fine', 'discount', 'fee', 'paid']
        item = dict(zip(keys, texts[1:10]))
        client_parts = [re.sub(r'\s+', ' ', part).strip() for part in cells[10]['text'].splitlines() if part.strip()]
        item.update(ourNumber=client_parts[0] if client_parts else '', client=' '.join(client_parts[1:]),
                    occurrence=texts[11], auxiliary=texts[12])
        images = cells[0]['images']
        if 'ico_negativo_03_off.gif' in images:
            severity = 'error'
        elif 'ico_negativo_03_on.gif' in images:
            severity = 'warning'
        elif 'ico_positivo_03.gif' in images or 'ico_positivo_05.gif' in images:
            severity = 'success'
        else:
            severity = 'info'
        item.update(severity=severity, occurrenceCode=codes.get(normalized(item['occurrence']), ''))
        rows.append(item)
    if header is None or re.search(r'Page\$\d+', page):
        raise s4e.ConnectorError('Os detalhes completos do retorno não foram confirmados; nenhuma resolução foi registrada.')
    return {'headers': header, 'rows': rows, 'totals': totals}


def open_session(credentials):
    if not credentials:
        raise s4e.ConnectorError('Nenhuma conta do S4E configurada no portal.')
    http_session = s4e.S4EHttp()
    raw, headers = http_session.get(s4e.LOGIN_PATH, timeout=45)
    fields = s4e._parse_inputs(s4e._decode(raw, headers))
    if 'TXT_CPF' not in fields:
        raise s4e.ConnectorError('A tela de login do S4E não foi reconhecida.')
    fields.update(CMB_Tipo='5', TXT_CPF=re.sub(r'\D', '', credentials[0]), TXT_Senha=credentials[1],
                  BTN_Avancar=fields.get('BTN_Avancar') or 'Avançar')
    raw, headers = http_session.post('/SYS/Login.aspx', fields, timeout=60)
    _checked_page(raw, headers)
    raw, headers = http_session.get(LIST_PATH, timeout=45)
    page = _checked_page(raw, headers)
    if not s4e._session_name(page):
        raise s4e.ConnectorError('O S4E não confirmou o acesso aos retornos com a conta configurada.')
    return http_session


def fetch_files(http_session, start, end):
    raw, headers = http_session.get(LIST_PATH, timeout=45)
    page = _checked_page(raw, headers)
    inputs = s4e._parse_inputs(page)
    if 'TXT_DataInicial' not in inputs or 'BTN_Busca' not in inputs:
        raise s4e.ConnectorError('O formulário de consulta dos retornos não foi reconhecido.')
    fields = {key: value for key, value in inputs.items() if key.startswith('__')}
    fields.update(__EVENTTARGET='', __EVENTARGUMENT='', TXT_DataInicial=start.strftime('%d/%m/%Y'),
                  TXT_DataFinal=end.strftime('%d/%m/%Y'), TXT_Convenio='', CMB_TipoPagamento='-1',
                  CMB_Servico='-1', CMB_Situacao='-1', BTN_Busca='Pesquisar')
    raw, headers = http_session.post(LIST_PATH, fields, timeout=60)
    return parse_files(_checked_page(raw, headers), start, end)


def fetch_details(http_session, lote_id):
    if not re.fullmatch(r'[0-9]+', str(lote_id)):
        raise s4e.ConnectorError('Identificador de lote inválido.')
    raw, headers = http_session.get(f'{DETAIL_PATH}?ID={lote_id}&Modal=1', timeout=45)
    return parse_details(_checked_page(raw, headers))
