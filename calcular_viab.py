"""
calcular_viab.py
Abre a planilha de viabilidade no Excel (via COM), aplica os inputs,
força o cálculo de todas as 38 abas, e retorna as células do
Relatório (2) + Apoio como JSON.

IMPORTANTE: usa DispatchEx para criar sempre uma instância NOVA e isolada
do Excel — nunca conecta ao Excel aberto pelo usuário.

Uso:
    python calcular_viab.py < inputs.json
    python calcular_viab.py --save "C:/caminho/saida.xlsx" < inputs.json

Requer: pip install pywin32
"""
import sys
import os
import json
import argparse
import traceback

TEMPLATE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "Viabilidade Padrão - REV 22 claude.xlsm")

# Células do Relatório (2) que queremos retornar
RELATORIO_RANGE = (1, 69, 2, 19)   # rows 1-69, cols B(2)-S(19)

# Células da aba Apoio que queremos retornar (totais / calculadas)
APOIO_CELLS = [
    'E19','F19','G19','H19','I19','J19','K19',
    'H21','H22','H23',
    'F3','F4','F5','F6','F7','F8','F9','F10','F11','F12',
    'G3','G4','G5','G6','G7','G8','G9','G10','G11','G12',
    'I3','I4','I5','I6','I7','I8','I9','I10','I11','I12',
    'K3','K4','K5','K6','K7','K8','K9','K10','K11','K12',
    'N3','N4','N5','N6','N7','N8','N9','N10','N11','N12',
]


def col_letter(n):
    """1-based column number to letter(s): 1->A, 2->B, 26->Z, 27->AA..."""
    s = ''
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def _new_excel():
    """
    Cria uma instância NOVA e completamente isolada do Excel.
    DispatchEx garante um processo separado — nunca reutiliza o Excel do usuário.
    """
    import win32com.client
    excel = win32com.client.DispatchEx("Excel.Application")
    excel.Visible = False
    excel.DisplayAlerts = False
    excel.ScreenUpdating = False
    excel.EnableEvents = False
    excel.AskToUpdateLinks = False
    excel.AutomationSecurity = 3  # desabilita macros VBA
    return excel


def _apply_inputs(wb, inputs: dict):
    """Aplica o dicionário de inputs ao workbook aberto."""
    for key, val in inputs.items():
        pipe = key.find('|')
        if pipe < 0:
            continue
        sheet_name = key[:pipe]
        coord      = key[pipe + 1:]
        try:
            ws = wb.Sheets(sheet_name)
            try:
                num = float(str(val).replace('.', '').replace(',', '.'))
                ws.Range(coord).Value = num
            except (ValueError, TypeError):
                ws.Range(coord).Value = str(val) if val is not None else ''
        except Exception:
            pass


def _quit_excel(excel, wb):
    """Fecha o workbook SEM salvar e encerra a instância do Excel."""
    try:
        if wb is not None:
            wb.Close(SaveChanges=False)
    except Exception:
        pass
    try:
        if excel is not None:
            excel.Quit()
    except Exception:
        pass


def save_xlsx(inputs: dict, out_path: str) -> dict:
    """
    Abre o template numa instância isolada, aplica inputs, calcula,
    salva como .xlsx em out_path, fecha e encerra o Excel.
    """
    try:
        import win32com.client
        import pythoncom
    except ImportError:
        return {"error": "pywin32 não instalado. Execute: pip install pywin32"}

    if not os.path.exists(TEMPLATE):
        return {"error": f"Template não encontrado: {TEMPLATE}"}

    pythoncom.CoInitialize()
    excel = None
    wb    = None

    try:
        excel = _new_excel()
        wb    = excel.Workbooks.Open(TEMPLATE, UpdateLinks=0, ReadOnly=False,
                                     IgnoreReadOnlyRecommended=True, Notify=False)

        _apply_inputs(wb, inputs)

        try:
            wb.Calculate()
        except Exception:
            pass

        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        # FileFormat 51 = xlOpenXMLWorkbook (.xlsx sem macros)
        wb.SaveAs(os.path.abspath(out_path), FileFormat=51, ConflictResolution=2)

        return {"ok": True, "path": out_path}

    except Exception as e:
        return {"error": str(e), "trace": traceback.format_exc()}

    finally:
        _quit_excel(excel, None)   # wb já foi salvo como xlsx; não fechar pelo wb para evitar prompt
        try:
            pythoncom.CoUninitialize()
        except Exception:
            pass


def run(inputs: dict) -> dict:
    """
    Abre o template numa instância isolada, aplica inputs, calcula,
    lê os valores do Relatório (2) e Apoio, fecha e encerra o Excel.
    """
    try:
        import win32com.client
        import pythoncom
    except ImportError:
        return {"error": "pywin32 não instalado. Execute: pip install pywin32"}

    if not os.path.exists(TEMPLATE):
        return {"error": f"Template não encontrado: {TEMPLATE}"}

    pythoncom.CoInitialize()
    excel = None
    wb    = None

    try:
        excel = _new_excel()
        wb    = excel.Workbooks.Open(TEMPLATE, UpdateLinks=0, ReadOnly=False,
                                     IgnoreReadOnlyRecommended=True, Notify=False)

        _apply_inputs(wb, inputs)

        try:
            wb.Calculate()
        except Exception:
            pass

        # ── Ler Relatório (2) ─────────────────────────────────────────────────
        results = {"_sheet": "Relatório (2)"}
        try:
            rel = wb.Sheets("Relatório (2)")
            r1, r2, c1, c2 = RELATORIO_RANGE
            for row in range(r1, r2 + 1):
                for col in range(c1, c2 + 1):
                    v = rel.Cells(row, col).Value
                    if v is not None and v != '':
                        coord = col_letter(col) + str(row)
                        results[coord] = round(v, 6) if isinstance(v, float) else v
        except Exception as e:
            results["_relatorio_error"] = str(e)

        # ── Ler células calculadas da Apoio ───────────────────────────────────
        apoio_results = {}
        try:
            apoio_ws = wb.Sheets("Apoio")
            for coord in APOIO_CELLS:
                try:
                    v = apoio_ws.Range(coord).Value
                    if v is not None:
                        apoio_results[coord] = round(v, 6) if isinstance(v, float) else v
                except Exception:
                    pass
        except Exception as e:
            apoio_results["_error"] = str(e)
        results["_apoio"] = apoio_results

        return results

    except Exception as e:
        return {"error": str(e), "trace": traceback.format_exc()}

    finally:
        _quit_excel(excel, wb)
        try:
            pythoncom.CoUninitialize()
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--inputs', type=str, help='JSON string com inputs')
    parser.add_argument('--save',   type=str, help='Caminho de saída .xlsx (modo salvar)')
    args = parser.parse_args()

    if args.inputs:
        raw = args.inputs
    else:
        raw = sys.stdin.read().strip()

    if not raw:
        inputs = {}
    else:
        try:
            inputs = json.loads(raw)
        except json.JSONDecodeError as e:
            print(json.dumps({"error": f"JSON inválido: {e}"}))
            sys.exit(1)

    if args.save:
        result = save_xlsx(inputs, args.save)
    else:
        result = run(inputs)
    print(json.dumps(result, ensure_ascii=False, default=str))


if __name__ == '__main__':
    main()
