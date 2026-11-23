"""Gera o PDF do recibo a partir dos dados que o próprio S4E devolve.

O S4E entrega o recibo em HTML com impressão automática. Para o portal baixar
uma pasta de PDFs, o mesmo conteúdo é desenhado aqui em PDF (logo, número,
valor, extenso, parcela, vencimento e data), sem alterar nada no S4E.
"""

import html as html_lib
import re
import struct
import zlib

PAGE_WIDTH = 595.28
PAGE_HEIGHT = 841.89
MARGIN = 72.0
RIGHT = PAGE_WIDTH - MARGIN

INK = (0.10, 0.23, 0.26)
MUTED = (0.40, 0.49, 0.51)
BAND = (0.91, 0.93, 0.95)
LINE = (0.72, 0.79, 0.79)


def clean_text(value):
    text = html_lib.unescape(re.sub(r"<[^>]+>", " ", str(value or "")))
    return re.sub(r"\s+", " ", text).strip()


def _pdf_text(value):
    raw = str(value or "").encode("cp1252", "replace")
    return raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


def _pdf_hex(value):
    raw = b"\xfe\xff" + str(value or "").encode("utf-16-be", "replace")
    return b"<" + raw.hex().upper().encode("ascii") + b">"


def _text_width(text, size):
    # Largura média da Helvetica; suficiente para alinhar e quebrar as linhas do recibo.
    return len(str(text)) * size * 0.52


def wrap_lines(text, size, max_width):
    words = clean_text(text).split()
    if not words:
        return [""]
    lines = []
    current = ""
    for word in words:
        trial = f"{current} {word}".strip()
        if current and _text_width(trial, size) > max_width:
            lines.append(current)
            current = word
        else:
            current = trial
    if current:
        lines.append(current)
    return lines


def _png_pixels(data):
    """Decodifica PNG 8 bits (RGB, RGBA ou cinza) e devolve RGB + alfa."""
    if not data or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("Logo não é um PNG válido.")
    pos = 8
    width = height = depth = color_type = interlace = 0
    palette = b""
    alpha_table = b""
    chunks = []
    while pos + 8 <= len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        ctype = data[pos + 4:pos + 8]
        payload = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if ctype == b"IHDR":
            width, height, depth, color_type, _, _, interlace = struct.unpack(">IIBBBBB", payload)
        elif ctype == b"PLTE":
            palette = payload
        elif ctype == b"tRNS":
            alpha_table = payload
        elif ctype == b"IDAT":
            chunks.append(payload)
        elif ctype == b"IEND":
            break
    if not width or not height:
        raise ValueError("Logo sem dimensões.")
    if depth != 8 or interlace:
        raise ValueError("Formato de logo não suportado.")
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color_type)
    if channels is None:
        raise ValueError("Formato de logo não suportado.")
    raw = zlib.decompress(b"".join(chunks))
    stride = width * channels
    rows = []
    previous = bytearray(stride)
    cursor = 0
    for _ in range(height):
        if cursor >= len(raw):
            raise ValueError("Logo incompleto.")
        filter_type = raw[cursor]
        cursor += 1
        line = bytearray(raw[cursor:cursor + stride])
        cursor += stride
        if filter_type == 1:
            for index in range(channels, stride):
                line[index] = (line[index] + line[index - channels]) & 0xFF
        elif filter_type == 2:
            for index in range(stride):
                line[index] = (line[index] + previous[index]) & 0xFF
        elif filter_type == 3:
            for index in range(stride):
                left = line[index - channels] if index >= channels else 0
                line[index] = (line[index] + ((left + previous[index]) >> 1)) & 0xFF
        elif filter_type == 4:
            for index in range(stride):
                left = line[index - channels] if index >= channels else 0
                up = previous[index]
                up_left = previous[index - channels] if index >= channels else 0
                guess = left + up - up_left
                da, db, dc = abs(guess - left), abs(guess - up), abs(guess - up_left)
                predictor = left if da <= db and da <= dc else (up if db <= dc else up_left)
                line[index] = (line[index] + predictor) & 0xFF
        elif filter_type != 0:
            raise ValueError("Filtro de logo não suportado.")
        rows.append(bytes(line))
        previous = line

    rgb = bytearray()
    alpha = bytearray()
    for line in rows:
        for index in range(width):
            offset = index * channels
            if color_type == 6:
                red, green, blue, opacity = line[offset:offset + 4]
            elif color_type == 2:
                red, green, blue = line[offset:offset + 3]
                opacity = 255
            elif color_type == 0:
                red = green = blue = line[offset]
                opacity = 255
            elif color_type == 4:
                red = green = blue = line[offset]
                opacity = line[offset + 1]
            else:
                palette_index = line[offset]
                red, green, blue = palette[palette_index * 3:palette_index * 3 + 3] or b"\x00\x00\x00"
                opacity = alpha_table[palette_index] if palette_index < len(alpha_table) else 255
            alpha.append(opacity)
            # O recibo é impresso em papel branco: compor o logo sobre branco
            # deixa o PDF legível em qualquer leitor, mesmo sem suporte a SMask.
            rgb.extend((
                (red * opacity + 255 * (255 - opacity)) // 255,
                (green * opacity + 255 * (255 - opacity)) // 255,
                (blue * opacity + 255 * (255 - opacity)) // 255,
            ))
    return width, height, bytes(rgb), bytes(alpha)


def _image_objects(logo_png):
    width, height, rgb, alpha = _png_pixels(logo_png)
    image = zlib.compress(rgb, 9)
    mask = zlib.compress(alpha, 9)
    return width, height, image, mask


def _stream(dictionary, payload):
    return (
        b"<< " + dictionary + f" /Length {len(payload)} >>\nstream\n".encode("ascii")
        + payload + b"\nendstream"
    )


def build_receipt_pdf(fields, logo_png=b""):
    """Monta um PDF A4 com o recibo. `fields` usa os mesmos nomes da tela do S4E."""
    numero = clean_text(fields.get("numero"))
    valor = clean_text(fields.get("valor"))
    nome = clean_text(fields.get("nome"))
    extenso = clean_text(fields.get("extenso"))
    historico = clean_text(fields.get("historico"))
    data = clean_text(fields.get("data"))
    hora = clean_text(fields.get("hora"))

    commands = bytearray()

    def text(font, size, x, y, value, color=INK):
        commands.extend(
            b"BT /" + font.encode("ascii") + b" " + f"{size:.2f}".encode("ascii")
            + b" Tf " + f"{color[0]:.3f} {color[1]:.3f} {color[2]:.3f} rg ".encode("ascii")
            + f"1 0 0 1 {x:.2f} {y:.2f} Tm (".encode("ascii")
            + _pdf_text(value) + b") Tj ET\n"
        )

    def rect(x, y, width, height, color=BAND):
        commands.extend(
            f"{color[0]:.3f} {color[1]:.3f} {color[2]:.3f} rg {x:.2f} {y:.2f} {width:.2f} {height:.2f} re f\n".encode("ascii")
        )

    def rule(y, color=LINE, start=MARGIN, end=RIGHT):
        commands.extend(
            f"{color[0]:.3f} {color[1]:.3f} {color[2]:.3f} RG 0.7 w {start:.2f} {y:.2f} m {end:.2f} {y:.2f} l S\n".encode("ascii")
        )

    logo_width, logo_height, image, mask = (0, 0, b"", b"")
    if logo_png:
        try:
            logo_width, logo_height, image, mask = _image_objects(logo_png)
        except (ValueError, zlib.error, struct.error):
            logo_width = 0

    if logo_width:
        draw_w = 110.0
        draw_h = draw_w * logo_height / logo_width
        commands.extend(
            f"q {draw_w:.2f} 0 0 {draw_h:.2f} {MARGIN:.2f} {PAGE_HEIGHT - MARGIN - draw_h:.2f} cm /Logo Do Q\n".encode("ascii")
        )

    label_width = 118.0
    label_x = MARGIN + label_width
    label_text_x = label_x + 8
    wrap_width = RIGHT - label_text_x - 12

    title = "RECIBO"
    text("F2", 18, RIGHT - _text_width(title, 18), PAGE_HEIGHT - MARGIN - 4, title)
    rule(PAGE_HEIGHT - MARGIN - 78)

    y = PAGE_HEIGHT - MARGIN - 104
    text("F3", 12, MARGIN, y, "Nº")
    rect(MARGIN + 30, y - 6, 128, 24)
    text("F2", 12, MARGIN + 38, y, numero or "—")
    if valor:
        text("F2", 14, RIGHT - _text_width(valor, 14), y, valor)

    y -= 58
    text("F3", 9.5, MARGIN, y, "Recebemos do(a) Sr(a).")
    text("F3", 9.5, MARGIN, y - 19, "a quantia de")
    name_lines = wrap_lines(nome or "—", 12, wrap_width)
    band_height = 21 * len(name_lines) + 9
    rect(label_x, y - band_height + 15, RIGHT - label_x, band_height)
    for index, line in enumerate(name_lines):
        text("F2", 12, label_text_x, y - index * 21, line)

    y -= band_height + 32
    amount_lines = wrap_lines(extenso or valor or "—", 11, wrap_width)
    band_height = 19 * len(amount_lines) + 11
    rect(label_x, y - band_height + 15, RIGHT - label_x, band_height)
    for index, line in enumerate(amount_lines):
        text("F2", 11, label_text_x, y - index * 19, line)

    y -= band_height + 32
    text("F3", 9.5, MARGIN, y, "referente a")
    history_lines = wrap_lines(historico or "—", 10.5, wrap_width)
    band_height = 19 * len(history_lines) + 11
    rect(label_x, y - band_height + 15, RIGHT - label_x, band_height)
    for index, line in enumerate(history_lines):
        text("F1", 10.5, label_text_x, y - index * 19, line)

    y -= band_height + 150
    rule(y + 12, LINE, 310, RIGHT)
    if data:
        text("F3", 9, RIGHT - _text_width(data, 9), y - 8, data)
    if hora:
        text("F1", 7.5, MARGIN + 10, y - 8, hora, MUTED)
    rule(y - 34)

    content = bytes(commands)

    objects = []

    def add(payload):
        objects.append(payload)
        return len(objects)

    catalog = add(b"")  # preenchido no fim
    pages = add(b"")
    page = add(b"")
    font_regular = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    font_bold = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
    font_italic = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>")
    info = add(
        b"<< /Title " + _pdf_hex(f"Recibo {numero} - {nome}")
        + b" /Author " + _pdf_hex("Rede Saúde")
        + b" /Producer " + _pdf_hex("Portal do Setor - Rede Saúde")
        + b" /Creator " + _pdf_hex("Portal do Setor - Rede Saúde") + b" >>"
    )
    logo_object = mask_object = 0
    if logo_width:
        mask_number = len(objects) + 2
        logo_object = add(
            _stream(
                f"/Type /XObject /Subtype /Image /Width {logo_width} /Height {logo_height} "
                f"/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /SMask {mask_number} 0 R".encode("ascii"),
                image,
            )
        )
        mask_object = add(
            _stream(
                f"/Type /XObject /Subtype /Image /Width {logo_width} /Height {logo_height} "
                f"/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode".encode("ascii"),
                mask,
            )
        )
    content_object = add(_stream(b"", content))

    resources = (
        b"<< /Font << /F1 " + str(font_regular).encode() + b" 0 R /F2 " + str(font_bold).encode()
        + b" 0 R /F3 " + str(font_italic).encode() + b" 0 R >>"
        + (b" /XObject << /Logo " + str(logo_object).encode() + b" 0 R >>" if logo_object else b"")
        + b" >>"
    )
    objects[page - 1] = (
        b"<< /Type /Page /Parent " + str(pages).encode() + b" 0 R /MediaBox [0 0 "
        + f"{PAGE_WIDTH:.2f} {PAGE_HEIGHT:.2f}".encode("ascii") + b"] /Resources " + resources
        + b" /Contents " + str(content_object).encode() + b" 0 R >>"
    )
    objects[pages - 1] = (
        b"<< /Type /Pages /Kids [" + str(page).encode() + b" 0 R] /Count 1 >>"
    )
    objects[catalog - 1] = b"<< /Type /Catalog /Pages " + str(pages).encode() + b" 0 R >>"

    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, payload in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{index} 0 obj\n".encode("ascii"))
        output.extend(payload)
        output.extend(b"\nendobj\n")
    start_xref = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(
        b"trailer\n<< /Size " + str(len(objects) + 1).encode("ascii")
        + b" /Root " + str(catalog).encode() + b" 0 R /Info " + str(info).encode()
        + b" 0 R >>\nstartxref\n" + str(start_xref).encode("ascii") + b"\n%%EOF\n"
    )
    return bytes(output)
