"""Validação de dados de adesões contra base local.

Valida lote, empresa, data de entrada e quantidade de vidas.
Retorna um dict com status, erros e avisos.
"""

import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "portal.db"


def validate_adesao(lote, empresa, data_entrada_iso, vidas_count):
    """
    Valida uma adesão contra critérios locais.
    
    Args:
        lote: str - código do lote
        empresa: str - nome ou código da empresa
        data_entrada_iso: str - data no formato ISO (YYYY-MM-DD)
        vidas_count: int - quantidade de vidas
    
    Returns:
        dict: { "valid": bool, "errors": [...], "warnings": [...] }
    """
    errors = []
    warnings = []
    
    # Validar lote
    if not lote or not str(lote).strip():
        errors.append("Lote não informado")
    elif len(str(lote).strip()) > 50:
        errors.append("Lote muito longo (máx 50 caracteres)")
    
    # Validar empresa
    if not empresa or not str(empresa).strip():
        errors.append("Empresa não informada")
    elif len(str(empresa).strip()) > 255:
        errors.append("Nome da empresa muito longo")
    
    # Validar data de entrada
    if not data_entrada_iso:
        errors.append("Data de entrada não informada")
    else:
        try:
            entry_date = datetime.fromisoformat(data_entrada_iso)
            today = datetime.now()
            diff_days = (today - entry_date).days
            
            if diff_days < -2:
                errors.append(f"Data de entrada no futuro ({data_entrada_iso})")
            elif diff_days > 365:
                warnings.append(f"Entrada é de mais de 1 ano atrás ({data_entrada_iso})")
        except (ValueError, TypeError):
            errors.append(f"Data inválida: {data_entrada_iso} (esperado YYYY-MM-DD)")
    
    # Validar quantidade de vidas
    try:
        vidas_int = int(vidas_count) if vidas_count else 0
        if vidas_int <= 0:
            errors.append(f"Quantidade de vidas inválida: {vidas_count} (deve ser > 0)")
        elif vidas_int > 100000:
            warnings.append(f"Quantidade de vidas acima do esperado: {vidas_int}")
    except (ValueError, TypeError):
        errors.append(f"Quantidade de vidas não é um número: {vidas_count}")
    
    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
    }


def validate_company_exists(empresa_codigo_or_name):
    """
    Verifica se a empresa existe na base local (se houver tabela de empresas).
    
    Args:
        empresa_codigo_or_name: str - código ou nome da empresa
    
    Returns:
        tuple: (exists: bool, message: str)
    """
    try:
        conn = sqlite3.connect(DB_PATH, timeout=5)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        
        # Tenta encontrar em uma tabela de empresas ou contratos
        # Ajuste conforme a estrutura real do banco
        cursor.execute("""
            SELECT 1 FROM contracts
            WHERE UPPER(company_name) LIKE UPPER(?)
            OR UPPER(company_code) = UPPER(?)
            LIMIT 1
        """, (f"%{empresa_codigo_or_name}%", empresa_codigo_or_name))
        
        result = cursor.fetchone()
        conn.close()
        
        if result:
            return True, "Empresa encontrada na base"
        return False, f"Empresa não encontrada: {empresa_codigo_or_name}"
    except Exception as e:
        # Se a tabela não existir ou houver erro, não falha a validação
        return True, f"Verificação de empresa não disponível ({str(e)[:30]})"


def validate_adesao_with_s4e(lote, empresa, data_entrada_iso, vidas_count, http_session=None):
    """
    Valida uma adesão com verificação opcional contra S4E.
    
    Se http_session for fornecida, tenta verificar a empresa no S4E.
    Caso contrário, valida apenas critérios locais.
    
    Args:
        lote: str - código do lote
        empresa: str - nome ou código da empresa
        data_entrada_iso: str - data no formato ISO (YYYY-MM-DD)
        vidas_count: int - quantidade de vidas
        http_session: s4e_connector.S4EHttp (opcional) - sessão S4E para verificação
    
    Returns:
        dict: { "valid": bool, "errors": [...], "warnings": [...] }
    """
    # Começa com validação local
    result = validate_adesao(lote, empresa, data_entrada_iso, vidas_count)
    
    # Se houver erros locais, retorna sem fazer chamadas S4E
    if result["errors"]:
        return result
    
    # Se tiver sessão S4E, tenta verificar a empresa lá
    if http_session:
        try:
            # Importa s4e_connector apenas se necessário
            from s4e_connector import fetch_contacts, ConnectorError
            
            # Tenta extrair código da empresa se estiver em formato "123 - Nome"
            import re
            code_match = re.match(r"^\s*(\d+)\s*-", str(empresa or ""))
            if code_match:
                code = code_match.group(1)
                try:
                    # Verifica se a empresa existe em S4E
                    contacts = fetch_contacts(http_session, code, "")
                    # Se fetch_contacts não lançar erro, empresa existe
                    result["warnings"].append(f"Empresa verificada no S4E (código {code})")
                except ConnectorError as s4e_err:
                    result["warnings"].append(f"Aviso S4E: {str(s4e_err)[:50]}")
                except Exception:
                    # Erros de rede ou parsing não invalidam a adesão
                    pass
        except ImportError:
            # s4e_connector não disponível, apenas validação local
            pass
        except Exception:
            # Qualquer erro em verificação S4E não deve quebrar a validação
            pass
    
    return result
