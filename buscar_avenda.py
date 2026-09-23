#!/usr/bin/env python3
"""
Busca anúncios imobiliários usando requests com sessão (cookies automáticos).
Tenta QuintoAndar API, VR scrape, ZAP scrape em ordem.
Uso: python buscar_avenda.py <lat_min> <lng_min> <lat_max> <lng_max>
Saída: JSON para stdout
"""
import sys, json, time, re
import requests
from urllib.parse import urlencode

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

def _session():
    s = requests.Session()
    s.headers.update({
        'User-Agent': UA,
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'DNT': '1',
    })
    return s

def _parse_preco(v):
    try:
        return 'R$ ' + f'{int(float(str(v))):,}'.replace(',','.')
    except:
        return str(v)

# ── QuintoAndar ────────────────────────────────────────────────────────────────
def buscar_qa(lat_min, lng_min, lat_max, lng_max):
    s = _session()
    base_hdrs = {
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://www.quintoandar.com.br',
        'Referer': 'https://www.quintoandar.com.br/comprar/imovel/sao-paulo-sp-brasil',
        'x-quintoandar-env': 'production',
        'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin',
    }

    # Aquece sessão na homepage
    try:
        s.get('https://www.quintoandar.com.br/', timeout=8,
              headers={'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8'})
    except: pass

    # Tenta API POST
    try:
        r = s.post('https://www.quintoandar.com.br/api/buying-search/v2/properties',
                   json={
                       'filters': {
                           'mapBounds': {'north': lat_max, 'south': lat_min,
                                        'east': lng_max, 'west': lng_min},
                       },
                       'pagination': {'currentPage': 0, 'pageSize': 60},
                       'sort': 'RELEVANCE'
                   },
                   headers=base_hdrs, timeout=15)
        print(f'[qa-api] status={r.status_code} len={len(r.text)} preview={r.text[:200]}', file=sys.stderr)
        if r.ok:
            d = r.json()
            items = d.get('items') or d.get('properties') or d.get('listings') or []
            if items:
                return _parse_qa_items(items, 'quintoandar_api')
    except Exception as e:
        print(f'[qa-api] err: {e}', file=sys.stderr)

    # Tenta scrape da página HTML
    try:
        url = (f'https://www.quintoandar.com.br/comprar/imovel/sao-paulo-sp-brasil'
               f'?north={lat_max}&south={lat_min}&east={lng_max}&west={lng_min}')
        r = s.get(url, timeout=15,
                  headers={'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
                           'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate',
                           'sec-fetch-site': 'same-origin', 'upgrade-insecure-requests': '1'})
        print(f'[qa-scrape] status={r.status_code} len={len(r.text)}', file=sys.stderr)
        if r.ok:
            # __NEXT_DATA__
            m = re.search(r'<script[^>]+id="__NEXT_DATA__"[^>]*>(.*?)</script>', r.text, re.S)
            if m:
                nd = json.loads(m.group(1))
                pp = nd.get('props', {}).get('pageProps', {})
                items = (pp.get('initialProps', {}).get('properties')
                         or pp.get('initialState', {}).get('search', {}).get('items')
                         or pp.get('properties')
                         or pp.get('listings') or [])
                print(f'[qa-scrape] __NEXT_DATA__ items={len(items)}', file=sys.stderr)
                if items:
                    return _parse_qa_items(items, 'quintoandar_scrape')
    except Exception as e:
        print(f'[qa-scrape] err: {e}', file=sys.stderr)

    return []

def _parse_qa_items(items, fonte):
    markers = []
    for item in items:
        addr = item.get('address') or {}
        lat = item.get('lat') or item.get('latitude') or addr.get('lat')
        lng = item.get('lng') or item.get('longitude') or addr.get('lng')
        if not lat or not lng: continue
        preco_raw = item.get('totalCost') or item.get('price') or item.get('salePrice') or item.get('sellPrice')
        area = item.get('area') or item.get('usableArea') or item.get('totalArea')
        bairro = (addr.get('neighborhood') or item.get('neighborhood') or item.get('region') or '')
        rua = addr.get('street') or item.get('street') or ''
        numero = (addr.get('streetNumber') or addr.get('number') or addr.get('houseNumber')
                  or item.get('streetNumber') or item.get('number') or item.get('houseNumber') or '')
        # Só entra no mapa se tiver rua E número — endereço aproximado (só bairro)
        # não é confiável o bastante pra identificar o imóvel num lote específico.
        if not rua or not numero: continue
        endereco = f'{rua}, {numero}'
        foto = (item.get('coverImage') or item.get('image')
                or (item.get('images') or [None])[0]
                or ((item.get('photos') or [{}])[0] or {}).get('url') or '')
        iid = item.get('id') or item.get('listing_id') or ''
        url = f'https://www.quintoandar.com.br/imovel/{iid}' if iid else 'https://www.quintoandar.com.br/comprar/imovel/sao-paulo-sp-brasil'
        markers.append({
            'lat': float(lat), 'lng': float(lng),
            'titulo': endereco[:60],
            'endereco': endereco,
            'preco': _parse_preco(preco_raw) if preco_raw else None,
            'area': f'{area} m²' if area else None,
            'bairro': bairro,
            'foto': foto or None,
            'quartos': item.get('bedrooms') or item.get('rooms'),
            'vagas': item.get('parkingSpaces') or item.get('garages'),
            'url': url,
            'plataforma': 'quintoandar',
            'plat_nome': 'QuintoAndar',
            'plat_cor': '#e8175d',
            'fonte': fonte,
        })
    return markers

# ── VivaReal scrape (backup) ───────────────────────────────────────────────────
def buscar_vr(lat_min, lng_min, lat_max, lng_max):
    s = _session()
    viewport = f'{lat_min},{lng_min},{lat_max},{lng_max}'
    url = f'https://www.vivareal.com.br/venda/sp/sao-paulo/?__vt=vb&viewport={viewport}&business=SALE&listingType=USED,DEVELOPMENT'
    try:
        r = s.get(url, timeout=15,
                  headers={'Accept': 'text/html,*/*;q=0.8',
                           'Referer': 'https://www.google.com.br/',
                           'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate',
                           'sec-fetch-site': 'cross-site'})
        print(f'[vr-scrape] status={r.status_code} len={len(r.text)}', file=sys.stderr)
        if not r.ok: return []
        m = re.search(r'<script[^>]+id="__NEXT_DATA__"[^>]*>(.*?)</script>', r.text, re.S)
        if not m: return []
        nd = json.loads(m.group(1))
        pp = nd.get('props', {}).get('pageProps', {})
        listings = (pp.get('initialState', {}).get('listings', {}).get('listings')
                    or pp.get('search', {}).get('result', {}).get('listings')
                    or pp.get('listings', {}).get('listings') or [])
        print(f'[vr-scrape] listings={len(listings)}', file=sys.stderr)
        return _parse_vr_listings(listings, 'vivareal_py')
    except Exception as e:
        print(f'[vr-scrape] err: {e}', file=sys.stderr)
        return []

def _parse_vr_listings(listings, fonte):
    markers = []
    for item in listings:
        l = item.get('listing', {})
        addr = l.get('address', {})
        geo = addr.get('geoLocation', {})
        prec = geo.get('precision', {})
        coord = None
        for lvl in ['CENTER','ROOFTOP','RANGE_INTERPOLATED','APPROXIMATE']:
            pt = (prec.get(lvl) or {}).get('point', {})
            if pt.get('lat') and pt.get('lon'):
                coord = (pt['lat'], pt['lon']); break
        if not coord:
            if geo.get('lat') and geo.get('lon'): coord = (geo['lat'], geo['lon'])
            elif addr.get('point', {}).get('lat'): coord = (addr['point']['lat'], addr['point']['lon'])
        if not coord: continue
        pricing = next((p for p in (l.get('pricingInfos') or []) if p.get('businessType')=='SALE'), {})
        preco_raw = pricing.get('price')
        areas = l.get('usableAreas') or l.get('totalAreas') or []
        slug = l.get('slug') or l.get('externalId') or l.get('id') or ''
        foto = ((item.get('medias') or [{}])[0] or {}).get('url') or ''
        markers.append({
            'lat': float(coord[0]), 'lng': float(coord[1]),
            'titulo': (addr.get('street') or addr.get('neighborhood') or 'Imóvel')[:60],
            'preco': _parse_preco(preco_raw) if preco_raw else None,
            'area': f'{areas[0]} m²' if areas else None,
            'bairro': addr.get('neighborhood') or '',
            'foto': foto or None,
            'quartos': (l.get('bedrooms') or [None])[0],
            'url': f'https://www.vivareal.com.br/imovel/{slug}/' if slug else 'https://www.vivareal.com.br',
            'plataforma': 'vivareal',
            'plat_nome': 'VivaReal',
            'plat_cor': '#00a884',
            'fonte': fonte,
        })
    return markers

# ── Main ───────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    if len(sys.argv) < 5:
        print(json.dumps({'ok': False, 'error': 'uso: buscar_avenda.py lat_min lng_min lat_max lng_max'}))
        sys.exit(1)

    lat_min, lng_min, lat_max, lng_max = [float(x) for x in sys.argv[1:5]]
    
    markers = buscar_qa(lat_min, lng_min, lat_max, lng_max)
    fonte = 'quintoandar'
    
    if not markers:
        markers = buscar_vr(lat_min, lng_min, lat_max, lng_max)
        fonte = 'vivareal_py'

    print(json.dumps({'ok': True, 'markers': markers, 'fonte': fonte, 'total': len(markers)},
                     ensure_ascii=False))
