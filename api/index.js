require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

// --- CONFIGURAÇÕES ---
const supabase = createClient(
    process.env.SUPABASE_URL || '', 
    process.env.SUPABASE_KEY || ''
);

const BASE_URL = 'https://api.headoffice.ai/v1';
const SHEET_ID = '1m6yZozLKIZ8KyT9YW62qikkSZE-CrQsjTNTX6V9Y0eM';
const SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;

const BOT_ID = '69372353b11d9df606b68bf8';
const BOT_NAME = 'Roger';

// --- ROTA DASHBOARD ---
app.get('/', (req, res) => {
    const currentUrl = `https://${req.headers.host}`;
    const htmlComUrl = DASHBOARD_HTML.replace('https://head-office-one.vercel.app', currentUrl);
    res.send(htmlComUrl);
});

// --- HELPER AUTH HEADOFFICE ---
function getHeadOfficeToken() {
    let rawToken = process.env.HEADOFFICE_API_KEY || process.env.HEADOFFICE_JWT || "";
    rawToken = rawToken.trim();
    if (rawToken.startsWith('"') && rawToken.endsWith('"')) rawToken = rawToken.slice(1, -1);
    if (rawToken.toLowerCase().startsWith('bearer')) {
        rawToken = rawToken.replace(/^bearer\s+/i, "").trim();
    }
    return rawToken.length > 10 ? rawToken : null;
}

// --- HELPER AUTH GOOGLE ---
function getGoogleAuth() {
    const privateKey = process.env.GOOGLE_PRIVATE_KEY 
        ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') 
        : undefined;

    if (!privateKey || !process.env.GOOGLE_CLIENT_EMAIL) {
        throw new Error("Credenciais GCP faltando.");
    }

    return new google.auth.GoogleAuth({
        credentials: {
            client_email: process.env.GOOGLE_CLIENT_EMAIL,
            private_key: privateKey,
        },
        scopes: [
            'https://www.googleapis.com/auth/documents.readonly'
        ],
    });
}

// --- UTILS ---
function parseDateFromTitle(title) {
    if (!title) return null;
    const lower = title.toLowerCase();
    const meses = { "jan": 0, "fev": 1, "mar": 2, "abr": 3, "mai": 4, "jun": 5, "jul": 6, "ago": 7, "set": 8, "out": 9, "nov": 10, "dez": 11 };
    
    const regexExt = /(\d{1,2})\s*(?:de)?\s*([a-zç]{3,})(?:\.|,)?/;
    let match = lower.match(regexExt);
    if (match) {
        const day = parseInt(match[1]);
        let monthStr = match[2];
        if (monthStr.length > 3 && !meses[monthStr]) monthStr = monthStr.substring(0, 3);
        if (monthStr === 'mar' || monthStr === 'març') monthStr = 'mar';
        const month = meses[monthStr] !== undefined ? meses[monthStr] : 0;
        const yearMatch = lower.match(/20\d{2}/);
        const year = yearMatch ? parseInt(yearMatch[0]) : new Date().getFullYear();
        return new Date(year, month, day);
    }

    const regexNum = /(\d{1,2})[\/\.\-](\d{1,2})(?:[\/\.\-](\d{2,4}))?/;
    match = lower.match(regexNum);
    if (match) {
        const day = parseInt(match[1]);
        const month = parseInt(match[2]) - 1;
        let year = match[3] ? parseInt(match[3]) : new Date().getFullYear();
        if (year < 100) year += 2000;
        return new Date(year, month, day);
    }
    return null;
}

function readStructuralElements(elements) {
    let text = '';
    if (!elements) return text;
    elements.forEach(element => {
        if (element.paragraph) {
            element.paragraph.elements.forEach(el => {
                if (el.textRun && el.textRun.content) text += el.textRun.content;
            });
            text += "\n";
        } else if (element.table) {
            element.table.tableRows.forEach(row => {
                row.tableCells.forEach(cell => {
                    text += readStructuralElements(cell.content) + " "; 
                });
                text += "\n";
            });
        }
    });
    return text;
}

function extractJSON(text) {
    if (!text) return null;
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
        return text.substring(start, end + 1);
    }
    return text;
}

// --- SNIPER DE TEXTO ---
function optimizeTextForGet(text) {
    if (!text) return "";
    let clean = text;

    const lower = clean.toLowerCase();
    const endMarkers = ["revise as anotações do gemini", "00:00:00", "transcrição\n", "registros da reunião transcrição"];
    let cutoff = clean.length;
    for (const m of endMarkers) {
        const idx = lower.indexOf(m);
        if (idx !== -1 && idx < cutoff && idx > 50) cutoff = idx;
    }
    clean = clean.substring(0, cutoff).trim();
    clean = clean.replace(/\n\s*\n/g, '\n').replace(/\s+/g, ' ');

    const MAX = 1600;
    if (clean.length <= MAX) return clean;

    const stepsMarkers = ["próximas etapas", "próximos passos", "ações futuras", "encaminhamentos"];
    let stepsIdx = -1;
    for (const sm of stepsMarkers) {
        const idx = clean.toLowerCase().lastIndexOf(sm);
        if (idx !== -1) { stepsIdx = idx; break; }
    }

    if (stepsIdx !== -1) {
        const head = clean.substring(0, 800);
        const tail = clean.substring(stepsIdx, stepsIdx + 800);
        return `${head} ... [OMITIDO] ... ${tail}`;
    } else {
        const head = clean.substring(0, 900);
        const tail = clean.substring(clean.length - 700);
        return `${head} ... [OMITIDO] ... ${tail}`;
    }
}

// --- BUSCA PLANILHA (VIA CSV PÚBLICO) ---
async function findDocLinkInSheet(companyName) {
    try {
        const response = await axios.get(SHEET_CSV_URL);
        const rows = response.data.split(/\r?\n/);

        for (const row of rows) {
            if (row.toLowerCase().includes(companyName.toLowerCase())) {
                const match = row.match(/https:\/\/docs\.google\.com\/document\/d\/[a-zA-Z0-9_-]+/);
                if (match) return match[0];
            }
        }
        return null;
    } catch (error) {
        throw new Error("Erro ao acessar Planilha (CSV): " + error.message);
    }
}

// --- BUSCA ABAS DO DOC ---
async function getAllTabsSorted(docId) {
    const auth = getGoogleAuth();
    const client = await auth.getClient();
    const docs = google.docs({ version: 'v1', auth: client });
    const res = await docs.documents.get({ documentId: docId });
    const doc = res.data;
    let tabsData = [];

    if (doc.tabs && doc.tabs.length > 0) {
        doc.tabs.forEach(t => {
            const title = t.tabProperties.title || "Sem Título";
            const date = parseDateFromTitle(title);
            let content = "";
            if (t.documentTab && t.documentTab.body) {
                content = readStructuralElements(t.documentTab.body.content);
            }
            if (content.trim().length > 0) {
                tabsData.push({ title, date, timestamp: date ? date.getTime() : 0, content });
            }
        });
    } else {
        const content = readStructuralElements(doc.body.content);
        if (content.trim().length > 0) {
            tabsData.push({ title: "Principal", date: null, timestamp: 0, content });
        }
    }
    tabsData.sort((a, b) => a.timestamp - b.timestamp);
    return tabsData;
}

// --- CORE: INTELLIGENCE GENERATOR ---
async function generateCompanyIntelligence(nome, id, authHeader) {
    let docId = null;
    let docUrl = null;
    let debugLogs = [];

    // 1. Achar Link
    try {
        docUrl = await findDocLinkInSheet(nome);
        if (docUrl) {
            const match = docUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
            if (match) docId = match[1];
        }
    } catch (e) { throw new Error("Erro Planilha: " + e.message); }

    if (!docId) throw new Error(`Link não encontrado para ${nome}.`);

    // 2. Ler Abas
    let allTabs = await getAllTabsSorted(docId);
    if (allTabs.length === 0) throw new Error("Documento vazio.");

    // 3. Processar (Cadeia)
    let currentMemory = "Início da análise.";
    
    for (let i = 0; i < allTabs.length; i++) {
        const tab = allTabs[i];
        const isLast = i === allTabs.length - 1;
        const cleanContent = optimizeTextForGet(tab.content);
        
        let prompt = "";
        let contextForUrl = "";

        if (!isLast) {
            prompt = `ATUE COMO CS MANAGER. REUNIÃO PASSADA: ${tab.title}. INSTRUÇÃO: Atualize a memória com o SENTIMENTO do cliente (ele reclamou? elogiou?). Seja conciso.`;
            contextForUrl = `MEMÓRIA: ${currentMemory.slice(0, 500)}\n\nRESUMO: ${cleanContent}`;
        } else {
            // PROMPT ATUALIZADO: Foco em HUMOR, não em TAREFAS
            prompt = `ATUE COMO DIRETOR DE CS. ÚLTIMA REUNIÃO (${tab.title}).
            
            --- MISSÃO FINAL ---

            Gere o Relatório de Inteligência Estratégico.

            GERE RELATÓRIO JSON:
            {"resumo_executivo": "...", "perfil_cliente": "...", "estrategia_relacionamento": "...", "checkpoints_feitos": [], "proximos_passos": [], "riscos_bloqueios": "...", "sentimento_score": "0-10"}
            
            REGRAS RÍGIDAS:
            1. 'proximos_passos': Extraia SOMENTE do texto da ÚLTIMA REUNIÃO abaixo.
            2. 'sentimento_score': AVALIE ESTRITAMENTE O HUMOR E A EMOÇÃO DO CLIENTE.
               - NÃO deduza o score baseado em tarefas atrasadas ou cronograma.
               - 9-10: Cliente apaixonado, elogios explícitos ("excelente", "muito bom").
               - 7-8: Cliente feliz, colaborativo, tom positivo e construtivo.
               - 5-6: Neutro, profissional, transacional (sem emoção).
               - 3-4: Cliente demonstrou insatisfação, rejeitou entregas ou reclamou levemente.
               - 0-2: Cliente irritado, grosso, ameaça de cancelamento ou crise.
            3. Use o "TEXTO DA ÚLTIMA REUNIÃO" para preencher 'checkpoints_feitos' e 'proximos_passos'.
            4. Se o texto citar Felipe, Barbara, William, use os nomes.
            5. Nunca fabrique dados ou invente tarefas.
            
            IMPORTANTE: Se o projeto está pegando fogo (atrasado) mas o cliente está calmo e parceiro, a nota DEVE SER ALTA (7+).`;
            
            contextForUrl = `Histórico Prévio (Perfil/Sentimento): ${currentMemory.slice(0, 600)}\n\nTEXTO DA ÚLTIMA REUNIÃO (Checkpoints/Próximos Passos):\n${cleanContent}`;
        }

        let respostaIA = "";
        for (let retry = 0; retry < 2; retry++) {
            try {
                const response = await axios.get(`${BASE_URL}/openai/question`, {
                    params: { aiName: BOT_NAME, aiId: BOT_ID, question: prompt, context: contextForUrl },
                    headers: { 'Authorization': authHeader },
                    timeout: 45000
                });
                const tResp = response.data.text || response.data.answer;
                if (tResp && tResp.trim().length > 2) { respostaIA = tResp; break; }
            } catch (e) {
                if (e.response && e.response.status === 414) {
                    try {
                        const mini = contextForUrl.slice(0, 500);
                        const r2 = await axios.get(`${BASE_URL}/openai/question`, {
                            params: { aiName: BOT_NAME, aiId: BOT_ID, question: prompt, context: mini },
                            headers: { 'Authorization': authHeader }
                        });
                        respostaIA = r2.data.text || r2.data.answer;
                    } catch(e2){}
                }
            }
        }

        if (respostaIA) {
            currentMemory = respostaIA;
        }
    }

    // 4. Salvar
    const jsonOnly = extractJSON(currentMemory);
    let data = {};
    try { data = JSON.parse(jsonOnly); } catch (e) { data = { resumo_executivo: "Erro JSON IA." }; }

    const score = parseInt(data.sentimento_score) || 5;
    
    // NOVA LÓGICA DE STATUS (5 NÍVEIS)
    let status_cliente = "Neutro";
    let scoreColor = "text-yellow-400 border-yellow-500/30 bg-yellow-500/10";
    
    if (score >= 9) {
        status_cliente = "Extremamente Satisfeito";
        scoreColor = "text-purple-400 border-purple-500/30 bg-purple-500/10";
    } else if (score >= 7) {
        status_cliente = "Satisfeito";
        scoreColor = "text-emerald-400 border-emerald-500/30 bg-emerald-500/10";
    } else if (score >= 5) {
        status_cliente = "Neutro";
        scoreColor = "text-yellow-400 border-yellow-500/30 bg-yellow-500/10";
    } else if (score >= 3) {
        status_cliente = "Insatisfeito";
        scoreColor = "text-orange-400 border-orange-500/30 bg-orange-500/10";
    } else {
        status_cliente = "Crítico";
        scoreColor = "text-red-400 border-red-500/30 bg-red-500/10";
    }

    const lastTabName = allTabs[allTabs.length-1].title;

    const htmlResumo = `
        <div class="space-y-4 font-sans">
            <div class="flex items-center justify-between mb-2">
                <span class="text-[9px] uppercase font-mono text-indigo-300 bg-indigo-500/10 px-2 py-1 rounded border border-indigo-500/20">
                    📅 Fonte: ${lastTabName}
                </span>
            </div>
            <div class="text-xs text-slate-300 leading-relaxed border-l-2 border-indigo-500 pl-3">
                ${data.resumo_executivo}
            </div>
            <div class="grid grid-cols-2 gap-2">
                <div class="bg-[#0f172a] p-2.5 rounded border border-white/5 hover:border-indigo-500/30">
                    <span class="text-[10px] font-bold text-purple-200 uppercase block mb-1">Perfil</span>
                    <p class="text-[10px] text-slate-400 leading-snug">${data.perfil_cliente || "-"}</p>
                </div>
                <div class="bg-[#0f172a] p-2.5 rounded border border-white/5 hover:border-emerald-500/30">
                    <span class="text-[10px] font-bold text-emerald-200 uppercase block mb-1">Estratégia</span>
                    <p class="text-[10px] text-slate-400 leading-snug italic">"${data.estrategia_relacionamento || "-"}"</p>
                </div>
            </div>
            <div class="grid grid-cols-1 gap-2">
                ${(data.checkpoints_feitos || []).length > 0 ? `
                <div class="bg-white/[0.02] p-2 rounded border border-white/5">
                    <h4 class="text-[10px] font-bold text-slate-500 uppercase mb-2">✅ Feito (${lastTabName})</h4>
                    <ul class="space-y-1">
                        ${(data.checkpoints_feitos || []).map(i => `<li class="text-[10px] text-slate-400 flex items-start gap-2"><span class="w-1 h-1 bg-green-500/50 rounded-full mt-1.5"></span><span class="flex-1">${i}</span></li>`).join('')}
                    </ul>
                </div>` : ''}
                ${(data.proximos_passos || []).length > 0 ? `
                <div class="bg-indigo-500/[0.05] p-2 rounded border border-indigo-500/20">
                    <h4 class="text-[10px] font-bold text-indigo-400 uppercase mb-2">🚀 Próximos</h4>
                    <ul class="space-y-1">
                        ${(data.proximos_passos || []).map(i => `<li class="text-[10px] text-indigo-200 flex items-start gap-2"><span class="w-1 h-1 bg-indigo-400 rounded-full mt-1.5"></span><span class="flex-1">${i}</span></li>`).join('')}
                    </ul>
                </div>` : ''}
            </div>
            <div class="flex gap-2 items-stretch">
                <div class="flex-1 bg-slate-800/50 border-white/5 border p-2 rounded flex flex-col justify-center">
                    <span class="text-[9px] uppercase font-bold text-slate-500 block mb-1">Riscos</span>
                    <p class="text-[10px] text-slate-400 leading-tight">${data.riscos_bloqueios || "Nenhum."}</p>
                </div>
                <div class="w-16 flex flex-col items-center justify-center p-1 rounded border ${scoreColor}">
                    <span class="text-[8px] uppercase font-bold opacity-70">Score</span>
                    <span class="text-xl font-bold">${score}</span>
                    <span class="text-[8px] opacity-70">/10</span>
                </div>
            </div>
        </div>
    `;

    const updatePayload = {
        doc_link: docUrl,
        resumo: htmlResumo,
        pontos_importantes: "Ver card",
        status_cliente: status_cliente,
        last_updated: new Date()
    };

    await supabase.from('empresas').update(updatePayload).eq('id', id);
    return updatePayload;
}

// --- ROTA MANUAL ---
app.post('/api/resumir-empresa', async (req, res) => {
    const { nome, id } = req.body;
    const authHeader = getHeadOfficeToken();
    if (!authHeader) return res.status(500).json({ error: "Token inválido." });

    try {
        const result = await generateCompanyIntelligence(nome, id, authHeader);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- ROTA CRON (DIÁRIA) ---
app.get('/api/cron/daily-sync', async (req, res) => {
    const authHeader = getHeadOfficeToken();
    if (!authHeader) return res.status(500).json({ error: "Token não configurado." });

    try {
        const { data: companies } = await supabase.from('empresas').select('*');
        if (!companies) return res.json({ message: "Nenhuma empresa." });

        let results = [];
        for (const emp of companies) {
            try {
                await generateCompanyIntelligence(emp.nome, emp.id, authHeader);
                results.push({ name: emp.nome, status: "Updated" });
            } catch (err) {
                results.push({ name: emp.nome, status: "Error", msg: err.message });
            }
        }
        res.json({ success: true, report: results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- API EMPRESAS ---
app.get('/api/empresas', async (req, res) => {
    const { data, error } = await supabase.from('empresas').select('*').order('nome', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

app.post('/api/empresas', async (req, res) => {
    const { nome } = req.body;
    if (!nome) return res.status(400).json({ error: "Nome obrigatório" });
    const { data, error } = await supabase.from('empresas').insert([{ nome }]).select();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, data });
});

module.exports = app;

// --- FRONTEND ATUALIZADO ---
const DASHBOARD_HTML = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CS Intelligence Hub</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/lucide@latest"></script>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Inter:wght@300;400;600;700;900&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; background-color: #020617; color: #f8fafc; overflow-x: hidden; }
        .glass-card { background: rgba(15, 23, 42, 0.6); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.08); box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3); transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
        .glass-card:hover { border-color: rgba(99, 102, 241, 0.4); transform: translateY(-4px); box-shadow: 0 20px 40px -10px rgba(99, 102, 241, 0.15); background: rgba(30, 41, 59, 0.7); }
        .badge { padding: 4px 10px; border-radius: 99px; font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; border: 1px solid; box-shadow: 0 2px 5px rgba(0,0,0,0.2); }
        
        .st-ExtremamenteSatisfeito { background: rgba(168, 85, 247, 0.15); color: #c084fc; border-color: rgba(168, 85, 247, 0.3); }
        .st-Satisfeito { background: rgba(16, 185, 129, 0.15); color: #34d399; border-color: rgba(16, 185, 129, 0.3); }
        .st-Neutro { background: rgba(250, 204, 21, 0.15); color: #fde047; border-color: rgba(250, 204, 21, 0.3); }
        .st-Insatisfeito { background: rgba(249, 115, 22, 0.15); color: #fdba74; border-color: rgba(249, 115, 22, 0.3); }
        .st-Crítico { background: rgba(239, 68, 68, 0.15); color: #fca5a5; border-color: rgba(239, 68, 68, 0.3); }
        
        .bg-grid { background-image: radial-gradient(rgba(255, 255, 255, 0.07) 1px, transparent 1px); background-size: 30px 30px; }
    </style>
</head>
<body class="min-h-screen bg-grid">
    <script>const API_URL = 'https://head-office-one.vercel.app';</script>
    <div class="fixed top-0 w-full h-[2px] bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 z-50 shadow-[0_0_20px_rgba(99,102,241,0.5)]"></div>
    <div class="max-w-[1800px] mx-auto p-6 md:p-10">
        <header class="flex flex-col md:flex-row justify-between items-center mb-10 gap-6">
            <div class="flex items-center gap-4">
                <div class="bg-indigo-600 p-2.5 rounded-lg shadow-lg shadow-indigo-500/30">
                    <i data-lucide="layout-dashboard" class="w-6 h-6 text-white"></i>
                </div>
                <div>
                    <h1 class="text-2xl font-black text-white tracking-tight">CS COMMAND CENTER</h1>
                    <p class="text-slate-400 text-xs font-medium tracking-wide">INTELLIGENCE FEED</p>
                </div>
            </div>
            <div class="flex items-center gap-3 w-full md:w-auto">
                <select id="statusFilter" onchange="loadCompanies()" class="bg-slate-900/80 border border-slate-700 text-white text-sm rounded-lg focus:ring-2 focus:ring-indigo-500 block p-2.5">
                    <option value="Todos">Todos os Status</option>
                    <option value="Extremamente Satisfeito">🟣 Extremamente Satisfeito</option>
                    <option value="Satisfeito">🟢 Satisfeito</option>
                    <option value="Neutro">🟡 Neutro</option>
                    <option value="Insatisfeito">🟠 Insatisfeito</option>
                    <option value="Crítico">🔴 Crítico</option>
                </select>
                <div class="relative group">
                    <input type="text" id="newCompanyInput" placeholder="Nova Empresa..." 
                        class="w-64 bg-slate-900/80 border border-slate-700 text-white text-sm rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 block p-2.5 pl-10 transition-all">
                    <i data-lucide="plus-circle" class="absolute left-3 top-3 w-4 h-4 text-slate-500"></i>
                </div>
                <button onclick="addCompany()" class="bg-white hover:bg-slate-200 text-slate-900 px-5 py-2.5 rounded-lg text-sm font-bold transition-all shadow-lg hover:shadow-xl flex items-center gap-2">
                    Adicionar
                </button>
            </div>
        </header>
        <div id="grid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-6 pb-20"></div>
    </div>
    <script>
        lucide.createIcons();
        async function loadCompanies() {
            const grid = document.getElementById('grid');
            const filter = document.getElementById('statusFilter').value;
            grid.innerHTML = '<div class="col-span-full flex flex-col items-center justify-center py-32 opacity-60"><i data-lucide="loader" class="animate-spin w-10 h-10 text-indigo-500 mb-4"></i><p class="text-sm font-mono text-indigo-300">ESTABLISHING UPLINK...</p></div>';
            lucide.createIcons();
            try {
                const res = await fetch(API_URL + '/api/empresas');
                let data = await res.json();
                if (filter !== "Todos") {
                    data = data.filter(emp => emp.status_cliente === filter);
                }
                grid.innerHTML = '';
                if(data.length === 0) { 
                    grid.innerHTML = '<div class="col-span-full text-center text-slate-600 py-32 font-mono">NENHUM CLIENTE ENCONTRADO.</div>'; 
                    return; 
                }
                data.forEach(emp => {
                    let sCli = (emp.status_cliente || 'Neutro').trim().replace(/\\s/g, '');
                    const contentHtml = emp.resumo && emp.resumo.includes('<div') 
                        ? emp.resumo 
                        : \`<div class="flex flex-col items-center justify-center h-40 text-slate-500 gap-2"><i data-lucide="ghost" class="w-6 h-6 opacity-30"></i><p class="text-xs">Sem inteligência gerada.</p></div>\`;
                    
                    grid.innerHTML += \`
                    <div class="glass-card rounded-2xl flex flex-col h-full relative group">
                        <div class="p-5 pb-3 border-b border-white/5">
                            <div class="flex justify-between items-start mb-3">
                                <h2 class="font-bold text-white text-lg tracking-tight truncate w-10/12 group-hover:text-indigo-300 transition-colors" title="\${emp.nome}">\${emp.nome}</h2>
                                \${emp.doc_link ? \`<a href="\${emp.doc_link}" target="_blank" class="text-slate-600 hover:text-white transition-colors p-1 hover:bg-white/10 rounded"><i data-lucide="file-text" class="w-4 h-4"></i></a>\` : ''}
                            </div>
                            <div class="flex gap-2">
                                <span class="badge st-\${sCli}">\${emp.status_cliente || 'Neutro'}</span>
                            </div>
                        </div>
                        <div class="p-5 flex-grow text-sm">
                            \${contentHtml}
                        </div>
                        <div class="p-4 mt-auto border-t border-white/5 bg-slate-900/30 rounded-b-2xl">
                            <button onclick="summarize('\${emp.nome}', \${emp.id})" id="btn-\${emp.id}" 
                                class="w-full bg-slate-800 hover:bg-indigo-600 text-slate-300 hover:text-white py-2.5 rounded-lg text-xs font-bold tracking-wide transition-all flex justify-center items-center gap-2 border border-white/5 group-hover:border-indigo-500/30">
                                <i data-lucide="zap" class="w-3 h-3"></i> 
                                \${emp.resumo ? 'REPROCESSAR DADOS' : 'INICIAR ANÁLISE'}
                            </button>
                            <div class="flex justify-between items-center mt-3 px-1">
                                <span class="text-[9px] text-slate-600 uppercase font-bold tracking-wider">Last Sync</span>
                                <span class="text-[9px] text-slate-500 font-mono">
                                    \${emp.last_updated ? new Date(emp.last_updated).toLocaleDateString() : '--/--'}
                                </span>
                            </div>
                        </div>
                    </div>\`;
                });
                lucide.createIcons();
            } catch (e) { 
                grid.innerHTML = '<div class="col-span-full text-center text-red-400 font-mono py-20">SYSTEM FAILURE: API UNREACHABLE.</div>'; 
            }
        }
        async function summarize(nome, id) {
            const btn = document.getElementById('btn-' + id);
            const originalHTML = btn.innerHTML;
            btn.disabled = true; 
            btn.className = "w-full bg-indigo-600/20 text-indigo-300 py-2.5 rounded-lg text-xs font-bold flex justify-center items-center gap-2 cursor-wait border border-indigo-500/30 animate-pulse";
            btn.innerHTML = '<i data-lucide="loader-2" class="animate-spin w-3 h-3"></i> ATUALIZANDO...';
            lucide.createIcons();
            try {
                const res = await fetch(API_URL + '/api/resumir-empresa', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ nome, id })
                });
                const json = await res.json();
                if (json.success) { 
                    loadCompanies(); 
                } else { 
                    alert('Erro: ' + (json.details || json.error)); 
                    btn.innerHTML = 'FALHA';
                    btn.className = "w-full bg-red-900/20 text-red-400 border border-red-500/30 py-2.5 rounded-lg text-xs font-bold";
                }
            } catch (e) { 
                btn.innerHTML = 'ERRO';
            } finally { 
                if(!btn.innerHTML.includes('FALHA') && !btn.innerHTML.includes('ERRO')) {
                } else {
                    setTimeout(() => { 
                        btn.disabled = false; 
                        btn.innerHTML = originalHTML; 
                        btn.className = "w-full bg-slate-800 hover:bg-indigo-600 text-slate-300 hover:text-white py-2.5 rounded-lg text-xs font-bold tracking-wide transition-all flex justify-center items-center gap-2 border border-white/5";
                        lucide.createIcons();
                    }, 3000);
                }
            }
        }
        async function addCompany() {
            const input = document.getElementById('newCompanyInput');
            const nome = input.value.trim();
            if(!nome) return;
            try {
                const res = await fetch(API_URL + '/api/empresas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nome }) });
                const json = await res.json();
                if(json.success) { input.value = ''; loadCompanies(); }
            } catch(e) {}
        }
        loadCompanies();
    </script>
</body>
</html>
`;              const json = await res.json();
                if(json.success) { input.value = ''; loadCompanies(); }
            } catch(e) {}
        }
        loadCompanies();
    </script>
</body>
</html>
`;