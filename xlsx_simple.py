"""Gera planilhas .xlsx com a biblioteca padrão (o runtime embarcado não tem openpyxl)."""
import io
import re
import zipfile
from xml.sax.saxutils import escape

_ILLEGAL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


class Money(float):
    pass


class Percent(float):
    pass


def _col(index):
    letters = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


def _text(value):
    return escape(_ILLEGAL.sub("", str(value)))


def _number(value):
    number = float(value)
    if number.is_integer():
        return str(int(number))
    return f"{number:.4f}".rstrip("0").rstrip(".")


def _cell(ref, value, style):
    if value is None:
        return ""
    if isinstance(value, bool):
        value = "Sim" if value else "Não"
    if isinstance(value, (int, float)):
        if isinstance(value, Money):
            style = 3
        elif isinstance(value, Percent):
            style = 4
        return f'<c r="{ref}" s="{style}" t="n"><v>{_number(value)}</v></c>'
    text = _text(value)
    if not text:
        return ""
    return f'<c r="{ref}" s="{style}" t="inlineStr"><is><t xml:space="preserve">{text}</t></is></c>'


def _width(rows, column):
    size = 12
    for row in rows:
        if column < len(row):
            size = max(size, len(str(row[column] or "")))
    return min(48, size + 2)


def _sheet(rows):
    if not rows:
        rows = [[""]]
    last = f"{_col(max(len(row) for row in rows) - 1)}{len(rows)}"
    widths = "".join(
        f'<col min="{index + 1}" max="{index + 1}" width="{_width(rows, index)}" customWidth="1"/>'
        for index in range(max(len(row) for row in rows))
    )
    body = []
    for r, row in enumerate(rows, start=1):
        style = 2 if r == 1 else 0
        cells = "".join(_cell(f"{_col(c)}{r}", value, style) for c, value in enumerate(row))
        body.append(f'<row r="{r}">{"".join(cells)}</row>')
    pane = '<sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView>'
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<dimension ref="A1:{last}"/>'
        f"<sheetViews>{pane}</sheetViews>"
        '<sheetFormatPr defaultRowHeight="15"/>'
        f"<cols>{widths}</cols>"
        f"<sheetData>{''.join(body)}</sheetData>"
        f'<autoFilter ref="A1:{last}"/>'
        "</worksheet>"
    )


def _name(value):
    clean = re.sub(r"[\[\]:*?/\\']", " ", str(value or "")).strip() or "Planilha"
    return clean[:31]


_STYLES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    '<numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;R$&quot; #,##0.00"/>'
    '<numFmt numFmtId="165" formatCode="0.0&quot;%&quot;"/></numFmts>'
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
    '<font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts>'
    '<fills count="3"><fill><patternFill patternType="none"/></fill>'
    '<fill><patternFill patternType="gray125"/></fill>'
    '<fill><patternFill patternType="solid"><fgColor rgb="FF0F3D46"/><bgColor indexed="64"/></patternFill></fill></fills>'
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    '<cellXfs count="5">'
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    "</cellXfs>"
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    "</styleSheet>"
)


def build(sheets):
    """sheets: lista de (nome, linhas). A primeira linha de cada planilha é o cabeçalho."""
    sheets = [(_name(name), rows) for name, rows in sheets if rows]
    if not sheets:
        sheets = [("Resumo", [["Sem dados"]])]
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as package:
        overrides = "".join(
            f'<Override PartName="/xl/worksheets/sheet{index}.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            for index in range(1, len(sheets) + 1)
        )
        package.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/styles.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            f"{overrides}</Types>",
        )
        package.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
            'Target="xl/workbook.xml"/></Relationships>',
        )
        entries = "".join(
            f'<sheet name="{_text(name)}" sheetId="{index}" r:id="rId{index}"/>'
            for index, (name, _) in enumerate(sheets, start=1)
        )
        package.writestr(
            "xl/workbook.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            f"<sheets>{entries}</sheets></workbook>",
        )
        relations = "".join(
            f'<Relationship Id="rId{index}" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
            f'Target="worksheets/sheet{index}.xml"/>'
            for index in range(1, len(sheets) + 1)
        )
        relations += (
            f'<Relationship Id="rId{len(sheets) + 1}" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        )
        package.writestr(
            "xl/_rels/workbook.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f"{relations}</Relationships>",
        )
        package.writestr("xl/styles.xml", _STYLES)
        for index, (_, rows) in enumerate(sheets, start=1):
            package.writestr(f"xl/worksheets/sheet{index}.xml", _sheet(rows))
    return buffer.getvalue()
