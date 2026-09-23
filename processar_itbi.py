"""
processar_itbi.py
Baixa e processa arquivos ITBI da Prefeitura de SP → SQLite (itbi.db)
Uso:
  python processar_itbi.py                      # processa anos 2019–2026
  python processar_itbi.py --anos 2023,2024,2025
  python processar_itbi.py --so-local           # só processa arquivos já na pasta ITBI/

Deploy na nuvem (sem disco local pro itbi.db, 190MB): quando as variáveis de
ambiente TURSO_DATABASE_URL e TURSO_AUTH_TOKEN estão definidas, as consultas
(query_sql/batch_query_sql/mapa_precos_sql — usadas pelo app web) passam a ler
do Turso (SQLite hospedado, tier grátis) em vez do arquivo itbi.db local. O
processamento/importação (main(), abaixo) continua SEMPRE local — baixar e
popular o itbi.db é feito no escritório; pra levar os dados pro Turso depois,
rode `python processar_itbi.py --migrar-turso` (envia o conteúdo do itbi.db
local pro banco na nuvem). Sem essas variáveis definidas (uso normal, local),
nada muda — continua lendo o arquivo itbi.db como sempre.
"""

import sys, os, json, re, sqlite3, argparse, time
import urllib.request, urllib.error

TURSO_URL   = os.environ.get('TURSO_DATABASE_URL', '').strip()
TURSO_TOKEN = os.environ.get('TURSO_AUTH_TOKEN', '').strip()

try:
    import openpyxl
except ImportError:
    print("[ITBI] Instalando openpyxl...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "openpyxl", "--break-system-packages", "-q"])
    import openpyxl

# ── URLs dos arquivos ITBI ────────────────────────────────────────────────────
URLS = {
    2026: "https://prefeitura.sp.gov.br/documents/d/fazenda/guias-de-itbi-pagas-3-xlsx",
    2025: "https://prefeitura.sp.gov.br/cidade/secretarias/upload/fazenda/arquivos/itbi/GUIAS DE ITBI PAGAS %2828012026%29 XLS.xlsx",
    2024: "https://prefeitura.sp.gov.br/cidade/secretarias/upload/fazenda/arquivos/itbi/GUIAS-DE-ITBI-PAGAS-2024.xlsx",
    2023: "https://www.prefeitura.sp.gov.br/cidade/secretarias/upload/fazenda/arquivos/XLSX/GUIAS-DE-ITBI-PAGAS-2023.xlsx",
    2022: "https://www.prefeitura.sp.gov.br/cidade/secretarias/upload/fazenda/arquivos/XLSX/GUIAS_DE_ITBI_PAGAS_12-2022.xlsx",
    2021: "https://www.prefeitura.sp.gov.br/cidade/secretarias/upload/fazenda/arquivos/itbi/ITBI_Setembro_2022/GUIAS_DE_ITBI_PAGAS_(2021).xlsx",
    2020: "https://www.prefeitura.sp.gov.br/cidade/secretarias/upload/fazenda/arquivos/itbi/ITBI_Setembro_2022/GUIAS_DE_ITBI_PAGAS_(2020).xlsx",
    2019: "https://www.prefeitura.sp.gov.br/cidade/secretarias/upload/fazenda/arquivos/itbi/ITBI_Setembro_2022/GUIAS_DE_ITBI_PAGAS_(2019).xlsx",
    2018: "https://www.prefeitura.sp.gov.br/cidade/secretarias/upload/fazenda/arquivos/itbi/guias_de_itbi_pagas_2018.xlsx",
    2017: "https://www.prefeitura.sp.gov.br/cidade/secretarias/upload/fazenda/arquivos/itbi/guias_de_itbi_pagas_2017.xlsx",
    2016: "https://www.prefeitura.sp.gov.br/cidade/secretarias/upload/fazenda/arquivos/itbi/guias_de_itbi_pagas_2016.xlsx",
}

BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
ITBI_DIR   = os.path.join(BASE_DIR, "ITBI")
DB_PATH    = os.path.join(BASE_DIR, "itbi.db")
STATUS_PATH = os.path.join(BASE_DIR, "itbi_status.json")

os.makedirs(ITBI_DIR, exist_ok=True)

# ── Mapeamento flexível de colunas ─────────────────────────────────────────────
# Cada entry é (campo_destino, [variações_possíveis_de_nome_no_xlsx])
COL_MAP = [
    ("sql",             ["SQL", "SQCONT", "Nº SQL", "N° SQL", "NÚMERO SQL", "NUMERO SQL",
                         "N° do Cadastro (SQL)", "Nº do Cadastro (SQL)",
                         "N° DO CADASTRO", "N CADASTRO SQL", "CADASTRO SQL",
                         "N° Cadastro", "Nº Cadastro", "NUMERO CADASTRO"]),
    ("contrib",         ["NÚMERO DO CONTRIBUINTE", "NUMERO DO CONTRIBUINTE", "Nº CONTRIBUINTE", "N° CONTRIBUINTE",
                         "N° DO CONTRIBUINTE"]),
    ("natureza",        ["NATUREZA DE TRANSAÇÃO", "NATUREZA DE TRANSACAO",
                         "NATUREZA DA TRANSAÇÃO", "NATUREZA DA TRANSACAO",
                         "NATUREZA TRANSACAO", "NATUREZA"]),
    ("tipo_imovel",     ["TIPO DE IMÓVEL", "TIPO DE IMOVEL", "TIPO IMOVEL", "TIPO_IMOVEL"]),
    ("bairro",          ["BAIRRO"]),
    ("endereco",        ["ENDEREÇO", "ENDERECO", "LOGRADOURO", "NOME DO LOGRADOURO"]),
    ("numero",          ["NÚMERO", "NUMERO", "NUM", "Nº"]),
    ("cep",             ["CEP"]),
    ("area_terreno",    ["ÁREA DO TERRENO (M²)", "AREA DO TERRENO (M2)", "AREA TERRENO",
                         "ÁREA TERRENO (M²)", "AREA_TERRENO", "ÁREA DO TERRENO",
                         "ÁREA DO TERRENO (M2)"]),
    ("area_construida", ["ÁREA CONSTRUÍDA (M²)", "AREA CONSTRUIDA (M2)", "AREA CONSTRUIDA",
                         "ÁREA CONSTRUÍDA", "AREA_CONSTRUIDA", "ÁREA CONSTRUÍDA (M²)",
                         "ÁREA CONSTRUÍDA (M2)"]),
    ("valor_declarado", ["VALOR DE TRANSAÇÃO (DECLARADO PELO CONTRIBUINTE)",
                         "VALOR DE TRANSACAO (DECLARADO PELO CONTRIBUINTE)",
                         "VALOR DECLARADO (R$)", "VALOR DECLARADO", "VLR DECLARADO", "VALOR_DECLARADO",
                         "VALOR DE TRANSAÇÃO", "VALOR DE TRANSACAO"]),
    ("valor_financiado",["VALOR FINANCIADO (R$)", "VALOR FINANCIADO", "VLR FINANCIADO", "VALOR_FINANCIADO"]),
    ("valor_venal",     ["VALOR VENAL DE REFERÊNCIA PARA ITBI (R$)", "VALOR VENAL REFERENCIA",
                         "VALOR VENAL ITBI", "VLR VENAL REFERENCIA", "VALOR_VENAL",
                         "VALOR VENAL DE REFERÊNCIA"]),
    ("ano_mes",         ["ANO-MÊS", "ANO-MES", "MÊS/ANO", "MES/ANO", "ANO_MES", "PERIODO", "MES_ANO"]),
    ("data_transacao",  ["DATA DE TRANSAÇÃO", "DATA DE TRANSACAO",
                         "DATA DA TRANSAÇÃO", "DATA DA TRANSACAO",
                         "DATA TRANSACAO", "DATA_TRANSACAO", "DT TRANSACAO"]),
]

def _norm_col(s):
    """Normaliza nome de coluna para comparação."""
    return re.sub(r'[\s\-_/\.]+', ' ', str(s)).upper().strip()

def _detect_cols(headers):
    """Retorna dict {campo: índice_coluna} para as colunas encontradas."""
    norm_headers = {_norm_col(h): i for i, h in enumerate(headers)}
    result = {}
    for campo, variantes in COL_MAP:
        for v in variantes:
            nv = _norm_col(v)
            if nv in norm_headers:
                result[campo] = norm_headers[nv]
                break
    return result

def _norm_sql(raw):
    """Normaliza SQL: remove espaços, garante formato xxx.xxx.xxxx ou xxx.xxx.xxxx-d.
    Aceita tanto '016.077.0019-0' quanto número puro '1607700190' (10-11 dígitos).
    """
    if not raw:
        return None
    s = str(raw).strip()
    # Remove casas decimais se vier como float do Excel (ex: '1607700190.0').
    # IMPORTANTE: só aplica quando a string INTEIRA é um número puro + ".0" —
    # nunca num SQL já pontuado (setor.quadra.lote), senão um lote de
    # condomínio/quadra inteira tipo "013.019.0000" perdia o lote inteiro
    # (virava "013.019", sem 3 grupos), o que fazia _norm_sql retornar None
    # e a consulta (query_sql/mapa_precos_sql) sempre voltar "nenhuma
    # transação encontrada" mesmo havendo dados reais pra aquela quadra.
    if re.fullmatch(r'\d+\.0+', s):
        s = re.sub(r'\.0+$', '', s)
    # Se for número puro de 10 ou 11 dígitos → parseia como setor(3)+quadra(3)+lote(4)+digito(0-1)
    if re.fullmatch(r'\d{10,11}', s):
        n = s.zfill(11)  # garante 11 dígitos
        setor  = n[0:3]
        quadra = n[3:6]
        lote   = n[6:10]
        digito = n[10]
        sql = f"{setor}.{quadra}.{lote}"
        if digito and digito != '0':
            sql += f"-{digito}"
        return sql
    # Remove sufixo "-0" (dígito zero = sem dígito)
    s = re.sub(r'-0$', '', s)
    # Verifica se tem pelo menos setor.quadra.lote separados por ponto
    parts = re.findall(r'\d+', s)
    if len(parts) < 3:
        return None
    setor = parts[0].zfill(3)
    quadra = parts[1].zfill(3)
    lote = parts[2].zfill(4)
    digito = parts[3] if len(parts) > 3 else None
    sql = f"{setor}.{quadra}.{lote}"
    if digito and digito != '0':
        sql += f"-{digito}"
    return sql

def _norm_sql_base(sql):
    """Retorna apenas setor.quadra.lote sem dígito (para busca parcial)."""
    if not sql:
        return None
    m = re.match(r'^(\d{3}\.\d{3}\.\d{4})', sql)
    return m.group(1) if m else sql

def _sql_prefix(sql):
    """Retorna setor.quadra para busca de condomínio (ex: '016.153')."""
    if not sql:
        return None
    m = re.match(r'^(\d{3}\.\d{3})', sql)
    return m.group(1) if m else None

def _is_condo_sql(sql_norm):
    """Retorna True se o SQL é de condomínio (lote 0000 ou 0001)."""
    if not sql_norm:
        return False
    m = re.match(r'^\d{3}\.\d{3}\.(\d{4})(?:-\d+)?$', sql_norm)
    if not m:
        return False
    return m.group(1) in ('0000', '0001')

def _to_float(v):
    if v is None:
        return None
    try:
        s = str(v).replace('.', '').replace(',', '.').replace('R$', '').strip()
        return float(s) if s else None
    except:
        return None

def _to_str(v):
    if v is None:
        return ''
    return str(v).strip()

def _to_date(v):
    if v is None:
        return ''
    import datetime
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.strftime('%Y-%m-%d')
    s = str(v).strip()
    # tenta formatos comuns
    for fmt in ('%d/%m/%Y', '%Y-%m-%d', '%d-%m-%Y', '%Y/%m/%d'):
        try:
            return datetime.datetime.strptime(s, fmt).strftime('%Y-%m-%d')
        except:
            pass
    return s[:10] if len(s) >= 10 else s

# ── Banco de dados ──────────────────────────────────────────────────────────────
def init_db(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS itbi (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            sql             TEXT,
            sql_base        TEXT,
            sql_prefix      TEXT,
            contrib         TEXT,
            ano             INTEGER,
            ano_mes         TEXT,
            data_transacao  TEXT,
            natureza        TEXT,
            tipo_imovel     TEXT,
            bairro          TEXT,
            endereco        TEXT,
            numero          TEXT,
            cep             TEXT,
            area_terreno    REAL,
            area_construida REAL,
            valor_declarado REAL,
            valor_financiado REAL,
            valor_venal     REAL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sql        ON itbi(sql)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sql_base  ON itbi(sql_base)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sql_prefix ON itbi(sql_prefix)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ano        ON itbi(ano)")
    conn.commit()

def clear_ano(conn, ano):
    conn.execute("DELETE FROM itbi WHERE ano = ?", (ano,))
    conn.commit()

# ── Download ────────────────────────────────────────────────────────────────────
def download_file(ano, dest_path, progress_cb=None):
    url = URLS.get(ano)
    if not url:
        return False, f"URL não cadastrada para {ano}"
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0',
        'Referer': 'https://prefeitura.sp.gov.br/',
        'Accept': '*/*',
    }
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=120) as r:
            total = int(r.headers.get('Content-Length', 0))
            data = b''
            chunk = 65536
            downloaded = 0
            while True:
                buf = r.read(chunk)
                if not buf:
                    break
                data += buf
                downloaded += len(buf)
                if progress_cb:
                    progress_cb(downloaded, total)
        with open(dest_path, 'wb') as f:
            f.write(data)
        return True, f"{len(data)//1024}KB"
    except Exception as e:
        return False, str(e)

# ── Processamento Excel ─────────────────────────────────────────────────────────
def process_xlsx(path, ano, conn, progress_cb=None):
    """Lê planilha ITBI e insere no SQLite. Retorna (inseridos, erros)."""
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    total_inserted = 0
    total_errors   = 0

    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        rows = ws.iter_rows(values_only=True)

        # Detecta cabeçalho (primeira linha não vazia com ≥ 5 colunas)
        headers = None
        first_data_row = None
        for row in rows:
            if row and sum(1 for c in row if c is not None) >= 5:
                headers = list(row)
                break

        if headers is None:
            continue

        col_idx = _detect_cols(headers)
        if 'sql' not in col_idx and 'contrib' not in col_idx:
            # Não tem coluna identificadora — pula
            print(f"  [aviso] Aba '{sheet_name}' sem coluna SQL detectável. Cabeçalhos: {headers[:8]}", flush=True)
            continue
        print(f"  [ok] Aba '{sheet_name}' — coluna SQL em idx {col_idx.get('sql','?')}, colunas: {list(col_idx.keys())}", flush=True)

        batch = []
        for i, row in enumerate(rows):
            if not row or all(c is None for c in row):
                continue
            try:
                def gc(campo):
                    idx = col_idx.get(campo)
                    return row[idx] if idx is not None and idx < len(row) else None

                raw_sql  = gc('sql')
                contrib  = _to_str(gc('contrib'))
                sql_norm = _norm_sql(raw_sql) or _norm_sql(contrib)
                if not sql_norm:
                    total_errors += 1
                    continue

                sql_base   = _norm_sql_base(sql_norm)
                sql_prefix = _sql_prefix(sql_norm)
                dt       = _to_date(gc('data_transacao'))
                ano_mes  = _to_str(gc('ano_mes'))
                # Tenta inferir ano_mes do nome da aba ou do dado
                if not ano_mes:
                    ano_mes = str(ano)

                batch.append((
                    sql_norm, sql_base, sql_prefix, contrib, ano, ano_mes,
                    dt,
                    _to_str(gc('natureza')),
                    _to_str(gc('tipo_imovel')),
                    _to_str(gc('bairro')),
                    _to_str(gc('endereco')),
                    _to_str(gc('numero')),
                    _to_str(gc('cep')),
                    _to_float(gc('area_terreno')),
                    _to_float(gc('area_construida')),
                    _to_float(gc('valor_declarado')),
                    _to_float(gc('valor_financiado')),
                    _to_float(gc('valor_venal')),
                ))
                total_inserted += 1

                if len(batch) >= 2000:
                    conn.executemany("""
                        INSERT INTO itbi
                        (sql,sql_base,sql_prefix,contrib,ano,ano_mes,data_transacao,natureza,tipo_imovel,
                         bairro,endereco,numero,cep,area_terreno,area_construida,
                         valor_declarado,valor_financiado,valor_venal)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """, batch)
                    conn.commit()
                    batch = []
                    if progress_cb:
                        progress_cb(total_inserted)

            except Exception:
                total_errors += 1

        if batch:
            conn.executemany("""
                INSERT INTO itbi
                (sql,sql_base,sql_prefix,contrib,ano,ano_mes,data_transacao,natureza,tipo_imovel,
                 bairro,endereco,numero,cep,area_terreno,area_construida,
                 valor_declarado,valor_financiado,valor_venal)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, batch)
            conn.commit()

    wb.close()
    return total_inserted, total_errors

# ── Status ─────────────────────────────────────────────────────────────────────
def load_status():
    if os.path.exists(STATUS_PATH):
        try:
            with open(STATUS_PATH) as f:
                return json.load(f)
        except:
            pass
    return {"anos": {}, "db_rows": 0, "last_update": None}

def save_status(status):
    with open(STATUS_PATH, 'w') as f:
        json.dump(status, f, ensure_ascii=False, indent=2)

# ── Main ────────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--anos', default='2019,2020,2021,2022,2023,2024,2025,2026',
                        help='Anos a processar, separados por vírgula')
    parser.add_argument('--so-local', action='store_true',
                        help='Só processa arquivos já em ITBI/, sem baixar')
    parser.add_argument('--stdin-json', action='store_true',
                        help='Lê config do stdin como JSON e escreve progresso no stdout')
    args = parser.parse_args()

    anos = [int(a.strip()) for a in args.anos.split(',') if a.strip().isdigit()]
    status = load_status()

    # Marca como processando
    status["processing"] = True
    status["processing_step"] = "Iniciando..."
    status["processing_started"] = time.strftime('%Y-%m-%dT%H:%M:%S')
    save_status(status)

    conn = sqlite3.connect(DB_PATH)
    init_db(conn)

    results = {}
    anos_disponiveis = [a for a in anos if os.path.exists(os.path.join(ITBI_DIR, f"ITBI_{a}.xlsx"))]
    total_anos = len(anos_disponiveis) if args.so_local else len(anos)

    for i, ano in enumerate(anos):
        dest = os.path.join(ITBI_DIR, f"ITBI_{ano}.xlsx")

        # Download se necessário
        if not args.so_local and not os.path.exists(dest):
            status["processing_step"] = f"Baixando {ano}... ({i+1}/{len(anos)})"
            save_status(status)
            print(f"[{ano}] Baixando...", flush=True)
            ok, info = download_file(ano, dest)
            if not ok:
                print(f"[{ano}] ERRO download: {info}", flush=True)
                results[ano] = {"ok": False, "erro": info}
                continue
            print(f"[{ano}] Download OK ({info})", flush=True)
        elif not os.path.exists(dest):
            print(f"[{ano}] Arquivo não encontrado em ITBI/ITBI_{ano}.xlsx — pulando", flush=True)
            continue
        else:
            print(f"[{ano}] Arquivo local encontrado.", flush=True)

        # Processa
        status["processing_step"] = f"Processando {ano}... ({i+1}/{len(anos)})"
        save_status(status)
        print(f"[{ano}] Processando...", flush=True)
        clear_ano(conn, ano)
        try:
            def make_progress(ano_):
                def cb(n):
                    if n % 10000 == 0:
                        status["processing_step"] = f"Processando {ano_}: {n:,} linhas..."
                        save_status(status)
                        print(f"[{ano_}] {n} linhas...", flush=True)
                return cb
            inserted, errors = process_xlsx(dest, ano, conn, progress_cb=make_progress(ano))
            print(f"[{ano}] OK — {inserted} transações inseridas, {errors} erros", flush=True)
            status["anos"][str(ano)] = {
                "inserted": inserted, "errors": errors,
                "file_size": os.path.getsize(dest),
                "processed_at": time.strftime('%Y-%m-%dT%H:%M:%S')
            }
            results[ano] = {"ok": True, "inserted": inserted}
        except Exception as e:
            print(f"[{ano}] ERRO processamento: {e}", flush=True)
            results[ano] = {"ok": False, "erro": str(e)}

    # Atualiza status final
    row_count = conn.execute("SELECT COUNT(*) FROM itbi").fetchone()[0]
    status["db_rows"]        = row_count
    status["last_update"]    = time.strftime('%Y-%m-%dT%H:%M:%S')
    status["processing"]     = False
    status["processing_step"] = f"Concluído — {row_count:,} transações"
    save_status(status)
    conn.close()

    print(f"\n[ITBI] Concluído. Total no banco: {row_count} transações.", flush=True)
    print(json.dumps({"ok": True, "rows": row_count, "anos": results}), flush=True)


def _get_conn():
    """Conexão de LEITURA com o banco ITBI: Turso (SQLite hospedado) quando
    TURSO_DATABASE_URL/TURSO_AUTH_TOKEN estão definidas (servidor rodando na
    nuvem, sem o itbi.db local) — senão o arquivo local itbi.db, como sempre.
    """
    if TURSO_URL and TURSO_TOKEN:
        try:
            import libsql
        except ImportError:
            print("[ITBI] Instalando libsql...")
            import subprocess
            subprocess.check_call([sys.executable, "-m", "pip", "install", "libsql", "--break-system-packages", "-q"])
            import libsql
        return libsql.connect(TURSO_URL, auth_token=TURSO_TOKEN)
    return sqlite3.connect(DB_PATH, timeout=10)

def _db_disponivel():
    if TURSO_URL and TURSO_TOKEN:
        return True  # existência real só se confirma na consulta (erro de conexão cai no except de cada função)
    return os.path.exists(DB_PATH)

def _rows_to_dicts(conn, query, params=()):
    # Não depende de sqlite3.Row (o driver do Turso/libsql é parecido mas não
    # é garantido ter o mesmo row_factory) — monta os dicts a partir de
    # cursor.description, que existe em qualquer driver DB-API.
    cur = conn.execute(query, params)
    cols = [d[0] for d in cur.description] if cur.description else []
    return [dict(zip(cols, row)) for row in cur.fetchall()]

def query_sql(sql_raw, limit=200, exact=False):
    """Consulta transacoes ITBI por SQL. Retorna JSON.
    Para condominios (lote 0000/0001), retorna todas as unidades agrupadas —
    a menos que exact=True, que sempre restringe ao SQL/lote especifico
    (usado pela camada "Mapa de Preços", onde cada lote deve mostrar só as
    suas próprias transações, não o condomínio/quadra inteira).
    """
    if not _db_disponivel():
        return json.dumps({"ok": False, "error": "Banco ITBI nao processado ainda.", "rows": []})

    sql_norm  = _norm_sql(sql_raw)
    sql_base  = _norm_sql_base(sql_norm) if sql_norm else _norm_sql_base(sql_raw)
    is_condo  = (not exact) and bool(sql_norm and re.search(r'\.(0000|0001)(?:-|$)', sql_norm))

    try:
        conn = _get_conn()
        if is_condo:
            prefix = _sql_prefix(sql_norm)
            rows = _rows_to_dicts(conn,
                "SELECT * FROM itbi WHERE sql_prefix = ? ORDER BY data_transacao DESC LIMIT ?",
                (prefix, limit))
            conn.close()
            return json.dumps({"ok": True, "sql": sql_norm, "prefix": prefix,
                               "is_condo": True, "rows": rows}, ensure_ascii=False)
        else:
            rows = _rows_to_dicts(conn,
                "SELECT * FROM itbi WHERE sql = ? ORDER BY data_transacao DESC LIMIT ?",
                (sql_norm, limit))
            if not rows and sql_base:
                rows = _rows_to_dicts(conn,
                    "SELECT * FROM itbi WHERE sql_base = ? ORDER BY data_transacao DESC LIMIT ?",
                    (sql_base, limit))
            conn.close()
            return json.dumps({"ok": True, "sql": sql_norm, "is_condo": False,
                               "rows": rows}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e), "rows": []})


def batch_query_sql(sqls_json):
    """Recebe JSON com lista de SQLs, retorna mapa {sql: {count, last_date, last_price, last_year}}."""
    try:
        sqls = json.loads(sqls_json)
    except Exception:
        return json.dumps({"ok": False, "error": "JSON invalido", "result": {}})
    if not _db_disponivel():
        return json.dumps({"ok": False, "error": "Banco ITBI nao processado.", "result": {}})
    try:
        conn = _get_conn()
        result = {}
        for sql_raw in sqls:
            sql_norm = _norm_sql(sql_raw)
            if not sql_norm:
                continue
            rows = _rows_to_dicts(conn,
                "SELECT data_transacao, valor_declarado FROM itbi WHERE sql = ? ORDER BY data_transacao DESC LIMIT 10",
                (sql_norm,))
            if not rows:
                sql_base = _norm_sql_base(sql_norm)
                if sql_base:
                    rows = _rows_to_dicts(conn,
                        "SELECT data_transacao, valor_declarado FROM itbi WHERE sql_base = ? ORDER BY data_transacao DESC LIMIT 10",
                        (sql_base,))
            if rows:
                last = rows[0]
                last_year = None
                if last.get('data_transacao'):
                    try: last_year = int(str(last['data_transacao'])[:4])
                    except: pass
                result[sql_raw] = {
                    "count": len(rows),
                    "last_date": last.get('data_transacao'),
                    "last_price": last.get('valor_declarado'),
                    "last_year": last_year
                }
        conn.close()
        return json.dumps({"ok": True, "result": result}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e), "result": {}})


def _median(vals):
    """Mediana simples de uma lista de numeros."""
    if not vals:
        return None
    s = sorted(vals)
    n = len(s)
    mid = n // 2
    if n % 2 == 1:
        return s[mid]
    return (s[mid - 1] + s[mid]) / 2


def mapa_precos_sql(sqls_json, anos_min=None):
    """Recebe JSON com lista de SQLs (lotes visiveis no mapa) e retorna
    {sql: {preco_m2, n}} com a MEDIANA de R$/m² (valor_declarado/area_construida)
    dos ultimos ~3 anos disponiveis no banco, agrupado por lote (sql_base) ou,
    no caso de condominios (lote 0000/0001), por quadra inteira (sql_prefix) —
    mesmo criterio ja usado em query_sql() para agrupar unidades de um predio.
    Usado pela camada "Mapa de Preços (ITBI)" do mapa principal.
    """
    try:
        sqls = json.loads(sqls_json)
    except Exception:
        return json.dumps({"ok": False, "error": "JSON invalido", "result": {}})
    if not _db_disponivel():
        return json.dumps({"ok": False, "error": "Banco ITBI nao processado.", "result": {}})
    try:
        conn = _get_conn()
        cur = conn.cursor()
        if anos_min is None:
            row = cur.execute("SELECT MAX(ano) FROM itbi").fetchone()
            max_ano = row[0] if row and row[0] else 2026
            anos_min = max_ano - 2  # ultimos 3 anos, mesma janela usada como referencia de mercado
        result = {}
        for sql_raw in sqls:
            sql_norm = _norm_sql(sql_raw)
            if not sql_norm:
                continue
            if _is_condo_sql(sql_norm):
                key_col, key_val = 'sql_prefix', _sql_prefix(sql_norm)
            else:
                key_col, key_val = 'sql_base', _norm_sql_base(sql_norm)
            if not key_val:
                continue
            rows = cur.execute(
                f"SELECT valor_declarado, area_construida FROM itbi "
                f"WHERE {key_col} = ? AND ano >= ? AND valor_declarado > 0 AND area_construida > 0",
                (key_val, anos_min)
            ).fetchall()
            if not rows:
                continue
            precos_m2 = [v / a for v, a in rows if a]
            if not precos_m2:
                continue
            med = _median(precos_m2)
            result[sql_raw] = {"preco_m2": round(med, 2), "n": len(precos_m2)}
        conn.close()
        return json.dumps({"ok": True, "result": result, "anos_min": anos_min}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e), "result": {}})


def migrar_para_turso(lote=2000):
    """Copia TODO o conteúdo do itbi.db local pro banco no Turso (cria a
    tabela lá se ainda não existir). Rodar manualmente sempre que reprocessar
    o banco local (baixar anos novos etc.) e quiser refletir isso na nuvem —
    não é automático. Precisa de TURSO_DATABASE_URL e TURSO_AUTH_TOKEN
    definidas no ambiente antes de rodar.
    """
    if not (TURSO_URL and TURSO_TOKEN):
        print("[ITBI] ERRO: defina TURSO_DATABASE_URL e TURSO_AUTH_TOKEN antes de migrar.", flush=True)
        return
    if not os.path.exists(DB_PATH):
        print(f"[ITBI] ERRO: {DB_PATH} não encontrado — processe o banco local primeiro.", flush=True)
        return

    print("[ITBI] Conectando no banco local...", flush=True)
    local = sqlite3.connect(DB_PATH)
    total = local.execute("SELECT COUNT(*) FROM itbi").fetchone()[0]
    print(f"[ITBI] {total:,} linhas no itbi.db local. Conectando no Turso...", flush=True)

    remoto = _get_conn()
    init_db(remoto)  # cria a tabela + índices lá se ainda não existirem
    print("[ITBI] Limpando tabela no Turso antes de reenviar (evita duplicar)...", flush=True)
    remoto.execute("DELETE FROM itbi")
    remoto.commit()

    cols = ["sql", "sql_base", "sql_prefix", "contrib", "ano", "ano_mes",
            "data_transacao", "natureza", "tipo_imovel", "bairro", "endereco",
            "numero", "cep", "area_terreno", "area_construida",
            "valor_declarado", "valor_financiado", "valor_venal"]
    placeholders = ",".join(["?"] * len(cols))
    insert_sql = f"INSERT INTO itbi ({','.join(cols)}) VALUES ({placeholders})"

    cur = local.execute(f"SELECT {','.join(cols)} FROM itbi")
    enviados = 0
    while True:
        rows = cur.fetchmany(lote)
        if not rows:
            break
        for row in rows:
            remoto.execute(insert_sql, row)
        remoto.commit()
        enviados += len(rows)
        if enviados % (lote * 10) == 0 or enviados >= total:
            print(f"[ITBI] {enviados:,}/{total:,} linhas enviadas pro Turso...", flush=True)

    local.close()
    remoto.close()
    print(f"[ITBI] Migração concluída — {enviados:,} linhas no Turso.", flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--anos', default='2019,2020,2021,2022,2023,2024,2025,2026')
    parser.add_argument('--so-local', action='store_true')
    parser.add_argument('--stdin-json', action='store_true')
    parser.add_argument('--query-sql', dest='query_sql', default=None,
                        help='Consulta transacoes por SQL e imprime JSON')
    parser.add_argument('--exact', action='store_true',
                        help='Com --query-sql, restringe ao lote especifico (nunca agrupa condominio/quadra)')
    parser.add_argument('--batch-sql', dest='batch_sql', default=None,
                        help='Consulta batch de SQLs (JSON array) e imprime mapa JSON')
    parser.add_argument('--mapa-precos', dest='mapa_precos', default=None,
                        help='Consulta mediana de R$/m2 por lote (JSON array de SQLs) para camada do mapa')
    parser.add_argument('--migrar-turso', dest='migrar_turso', action='store_true',
                        help='Copia o itbi.db local inteiro pro banco Turso (requer TURSO_DATABASE_URL/TURSO_AUTH_TOKEN no ambiente)')
    args = parser.parse_args()

    if args.query_sql:
        print(query_sql(args.query_sql, exact=args.exact))
    elif args.batch_sql:
        print(batch_query_sql(args.batch_sql))
    elif args.mapa_precos:
        print(mapa_precos_sql(args.mapa_precos))
    elif args.migrar_turso:
        migrar_para_turso()
    else:
        main()
