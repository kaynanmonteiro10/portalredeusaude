#!/usr/bin/env python3
import sqlite3
from datetime import datetime
import uuid

# Dados extraídos do Excel fornecido (Ades-es Sinteg 2026.xlsx)
adesoes_data = [
    # Janeiro 2026
    ("17001", "EXEMPLAR SERVICOS E LIMPEZA - 2471 - PJ", "1/2/26", "1/20/26", 9, 364.32, "CRM", "PAGO"),
    ("17002", "INSTITUTO BRASILEIRO DE POLITICAS PUBLICAS - 2662 - PJ", "1/2/26", "2/10/26", 1, 50.00, "WEB", "PAGO"),
    ("17003", "ATITUDE PARAIBA TERCEIRIZACAO DE MAO DE OBRA LTDA - 2609 - PJ", "1/5/26", "2/10/26", 9, 450.00, "CRM", "PAGO"),
    ("17004", "ATITUDE PARAIBA TERCEIRIZACAO DE MAO DE OBRA LTDA - 2609 - PJ", "1/6/26", "2/10/26", 3, 150.00, "CRM", "PAGO"),
    ("17005", "AMA FACILITIES - 2495 - PJ", "1/7/26", "2/10/26", 2, 100.00, "WEB", "PAGO"),
    ("17006", "ATITUDE PARAIBA TERCEIRIZACAO DE MAO DE OBRA LTDA - 2609 - PJ", "1/7/26", "2/10/26", 2, 100.00, "CRM", "PAGO"),
    ("17007", "SERVAL SERVICOS E LIMPEZA LTDA - 2425 - PJ", "1/7/26", "1/10/26", 1, 50.00, "CRM", "PAGO"),
    ("17008", "ZELO LOCACAO DE MAO DE OBRA EIRELI - 2587 - PJ", "1/7/26", "2/10/26", 1, 50.00, "CRM", "PAGO"),
    ("17009", "ZELO LOCACAO DE MAO DE OBRA EIRELI - 289 - PJ", "1/7/26", "2/10/26", 1, 50.00, "CRM", "PAGO"),
    ("17010", "ANTARES ENGENHARIA LTDA - 2911", "1/8/26", "1/10/26", 1, 50.00, "WEB", "PAGO"),
    ("17011", "CLEANMAX SERVICOS LTDA - 5190 - PJ", "1/8/26", "1/10/26", 1, 50.00, "CRM", "PAGO"),
    ("17012", "ATITUDE PARAIBA TERCEIRIZACAO DE MAO DE OBRA LTDA - 2609 - PJ", "1/9/26", "2/10/26", 2, 100.00, "CRM", "PAGO"),
    ("17013", "INSTITUTO BRASILEIRO DE POLITICAS PUBLICAS - 392 - PJ", "1/9/26", "2/10/26", 1, 50.00, "WEB", "PAGO"),
    ("17014", "ATITUDE PARAIBA TERCEIRIZACAO DE MAO DE OBRA LTDA - 2609 - PJ", "1/12/26", "2/10/26", 5, 250.00, "CRM", "PAGO"),
    ("17015", "POP TRADE MARKETING E CONSULTORIA LTDA - 3890 - PJ", "1/12/26", "1/20/26", 3, 150.00, "CRM", "PAGO"),
    
    # Fevereiro 2026
    ("17016", "AMA SERVICOS LTDA - 248 - PJ", "2/2/26", "3/10/26", 4, 200.00, "WEB", "PAGO"),
    ("17017", "IDEAL CONSERVACAO E LIMPEZA DE PREDIOS LTDA - 4929 - PJ", "2/2/26", "2/10/26", 1, 50.00, "CRM", "PAGO"),
    ("17018", "ATITUDE PARAIBA TERCEIRIZACAO DE MAO DE OBRA LTDA - 2609 - PJ", "2/2/26", "3/10/26", 1, 50.00, "CRM", "CANCELADO"),
    ("17019", "SERVAL SERVICOS E LIMPEZA LTDA - 2425 - PJ", "2/3/26", "2/10/26", 3, 150.00, "CRM", "PAGO"),
    ("17020", "SERVEBEM CONSERVACAO E LIMPEZA DE PREDIOS LTDA - 2895 - PJ", "2/3/26", "2/10/26", 1, 50.00, "CRM", "PAGO"),
    ("17021", "SERVEBEM CONSERVACAO E LIMPEZA DE PREDIOS LTDA - 478 - PJ", "2/3/26", "2/10/26", 2, 100.00, "CRM", "PAGO"),
    ("17022", "EXEMPLAR SERVICOS E LIMPEZA - 2471 - PJ", "2/6/26", "2/20/26", 32, 1295.36, "CRM", "PAGO"),
    ("17023", "RM TERCEIRIZACAO E GESTAO DE RECURSOS HUMANOS LTDA - 4078 - PJ", "2/9/26", "3/25/26", 1, 47.50, "CRM", "PAGO"),
    
    # Março 2026
    ("17024", "IDEAL CONSERVACAO E LIMPEZA DE PREDIOS LTDA - 4929 - PJ", "3/3/26", "3/10/26", 1, 60.00, "CRM", "PAGO"),
    ("17025", "IDEAL CONSERVACAO E LIMPEZA DE PREDIOS LTDA - 4931 - PJ", "3/3/26", "3/10/26", 2, 120.00, "CRM", "PAGO"),
    ("17026", "OS ELOFORT SERVICOS SA - 228 - PJ", "3/3/26", "3/10/26", 1, 60.00, "CRM", "PAGO"),
    ("17027", "ACAUA SERVICOS GERAIS LTDA - 222 - PJ", "3/4/26", "3/20/26", 4, 240.00, "CRM", "PAGO"),
    ("17028", "CONTROL CONSTRUCOES LTDA - 495 - PJ", "3/4/26", "3/20/26", 1, 60.00, "CRM", "PAGO"),
    ("17029", "CONTROL CONSTRUCOES SA - 494 - PJ", "3/4/26", "3/20/26", 12, 720.00, "CRM", "PAGO"),
    ("17030", "POP TRADE MARKETING E CONSULTORIA LTDA - 3890 - PJ", "3/4/26", "3/20/26", 2, 120.00, "CRM", "PAGO"),
    ("17031", "SERVAL SERVICOS E LIMPEZA LTDA - 2425 - PJ", "3/4/26", "3/10/26", 2, 120.00, "CRM", "PAGO"),
    ("17032", "TOP SERVICE SERVICOS E SISTEMAS SA - 388 - PJ", "3/4/26", "3/20/26", 6, 360.00, "CRM", "PAGO"),
    
    # Junho 2026
    ("17033", "GARCIA ENGENHARIA SERVICOS LTDA - 2903 - PJ", "6/1/26", "6/10/26", 1, 60.00, "WEB", "PAGO"),
    ("17034", "ZELO LOCACAO DE MAO DE OBRA LTDA - 5515 - PJ", "6/1/26", "6/10/26", 34, 2040.00, "CRM", "PAGO"),
    ("17035", "ATITUDE PARAIBA TERCEIRIZACAO DE MAO DE OBRA LTDA - 2609 - PJ", "6/1/26", "7/10/26", 1, 0.00, "CRM", "PAGO"),
    ("17036", "SERVAL SERVICOS E LIMPEZA LTDA - 2425 - PJ", "6/3/26", "6/10/26", 5, 300.00, "CRM", "PAGO"),
    ("17037", "CLEANMAX SERVICOS LTDA - 5190 - PJ", "6/8/26", "6/10/26", 1, 60.00, "CRM", "PAGO"),
    ("17038", "SOSERVI SOCIEDADE DE SERVICOS GERAIS L - 462 - PJ", "6/15/26", "6/18/26", 42, 2520.00, "CRM", "PAGO"),
    
    # Julho 2026
    ("17039", "ATITUDE PARAIBA TERCEIRIZACAO DE MAO DE OBRA LTDA - 2609 - PJ", "7/1/26", "7/10/26", 1, 60.00, "CRM", "PAGO"),
    ("17040", "ATITUDE PARAIBA TERCEIRIZACAO DE MAO DE OBRA LTDA - 2609 - PJ", "7/2/26", "8/10/26", 4, 240.00, "CRM", "PAGO"),
    ("17041", "IDEAL CONSERVACAO E LIMPEZA DE PREDIOS LTDA - 5397 - PJ", "7/2/26", "7/10/26", 1, 60.00, "CRM", "PAGO"),
    ("17042", "CONTATO SERVICOS DE CONSERVACAO E MANUTENCAO EIRELI - 2492 - PJ", "7/3/26", "7/28/26", 1, 60.00, "WEB", "PAGO"),
    ("17043", "RM TERCEIRIZACAO E GESTAO DE RECURSOS HUMANOS LTDA - 4078 - PJ", "7/3/26", "7/25/26", 24, 1368.00, "CRM", "PAGO"),
    
    # Agosto 2026
    ("17044", "EXEMPLAR SERVICOS E LIMPEZA - 2471 - PJ", "8/3/26", "8/20/26", 24, 971.52, "CRM", "PAGO"),
    ("17045", "SERVITE EMPREENDIMENTOS E SERVICOS LTDA - 5393 - PJ", "8/3/26", "8/10/26", 4, 240.00, "CRM", "PAGO"),
    ("17046", "BENIT CONSTRUCOES TERCEIRIZACAO E SERVICOS LTDA - 5333 - PJ", "8/4/26", "8/20/26", 1, 60.00, "CRM", "PAGO"),
    ("17047", "SERVAL SERVICOS E LIMPEZA LTDA - 2425 - PJ", "8/4/26", "8/10/26", 8, 480.00, "CRM", "PAGO"),
    ("17048", "CONTROL CONSTRUCOES SA - 494 - PJ", "8/5/26", "8/20/26", 8, 480.00, "CRM", "PAGO"),
    ("17049", "GARANTIA REAL SERVICOS LTDA - 4834 - PJ", "8/5/26", "9/10/26", 2, 120.00, "CRM", "PAGO"),
    
    # Setembro 2026
    ("17050", "R MARTINS SERVICOS TERCEIRIZADOS LTDA - 5419 - PJ", "9/1/26", "10/10/26", 1, 60.00, "CRM", "PAGO"),
    ("17051", "PREMIUM CONSERVADORA E CONSTRUCOES LTDA - 5592 - PJ", "9/2/26", "10/10/26", 4, 240.00, "CRM", "PAGO"),
    ("17052", "CLEANMAX SERVICOS LTDA - 5190 - PJ", "9/3/26", "9/10/26", 1, 60.00, "CRM", "PAGO"),
    ("17053", "RM TERCEIRIZACAO E GESTAO DE RECURSOS HUMANOS LTDA - 4078 - PJ", "9/3/26", "9/25/26", 39, 2223.00, "CRM", "PAGO"),
    ("17054", "ATITUDE PARAIBA TERCEIRIZACAO DE MAO DE OBRA LTDA - 2609 - PJ", "9/3/26", "9/10/26", 51, 3060.00, "CRM", "PAGO"),
    ("17055", "SERVAL SERVICOS E LIMPEZA LTDA - 2425 - PJ", "9/3/26", "10/10/26", 5, 300.00, "CRM", "PAGO"),
    
    # Outubro 2026
    ("17056", "SERVAL SERVICOS E LIMPEZA LTDA - 2425 - PJ", "10/5/26", "10/10/26", 6, 360.00, "CRM", "PAGO"),
    ("17057", "DMCG SERVICOS LTDA - 3010 - PJ", "10/6/26", "1/20/26", 2, 120.00, "CRM", "PAGO"),
    ("17058", "INTEGRA SERVICOS CORPORATIVOS LTDA - 5695 - PJ", "10/6/26", "10/20/26", 2, 120.00, "CRM", "PAGO"),
    ("17059", "PAULO EDUARDO M FRANCA NETO - 5700 - PJ", "10/7/26", "1/10/26", 1, 60.00, "CRM", "PAGO"),
    ("17060", "RM TERCEIRIZACAO E GESTAO DE RECURSOS HUMANOS LTDA - 4078 - PJ", "10/7/26", "10/25/26", 8, 456.00, "CRM", "PAGO"),
    ("17061", "EXEMPLAR SERVICOS E LIMPEZA - 2471 - PJ", "10/9/26", "10/20/26", 93, 3764.64, "CRM", "PAGO"),
    ("17062", "SOSERVI SOCIEDADE DE SERVICOS GERAIS L - 462 - PJ", "10/13/26", "10/15/26", 53, 3180.00, "CRM", "PAGO"),
    ("17063", "BRASANITAS EMPRESA BRASILEIRA DE SANEAMENTO E COM LTDA - 355 - PJ", "10/9/26", "10/15/26", 60, 3600.00, "CRM", "PAGO"),
    
    # Novembro 2026
    ("17064", "RM TERCEIRIZACAO E GESTAO DE RECURSOS HUMANOS LTDA - 4078 - PJ", "11/3/26", "11/25/26", 1, 57.00, "CRM", "PAGO"),
    ("17065", "RM TERCEIRIZACAO E GESTAO DE RECURSOS HUMANOS LTDA - 4078 - PJ", "11/3/26", "11/25/26", 4, 228.00, "CRM", "PAGO"),
    ("17066", "SEGURPRO TECNOLOGIA EM SISTEMAS DE SEGURANCA ELETRONICA E INCENDIOS LTDA - 2440 - PJ", "11/3/26", "11/10/26", 7, 420.00, "CRM", "PAGO"),
    ("17067", "ALLPARK EMPREENDIMENTOS PARTICIPACOES E SERVICOS SA ESTAPAR - 1153 - PJ", "11/4/26", "11/25/26", 1, 60.00, "CRM", "PAGO"),
    ("17068", "PLANSUL PLANEJAMENTO E CONSULTORIA LTDA - 5129 - PJ", "11/6/26", "11/10/26", 4, 240.00, "CRM", "PAGO"),
    ("17069", "SOLL SERVICOS OBRAS E LOCACAO LTDA - 969 - PJ", "11/6/26", "11/10/26", 1, 60.00, "CRM", "PAGO"),
]

def parse_date(date_str):
    """Parse Brazilian date format MM/DD/YY to YYYY-MM-DD"""
    if not date_str:
        return None
    try:
        parts = date_str.split('/')
        month, day, year = int(parts[0]), int(parts[1]), int(parts[2])
        # Assume 20XX for 26 -> 2026, etc
        if year < 50:
            year += 2000
        else:
            year += 1900
        return f"{year:04d}-{month:02d}-{day:02d}"
    except:
        return None

db = sqlite3.connect('portal.db')
cursor = db.cursor()

imported = 0
for lote, empresa, data_entrada, data_adesao, vidas, valor, tipo, situacao in adesoes_data:
    try:
        adesao_id = str(uuid.uuid4())
        entrada_iso = parse_date(data_entrada)
        adesao_iso = parse_date(data_adesao)
        
        cursor.execute("""
            INSERT INTO adesoes(id, lote, empresa, data_entrada, data_adesao, vidas, valor, tipo, situacao, 
                              conferencia_status, criado_em, atualizado_em)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (adesao_id, lote, empresa, entrada_iso, adesao_iso, vidas, valor, tipo, situacao, 
              'pendente', datetime.now().isoformat(), datetime.now().isoformat()))
        imported += 1
    except Exception as e:
        print(f"ERRO ao importar lote {lote}: {e}")

db.commit()
db.close()

print(f"✅ {imported} adesões importadas com sucesso!")
