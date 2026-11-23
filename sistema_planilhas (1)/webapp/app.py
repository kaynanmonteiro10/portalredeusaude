# -*- coding: utf-8 -*-
"""
Interface web do sistema de processamento de planilhas.

Como usar:
    python3 app.py
O navegador abre sozinho em http://127.0.0.1:5000

Nenhuma etapa precisa de terminal: tudo é feito por telas, botões e formulários.

Importante sobre o "voltar": cada etapa sempre recalcula a partir dos dados
ORIGINAIS (ESTADO['linhas_original']), nunca em cima do resultado já filtrado.
Isso permite voltar e mudar de ideia sem os filtros se acumularem errado.
"""

import os
import shutil
import threading
import webbrowser
from datetime import datetime

from flask import Flask, render_template, request, redirect, url_for, send_from_directory, flash

import motor

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
OUTPUT_DIR = os.path.join(BASE_DIR, "outputs")
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)
print("BASE_DIR:", BASE_DIR)
print("UPLOAD_DIR:", UPLOAD_DIR)
print("Existe uploads?", os.path.exists(UPLOAD_DIR))

app = Flask(__name__)
app.secret_key = "sistema-planilhas-local"  # uso local, não precisa ser secreto

ESTADO = {}


def registra_historico_semana(caminho_planilha2, caminho_relatorio):
    agora = datetime.now()
    semana = (agora.day - 1) // 7 + 1
    pasta_historico = os.path.join(
        OUTPUT_DIR,
        "historico",
        agora.strftime("%Y"),
        agora.strftime("%m"),
        f"semana_{semana}",
    )
    os.makedirs(pasta_historico, exist_ok=True)

    nome_planilha = os.path.basename(caminho_planilha2)
    nome_relatorio = os.path.basename(caminho_relatorio)
    shutil.copy2(caminho_planilha2, os.path.join(pasta_historico, nome_planilha))
    shutil.copy2(caminho_relatorio, os.path.join(pasta_historico, nome_relatorio))


def listar_historico():
    base = os.path.join(OUTPUT_DIR, "historico")
    if not os.path.exists(base):
        return []

    historico = []
    for ano in sorted(os.listdir(base)):
        ano_path = os.path.join(base, ano)
        if not os.path.isdir(ano_path):
            continue

        for mes in sorted(os.listdir(ano_path)):
            mes_path = os.path.join(ano_path, mes)
            if not os.path.isdir(mes_path):
                continue

            for semana in sorted(os.listdir(mes_path), key=lambda nome: int(nome.split("_")[-1])):
                semana_path = os.path.join(mes_path, semana)
                if not os.path.isdir(semana_path):
                    continue

                arquivos = []
                for nome_arquivo in sorted(os.listdir(semana_path)):
                    caminho_arquivo = os.path.join(semana_path, nome_arquivo)
                    if os.path.isfile(caminho_arquivo):
                        arquivos.append({
                            "nome": nome_arquivo,
                            "subpath": os.path.relpath(caminho_arquivo, base),
                        })

                if arquivos:
                    numero_semana = int(semana.split("_")[-1])
                    historico.append({
                        "ano": ano,
                        "mes": mes,
                        "semana": f"Semana {numero_semana}",
                        "arquivos": arquivos,
                    })

    return historico


def reset_estado():
    ESTADO.clear()
    ESTADO.update({
        "linhas_original": None,   # tudo que veio da planilha 1, intocado
        "sem_codigo": 0,
        "opcao_cpf": "apenas_cnpj",
        "linhas_pos_cpf": None,    # após filtro CPF/CNPJ + limpeza de valor
        "tipos_removidos": [],
        "linhas_pos_tipo": None,   # após remoção de tipos
        "grupos": None,
        "deposito_bancario": None,
        "wb2": None,
        "wb2_nome_original": None,
        "mapeamento_anterior": {},
        "resultado": None,
        "resumo_por_aba": None,
        "arquivo_saida_planilha2": None,
        "arquivo_saida_relatorio": None,
        "resumo_relatorio": None,
    })


reset_estado()


# =============================================================================
# TELA 1 — Início / upload da planilha 1
# =============================================================================

@app.route("/", methods=["GET"])
def inicio():
    reset_estado()
    return render_template("inicio.html")

from werkzeug.utils import secure_filename

@app.route("/upload1", methods=["POST"])
def upload1():
    arquivo = request.files.get("planilha1")

    if not arquivo or arquivo.filename == "":
        flash("Selecione um arquivo .xlsx para a planilha 1.")
        return redirect(url_for("inicio"))

    nome = secure_filename(arquivo.filename)
    caminho = os.path.join(UPLOAD_DIR, "planilha1_" + nome)

    print("Nome original:", arquivo.filename)
    print("Nome seguro:", nome)
    print("Salvando em:", caminho)
    print("Pasta existe?", os.path.exists(os.path.dirname(caminho)))

    arquivo.save(caminho)

    linhas, sem_codigo = motor.carrega_planilha1(caminho)
    ESTADO["linhas_original"] = linhas
    ESTADO["sem_codigo"] = sem_codigo

    return redirect(url_for("step_cpf"))

# =============================================================================
# TELA 2 — CPF / CNPJ
# =============================================================================

@app.route("/cpf", methods=["GET"])
def step_cpf():
    if ESTADO["linhas_original"] is None:
        return redirect(url_for("inicio"))
    stats = motor.estatistica_cpf_cnpj(ESTADO["linhas_original"])
    return render_template(
        "step_cpf.html", stats=stats, sem_codigo=ESTADO["sem_codigo"],
        opcao_atual=ESTADO["opcao_cpf"],
    )


@app.route("/cpf", methods=["POST"])
def step_cpf_post():
    opcao = request.form.get("opcao", "ambos")
    ESTADO["opcao_cpf"] = opcao

    # sempre parte do zero (linhas_original) para não acumular filtro de tentativas antigas
    linhas = motor.aplica_filtro_cpf_cnpj(ESTADO["linhas_original"], opcao)
    linhas = motor.aplica_limpeza_valor_parcela(linhas)
    ESTADO["linhas_pos_cpf"] = linhas

    return redirect(url_for("step_tipo"))


# =============================================================================
# TELA 3 — Tipo Parcela
# =============================================================================

@app.route("/tipo", methods=["GET"])
def step_tipo():
    if ESTADO["linhas_pos_cpf"] is None:
        return redirect(url_for("inicio"))
    # mostra TODOS os tipos que existem na planilha original, para não "sumir"
    # tipos raros que tenham sido descartados pelos filtros anteriores
    contagem = motor.contagem_tipo_parcela(ESTADO["linhas_original"])
    return render_template(
        "step_tipo.html",
        contagem=contagem,
        total=len(ESTADO["linhas_pos_cpf"]),
        removidos_atuais=set(ESTADO["tipos_removidos"]),
    )


@app.route("/tipo", methods=["POST"])
def step_tipo_post():
    tipos_remover = request.form.getlist("remover")
    ESTADO["tipos_removidos"] = tipos_remover

    linhas = motor.aplica_remocao_tipo_parcela(ESTADO["linhas_pos_cpf"], tipos_remover)
    ESTADO["linhas_pos_tipo"] = linhas

    grupos = motor.agrupa_e_ordena(linhas)
    ESTADO["grupos"] = grupos
    ESTADO["deposito_bancario"] = motor.detecta_deposito_bancario(grupos)

    return redirect(url_for("upload2"))


# =============================================================================
# TELA 4 — Upload da planilha 2
# =============================================================================

@app.route("/planilha2", methods=["GET"])
def upload2():
    if ESTADO["grupos"] is None:
        return redirect(url_for("inicio"))
    resumo_grupos = sorted(
        ((chave, len(itens)) for chave, itens in ESTADO["grupos"].items()),
        key=lambda x: -x[1],
    )
    return render_template("upload2.html", resumo_grupos=resumo_grupos)


@app.route("/upload2", methods=["POST"])
def upload2_post():
    arquivo = request.files.get("planilha2")
    if not arquivo or arquivo.filename == "":
        flash("Selecione um arquivo .xlsx para a planilha 2.")
        return redirect(url_for("upload2"))

    caminho = os.path.join(UPLOAD_DIR, "planilha2_" + arquivo.filename)
    arquivo.save(caminho)

    ESTADO["wb2"] = motor.carrega_planilha2(caminho)
    ESTADO["wb2_nome_original"] = arquivo.filename

    return redirect(url_for("step_mapeamento"))


# =============================================================================
# TELA 5 — Mapeamento Grupo Empresa -> Aba (Grupo Mãe)
# =============================================================================

@app.route("/mapeamento", methods=["GET"])
def step_mapeamento():
    if ESTADO["wb2"] is None:
        return redirect(url_for("inicio"))

    mapeamento_anterior = ESTADO.get("mapeamento_anterior", {})
    grupos_info = []
    for chave, itens in sorted(ESTADO["grupos"].items(), key=lambda x: -len(x[1])):
        grupos_info.append({
            "chave": chave,
            "qtd": len(itens),
            "deposito_bancario": ESTADO["deposito_bancario"].get(chave, False),
            "aba_atual": mapeamento_anterior.get(chave, ""),
        })

    return render_template(
        "step_mapeamento.html",
        grupos_info=grupos_info,
        abas=ESTADO["wb2"].sheetnames,
    )


@app.route("/mapeamento", methods=["POST"])
def step_mapeamento_post():
    mapeamento = {}
    for chave in ESTADO["grupos"].keys():
        campo = f"aba__{chave}"
        aba = request.form.get(campo, "")
        if aba:
            mapeamento[chave] = aba
    ESTADO["mapeamento_anterior"] = mapeamento

    if not mapeamento:
        flash("Selecione ao menos um grupo para importar.")
        return redirect(url_for("step_mapeamento"))

    resultado, resumo_por_aba = motor.escreve_na_planilha2(ESTADO["wb2"], mapeamento, ESTADO["grupos"])
    ESTADO["resultado"] = resultado
    ESTADO["resumo_por_aba"] = resumo_por_aba

    nome_base = os.path.splitext(ESTADO["wb2_nome_original"])[0]
    caminho_planilha2_saida = os.path.join(OUTPUT_DIR, f"{nome_base}_ATUALIZADA.xlsx")
    ESTADO["wb2"].save(caminho_planilha2_saida)
    ESTADO["arquivo_saida_planilha2"] = os.path.basename(caminho_planilha2_saida)

    caminho_relatorio = os.path.join(OUTPUT_DIR, "resumo_pagamentos.xlsx")
    resumo = motor.gera_relatorio_resumo(resultado, caminho_relatorio)
    registra_historico_semana(caminho_planilha2_saida, caminho_relatorio)
    ESTADO["arquivo_saida_relatorio"] = os.path.basename(caminho_relatorio)
    ESTADO["resumo_relatorio"] = resumo

    return redirect(url_for("resultado"))


# =============================================================================
# TELA 6 — Resultado final
# =============================================================================

@app.route("/resultado", methods=["GET"])
def resultado():
    if ESTADO["resultado"] is None:
        return redirect(url_for("inicio"))

    pagos = [r for r in ESTADO["resultado"] if r["situacao"] == "PAGO"]
    nao_pagos = [r for r in ESTADO["resultado"] if r["situacao"] == "NAO PAGO"]

    return render_template(
        "resultado.html",
        resumo=ESTADO["resumo_relatorio"],
        resumo_por_aba=ESTADO["resumo_por_aba"],
        pagos=pagos,
        nao_pagos=nao_pagos,
        arquivo_planilha2=ESTADO["arquivo_saida_planilha2"],
        arquivo_relatorio=ESTADO["arquivo_saida_relatorio"],
        historico=listar_historico(),
    )


@app.route("/download/<nome_arquivo>")
def download(nome_arquivo):
    return send_from_directory(OUTPUT_DIR, nome_arquivo, as_attachment=True)


@app.route("/download_historico/<path:subpath>")
def download_historico(subpath):
    return send_from_directory(os.path.join(OUTPUT_DIR, "historico"), subpath, as_attachment=True)


# =============================================================================
# Inicialização — abre o navegador automaticamente
# =============================================================================

def abrir_navegador():
    portal = os.path.abspath(os.path.join(BASE_DIR, "..", "..", "index.html"))
    webbrowser.open(f"file:///{portal.replace(os.sep, '/')}")


if __name__ == "__main__":
    threading.Timer(1.2, abrir_navegador).start()
    app.run(debug=False, port=5000)
