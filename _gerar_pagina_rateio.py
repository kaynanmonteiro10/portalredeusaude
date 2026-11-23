"""Monta a página de análise do rateio a partir do JSON da análise."""
import json
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
DADOS = RAIZ / "entregas" / "rateio-analise.json"
SAIDA = RAIZ / "entregas" / "rateio-analise.html"


def brl(valor):
    return f"R$ {valor:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def pct(parte, todo):
    return f"{parte / todo * 100:.1f}%" if todo else "—"


d = json.loads(DADOS.read_text(encoding="utf-8"))
resumo = d["resumo"]
rateio = d["rateioRecebido"]
apuracao = d["apuracao"]

grupos_com_regra = [c for c in d["cobertura"] if c["temRegra"]]
grupos_sem_regra = [c for c in d["cobertura"] if not c["temRegra"]]

# quanto cada recebedor levaria se as regras cobrissem todos os grupos
total_com_regra = sum(c["totalDistribuido"] for c in grupos_com_regra)

html = [f"""<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Análise de rateio — {apuracao['competencia']}</title>
<style>
  :root{{--ink:#16272e;--ink-2:#4b6570;--ink-3:#7d949e;--line:#e3ecef;--bg:#f7fafb;--card:#fff;
        --teal:#0f8f8a;--teal-soft:#e6f5f4;--amber:#b7791f;--amber-soft:#fdf5e6;--red:#b4413a;--red-soft:#fdeeed;
        --blue:#2b6cb0;--blue-soft:#eaf2fb;--purple:#6b46c1;--purple-soft:#f0ebfb}}
  *{{box-sizing:border-box}}
  body{{margin:0;background:var(--bg);color:var(--ink);
       font:15px/1.6 'DM Sans',-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}}
  .wrap{{max-width:1120px;margin:0 auto;padding:40px 28px 72px}}
  h1{{font:700 27px/1.25 'Space Grotesk','Segoe UI',sans-serif;letter-spacing:-.02em;margin:0 0 6px}}
  .sub{{color:var(--ink-3);font-size:13.5px;margin:0 0 34px}}
  h2{{font:700 16px/1.3 'Space Grotesk','Segoe UI',sans-serif;margin:44px 0 4px;letter-spacing:-.01em}}
  .lead{{color:var(--ink-2);font-size:13.5px;margin:0 0 16px;max-width:760px}}
  .cards{{display:grid;grid-template-columns:repeat(auto-fit,minmax(196px,1fr));gap:14px}}
  .card{{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;
         box-shadow:0 1px 2px rgba(20,50,60,.04)}}
  .card .lbl{{font:700 9.5px/1 'Montserrat','Segoe UI',sans-serif;letter-spacing:.11em;text-transform:uppercase;color:var(--ink-3)}}
  .card .val{{font:700 23px/1.2 'Space Grotesk','Segoe UI',sans-serif;margin:9px 0 3px;letter-spacing:-.02em}}
  .card .hint{{font-size:11.5px;color:var(--ink-3);line-height:1.4}}
  .card.is-teal{{border-left:3px solid var(--teal)}} .card.is-amber{{border-left:3px solid var(--amber)}}
  .card.is-red{{border-left:3px solid var(--red)}} .card.is-blue{{border-left:3px solid var(--blue)}}
  .card.is-purple{{border-left:3px solid var(--purple)}}
  table{{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);
         border-radius:13px;overflow:hidden;font-size:13px;margin-top:10px}}
  th{{background:#f1f6f7;text-align:left;padding:9px 12px;font:700 9.5px/1 'Montserrat','Segoe UI',sans-serif;
      letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2);white-space:nowrap}}
  td{{padding:9px 12px;border-top:1px solid #eef3f4;vertical-align:top}}
  tr:hover td{{background:#fbfdfd}}
  td.num,th.num{{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}}
  .tag{{display:inline-block;border-radius:999px;padding:2px 8px;font:700 9.5px/1.5 'Montserrat',sans-serif;
        letter-spacing:.04em;text-transform:uppercase}}
  .tag.ok{{background:var(--teal-soft);color:var(--teal)}}
  .tag.no{{background:var(--red-soft);color:var(--red)}}
  .tag.warn{{background:var(--amber-soft);color:var(--amber)}}
  .tag.info{{background:var(--blue-soft);color:var(--blue)}}
  .bar{{height:5px;border-radius:3px;background:#eef3f4;overflow:hidden;margin-top:6px;min-width:60px}}
  .bar>span{{display:block;height:100%;border-radius:3px;background:var(--teal)}}
  .bar.low>span{{background:var(--red)}} .bar.mid>span{{background:var(--amber)}}
  .note{{background:var(--amber-soft);border:1px solid #f0e0bd;border-radius:13px;padding:15px 17px;
         font-size:13px;color:#7a5c17;line-height:1.55}}
  .note strong{{color:#5f460f}}
  .box{{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:17px 19px;margin-top:12px}}
  .box h3{{font:700 13.5px/1.3 'Space Grotesk',sans-serif;margin:0 0 8px}}
  ul{{margin:0;padding-left:19px}} li{{margin:5px 0;font-size:13px;color:var(--ink-2)}}
  .foot{{margin-top:44px;padding-top:16px;border-top:1px solid var(--line);font-size:11.5px;color:var(--ink-3)}}
  @media(max-width:640px){{.wrap{{padding:26px 16px 52px}} h1{{font-size:22px}}}}
</style></head><body><div class="wrap">
<h1>Faturamento, recebimento e rateio</h1>
<p class="sub">Competência {apuracao['competencia']} · apuração de {apuracao['concluidaEm'][:10]} ·
{apuracao['linhas']} títulos · fonte: S4E (faturamento e baixa) + relatórios P4X (rateio)</p>

<div class="cards">
  <div class="card is-blue"><div class="lbl">Faturado</div><div class="val">{brl(resumo['faturado'])}</div>
    <div class="hint">{resumo['grupos']} grupos · valor dos títulos emitidos</div></div>
  <div class="card is-teal"><div class="lbl">Recebido no S4E</div><div class="val">{brl(resumo['recebido'])}</div>
    <div class="hint">{resumo['taxaRecebimento']:.1f}% do faturado já baixado</div></div>
  <div class="card is-red"><div class="lbl">Ainda em aberto</div><div class="val">{brl(resumo['emAberto'])}</div>
    <div class="hint">títulos sem baixa até hoje</div></div>
  <div class="card is-purple"><div class="lbl">Rateio P4X único</div><div class="val">{brl(rateio['totalRateio'])}</div>
    <div class="hint">{rateio['linhasUnicas']} lançamentos sem repetição</div></div>
</div>
"""]

# ── o que a tela distribui hoje ──
html.append(f"""
<h2>O que a tela de rateio distribui hoje</h2>
<p class="lead">Só quatro grupos têm regra ativa. Todo o resto do faturamento — inclusive os grupos grandes —
fica sem distribuição e não aparece como erro na tela.</p>
<div class="cards">
  <div class="card is-teal"><div class="lbl">Faturado com regra</div><div class="val">{brl(resumo['faturadoComRegra'])}</div>
    <div class="hint">{resumo['gruposComRegra']} de {resumo['grupos']} grupos</div></div>
  <div class="card is-red"><div class="lbl">Faturado sem regra</div><div class="val">{brl(resumo['faturadoSemRegra'])}</div>
    <div class="hint">{resumo['gruposSemRegra']} grupos sem nenhuma regra</div></div>
  <div class="card is-amber"><div class="lbl">Distribuído pelas regras</div><div class="val">{brl(total_com_regra)}</div>
    <div class="hint">{pct(total_com_regra, resumo['faturado'])} do faturamento total</div></div>
</div>
<table><thead><tr><th>Grupo</th><th>Recebedor</th><th class="num">R$/vida</th><th class="num">Total distribuído</th></tr></thead><tbody>""")
for grupo in grupos_com_regra:
    for i, regra in enumerate(grupo["regras"]):
        nome = f"<strong>{grupo['grupo']}</strong>" if i == 0 else ""
        html.append(f"<tr><td>{nome}</td><td>{regra['recebedor']}</td>"
                    f"<td class='num'>{brl(regra['valorUnitario'])}</td>"
                    f"<td class='num'>{brl(regra['total'])}</td></tr>")
html.append("</tbody></table>")

# ── quem recebe de verdade ──
html.append(f"""
<h2>Quem recebe de verdade (relatórios P4X)</h2>
<p class="lead">Só dois recebedores aparecem nos relatórios. São {rateio['linhasBrutas']} lançamentos nos arquivos,
mas apenas {rateio['linhasUnicas']} são de verdade: {rateio['lancamentosRepetidosEntreArquivos']} linhas são
o mesmo lançamento chegando em vários relatórios. Somar os arquivos sem deduplicar infla o recebido
em mais de {rateio['linhasBrutas'] / rateio['linhasUnicas']:.0f} vezes.</p>
<table><thead><tr><th>Recebedor</th><th class="num">Lançamentos</th><th class="num">Nominal</th>
<th class="num">Rateio</th><th class="num">% do total</th></tr></thead><tbody>""")
for item in rateio["recebedores"]:
    html.append(f"<tr><td><strong>{item['nome']}</strong></td><td class='num'>{item['lancamentos']}</td>"
                f"<td class='num'>{brl(item['nominal'])}</td><td class='num'>{brl(item['rateio'])}</td>"
                f"<td class='num'>{pct(item['rateio'], rateio['totalRateio'])}</td></tr>")
html.append(f"""<tr><td><strong>Total</strong></td><td class="num">{rateio['linhasUnicas']}</td>
<td class="num">{brl(rateio['totalNominal'])}</td><td class="num">{brl(rateio['totalRateio'])}</td>
<td class="num">100%</td></tr></tbody></table>""")

if rateio["importacoesRepetidas"]:
    html.append('<div class="note" style="margin-top:14px"><strong>Atenção:</strong> ')
    nomes = ", ".join(f"{r['arquivo']} (= {r['igualA']})" for r in rateio["importacoesRepetidas"])
    html.append(f"há importação repetida na base: {nomes}. Somar tudo sem deduplicar infla o recebido.")
    html.append("</div>")

# ── faturado x recebido por forma ──
html.append("""
<h2>Faturado x recebido por forma de pagamento</h2>
<p class="lead">É aqui que aparece a diferença entre "faturei" e "vou receber". Tudo em ABERTO é o que
ainda não entrou. As formas P4X são os convênios que repassam o rateio.</p>
<table><thead><tr><th>Forma de recebimento</th><th class="num">Títulos</th><th class="num">Faturado</th>
<th class="num">Recebido</th><th class="num">%</th><th style="width:110px"></th></tr></thead><tbody>""")
for forma in d["formas"]:
    taxa = forma["recebido"] / forma["faturado"] * 100 if forma["faturado"] else 0
    classe = "low" if taxa < 50 else ("mid" if taxa < 95 else "")
    html.append(f"<tr><td>{forma['forma']}</td><td class='num'>{forma['titulos']}</td>"
                f"<td class='num'>{brl(forma['faturado'])}</td><td class='num'>{brl(forma['recebido'])}</td>"
                f"<td class='num'>{taxa:.1f}%</td>"
                f"<td><div class='bar {classe}'><span style='width:{min(taxa, 100):.0f}%'></span></div></td></tr>")
html.append("</tbody></table>")

# ── por grupo ──
html.append("""
<h2>Grupo por grupo: faturado, recebido no S4E e rateio P4X</h2>
<p class="lead">O rateio P4X é ligado à empresa pelo documento (CNPJ) do pagador. Onde aparece zero,
ou não houve repasse do convênio, ou o pagador não bate com nenhuma empresa da apuração.</p>
<table><thead><tr><th>Grupo</th><th class="num">Títulos</th><th class="num">Faturado</th>
<th class="num">Recebido S4E</th><th class="num">%</th><th class="num">Em aberto</th>
<th class="num">Rateio P4X</th><th>Regra</th></tr></thead><tbody>""")
for item in d["cobertura"]:
    taxa = item["recebido"] / item["faturado"] * 100 if item["faturado"] else 0
    etiqueta = "<span class='tag ok'>com regra</span>" if item["temRegra"] else "<span class='tag no'>sem regra</span>"
    html.append(f"<tr><td>{item['grupo']}</td><td class='num'>{item['faturado'] and ''}"
                f"{(next((g['titulos'] for g in d['grupos'] if g['grupo'] == item['grupo']), 0))}</td>"
                f"<td class='num'>{brl(item['faturado'])}</td><td class='num'>{brl(item['recebido'])}</td>"
                f"<td class='num'>{taxa:.0f}%</td><td class='num'>{brl(next((g['aberto'] for g in d['grupos'] if g['grupo'] == item['grupo']), 0))}</td>"
                f"<td class='num'>{brl(item['rateioP4X'])}</td><td>{etiqueta}</td></tr>")
html.append("</tbody></table>")

# ── conclusão ──
html.append(f"""
<h2>O que isso quer dizer</h2>
<div class="box"><h3>1. A tela não está errada na conta — está vazia de regras</h3>
<ul>
  <li>{resumo['gruposSemRegra']} dos {resumo['grupos']} grupos não têm nenhuma regra de rateio cadastrada,
      o que deixa {brl(resumo['faturadoSemRegra'])} ({pct(resumo['faturadoSemRegra'], resumo['faturado'])} do faturamento) sem distribuição.</li>
  <li>SINTEG sozinho é {brl(next((g['faturado'] for g in d['grupos'] if g['grupo'] == 'SINTEG'), 0))}
      de faturamento e não tem regra — por isso a tela parece não funcionar.</li>
  <li>Os 4 grupos com regra fecham exatamente no faturado (saldo zero): o cálculo por vida está correto.</li>
</ul></div>
<div class="box"><h3>2. Faturar não é receber</h3>
<ul>
  <li>Faturado {brl(resumo['faturado'])}; recebido {brl(resumo['recebido'])} ({resumo['taxaRecebimento']:.1f}%);
      em aberto {brl(resumo['emAberto'])}.</li>
  <li>Quase tudo em aberto está em SINTEG: {brl(next((g['aberto'] for g in d['grupos'] if g['grupo'] == 'SINTEG'), 0))},
      em títulos com forma de recebimento ABERTO (sem convênio definido).</li>
  <li>As formas P4X (FITBANK SINTEG, SINTRASECE, SINDIMOTOS, SINATC, SITIAL, PARACATU, SEEAC) estão
      praticamente 100% recebidas.</li>
</ul></div>
<div class="box"><h3>3. O rateio que chega é de dois recebedores, não da rede toda</h3>
<ul>
  <li>Os relatórios P4X trazem {brl(rateio['totalRateio'])} para APP REDE SAUDE LTDA
      ({brl(next((r['rateio'] for r in rateio['recebedores'] if 'APP' in r['nome']), 0))}) e
      CARTAO REDE SAUDE LTDA ({brl(next((r['rateio'] for r in rateio['recebedores'] if 'CARTAO' in r['nome']), 0))}).</li>
  <li>Não há repasse identificado para os demais recebedores das regras (RS, SEAC RJ, Sintrasece, SINALSUL…).
      Ou seja: a regra diz quem deveria receber, o relatório mostra quem recebeu de fato.</li>
  <li>{brl(rateio['semEmpresaNaApuracao'])} em rateios não casaram com nenhuma empresa da apuração
      (pagador com CNPJ diferente do cadastro) — precisa de conferência manual.</li>
</ul></div>
<div class="box"><h3>4. O que falta para a tela servir de análise</h3>
<ul>
  <li>Cadastrar regra para os {resumo['gruposSemRegra']} grupos — sem isso a tela não tem o que distribuir.</li>
  <li>Tratar o grupo SINTEG separadamente: {brl(next((g['faturado'] for g in d['grupos'] if g['grupo'] == 'SINTEG'), 0))}
      faturado contra {brl(next((g['rateioP4X'] for g in d['cobertura'] if g['grupo'] == 'SINTEG'), 0))} de rateio P4X.</li>
  <li>Deduplicar os relatórios P4X na importação (mesmo pagador + data + valor + movimento),
      senão o recebido aparece inflado.</li>
</ul></div>
<p class="foot">Gerado a partir de portal.db (apuracao_rows e finance_rateios) e do cache de faturamento do S4E.
Nada foi alterado no portal. Valores em reais.</p>
</div></body></html>""")

SAIDA.write_text("\n".join(html), encoding="utf-8")
print(f"gerado: {SAIDA}")
