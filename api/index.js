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

// --- HELPER AUTH ---
function getHeadOfficeToken() {
    let rawToken = process.env.HEADOFFICE_API_KEY || process.env.HEADOFFICE_JWT || "";
    rawToken = rawToken.trim();
    if (rawToken.startsWith('"') && rawToken.endsWith('"')) rawToken = rawToken.slice(1, -1);
    if (rawToken.toLowerCase().startsWith('bearer')) {
        rawToken = rawToken.replace(/^bearer\s+/i, "").trim();
    }
    return rawToken.length > 10 ? rawToken : null;
}

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
        scopes: ['https://www.googleapis.com/auth/documents.readonly'],
    });
}

// --- 1. PARSER DE DATAS BR ---
function parseDateFromTitle(title) {
    if (!title) return null;
    const lower = title.toLowerCase();
    const meses = { 
        "jan": 0, "fev": 1, "mar": 2, "abr": 3, "mai": 4, "jun": 5, "jul": 6, "ago": 7, "set": 8, "out": 9, "nov": 10, "dez": 11,
        "janeiro": 0, "fevereiro": 1, "março": 2, "abril": 3, "maio": 4, "junho": 5, "julho": 6, "agosto": 7, "setembro": 8, "outubro": 9, "novembro": 10, "dezembro": 11
    };
    const regexExt = /(\d{1,2})\s*(?:de)?\s*([a-zç]{3,})/;
    let match = lower.match(regexExt);
    if (match) {
        const day = parseInt(match[1]);
        let monthStr = match[2];
        if (monthStr.length > 3) monthStr = monthStr.substring(0, 3);
        if (monthStr === 'mar' || monthStr === 'març') monthStr = 'mar';
        const month = meses[monthStr];
        const yearMatch = lower.match(/20\d{2}/);
        const year = yearMatch ? parseInt(yearMatch[0]) : new Date().getFullYear();
        if (month !== undefined) return new Date(year, month, day);
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

// --- 2. EXTRATOR DE TEXTO ---
function readStructuralElements(elements) {
    let text = '';
    if (!elements) return text;
    elements.forEach(element => {
        if (element.paragraph) {
            element.paragraph.elements.forEach(el => {
                if (el.textRun && el.textRun.content) {
                    text += el.textRun.content;
                }
            });
            text += "\n"; 
        } else if (element.table) {
            element.table.tableRows.forEach(row => {
                row.tableCells.forEach(cell => {
                    text += readStructuralElements(cell.content) + " | "; 
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

// --- 3. CORTE INTELIGENTE ---
function optimizeTextForGet(text) {
    if (!text) return "";
    let clean = text;
    const lower = clean.toLowerCase();
    const endMarkers = ["revise as anotações do gemini", "00:00:00", "envie feedback sobre o uso", "transcrição\n00:"];
    let cutoff = clean.length;
    for (const m of endMarkers) {
        const idx = lower.indexOf(m);
        if (idx !== -1 && idx < cutoff) cutoff = idx;
    }
    clean = clean.substring(0, cutoff).trim();
    clean = clean.replace(/\n\s*\n/g, '\n').replace(/\s+/g, ' ');
    const MAX = 1800;
    if (clean.length <= MAX) return clean;
    const stepsMarkers = ["próximas etapas", "próximos passos", "ações futuras", "encaminhamentos"];
    let stepsIdx = -1;
    for (const sm of stepsMarkers) {
        const idx = clean.toLowerCase().lastIndexOf(sm);
        if (idx !== -1) { stepsIdx = idx; break; }
    }
    if (stepsIdx !== -1) {
        const head = clean.substring(0, 800);
        const tail = clean.substring(stepsIdx, stepsIdx + 1000); 
        return `${head} ... [MEIO OMITIDO] ... ${tail}`;
    } else {
        const head = clean.substring(0, 1000);
        const tail = clean.substring(clean.length - 800);
        return `${head} ... [MEIO OMITIDO] ... ${tail}`;
    }
}

// --- BUSCAR ABAS ---
async function getAllTabsSorted(docId) {
    const auth = getGoogleAuth();
    const client = await auth.getClient();
    const docs = google.docs({ version: 'v1', auth: client });
    console.log(`[GCP] Baixando Doc: ${docId}`);
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
                tabsData.push({ title: title, date: date, timestamp: date ? date.getTime() : 0, content: content });
            }
        });
    } else {
        const content = readStructuralElements(doc.body.content);
        if (content.trim().length > 0) {
            tabsData.push({ title: "Principal", date: null, timestamp: 0, content: content });
        }
    }
    tabsData.sort((a, b) => a.timestamp - b.timestamp);
    return tabsData;
}

// --- ROTAS CRUD ---
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

// ======================================================
// LÓGICA DE INTELIGÊNCIA
// ======================================================

async function processCompanyIntelligence(id, nome, existingHistory = null) {
    const authHeader = getHeadOfficeToken();
    let docId = null;
    let docUrl = null;
    let history = existingHistory || [];

    if (!authHeader) return { success: false, error: "Token HeadOffice inválido." };

    try {
        if (!existingHistory) {
            const { data: companyData, error: historyError } = await supabase.from('empresas').select('score_history').eq('id', id).single();
            if (!historyError) history = companyData?.score_history || [];
        }

        try {
            const csvResponse = await axios.get(SHEET_CSV_URL);
            const lines = csvResponse.data.split('\n');
            for (const line of lines) {
                if (line.toLowerCase().includes(nome.toLowerCase())) {
                    const match = line.match(/\/d\/([a-zA-Z0-9_-]+)/);
                    if (match) { docId = match[1]; docUrl = `https://docs.google.com/document/d/${docId}`; break; }
                }
            }
        } catch (e) { console.warn(`CSV Error: ${e.message}`); }

        if (!docId) return { success: false, error: `Link não encontrado para ${nome}.` };

        let allTabs = [];
        try {
            allTabs = await getAllTabsSorted(docId);
            if (allTabs.length === 0) return { success: false, error: "Doc vazio." };
        } catch (apiError) { return { success: false, error: "Erro GCP: " + apiError.message }; }

        let currentMemory = "Início da análise.";
        for (let i = 0; i < allTabs.length; i++) {
            const tab = allTabs[i];
            const isLast = i === allTabs.length - 1;
            const cleanContent = optimizeTextForGet(tab.content);
            
            let prompt = "";
            let contextForUrl = "";

            if (!isLast) {
                prompt = `ATUE COMO CS MANAGER. REUNIÃO PASSADA: ${tab.title}. MEMÓRIA ATUAL: ${currentMemory}. RESUMO DESTA REUNIÃO: ${cleanContent}. INSTRUÇÃO: Atualize a memória com fatos importantes. Seja conciso.`;
                contextForUrl = `MEMORIA_PREVIA`; 
            } else {
                prompt = `ATUE COMO DIRETOR DE CS. ESTA É A ÚLTIMA REUNIÃO (${tab.title}).
                
                --- MISSÃO FINAL ---
                Gere o Relatório de Inteligência Estratégico.
                
                DADOS DE ENTRADA:
                1. Histórico Prévio (Perfil/Sentimento): ${currentMemory.slice(0, 600)}
                2. TEXTO DA ÚLTIMA REUNIÃO:
                ${cleanContent}
                
                REGRAS RÍGIDAS PARA 'sentimento_score':
                1. AVALIE ESTRITAMENTE O HUMOR E A EMOÇÃO DO CLIENTE com base no texto. IGNORE o progresso de tarefas ou cronogramas. O score reflete o SENTIMENTO do cliente, não o status do projeto.
                2. PONTO DE PARTIDA: Comece com um score base de 8 (Satisfeito/Colaborativo). A partir daí, ajuste para cima ou para baixo.
                3. AUMENTE O SCORE (9-10) APENAS se houver elogios explícitos, claros e entusiasmados sobre o serviço, a plataforma ou a equipe. Exemplos: "excelente", "incrível", "muito contente", "adorando". Um cliente que é apenas "colaborativo" ou "positivo" é um 7-8, não um 10.
                4. MANTENHA O SCORE (7-8) se a conversa for positiva, construtiva e colaborativa, mesmo que existam problemas a serem resolvidos. A ausência de negatividade forte mantém a nota alta.
                5. REDUZA O SCORE (0-6) APENAS se houver sinais negativos claros: frustração, preocupação, crítica, impaciência, atritos, desinteresse, apatia ou linguagem hostil.
                6. EXEMPLOS PRÁTICOS:
                   - Projeto atrasado, mas cliente calmo e ajudando a resolver: Score 7-8.
                   - Projeto em dia, mas cliente irritado com um detalhe: Score 3-4.
                   - Cliente elogia muito a plataforma ("estou extremamente contente"): Score 10.
                   - Cliente colaborativo e positivo, sem grandes elogios: Score 7-8.
                7. 'proximos_passos' e 'checkpoints_feitos' devem ser extraídos SOMENTE do "TEXTO DA ÚLTIMA REUNIÃO". Se o texto citar Felipe, Barbara, William, use os nomes.
                8. Nunca fabrique dados ou invente tarefas.
        
                FORMATO DE RESPOSTA:
                JSON ESTRITO (Responda APENAS o JSON):
                {"resumo_executivo": "...", "perfil_cliente": "...", "estrategia_relacionamento": "...", "checkpoints_feitos": [], "proximos_passos": [], "riscos_bloqueios": "...", "sentimento_score": "0-10"}`;
            }

            let respostaIA = "";
            for (let retry = 0; retry < 2; retry++) {
                try {
                    const response = await axios.get(`${BASE_URL}/openai/question`, {
                        params: { aiName: BOT_NAME, aiId: BOT_ID, question: prompt, context: isLast ? "Foco na última reunião" : "Atualizando memória" },
                        headers: { 'Authorization': authHeader },
                        timeout: 40000
                    });
                    const tResp = response.data.text || response.data.answer;
                    if (tResp && tResp.trim().length > 2) { respostaIA = tResp; break; }
                } catch (e) { 
                    if (e.response && e.response.status === 414) {
                        try {
                            const miniContext = "Resumo curto";
                            const r2 = await axios.get(`${BASE_URL}/openai/question`, { params: { aiName: BOT_NAME, aiId: BOT_ID, question: prompt, context: miniContext }, headers: { 'Authorization': authHeader } });
                            respostaIA = r2.data.text || r2.data.answer;
                        } catch(e2) {}
                    }
                }
            }
            if (respostaIA) currentMemory = respostaIA;
        }

        const jsonOnly = extractJSON(currentMemory);
        let data = {};
        try { data = JSON.parse(jsonOnly); } catch (e) { data = { resumo_executivo: "Erro ao processar JSON." }; }

        const newScore = parseInt(data.sentimento_score, 10) || 5;
        history.push({ score: newScore, date: new Date().toISOString() });
        const updatedHistory = history.slice(-12);

        let scoreColor, statusCliente;
        if (newScore >= 9) { statusCliente = "Extremamente Satisfeito"; scoreColor = "text-cyan-400 border-cyan-500/30 bg-cyan-500/10"; }
        else if (newScore >= 7) { statusCliente = "Satisfeito"; scoreColor = "text-emerald-400 border-emerald-500/30 bg-emerald-500/10"; }
        else if (newScore >= 5) { statusCliente = "Neutro"; scoreColor = "text-yellow-400 border-yellow-500/30 bg-yellow-500/10"; }
        else if (newScore >= 3) { statusCliente = "Insatisfeito"; scoreColor = "text-orange-400 border-orange-500/30 bg-orange-500/10"; }
        else { statusCliente = "Crítico"; scoreColor = "text-red-400 border-red-500/30 bg-red-500/10"; }

        const temperatura = data.temperatura_geral;
        let temperaturaHtml = '';
        if (temperatura) {
            let tempIcon = 'minus'; let tempColor = 'text-yellow-400';
            if (temperatura === 'aquecendo') { tempIcon = 'trending-up'; tempColor = 'text-emerald-400'; }
            if (temperatura === 'esfriando') { tempIcon = 'trending-down'; tempColor = 'text-red-400'; }
            temperaturaHtml = `<div class="flex-1 bg-slate-800/50 border-white/5 border p-2 rounded flex flex-col justify-center items-center"><span class="text-[9px] uppercase font-bold text-slate-500 block mb-1">Temperatura</span><div class="flex items-center gap-1.5 ${tempColor}"><i data-lucide="${tempIcon}" class="w-3 h-3"></i><span class="text-[10px] font-bold uppercase">${temperatura}</span></div></div>`;
        }

        const lastTabName = allTabs.length > 0 ? allTabs[allTabs.length-1].title : "Geral";
        const htmlResumo = `
            <div class="space-y-4 font-sans">
                <div class="flex items-center justify-between mb-2">
                    <span class="text-[9px] uppercase font-mono text-indigo-300 bg-indigo-500/10 px-2 py-1 rounded border border-indigo-500/20">📅 Fonte: ${lastTabName}</span>
                </div>
                <div class="text-xs text-slate-300 leading-relaxed border-l-2 border-indigo-500 pl-3">${data.resumo_executivo}</div>
                <div class="grid grid-cols-2 gap-2">
                    <div class="bg-[#0f172a] p-2.5 rounded border border-white/5"><div class="flex items-center gap-2 mb-1"><i data-lucide="brain" class="w-3 h-3 text-purple-400"></i><span class="text-[10px] font-bold text-purple-200 uppercase">Perfil</span></div><p class="text-[10px] text-slate-400 leading-snug">${data.perfil_cliente || "-"}</p></div>
                    <div class="bg-[#0f172a] p-2.5 rounded border border-white/5"><div class="flex items-center gap-2 mb-1"><i data-lucide="compass" class="w-3 h-3 text-emerald-400"></i><span class="text-[10px] font-bold text-emerald-200 uppercase">Ação</span></div><p class="text-[10px] text-slate-400 leading-snug italic">"${data.estrategia_relacionamento || "-"}"</p></div>
                </div>
                <div class="grid grid-cols-1 gap-2">
                    ${(data.checkpoints_feitos || []).length > 0 ? `<div class="bg-white/[0.02] p-2 rounded border border-white/5"><h4 class="text-[10px] font-bold text-slate-500 uppercase mb-2 flex items-center gap-1"><i data-lucide="check-circle-2" class="w-3 h-3"></i> Concluído (${lastTabName})</h4><ul class="space-y-1">${(data.checkpoints_feitos || []).map(i => `<li class="text-[10px] text-slate-400 flex items-start gap-2"><span class="w-1 h-1 bg-green-500/50 rounded-full mt-1.5"></span><span class="flex-1">${i}</span></li>`).join('')}</ul></div>` : ''}
                    ${(data.proximos_passos || []).length > 0 ? `<div class="bg-indigo-500/[0.05] p-2 rounded border border-indigo-500/20"><h4 class="text-[10px] font-bold text-indigo-400 uppercase mb-2 flex items-center gap-1"><i data-lucide="arrow-right-circle" class="w-3 h-3"></i> Próximos Passos</h4><ul class="space-y-1">${(data.proximos_passos || []).map(i => `<li class="text-[10px] text-indigo-200 flex items-start gap-2"><span class="w-1 h-1 bg-indigo-400 rounded-full mt-1.5"></span><span class="flex-1">${i}</span></li>`).join('')}</ul></div>` : ''}
                </div>
                <div class="flex gap-2 items-stretch">
                    <div class="flex-1 bg-slate-800/50 border-white/5 border p-2 rounded flex flex-col justify-center"><span class="text-[9px] uppercase font-bold text-slate-500 block mb-1">Riscos</span><p class="text-[10px] text-slate-400 leading-tight">${data.riscos_bloqueios || "Nenhum."}</p></div>
                    ${temperaturaHtml}
                    <div class="w-16 flex flex-col items-center justify-center p-1 rounded border ${scoreColor}"><span class="text-[8px] uppercase font-bold opacity-70">Score</span><span class="text-xl font-bold">${newScore}</span><span class="text-[8px] opacity-70">/10</span></div>
                </div>
            </div>`;

        const updatePayload = { doc_link: docUrl, resumo: htmlResumo, pontos_importantes: "Ver card", score_history: updatedHistory, status_cliente: statusCliente, last_updated: new Date() };
        await supabase.from('empresas').update(updatePayload).eq('id', id);
        return { success: true, data: { ...updatePayload, id, nome } };

    } catch (error) {
        console.error(`[ERRO FATAL] para ${nome}:`, error.message);
        return { success: false, error: "Falha de processamento", details: error.message };
    }
}

app.post('/api/resumir-empresa', async (req, res) => {
    const { nome, id } = req.body;
    try {
        const result = await processCompanyIntelligence(id, nome);
        if (!result || !result.success) return res.status(500).json(result);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: "Erro inesperado.", details: error.message });
    }
});

app.get('/api/cron/daily-update', async (req, res) => {
    try {
        const { data: companies } = await supabase.from('empresas').select('*');
        if (!companies) return res.json({ message: "Nenhuma empresa." });
        const results = [];
        for (const company of companies) {
            const result = await processCompanyIntelligence(company.id, company.nome, company.score_history);
            results.push({ company: company.nome, success: result.success });
        }
        res.json({ status: "Ciclo diário concluído", details: results });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug-bot', async (req, res) => {
    try {
        const rawToken = getHeadOfficeToken();
        const response = await axios.get(`${BASE_URL}/openai/question`, { params: { aiName: BOT_NAME, aiId: BOT_ID, question: "Olá" }, headers: { 'Authorization': rawToken } });
        res.json({ text: response.data.text, full: response.data });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = app;

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
        .st-ExtremamenteSatisfeito { background: rgba(6, 182, 212, 0.1); color: #22d3ee; border-color: rgba(6, 182, 212, 0.3); }
        .st-Satisfeito { background: rgba(16, 185, 129, 0.15); color: #34d399; border-color: rgba(16, 185, 129, 0.3); }
        .st-Neutro { background: rgba(234, 179, 8, 0.1); color: #facc15; border-color: rgba(234, 179, 8, 0.3); }
        .st-Insatisfeito { background: rgba(249, 115, 22, 0.1); color: #fb923c; border-color: rgba(249, 115, 22, 0.3); }
        .st-Crítico { background: rgba(239, 68, 68, 0.15); color: #fca5a5; border-color: rgba(239, 68, 68, 0.3); }
        .bg-grid { background-image: radial-gradient(rgba(255, 255, 255, 0.07) 1px, transparent 1px); background-size: 30px 30px; }
        .is-unlinked { opacity: 0.6; filter: grayscale(60%); transition: all 0.4s ease-in-out; }
        .is-unlinked:hover { opacity: 1; filter: grayscale(0%); transform: translateY(-4px); }
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
                    <p class="text-slate-400 text-xs font-medium tracking-wide">REAL-TIME INTELLIGENCE FEED</p>
                </div>
            </div>
            <div class="flex items-center gap-3 w-full md:w-auto flex-wrap justify-end">
                <div class="relative"><input type="text" id="searchFilter" oninput="applyFilters()" placeholder="Buscar empresa..." class="w-56 bg-slate-900/80 border border-slate-700 text-white text-sm rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 block p-2.5 pl-10 transition-all"><i data-lucide="search" class="absolute left-3 top-3 w-4 h-4 text-slate-500 pointer-events-none"></i></div>
                <div class="relative"><select id="statusFilter" onchange="applyFilters()" class="bg-slate-900/80 border border-slate-700 text-white text-sm rounded-lg focus:ring-2 focus:ring-indigo-500 block p-2.5 pr-8 appearance-none cursor-pointer"><option value="all">Todos</option><option value="Extremamente Satisfeito">Extremamente Satisfeitos</option><option value="Satisfeito">Satisfeitos</option><option value="Neutro">Neutros</option><option value="Insatisfeito">Insatisfeitos</option><option value="Crítico">Críticos</option></select><i data-lucide="filter" class="absolute right-3 top-3 w-4 h-4 text-slate-500 pointer-events-none"></i></div>
                <div class="relative group"><input type="text" id="newCompanyInput" placeholder="Nova Empresa..." class="w-56 bg-slate-900/80 border border-slate-700 text-white text-sm rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 block p-2.5 pl-10 transition-all"><i data-lucide="plus-circle" class="absolute left-3 top-3 w-4 h-4 text-slate-500"></i></div>
                <button onclick="addCompany()" class="bg-white hover:bg-slate-200 text-slate-900 px-5 py-2.5 rounded-lg text-sm font-bold transition-all shadow-lg hover:shadow-xl flex items-center gap-2">Adicionar</button>
            </div>
        </header>
        <div id="grid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-6 pb-20"></div>
        <div id="historyModal" class="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-[100] hidden" onclick="closeModal()"><div class="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-2xl shadow-2xl shadow-indigo-500/10" onclick="event.stopPropagation()"><div class="p-5 border-b border-slate-800 flex justify-between items-center"><h3 id="modalTitle" class="text-lg font-bold text-white">Histórico de Sentimento</h3><button onclick="closeModal()" class="text-slate-500 hover:text-white p-2 -mr-2 rounded-full transition-colors"><i data-lucide="x" class="w-5 h-5"></i></button></div><div id="modalContent" class="p-6 bg-slate-900/50 rounded-b-2xl"></div></div></div>
    </div>
    <script>
        lucide.createIcons();
        async function loadCompanies() {
            const grid = document.getElementById('grid');
            const gridContent = grid.innerHTML;
            if(!gridContent.includes('glass-card')) {
               grid.innerHTML = '<div class="col-span-full flex flex-col items-center justify-center py-32 opacity-60"><i data-lucide="loader" class="animate-spin w-10 h-10 text-indigo-500 mb-4"></i><p class="text-sm font-mono text-indigo-300">ESTABLISHING UPLINK...</p></div>';
            }
            lucide.createIcons();
            try {
                const res = await fetch(API_URL + '/api/empresas');
                const data = await res.json();
                grid.innerHTML = '';
                if(data.length === 0) { grid.innerHTML = '<div class="col-span-full text-center text-slate-600 py-32 font-mono">NO ACTIVE CLIENTS.</div>'; return; }
                data.forEach(emp => {
                    const sCli = (emp.status_cliente || 'Neutro').replace(/\\s/g, '');
                    const historyJson = JSON.stringify(emp.score_history || []);
                    const contentHtml = emp.resumo && emp.resumo.includes('<div') ? emp.resumo : \`<div class="flex flex-col items-center justify-center h-40 text-slate-500 gap-2"><i data-lucide="ghost" class="w-6 h-6 opacity-30"></i><p class="text-xs">Sem inteligência gerada.</p></div>\`;
                    const cardClass = emp.doc_link ? 'glass-card' : 'glass-card is-unlinked bg-slate-950/40 border-slate-800';
                    const iconLink = emp.doc_link ? \`<a href="\${emp.doc_link}" target="_blank" class="text-slate-600 hover:text-white transition-colors p-1 hover:bg-white/10 rounded"><i data-lucide="file-text" class="w-4 h-4"></i></a>\` : \`<span class="text-slate-700 cursor-not-allowed" title="Sem Link"><i data-lucide="link-2-off" class="w-4 h-4"></i></span>\`;

                    grid.innerHTML += \`
                    <div id="card-\${emp.id}" class="\${cardClass} rounded-2xl flex flex-col h-full relative group company-card" data-status="\${emp.status_cliente || 'Neutro'}">
                        <div class="p-5 pb-3 border-b border-white/5">
                            <div class="flex justify-between items-start mb-3"><h2 class="font-bold text-white text-lg tracking-tight truncate w-10/12 group-hover:text-indigo-300 transition-colors" title="\${emp.nome}">\${emp.nome}</h2>\${iconLink}</div>
                            <div class="flex gap-2"><span class="badge st-\${sCli}">\${emp.status_cliente || 'PENDENTE'}</span></div>
                        </div>
                        <div class="p-5 flex-grow text-sm">\${contentHtml}</div>
                        <div class="p-4 mt-auto border-t border-white/5 bg-slate-900/30 rounded-b-2xl flex flex-col gap-3">
                            <div class="flex gap-2">
                                <button onclick="summarize('\${emp.nome.replace(/'/g, "\\\\'")}', \${emp.id})" id="btn-\${emp.id}" class="flex-grow bg-slate-800 hover:bg-indigo-600 text-slate-300 hover:text-white py-2.5 rounded-lg text-xs font-bold tracking-wide transition-all flex justify-center items-center gap-2 border border-white/5 group-hover:border-indigo-500/30"><i data-lucide="zap" class="w-3 h-3"></i> \${emp.resumo ? 'REPROCESSAR' : 'ANALISAR'}</button>
                                <button onclick='if((emp.score_history || []).length > 1) openHistoryModal(\${historyJson}, \`\${emp.nome.replace(/'/g, "\\\\'")}\`)' class="w-12 flex-shrink-0 flex items-center justify-center bg-slate-800 rounded-lg border border-white/5 \${(emp.score_history || []).length > 1 ? 'hover:bg-indigo-600 hover:border-indigo-500/30 cursor-pointer' : 'opacity-50 cursor-not-allowed'}" title="Ver Histórico de Score"><i data-lucide="bar-chart-3" class="w-4 h-4 text-slate-300"></i></button>
                            </div>
                            <div class="flex justify-between items-center px-1"><span class="text-[9px] text-slate-600 uppercase font-bold tracking-wider">Last Sync</span><span class="text-[9px] text-slate-500 font-mono">\${emp.last_updated ? new Date(emp.last_updated).toLocaleDateString() : '--/--'}</span></div>
                        </div>
                    </div>\`;
                });
                lucide.createIcons();
                applyFilters();
            } catch (e) { grid.innerHTML = '<div class="col-span-full text-center text-red-400 font-mono py-20">SYSTEM FAILURE: API UNREACHABLE.</div>'; }
        }
        function applyFilters() {
            const statusFilter = document.getElementById('statusFilter').value;
            const searchFilter = document.getElementById('searchFilter').value.toLowerCase();
            const cards = document.querySelectorAll('.company-card');
            cards.forEach(card => {
                const status = card.getAttribute('data-status');
                const name = card.querySelector('h2').getAttribute('title').toLowerCase();
                const statusMatch = (statusFilter === 'all' || status === statusFilter);
                const nameMatch = name.includes(searchFilter);
                if (statusMatch && nameMatch) { card.style.display = 'flex'; } else { card.style.display = 'none'; }
            });
        }
        async function summarize(nome, id) {
            const btn = document.getElementById('btn-' + id);
            const card = document.getElementById('card-' + id);
            const originalHTML = btn.innerHTML;
            
            // Add Overlay
            let overlay = null;
            if (card) {
                overlay = document.createElement('div');
                overlay.className = 'absolute inset-0 bg-slate-900/80 flex flex-col items-center justify-center rounded-2xl z-10 backdrop-blur-sm transition-all duration-300';
                overlay.innerHTML = '<i data-lucide="loader-2" class="animate-spin w-10 h-10 text-indigo-400"></i><p class="mt-3 text-xs text-indigo-300 font-mono animate-pulse">REPROCESSANDO...</p>';
                card.appendChild(overlay);
                lucide.createIcons();
            }

            btn.disabled = true; 
            btn.className = "w-full bg-indigo-600/20 text-indigo-300 py-2.5 rounded-lg text-xs font-bold flex justify-center items-center gap-2 cursor-wait border border-indigo-500/30 animate-pulse";
            btn.innerHTML = '<i data-lucide="loader-2" class="animate-spin w-3 h-3"></i> PROCESSANDO...';
            
            lucide.createIcons();
            
            try {
                const res = await fetch(API_URL + '/api/resumir-empresa', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nome, id }) });
                const json = await res.json();
                if (json.success) { loadCompanies(); } else { throw new Error(json.details || json.error); }
            } catch (e) { 
                alert('Erro: ' + e.message); 
                btn.innerHTML = 'FALHA'; 
                btn.className = "w-full bg-red-900/20 text-red-400 border border-red-500/30 py-2.5 rounded-lg text-xs font-bold";
                if(overlay) overlay.remove();
                
                setTimeout(() => { 
                    btn.disabled = false; 
                    btn.innerHTML = originalHTML; 
                    btn.className = "w-full bg-slate-800 hover:bg-indigo-600 text-slate-300 hover:text-white py-2.5 rounded-lg text-xs font-bold tracking-wide transition-all flex justify-center items-center gap-2 border border-white/5"; 
                    lucide.createIcons(); 
                }, 3000);
            }
        }
        async function addCompany() {
            const input = document.getElementById('newCompanyInput');
            const nome = input.value.trim();
            if(!nome) return;
            try { const res = await fetch(API_URL + '/api/empresas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nome }) }); const json = await res.json(); if(json.success) { input.value = ''; loadCompanies(); } } catch(e) {}
        }
        function openHistoryModal(history, companyName) {
            if (!history || history.length < 2) return;
            const modal = document.getElementById('historyModal');
            document.getElementById('modalTitle').innerText = \`Histórico: \${companyName}\`;
            document.getElementById('modalContent').innerHTML = generateChartSVG(history);
            modal.classList.remove('hidden');
        }
        function closeModal() { document.getElementById('historyModal').classList.add('hidden'); }
        function generateChartSVG(history) {
            if (!history || history.length < 2) return \`<div class="text-center text-slate-500 py-10">Dados insuficientes.</div>\`;
            const W = 570, H = 250, PADDING = 40;
            const points = history.map((p, i) => ({ x: PADDING + i * (W - 2 * PADDING) / (history.length - 1), y: H - PADDING - (p.score / 10) * (H - 2 * PADDING), score: p.score, date: new Date(p.date) }));
            const pathD = "M" + points.map(p => \`\${p.x.toFixed(2)} \${p.y.toFixed(2)}\`).join(" L");
            const circles = points.map(p => \`<g transform="translate(\${p.x}, \${p.y})"><circle cx="0" cy="0" r="8" fill="#6366f1" fill-opacity="0.2" /><circle cx="0" cy="0" r="4" fill="#a5b4fc" stroke="#0f172a" stroke-width="2" /></g>\`).join('');
            const xLabels = points.map((p, i) => { if (history.length > 10 && i % 2 !== 0 && i !== history.length - 1 && i !== 0) return ''; const dateStr = p.date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }); return \`<text x="\${p.x}" y="\${H - PADDING + 20}" fill="#94a3b8" font-size="10" text-anchor="middle">\${dateStr}</text>\`; }).join('');
            const yLabels = [0, 2, 4, 6, 8, 10].map(score => { const y = H - PADDING - (score / 10) * (H - 2 * PADDING); return \`<text x="\${PADDING - 10}" y="\${y}" fill="#94a3b8" font-size="10" text-anchor="end" dominant-baseline="middle">\${score}</text><line x1="\${PADDING}" y1="\${y}" x2="\${W - PADDING}" y2="\${y}" stroke="#334155" stroke-width="0.5" />\`; }).join('');
            return \`<svg width="100%" height="\${H}" viewBox="0 0 \${W} \${H}">\${yLabels}<path d="\${pathD}" fill="none" stroke="#6366f1" stroke-width="2" />\${circles}\${xLabels}</svg>\`;
        }
        loadCompanies();
    </script>
</body>
</html>
`;