"""Página: o rateio já tem destino definido? Sim — falta ligar."""
import json
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
DADOS = RAIZ / "entregas" / "rateio-destino.json"
SAIDA = RAIZ / "entregas" / "rateio-destino.html"


def brl(v):
    return f"R$ {v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


d = json.loads(DADOS.read_text(encoding="utf-8"))
todas = d["cenarioTodasRegras"]
ativo = d["cenarioAtivo"]
total_todas = d["totalTodas"]
total_ativo = d["totalAtivo"]
desalinhadas = [v for v in d["viabilidade"] if not v["ajustada"] and v["precoModal"]]
alinhadas = [v for v in d["viabilidade"] if v["ajustada"]]

html = [f"""<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Destino do rateio — {d['apuracao']}</title>
<style>
  :root{{--ink:#16272e;--ink2:#4b6570;--ink3:#7d949e;--line:#e3ecef;--bg:#f7fafb;--card:#fff;
        --teal:#0f8f8a;--tealS:#e6f5f4;--amber:#b7791f;--amberS:#fdf5e6;--red:#b4413a;--redS:#fdeeed;
        --blue:#2b6cb0;--blueS:#eaf2fb;--purple:#6b46c1;--purpleS:#f0ebfb}}
  *{{box-sizing:border-box}}
  body{{margin:0;background:var(--bg);color:var(--ink);
       font:15px/1.6 'DM Sans',-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}}
  .wrap{{max-width:1080px;margin:0 auto;padding:40px 28px 72px}}
  h1{{font:700 27px/1.25 'Space Grotesk','Segoe UI',sans-serif;letter-spacing:-.02em;margin:0 0 6px}}
  .sub{{color:var(--ink3);font-size:13.5px;margin:0 0 30px}}
  h2{{font:700 16px/1.3 'Space Grotesk','Segoe UI',sans-serif;margin:42px 0 4px;letter-spacing:-.01em}}
  .lead{{color:var(--ink2);font-size:13.5px;margin:0 0 16px;max-width:780px}}
  .cards{{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}}
  .card{{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;
         box-shadow:0 1px 2px rgba(20,50,60,.04)}}
  .card .lbl{{font:700 9.5px/1 'Montserrat','Segoe UI',sans-serif;letter-spacing:.11em;
              text-transform:uppercase;color:var(--ink3)}}
  .card .val{{font:700 22px/1.2 'Space Grotesk','Segoe UI',sans-serif;margin:9px 0 3px;letter-spacing:-.02em}}
  .card .hint{{font-size:11.5px;color:var(--ink3);line-height:1.4}}
  .card.is-teal{{border-left:3px solid var(--teal)}} .card.is-amber{{border-left:3px solid var(--amber)}}
  .card.is-red{{border-left:3px solid var(--red)}} .card.is-purple{{border-left:3px solid var(--purple)}}
  table{{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);
         border-radius:13px;overflow:hidden;font-size:13px;margin-top:10px}}
  th{{background:#f1f6f7;text-align:left;padding:9px 12px;font:700 9.5px/1 'Montserrat','Segoe UI',sans-serif;
      letter-spacing:.08em;text-transform:uppercase;color:var(--ink2);white-space:nowrap}}
  td{{padding:9px 12px;border-top:1px solid #eef3f4;vertical-align:top}}
  tr:hover td{{background:#fbfdfd}}
  td.num,th.num{{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}}
  .tag{{display:inline-block;border-radius:999px;padding:2px 8px;font:700 9.5px/1.5 'Montserrat',sans-serif;
        letter-spacing:.04em;text-transform:uppercase}}
  .tag.ok{{background:var(--tealS);color:var(--teal)}}
  .tag.no{{background:var(--redS);color:var(--red)}}
  .tag.warn{{background:var(--amberS);color:var(--amber)}}
  .box{{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:17px 19px;margin-top:12px}}
  .box h3{{font:700 13.5px/1.3 'Space Grotesk',sans-serif;margin:0 0 8px}}
  ul{{margin:0;padding-left:19px}} li{{margin:6px 0;font-size:13px;color:var(--ink2)}}
  .note{{background:var(--amberS);border:1px solid #f0e0bd;border-radius:13px;padding:15px 17px;
         font-size:13px;color:#7a5c17;line-height:1.55;margin-top:14px}}
  .note strong{{color:#5f460f}}
  .foot{{margin-top:42px;padding-top:16px;border-top:1px solid var(--line);font-size:11.5px;color:var(--ink3)}}
  @media(max-width:640px){{.wrap{{padding:26px 16px 52px}} h1{{font-size:22px}}}}
</style></head><body><div class="wrap">
<h1>O rateio já tem destino — só não está ligado</h1>
<p class="sub">Competência {d['apuracao']} · 36 regras cadastradas, 21 ativas · a regra diz quanto cada
recebedor leva por vida</p>

<div class="cards">
  <div class="card is-teal"><div class="lbl">Distribuído hoje</div><div class="val">{brl(total_ativo)}</div>
    <div class="hint">só 4 grupos com regra ativa</div></div>
  <div class="card is-purple"><div class="lbl">Se ligar todas</div><div class="val">{brl(total_todas)}</div>
    <div class="hint">18 grupos cobertos</div></div>
  <div class="card is-amber"><div class="lbl">Grupos sem regra</div><div class="val">{len(d['semRegra'])}</div>
    <div class="hint">nenhum destino definido</div></div>
  <div class="card is-red"><div class="lbl">Regras desalinhadas</div><div class="val">{len(desalinhadas)}</div>
    <div class="hint">valor não bate com o preço real</div></div>
</div>

<h2>Quem recebe o quê — com todas as regras ligadas</h2>
<p class="lead">Distribuindo 100% do faturamento de cada grupo na proporção das regras cadastradas.
É o destino que já está escrito no banco, esperando só o botão de ativo.</p>
<table><thead><tr><th>Recebedor</th><th class="num">Valor no mês</th><th class="num">% do total</th>
<th style="width:150px"></th></tr></thead><tbody>"""]
for item in todas:
    p = item["valor"] / total_todas * 100 if total_todas else 0
    html.append(f"<tr><td><strong>{item['recebedor']}</strong></td><td class='num'>{brl(item['valor'])}</td>"
                f"<td class='num'>{p:.1f}%</td>"
                f"<td><div style='height:5px;border-radius:3px;background:#eef3f4;overflow:hidden'>"
                f"<span style='display:block;height:100%;background:var(--teal);width:{p:.0f}%'></span></div></td></tr>")
html.append(f"""<tr><td><strong>Total</strong></td><td class="num"><strong>{brl(total_todas)}</strong></td>
<td class="num">100%</td><td></td></tr></tbody></table>""")

html.append("""
<h2>Grupo por grupo</h2>
<p class="lead">Os grupos grandes já têm destino definido. O que falta são os grupos novos
(Ceará, Sindicato Rodoviários Rio, SindbRef-PB, Anaseg, Clínica Digital…).</p>
<table><thead><tr><th>Grupo</th><th class="num">Faturado</th><th>Vai para</th></tr></thead><tbody>""")
for g in d["porGrupoTodas"]:
    destino = "<br>".join(
        f"<span style='color:#4b6570'>{r['recebedor']}</span> "
        f"<strong>{brl(r['valor'])}</strong>" for r in g["recebedores"])
    html.append(f"<tr><td><strong>{g['grupo']}</strong></td><td class='num'>{brl(g['faturado'])}</td>"
                f"<td>{destino}</td></tr>")
html.append("</tbody></table>")

html.append(f"""
<h2>Onde a regra não bate com a realidade</h2>
<p class="lead">Cada grupo cobra um preço por vida. Se a soma das regras passa desse preço,
o rateio não fecha — e foi isso que fez a tela parecer quebrada. Comparei com o preço que a
maioria das empresas realmente paga (o preço modal).</p>
<table><thead><tr><th>Grupo</th><th class="num">Preço real/vida</th><th class="num">Soma das regras</th>
<th class="num">Diferença</th><th>Situação</th></tr></thead><tbody>""")
for v in sorted(d["viabilidade"], key=lambda x: -abs(x["diferencaModal"])):
    if not v["precoModal"]:
        continue
    if v["ajustada"]:
        tag = "<span class='tag ok'>alinhada</span>"
        dif = "—"
    else:
        tag = "<span class='tag no'>desalinhada</span>"
        dif = f"{v['diferencaModal']:+.2f}"
    html.append(f"<tr><td>{v['grupo']}</td><td class='num'>{brl(v['precoModal'])}</td>"
                f"<td class='num'>{brl(v['somaRegras'])}</td><td class='num'>{dif}</td><td>{tag}</td></tr>")
html.append("</tbody></table>")

html.append("""
<div class="note"><strong>O caso do SINTEG — o maior de todos.</strong>
O preço é R$ 60,00 por vida (81 das 100 empresas pagam exatamente isso). As regras somam
R$ 61,50: RS 18,45 + SINTEG 18,45 + BOLSÃO 23,10 = 60,00, mais ALMIR 1,50. Ou seja,
os R$ 1,50 do ALMIR estão por fora do preço — a regra dele precisa ser checada ou o preço
dele sai do bolsão. Do jeito que está, ligar o SINTEG distribuiria mais do que entrou.</div>

<div class="note" style="background:var(--redS);border-color:#f0c9c6;color:#8d322c">
<strong>Outro problema de cadastro:</strong> em PARACATU e PARACATU ESP. as regras estão
trocadas — PARACATU cobra R$ 13,50/vida mas tem regra de R$ 8,50, e PARACATU ESP. cobra
R$ 8,50 mas tem regra de R$ 13,50. SINTRUCAD ACT cobra R$ 25,90 e a regra diz R$ 5,50.</div>
""")

html.append("""
<h2>Grupos sem nenhum destino definido</h2>
<p class="lead">Estes 11 grupos não têm uma única regra. Para eles não existe resposta hoje —
é preciso dizer para onde vai.</p>
<table><thead><tr><th>Grupo</th><th class="num">Títulos</th><th class="num">Faturado</th>
<th class="num">Vidas</th><th class="num">Preço/vida</th></tr></thead><tbody>""")
for s in d["semRegra"]:
    html.append(f"<tr><td>{s['grupo']}</td><td class='num'>{s['titulos']}</td>"
                f"<td class='num'>{brl(s['faturado'])}</td><td class='num'>{s['vidas']:,}</td>"
                f"<td class='num'>{brl(s['precoRealPorVida'])}</td></tr>".replace(",", ".", 1))
html.append("</tbody></table>")

html.append(f"""
<h2>Como a regra funciona</h2>
<p class="lead">A regra mais específica vence, e é isso que permite o centro de custo ter
uma regra, um grupo dentro dele ter outra, e uma empresa ter exceção.</p>
<div class="box"><h3>Escala de prioridade</h3>
<ul>
  <li><strong>Empresa</strong> — vale só para aquele CNPJ. Vence tudo.</li>
  <li><strong>Grupo</strong> — vale para as empresas daquele grupo dentro do centro.</li>
  <li><strong>Centro de custo</strong> — a regra geral; vale quando não há nada mais específico.</li>
  <li>Várias regras no mesmo nível <strong>somam</strong> — é assim que o SINTEG tem RS, SINTEG e BOLSÃO.</li>
</ul></div>
<div class="box"><h3>Juros, multa e acréscimo</h3>
<ul>
  <li>Cada regra diz o destino dos encargos: <strong>dividir junto com a base</strong>,
      <strong>mandar para uma conta específica</strong> ou <strong>ficar com a Rede Saúde</strong>.</li>
  <li>Na competência foram R$ 1.612,24 de juros e multas — 0,18% do faturado.
      Sem regra definida, ficam com a Rede Saúde.</li>
</ul></div>

<h2>O que fazer, na ordem</h2>
<div class="box"><h3>1. Revisar as 5 regras desalinhadas</h3>
<ul>
  <li>SINTEG: R$ 1,50 do ALMIR está fora do preço de R$ 60,00.</li>
  <li>PARACATU e PARACATU ESP.: valores trocados entre os dois grupos.</li>
  <li>SINTRUCAD ACT: regra de R$ 5,50 contra preço de R$ 25,90.</li>
  <li>SINDIMOTOS: regras somam R$ 28,03 contra preço de R$ 23,70.</li>
</ul></div>
<div class="box"><h3>2. Ligar as regras dos 15 grupos que já estão cadastrados</h3>
<ul>
  <li>São {len(alinhadas)} grupos com regra já batendo com o preço real — é só ativar.</li>
  <li>Isso sobe a distribuição de {brl(total_ativo)} para {brl(total_todas)}.</li>
</ul></div>
<div class="box"><h3>3. Definir destino para os {len(d['semRegra'])} grupos restantes</h3>
<ul>
  <li>É a única parte que depende de decisão sua: quem recebe nesses grupos.</li>
  <li>Com a regra cadastrada, a tela passa a responder sozinha todo mês.</li>
</ul></div>
<p class="foot">Fonte: portal.db (rateio_rules, apuracao_rows) e relatórios P4X. Nada foi alterado no portal.
Valores em reais, competência {d['apuracao']}.</p>
</div></body></html>""")

SAIDA.write_text("\n".join(html), encoding="utf-8")
print(f"gerado: {SAIDA}")
