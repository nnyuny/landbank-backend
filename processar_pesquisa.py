import sys, json, os
import pandas as pd
import numpy as np
import warnings
warnings.filterwarnings('ignore')

BASE  = os.path.dirname(os.path.abspath(__file__))
EXCEL = os.path.join(BASE, 'Pesquisa de mercado', 'Pesquisa de Mercado 2016-2026.xlsx')
ANOS_SERIE = list(range(2019, 2026))
PRECO = '(VUV) Preco m2 privativo na data pesquisa'
VGV   = 'VGV'
VSO   = '% Unidades Vendidas'
CLASS = 'Classificacao do tipo'
AREA  = 'Área Privativa'

# Faixas de tamanho (área privativa) — pedidas pela Kamila, pra entender a
# "vocação" de cada região (que tipo de produto/metragem ela concentra).
TAMANHO_FAIXAS = [
    ('ate-30',    0,   30),
    ('31-50',    30,   50),
    ('51-80',    50,   80),
    ('81-120',   80,  120),
    ('121-180', 120,  180),
    ('181-220', 180,  220),
    ('acima-220',220,  np.inf),
]

# Faixas de ticket (preço médio por unidade = VGV / Unidades)
TICKET_FAIXAS = [
    ('ate-2M',     0,      2e6),
    ('2M-5M',      2e6,    5e6),
    ('5M-10M',     5e6,   10e6),
    ('10M-20M',    10e6,  20e6),
    ('acima-20M',  20e6,  np.inf),
]

def faixa_tamanho_label(area):
    """Devolve o label da faixa de tamanho (TAMANHO_FAIXAS) pra uma área
    privativa, ou None se a área for inválida/ausente."""
    if area is None or (isinstance(area, float) and np.isnan(area)) or area <= 0:
        return None
    for label, lo, hi in TAMANHO_FAIXAS:
        if lo <= area < hi:
            return label
    return None

def safe(v):
    if v is None or (isinstance(v, float) and np.isnan(v)): return None
    if isinstance(v, np.integer):  return int(v)
    if isinstance(v, np.floating): return round(float(v), 2)
    return v

def build_kpis(frame, alto):
    ticket_m = frame['ticket'].median() if 'ticket' in frame.columns else None
    ticket_a = alto['ticket'].median()  if 'ticket' in alto.columns  else None
    return {
        'vgv_mercado_total_bi':    safe(frame[VGV].sum()/1e9),
        'vgv_alto_bi':             safe(alto[VGV].sum()/1e9),
        'preco_medio_mercado':     safe(frame[PRECO].mean()),
        'preco_medio_alto':        safe(alto[PRECO].mean()),
        'vso_mercado':             safe(frame[VSO].mean()),
        'vso_alto':                safe(alto[VSO].mean()),
        'empreendimentos_mercado': safe(frame['Empreendimento'].nunique()),
        'empreendimentos_alto':    safe(alto['Empreendimento'].nunique()),
        'unidades_mercado':        safe(int(frame['Unidades'].sum())),
        'unidades_alto':           safe(int(alto['Unidades'].sum())),
        'ticket_medio_mercado':    safe(ticket_m),
        'ticket_medio_alto':       safe(ticket_a),
    }

def build_series(frame, alto):
    def serie(fr, col, func):
        g = fr.groupby('ano')[col]
        r = g.sum() if func == 'sum' else g.mean()
        return [safe(r.get(a)) for a in ANOS_SERIE]

    va    = serie(alto,  VGV, 'sum')
    vm    = serie(frame, VGV, 'sum')
    vso_m = serie(frame, VSO, 'mean')
    unid_m = [safe(int(frame[frame['ano']==a]['Unidades'].sum())) for a in ANOS_SERIE]
    unid_disp = [
        safe(round(u * (1 - (v or 0) / 100))) if u else None
        for u, v in zip(unid_m, vso_m)
    ]
    return {
        'anos':                [str(a) for a in ANOS_SERIE],
        'vgv_alto_mm':         [round(v/1e6,1) if v else None for v in va],
        'vgv_mercado_mm':      [round(v/1e6,1) if v else None for v in vm],
        'preco_alto':          serie(alto,  PRECO,'mean'),
        'preco_mercado':       serie(frame, PRECO,'mean'),
        'vso_alto':            serie(alto,  VSO,  'mean'),
        'vso_mercado':         vso_m,
        'emps_alto':           [safe(alto[alto['ano']==a]['Empreendimento'].nunique())   for a in ANOS_SERIE],
        'emps_mercado':        [safe(frame[frame['ano']==a]['Empreendimento'].nunique()) for a in ANOS_SERIE],
        'unidades_mercado':    unid_m,
        'unidades_disponiveis': unid_disp,
    }

try:
    df = pd.read_excel(EXCEL, sheet_name='plan', header=0)
    df.columns = [str(c).strip() for c in df.columns]
    # normalizar nomes de colunas com acento (pode variar)
    col_map = {}
    for c in df.columns:
        if 'privativo na data' in c: col_map[c] = PRECO
        if 'Classifica' in c:        col_map[c] = CLASS
        if 'rea Privativa' in c or 'rea privativa' in c: col_map[c] = AREA
    df.rename(columns=col_map, inplace=True)

    df['Data Lancamento'] = pd.to_datetime(df.get('Data Lancamento', df.get('Data Lançamento')), errors='coerce')
    df['Data Pesquisa']   = pd.to_datetime(df.get('Data Pesquisa'), errors='coerce')
    df['ano'] = df['Data Lancamento'].dt.year

    # Ticket médio por unidade = VGV / Unidades
    df['ticket'] = np.where(df['Unidades'] > 0, df[VGV] / df['Unidades'], np.nan)

    ultima     = df['Data Pesquisa'].max()
    ultima_str = ultima.strftime('%d/%m/%Y') if pd.notna(ultima) else '-'

    alto_g = df[df[CLASS] == 'Alto']

    kpis_global = build_kpis(df, alto_g)
    kpis_global['ultima_pesquisa'] = ultima_str
    series_global = build_series(df, alto_g)

    # Por Regiao
    regioes = {}
    for reg, grp in df.groupby('Região'):
        alto_r = grp[grp[CLASS] == 'Alto']
        regioes[str(reg)] = {
            'kpis':   build_kpis(grp, alto_r),
            'series': build_series(grp, alto_r),
        }

    # Por Incorporadora (top 40 por VGV alto — só KPIs, sem série)
    INC_COL = 'Incorporadora 1' if 'Incorporadora 1' in df.columns else None

    # Top incorporadoras (lista para dropdown)
    alto_rec = df[(df[CLASS]=='Alto') & (df['ano']>=2023)]
    top_incs = alto_rec.groupby('Incorporadora 1')[VGV].sum().sort_values(ascending=False).head(10)
    top_incorporadoras = [{'nome':str(k),'vgv_mm':safe(v/1e6)} for k,v in top_incs.items()]

    # Séries anuais por incorporadora (top 10 por VGV histórico alto padrão)
    top10_hist = alto_g.groupby(INC_COL)[VGV].sum().sort_values(ascending=False).head(10).index.tolist() if INC_COL else []
    top_incs_series = {}
    for inc in top10_hist:
        grp_i = df[df[INC_COL] == inc]
        top_incs_series[str(inc)] = [
            safe(grp_i[grp_i['ano']==a][VGV].sum() / 1e6) for a in ANOS_SERIE
        ]
    incorporadoras = {}
    if INC_COL:
        top40 = alto_g.groupby(INC_COL)[VGV].sum().sort_values(ascending=False).head(40).index.tolist()
        for inc, grp in df[df[INC_COL].isin(top40)].groupby(INC_COL):
            alto_i = grp[grp[CLASS] == 'Alto']
            incorporadoras[str(inc)] = {
                'kpis':   build_kpis(grp, alto_i),
                'series': build_series(grp, alto_i),
            }

    # Por Bairro (top 50 por VGV alto — KPIs + série anual)
    BAI_COL = next((c for c in df.columns if 'airro' in c), None)
    bairros = {}
    if BAI_COL:
        top50 = alto_g.groupby(BAI_COL)[VGV].sum().sort_values(ascending=False).head(50).index.tolist()
        for bairro, grp in df[df[BAI_COL].isin(top50)].groupby(BAI_COL):
            alto_b = grp[grp[CLASS] == 'Alto']
            bairros[str(bairro)] = {
                'kpis':   build_kpis(grp, alto_b),
                'series': build_series(grp, alto_b),
            }

    # ── Tickets: distribuição por faixa ─────────────────────────────────────
    tickets_dist = []
    for label, lo, hi in TICKET_FAIXAS:
        mask_m = (df['ticket'] >= lo)     & (df['ticket'] < hi)
        mask_a = (alto_g['ticket'] >= lo) & (alto_g['ticket'] < hi)
        tickets_dist.append({
            'label':         label,
            'count_mercado': int(df[mask_m]['Empreendimento'].nunique()),
            'count_alto':    int(alto_g[mask_a]['Empreendimento'].nunique()),
            'vgv_alto_mm':   safe(alto_g[mask_a][VGV].sum() / 1e6),
        })

    # ── Tickets: KPIs por faixa (para o filtro) ──────────────────────────────
    tickets_faixas = {}
    for label, lo, hi in TICKET_FAIXAS:
        mask = (df['ticket'] >= lo) & (df['ticket'] < hi)
        grp  = df[mask]
        if len(grp) == 0: continue
        alto_t = grp[grp[CLASS] == 'Alto']
        tickets_faixas[label] = {'kpis': build_kpis(grp, alto_t)}

    # ── Tickets: séries anuais por faixa (para gráficos) ─────────────────────
    ticket_series = {}
    for label, lo, hi in TICKET_FAIXAS:
        mask = (df['ticket'] >= lo) & (df['ticket'] < hi)
        grp  = df[mask]
        if len(grp) == 0: continue
        alto_t = grp[grp[CLASS] == 'Alto']
        ts = build_series(grp, alto_t)
        # Adicionar contagem de empreendimentos por ano
        ts['emps_faixa'] = [safe(grp[grp['ano']==a]['Empreendimento'].nunique()) for a in ANOS_SERIE]
        ts['unidades_faixa'] = [safe(int(grp[grp['ano']==a]['Unidades'].sum())) for a in ANOS_SERIE]
        ticket_series[label] = ts

    # ── Cruzamento Ticket × Região/Bairro/Incorporadora ─────────────────────────
    ticket_cross = {}
    for label, lo, hi in TICKET_FAIXAS:
        mask = (df['ticket'] >= lo) & (df['ticket'] < hi)
        grp  = df[mask]
        if len(grp) == 0: continue

        # IVV por região (VSO médio)
        regioes_ivv = {}
        for reg, rg in grp.groupby('Região'):
            regioes_ivv[str(reg)] = safe(rg[VSO].mean())

        # Preço por bairro (top 15)
        bairros_preco = {}
        if BAI_COL:
            top_b = grp.groupby(BAI_COL)[PRECO].mean().sort_values(ascending=False).head(15)
            for b, p in top_b.items():
                bairros_preco[str(b)] = safe(p)

        # Top incorporadoras por VGV
        incs_list = []
        if INC_COL:
            top_i = grp.groupby(INC_COL)[VGV].sum().sort_values(ascending=False).head(10)
            incs_list = [{'nome': str(k), 'vgv_mm': safe(v/1e6)} for k, v in top_i.items()]

        # Estoque por ano
        unid_por_ano = []
        for ano in ANOS_SERIE:
            ag = grp[grp['ano'] == ano]
            u  = safe(int(ag['Unidades'].sum())) if len(ag) > 0 else None
            v  = safe(ag[VSO].mean())            if len(ag) > 0 else None
            d  = safe(round(u * (1 - (v or 0) / 100))) if u else None
            unid_por_ano.append({'unidades': u, 'disponiveis': d})

        ticket_cross[label] = {
            'regioes_ivv':      regioes_ivv,
            'bairros_preco':    bairros_preco,
            'top_incorporadoras': incs_list,
            'unidades_por_ano': unid_por_ano,
        }

    # ── Tamanho (Área Privativa): vocação por região ────────────────────────────
    # Só considera linhas com área privativa válida (>0) — sem afetar as demais
    # agregações acima, que continuam usando o df completo.
    df_area = df[df[AREA].notna() & (df[AREA] > 0)] if AREA in df.columns else df.iloc[0:0]

    def _calc_tamanho_series(grp_area):
        """Série anual (unidades lançadas, empreendimentos, estoque) por faixa de
        tamanho, pra um recorte qualquer do df (SP inteiro ou uma região)."""
        out = {}
        for label, lo, hi in TAMANHO_FAIXAS:
            mask = (grp_area[AREA] >= lo) & (grp_area[AREA] < hi)
            grp = grp_area[mask]
            if len(grp) == 0: continue
            # Estoque por ano: unidades lançadas na faixa que ainda não venderam
            # (mesmo critério usado em ticket_cross: unidades * (1 - VSO médio))
            estoque_por_ano = []
            for a in ANOS_SERIE:
                ag = grp[grp['ano'] == a]
                u  = int(ag['Unidades'].sum()) if len(ag) else 0
                v  = safe(ag[VSO].mean()) if len(ag) else None
                d  = round(u * (1 - (v or 0) / 100)) if u else 0
                estoque_por_ano.append(safe(d))
            out[label] = {
                'unidades_faixa': [safe(int(grp[grp['ano']==a]['Unidades'].sum())) for a in ANOS_SERIE],
                'emps_faixa':     [safe(grp[grp['ano']==a]['Empreendimento'].nunique()) for a in ANOS_SERIE],
                'estoque_faixa':  estoque_por_ano,
            }
        return out

    tamanho_series = _calc_tamanho_series(df_area)

    # Mesma série, recortada por região — permite o filtro de região no painel
    # de Faixas de Tamanho sem precisar reprocessar no cliente.
    tamanho_series_regiao = {}
    for reg, rg in df_area.groupby('Região'):
        s = _calc_tamanho_series(rg)
        if s: tamanho_series_regiao[str(reg)] = s

    tamanho_dist = []
    for label, lo, hi in TAMANHO_FAIXAS:
        mask = (df_area[AREA] >= lo) & (df_area[AREA] < hi)
        grp = df_area[mask]
        tamanho_dist.append({
            'label':                label,
            'unidades':             safe(int(grp['Unidades'].sum())),
            'count_empreendimentos':safe(grp['Empreendimento'].nunique()),
            'preco_medio_m2':       safe(grp[PRECO].mean()) if len(grp) else None,
        })

    # Vocação por região: pra cada região, % de unidades lançadas em cada faixa
    # de tamanho — mostra o perfil de produto predominante de cada uma.
    tamanho_regiao = {}
    for reg, rg in df_area.groupby('Região'):
        total_unid = int(rg['Unidades'].sum())
        faixas_reg = {}
        for label, lo, hi in TAMANHO_FAIXAS:
            mask = (rg[AREA] >= lo) & (rg[AREA] < hi)
            fg = rg[mask]
            unid = int(fg['Unidades'].sum())
            faixas_reg[label] = {
                'unidades':       safe(unid),
                'pct':            safe(round(unid/total_unid*100, 1)) if total_unid else None,
                'preco_medio_m2': safe(fg[PRECO].mean()) if len(fg) else None,
            }
        tamanho_regiao[str(reg)] = {'total_unidades': safe(total_unid), 'faixas': faixas_reg}

    # ── Por Ano de Lançamento ────────────────────────────────────────────────────
    anos_data = {}
    for ano in ANOS_SERIE:
        grp = df[df['ano'] == ano]
        if len(grp) == 0: continue
        alto_a = grp[grp[CLASS] == 'Alto']
        anos_data[str(ano)] = {'kpis': build_kpis(grp, alto_a)}

    # ── Série Mensal de Lançamentos ─────────────────────────────────────────────
    meses_series = {}
    df['mes_ano'] = df['Data Lancamento'].dt.to_period('M')
    for periodo, grp in df.groupby('mes_ano'):
        key = str(periodo)
        if 'NaT' in key or 'nat' in key.lower(): continue
        alto_m = grp[grp[CLASS] == 'Alto']
        unid_lanc = int(grp['Unidades'].sum())
        unid_vend = int((grp['Unidades'] * grp[VSO] / 100).sum())
        meses_series[key] = {
            'emps_mercado':      safe(grp['Empreendimento'].nunique()),
            'emps_alto':         safe(alto_m['Empreendimento'].nunique()),
            'vgv_mercado_mm':    safe(grp[VGV].sum() / 1e6),
            'unidades_lancadas': safe(unid_lanc),
            'unidades_vendidas': safe(unid_vend),
        }
    meses_disponiveis = sorted(meses_series.keys())

    # ── Empreendimentos por mês (drill-down ao clicar no gráfico) ──────────────
    meses_emps = {}
    for periodo, grp_m in df.groupby('mes_ano'):
        key = str(periodo)
        if 'NaT' in key or 'nat' in key.lower(): continue
        emps_list = []
        for nome, eg in grp_m.groupby('Empreendimento'):
            # pegar a linha com pesquisa mais recente
            eg_s = eg.sort_values('Data Pesquisa', ascending=False) if 'Data Pesquisa' in eg.columns else eg
            row = eg_s.iloc[0]
            area_priv = row[AREA] if AREA in row else None
            emps_list.append({
                'nome':          str(nome),
                'incorporadora': str(row['Incorporadora 1']) if INC_COL and 'Incorporadora 1' in row else '',
                'bairro':        str(row[BAI_COL]) if BAI_COL and BAI_COL in row else '',
                'regiao':        str(row.get('Região', '')),
                'vgv_mm':        safe(row[VGV] / 1e6),
                'ticket':        safe(row['ticket']),
                'vso':           safe(row[VSO]),
                'unidades':      safe(int(row['Unidades'])) if pd.notna(row.get('Unidades')) else None,
                'area_privativa':safe(area_priv),
                'faixa_tamanho': faixa_tamanho_label(area_priv),
            })
        emps_list.sort(key=lambda x: x['vgv_mm'] or 0, reverse=True)
        if emps_list:
            meses_emps[key] = emps_list

    # ── Dados mensais por faixa de ticket (para filtro dinâmico) ───────────────
    meses_faixas = {}
    for periodo, grp_m in df.groupby('mes_ano'):
        key = str(periodo)
        if 'NaT' in key or 'nat' in key.lower(): continue
        fm = {}
        for label, lo, hi in TICKET_FAIXAS:
            mask = (grp_m['ticket'] >= lo) & (grp_m['ticket'] < hi)
            fg = grp_m[mask]
            if len(fg) == 0: continue
            fm[label] = {
                'vso':      safe(fg[VSO].mean()),
                'emps':     safe(int(fg['Empreendimento'].nunique())),
                'vgv_mm':   safe(fg[VGV].sum() / 1e6),
                'preco':    safe(fg[PRECO].mean()),
                'unidades': safe(int(fg['Unidades'].sum())),
            }
        if fm:
            meses_faixas[key] = fm

    # ── Dados mensais por região (para filtro dinâmico) ─────────────────────────
    meses_regioes = {}
    for periodo, grp_m in df.groupby('mes_ano'):
        key = str(periodo)
        if 'NaT' in key or 'nat' in key.lower(): continue
        rm = {}
        for reg, rg in grp_m.groupby('Região'):
            rm[str(reg)] = {
                'vso':      safe(rg[VSO].mean()),
                'emps':     safe(int(rg['Empreendimento'].nunique())),
                'preco':    safe(rg[PRECO].mean()),
                'vgv_mm':   safe(rg[VGV].sum() / 1e6),
                'unidades': safe(int(rg['Unidades'].sum())),
            }
        if rm:
            meses_regioes[key] = rm

    # ── Dados mensais por bairro (para filtro dinâmico) ─────────────────────────
    meses_bairros = {}
    if BAI_COL:
        for periodo, grp_m in df.groupby('mes_ano'):
            key = str(periodo)
            if 'NaT' in key or 'nat' in key.lower(): continue
            bm = {}
            for bairro, bg in grp_m.groupby(BAI_COL):
                bm[str(bairro)] = {
                    'preco':    safe(bg[PRECO].mean()),
                    'emps':     safe(int(bg['Empreendimento'].nunique())),
                    'vgv_mm':   safe(bg[VGV].sum() / 1e6),
                    'unidades': safe(int(bg['Unidades'].sum())),
                    'vso':      safe(bg[VSO].mean()),
                }
            if bm:
                meses_bairros[key] = bm

    # ── Dados mensais por incorporadora (top 10 históricas) ─────────────────────
    meses_incs = {}
    if INC_COL and top10_hist:
        top_incs_set = set(str(i) for i in top10_hist)
        for periodo, grp_m in df.groupby('mes_ano'):
            key = str(periodo)
            if 'NaT' in key or 'nat' in key.lower(): continue
            im = {}
            for inc, ig in grp_m.groupby(INC_COL):
                if str(inc) not in top_incs_set: continue
                im[str(inc)] = {
                    'vgv_mm':   safe(ig[VGV].sum() / 1e6),
                    'emps':     safe(int(ig['Empreendimento'].nunique())),
                    'vso':      safe(ig[VSO].mean()),
                    'unidades': safe(int(ig['Unidades'].sum())),
                }
            if im:
                meses_incs[key] = im

    result = {
        'ok': True,
        'kpis': kpis_global,
        'series': series_global,
        'regioes': regioes,
        'bairros': bairros,
        'incorporadoras': incorporadoras,
        'top_incorporadoras': top_incorporadoras,
        'tickets_dist':    tickets_dist,
        'tickets_faixas':  tickets_faixas,
        'ticket_series':   ticket_series,
        'ticket_cross':      ticket_cross,
        'tamanho_dist':      tamanho_dist,
        'tamanho_series':    tamanho_series,
        'tamanho_series_regiao': tamanho_series_regiao,
        'tamanho_regiao':    tamanho_regiao,
        'tamanho_disponiveis': [f[0] for f in TAMANHO_FAIXAS],
        'top_incs_series':   top_incs_series,
        'anos_data':       anos_data,
        'meses_series':    meses_series,
        'meses_emps':      meses_emps,
        'meses_faixas':    meses_faixas,
        'meses_regioes':   meses_regioes,
        'meses_bairros':   meses_bairros,
        'meses_incs':      meses_incs,
        'regioes_disponiveis':        sorted(df['Região'].dropna().unique().tolist()),
        'bairros_disponiveis':        sorted(bairros.keys()),
        'incorporadoras_disponiveis': sorted(incorporadoras.keys()),
        'tickets_disponiveis':        [f[0] for f in TICKET_FAIXAS],
        'anos_disponiveis':           [str(a) for a in ANOS_SERIE if str(a) in anos_data],
        'meses_disponiveis':          meses_disponiveis,
    }
    print(json.dumps(result, ensure_ascii=False))

except Exception as e:
    import traceback
    print(json.dumps({'ok':False,'error':str(e),'trace':traceback.format_exc()}))
