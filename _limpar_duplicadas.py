"""Camada 3 — limpeza das demandas duplicadas que já existem.

Regra de segurança:
  * nada é apagado de verdade: o registro sai de `tasks` e entra em
    `deletedTaskIds` (tombstone), que o sistema já respeita;
  * um grupo só é unificado quando todos os registros têm o MESMO conteúdo
    (notas, prioridade, status, checklist). Se as notas divergem, o grupo é
    PRESERVADO e apenas listado para decisão humana;
  * o registro mantido é o mais antigo (o primeiro a ser criado).

Uso:
    python _limpar_duplicadas.py            # mostra o que faria (não grava)
    python _limpar_duplicadas.py --aplicar  # grava as alterações
"""
import json
import shutil
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
BANCO = RAIZ / "portal.db"


def norm(valor):
    return " ".join(str(valor or "").lower().split())


def assinatura(tarefa):
    """Tudo o que faz dois registros serem 'o mesmo trabalho'."""
    checklist = tuple(
        (str(item.get("text") or "").strip(), bool(item.get("done")))
        for item in (tarefa.get("checklist") or [])
        if isinstance(item, dict)
    )
    return (
        norm(tarefa.get("notes")),
        str(tarefa.get("priority") or ""),
        str(tarefa.get("status") or ""),
        str(tarefa.get("category") or ""),
        str(tarefa.get("sectorId") or ""),
        bool(tarefa.get("attachments")),
        checklist,
    )


def util(tarefa):
    """Marca um registro como 'com conteúdo próprio'.

    Um registro com nota escrita ou checklist preenchido carrega informação que
    o outro não tem — ele nunca é descartado, mesmo que o resto seja igual.
    """
    nota = norm(tarefa.get("notes"))
    itens = [i for i in (tarefa.get("checklist") or []) if isinstance(i, dict)]
    return bool(nota) or bool(itens)


def chave(tarefa):
    return (
        norm(tarefa.get("title")),
        str(tarefa.get("due") or tarefa.get("periodEnd") or "")[:10],
        norm(tarefa.get("owner")),
    )


def main():
    aplicar = "--aplicar" in sys.argv
    if not BANCO.exists():
        print(f"Banco não encontrado: {BANCO}")
        return 1

    copia = BANCO.with_name(f"portal.backup-{datetime.now():%Y%m%d-%H%M%S}.db")
    shutil.copy2(BANCO, copia)
    print(f"backup: {copia.name}\n")

    conexao = sqlite3.connect(BANCO, timeout=30)
    conexao.row_factory = sqlite3.Row
    linha = conexao.execute("SELECT data FROM portal_state WHERE id = 1").fetchone()
    estado = json.loads(linha["data"])
    tarefas = estado.get("tasks") or []
    apagadas = list(estado.get("deletedTaskIds") or [])

    grupos = defaultdict(list)
    for tarefa in tarefas:
        if isinstance(tarefa, dict):
            grupos[chave(tarefa)].append(tarefa)

    remover, preservar = [], []
    for chave_grupo, itens in grupos.items():
        if len(itens) < 2:
            continue
        itens.sort(key=lambda t: str(t.get("createdAt") or ""))
        assinaturas = {assinatura(t) for t in itens}
        uteis = [t for t in itens if util(t)]
        # Duas cópias do mesmo trabalho são descartáveis só quando nenhuma delas
        # carrega informação própria: sem nota e sem checklist. Basta uma ter
        # nota, checklist ou status diferente para o grupo ir para revisão humana.
        if len(assinaturas) == 1 and not uteis:
            remover.extend(itens[1:])
        else:
            preservar.append((chave_grupo, itens))

    print(f"grupos repetidos: {sum(1 for v in grupos.values() if len(v) > 1)}")
    print(f"  unificáveis (conteúdo idêntico): {len(remover)} registros a remover")
    print(f"  preservados (conteúdo diferente): {len(preservar)} grupos\n")

    if remover:
        print("── SERÃO REMOVIDOS (fica o mais antigo) ──")
        for tarefa in remover:
            print(f"  {str(tarefa.get('due'))[:10]}  {tarefa.get('owner'):12s}  {tarefa.get('title')}")
            print(f"      id={tarefa.get('id')}  criado={str(tarefa.get('createdAt'))[:19]}")
        print()

    if preservar:
        print("── PRESERVADOS: conteúdo diferente, decisão sua ──")
        for (titulo, dia, dono), itens in sorted(preservar, key=lambda x: x[0][1]):
            print(f"  {dia}  {dono}  '{titulo}'")
            for tarefa in itens:
                nota = (tarefa.get("notes") or "(sem nota)").strip().replace("\n", " ")[:70]
                print(f"      id={str(tarefa.get('id'))[:8]}  {str(tarefa.get('createdAt'))[:19]}  nota: {nota}")
            print()

    if not aplicar:
        print("Modo prévia. Rode com --aplicar para gravar.")
        return 0

    if not remover:
        print("Nada a gravar.")
        return 0

    ids_removidos = {str(t.get("id")) for t in remover}
    novo_estado = dict(estado)
    novo_estado["tasks"] = [t for t in tarefas if str(t.get("id")) not in ids_removidos]
    novo_estado["deletedTaskIds"] = sorted(set(apagadas) | ids_removidos)

    conexao.execute("BEGIN IMMEDIATE")
    conexao.execute(
        "UPDATE portal_state SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1",
        (json.dumps(novo_estado, ensure_ascii=False),),
    )
    # tombstones da sincronização também precisam saber, senão um aparelho
    # antigo ressuscita a demanda no próximo sync.
    try:
        conexao.executemany(
            "INSERT OR IGNORE INTO task_sync_tombstones(task_id) VALUES (?)",
            [(i,) for i in ids_removidos],
        )
    except sqlite3.Error:
        pass
    # libera as vagas (série, dia) que pertenciam aos registros removidos
    try:
        conexao.executemany(
            "DELETE FROM task_occurrences WHERE task_id = ?", [(i,) for i in ids_removidos]
        )
    except sqlite3.Error:
        pass
    conexao.commit()

    print(f"gravado: {len(ids_removidos)} demandas movidas para a lixeira.")
    print(f"demandas agora: {len(novo_estado['tasks'])}")
    conexao.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
