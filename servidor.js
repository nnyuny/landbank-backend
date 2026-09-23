const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// Pasta-base da biblioteca do OneDrive "YUNYGROUP - Novos Negócios", montada
// dentro da pasta de usuário do Windows de QUEM ESTIVER RODANDO o servidor
// (os.homedir() — funciona pra qualquer colega que tenha essa biblioteca
// sincronizada, não só a Kamila). Antes disso era um caminho fixo só do
// usuário "ksantos", que só funcionava no computador dela.
const PASTA_YUNY_BASE = path.join(os.homedir(), 'Yuny Incorporadora Holding S.A', 'YUNYGROUP - Novos Negócios', 'BANCO DE DADOS DE TERRENOS');

// Pasta modelo com a estrutura padrão de subpastas (+ arquivos de referência,
// ex: modelos de proposta, planilha de briefing, viabilidade padrão) que deve
// ser copiada pra dentro de toda pasta de terreno NOVA criada na rede — fica
// junto do próprio app (__dirname), não na pasta de rede, pra sempre viajar
// junto com qualquer cópia do app instalada em outro computador.
const PASTA_MODELO = path.join(__dirname, 'PASTA MODELO');

// Copia recursivamente a PASTA_MODELO (todas as subpastas e arquivos) pra
// dentro da pasta recém-criada de um terreno. Só é chamada quando a pasta é
// criada do ZERO (nunca roda em cima de uma pasta que já existia, pra nunca
// sobrescrever nada). Cópia manual (readdir/mkdir/copyFile) em vez de
// fs.cpSync, pra funcionar em qualquer versão do Node instalada nos
// computadores da equipe (fs.cpSync só existe a partir do Node 16.7).
function _copiarPastaModelo(destino) {
  if (!fs.existsSync(PASTA_MODELO)) {
    console.warn('[pastaModelo] "PASTA MODELO" não encontrada em', PASTA_MODELO, '— pasta do terreno criada vazia.');
    return;
  }
  const copiarRecursivo = (origem, alvo) => {
    fs.mkdirSync(alvo, { recursive: true });
    for (const item of fs.readdirSync(origem, { withFileTypes: true })) {
      const origemItem = path.join(origem, item.name);
      const alvoItem = path.join(alvo, item.name);
      if (item.isDirectory()) copiarRecursivo(origemItem, alvoItem);
      else fs.copyFileSync(origemItem, alvoItem);
    }
  };
  try {
    copiarRecursivo(PASTA_MODELO, destino);
    console.log('[pastaModelo] estrutura padrão copiada pra', destino);
  } catch (e) {
    console.warn('[pastaModelo] erro ao copiar estrutura padrão:', e.message);
  }
}

// Tabela completa de PGV por Setor+Quadra+Codlog (Quadro 14 — 2026), extraída
// do PDF oficial preservando cada rua individualmente (ao contrário do
// pgv_data.js do front, que já vem colapsado no maior valor por quadra).
// Carregada sob demanda (só na primeira chamada do endpoint /api/pgv-codlogs)
// e guardada em memória — o arquivo tem ~45 mil quadras, então não vale a
// pena reler do disco a cada requisição.
let _pgvPorCodlogCache = null;
function _carregarPgvPorCodlog() {
  if (_pgvPorCodlogCache) return _pgvPorCodlogCache;
  const arq = path.join(__dirname, 'pgv_por_codlog_2026.json');
  _pgvPorCodlogCache = fs.existsSync(arq) ? JSON.parse(fs.readFileSync(arq, 'utf-8')) : {};
  return _pgvPorCodlogCache;
}

// Toda vez que o servidor inicia, confere se existe uma versão mais nova do
// index.html na pasta de rede (App_Local_Para_Instalar — a mesma "cópia
// mestre" que a Kamila mantém sincronizada) e, se houver diferença, copia
// por cima da cópia local ANTES de subir o app. Assim cada colega sempre
// abre a versão mais recente do sistema, sem precisar copiar arquivo na mão
// toda vez que alguma coisa for atualizada.
// Silencioso e seguro: se a pasta de rede não existir (offline, VPN caída,
// ou rodando na nuvem onde essa pasta nem faz sentido), simplesmente segue
// com a cópia local de sempre — nunca impede o servidor de iniciar.
function _autoAtualizarIndexHtml() {
  try {
    const origemRede = path.join(PASTA_YUNY_BASE, 'TERRENOS', 'App_Local_Para_Instalar', 'index.html');
    const destinoLocal = path.join(__dirname, 'index.html');
    if (!fs.existsSync(origemRede)) return;
    const conteudoRede = fs.readFileSync(origemRede);
    const conteudoLocal = fs.existsSync(destinoLocal) ? fs.readFileSync(destinoLocal) : null;
    if (conteudoLocal && Buffer.compare(conteudoRede, conteudoLocal) === 0) {
      console.log('[auto-update] index.html já está na versão mais recente.');
      return;
    }
    fs.writeFileSync(destinoLocal, conteudoRede);
    console.log('[auto-update] index.html atualizado a partir da pasta de rede — abrindo versão mais recente.');
  } catch (e) {
    console.warn('[auto-update] Não foi possível checar atualização (seguindo com a cópia local):', e.message);
  }
}
_autoAtualizarIndexHtml();

// Mesma ideia, agora pro próprio servidor.js. Diferença importante: como
// este processo já está rodando com o código ANTIGO carregado em memória,
// não dá pra "trocar de roupa andando" — trocar o arquivo no disco não muda
// o que já está executando. Então aqui a gente só deixa o arquivo novo
// pronto no disco (valendo assim que o app for reaberto) e liga um aviso
// (_servidorAtualizadoPendente) que o próprio app mostra na tela via
// /api/versao — necessário porque a janela do servidor normalmente fica
// escondida quando a inicialização automática está ativada, então um
// console.log sozinho não seria visto por ninguém.
let _servidorAtualizadoPendente = false;
function _autoAtualizarServidorJs() {
  try {
    const origemRede = path.join(PASTA_YUNY_BASE, 'TERRENOS', 'App_Local_Para_Instalar', 'servidor.js');
    const destinoLocal = path.join(__dirname, 'servidor.js');
    if (!fs.existsSync(origemRede)) return;
    const conteudoRede = fs.readFileSync(origemRede);
    const conteudoLocal = fs.existsSync(destinoLocal) ? fs.readFileSync(destinoLocal) : null;
    if (conteudoLocal && Buffer.compare(conteudoRede, conteudoLocal) === 0) return;
    fs.writeFileSync(destinoLocal, conteudoRede);
    _servidorAtualizadoPendente = true;
    console.log('[auto-update] servidor.js atualizado no disco — feche e abra o app de novo pra aplicar.');
  } catch (e) {
    console.warn('[auto-update] Não foi possível checar atualização do servidor.js:', e.message);
  }
}
_autoAtualizarServidorJs();

// PORT vem de variável de ambiente quando hospedado na nuvem (Render/Railway
// definem process.env.PORT automaticamente); localmente cai no 8080 de sempre.
const PORT = process.env.PORT || 8080;
const DIR = __dirname;
const CALC_SCRIPT = path.join(DIR, 'calcular_viab.py');
// Comando Python correto por plataforma — Windows usa o launcher 'py',
// Linux (host cloud) usa 'python3'. Usado nos endpoints do ITBI/À Venda que
// antes chamavam 'python' fixo (que não existe em muitas imagens Linux).
const PY_CMD = process.platform === 'win32' ? 'py' : 'python3';

// Store para certidões CDC capturadas do portal Prefeitura SP (in-memory, reseta ao reiniciar)
const _cdcStore = {};
// Cache de resultados À Venda (5 min por área)
const _avendaCache = {};
// Cache da Pesquisa de Mercado (reusa enquanto o Excel não mudar)
let _pesquisaCache = null; // { data: string, mtime: number }
const PESQUISA_EXCEL = path.join(DIR, 'Pesquisa de mercado', 'Pesquisa de Mercado 2016-2026.xlsx');

// ── Geocodificação PERSISTENTE dos lançamentos da Pesquisa de Mercado ─────────
// Objetivo: em vez de geocodificar ao vivo (Nominatim, ~1 req/s) toda vez que
// alguém abre a camada "Lançamentos (base Mercado)" no mapa, guarda o
// resultado pra sempre num arquivo local (geocode_mercado_cache.json) — assim
// só se paga o custo de geocodificar cada endereço UMA VEZ, e depois disso
// todo mundo que abrir o app (em qualquer computador que sincronize esse
// arquivo) já vê os pins prontos, sem esperar nada.
const GEOCODE_MERC_CACHE_PATH  = path.join(DIR, 'geocode_mercado_cache.json');
const GEOCODE_MERC_STATUS_PATH = path.join(DIR, 'geocode_mercado_status.json');
let _geocodeMercRunning = false;

function _lerGeocodeMercCache() {
  try { return JSON.parse(fs.readFileSync(GEOCODE_MERC_CACHE_PATH, 'utf8')); }
  catch (e) { return {}; }
}
function _salvarGeocodeMercCache(cache) {
  try { fs.writeFileSync(GEOCODE_MERC_CACHE_PATH, JSON.stringify(cache)); } catch (e) {}
}
function _salvarGeocodeMercStatus(status) {
  try { fs.writeFileSync(GEOCODE_MERC_STATUS_PATH, JSON.stringify(status)); } catch (e) {}
}

// Uma chamada ao Nominatim (mesmo proxy/User-Agent do /api/geocode).
function _geocodeMercUm(q) {
  return new Promise(resolve => {
    const url = 'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(q) + '&format=json&limit=1&accept-language=pt-BR';
    https.get(url, { headers: { 'User-Agent': 'YUNY-LandBank/1.0' } }, (r) => {
      let data = '';
      r.on('data', d => data += d);
      r.on('end', () => {
        try {
          const arr = JSON.parse(data);
          if (arr && arr.length) resolve({ lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon) });
          else resolve(null);
        } catch (e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// Geocodifica um lançamento (nome+bairro, com fallback só bairro), respeitando
// o limite de ~1 requisição/segundo do Nominatim entre tentativas.
async function _geocodeMercItem(nome, bairro) {
  const tentativas = [];
  if (nome && bairro) tentativas.push(nome + ', ' + bairro + ', São Paulo, Brazil');
  if (bairro) tentativas.push(bairro + ', São Paulo, SP, Brazil');
  for (const q of tentativas) {
    const r = await _geocodeMercUm(q);
    if (r) return r;
    await new Promise(res => setTimeout(res, 1100));
  }
  return null;
}

// Roda em background: geocodifica todo mundo que ainda não está no cache.
// `itens` é [{key, nome, bairro}, ...] — key = "nome|bairro" (mesma convenção
// do cache usado no frontend). Salva o cache a cada 10 itens processados (pra
// não perder progresso se o servidor cair no meio) e mantém o status
// atualizado pra o frontend fazer polling.
async function _rodarGeocodeBatchMercado(itens) {
  if (_geocodeMercRunning) return;
  _geocodeMercRunning = true;
  try {
    const cache = _lerGeocodeMercCache();
    const pendentes = itens.filter(it => cache[it.key] === undefined);
    const total = itens.length;
    let done = total - pendentes.length;
    _salvarGeocodeMercStatus({ processing: true, total, done, faltam: pendentes.length, started_at: new Date().toISOString() });
    for (const it of pendentes) {
      const geo = await _geocodeMercItem(it.nome, it.bairro);
      cache[it.key] = geo ? [geo.lat, geo.lng] : null;
      done++;
      if (done % 10 === 0 || done === total) {
        _salvarGeocodeMercCache(cache);
        _salvarGeocodeMercStatus({ processing: true, total, done, faltam: total - done, atualizado_em: new Date().toISOString() });
      }
      await new Promise(res => setTimeout(res, 1100)); // ~1 req/s (etiqueta de uso do Nominatim)
    }
    _salvarGeocodeMercCache(cache);
    _salvarGeocodeMercStatus({ processing: false, total, done, faltam: 0, finished_at: new Date().toISOString() });
  } catch (e) {
    _salvarGeocodeMercStatus({ processing: false, error: e.message, finished_at: new Date().toISOString() });
  } finally {
    _geocodeMercRunning = false;
  }
}

// Roda processar_pesquisa.py (ou reusa o cache já quente do /api/pesquisa-mercado)
// e devolve só a lista de itens únicos { key, nome, bairro } de meses_emps —
// entrada padrão tanto pro batch quanto pra eventuais outros usos futuros.
function _listarItensParaGeocode(cb) {
  let excelMtime = 0, scriptMtime = 0;
  try { excelMtime = fs.statSync(PESQUISA_EXCEL).mtimeMs; } catch (e) {}
  try { scriptMtime = fs.statSync(path.join(DIR, 'processar_pesquisa.py')).mtimeMs; } catch (e) {}
  const cacheKey = excelMtime + '|' + scriptMtime;

  const extrair = (dados) => {
    const me = dados.meses_emps || {};
    const vistos = new Set();
    const itens = [];
    Object.values(me).forEach(arr => {
      (arr || []).forEach(it => {
        const nome = (it.nome || '').trim();
        const bairro = (it.bairro || '').trim();
        const key = nome + '|' + bairro;
        if (vistos.has(key)) return;
        vistos.add(key);
        itens.push({ key, nome, bairro });
      });
    });
    return itens;
  };

  if (_pesquisaCache && _pesquisaCache.mtime === cacheKey && _pesquisaCache.data) {
    try { return cb(null, extrair(JSON.parse(_pesquisaCache.data))); }
    catch (e) { return cb(e); }
  }

  const script = path.join(DIR, 'processar_pesquisa.py');
  let out = '', err2 = '';
  const py = spawn(PY_CMD, [script], { windowsHide: true });
  py.stdout.on('data', d => out += d);
  py.stderr.on('data', d => err2 += d);
  py.on('close', code => {
    if (code !== 0 || !out.trim()) return cb(new Error(err2.slice(0, 500) || ('Script falhou (código ' + code + ')')));
    try {
      _pesquisaCache = { data: out.trim(), mtime: cacheKey };
      cb(null, extrair(JSON.parse(out.trim())));
    } catch (e) { cb(e); }
  });
  py.on('error', e => cb(e));
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pdf':  'application/pdf',
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Monta o nome de pasta de um terreno no formato já usado manualmente pela
// equipe em BANCO DE DADOS DE TERRENOS/<ano>/ (ex: "Joaquim Floriano, 295_mar.26",
// "Hassib Mofarrej, 602_jul.26"): remove o prefixo de logradouro (Rua/Av./
// Alameda/etc.), troca "nº"/"n°" pelo número com vírgula, e adiciona o mês
// (3 letras, pt-BR) + ano com 2 dígitos, ambos da DATA DE HOJE (data do
// cadastro, não do endereço).
function _nomePastaTerreno(endereco) {
  const MESES = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
  let s = (endereco || '').trim();
  s = s.replace(/^(rua|avenida|av\.?|alameda|al\.?|pra[çc]a|p[çc]a\.?|estrada|rodovia|travessa|trav\.?|largo)\s+/i, '');
  s = s.replace(/\s+n[º°ᵒ]?\.?\s+/i, ', ');
  s = s.replace(/\s*,\s*/g, ', ').trim().replace(/,\s*$/, '');
  const hoje = new Date();
  const mes = MESES[hoje.getMonth()];
  const ano2 = String(hoje.getFullYear()).slice(-2);
  return `${s}_${mes}.${ano2}`;
}

// Localiza a pasta de um terreno (por nome) em qualquer subpasta de ano
// dentro de PASTA_YUNY_BASE (a pasta foi criada num ano que pode não ser
// mais o ano corrente). Retorna o caminho completo se encontrar, ou null.
function _encontrarPastaTerreno(nomePasta) {
  if (!nomePasta || !fs.existsSync(PASTA_YUNY_BASE)) return null;
  let anos;
  try {
    anos = fs.readdirSync(PASTA_YUNY_BASE, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^\d{4}$/.test(d.name))
      .map(d => d.name)
      .sort().reverse(); // ano mais recente primeiro
  } catch (e) { return null; }
  for (const ano of anos) {
    const p = path.join(PASTA_YUNY_BASE, ano, nomePasta);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Localiza a pasta do terreno (por nome, em qualquer ano) ou cria uma nova no
// ano corrente — mesma lógica usada por /api/criar-pasta-terreno. Reaproveitada
// por qualquer endpoint que precise gravar um arquivo na pasta do terreno.
function _resolverOuCriarPastaTerreno(endereco, pastaRede) {
  let nomePasta = (pastaRede || '').toString().trim();
  if (!nomePasta) {
    if (!endereco) throw new Error('endereco ou pastaRede obrigatório');
    nomePasta = _nomePastaTerreno(endereco);
  }
  let pastaPath = _encontrarPastaTerreno(nomePasta);
  if (!pastaPath) {
    const anoDir = path.join(PASTA_YUNY_BASE, String(new Date().getFullYear()));
    if (!fs.existsSync(anoDir)) throw new Error('Pasta de rede não encontrada (rede/OneDrive offline?)');
    pastaPath = path.join(anoDir, nomePasta);
    fs.mkdirSync(pastaPath, { recursive: true });
    _copiarPastaModelo(pastaPath);
  }
  return { nomePasta, pastaPath };
}

// Salva um arquivo na pasta do terreno na rede — texto (HTML/txt, campo
// 'conteudo') ou binário (imagem/PDF em base64, campo 'base64'). Usado pela
// Ficha de Aquisição enriquecida, pelas revisões do Estudo de Massa, e pelos
// prints do Histórico de Recebimento. Tenta achar a pasta já criada (por
// nome, em qualquer ano); se não achar, cria uma nova no ano corrente (mesmo
// comportamento do /api/criar-pasta-terreno).
function handleSalvarArquivoTerreno(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const endereco    = (body.endereco || '').toString().trim();
      const conteudo    = body.conteudo != null ? String(body.conteudo) : '';
      const base64      = body.base64 != null ? String(body.base64).replace(/^data:.*;base64,/, '') : '';
      const nomeArquivo = (body.nomeArquivo || ('Documento_' + Date.now() + (base64 ? '.jpg' : '.html'))).toString();
      const subpasta    = (body.subpasta || '').toString().trim();
      if (!conteudo && !base64) throw new Error('Conteúdo vazio');

      let { nomePasta, pastaPath } = _resolverOuCriarPastaTerreno(endereco, body.pastaRede);
      if (subpasta) {
        // Subpasta padrão (ex.: "E-mail do Terreno") já vem da PASTA MODELO
        // copiada na criação — o mkdir aqui é só uma rede de segurança pra
        // pastas antigas/vinculadas manualmente que não tenham a estrutura.
        pastaPath = path.join(pastaPath, subpasta.replace(/[<>:"|?*]/g, '_'));
        fs.mkdirSync(pastaPath, { recursive: true });
      }

      const nomeArqSafe = nomeArquivo.replace(/[<>:"/\\|?*]/g, '_').trim().slice(0, 150);
      const filePath = path.join(pastaPath, nomeArqSafe);
      if (base64) fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
      else fs.writeFileSync(filePath, conteudo, 'utf8');

      console.log(`[salvar-arquivo-terreno] Salvo: ${filePath}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pasta: nomePasta, path: filePath }));
    } catch (err) {
      console.error('[salvar-arquivo-terreno] Erro:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });
}

// Procura um Chrome/Edge já instalado no Windows do usuário, pra usar como
// navegador do puppeteer quando o Chromium que o puppeteer baixa sozinho não
// estiver disponível (ex.: "Could not find Chrome" — baixo desse erro em
// máquinas onde o "npm install" não conseguiu baixar o Chromium, por
// política de rede/antivírus/proxy da empresa). O Edge vem de fábrica em
// todo Windows 10/11, então serve de rede de segurança mesmo sem Chrome.
function _encontrarChromeInstalado() {
  const candidatos = [
    process.env['PROGRAMFILES'] && path.join(process.env['PROGRAMFILES'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env['PROGRAMFILES'] && path.join(process.env['PROGRAMFILES'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  for (const c of candidatos) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return null;
}

// Gera um PDF de verdade a partir de um HTML (usando o puppeteer, já
// instalado no projeto pro whatsapp-bot.js) e salva na pasta do terreno na
// rede. Usado pelo "Salvar PDF na pasta" do Estudo de Massa (manual e
// automático ao salvar uma revisão) — mesmo layout que sai no botão
// "Gerar PDF" da tela, só que virando arquivo de verdade em vez de precisar
// imprimir manualmente pelo navegador.
async function handleSalvarPdfTerreno(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    let browser;
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const endereco    = (body.endereco || '').toString().trim();
      const html        = body.html != null ? String(body.html) : '';
      let   nomeArquivo = (body.nomeArquivo || ('Documento_' + Date.now() + '.pdf')).toString();
      const subpasta    = (body.subpasta || '').toString().trim();
      if (!html) throw new Error('HTML vazio');
      if (!/\.pdf$/i.test(nomeArquivo)) nomeArquivo += '.pdf';

      let { nomePasta, pastaPath } = _resolverOuCriarPastaTerreno(endereco, body.pastaRede);
      if (subpasta) {
        pastaPath = path.join(pastaPath, subpasta.replace(/[<>:"|?*]/g, '_'));
        fs.mkdirSync(pastaPath, { recursive: true });
      }

      let puppeteer;
      try { puppeteer = require('puppeteer'); }
      catch (e) { throw new Error('puppeteer não está instalado neste computador — rode "npm install" na pasta do app.'); }

      try {
        browser = await puppeteer.launch({ headless: true });
      } catch (eLaunch) {
        // O Chromium que o puppeteer tenta baixar sozinho não está disponível
        // nesta máquina (erro comum: "Could not find Chrome"). Tenta de novo
        // usando um Chrome/Edge já instalado no Windows antes de desistir.
        const chromePath = _encontrarChromeInstalado();
        if (!chromePath) {
          throw new Error(
            'Não encontrou o navegador do puppeteer nem um Chrome/Edge instalado. ' +
            'Rode "npx puppeteer browsers install chrome" na pasta do app, ou instale o Google Chrome.'
          );
        }
        browser = await puppeteer.launch({ headless: true, executablePath: chromePath });
      }
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const pdfBuffer = await page.pdf({
        format: 'A4', printBackground: true,
        margin: { top: '15mm', bottom: '15mm', left: '12mm', right: '12mm' },
      });
      await browser.close();
      browser = null;

      const nomeArqSafe = nomeArquivo.replace(/[<>:"/\\|?*]/g, '_').trim().slice(0, 150);
      const filePath = path.join(pastaPath, nomeArqSafe);
      fs.writeFileSync(filePath, pdfBuffer);

      console.log(`[salvar-pdf-terreno] Salvo: ${filePath}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pasta: nomePasta, path: filePath }));
    } catch (err) {
      console.error('[salvar-pdf-terreno] Erro:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    } finally {
      if (browser) { try { await browser.close(); } catch (e) {} }
    }
  });
}

// Config de e-mail (mesmo arquivo/chaves usados por verificar_lembretes.js e
// ler_respostas_email.js: host/port de IMAP pra leitura, smtp_host/smtp_port
// pra envio — user/pass são a mesma conta pros dois). Carregado sob demanda
// (só quando alguém realmente manda um e-mail pela Prospecção) e cacheado.
let _emailConfigCache = null;
function _carregarEmailConfig() {
  if (_emailConfigCache) return _emailConfigCache;
  const arq = path.join(__dirname, 'email_config.json');
  if (!fs.existsSync(arq)) throw new Error('email_config.json não encontrado — copie email_config.example.json e preencha as credenciais.');
  _emailConfigCache = JSON.parse(fs.readFileSync(arq, 'utf-8'));
  return _emailConfigCache;
}
function _criarTransporterEmail() {
  const config = _carregarEmailConfig();
  const nodemailer = require('nodemailer');
  return nodemailer.createTransport({
    host: config.smtp_host || 'smtp.gmail.com',
    port: config.smtp_port || 465,
    secure: (config.smtp_port || 465) === 465,
    auth: { user: config.user, pass: config.pass },
  });
}

// Envia o e-mail de "Prospecção Ativa" pro corretor, com o print da quadra
// selecionada embutido no corpo (via cid, não como link externo — assim
// aparece direto na maioria dos clientes de e-mail sem precisar baixar
// anexo). Usado pelo botão "📧 E-mail corretor" da aba Prospecção.
function handleEnviarEmailProspeccao(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const to          = (body.to || '').toString().trim();
      const cc          = (body.cc || '').toString().trim();
      const assunto     = (body.assunto || 'Yuny – Prospecção Ativa').toString();
      const corpoTexto  = (body.corpoTexto || '').toString();
      const imagemB64   = (body.imagemBase64 || '').toString().replace(/^data:image\/\w+;base64,/, '');
      if (!to) throw new Error('E-mail do destinatário (to) é obrigatório');
      if (!imagemB64) throw new Error('Imagem do mapa (imagemBase64) é obrigatória');

      const corpoHtml = corpoTexto
        .split('\n')
        .map(l => l.trim() ? `<p style="margin:0 0 10px;">${l}</p>` : '<br>')
        .join('\n') + '<img src="cid:mapa-prospeccao" style="max-width:600px;width:100%;border:1px solid #ddd;border-radius:6px;margin-top:6px;" alt="Print da área">';

      const transporter = _criarTransporterEmail();
      const config = _carregarEmailConfig();
      await transporter.sendMail({
        from: `"LandBank YUNY" <${config.user}>`,
        to,
        cc: cc || undefined,
        subject: assunto,
        text: corpoTexto,
        html: corpoHtml,
        attachments: [{
          filename: 'print-area.png',
          content: Buffer.from(imagemB64, 'base64'),
          cid: 'mapa-prospeccao',
        }],
      });

      console.log(`[enviar-email-prospeccao] Enviado pra ${to}${cc ? ' (cc '+cc+')' : ''} — assunto: ${assunto}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error('[enviar-email-prospeccao] Erro:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });
}

function handleSalvarViab(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

  const terrenoNome = decodeURIComponent(req.headers['x-terreno-nome'] || 'Sem_Nome');
  const data = new Date();
  const dataStr = `${data.getFullYear()}-${String(data.getMonth()+1).padStart(2,'0')}-${String(data.getDate()).padStart(2,'0')}`;

  // Sanitizar nome da pasta
  const nomePasta = terrenoNome.replace(/[<>:"/\\|?*]/g, '_').trim().slice(0, 80);
  const nomeArq   = `Viabilidade_${nomePasta}_${dataStr}.xlsx`;
  const pasta     = path.join(DIR, 'Viabilidades', nomePasta);
  const filePath  = path.join(pasta, nomeArq);

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    fs.mkdirSync(pasta, { recursive: true });
    fs.writeFile(filePath, buf, err => {
      cors(res);
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        console.log(`[salvar-viab] Salvo: ${filePath}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: filePath, arquivo: nomeArq }));
      }
    });
  });
}

// Salva uma cópia de documento (PDF) na pasta de rede, dentro de uma subpasta
// com o nome do terreno (cria a subpasta se ainda não existir).
const PASTA_REDE_TERRENOS = path.join(PASTA_YUNY_BASE, 'TERRENOS');

function handleSalvarDocRede(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const terrenoNome = (body.terreno || 'Sem_Nome').toString();
      const nomeArquivo  = (body.nomeArquivo || ('Documento_' + Date.now() + '.pdf')).toString();
      const base64 = (body.base64 || '').replace(/^data:.*;base64,/, '');
      if (!base64) throw new Error('PDF vazio');
      if (!fs.existsSync(PASTA_REDE_TERRENOS)) throw new Error('Pasta de rede não encontrada (offline?)');

      const nomePasta = terrenoNome.replace(/[<>:"/\\|?*]/g, '_').trim().slice(0, 80) || 'Sem_Nome';
      const nomeArq   = nomeArquivo.replace(/[<>:"/\\|?*]/g, '_').trim().slice(0, 120);
      const pasta     = path.join(PASTA_REDE_TERRENOS, nomePasta);
      const filePath  = path.join(pasta, nomeArq);

      fs.mkdirSync(pasta, { recursive: true });
      fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));

      console.log(`[salvar-doc-rede] Salvo: ${filePath}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: filePath }));
    } catch (err) {
      console.error('[salvar-doc-rede] Erro:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });
}

function handleBaixarViab(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

  const terrenoNome = decodeURIComponent(req.headers['x-terreno-nome'] || 'Viabilidade');
  const safeName    = terrenoNome.replace(/[<>:"/\\|?*]/g, '_').trim().slice(0, 80);
  const data        = new Date();
  const dataStr     = `${data.getFullYear()}-${String(data.getMonth()+1).padStart(2,'0')}-${String(data.getDate()).padStart(2,'0')}`;
  const pasta       = path.join(DIR, 'Viabilidades', safeName);
  const outPath     = path.join(pasta, `Viabilidade_${safeName}_${dataStr}.xlsx`);

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    console.log('[/api/baixar-viab] Gerando xlsx via Excel...');
    const pyCmd = process.platform === 'win32' ? 'py' : 'python3';
    let py;
    try {
      py = spawn(pyCmd, [CALC_SCRIPT, '--save', outPath], {
        cwd: DIR,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        windowsHide: true
      });
    } catch(spawnErr) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Não foi possível iniciar Python: ' + spawnErr.message }));
      return;
    }

    let stdout = '', stderr = '';
    py.stdout.setEncoding('utf8');
    py.stderr.setEncoding('utf8');
    py.stdout.on('data', d => stdout += d);
    py.stderr.on('data', d => stderr += d);

    const killTimer = setTimeout(() => {
      try { py.kill(); } catch(e) {}
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Timeout ao gerar Excel' }));
      }
    }, 480000);

    py.on('close', code => {
      clearTimeout(killTimer);
      if (res.headersSent) return;
      let result = {};
      try { result = JSON.parse(stdout); } catch(e) {}
      if (result.error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      // Retornar o arquivo gerado como download
      fs.readFile(outPath, (err, buf) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Arquivo não encontrado após geração: ' + err.message }));
          return;
        }
        const fileName = encodeURIComponent(`Viabilidade_${safeName}_${dataStr}.xlsx`);
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename*=UTF-8''${fileName}`,
          'Content-Length': buf.length,
          'Access-Control-Allow-Origin': '*',
        });
        res.end(buf);
        console.log(`[baixar-viab] Enviado: ${outPath} (${buf.length} bytes)`);
      });
    });

    py.stdin.write(body);
    py.stdin.end();
  });
}

function handleCalcular(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405); res.end('Method not allowed'); return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    console.log('[/api/calcular] recebido, rodando Python...');
    // Tenta 'py' (Python Launcher Windows) depois 'python3'
    const pyCmd = process.platform === 'win32' ? 'py' : 'python3';
    let py;
    try {
      py = spawn(pyCmd, [CALC_SCRIPT], {
        cwd: DIR,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        windowsHide: true
      });
    } catch(spawnErr) {
      cors(res);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Não foi possível iniciar Python: ' + spawnErr.message }));
      return;
    }

    let stdout = '';
    let stderr = '';
    py.stdout.setEncoding('utf8');
    py.stderr.setEncoding('utf8');
    py.stdout.on('data', d => stdout += d);
    py.stderr.on('data', d => stderr += d);

    py.on('error', err => {
      console.error('[/api/calcular] Erro ao iniciar Python:', err.message);
      if (!res.headersSent) {
        cors(res);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Python não encontrado: ' + err.message }));
      }
    });

    // Timeout de 8 minutos
    const killTimer = setTimeout(() => {
      try { py.kill(); } catch(e) {}
      if (!res.headersSent) {
        cors(res);
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Timeout: Excel demorou mais de 8 minutos' }));
      }
    }, 480000);

    py.on('close', code => {
      clearTimeout(killTimer);
      console.log(`[/api/calcular] Python saiu com código ${code}`);
      if (stderr) console.warn('[Python stderr]', stderr.slice(0, 400));
      if (res.headersSent) return;

      cors(res);
      if (code !== 0 && !stdout.trim()) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Python falhou (código ' + code + ')', stderr: stderr.slice(0, 500) }));
        return;
      }
      try {
        JSON.parse(stdout); // valida
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(stdout);
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'JSON inválido do Python', raw: stdout.slice(0, 300) }));
      }
    });

    py.stdin.write(body);
    py.stdin.end();
  });
}

http.createServer((req, res) => {
  // ── Health check (usado por hosts cloud tipo Render/Railway pra saber se o
  // servidor subiu, e útil pra checar rapidamente se está no ar de qualquer
  // lugar) — não depende de Excel/Python/pasta de rede, só confirma que o
  // processo Node está respondendo.
  if (req.url === '/health' || req.url === '/api/health') {
    cors(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
    return;
  }

  // ── API: cálculo via Excel ────────────────────────────────────────────────
  if (req.url === '/api/calcular' || req.url.startsWith('/api/calcular?')) {
    handleCalcular(req, res);
    return;
  }

  // ── API: gerar + baixar Excel via Excel real ──────────────────────────────
  if (req.url === '/api/baixar-viab') {
    handleBaixarViab(req, res);
    return;
  }

  // ── API: salvar proposta DOCX/PDF em disco ──────────────────────────────
  if (req.url === '/api/salvar-proposta' && req.method === 'POST') {
    cors(res);
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch(e) { res.writeHead(400); res.end(JSON.stringify({ok:false,error:'JSON inválido'})); return; }
      const { terrenoId, revIdx, nome, base64 } = body;
      if (!terrenoId || !nome || !base64) { res.writeHead(400); res.end(JSON.stringify({ok:false,error:'Campos obrigatórios: terrenoId, nome, base64'})); return; }
      const safeTerrenoId = String(terrenoId).replace(/[^a-zA-Z0-9_\-]/g, '_');
      const safeNome = String(nome).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
      const pasta = path.join(DIR, 'Propostas', safeTerrenoId);
      if (!fs.existsSync(pasta)) fs.mkdirSync(pasta, { recursive: true });
      const filePath = path.join(pasta, safeNome);
      const b64data = base64.includes(',') ? base64.split(',')[1] : base64;
      try {
        fs.writeFileSync(filePath, Buffer.from(b64data, 'base64'));
        const serverPath = `/api/proposta/${safeTerrenoId}/${safeNome}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, server_path: serverPath, file: safeNome }));
      } catch(e) {
        res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── API: servir proposta salva em disco ──────────────────────────────────
  if (req.url && req.url.startsWith('/api/proposta/')) {
    cors(res);
    const parts = req.url.replace('/api/proposta/', '').split('/');
    if (parts.length < 2) { res.writeHead(400); res.end('bad path'); return; }
    const filePath = path.join(DIR, 'Propostas', ...parts.map(p => p.replace(/[^a-zA-Z0-9_\-\.]/g, '_')));
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end(JSON.stringify({error:'Arquivo não encontrado'})); return; }
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === '.pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    res.writeHead(200, { 'Content-Type': mime, 'Content-Disposition': `attachment; filename="${parts[parts.length-1]}"` });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // ── API: salvar cópia Excel por terreno (SheetJS fallback) ────────────────
  if (req.url === '/api/salvar-viab') {
    handleSalvarViab(req, res);
    return;
  }

  // ── API: salvar cópia de documento (IPTU/CDC etc.) na pasta de rede ───────
  if (req.url === '/api/salvar-doc-rede') {
    handleSalvarDocRede(req, res);
    return;
  }

  // ── API: GeoSampa — dados do lote por setor/quadra/condomínio ───────────────
  if (req.url === '/api/geosampa-lote') {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let params;
      try { params = JSON.parse(body); } catch(e) { res.writeHead(400); res.end(JSON.stringify({error:'invalid json'})); return; }

      const payload = JSON.stringify({
        pCdSetor:      params.setor      || '',
        pCdQuadra:     params.quadra     || '',
        pCdCondominio: params.condominio || '00',
      });

      const geoHeaders = {
        'Content-Type':     'application/json; charset=utf-8',
        'Content-Length':   Buffer.byteLength(payload),
        'Accept':           'application/json, text/javascript, */*; q=0.01',
        'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Referer':          'https://geosampa.prefeitura.sp.gov.br/PaginasPublicas/_SBC.aspx',
        'Origin':           'https://geosampa.prefeitura.sp.gov.br',
        'X-Requested-With': 'XMLHttpRequest',
      };

      function tryLote(useHttp, cb) {
        const mod = useHttp ? require('http') : https;
        const opts = {
          hostname: 'geosampa.prefeitura.sp.gov.br',
          path:     '/PaginasPublicas/_SBC.aspx/pesquisaLoteInfo',
          method:   'POST',
          headers:  geoHeaders,
        };
        if (!useHttp) opts.rejectUnauthorized = false;
        const preq = mod.request(opts, pres => {
          let data = '';
          pres.on('data', d => data += d);
          pres.on('end', () => {
            console.log(`[geosampa-lote] ${useHttp?'HTTP':'HTTPS'} status=${pres.statusCode} bytes=${data.length}`);
            cb(null, pres.statusCode, data);
          });
        });
        preq.on('error', e => { console.log(`[geosampa-lote] ${useHttp?'HTTP':'HTTPS'} err=${e.message}`); cb(e); });
        preq.write(payload);
        preq.end();
      }

      tryLote(false, (err, status, data) => {
        if (!err && status === 200) {
          res.writeHead(200, { 'Content-Type':'application/json;charset=utf-8', 'Access-Control-Allow-Origin':'*' });
          return res.end(data);
        }
        // Fallback HTTP
        tryLote(true, (err2, status2, data2) => {
          if (!err2 && status2 === 200) {
            res.writeHead(200, { 'Content-Type':'application/json;charset=utf-8', 'Access-Control-Allow-Origin':'*' });
            return res.end(data2);
          }
          res.writeHead(500); res.end(JSON.stringify({ error: err2?.message || `status ${status2}` }));
        });
      });
    });
    return;
  }

  // ── API: GeoSampa bbox — busca todos os lotes numa bbox (para polígono) ──
  if (req.url && req.url.startsWith('/api/geosampa-bbox')) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const qs     = new URL(req.url, 'http://localhost').searchParams;
    const minLat = parseFloat(qs.get('minLat'));
    const minLng = parseFloat(qs.get('minLng'));
    const maxLat = parseFloat(qs.get('maxLat'));
    const maxLng = parseFloat(qs.get('maxLng'));
    const maxF   = parseInt(qs.get('max') || '500');
    if ([minLat,minLng,maxLat,maxLng].some(isNaN)) {
      res.writeHead(400); res.end(JSON.stringify({error:'minLat/minLng/maxLat/maxLng required'})); return;
    }
    const geoHdrs = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Referer': 'https://geosampa.prefeitura.sp.gov.br/PaginasPublicas/_SBC.aspx',
      'Accept': 'application/json, */*',
    };
    const hasFeats = d => d && (d.match(/"type"\s*:\s*"Feature"/g)||[]).length > 0;
    const replyBbox = data => {
      res.writeHead(200, {'Content-Type':'application/json;charset=utf-8','Access-Control-Allow-Origin':'*'});
      res.end(data);
    };
    // Tenta lat,lon e lon,lat para WFS 1.1.0
    const bboxLL = `${minLat},${minLng},${maxLat},${maxLng},EPSG:4326`;
    const bboxLonLat = `${minLng},${minLat},${maxLng},${maxLat},EPSG:4326`;
    const basePath = (bbox) =>
      `/geoserver/geoportal/wfs?service=WFS&version=1.1.0&request=GetFeature` +
      `&typeName=geoportal:lote_cidadao&outputFormat=application/json&maxFeatures=${maxF}&srsName=EPSG:4326&bbox=${bbox}`;
    const doReqBbox = (mod, path, cb) => {
      const opts = { hostname:'wms.geosampa.prefeitura.sp.gov.br', path, method:'GET', headers:geoHdrs, rejectUnauthorized:false };
      const pr = mod.request(opts, pr2 => {
        let d=''; pr2.on('data',c=>d+=c); pr2.on('end',()=>{
          const n=(d.match(/"type"\s*:\s*"Feature"/g)||[]).length;
          console.log(`[geosampa-bbox] ${mod===https?'HTTPS':'HTTP'} feats=${n}`);
          cb(null,pr2.statusCode,d);
        });
      });
      pr.on('error',e=>{console.log('[geosampa-bbox] err:',e.message);cb(e);});
      pr.setTimeout(12000, ()=>{ console.log('[geosampa-bbox] timeout'); pr.destroy(new Error('timeout GeoSampa')); });
      pr.end();
    };
    const bboxAttempts = [
      ()=>doReqBbox(https, basePath(bboxLL),     (e,s,d)=>bboxNext(e,s,d)),
      ()=>doReqBbox(https, basePath(bboxLonLat), (e,s,d)=>bboxNext(e,s,d)),
      ()=>doReqBbox(require('http'), basePath(bboxLL),     (e,s,d)=>bboxNext(e,s,d)),
      ()=>doReqBbox(require('http'), basePath(bboxLonLat), (e,s,d)=>bboxNext(e,s,d)),
    ];
    let bi=0;
    function bboxNext(err,status,data){
      if(!err && status===200 && hasFeats(data)) return replyBbox(data);
      if(bi<bboxAttempts.length) bboxAttempts[bi++]();
      else replyBbox(JSON.stringify({type:'FeatureCollection',features:[]}));
    }
    bboxAttempts[bi++]();
    return;
  }

  // ── API: GeoSampa zona — busca zoneamento numa bbox ──────────────────────────
  if (req.url && req.url.startsWith('/api/geosampa-zona')) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const qs     = new URL(req.url, 'http://localhost').searchParams;
    const minLat = parseFloat(qs.get('minLat'));
    const minLng = parseFloat(qs.get('minLng'));
    const maxLat = parseFloat(qs.get('maxLat'));
    const maxLng = parseFloat(qs.get('maxLng'));
    const maxF   = parseInt(qs.get('max') || '200');
    if ([minLat,minLng,maxLat,maxLng].some(isNaN)) {
      res.writeHead(400); res.end(JSON.stringify({error:'minLat/minLng/maxLat/maxLng required'})); return;
    }
    const zHdrs = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Referer': 'https://geosampa.prefeitura.sp.gov.br/PaginasPublicas/_SBC.aspx',
      'Accept': 'application/json, */*',
    };
    const hasFeatsZ = d => d && (d.match(/"type"\s*:\s*"Feature"/g)||[]).length > 0;
    const replyZ = data => { res.writeHead(200,{'Content-Type':'application/json;charset=utf-8','Access-Control-Allow-Origin':'*'}); res.end(data); };
    const bboxLL2 = `${minLat},${minLng},${maxLat},${maxLng},EPSG:4326`;
    const bboxLL2b = `${minLng},${minLat},${maxLng},${maxLat},EPSG:4326`;
    const zonaPath = bbox => `/geoserver/geoportal/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=geoportal:perimetro_zona_lei_18177_24&outputFormat=application/json&maxFeatures=${maxF}&srsName=EPSG:4326&bbox=${bbox}`;
    const doReqZ = (mod, path, cb) => {
      const opts = { hostname:'wms.geosampa.prefeitura.sp.gov.br', path, method:'GET', headers:zHdrs, rejectUnauthorized:false };
      const pr = mod.request(opts, pr2 => {
        let d=''; pr2.on('data',c=>d+=c); pr2.on('end',()=>{
          console.log(`[geosampa-zona] feats=${(d.match(/"type"\s*:\s*"Feature"/g)||[]).length}`);
          cb(null, pr2.statusCode, d);
        });
      });
      pr.on('error', e=>{ console.log('[geosampa-zona] err:', e.message); cb(e); });
      pr.setTimeout(12000, ()=>{ console.log('[geosampa-zona] timeout'); pr.destroy(new Error('timeout GeoSampa')); });
      pr.end();
    };
    const zAttempts = [
      ()=>doReqZ(https, zonaPath(bboxLL2),  (e,s,d)=>zNext(e,s,d)),
      ()=>doReqZ(https, zonaPath(bboxLL2b), (e,s,d)=>zNext(e,s,d)),
      ()=>doReqZ(require('http'), zonaPath(bboxLL2),  (e,s,d)=>zNext(e,s,d)),
      ()=>doReqZ(require('http'), zonaPath(bboxLL2b), (e,s,d)=>zNext(e,s,d)),
    ];
    let zi=0;
    function zNext(err,status,data){
      if(!err && status===200 && hasFeatsZ(data)) return replyZ(data);
      if(zi<zAttempts.length) zAttempts[zi++]();
      else replyZ(JSON.stringify({type:'FeatureCollection',features:[]}));
    }
    zAttempts[zi++]();
    return;
  }

  // ── API: GeoSampa patrimônio — bens tombados numa bbox ───────────────────────
  // Mesmo padrão do /api/geosampa-zona, só troca o typeName. Camada
  // geoportal:patrimonio_cultural_bem_tombado (CONPRESP/CONDEPHAAT/IPHAN),
  // geometria em polígono (a área tombada do lote/imóvel).
  if (req.url && req.url.startsWith('/api/geosampa-patrimonio')) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const qs     = new URL(req.url, 'http://localhost').searchParams;
    const minLat = parseFloat(qs.get('minLat'));
    const minLng = parseFloat(qs.get('minLng'));
    const maxLat = parseFloat(qs.get('maxLat'));
    const maxLng = parseFloat(qs.get('maxLng'));
    const maxF   = parseInt(qs.get('max') || '300');
    if ([minLat,minLng,maxLat,maxLng].some(isNaN)) {
      res.writeHead(400); res.end(JSON.stringify({error:'minLat/minLng/maxLat/maxLng required'})); return;
    }
    const ptHdrs = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Referer': 'https://geosampa.prefeitura.sp.gov.br/PaginasPublicas/_SBC.aspx',
      'Accept': 'application/json, */*',
    };
    const hasFeatsPt = d => d && (d.match(/"type"\s*:\s*"Feature"/g)||[]).length > 0;
    const replyPt = data => { res.writeHead(200,{'Content-Type':'application/json;charset=utf-8','Access-Control-Allow-Origin':'*'}); res.end(data); };
    const bboxPt1 = `${minLat},${minLng},${maxLat},${maxLng},EPSG:4326`;
    const bboxPt2 = `${minLng},${minLat},${maxLng},${maxLat},EPSG:4326`;
    const patrimonioPath = bbox => `/geoserver/geoportal/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=geoportal:patrimonio_cultural_bem_tombado&outputFormat=application/json&maxFeatures=${maxF}&srsName=EPSG:4326&bbox=${bbox}`;
    const doReqPt = (mod, path, cb) => {
      const opts = { hostname:'wms.geosampa.prefeitura.sp.gov.br', path, method:'GET', headers:ptHdrs, rejectUnauthorized:false };
      const pr = mod.request(opts, pr2 => {
        let d=''; pr2.on('data',c=>d+=c); pr2.on('end',()=>{
          console.log(`[geosampa-patrimonio] feats=${(d.match(/"type"\s*:\s*"Feature"/g)||[]).length}`);
          cb(null, pr2.statusCode, d);
        });
      });
      pr.on('error', e=>{ console.log('[geosampa-patrimonio] err:', e.message); cb(e); });
      pr.setTimeout(12000, ()=>{ console.log('[geosampa-patrimonio] timeout'); pr.destroy(new Error('timeout GeoSampa')); });
      pr.end();
    };
    const ptAttempts = [
      ()=>doReqPt(https, patrimonioPath(bboxPt1),  (e,s,d)=>ptNext(e,s,d)),
      ()=>doReqPt(https, patrimonioPath(bboxPt2), (e,s,d)=>ptNext(e,s,d)),
      ()=>doReqPt(require('http'), patrimonioPath(bboxPt1),  (e,s,d)=>ptNext(e,s,d)),
      ()=>doReqPt(require('http'), patrimonioPath(bboxPt2), (e,s,d)=>ptNext(e,s,d)),
    ];
    let pti=0;
    function ptNext(err,status,data){
      if(!err && status===200 && hasFeatsPt(data)) return replyPt(data);
      if(pti<ptAttempts.length) ptAttempts[pti++]();
      else replyPt(JSON.stringify({type:'FeatureCollection',features:[]}));
    }
    ptAttempts[pti++]();
    return;
  }

  // ── API: GeoSampa patrimônio cultural — demais camadas (Tombamento +
  // Arqueologia), uma de cada vez por ?layer= ────────────────────────────────
  // A pedido da Kamila (mostrou o print da árvore de camadas do próprio
  // GeoSampa): além do Bem Tombado (rota acima), incluir todo o resto da
  // seção "Patrimônio Cultural" do GeoSampa. Nomes de camada confirmados via
  // GetCapabilities do WFS geoportal (jul/2026) — mesmo padrão do
  // /api/geosampa-ouc (uma camada por vez, bbox com retry https/http × 2
  // ordens de bbox), só que sem o modo ponto (aqui só é usado por bbox, ao
  // navegar o mapa).
  const PATCULT_LAYERS = {
    bairro_ambiental:        'geoportal:patrimonio_cultural_bairro_ambiental',
    lugar_paisagistico:      'geoportal:patrimonio_cultural_lugar_paisagistico_ambiental',
    envoltoria_conpresp:     'geoportal:patrimonio_cultural_area_envoltoria_CONPRESP',
    envoltoria_condephaat:   'geoportal:patrimonio_cultural_area_envoltoria_CONDEPHAAT',
    envoltoria_iphan:        'geoportal:patrimonio_cultural_area_envoltoria_IPHAN',
    acervo_tombado:          'geoportal:patrimonio_cultural_acervo_tombado',
    area_arqueologica:       'geoportal:patrimonio_cultural_area_arqueologica',
    sitio_arqueologico:      'geoportal:patrimonio_cultural_sitio_arqueologico',
    ocorrencia_arqueologica: 'geoportal:patrimonio_cultural_ocorrencia_arqueologica',
    bem_arqueologico:        'geoportal:patrimonio_cultural_bem_arqueologico',
    bem_registrado:          'geoportal:patrimonio_cultural_bem_registrado',
    selo_valor_cultural:     'geoportal:patrimonio_cultural_selo_valor_cultural',
    memoria_paulistana:      'geoportal:patrimonio_cultural_memoria_paulistana',
    zepec_apc:               'geoportal:zona_especial_preservacao_cultural_apc',
    monumento:               'geoportal:patrimonio_cultural_monumento',
  };
  if (req.url && req.url.startsWith('/api/geosampa-patcult')) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const qs     = new URL(req.url, 'http://localhost').searchParams;
    const layer  = qs.get('layer') || '';
    const minLat = parseFloat(qs.get('minLat'));
    const minLng = parseFloat(qs.get('minLng'));
    const maxLat = parseFloat(qs.get('maxLat'));
    const maxLng = parseFloat(qs.get('maxLng'));
    const maxF   = parseInt(qs.get('max') || '200');
    const typeNamePc = PATCULT_LAYERS[layer];
    if (!typeNamePc) {
      res.writeHead(400); res.end(JSON.stringify({error:`layer inválida — use uma de: ${Object.keys(PATCULT_LAYERS).join(', ')}`})); return;
    }
    if ([minLat,minLng,maxLat,maxLng].some(isNaN)) {
      res.writeHead(400); res.end(JSON.stringify({error:'minLat/minLng/maxLat/maxLng required'})); return;
    }
    const pcHdrs = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Referer': 'https://geosampa.prefeitura.sp.gov.br/PaginasPublicas/_SBC.aspx',
      'Accept': 'application/json, */*',
    };
    const hasFeatsPc = d => d && (d.match(/"type"\s*:\s*"Feature"/g)||[]).length > 0;
    const replyPc = data => { res.writeHead(200,{'Content-Type':'application/json;charset=utf-8','Access-Control-Allow-Origin':'*'}); res.end(data); };
    const bboxPc1 = `${minLat},${minLng},${maxLat},${maxLng},EPSG:4326`;
    const bboxPc2 = `${minLng},${minLat},${maxLng},${maxLat},EPSG:4326`;
    const patcultPath = bbox =>
      `/geoserver/geoportal/wfs?service=WFS&version=1.1.0&request=GetFeature` +
      `&typeName=${typeNamePc}&outputFormat=application/json&maxFeatures=${maxF}&srsName=EPSG:4326&bbox=${bbox}`;
    const doReqPc = (mod, path, cb) => {
      const opts = { hostname:'wms.geosampa.prefeitura.sp.gov.br', path, method:'GET', headers:pcHdrs, rejectUnauthorized:false };
      const pr = mod.request(opts, pr2 => {
        let d=''; pr2.on('data',c=>d+=c); pr2.on('end',()=>{
          console.log(`[geosampa-patcult:${layer}] ${mod===https?'HTTPS':'HTTP'} feats=${(d.match(/"type"\s*:\s*"Feature"/g)||[]).length}`);
          cb(null, pr2.statusCode, d);
        });
      });
      pr.on('error', e=>{ console.log(`[geosampa-patcult:${layer}] err:`, e.message); cb(e); });
      pr.setTimeout(12000, ()=>{ console.log(`[geosampa-patcult:${layer}] timeout`); pr.destroy(new Error('timeout GeoSampa')); });
      pr.end();
    };
    const pcAttempts = [
      ()=>doReqPc(https, patcultPath(bboxPc1), (e,s,d)=>pcNext(e,s,d)),
      ()=>doReqPc(https, patcultPath(bboxPc2), (e,s,d)=>pcNext(e,s,d)),
      ()=>doReqPc(require('http'), patcultPath(bboxPc1), (e,s,d)=>pcNext(e,s,d)),
      ()=>doReqPc(require('http'), patcultPath(bboxPc2), (e,s,d)=>pcNext(e,s,d)),
    ];
    let pci=0;
    function pcNext(err,status,data){
      if(!err && status===200 && hasFeatsPc(data)) return replyPc(data);
      if(pci<pcAttempts.length) pcAttempts[pci++]();
      else replyPc(JSON.stringify({type:'FeatureCollection',features:[]}));
    }
    pcAttempts[pci++]();
    return;
  }

  // ── API: GeoSampa ambiental — APAs + corredor verde numa bbox ────────────────
  // Junta 3 camadas do GeoSampa numa FeatureCollection só, cada feature
  // marcada com properties._camada pra o front colorir diferente:
  //   apa_borore / apa_cm → APA Bororé-Colônia e APA Capivari-Monos (zona sul)
  //   corredor_verde      → corredores verdes / áreas de proteção ao longo de cursos d'água
  if (req.url && req.url.startsWith('/api/geosampa-ambiental')) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const qs     = new URL(req.url, 'http://localhost').searchParams;
    const minLat = parseFloat(qs.get('minLat'));
    const minLng = parseFloat(qs.get('minLng'));
    const maxLat = parseFloat(qs.get('maxLat'));
    const maxLng = parseFloat(qs.get('maxLng'));
    const maxF   = parseInt(qs.get('max') || '150');
    if ([minLat,minLng,maxLat,maxLng].some(isNaN)) {
      res.writeHead(400); res.end(JSON.stringify({error:'minLat/minLng/maxLat/maxLng required'})); return;
    }
    const ambHdrs = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Referer': 'https://geosampa.prefeitura.sp.gov.br/PaginasPublicas/_SBC.aspx',
      'Accept': 'application/json, */*',
    };
    const hasFeatsAmb = d => d && (d.match(/"type"\s*:\s*"Feature"/g)||[]).length > 0;
    const bboxAmb1 = `${minLat},${minLng},${maxLat},${maxLng},EPSG:4326`;
    const bboxAmb2 = `${minLng},${minLat},${maxLng},${maxLat},EPSG:4326`;
    const AMB_LAYERS = [
      { key:'apa_borore',     typeName:'geoportal:GEOSAMPA_zoneamento_geoambiental_apa_borore' },
      { key:'apa_cm',         typeName:'geoportal:GEOSAMPA_zoneamento_geoambiental_apa_cm' },
      { key:'corredor_verde', typeName:'geoportal:GEOSAMPA_corredor_verde' },
    ];
    const ambPath = (typeName, bbox) => `/geoserver/geoportal/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=${typeName}&outputFormat=application/json&maxFeatures=${maxF}&srsName=EPSG:4326&bbox=${bbox}`;
    const doReqAmb = (mod, path, cb) => {
      const opts = { hostname:'wms.geosampa.prefeitura.sp.gov.br', path, method:'GET', headers:ambHdrs, rejectUnauthorized:false };
      const pr = mod.request(opts, pr2 => {
        let d=''; pr2.on('data',c=>d+=c); pr2.on('end',()=>cb(null, pr2.statusCode, d));
      });
      pr.on('error', e=>cb(e));
      pr.setTimeout(12000, ()=>{ pr.destroy(new Error('timeout GeoSampa')); });
      pr.end();
    };
    // Busca 1 typeName, tentando as 4 combinações de https/http x ordem de bbox.
    function fetchAmbLayer(typeName, cb){
      const attempts = [
        ()=>doReqAmb(https, ambPath(typeName, bboxAmb1),  next),
        ()=>doReqAmb(https, ambPath(typeName, bboxAmb2), next),
        ()=>doReqAmb(require('http'), ambPath(typeName, bboxAmb1),  next),
        ()=>doReqAmb(require('http'), ambPath(typeName, bboxAmb2), next),
      ];
      let ai=0;
      function next(err,status,data){
        if(!err && status===200 && hasFeatsAmb(data)) return cb(JSON.parse(data));
        if(ai<attempts.length) attempts[ai++]();
        else cb({type:'FeatureCollection',features:[]});
      }
      attempts[ai++]();
    }
    let pendentes = AMB_LAYERS.length;
    const todasFeatures = [];
    AMB_LAYERS.forEach(({key, typeName}) => {
      fetchAmbLayer(typeName, gj => {
        (gj.features||[]).forEach(f => {
          f.properties = f.properties || {};
          f.properties._camada = key;
          todasFeatures.push(f);
        });
        pendentes--;
        if (pendentes === 0) {
          console.log(`[geosampa-ambiental] feats totais=${todasFeatures.length}`);
          res.writeHead(200,{'Content-Type':'application/json;charset=utf-8','Access-Control-Allow-Origin':'*'});
          res.end(JSON.stringify({type:'FeatureCollection', features:todasFeatures}));
        }
      });
    });
    return;
  }

  // ── API: GeoSampa infra viária — Lei de Melhoramento Viário + Faixa Não
  // Edificável numa bbox ────────────────────────────────────────────────────
  // Mesmo padrão combinado do /api/geosampa-ambiental (2 camadas, uma
  // FeatureCollection só, marcada por properties._camada):
  //   melhoramento → geoportal:geoconvias_lei_melhoramento_vigente (perímetro
  //     indicativo de incidência de lei de melhoramento viário — abertura de
  //     via, alargamento, viaduto etc. NÃO é o alinhamento exato da planta da
  //     lei, só indica que o lote pode ser afetado; a certidão oficial é via
  //     Portal 156)
  //   faixa_nao_edif → geoportal:geoconvias_faixa_nao_edificavel (faixa non
  //     aedificandi ao longo de cursos d'água/drenagem, Código de Obras 1992 —
  //     Decreto 32.329/1992, hoje substituído pelo Decreto 57.776/2017)
  const INFRA_VIARIA_LAYERS = [
    { key:'melhoramento',   typeName:'geoportal:geoconvias_lei_melhoramento_vigente' },
    { key:'faixa_nao_edif', typeName:'geoportal:geoconvias_faixa_nao_edificavel' },
  ];
  if (req.url && req.url.startsWith('/api/geosampa-infra-viaria')) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const qs     = new URL(req.url, 'http://localhost').searchParams;
    const minLat = parseFloat(qs.get('minLat'));
    const minLng = parseFloat(qs.get('minLng'));
    const maxLat = parseFloat(qs.get('maxLat'));
    const maxLng = parseFloat(qs.get('maxLng'));
    const maxF   = parseInt(qs.get('max') || '300');
    if ([minLat,minLng,maxLat,maxLng].some(isNaN)) {
      res.writeHead(400); res.end(JSON.stringify({error:'minLat/minLng/maxLat/maxLng required'})); return;
    }
    const ivHdrs = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Referer': 'https://geosampa.prefeitura.sp.gov.br/PaginasPublicas/_SBC.aspx',
      'Accept': 'application/json, */*',
    };
    const hasFeatsIv = d => d && (d.match(/"type"\s*:\s*"Feature"/g)||[]).length > 0;
    const bboxIv1 = `${minLat},${minLng},${maxLat},${maxLng},EPSG:4326`;
    const bboxIv2 = `${minLng},${minLat},${maxLng},${maxLat},EPSG:4326`;
    const ivPath = (typeName, bbox) => `/geoserver/geoportal/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=${typeName}&outputFormat=application/json&maxFeatures=${maxF}&srsName=EPSG:4326&bbox=${bbox}`;
    const doReqIv = (mod, path, cb) => {
      const opts = { hostname:'wms.geosampa.prefeitura.sp.gov.br', path, method:'GET', headers:ivHdrs, rejectUnauthorized:false };
      const pr = mod.request(opts, pr2 => {
        let d=''; pr2.on('data',c=>d+=c); pr2.on('end',()=>cb(null, pr2.statusCode, d));
      });
      pr.on('error', e=>cb(e));
      pr.setTimeout(12000, ()=>{ pr.destroy(new Error('timeout GeoSampa')); });
      pr.end();
    };
    function fetchIvLayer(typeName, cb){
      const attempts = [
        ()=>doReqIv(https, ivPath(typeName, bboxIv1),  next),
        ()=>doReqIv(https, ivPath(typeName, bboxIv2), next),
        ()=>doReqIv(require('http'), ivPath(typeName, bboxIv1),  next),
        ()=>doReqIv(require('http'), ivPath(typeName, bboxIv2), next),
      ];
      let ai=0;
      function next(err,status,data){
        if(!err && status===200 && hasFeatsIv(data)) { try{ return cb(JSON.parse(data)); }catch(e){} }
        if(ai<attempts.length) attempts[ai++]();
        else cb({type:'FeatureCollection',features:[]});
      }
      attempts[ai++]();
    }
    let pendentesIv = INFRA_VIARIA_LAYERS.length;
    const todasFeaturesIv = [];
    INFRA_VIARIA_LAYERS.forEach(({key, typeName}) => {
      fetchIvLayer(typeName, gj => {
        (gj.features||[]).forEach(f => {
          f.properties = f.properties || {};
          f.properties._camada = key;
          todasFeaturesIv.push(f);
        });
        pendentesIv--;
        if (pendentesIv === 0) {
          console.log(`[geosampa-infra-viaria] feats totais=${todasFeaturesIv.length}`);
          res.writeHead(200,{'Content-Type':'application/json;charset=utf-8','Access-Control-Allow-Origin':'*'});
          res.end(JSON.stringify({type:'FeatureCollection', features:todasFeaturesIv}));
        }
      });
    });
    return;
  }

  // ── API: GeoSampa contaminação — Área Contaminada Reabilitada (SVMA) + Área
  // Suspeita de Contaminação (SIGAC) numa bbox ─────────────────────────────
  // Mesmo padrão combinado do /api/geosampa-ambiental (2 camadas, uma
  // FeatureCollection só, marcada por properties._camada) — pedido da Kamila
  // pra virar polígonos clicáveis no mapa (antes só WMS raster, sem popup)
  // mostrando classificação/contaminante/endereço/processo de cada área:
  //   reabilitada → geoportal:area_contaminada_reabilitada_svma (verde — já remediada)
  //   suspeita    → geoportal:GEOSAMPA_area_contaminada_sigac (vermelho — sob investigação)
  const CONTAM_LAYERS = [
    { key:'reabilitada', typeName:'geoportal:area_contaminada_reabilitada_svma' },
    { key:'suspeita',     typeName:'geoportal:GEOSAMPA_area_contaminada_sigac' },
  ];
  if (req.url && req.url.startsWith('/api/geosampa-contaminacao')) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const qs     = new URL(req.url, 'http://localhost').searchParams;
    const minLat = parseFloat(qs.get('minLat'));
    const minLng = parseFloat(qs.get('minLng'));
    const maxLat = parseFloat(qs.get('maxLat'));
    const maxLng = parseFloat(qs.get('maxLng'));
    const maxF   = parseInt(qs.get('max') || '300');
    if ([minLat,minLng,maxLat,maxLng].some(isNaN)) {
      res.writeHead(400); res.end(JSON.stringify({error:'minLat/minLng/maxLat/maxLng required'})); return;
    }
    const ctHdrs = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Referer': 'https://geosampa.prefeitura.sp.gov.br/PaginasPublicas/_SBC.aspx',
      'Accept': 'application/json, */*',
    };
    const hasFeatsCt = d => d && (d.match(/"type"\s*:\s*"Feature"/g)||[]).length > 0;
    const bboxCt1 = `${minLat},${minLng},${maxLat},${maxLng},EPSG:4326`;
    const bboxCt2 = `${minLng},${minLat},${maxLng},${maxLat},EPSG:4326`;
    const ctPath = (typeName, bbox) => `/geoserver/geoportal/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=${typeName}&outputFormat=application/json&maxFeatures=${maxF}&srsName=EPSG:4326&bbox=${bbox}`;
    const doReqCt = (mod, path, cb) => {
      const opts = { hostname:'wms.geosampa.prefeitura.sp.gov.br', path, method:'GET', headers:ctHdrs, rejectUnauthorized:false };
      const pr = mod.request(opts, pr2 => {
        let d=''; pr2.on('data',c=>d+=c); pr2.on('end',()=>cb(null, pr2.statusCode, d));
      });
      pr.on('error', e=>cb(e));
      pr.setTimeout(12000, ()=>{ pr.destroy(new Error('timeout GeoSampa')); });
      pr.end();
    };
    function fetchCtLayer(typeName, cb){
      const attempts = [
        ()=>doReqCt(https, ctPath(typeName, bboxCt1),  next),
        ()=>doReqCt(https, ctPath(typeName, bboxCt2), next),
        ()=>doReqCt(require('http'), ctPath(typeName, bboxCt1),  next),
        ()=>doReqCt(require('http'), ctPath(typeName, bboxCt2), next),
      ];
      let ai=0;
      function next(err,status,data){
        if(!err && status===200 && hasFeatsCt(data)) { try{ return cb(JSON.parse(data)); }catch(e){} }
        if(ai<attempts.length) attempts[ai++]();
        else cb({type:'FeatureCollection',features:[]});
      }
      attempts[ai++]();
    }
    let pendentesCt = CONTAM_LAYERS.length;
    const todasFeaturesCt = [];
    CONTAM_LAYERS.forEach(({key, typeName}) => {
      fetchCtLayer(typeName, gj => {
        (gj.features||[]).forEach(f => {
          f.properties = f.properties || {};
          f.properties._camada = key;
          todasFeaturesCt.push(f);
        });
        pendentesCt--;
        if (pendentesCt === 0) {
          console.log(`[geosampa-contaminacao] feats totais=${todasFeaturesCt.length}`);
          res.writeHead(200,{'Content-Type':'application/json;charset=utf-8','Access-Control-Allow-Origin':'*'});
          res.end(JSON.stringify({type:'FeatureCollection', features:todasFeaturesCt}));
        }
      });
    });
    return;
  }

  // ── API: GeoSampa OUC/AIU — perímetros e setores/subsetores de Operações Urbanas ──
  // Camadas confirmadas via metadados GeoSampa (jul/2026):
  //   operacao_urbana      → geoportal:operacao_urbana (perímetro geral; cobre Faria Lima,
  //                          Água Branca, Água Espraiada, Centro)
  //   subsetor_operacao_urbana → geoportal:subsetor_operacao_urbana (SETOR/SUBSETOR real —
  //                          confirmado via shapefile baixado direto do GeoSampa, jul/2026 —
  //                          atributos nm_operacao_urbana/nm_setor_operacao_urbana/
  //                          nm_subsetor_operacao_urbana/tx_lei_subsetor. Cobre Faria Lima
  //                          (setores Pinheiros/Faria Lima/Hélio Pellegrino/Olimpíadas, sub 1A-4D),
  //                          Água Branca, Água Espraiada e Centro (revogada))
  //   tamanduatei          → geoportal:oucbt_perimetro (atributo tx_tipo_perimetro="Setor":
  //                          Vila Carioca, Cambuci, Vila Prudente, Mooca... — Lei 18.079/2024)
  //   jurubatuba           → geoportal:aiu_perimetro_jurubatuba (atributo nm_aiu: Jurubatuba/
  //                          Interlagos/Vila Andrade; tx_classificacao_perimetro="Subsetor" —
  //                          Lei 18.178/2024)
  //   leopoldina           → geoportal:aiu_vl_perimetro_adesao (perímetro único, sem setor —
  //                          Lei 17.968/2023)
  const OUC_LAYERS = {
    operacao_urbana:  'geoportal:operacao_urbana',
    subsetor_ouc:     'geoportal:subsetor_operacao_urbana',
    area_influencia_fl: 'geoportal:oucfl_area_influencia', // lotes na área de influência de transporte
                        // da Faria Lima (raio 400m estações / faixa 250m corredores) — Art. 13 §6º,
                        // Lei 18.175/2024. Confirmado via shapefile baixado do GeoSampa (292 feições).
                        // Atributos: cd_identificador_oucfl_area_influencia, qt_area_metro,
                        // tx_lei_numero, tx_observacao — SEM valor de Fp majorado (só a geometria).
    tamanduatei:      'geoportal:oucbt_perimetro',
    jurubatuba:       'geoportal:aiu_perimetro_jurubatuba',
    leopoldina:       'geoportal:aiu_vl_perimetro_adesao',
    // AIU Arco Pinheiros (Lei 18.222/2024 — Plano de Intervenção Urbana Arco
    // Pinheiros), confirmado via WFS jul/2026:
    //   pinheiros_perimetro → geoportal:aiu_perimetro_pinheiros (Perímetros —
    //     Projetos Estratégicos/Áreas de Estruturação Local, Quadro 2A/2B)
    //   pinheiros_parametro → geoportal:aiu_parametro_urbanistico_pinheiros
    //     (Parâmetros Urbanísticos, Quadro 3A — CA máx/gabarito/cota-parte/
    //     fatores de planejamento por código cd_parametro: T=Transformação,
    //     Q=Qualificação, P=Preservação)
    pinheiros_perimetro: 'geoportal:aiu_perimetro_pinheiros',
    pinheiros_parametro: 'geoportal:aiu_parametro_urbanistico_pinheiros',
  };
  if (req.url && req.url.startsWith('/api/geosampa-ouc')) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const qs     = new URL(req.url, 'http://localhost').searchParams;
    const layer  = qs.get('layer') || '';
    // Modo ponto: lat/lng de um terreno específico (ex: identificar setor/subsetor
    // da OUC em que ele cai) — monta um bbox minúsculo (~15m) em volta do ponto,
    // igual ao truque já usado em /api/geosampa-click.
    const ptLat = parseFloat(qs.get('lat'));
    const ptLng = parseFloat(qs.get('lng'));
    const pontoMode = !isNaN(ptLat) && !isNaN(ptLng);
    const PT_DELTA = 0.00015; // ~15m
    let minLat, minLng, maxLat, maxLng;
    if (pontoMode) {
      minLat = ptLat - PT_DELTA; maxLat = ptLat + PT_DELTA;
      minLng = ptLng - PT_DELTA; maxLng = ptLng + PT_DELTA;
    } else {
      minLat = parseFloat(qs.get('minLat'));
      minLng = parseFloat(qs.get('minLng'));
      maxLat = parseFloat(qs.get('maxLat'));
      maxLng = parseFloat(qs.get('maxLng'));
    }
    const maxF   = parseInt(qs.get('max') || '200');
    const typeName = OUC_LAYERS[layer];
    if (!typeName) {
      res.writeHead(400); res.end(JSON.stringify({error:`layer inválida — use uma de: ${Object.keys(OUC_LAYERS).join(', ')}`})); return;
    }
    if ([minLat,minLng,maxLat,maxLng].some(isNaN)) {
      res.writeHead(400); res.end(JSON.stringify({error:'informe minLat/minLng/maxLat/maxLng (bbox) OU lat/lng (ponto)'})); return;
    }
    const oHdrs = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Referer': 'https://geosampa.prefeitura.sp.gov.br/PaginasPublicas/_SBC.aspx',
      'Accept': 'application/json, */*',
    };
    const hasFeatsO = d => d && (d.match(/"type"\s*:\s*"Feature"/g)||[]).length > 0;
    const replyO = data => { res.writeHead(200,{'Content-Type':'application/json;charset=utf-8','Access-Control-Allow-Origin':'*'}); res.end(data); };
    const bboxO1 = `${minLat},${minLng},${maxLat},${maxLng},EPSG:4326`;
    const bboxO2 = `${minLng},${minLat},${maxLng},${maxLat},EPSG:4326`;
    const oucPath = bbox =>
      `/geoserver/geoportal/wfs?service=WFS&version=1.1.0&request=GetFeature` +
      `&typeName=${typeName}&outputFormat=application/json&maxFeatures=${maxF}&srsName=EPSG:4326&bbox=${bbox}`;
    const doReqO = (mod, path, cb) => {
      const opts = { hostname:'wms.geosampa.prefeitura.sp.gov.br', path, method:'GET', headers:oHdrs, rejectUnauthorized:false };
      const pr = mod.request(opts, pr2 => {
        let d=''; pr2.on('data',c=>d+=c); pr2.on('end',()=>{
          console.log(`[geosampa-ouc:${layer}] ${mod===https?'HTTPS':'HTTP'} feats=${(d.match(/"type"\s*:\s*"Feature"/g)||[]).length}`);
          cb(null, pr2.statusCode, d);
        });
      });
      pr.on('error', e=>{ console.log(`[geosampa-ouc:${layer}] err:`, e.message); cb(e); });
      pr.setTimeout(12000, ()=>{ console.log(`[geosampa-ouc:${layer}] timeout`); pr.destroy(new Error('timeout GeoSampa')); });
      pr.end();
    };
    const oAttempts = [
      ()=>doReqO(https, oucPath(bboxO1), (e,s,d)=>oNext(e,s,d)),
      ()=>doReqO(https, oucPath(bboxO2), (e,s,d)=>oNext(e,s,d)),
      ()=>doReqO(require('http'), oucPath(bboxO1), (e,s,d)=>oNext(e,s,d)),
      ()=>doReqO(require('http'), oucPath(bboxO2), (e,s,d)=>oNext(e,s,d)),
    ];
    let oi=0;
    function oNext(err,status,data){
      if(!err && status===200 && hasFeatsO(data)) return replyO(data);
      if(oi<oAttempts.length) oAttempts[oi++]();
      else replyO(JSON.stringify({type:'FeatureCollection',features:[]}));
    }
    oAttempts[oi++]();
    return;
  }

  // ── API: GeoSampa ponto genérico — qualquer camada, por lat/lng ────────────
  // Generaliza o mesmo truque do /api/geosampa-ouc (bbox minúsculo ~15m em
  // volta do ponto, com retry https/http e 2 ordens de bbox) pra outras
  // camadas usadas na Ficha de Aquisição (tombamento, zoneamento, carta
  // geotécnica, desapropriação, contaminação) — essas consultas eram feitas
  // direto do navegador pro GeoSampa (função geoFetch, com fallback em
  // proxies públicos de CORS tipo corsproxy.io/allorigins.win), o que é lento
  // e intermitente. Passando pelo servidor (que já tem acesso direto,
  // confirmado funcionando nas outras rotas /api/geosampa-*) fica muito mais
  // confiável. Allowlist de typeName por segurança (não é proxy aberto).
  const GEOSAMPA_PONTO_LAYERS = new Set([
    'geoportal:lote_cidadao',
    'geoportal:patrimonio_cultural_bem_tombado',
    'geoportal:perimetro_zona_lei_18177_24',
    'geoportal:carta_geotecnica_2024',
    'geoportal:decreto_desapropriacao',
    'geoportal:area_contaminada_reabilitada',
    'geoportal:area_potencial_suspeita_contaminacao',
    // 7 camadas novas pedidas pela Kamila (mesmas do objeto _geoLayers do
    // mapa) — usadas na seção de Restrições e Condicionantes da Ficha de
    // Aquisição (ver gerarFicha() no index.html).
    'geoportal:area_contaminada_reabilitada_svma',
    'geoportal:GEOSAMPA_area_contaminada_sigac',
    'geoportal:GEOSAMPA_cadastro_area_publica_cidadao',
    'geoportal:arruamento_aprovado',
    'geoportal:passagem',
    'geoportal:planta_dup_dis_pd',
    'geoportal:planta_expropriatoria_pd',
    // Lei de Melhoramento Viário + Faixa Não Edificável (mesmas camadas do
    // /api/geosampa-infra-viaria do mapa) — também usadas na Ficha de Aquisição.
    'geoportal:geoconvias_lei_melhoramento_vigente',
    'geoportal:geoconvias_faixa_nao_edificavel',
  ]);
  if (req.url && req.url.startsWith('/api/geosampa-ponto')) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const qs = new URL(req.url, 'http://localhost').searchParams;
    const typeName = qs.get('typeName') || '';
    if (!GEOSAMPA_PONTO_LAYERS.has(typeName)) {
      res.writeHead(400); res.end(JSON.stringify({error:`typeName inválido — use uma de: ${[...GEOSAMPA_PONTO_LAYERS].join(', ')}`})); return;
    }
    const ptLat = parseFloat(qs.get('lat'));
    const ptLng = parseFloat(qs.get('lng'));
    if (isNaN(ptLat) || isNaN(ptLng)) { res.writeHead(400); res.end(JSON.stringify({error:'informe lat/lng'})); return; }
    const maxF = parseInt(qs.get('count') || '5');
    const PT_DELTA = 0.00015; // ~15m
    const minLat = ptLat - PT_DELTA, maxLat = ptLat + PT_DELTA;
    const minLng = ptLng - PT_DELTA, maxLng = ptLng + PT_DELTA;
    const pHdrs = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Referer': 'https://geosampa.prefeitura.sp.gov.br/PaginasPublicas/_SBC.aspx',
      'Accept': 'application/json, */*',
    };
    const hasFeatsP = d => d && (d.match(/"type"\s*:\s*"Feature"/g)||[]).length > 0;
    const replyP = data => { res.writeHead(200,{'Content-Type':'application/json;charset=utf-8','Access-Control-Allow-Origin':'*'}); res.end(data); };
    const bboxP1 = `${minLat},${minLng},${maxLat},${maxLng},EPSG:4326`;
    const bboxP2 = `${minLng},${minLat},${maxLng},${maxLat},EPSG:4326`;
    const pontoPath = bbox =>
      `/geoserver/geoportal/wfs?service=WFS&version=1.1.0&request=GetFeature` +
      `&typeName=${typeName}&outputFormat=application/json&maxFeatures=${maxF}&srsName=EPSG:4326&bbox=${bbox}`;
    const doReqP = (mod, path, cb) => {
      const opts = { hostname:'wms.geosampa.prefeitura.sp.gov.br', path, method:'GET', headers:pHdrs, rejectUnauthorized:false };
      const pr = mod.request(opts, pr2 => {
        let d=''; pr2.on('data',c=>d+=c); pr2.on('end',()=>{
          console.log(`[geosampa-ponto:${typeName}] ${mod===https?'HTTPS':'HTTP'} feats=${(d.match(/"type"\s*:\s*"Feature"/g)||[]).length}`);
          cb(null, pr2.statusCode, d);
        });
      });
      pr.on('error', e=>{ console.log(`[geosampa-ponto:${typeName}] err:`, e.message); cb(e); });
      pr.setTimeout(12000, ()=>{ console.log(`[geosampa-ponto:${typeName}] timeout`); pr.destroy(new Error('timeout GeoSampa')); });
      pr.end();
    };
    const pAttempts = [
      ()=>doReqP(https, pontoPath(bboxP1), (e,s,d)=>pNext(e,s,d)),
      ()=>doReqP(https, pontoPath(bboxP2), (e,s,d)=>pNext(e,s,d)),
      ()=>doReqP(require('http'), pontoPath(bboxP1), (e,s,d)=>pNext(e,s,d)),
      ()=>doReqP(require('http'), pontoPath(bboxP2), (e,s,d)=>pNext(e,s,d)),
    ];
    let pi=0;
    function pNext(err,status,data){
      if(!err && status===200 && hasFeatsP(data)) return replyP(data);
      if(pi<pAttempts.length) pAttempts[pi++]();
      else replyP(JSON.stringify({type:'FeatureCollection',features:[]}));
    }
    pAttempts[pi++]();
    return;
  }

  // ── API: GeoSampa Cartório (CRI) ──
  if (req.url && req.url.startsWith('/api/geosampa-cartorio')) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const qs = new URL(req.url, 'http://localhost').searchParams;
    const minLat = parseFloat(qs.get('minLat')||'-23.60'), maxLat = parseFloat(qs.get('maxLat')||'-23.50');
    const minLng = parseFloat(qs.get('minLng')||'-46.70'), maxLng = parseFloat(qs.get('maxLng')||'-46.60');
    const maxF = Math.min(parseInt(qs.get('max')||'50'), 100);
    const replyC = data => { res.writeHead(200,{'Content-Type':'application/json;charset=utf-8','Access-Control-Allow-Origin':'*'}); res.end(data); };
    const empty = JSON.stringify({type:'FeatureCollection',features:[]});
    const bboxLL = `${minLat},${minLng},${maxLat},${maxLng},EPSG:4326`;
    // Try two possible layer names
    const layerNames = ['circunscricao_cartorio_ri','restricao_circunscricao_ri','limite_cartorio'];
    const hdrs = { 'User-Agent':'Mozilla/5.0','Accept':'application/json,*/*','Referer':'https://geosampa.prefeitura.sp.gov.br/' };
    function tryNext(layerIdx, bboxStr, useHttps) {
      if (layerIdx >= layerNames.length) { replyC(empty); return; }
      const layer = layerNames[layerIdx];
      const path = `/geoserver/geoportal/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=geoportal:${layer}&outputFormat=application/json&maxFeatures=${maxF}&srsName=EPSG:4326&bbox=${bboxStr}`;
      const mod = useHttps ? https : http;
      const opts = { hostname:'wms.geosampa.prefeitura.sp.gov.br', path, method:'GET', headers:hdrs, rejectUnauthorized:false };
      const pr = mod.request(opts, pr2 => {
        let d=''; pr2.on('data',c=>d+=c); pr2.on('end',()=>{
          const n=(d.match(/"type"\s*:\s*"Feature"/g)||[]).length;
          console.log(`[geosampa-cartorio] layer=${layer} feats=${n}`);
          if(n>0){ replyC(d); } else { tryNext(layerIdx+1, bboxStr, useHttps); }
        });
      });
      pr.on('error', ()=>{ tryNext(layerIdx+1, bboxStr, useHttps); });
      pr.end();
    }
    tryNext(0, bboxLL, true);
    return;
  }

  // ── API: GeoSampa click — WFS 2.0.0 INTERSECTS (retorna exatamente o lote clicado) ──
  if (req.url && req.url.startsWith('/api/geosampa-click')) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const qs  = new URL(req.url, 'http://localhost').searchParams;
    const lat = parseFloat(qs.get('lat'));
    const lng = parseFloat(qs.get('lng'));
    if (isNaN(lat) || isNaN(lng)) { res.writeHead(400); res.end(JSON.stringify({error:'lat/lng required'})); return; }

    // GeoSampa ignora CQL_FILTER=INTERSECTS e count — usa BBOX com delta pequeno (~11m)
    // WFS 1.1.0 com EPSG:4326 usa ordem lat,lon (Y,X) no BBOX
    const geoHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Referer':    'https://geosampa.prefeitura.sp.gov.br/PaginasPublicas/_SBC.aspx',
      'Accept':     'application/json, */*',
    };

    function doRequest(mod, path, cb) {
      const opts = { hostname: 'wms.geosampa.prefeitura.sp.gov.br', path, method: 'GET', headers: geoHeaders, rejectUnauthorized: false };
      const preq = mod.request(opts, pres => {
        let data = '';
        pres.on('data', c => data += c);
        pres.on('end', () => {
          const n = (data.match(/"type"\s*:\s*"Feature"/g)||[]).length;
          console.log(`[geosampa-click] ${mod===https?'HTTPS':'HTTP'} status=${pres.statusCode} feats=${n}`);
          cb(null, pres.statusCode, data);
        });
      });
      preq.on('error', e => { console.log('[geosampa-click] err:', e.message); cb(e); });
      preq.end();
    }

    const hasFeatures = d => d && (d.match(/"type"\s*:\s*"Feature"/g)||[]).length > 0;
    const reply = data => { res.writeHead(200,{'Content-Type':'application/json;charset=utf-8','Access-Control-Allow-Origin':'*'}); res.end(data); };

    // BBOX pequeno (0.0001° ≈ 11m) — ordem lat,lon para WFS 1.1.0 EPSG:4326
    const dd = 0.0001;
    const makeBbox = (d, latFirst) => latFirst
      ? `${lat-d},${lng-d},${lat+d},${lng+d},EPSG:4326`
      : `${lng-d},${lat-d},${lng+d},${lat+d},EPSG:4326`;
    const makePath = (d, latFirst) =>
      `/geoserver/geoportal/wfs?service=WFS&version=1.1.0&request=GetFeature` +
      `&typeName=geoportal:lote_cidadao&outputFormat=application/json&maxFeatures=3` +
      `&srsName=EPSG:4326&bbox=${makeBbox(d, latFirst)}`;

    // Tenta 4 variações: HTTPS lat,lon → HTTPS lon,lat → HTTP lat,lon → HTTP lon,lat
    // Se todas falharem com delta pequeno, aumenta para 0.0005
    const attempts = [
      () => doRequest(https, makePath(dd, true),  (e,s,d) => next(e,s,d,1)),
      () => doRequest(https, makePath(dd, false), (e,s,d) => next(e,s,d,2)),
      () => doRequest(require('http'), makePath(dd, true),  (e,s,d) => next(e,s,d,3)),
      () => doRequest(require('http'), makePath(dd, false), (e,s,d) => next(e,s,d,4)),
      () => doRequest(https, makePath(0.001, true),  (e,s,d) => next(e,s,d,5)),
      () => doRequest(https, makePath(0.001, false), (e,s,d) => next(e,s,d,6)),
    ];
    let ai = 0;
    function next(err, status, data, attempt) {
      if (!err && status === 200 && hasFeatures(data)) { console.log(`[geosampa-click] ok attempt=${attempt}`); return reply(data); }
      if (ai < attempts.length) attempts[ai++]();
      else reply(JSON.stringify({ type:'FeatureCollection', features:[] }));
    }
    attempts[ai++]();
    return;
  }

  // ── API: busca geometria WFS por SQL (setor+quadra+lote) via CQL_FILTER ────────
  if (req.url && req.url.startsWith('/api/geosampa-sql-geom')) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const qs = new URL(req.url, 'http://localhost').searchParams;
    const setor = (qs.get('setor')||'').replace(/\D/g,'').padStart(3,'0');
    const quadra = (qs.get('quadra')||'').replace(/\D/g,'').padStart(3,'0');
    const lote = (qs.get('lote')||'').replace(/\D/g,'').padStart(4,'0');
    if (!setor || !quadra || !lote) { res.writeHead(400); res.end(JSON.stringify({error:'setor/quadra/lote obrigatórios'})); return; }

    const cql = encodeURIComponent(`cd_setor_fiscal='${setor}' AND cd_quadra_fiscal='${quadra}' AND cd_lote='${lote}'`);
    const path = `/geosampa/ows?service=WFS&version=2.0.0&request=GetFeature&typeName=geoportal:geo_lote_territorial&count=5&outputFormat=application/json&srsName=EPSG:4326&CQL_FILTER=${cql}`;
    const geoHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Referer':    'https://geosampa.prefeitura.sp.gov.br/PaginasPublicas/_SBC.aspx',
      'Accept':     'application/json, */*',
    };
    const reply = data => { res.writeHead(200,{'Content-Type':'application/json;charset=utf-8','Access-Control-Allow-Origin':'*'}); res.end(data); };
    const opts = { hostname:'wms.geosampa.prefeitura.sp.gov.br', path, method:'GET', headers:geoHeaders, rejectUnauthorized:false };

    // Mesmo problema do /api/geosampa-setor-quadra: o GeoSampa falha/demora de
    // forma intermitente. Esse endpoint é chamado individualmente por lote
    // (ex: zoneamento automático de cada lote adicionado) — sem retry, uma
    // falha passageira do GeoSampa vira erro 500 visível pra pessoa mesmo
    // quando bastaria tentar de novo.
    const MAX_TENTATIVAS = 3;
    const tentar = (n) => {
      const preq = https.request(opts, pres => {
        let data = '';
        pres.on('data', c => data += c);
        pres.on('end', () => {
          console.log(`[sql-geom] ${setor}.${quadra}.${lote} tentativa=${n} status=${pres.statusCode} bytes=${data.length}`);
          if (pres.statusCode === 200) reply(data);
          else if (n < MAX_TENTATIVAS) setTimeout(() => tentar(n + 1), 700 * n);
          else { res.writeHead(500); res.end(JSON.stringify({error:`GeoSampa status ${pres.statusCode} (após ${n} tentativas)`})); }
        });
      });
      preq.setTimeout(15000, () => preq.destroy(new Error('timeout GeoSampa')));
      preq.on('error', e => {
        console.log(`[sql-geom] ${setor}.${quadra}.${lote} tentativa=${n} erro=${e.message}`);
        if (n < MAX_TENTATIVAS) setTimeout(() => tentar(n + 1), 700 * n);
        else { res.writeHead(500); res.end(JSON.stringify({error:`${e.message} (após ${n} tentativas)`})); }
      });
      preq.end();
    };
    tentar(1);
    return;
  }

  // ── API: busca todos os lotes de um Setor+Quadra via CQL_FILTER (sem lote) ──
  if (req.url && req.url.startsWith('/api/geosampa-setor-quadra')) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const qs = new URL(req.url, 'http://localhost').searchParams;
    const setor = (qs.get('setor')||'').replace(/\D/g,'').padStart(3,'0');
    const quadra = (qs.get('quadra')||'').replace(/\D/g,'').padStart(3,'0');
    if (!setor || !quadra) { res.writeHead(400); res.end(JSON.stringify({error:'setor/quadra obrigatórios'})); return; }

    const cql = encodeURIComponent(`cd_setor_fiscal='${setor}' AND cd_quadra_fiscal='${quadra}'`);
    const path = `/geosampa/ows?service=WFS&version=2.0.0&request=GetFeature&typeName=geoportal:geo_lote_territorial&count=300&outputFormat=application/json&srsName=EPSG:4326&CQL_FILTER=${cql}`;
    const geoHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Referer':    'https://geosampa.prefeitura.sp.gov.br/PaginasPublicas/_SBC.aspx',
      'Accept':     'application/json, */*',
    };
    const reply = data => { res.writeHead(200,{'Content-Type':'application/json;charset=utf-8','Access-Control-Allow-Origin':'*'}); res.end(data); };
    const opts = { hostname:'wms.geosampa.prefeitura.sp.gov.br', path, method:'GET', headers:geoHeaders, rejectUnauthorized:false };

    // GeoSampa às vezes falha/timeout de forma intermitente — tenta até 3x
    // com pequeno atraso antes de desistir, em vez de estourar 500 na primeira falha.
    const MAX_TENTATIVAS = 3;
    const tentar = (n) => {
      const preq = https.request(opts, pres => {
        let data = '';
        pres.on('data', c => data += c);
        pres.on('end', () => {
          console.log(`[setor-quadra] ${setor}.${quadra} tentativa=${n} status=${pres.statusCode} bytes=${data.length}`);
          if (pres.statusCode === 200) reply(data);
          else if (n < MAX_TENTATIVAS) setTimeout(() => tentar(n + 1), 700 * n);
          else { res.writeHead(500); res.end(JSON.stringify({error:`GeoSampa status ${pres.statusCode} (após ${n} tentativas)`})); }
        });
      });
      preq.setTimeout(15000, () => preq.destroy(new Error('timeout GeoSampa')));
      preq.on('error', e => {
        console.log(`[setor-quadra] ${setor}.${quadra} tentativa=${n} erro=${e.message}`);
        if (n < MAX_TENTATIVAS) setTimeout(() => tentar(n + 1), 700 * n);
        else { res.writeHead(500); res.end(JSON.stringify({error:`${e.message} (após ${n} tentativas)`})); }
      });
      preq.end();
    };
    tentar(1);
    return;
  }

  // ── API: valores de PGV por RUA (codlog) dentro de um Setor+Quadra ─────────
  // O Quadro 14 (Cadastro de Valor de Terreno) tem, na verdade, um valor por
  // rua (codlog) dentro de cada Setor/Quadra — não um valor único. O arquivo
  // `pgv_data.js` usado no front (busca "rápida", com o maior valor da
  // quadra) é derivado deste aqui, mas colapsado. Esse endpoint devolve a
  // lista completa (todos os codlogs + valores) pra deixar quem está usando
  // o Estudo de Massa escolher a rua correta — o terreno pode não fazer
  // frente pra todas as ruas da quadra, então pegar sempre o maior valor
  // pode superestimar a outorga.
  if (req.url && req.url.startsWith('/api/pgv-codlogs')) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const qs = new URL(req.url, 'http://localhost').searchParams;
    const setor = (qs.get('setor')||'').replace(/\D/g,'').padStart(3,'0');
    const quadra = (qs.get('quadra')||'').replace(/\D/g,'').padStart(3,'0');
    if (!setor || !quadra) { res.writeHead(400); res.end(JSON.stringify({error:'setor/quadra obrigatórios'})); return; }
    try {
      const tabela = _carregarPgvPorCodlog();
      const lista = tabela[setor+quadra] || [];
      res.writeHead(200, {'Content-Type':'application/json;charset=utf-8'});
      res.end(JSON.stringify(lista));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({error:e.message}));
    }
    return;
  }

  // ── API: proxy WFS GeoSampa (para geometrias de lotes) ───────────────────────
  if (req.url && req.url.startsWith('/api/proxy-wfs')) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const qs = new URL(req.url, 'http://localhost').searchParams;
    const targetUrl = qs.get('url');
    if (!targetUrl || !targetUrl.startsWith('https://geosampa.prefeitura.sp.gov.br/')) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'url inválida' })); return;
    }
    const parsed = new URL(targetUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Referer': 'https://geosampa.prefeitura.sp.gov.br/PaginasPublicas/_SBC.aspx',
        'Origin': 'https://geosampa.prefeitura.sp.gov.br',
      },
    };
    const preq = https.request(options, pres => {
      let data = '';
      pres.on('data', d => data += d);
      pres.on('end', () => {
        res.writeHead(pres.statusCode, {
          'Content-Type': pres.headers['content-type'] || 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(data);
      });
    });
    preq.on('error', e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    preq.end();
    return;
  }

  // ── API: geocoding proxy (Nominatim) ─────────────────────────────────────────
  // ── API: extrair dados de terreno via IA (Anthropic) — chave fica só aqui,
  // nunca no index.html. Requer anthropic_config.json (ver .example) preenchido.
  if (req.url === '/api/extrair-terreno' && req.method === 'POST') {
    cors(res);
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'JSON inválido' }));
        return;
      }

      // Em host cloud a chave normalmente vem de variável de ambiente
      // (ANTHROPIC_API_KEY, configurada no painel do host); localmente
      // continua caindo no anthropic_config.json de sempre.
      let apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        const configPath = path.join(DIR, 'anthropic_config.json');
        let config;
        try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Chave da Anthropic não configurada. Defina a variável de ambiente ANTHROPIC_API_KEY (host na nuvem) ou copie anthropic_config.example.json para anthropic_config.json e preencha a chave (servidor local).' }));
          return;
        }
        apiKey = config.api_key;
      }
      if (!apiKey || apiKey === 'SUA_CHAVE_AQUI') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Chave da Anthropic não configurada em anthropic_config.json' }));
        return;
      }

      const PROMPT_TERRENO = 'Extraia deste texto/print de terreno: endereço, bairro, área em m², corretor, zoneamento. Responda APENAS em JSON: {"endereco":"","bairro":"","area":"","corretor":"","zoneamento":"","status":"5.Frio","obs":"","todo":""}. Use string vazia se não encontrar.';

      let content;
      if (payload.tipo === 'imagem' && payload.imagem_base64) {
        content = [
          { type: 'image', source: { type: 'base64', media_type: payload.media_type || 'image/png', data: payload.imagem_base64 } },
          { type: 'text', text: PROMPT_TERRENO }
        ];
      } else if (payload.tipo === 'texto' && payload.texto) {
        content = PROMPT_TERRENO + '\n\nTexto:\n' + String(payload.texto).slice(0, 2000);
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Parâmetros inválidos (tipo/imagem_base64/texto)' }));
        return;
      }

      const anthropicBody = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{ role: 'user', content }]
      });

      const anthReq = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(anthropicBody)
        }
      }, (aRes) => {
        let out = '';
        aRes.on('data', d => out += d);
        aRes.on('end', () => {
          if (aRes.statusCode !== 200) {
            console.log('[extrair-terreno] Anthropic status=' + aRes.statusCode + ' body=' + out.slice(0, 300));
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Anthropic respondeu ' + aRes.statusCode + ' — confira a chave em anthropic_config.json' }));
            return;
          }
          try {
            const d = JSON.parse(out);
            const txt = (d.content && d.content[0] && d.content[0].text) || '{}';
            const match = txt.match(/\{[\s\S]*\}/);
            const parsed = JSON.parse(match ? match[0] : '{}');
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, parsed }));
          } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Erro ao interpretar resposta da IA: ' + e.message }));
          }
        });
      });
      anthReq.on('error', e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      });
      anthReq.write(anthropicBody);
      anthReq.end();
    });
    return;
  }

  // ── API: avisa o app se uma nova versão do servidor.js já foi baixada e
  // está esperando um restart pra valer (ver _autoAtualizarServidorJs acima).
  if (req.url === '/api/versao') {
    cors(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, atualizacaoPendente: _servidorAtualizadoPendente }));
    return;
  }

  if (req.url && req.url.startsWith('/api/geocode')) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const qs = new URL(req.url, 'http://localhost').searchParams;
    const q  = qs.get('q') || '';
    const limit = (qs.get('limit')||'1').replace(/\D/g,'') || '1';
    if (!q) { res.writeHead(400); res.end(JSON.stringify({error:'q param required'})); return; }
    const nomUrl = 'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(q) + '&format=json&limit=' + limit + '&accept-language=pt-BR';
    https.get(nomUrl, { headers: { 'User-Agent': 'YUNY-LandBank/1.0' } }, (nr) => {
      let data = '';
      nr.on('data', d => data += d);
      nr.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(data);
      });
    }).on('error', e => {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }

  // ── API: cache PERSISTENTE de geocodificação da Pesquisa de Mercado ────────
  // GET  /api/mercado/geocode-cache        → devolve o cache inteiro (nome|bairro → [lat,lng]|null)
  // POST /api/mercado/geocode-item         → geocodifica 1 item (se não tiver no cache) e já salva
  // POST /api/mercado/geocode-batch        → dispara o job em background pra TODOS os anos
  // GET  /api/mercado/geocode-batch/status → polling do progresso do batch
  if (req.url === '/api/mercado/geocode-cache' && req.method === 'GET') {
    cors(res);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(_lerGeocodeMercCache()));
    return;
  }

  if (req.url === '/api/mercado/geocode-item' && req.method === 'POST') {
    cors(res);
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); }
      catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: 'JSON inválido' })); return; }
      const nome = (body.nome || '').trim();
      const bairro = (body.bairro || '').trim();
      const key = nome + '|' + bairro;
      const cache = _lerGeocodeMercCache();
      if (cache[key] !== undefined) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ coord: cache[key], cached: true }));
        return;
      }
      const geo = await _geocodeMercItem(nome, bairro);
      const coord = geo ? [geo.lat, geo.lng] : null;
      cache[key] = coord;
      _salvarGeocodeMercCache(cache);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ coord, cached: false }));
    });
    return;
  }

  if (req.url === '/api/mercado/geocode-batch/status' && req.method === 'GET') {
    cors(res);
    fs.readFile(GEOCODE_MERC_STATUS_PATH, 'utf8', (err, data) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (err) { res.end(JSON.stringify({ processing: false })); return; }
      try { JSON.parse(data); res.end(data); } catch { res.end(JSON.stringify({ processing: false })); }
    });
    return;
  }

  if (req.url === '/api/mercado/geocode-batch' && req.method === 'POST') {
    cors(res);
    if (_geocodeMercRunning) {
      res.writeHead(409); res.end(JSON.stringify({ ok: false, error: 'Já existe uma geocodificação em andamento — acompanhe em /api/mercado/geocode-batch/status.' }));
      return;
    }
    _listarItensParaGeocode((err, itens) => {
      if (err) {
        res.writeHead(500); res.end(JSON.stringify({ ok: false, error: err.message }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, started: true, total: itens.length, message: 'Geocodificação iniciada em background. Acompanhe via /api/mercado/geocode-batch/status' }));
      _rodarGeocodeBatchMercado(itens); // não aguarda — roda em background, sem segurar a resposta HTTP
    });
    return;
  }

  // ── API: importar relatório "Pesquisa de Mercado" do geoimovel.dataland.ai ──
  // O merge no Excel mestre (~20 mil linhas) pode levar 1-2 minutos, então roda
  // em background (mesmo padrão do /api/itbi/processar) — o frontend faz
  // polling via /api/mercado/importar-geoimovel/status até processing:false.
  const MERCADO_IMPORT_STATUS_PATH = path.join(DIR, 'mercado_import_status.json');

  if (req.url === '/api/mercado/importar-geoimovel/status' && req.method === 'GET') {
    cors(res);
    fs.readFile(MERCADO_IMPORT_STATUS_PATH, 'utf8', (err, data) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (err) { res.end(JSON.stringify({ processing: false })); return; }
      try { JSON.parse(data); res.end(data); } catch { res.end(JSON.stringify({ processing: false })); }
    });
    return;
  }

  if (req.url === '/api/mercado/importar-geoimovel' && req.method === 'POST') {
    cors(res);
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); }
      catch(e) { cors(res); res.writeHead(400); res.end(JSON.stringify({ ok:false, error:'JSON inválido' })); return; }

      const raw = String(body.arquivo_base64 || '');
      const b64 = raw.includes(',') ? raw.split(',').pop() : raw;
      if (!b64) { cors(res); res.writeHead(400); res.end(JSON.stringify({ ok:false, error:'arquivo_base64 obrigatório' })); return; }

      try {
        const atual = JSON.parse(fs.readFileSync(MERCADO_IMPORT_STATUS_PATH, 'utf8'));
        if (atual.processing) { cors(res); res.writeHead(409); res.end(JSON.stringify({ ok:false, error:'Já existe uma importação em andamento — aguarde terminar.' })); return; }
      } catch(e) { /* sem status anterior, segue normal */ }

      const tmpDir = path.join(DIR, 'tmp_uploads');
      try { fs.mkdirSync(tmpDir, { recursive: true }); } catch(e) {}
      const tmpPath = path.join(tmpDir, 'geoimovel_import_' + Date.now() + '.xlsx');
      try { fs.writeFileSync(tmpPath, Buffer.from(b64, 'base64')); }
      catch(e) { cors(res); res.writeHead(500); res.end(JSON.stringify({ ok:false, error:'Falha ao salvar arquivo: ' + e.message })); return; }

      try { fs.writeFileSync(MERCADO_IMPORT_STATUS_PATH, JSON.stringify({ processing: true, started_at: new Date().toISOString() })); } catch(e) {}

      const meses = String(parseInt(body.meses_recentes, 10) || 12);
      const script = path.join(DIR, 'importar_geoimovel.py');
      let out = '', err2 = '';
      const py = spawn(PY_CMD, [script, tmpPath, PESQUISA_EXCEL, meses], { windowsHide: true, cwd: DIR });
      py.stdout.on('data', d => out += d);
      py.stderr.on('data', d => err2 += d);
      py.on('close', code => {
        try { fs.unlinkSync(tmpPath); } catch(e) {}
        let result;
        if (code !== 0 || !out.trim()) {
          console.error('[importar-geoimovel] erro:', err2.slice(0,500));
          result = { ok:false, processing:false, error: err2.slice(0,500) || ('Script falhou (código '+code+')'), finished_at: new Date().toISOString() };
        } else {
          try {
            const parsed = JSON.parse(out.trim());
            result = Object.assign({ processing:false, finished_at: new Date().toISOString() }, parsed);
          } catch(e) {
            result = { ok:false, processing:false, error: 'Resposta inválida do script de importação', finished_at: new Date().toISOString() };
          }
        }
        try { fs.writeFileSync(MERCADO_IMPORT_STATUS_PATH, JSON.stringify(result)); } catch(e) {}
        console.log('[importar-geoimovel] finalizado, código ' + code);
      });
      py.on('error', e => {
        try { fs.unlinkSync(tmpPath); } catch(e2) {}
        try { fs.writeFileSync(MERCADO_IMPORT_STATUS_PATH, JSON.stringify({ ok:false, processing:false, error: e.message, finished_at: new Date().toISOString() })); } catch(e2) {}
      });

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok:true, started:true, message:'Importação iniciada. Acompanhe via /api/mercado/importar-geoimovel/status' }));
    });
    return;
  }

  // ── API: pesquisa de mercado SP ──────────────────────────────────────────
  if (req.url === '/api/pesquisa-mercado') {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // Verifica se o Excel OU o script de processamento mudaram desde o último cache
    // (inclui o script pra não servir dado velho depois de uma atualização do
    // processar_pesquisa.py enquanto o servidor continua rodando, sem precisar reiniciar)
    let excelMtime = 0, scriptMtime = 0;
    try { excelMtime = fs.statSync(PESQUISA_EXCEL).mtimeMs; } catch(e) {}
    try { scriptMtime = fs.statSync(path.join(DIR, 'processar_pesquisa.py')).mtimeMs; } catch(e) {}
    const _pesquisaCacheKey = excelMtime + '|' + scriptMtime;
    if (_pesquisaCache && _pesquisaCache.mtime === _pesquisaCacheKey && _pesquisaCache.data) {
      console.log('[pesquisa] servindo do cache (Excel inalterado)');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'HIT' });
      res.end(_pesquisaCache.data);
      return;
    }

    console.log('[pesquisa] processando Excel (pode levar ~20s)…');
    const pyCmd  = process.platform === 'win32' ? 'py' : 'python3';
    const script = path.join(DIR, 'processar_pesquisa.py');
    let out = '', err2 = '';
    const py = spawn(pyCmd, [script], { windowsHide: true });
    py.stdout.on('data', d => out += d);
    py.stderr.on('data', d => err2 += d);
    py.on('close', code => {
      cors(res);
      if (code !== 0 || !out.trim()) {
        console.error('[pesquisa] erro:', err2.slice(0,300));
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err2.slice(0,500) || 'Script falhou (código '+code+')' }));
        return;
      }
      // Salvar no cache
      _pesquisaCache = { data: out.trim(), mtime: _pesquisaCacheKey };
      console.log('[pesquisa] processado e cacheado (' + Math.round(out.length/1024) + ' KB)');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'MISS' });
      res.end(out.trim());
    });
    py.on('error', e => {
      cors(res);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    });
    return;
  }

  // ── API: proxy de imagem (evita bloqueio de hotlink, segue redirects) ──────
  if (req.url && req.url.startsWith('/api/img-proxy')) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const imgUrl = new URL(req.url, 'http://localhost').searchParams.get('url');
    if (!imgUrl) { res.writeHead(400); res.end('url param required'); return; }

    function fetchImg(url, hops) {
      if (hops > 6) { res.writeHead(502); res.end('Too many redirects'); return; }
      let parsed;
      try { parsed = new URL(url); } catch(e) { res.writeHead(400); res.end('Bad URL'); return; }
      const lib = parsed.protocol === 'https:' ? https : http;
      lib.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': parsed.origin + '/',
          'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        }
      }, (ir) => {
        // Seguir redirect
        if ([301,302,303,307,308].includes(ir.statusCode) && ir.headers.location) {
          ir.resume();
          const next = ir.headers.location.startsWith('http')
            ? ir.headers.location
            : new URL(ir.headers.location, url).href;
          return fetchImg(next, hops + 1);
        }
        const ct = ir.headers['content-type'] || 'image/jpeg';
        if (!res.headersSent) {
          res.writeHead(ir.statusCode === 200 ? 200 : 404, {
            'Content-Type': ct,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=86400',
          });
        }
        ir.pipe(res);
      }).on('error', e => {
        if (!res.headersSent) { res.writeHead(502); res.end('Proxy error: ' + e.message); }
      });
    }
    fetchImg(imgUrl, 0);
    return;
  }

  // ── API: ITBI ─────────────────────────────────────────────────────────────
  if (req.url && req.url.startsWith('/api/itbi')) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const itbiUrl = new URL(req.url, 'http://localhost');
    const itbiPath = itbiUrl.pathname; // /api/itbi, /api/itbi/status, /api/itbi/processar

    // GET /api/itbi/status — lê itbi_status.json diretamente (sem spawnar Python)
    if (itbiPath === '/api/itbi/status') {
      const statusPath = path.join(DIR, 'itbi_status.json');
      fs.readFile(statusPath, 'utf8', (err, data) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        if (err) {
          res.end(JSON.stringify({ ok: false, db_exists: false, db_rows: 0, processing: false }));
        } else {
          try {
            const s = JSON.parse(data);
            s.db_exists = fs.existsSync(path.join(DIR, 'itbi.db'));
            res.end(JSON.stringify(s));
          } catch {
            res.end(JSON.stringify({ ok: false, db_exists: false, db_rows: 0, processing: false }));
          }
        }
      });
      return;
    }

    // GET /api/itbi?sql=XXX (&exact=1 pra restringir ao lote específico, sem
    // agrupar condomínio/quadra — usado pela camada "Mapa de Preços")
    if (itbiPath === '/api/itbi' && req.method === 'GET') {
      const sqlParam = itbiUrl.searchParams.get('sql') || '';
      const exactParam = itbiUrl.searchParams.get('exact');
      if (!sqlParam) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'sql param required' })); return; }
      const pyArgs = [path.join(DIR, 'processar_itbi.py'), '--query-sql', sqlParam];
      if (exactParam) pyArgs.push('--exact');
      const py = spawn(PY_CMD, pyArgs, { windowsHide: true });
      let out = '';
      py.stdout.on('data', d => out += d);
      py.on('close', () => {
        const last = out.trim().split('\n').pop();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        try { JSON.parse(last); res.end(last); } catch { res.end(JSON.stringify({ ok: false, rows: [] })); }
      });
      py.on('error', e => { res.writeHead(500); res.end(JSON.stringify({ ok: false, rows: [], error: e.message })); });
      return;
    }

    // POST /api/itbi/batch — consulta múltiplos SQLs de uma vez (para Prospecção)
    if (itbiPath === '/api/itbi/batch' && req.method === 'POST') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        let sqls = [];
        try { sqls = JSON.parse(Buffer.concat(chunks).toString()).sqls || []; } catch {}
        if (!sqls.length) { res.writeHead(200); res.end(JSON.stringify({})); return; }
        const py = spawn(PY_CMD, [path.join(DIR, 'processar_itbi.py'), '--batch-sql', JSON.stringify(sqls)], { windowsHide: true });
        let out = '';
        py.stdout.on('data', d => out += d);
        py.on('close', () => {
          const last = out.trim().split('\n').pop();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          try { const parsed = JSON.parse(last); res.end(JSON.stringify(parsed.result || {})); }
          catch { res.end(JSON.stringify({})); }
        });
        py.on('error', () => { res.writeHead(500); res.end(JSON.stringify({})); });
      });
      return;
    }

    // POST /api/itbi/mapa-precos — mediana de R$/m² por lote, para a camada
    // "Mapa de Preços (ITBI)" do mapa principal (colorir lotes por preço real)
    if (itbiPath === '/api/itbi/mapa-precos' && req.method === 'POST') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        let sqls = [];
        try { sqls = JSON.parse(Buffer.concat(chunks).toString()).sqls || []; } catch {}
        if (!sqls.length) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: true, result: {} })); return; }
        const py = spawn(PY_CMD, [path.join(DIR, 'processar_itbi.py'), '--mapa-precos', JSON.stringify(sqls)], { windowsHide: true });
        let out = '';
        py.stdout.on('data', d => out += d);
        py.on('close', () => {
          const last = out.trim().split('\n').pop();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          try { const parsed = JSON.parse(last); res.end(JSON.stringify(parsed)); }
          catch { res.end(JSON.stringify({ ok: false, result: {} })); }
        });
        py.on('error', () => { res.writeHead(500); res.end(JSON.stringify({ ok: false, result: {} })); });
      });
      return;
    }

    // POST /api/itbi/processar?anos=2022,2023,2024,2025,2026
    if (itbiPath === '/api/itbi/processar' && req.method === 'POST') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        let anos = '2022,2023,2024,2025,2026';
        let soLocal = false;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          if (body.anos) anos = body.anos;
          if (body.so_local) soLocal = true;
        } catch {}
        const pyArgs = soLocal
          ? [path.join(DIR, 'processar_itbi.py'), '--so-local']
          : [path.join(DIR, 'processar_itbi.py'), '--anos', anos];
        // Roda em background — retorna imediatamente, frontend faz polling via /api/itbi/status
        const py = spawn(PY_CMD, pyArgs, { windowsHide: true });
        py.stdout.on('data', d => process.stdout.write(d));
        py.stderr.on('data', d => process.stderr.write(d));
        py.on('close', code => console.log(`[itbi/processar] Python saiu com código ${code}`));
        py.on('error', e => console.error('[itbi/processar] Erro:', e.message));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, started: true, message: 'Processamento iniciado. Acompanhe via /api/itbi/status' }));
      });
      return;
    }

    res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // ── Scraper HTML VivaReal (fallback quando glue-api bloqueia) ───────────────
  // VR embute todos os listings no __NEXT_DATA__ da página HTML
  function _scrapeVRPage(latMin, lngMin, latMax, lngMax, mLat, mLng, sendResult) {
    const viewport = encodeURIComponent(`${latMin},${lngMin},${latMax},${lngMax}`);
    const pageOpts = {
      hostname: 'www.vivareal.com.br',
      path: `/venda/sp/sao-paulo/?__vt=vb&viewport=${viewport}&business=SALE&listingType=USED,DEVELOPMENT&size=48`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'max-age=0',
        'Referer': 'https://www.google.com.br/',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1',
      },
    };
    const req = https.request(pageOpts, res => {
      _decodeResponse(res, (err, body) => {
        console.log('[avenda-scrape] VR page status=' + res.statusCode + ' body_len=' + (body||'').length);
        if (err || res.statusCode >= 400) {
          _scrapeZAPPage(latMin, lngMin, latMax, lngMax, mLat, mLng, sendResult);
          return;
        }
        try {
          // Extrai __NEXT_DATA__ do HTML
          const m = body.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
          if (!m) throw new Error('__NEXT_DATA__ não encontrado');
          const nextData = JSON.parse(m[1]);
          // Caminho pode variar por versão do Next.js
          const pp = nextData?.props?.pageProps || {};
          const listingsArr =
            pp?.initialState?.listings?.listings ||
            pp?.search?.result?.listings ||
            pp?.listings?.listings ||
            [];
          console.log('[avenda-scrape] VR __NEXT_DATA__ listings=' + listingsArr.length);
          const markers = _parseListings(listingsArr, 'VivaReal', '#00a884', _vrUrl);
          if (markers.length > 0) { sendResult(markers, 'vivareal_scrape'); return; }
        } catch(e) {
          console.log('[avenda-scrape] VR parse err:', e.message);
        }
        _scrapeZAPPage(latMin, lngMin, latMax, lngMax, mLat, mLng, sendResult);
      });
    });
    req.on('error', e => { console.log('[avenda-scrape] VR conn err:', e.message); _scrapeZAPPage(latMin, lngMin, latMax, lngMax, mLat, mLng, sendResult); });
    req.setTimeout(15000, () => { req.destroy(); _scrapeZAPPage(latMin, lngMin, latMax, lngMax, mLat, mLng, sendResult); });
    req.end();
  }

  function _scrapeZAPPage(latMin, lngMin, latMax, lngMax, mLat, mLng, sendResult) {
    const viewport = encodeURIComponent(`${latMin},${lngMin},${latMax},${lngMax}`);
    const pageOpts = {
      hostname: 'www.zapimoveis.com.br',
      path: `/venda/imoveis/sp+sao-paulo/?__vt=vb&viewport=${viewport}&business=SALE`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://www.google.com.br/',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'cross-site',
      },
    };
    const req = https.request(pageOpts, res => {
      _decodeResponse(res, (err, body) => {
        console.log('[avenda-scrape] ZAP page status=' + res.statusCode + ' body_len=' + (body||'').length);
        if (!err && res.statusCode < 400) {
          try {
            const m = body.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
            if (m) {
              const nextData = JSON.parse(m[1]);
              const pp = nextData?.props?.pageProps || {};
              const listingsArr =
                pp?.initialState?.listings?.listings ||
                pp?.search?.result?.listings ||
                pp?.listings?.listings ||
                [];
              console.log('[avenda-scrape] ZAP __NEXT_DATA__ listings=' + listingsArr.length);
              const markers = _parseListings(listingsArr, 'ZAP Imóveis', '#003da5', _zapUrl);
              if (markers.length > 0) { sendResult(markers, 'zap_scrape'); return; }
            }
          } catch(e) { console.log('[avenda-scrape] ZAP parse err:', e.message); }
        }
        _tryQuintoAndar(latMin,lngMin,latMax,lngMax,(m,f) => { if(m.length>0){sendResult(m,f);}else{_avendaLinksOnly(latMin,lngMin,latMax,lngMax,mLat,mLng,sendResult);} });
      });
    });
    req.on('error', () => _tryQuintoAndar(latMin,lngMin,latMax,lngMax,(m,f) => { if(m.length>0){sendResult(m,f);}else{_avendaLinksOnly(latMin,lngMin,latMax,lngMax,mLat,mLng,sendResult);} }));
    req.setTimeout(15000, () => { req.destroy(); _tryQuintoAndar(latMin,lngMin,latMax,lngMax,(m,f) => { if(m.length>0){sendResult(m,f);}else{_avendaLinksOnly(latMin,lngMin,latMax,lngMax,mLat,mLng,sendResult);} }); });
    req.end();
  }

  // ── QuintoAndar API ─────────────────────────────────────────────────────────
  function _tryQuintoAndar(latMin, lngMin, latMax, lngMax, cb) {
    // Tenta a API de busca do QuintoAndar (POST JSON)
    const body = JSON.stringify({
      filters: {
        mapBounds: { north: parseFloat(latMax), south: parseFloat(latMin), east: parseFloat(lngMax), west: parseFloat(lngMin) },
        listingType: ['USED', 'DEVELOPMENT']
      },
      pagination: { currentPage: 0, pageSize: 60 },
      sort: 'RELEVANCE'
    });
    const qaOpts = {
      hostname: 'www.quintoandar.com.br',
      path: '/api/buying-search/v2/properties',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Origin': 'https://www.quintoandar.com.br',
        'Referer': 'https://www.quintoandar.com.br/comprar/imovel/sao-paulo-sp-brasil',
        'x-quintoandar-env': 'production',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
      }
    };
    const qaReq = https.request(qaOpts, qaRes => {
      _decodeResponse(qaRes, (err, qaBody) => {
        console.log('[avenda-qa] POST status=' + qaRes.statusCode + ' len=' + (qaBody||'').length + ' preview=' + (qaBody||'').slice(0,200));
        if (err || qaRes.statusCode >= 400) { _scrapeQuintoAndar(latMin,lngMin,latMax,lngMax,cb); return; }
        try {
          const data = JSON.parse(qaBody);
          // Tenta diferentes paths de resposta
          const items = data?.items || data?.data?.items || data?.properties || data?.listings || [];
          const markers = _parseQAListings(items);
          console.log('[avenda-qa] POST markers=' + markers.length);
          if (markers.length > 0) { cb(markers, 'quintoandar_api'); return; }
        } catch(e) { console.log('[avenda-qa] POST parse err:', e.message); }
        _scrapeQuintoAndar(latMin,lngMin,latMax,lngMax,cb);
      });
    });
    qaReq.on('error', e => { console.log('[avenda-qa] POST err:', e.message); _scrapeQuintoAndar(latMin,lngMin,latMax,lngMax,cb); });
    qaReq.setTimeout(12000, () => { qaReq.destroy(); _scrapeQuintoAndar(latMin,lngMin,latMax,lngMax,cb); });
    qaReq.write(body);
    qaReq.end();
  }

  function _scrapeQuintoAndar(latMin, lngMin, latMax, lngMax, cb) {
    // Scrape da página HTML do QuintoAndar com bbox
    const qaPath = `/comprar/imovel/sao-paulo-sp-brasil?north=${latMax}&south=${latMin}&east=${lngMax}&west=${lngMin}`;
    const qaPageOpts = {
      hostname: 'www.quintoandar.com.br',
      path: qaPath,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://www.google.com.br/',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'cross-site',
        'upgrade-insecure-requests': '1',
      }
    };
    const qaPageReq = https.request(qaPageOpts, qaPageRes => {
      _decodeResponse(qaPageRes, (err, body) => {
        console.log('[avenda-qa] scrape status=' + qaPageRes.statusCode + ' len=' + (body||'').length);
        if (err || qaPageRes.statusCode >= 400) { cb([], 'qa_scrape_err'); return; }
        try {
          // Tenta __NEXT_DATA__
          const m = body.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
          if (m) {
            const nd = JSON.parse(m[1]);
            const pp = nd?.props?.pageProps || {};
            const items =
              pp?.initialProps?.properties ||
              pp?.initialState?.search?.items ||
              pp?.search?.result?.items ||
              pp?.properties ||
              pp?.listings ||
              [];
            if (items.length > 0) {
              const markers = _parseQAListings(items);
              console.log('[avenda-qa] __NEXT_DATA__ markers=' + markers.length);
              if (markers.length > 0) { cb(markers, 'quintoandar_scrape'); return; }
            }
          }
          // Tenta window.__PRELOADED_STATE__
          const stateM = body.match(/window\.__PRELOADED_STATE__\s*=\s*({[\s\S]*?});\s*<\/script>/);
          if (stateM) {
            const state = JSON.parse(stateM[1]);
            const items = state?.search?.result?.items || state?.properties || [];
            const markers = _parseQAListings(items);
            console.log('[avenda-qa] PRELOADED_STATE markers=' + markers.length);
            if (markers.length > 0) { cb(markers, 'quintoandar_state'); return; }
          }
        } catch(e) { console.log('[avenda-qa] scrape parse err:', e.message); }
        cb([], 'qa_scrape_empty');
      });
    });
    qaPageReq.on('error', e => { console.log('[avenda-qa] scrape conn err:', e.message); cb([], 'qa_conn_err'); });
    qaPageReq.setTimeout(15000, () => { qaPageReq.destroy(); cb([], 'qa_timeout'); });
    qaPageReq.end();
  }

  // Parse de listagens no formato QuintoAndar — só entra no mapa quem tiver
  // rua E número completos (endereço só com bairro não é preciso o bastante
  // pra identificar o imóvel num lote específico do mapa).
  function _parseQAListings(items) {
    return (items || []).map(item => {
      // QuintoAndar usa diferentes estruturas dependendo da versão da API
      const addr = item.address || {};
      const lat = item.lat || item.latitude || addr.lat || item.location?.lat;
      const lng = item.lng || item.longitude || addr.lng || item.location?.lng || addr.lon || item.location?.lon;
      if (!lat || !lng) return null;
      const rua    = addr.street || item.street || '';
      const numero = addr.streetNumber || addr.number || addr.houseNumber
                   || item.streetNumber || item.number || item.houseNumber || '';
      if (!rua || !numero) return null;
      const endereco = `${rua}, ${numero}`;
      const preco = item.totalCost || item.price || item.salePrice || item.sellPrice;
      const precoFmt = preco ? 'R$ ' + parseInt(preco).toLocaleString('pt-BR') : null;
      const area = item.area || item.usableArea || item.totalArea;
      const bairro = addr.neighborhood || item.neighborhood || item.region || '';
      const foto = item.coverImage || item.image || item.images?.[0] || item.photos?.[0]?.url || null;
      const quartos = item.bedrooms || item.rooms || null;
      const vagas = item.parkingSpaces || item.garages || null;
      const id = item.id || item.listing_id || '';
      const url = id ? 'https://www.quintoandar.com.br/imovel/' + id : 'https://www.quintoandar.com.br/comprar/imovel/sao-paulo-sp-brasil';
      return {
        lat: parseFloat(lat), lng: parseFloat(lng),
        titulo: endereco,
        endereco,
        preco: precoFmt,
        area: area ? area + ' m²' : null,
        bairro, foto,
        quartos, vagas,
        url,
        plataforma: 'quintoandar',
        plat_nome: 'QuintoAndar',
        plat_cor: '#e8175d',
        fonte: 'api'
      };
    }).filter(Boolean);
  }

  function _avendaDuckFallback(latMin, lngMin, latMax, lngMax, mLat, mLng, sendResult) {
    // Cadeia: VR scrape → ZAP scrape → QuintoAndar → links
    _scrapeVRPage(latMin, lngMin, latMax, lngMax, mLat, mLng, (markers, fonte) => {
      if (markers && markers.length > 0) { sendResult(markers, fonte); return; }
      _tryQuintoAndar(latMin, lngMin, latMax, lngMax, (qaMarkers, qaFonte) => {
        if (qaMarkers && qaMarkers.length > 0) { sendResult(qaMarkers, qaFonte); return; }
        _avendaLinksOnly(latMin, lngMin, latMax, lngMax, mLat, mLng, sendResult);
      });
    });
  }

  function _avendaLinksOnly(latMin, lngMin, latMax, lngMax, lat, lng, sendResult) {
    function _slugify(s){
      return (s || '').toString()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    }

    function _montarLinks(bairro){
      const bairroSlug = _slugify(bairro);
      // QuintoAndar aceita o padrão <bairro>-sao-paulo-sp-brasil na URL de busca (testado e confirmado).
      const qaUrl = bairroSlug
        ? `https://www.quintoandar.com.br/comprar/imovel/${bairroSlug}-sao-paulo-sp-brasil`
        : `https://www.quintoandar.com.br/comprar/imovel/sao-paulo-sp-brasil`;
      // VivaReal aceita /venda/sp/sao-paulo/bairros/<slug>/ (testado e confirmado).
      // O antigo formato com "viewport=" era inválido e o site devolvia uma página de erro
      // com coordenadas absurdas na URL.
      const vrUrl = bairroSlug
        ? `https://www.vivareal.com.br/venda/sp/sao-paulo/bairros/${bairroSlug}/`
        : `https://www.vivareal.com.br/venda/sp/sao-paulo/`;
      // OLX não tem parâmetro de área/bbox documentado — usamos busca por texto (q=bairro)
      // pra pelo menos restringir ao bairro, em vez de abrir a cidade toda (testado e confirmado).
      const olxUrl = bairro
        ? `https://www.olx.com.br/imoveis/estado-sp/sao-paulo-e-regiao?q=${encodeURIComponent(bairro)}`
        : `https://sp.olx.com.br/sao-paulo-e-regiao/imoveis/terrenos-e-lotes`;
      // ZAP exige zona+bairro (ex: sp+sao-paulo+zona-sul+moema) e não temos como
      // descobrir a zona com confiança — mantido no nível de cidade pra não quebrar o link.
      const zapUrl = `https://www.zapimoveis.com.br/venda/imoveis/sp+sao-paulo/`;
      const links = [
        { nome:'VivaReal',    cor:'#00a884', url: vrUrl },
        { nome:'ZAP Imóveis', cor:'#003366', url: zapUrl },
        { nome:'OLX',         cor:'#6e0ad6', url: olxUrl },
        { nome:'QuintoAndar', cor:'#e8175d', url: qaUrl },
      ];
      const marker = { lat, lng, titulo: 'Buscar imóveis nesta área', plataforma: 'links', plat_nome: 'Plataformas', fonte: 'links_only', links };
      console.log('[avenda] todos os métodos falharam → links' + (bairro ? ` (bairro: ${bairro})` : ''));
      sendResult([marker], 'links_only');
    }

    // Geocodificação reversa (Nominatim) pra descobrir o bairro do centro do mapa
    // e assim restringir os links do OLX/QuintoAndar (que não aceitam bbox na URL).
    const nomUrl = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=16&accept-language=pt-BR`;
    const reqTimeout = setTimeout(() => { try{ nomReq.destroy(); }catch(e){} _montarLinks(''); }, 4000);
    const nomReq = https.get(nomUrl, { headers: { 'User-Agent': 'YUNY-LandBank/1.0' } }, (nr) => {
      let data = '';
      nr.on('data', d => data += d);
      nr.on('end', () => {
        clearTimeout(reqTimeout);
        let bairro = '';
        try {
          const j = JSON.parse(data);
          bairro = (j.address && (j.address.suburb || j.address.neighbourhood || j.address.city_district)) || '';
        } catch(e){ console.log('[avenda-reverse] parse err:', e.message); }
        _montarLinks(bairro);
      });
    }).on('error', e => { clearTimeout(reqTimeout); console.log('[avenda-reverse] err:', e.message); _montarLinks(''); });
  }

  // ── API: À Venda / Debug — diagnóstico do que VR/ZAP retornam ─────────────
  if (req.url && req.url.startsWith('/api/avenda/debug')) {
    cors(res);
    const dbgUrl = new URL(req.url, 'http://localhost');
    const dLat = parseFloat(dbgUrl.searchParams.get('lat') || '-23.5692');
    const dLng = parseFloat(dbgUrl.searchParams.get('lng') || '-46.6572');
    const ddLat = 800/111000;
    const ddLng = 800/(111000*Math.abs(Math.cos(dLat*Math.PI/180)));
    const latMn = (dLat-ddLat).toFixed(6), latMx = (dLat+ddLat).toFixed(6);
    const lngMn = (dLng-ddLng).toFixed(6), lngMx = (dLng+ddLng).toFixed(6);
    const VRF = 'search(result(listings(listing(id,externalId,slug,address,pricingInfos,usableAreas),medias)),totalCount(input,result))';
    const vpStr = latMn + ',' + lngMn + ',' + latMx + ',' + lngMx;
    const params = new URLSearchParams({ business:'SALE', listingType:'USED,DEVELOPMENT', size:'5', from:'0', '__vt':'vb', viewport:vpStr, fields:VRF, categoryPage:'MAP' }).toString();
    const vrOp = { hostname:'glue-api.vivareal.com.br', path:'/v2/listings?'+params, method:'GET', headers:{
      'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept':'application/json','Origin':'https://www.vivareal.com.br','x-domain':'www.vivareal.com.br',
      'Referer':'https://www.vivareal.com.br/','Accept-Encoding':'gzip','x-client-name':'WEB',
    }};
    const vrDbgReq = https.request(vrOp, vrDbgRes => {
      _decodeResponse(vrDbgRes, (err, body) => {
        const out = 'VR API status=' + vrDbgRes.statusCode + '\n\nBODY:\n' + body.slice(0,3000);
        res.writeHead(200, {'Content-Type':'text/plain; charset=utf-8'});
        res.end(out);
      });
    });
    vrDbgReq.on('error', e => { res.writeHead(200,{'Content-Type':'text/plain'}); res.end('VR ERR: '+e.message); });
    vrDbgReq.setTimeout(10000, () => { vrDbgReq.destroy(); res.writeHead(200,{'Content-Type':'text/plain'}); res.end('VR TIMEOUT'); });
    vrDbgReq.end();
    return;
  }

  // ── API: À Venda / Mapa — busca marcadores por bbox ─────────────────────
  if (req.url && req.url.startsWith('/api/avenda/mapa')) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const mapaUrl = new URL(req.url, 'http://localhost');
    const mLat  = parseFloat(mapaUrl.searchParams.get('lat')  || '0');
    const mLng  = parseFloat(mapaUrl.searchParams.get('lng')  || '0');
    const mRaio = parseInt(mapaUrl.searchParams.get('raio') || '800', 10);
    if (!mLat || !mLng) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'lat/lng obrigatórios', markers: [] }));
      return;
    }
    // Calcula bbox
    const dLat = mRaio / 111000;
    const dLng = mRaio / (111000 * Math.abs(Math.cos(mLat * Math.PI / 180)));
    const latMin = (mLat - dLat).toFixed(6), latMax = (mLat + dLat).toFixed(6);
    const lngMin = (mLng - dLng).toFixed(6), lngMax = (mLng + dLng).toFixed(6);

    // Chave de cache (grade de 500m)
    const cacheKey = `${Math.round(mLat*200)/200}_${Math.round(mLng*200)/200}`;
    if (!_avendaCache) _avendaCache = {};
    const cached = _avendaCache[cacheKey];
    if (cached && (Date.now() - cached.ts) < 5 * 60 * 1000) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(cached.data));
      return;
    }

    // Helper: decompress gzip/deflate/brotli response
    function _decodeResponse(res, cb) {
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      const zlib = require('zlib');
      let stream = res;
      if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      stream.on('data', d => chunks.push(d));
      stream.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
      stream.on('error', e => cb(e, ''));
    }

    // Helper: parse listing coord from multiple possible paths
    function _extractCoord(addr) {
      // VivaReal/ZAP real API returns coords nested under geoLocation
      const geo = addr.geoLocation;
      if (geo) {
        const prec = geo.precision || {};
        for (const level of ['CENTER','ROOFTOP','RANGE_INTERPOLATED','APPROXIMATE']) {
          const pt = prec[level]?.point;
          if (pt?.lat && pt?.lon) return { lat: pt.lat, lng: pt.lon };
        }
        if (geo.lat && geo.lon) return { lat: geo.lat, lng: geo.lon };
      }
      // Fallback: direct point on address
      if (addr.point?.lat && addr.point?.lon) return { lat: addr.point.lat, lng: addr.point.lon };
      return null;
    }

    // Helper: build listing URL from slug/externalId/id
    function _vrUrl(l) {
      const s = l.slug || l.externalId || l.id || '';
      return s ? `https://www.vivareal.com.br/imovel/${s}/` : 'https://www.vivareal.com.br';
    }
    function _zapUrl(l) {
      const s = l.slug || l.externalId || l.id || '';
      return s ? `https://www.zapimoveis.com.br/imovel/${s}/` : 'https://www.zapimoveis.com.br';
    }

    // Helper: parse listings array into markers
    function _parseListings(listings, platName, platCor, urlFn) {
      return listings.map(item => {
        const l = item.listing || {};
        const addr = l.address || {};
        const coord = _extractCoord(addr);
        if (!coord) return null;
        const pricing = (l.pricingInfos || []).find(p => p.businessType === 'SALE') || {};
        const preco = pricing.price ? 'R$ ' + parseInt(pricing.price).toLocaleString('pt-BR') : null;
        const areas = (l.usableAreas?.length ? l.usableAreas : null) || l.totalAreas || [];
        const area = areas[0] ? areas[0] + ' m²' : null;
        const rua = [addr.street, addr.streetNumber].filter(Boolean).join(', ');
        const bairroA = addr.neighborhood || '';
        const foto = (item.medias || [])[0]?.url || null;
        const quartos = (l.bedrooms || [])[0] || null;
        const tipo = (l.unitTypes || [])[0] || '';
        return {
          lat: coord.lat, lng: coord.lng,
          titulo: rua || bairroA || 'Imóvel', preco, area,
          bairro: bairroA, foto, quartos, tipo,
          url: urlFn(l),
          plataforma: platName.toLowerCase().replace(' ',''),
          plat_nome: platName, plat_cor: platCor, fonte: 'api'
        };
      }).filter(Boolean);
    }

    // VivaReal API — parâmetros corretos (campos em notação de parênteses, categoryPage=MAP)
    const VR_FIELDS = 'search(result(listings(listing(id,externalId,slug,address,pricingInfos,usableAreas,totalAreas,unitTypes,bedrooms,listingType,description),account(id,name,logoUrl),medias,accountLink)),totalCount(input,result))';
    const vrParams = new URLSearchParams({
      business: 'SALE',
      listingType: 'USED,DEVELOPMENT',
      size: '50', from: '0',
      '__vt': 'vb',
      viewport: `${latMin},${lngMin},${latMax},${lngMax}`,
      fields: VR_FIELDS,
      categoryPage: 'MAP',
    }).toString();

    const vrOpts = {
      hostname: 'glue-api.vivareal.com.br',
      path: '/v2/listings?' + vrParams,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Origin': 'https://www.vivareal.com.br',
        'Referer': 'https://www.vivareal.com.br/venda/sp/sao-paulo/',
        'x-domain': 'www.vivareal.com.br',
        'x-deviceid': 'ld' + Math.random().toString(36).slice(2,18),
        'x-client-name': 'WEB',
        'sec-ch-ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'cross-site',
      },
    };

    // ZAP API — mesmos parâmetros corretos
    const ZAP_FIELDS = 'search(result(listings(listing(id,externalId,slug,address,pricingInfos,usableAreas,totalAreas,unitTypes,bedrooms,listingType,description),account(id,name,logoUrl),medias,accountLink)),totalCount(input,result))';
    function tryZAP(cb) {
      const zapParams = new URLSearchParams({
        business: 'SALE',
        listingType: 'USED,DEVELOPMENT',
        size: '50', from: '0',
        '__vt': 'vb',
        viewport: `${latMin},${lngMin},${latMax},${lngMax}`,
        fields: ZAP_FIELDS,
        categoryPage: 'MAP',
      }).toString();
      const zapOpts = {
        hostname: 'glue-api.zapimoveis.com.br',
        path: '/v2/listings?' + zapParams,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'pt-BR,pt;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Origin': 'https://www.zapimoveis.com.br',
          'Referer': 'https://www.zapimoveis.com.br/venda/imoveis/sp+sao-paulo/',
          'x-domain': 'www.zapimoveis.com.br',
          'x-deviceid': 'ld' + Math.random().toString(36).slice(2,18),
          'x-client-name': 'WEB',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'cross-site',
        },
      };
      const zapReq = https.request(zapOpts, zapRes => {
        _decodeResponse(zapRes, (err, zapBody) => {
          if (err) { cb([], 'zap_decode_err'); return; }
          console.log('[avenda] ZAP status=' + zapRes.statusCode + ' body_len=' + zapBody.length + ' preview=' + zapBody.slice(0,200));
          try {
            const data = JSON.parse(zapBody);
            const listings = data?.search?.result?.listings || [];
            const markers = _parseListings(listings, 'ZAP Imóveis', '#003da5', _zapUrl);
            cb(markers, markers.length ? 'zap_api' : 'zap_empty');
          } catch(e) { console.log('[avenda] ZAP parse err:', e.message); cb([], 'zap_parse_err'); }
        });
      });
      zapReq.on('error', e => { console.log('[avenda] ZAP conn err:', e.message); cb([], 'zap_error'); });
      zapReq.setTimeout(12000, () => { zapReq.destroy(); cb([], 'zap_timeout'); });
      zapReq.end();
    }

    // Teto geral de tempo — a cadeia completa de fallbacks (Python, VR, ZAP,
    // scrapes, QuintoAndar, DuckDuck) pode passar de 1 minuto no pior caso,
    // e o navegador/proxy derruba a conexão (ERR_CONNECTION_RESET) antes
    // disso. Se nada respondeu até o teto, responde vazio imediatamente —
    // melhor "sem anúncios agora" do que a conexão simplesmente cair.
    let _avendaResponded = false;
    const _avendaDeadline = setTimeout(() => {
      if (_avendaResponded) return;
      _avendaResponded = true;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, markers: [], fonte: 'timeout', total: 0 }));
    }, 20000);

    function sendResult(markers, fonte) {
      if (_avendaResponded) return;
      _avendaResponded = true;
      clearTimeout(_avendaDeadline);
      const result = { ok: true, markers, fonte, total: markers.length };
      if (markers.length > 0) _avendaCache[cacheKey] = { ts: Date.now(), data: result };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    }

    // ── Tenta Python primeiro (requests com sessão = mais difícil de bloquear) ──
    function _tryPython(cb) {
      const pyScript = path.join(DIR, 'buscar_avenda.py');
      if (!fs.existsSync(pyScript)) { cb([], 'py_not_found'); return; }
      const args = [pyScript, latMin, lngMin, latMax, lngMax];
      // Windows usa 'python', Linux/Mac pode precisar de 'python3'
      const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
      const py = spawn(pyCmd, args, { cwd: DIR });
      let out = '', err = '';
      py.stdout.on('data', d => out += d);
      py.stderr.on('data', d => err += d);
      py.on('close', code => {
        if (err) console.log('[avenda-py] stderr:', err.slice(0, 400));
        try {
          const parsed = JSON.parse(out);
          const markers = parsed.markers || [];
          console.log(`[avenda-py] markers=${markers.length} fonte=${parsed.fonte}`);
          cb(markers, parsed.fonte || 'python');
        } catch(e) {
          console.log('[avenda-py] parse err:', e.message, 'out:', out.slice(0,200));
          cb([], 'py_parse_err');
        }
      });
      py.on('error', e => { console.log('[avenda-py] spawn err:', e.message); cb([], 'py_error'); });
      setTimeout(() => { try { py.kill(); } catch(e){} cb([], 'py_timeout'); }, 25000);
    }

    // Inicia com Python; se falhar, cai para Node.js VR→ZAP→scrape→links
    _tryPython((pyMarkers, pyFonte) => {
      if (pyMarkers.length > 0) { sendResult(pyMarkers, pyFonte); return; }
      // Continua com Node.js VR
      _startVR();
    });
    function _startVR(){
    const vrReq = https.request(vrOpts, vrRes => {
      _decodeResponse(vrRes, (err, vrBody) => {
        if (err) { console.log('[avenda] VR decode err:', err.message); tryZAP((m, f) => { if(m.length>0){sendResult(m,f);return;} _avendaDuckFallback(mLat,mLng,sendResult); }); return; }
        console.log('[avenda] VR status=' + vrRes.statusCode + ' body_len=' + vrBody.length + ' preview=' + vrBody.slice(0,200));
        try {
          const data = JSON.parse(vrBody);
          const listings = data?.search?.result?.listings || [];
          const markers = _parseListings(listings, 'VivaReal', '#00a884', _vrUrl);
          console.log('[avenda] VR markers parsed=' + markers.length);
          if (markers.length > 0) { sendResult(markers, 'vivareal_api'); return; }
        } catch(e) { console.log('[avenda] VR parse err:', e.message); }
        // Fallback: ZAP
        tryZAP((zapMarkers, fonte) => {
          console.log('[avenda] ZAP markers=' + zapMarkers.length + ' fonte=' + fonte);
          if (zapMarkers.length > 0) { sendResult(zapMarkers, fonte); return; }
          _avendaDuckFallback(latMin, lngMin, latMax, lngMax, mLat, mLng, sendResult);
        });
      });
    });
    vrReq.on('error', (e) => {
      console.log('[avenda] VR conn err:', e.message);
      tryZAP((zapMarkers, fonte) => {
        if (zapMarkers.length > 0) { sendResult(zapMarkers, fonte); return; }
        _avendaDuckFallback(latMin, lngMin, latMax, lngMax, mLat, mLng, sendResult);
      });
    });
    vrReq.setTimeout(15000, () => { vrReq.destroy(); tryZAP((m, f) => {
      if (m.length > 0) { sendResult(m, f); return; }
      _avendaDuckFallback(latMin, lngMin, latMax, lngMax, mLat, mLng, sendResult);
    }); });
    vrReq.end();
    } // fim _startVR
    return;
  }

  // ── API: À Venda — busca anúncios por endereço ──────────────────────────
  if (req.url && req.url.startsWith('/api/avenda')) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const avendaUrl = new URL(req.url, 'http://localhost');
    const endereco  = avendaUrl.searchParams.get('endereco') || '';
    const bairro    = avendaUrl.searchParams.get('bairro')   || '';
    if (!endereco) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'endereco obrigatório' }));
      return;
    }
    const py = spawn(PY_CMD, [
      path.join(DIR, 'buscar_avenda.py'),
      endereco, bairro
    ], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let out = '', err = '';
    py.stdout.on('data', d => { out += d.toString('utf8'); });
    py.stderr.on('data', d => { err += d.toString(); });
    py.on('close', code => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (code !== 0 || !out) {
        res.end(JSON.stringify({ ok: false, error: err || 'Python error', anuncios: [], links: [] }));
      } else {
        try {
          res.end(out);
        } catch(e) {
          res.end(JSON.stringify({ ok: false, error: String(e), anuncios: [], links: [] }));
        }
      }
    });
    return;
  }

  // ── API: upload de imagem (print colado ou arrastado) ────────────────────
  if (req.url === '/api/upload-img' && req.method === 'POST') {
    cors(res);
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const dataUrl = body.data || '';
        const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!match) { res.writeHead(400); res.end(JSON.stringify({error:'invalid'})); return; }
        const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
        const fname = 'img_' + Date.now() + '.' + ext;
        const dir = path.join(DIR, 'uploads', 'imgs');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, fname), Buffer.from(match[2], 'base64'));
        cors(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: '/uploads/imgs/' + fname }));
      } catch(e) {
        res.writeHead(500); res.end(JSON.stringify({error: e.message}));
      }
    });
    return;
  }

  // ── Busca imagens via DuckDuckGo ──────────────────────────────────────────
  if (req.url && req.url.startsWith('/api/buscar-imgs')) {
    cors(res);
    const qs = new URL(req.url, 'http://localhost').searchParams;
    const q = qs.get('q') || '';
    if (!q) { res.writeHead(400); res.end(JSON.stringify({error:'no query'})); return; }

    const fetchUrl = (url, opts={}) => new Promise((resolve, reject) => {
      const lib = url.startsWith('https') ? https : http;
      const reqOpts = Object.assign({ headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,*/*',
      }}, opts);
      const r = lib.get(url, reqOpts, resp => {
        // Follow redirects
        if ([301,302,303,307,308].includes(resp.statusCode) && resp.headers.location) {
          const loc = resp.headers.location.startsWith('http') ? resp.headers.location : 'https://duckduckgo.com' + resp.headers.location;
          return resolve(fetchUrl(loc, opts));
        }
        const chunks = [];
        resp.on('data', c => chunks.push(c));
        resp.on('end', () => resolve({ body: Buffer.concat(chunks).toString(), headers: resp.headers, status: resp.statusCode }));
      });
      r.on('error', reject);
      r.setTimeout(8000, () => { r.destroy(); reject(new Error('timeout')); });
    });

    (async () => {
      try {
        // Step 1: get vqd token from DDG
        const init = await fetchUrl('https://duckduckgo.com/?q=' + encodeURIComponent(q) + '&iax=images&ia=images');
        const vqdMatch = init.body.match(/vqd=['"]([^'"]+)['"]/);
        const vqd = vqdMatch ? vqdMatch[1] : null;
        if (!vqd) throw new Error('no vqd');

        // Step 2: fetch image results
        const apiUrl = 'https://duckduckgo.com/i.js?q=' + encodeURIComponent(q) +
          '&o=json&p=1&s=0&u=bing&f=,,,,,&l=pt-br&vqd=' + encodeURIComponent(vqd);
        const result = await fetchUrl(apiUrl);
        const json = JSON.parse(result.body);
        const imgs = (json.results || []).slice(0, 12).map(r => ({
          thumb: r.thumbnail,
          full:  r.image,
          title: r.title,
          width: r.width,
          height: r.height,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ imgs }));
      } catch(e) {
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    })();
    return;
  }

  // ── GeoImovel Sync ───────────────────────────────────────────────────────
  if (req.url && req.url.startsWith('/api/geoimovel-sync')) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const qs = new URL(req.url, 'http://localhost').searchParams;
    const nome  = qs.get('nome') || '';
    const token = qs.get('token') || '';
    const userId = qs.get('user_id') || '';
    if (!nome || !token) { res.writeHead(400); res.end(JSON.stringify({error:'nome e token obrigatórios'})); return; }

    const geoFetch = (url, opts={}) => new Promise((resolve, reject) => {
      const lib = url.startsWith('https') ? https : http;
      const parsedUrl = new URL(url);
      const reqOpts = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: opts.method || 'GET',
        headers: Object.assign({
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        }, opts.headers || {}),
      };
      const r = lib.request(reqOpts, resp => {
        const chunks = [];
        resp.on('data', c => chunks.push(c));
        resp.on('end', () => resolve({ body: Buffer.concat(chunks).toString(), status: resp.statusCode }));
      });
      r.on('error', reject);
      r.setTimeout(10000, () => { r.destroy(); reject(new Error('timeout')); });
      if (opts.body) r.write(opts.body);
      r.end();
    });

    (async () => {
      try {
        const BASE = 'https://keymaker-java.matrix.geoimovel.com.br';

        // Step 1: search by name
        const searchResp = await geoFetch(`${BASE}/rdr/api/v1/composite/query_builder/query_project_property?where=name,ics,${encodeURIComponent(nome)}`);
        const searchData = JSON.parse(searchResp.body);
        const records = searchData.records || [];
        if (!records.length) { res.writeHead(404); res.end(JSON.stringify({error:'Empreendimento não encontrado no GeoImovel'})); return; }
        const idProjectProperty = records[0].id;

        // Step 2: get company ID (needed for filter_search_2)
        let companyId = '185'; // fallback default
        if (userId) {
          try {
            const compResp = await geoFetch(`${BASE}/rdr/api/v1/param-query/query_param/get_company_id?id_employee=${userId}`);
            const compData = JSON.parse(compResp.body);
            if (compData.records && compData.records[0]) companyId = compData.records[0].company_id || compData.records[0].id_customer || companyId;
          } catch(e) { /* use fallback */ }
        }

        // Step 3: get id_source via filter_search_2
        const filterResp = await geoFetch(`${BASE}/rdr/api/v1/composite/query_builder/filter_search_2/?where=id_project_property,eq,${idProjectProperty}&condition=perm_comp;${companyId}`);
        const filterData = JSON.parse(filterResp.body);
        const propRecord = (filterData.records || [])[0];
        if (!propRecord) { res.writeHead(404); res.end(JSON.stringify({error:'Dados do empreendimento não encontrados'})); return; }
        const idSource = propRecord.id_source || propRecord.id;

        // Step 4: get full modal details
        const detailResp = await geoFetch(`${BASE}/rdr/get-modal-details`, {
          method: 'POST',
          body: JSON.stringify({ id_source: parseInt(idSource), backoffice: false }),
        });
        const detailData = JSON.parse(detailResp.body);
        if (!detailData.detail) { res.writeHead(500); res.end(JSON.stringify({error:'Erro ao obter detalhes', raw: detailData})); return; }
        const d = detailData.detail;

        // Step 5: get sales monitoring (optional)
        let salesData = null;
        try {
          const salesResp = await geoFetch(`${BASE}/rdr/sales-monitoring`, {
            method: 'POST',
            body: JSON.stringify({ idSource: parseInt(idSource) }),
          });
          salesData = JSON.parse(salesResp.body);
        } catch(e) { /* ignore */ }

        // Build image URL — fachada from filter_search_2 has priority
        const cdnBase = 'https://dzducb3xx8cfd.cloudfront.net/geoimovel02/produtos/admingeral/lancamentos';
        let imgUrl = null;
        if (propRecord.path_file) {
          const pf = propRecord.path_file.replace('./', '');
          imgUrl = pf.startsWith('foto/') ? cdnBase + '/' + pf : cdnBase + '/foto/' + pf;
        } else if (d.path_files_infra && d.path_files_infra.length) {
          imgUrl = cdnBase + '/' + d.path_files_infra[0].replace('./', '');
        }

        // Compute ranges from estoque_atual
        const estoque = d.estoque_atual || [];
        const areas   = estoque.map(e => parseFloat(e.area)).filter(Boolean);
        const vagas   = estoque.map(e => e.garage).filter(Boolean);
        const dorms   = estoque.map(e => e.bedroom).filter(Boolean);
        const tickets = estoque.map(e => e.val_lanc / 1e6).filter(Boolean);
        const disponiveis = estoque.reduce((s, e) => s + (e.quant - (e.q_vend||0)), 0);

        const result = {
          nome:         d.project_property,
          incorporadora: propRecord.developer_name || propRecord.developer || '',
          endereco:     `${d.street}, ${d.number}`,
          bairro:       d.neighborhood,
          regiao:       d.district,
          lat:          d.latitude,
          lng:          d.longitude,
          unidades:     d.unity,
          data_lancamento: d.launch_year && d.launch_month ? `${d.launch_year}-${String(d.launch_month).padStart(2,'0')}-01` : null,
          data_entrega: d.date_delivery,
          torres:       d.towers,
          pavimentos:   d.pavement_quantity,
          area_terreno: parseFloat(d.area_terreno),
          vgv_mm:       parseFloat(d.ind_vgv_brl) / 1e6,
          tipologia:    d.tipologia,
          preco_m2_min: d.valor_m2 ? Math.round(d.valor_m2) : null,
          area_min:     areas.length ? Math.min(...areas) : null,
          area_max:     areas.length ? Math.max(...areas) : null,
          vagas_min:    vagas.length ? Math.min(...vagas) : null,
          vagas_max:    vagas.length ? Math.max(...vagas) : null,
          dorm_min:     dorms.length ? Math.min(...dorms) : null,
          dorm_max:     dorms.length ? Math.max(...dorms) : null,
          ticket_min:   tickets.length ?parseFloat(Math.min(...tickets).toFixed(2)) : null,
          ticket_max:   tickets.length ? parseFloat(Math.max(...tickets).toFixed(2)) : null,
          pavimento_tipo:     d.pavement_unity || null,
          unidades_por_andar: d.pavement_unity || null,
          data_entrega:      d.date_delivery || null,
          estoque_atual:     disponiveis,
          estoque_detalhes:  estoque,
          enterprise_details: d.enterprise_details || [],
          img_url:      imgUrl,
          img_infra:    (d.path_files_infra||[]).map(p => cdnBase + '/' + p.replace('./','')),
          img_plantas:  (d.path_files_plan||[]).map(p => cdnBase + '/' + p.replace('./','')),
          id_source:    idSource,
          sales_chart:  salesData ? (salesData.table_chart || null) : null,
          quant_vendida: (() => {
            if (!salesData || !salesData.table_chart) return null;
            const chart = Array.isArray(salesData.table_chart)
              ? salesData.table_chart
              : (salesData.table_chart[0] || []);
            if (!chart.length) return null;
            const last = chart[chart.length - 1];
            return last.sum_quantity_sold != null ? last.sum_quantity_sold : null;
          })(),
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch(e) {
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    })();
    return;
  }

  // ── API: CDC capture (recebe PDF da certidão via POST do portal da Prefeitura) ──
  if (req.url && req.url.startsWith('/api/cdc-capture')) {
    cors(res);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          const { sql, base64, html, nome } = body;
          if (sql) _cdcStore[sql] = { base64: base64 || html || '', nome: nome || '', ts: Date.now() };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch(e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }
    if (req.method === 'DELETE') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          if (body.sql) delete _cdcStore[body.sql];
        } catch(e) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(404); res.end();
    return;
  }

  // ── API: CDC result — poll para base64 do PDF capturado ─────────────────
  if (req.url && req.url.startsWith('/api/cdc-result')) {
    cors(res);
    const qs = new URL(req.url, 'http://localhost').searchParams;
    const sql = qs.get('sql') || '';
    const entry = _cdcStore[sql];
    if (entry && entry.base64) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, base64: entry.base64, nome: entry.nome }));
    } else {
      res.writeHead(204); res.end();
    }
    return;
  }

  // ── API: criar pasta do terreno na rede ──────────────────────────────────
  // Ao cadastrar um terreno novo, cria automaticamente uma pasta vazia em
  // BANCO DE DADOS DE TERRENOS/<ano atual>/<Nome, Número_mês.ano>, no mesmo
  // formato das pastas já usadas manualmente pela equipe (ex: "Joaquim
  // Floriano, 295_mar.26"). Não sobrescreve nem apaga nada — se a pasta já
  // existir (endereço repetido, ou criada manualmente antes), só confirma.
  if (req.url === '/api/criar-pasta-terreno' && req.method === 'POST') {
    cors(res);
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        const endereco = (body.endereco || '').trim();
        if (!endereco) {
          res.writeHead(400, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false, error:'endereco obrigatório'}));
          return;
        }
        const nomePasta = _nomePastaTerreno(endereco);
        const ano = new Date().getFullYear();
        const baseDir = PASTA_YUNY_BASE;
        const anoDir = path.join(baseDir, String(ano));
        if (!fs.existsSync(anoDir)) {
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false, error:`Pasta do ano ${ano} não encontrada em ${baseDir} (rede/OneDrive offline?) — pasta do terreno não foi criada.`}));
          return;
        }
        const pastaPath = path.join(anoDir, nomePasta);
        const jaExistia = fs.existsSync(pastaPath);
        if (!jaExistia) {
          fs.mkdirSync(pastaPath, { recursive: true });
          _copiarPastaModelo(pastaPath);
        }
        console.log(`[criarPastaTerreno] ${jaExistia ? 'já existia' : 'criada'}: ${pastaPath}`);
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true, jaExistia, pasta:nomePasta, caminho:pastaPath}));
      } catch(e) {
        res.writeHead(500, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:false, error:e.message}));
      }
    });
    return;
  }

  // ── API: listar pastas já existentes na rede (todos os anos) ─────────────
  // Usado pelo seletor "já existe uma pasta pra esse terreno" no cadastro —
  // em vez de criar uma pasta nova, a pessoa escolhe uma já existente numa
  // lista, sem precisar digitar caminho nenhum. Retorna todas as pastas de
  // todos os anos numa lista só (achatada) — o filtro por texto é feito no
  // próprio app (a quantidade total de pastas não justifica paginação/busca
  // no servidor).
  if (req.url === '/api/listar-pastas-rede' && req.method === 'GET') {
    cors(res);
    try {
      const baseDir = PASTA_YUNY_BASE;
      if (!fs.existsSync(baseDir)) {
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:false, error:`Pasta de rede não encontrada em ${baseDir} (rede/OneDrive offline?).`}));
        return;
      }
      const anos = fs.readdirSync(baseDir, {withFileTypes:true})
        .filter(d => d.isDirectory() && /^\d{4}$/.test(d.name))
        .map(d => d.name)
        .sort().reverse(); // ano mais recente primeiro
      const pastas = [];
      anos.forEach(ano => {
        const anoDir = path.join(baseDir, ano);
        try {
          fs.readdirSync(anoDir, {withFileTypes:true})
            .filter(d => d.isDirectory())
            .forEach(d => pastas.push({ano, nome:d.name}));
        } catch(e) { /* pasta do ano ilegível — ignora, não trava a listagem inteira */ }
      });
      pastas.sort((a,b)=> b.ano.localeCompare(a.ano) || a.nome.localeCompare(b.nome, 'pt-BR'));
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true, pastas}));
    } catch(e) {
      res.writeHead(500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:false, error:e.message}));
    }
    return;
  }

  // ── API: vincular pasta já existente a um terreno novo ────────────────────
  // Contraparte do /api/criar-pasta-terreno: em vez de criar uma pasta nova,
  // só confirma que a pasta escolhida (ano + nome, vindos do seletor do
  // /api/listar-pastas-rede) realmente existe e devolve no MESMO formato de
  // resposta do /api/criar-pasta-terreno ({ok, jaExistia, pasta, caminho}) —
  // assim o front reaproveita o mesmo código de "depois de resolver a pasta"
  // (salvar pasta_rede no Firestore, gerar Ficha de Aquisição etc.) sem
  // precisar de um caminho separado pra cada caso.
  if (req.url === '/api/vincular-pasta-terreno' && req.method === 'POST') {
    cors(res);
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        const ano  = (body.ano  || '').toString().trim();
        const nome = (body.nome || '').toString().trim();
        if (!/^\d{4}$/.test(ano)) throw new Error('ano inválido');
        if (!nome || nome.includes('..') || nome.includes('/') || nome.includes('\\')) {
          throw new Error('nome de pasta inválido');
        }
        const pastaPath = path.join(PASTA_YUNY_BASE, ano, nome);
        if (!fs.existsSync(pastaPath) || !fs.statSync(pastaPath).isDirectory()) {
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false, error:'Pasta não encontrada — pode ter sido movida ou renomeada.'}));
          return;
        }
        console.log(`[vincularPastaTerreno] vinculada: ${pastaPath}`);
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true, jaExistia:true, pasta:nome, caminho:pastaPath}));
      } catch(e) {
        res.writeHead(500, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:false, error:e.message}));
      }
    });
    return;
  }

  // ── API: salvar arquivo (Ficha de Aquisição / revisões do Estudo de Massa)
  // na pasta do terreno na rede ─────────────────────────────────────────────
  if (req.url === '/api/salvar-arquivo-terreno' && req.method === 'POST') {
    handleSalvarArquivoTerreno(req, res);
    return;
  }

  // ── API: gerar PDF real (via puppeteer) do Estudo de Massa e salvar na
  // pasta do terreno na rede ────────────────────────────────────────────────
  if (req.url === '/api/salvar-pdf-terreno' && req.method === 'POST') {
    handleSalvarPdfTerreno(req, res);
    return;
  }

  // ── API: enviar e-mail de Prospecção Ativa pro corretor (com print
  // embutido) ───────────────────────────────────────────────────────────────
  if (req.url === '/api/enviar-email-prospeccao' && req.method === 'POST') {
    handleEnviarEmailProspeccao(req, res);
    return;
  }

  // ── Arquivos estáticos ────────────────────────────────────────────────────
  let filePath = path.join(DIR, decodeURIComponent(req.url === '/' ? '/index.html' : req.url));
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log('Servidor rodando em http://localhost:' + PORT);
  console.log('Endpoint de calculo: POST http://localhost:' + PORT + '/api/calcular');
  console.log('Feche esta janela para parar.');
  _retomarGeocodeBatchMercadoSeInterrompido();
});

// Se o servidor foi reiniciado NO MEIO de um job de pré-geocodificação em
// lote (arquivo de status ficou com processing:true, mas o processo Node
// que estava rodando o loop morreu junto com o restart — a variável em
// memória _geocodeMercRunning sempre volta como false num processo novo),
// retoma sozinho de onde parou, em vez de deixar o status "preso" pra
// sempre dizendo "processando" sem nada realmente rodando (bug real
// encontrado: Kamila reiniciou o servidor várias vezes pra aplicar outras
// correções, e o job de geocodificação ficou "fantasma" parado há mais de
// um dia sem avisar ninguém).
function _retomarGeocodeBatchMercadoSeInterrompido(){
  const status = _lerGeocodeMercStatusSeguro();
  if (!status || !status.processing) return;
  console.log('[geocode-batch] job interrompido detectado (' + (status.done||0) + '/' + (status.total||'?') + ') — retomando automaticamente...');
  _listarItensParaGeocode((err, itens) => {
    if (err) { console.log('[geocode-batch] falha ao retomar:', err.message); return; }
    _rodarGeocodeBatchMercado(itens);
  });
}
function _lerGeocodeMercStatusSeguro(){
  try { return JSON.parse(fs.readFileSync(GEOCODE_MERC_STATUS_PATH, 'utf8')); } catch (e) { return null; }
}
