require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

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
const SHEET_FULL_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;

// ID DO BOT ROGER
const BOT_ID = '69372353b11d9df606b68bf8';
const BOT_NAME = 'Roger';

// --- ROTA DASHBOARD ---
app.get('/', (req, res) => {
    const currentUrl = `https://${req.headers.host}`;
    const htmlComUrl = DASHBOARD_HTML.replace('https://head-office-one.vercel.app', currentUrl);
    res.send(htmlComUrl);
});

// --- HELPER AUTH (HEADOFFICE) ---
function getHeadOfficeToken() {
    const TOKEN_DE_EMERGENCIA = ""; 
    let rawToken = TOKEN_DE_EMERGENCIA || process.env.HEADOFFICE_API_KEY || process.env.HEADOFFICE_JWT || "";
    rawToken = rawToken.trim();
    if (rawToken.startsWith('"') && rawToken.endsWith('"')) rawToken = rawToken.slice(1, -1);
    return rawToken.length > 10 ? rawToken : null;
}

// --- HELPER GOOGLE DOCS API (GCP) ---
async function getGoogleDocContent(docId) {
    const apiKey = process.env.GOOGLE_API_KEY; // SUA CHAVE DO GCP AQUI
    if (!apiKey) throw new Error("GOOGLE_API_KEY não configurada na Vercel.");

    try {
        const url = `https://docs.googleapis.com/v1/documents/${docId}?key=${apiKey}`;
        const response = await axios.get(url);
        const doc = response.data;
        
        // O Google devolve um JSON complexo. Precisamos extrair o texto de cada parágrafo.
        let fullText = "";
        if (doc.body && doc.body.content) {
            doc.body.content.forEach(struc => {
                if (struc.paragraph) {
                    struc.paragraph.elements.forEach(elem => {
                        if (elem.textRun) {
                            fullText += elem.textRun.content;
                        }
                    });
                }
            });
        }
        return fullText;
    } catch (error) {
        if (error.response && error.response.status === 403) {
            throw new Error("Permissão negada pelo Google. O documento precisa estar público (Leitor) ou a API Key não tem acesso.");
        }
        throw error;
    }
}

// --- HELPER TEXT SPLIT ---
function splitText(text, chunkSize) {
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize) {
        chunks.push(text.substring(i, i + chunkSize));
    }
    return chunks;
}

// --- HELPER JSON PARSE ---
function extractJSON(text) {
    if (!text) return null;
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
        return text.substring(start, end + 1);
    }
    return text;
}

// --- ROTAS CRUD EMPRESAS ---
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
// LÓGICA DE INTELIGÊNCIA ARTIFICIAL (CS INTELLIGENCE V2)
// ======================================================

app.post('/api/resumir-empresa', async (req, res) => {
    const { nome, id } = req.body;
    const authHeader = getHeadOfficeToken();

    if (!authHeader) return res.status(500).json({ error: "Token HeadOffice inválido." });

    let step = "Início";
    let docUrl = null;
    let docId = null;

    try {
        // 1. Encontrar Link no CSV
        step = "Buscando Link no CSV";
        try {
            const csvResponse = await axios.get(SHEET_CSV_URL);
            const lines = csvResponse.data.split('\n');
            for (const line of lines) {
                if (line.toLowerCase().includes(nome.toLowerCase())) {
                    const match = line.match(/(https:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+))/);
                    if (match) { 
                        docUrl = match[0]; 
                        docId = match[2];
                        break; 
                    }
                }
            }
        } catch (e) { console.warn("CSV falhou."); }

        if (!docUrl) return res.json({ success: false, error: `Link não encontrado na planilha para ${nome}.` });

        // 2. Extração via GCP (INFALÍVEL SE TIVER PERMISSÃO)
        step = `Lendo Google Docs (API Oficial)`;
        let fullText = "";
        
        try {
            fullText = await getGoogleDocContent(docId);
            
            // Validação Anti-Alucinação
            if (!fullText || fullText.trim().length < 20) {
                return res.json({ success: false, error: "O documento está vazio. A IA não tem o que ler." });
            }
        } catch (apiError) {
            console.error("Erro GCP:", apiError.message);
            return res.json({ 
                success: false, 
                error: `Erro ao ler Doc via Google API: ${apiError.message}. Verifique se o doc é público e se a API Key está válida.` 
            });
        }

        // 3. ANÁLISE PROFUNDA (CHAIN)
        step = "Processamento Neural CS";
        
        // Pega os últimos 20.000 caracteres para ter muito contexto
        const relevantText = fullText.slice(-20000); 
        const chunks = splitText(relevantText, 3000); // 3k chars por chunk
        console.log(`[CHAIN] Processando ${chunks.length} blocos de texto real.`);

        let currentMemory = "";

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const isLast = i === chunks.length - 1;
            const safeMemory = currentMemory.length > 1500 ? currentMemory.substring(0, 1500) + "..." : currentMemory;

            // --- PROMPT CS SÊNIOR (ANTI-ALUCINAÇÃO) ---
            const prompt = isLast 
                ? `ATUE COMO UM SÊNIOR CUSTOMER SUCCESS MANAGER.
                   Analise o texto real fornecido abaixo (transcrição de reunião/doc).
                   
                   🚨 REGRA CRÍTICA: Se o texto não contiver informações suficientes, escreva "Não informado no texto" no campo correspondente. NUNCA INVENTE DADOS ("A conta X", "01/01/2022"). USE APENAS FATOS DO TEXTO.

                   Gere um Relatório de Inteligência JSON estrito:
                   {
                      "resumo_executivo": "Onde estamos HOJE? Qual o foco da semana? Use nomes reais citados.",
                      "perfil_cliente": "Psicologia do cliente: Ele é detalhista? Apressado? Visionário? Como ele reage a problemas?",
                      "estrategia_relacionamento": "Como o CS deve agir? (Ex: 'Seja proativo no WhatsApp', 'Formalize tudo por email').",
                      "checkpoints_concluidos": ["Lista do que FOI FEITO recentemente"],
                      "proximos_passos": ["Lista do que SERÁ FEITO e QUEM fará"],
                      "riscos_bloqueios": "O que está impedindo o sucesso? Alguma reclamação?",
                      "sentimento_score": "Número de 0 a 10 (0=Furioso, 10=Fã)",
                      "status_projeto": "Em Dia/Atrasado/Pausado"
                   }`
                : `Analise este trecho da transcrição. Extraia fatos, datas e sentimentos. Ignore conversas fiadas ("bom dia"). Acumule inteligência para o relatório final.`;

            let respostaIA = "";
            for (let retry = 0; retry < 2; retry++) {
                try {
                    const response = await axios.get(`${BASE_URL}/openai/question`, {
                        params: {
                            aiName: BOT_NAME,
                            aiId: BOT_ID,
                            context: `CONTEXTO ACUMULADO: ${safeMemory || "Início da leitura"}\n\nTEXTO ORIGINAL DO DOC:\n${chunk}`,
                            question: prompt
                        },
                        headers: { 'Authorization': authHeader }
                    });
                    
                    const textoResposta = response.data.text || response.data.answer;
                    if (textoResposta && textoResposta.trim().length > 0) {
                        respostaIA = textoResposta;
                        break; 
                    }
                } catch (e) { console.error("Erro IA:", e.message); }
            }

            if (respostaIA) currentMemory = respostaIA;
        }

        // 4. RENDERIZAÇÃO VISUAL (FRONTEND INSIDE BACKEND)
        step = "Gerando Visualização";
        if (!currentMemory) return res.json({ success: false, error: `IA não retornou análise.` });

        const jsonOnly = extractJSON(currentMemory);
        let data = {};

        try {
            data = JSON.parse(jsonOnly);
        } catch (e) {
            data = { resumo_executivo: "Erro ao estruturar dados: " + currentMemory.substring(0, 200) };
        }

        // Definição de Cores baseada no Score
        const score = parseInt(data.sentimento_score) || 5;
        let scoreColor = "text-yellow-400 border-yellow-500/30 bg-yellow-500/10";
        if (score >= 8) scoreColor = "text-emerald-400 border-emerald-500/30 bg-emerald-500/10";
        if (score <= 4) scoreColor = "text-red-400 border-red-500/30 bg-red-500/10";

        const htmlResumo = `
            <div class="space-y-4 font-sans">
                <div class="text-xs text-slate-300 leading-relaxed border-l-2 border-indigo-500 pl-3">
                    ${data.resumo_executivo}
                </div>

                <div class="grid grid-cols-2 gap-2">
                    <div class="bg-[#0f172a] p-2.5 rounded border border-white/5 hover:border-indigo-500/30 transition-colors">
                        <div class="flex items-center gap-2 mb-1">
                            <i data-lucide="brain" class="w-3 h-3 text-purple-400"></i>
                            <span class="text-[10px] font-bold text-purple-200 uppercase tracking-wide">Perfil</span>
                        </div>
                        <p class="text-[10px] text-slate-400 leading-snug">${data.perfil_cliente || "-"}</p>
                    </div>
                    <div class="bg-[#0f172a] p-2.5 rounded border border-white/5 hover:border-emerald-500/30 transition-colors">
                        <div class="flex items-center gap-2 mb-1">
                            <i data-lucide="message-square" class="w-3 h-3 text-emerald-400"></i>
                            <span class="text-[10px] font-bold text-emerald-200 uppercase tracking-wide">Estratégia</span>
                        </div>
                        <p class="text-[10px] text-slate-400 leading-snug italic">"${data.estrategia_relacionamento || "-"}"</p>
                    </div>
                </div>

                <div class="grid grid-cols-1 gap-2">
                    ${(data.checkpoints_feitos && data.checkpoints_feitos.length > 0) ? `
                    <div class="bg-white/[0.02] p-2 rounded border border-white/5">
                        <h4 class="text-[10px] font-bold text-slate-500 uppercase mb-2 flex items-center gap-1"><i data-lucide="check-circle-2" class="w-3 h-3"></i> Concluído</h4>
                        <ul class="space-y-1">
                            ${data.checkpoints_feitos.map(i => `<li class="text-[10px] text-slate-400 flex items-start gap-2"><span class="w-1 h-1 bg-green-500/50 rounded-full mt-1.5"></span><span class="flex-1">${i}</span></li>`).join('')}
                        </ul>
                    </div>` : ''}
                    
                    ${(data.proximos_passos && data.proximos_passos.length > 0) ? `
                    <div class="bg-indigo-500/[0.05] p-2 rounded border border-indigo-500/20">
                        <h4 class="text-[10px] font-bold text-indigo-400 uppercase mb-2 flex items-center gap-1"><i data-lucide="arrow-right-circle" class="w-3 h-3"></i> Próximos Passos</h4>
                        <ul class="space-y-1">
                            ${data.proximos_passos.map(i => `<li class="text-[10px] text-indigo-200 flex items-start gap-2"><span class="w-1 h-1 bg-indigo-400 rounded-full mt-1.5"></span><span class="flex-1">${i}</span></li>`).join('')}
                        </ul>
                    </div>` : ''}
                </div>

                <div class="flex gap-2 items-stretch">
                    <div class="flex-1 ${data.riscos_bloqueios ? 'bg-red-500/10 border-red-500/20' : 'bg-slate-800/50 border-white/5'} border p-2 rounded flex flex-col justify-center">
                        <span class="text-[9px] uppercase font-bold ${data.riscos_bloqueios ? 'text-red-400' : 'text-slate-500'} block mb-1">Pontos de Atenção</span>
                        <p class="text-[10px] ${data.riscos_bloqueios ? 'text-red-200' : 'text-slate-500'} leading-tight">${data.riscos_bloqueios || "Nenhum risco crítico detectado."}</p>
                    </div>
                    <div class="w-16 flex flex-col items-center justify-center p-1 rounded border ${scoreColor}">
                        <span class="text-[8px] uppercase font-bold opacity-70">Score</span>
                        <span class="text-xl font-bold">${score}</span>
                        <span class="text-[8px] opacity-70">/10</span>
                    </div>
                </div>
            </div>
        `;

        // Salvar
        const updatePayload = {
            doc_link: docUrl,
            resumo: htmlResumo,
            pontos_importantes: "Ver card",
            status_cliente: score >= 7 ? "Satisfeito" : (score <= 4 ? "Crítico" : "Neutro"),
            status_projeto: data.status_projeto || "Em Análise",
            last_updated: new Date()
        };

        await supabase.from('empresas').update(updatePayload).eq('id', id);
        res.json({ success: true, data: updatePayload });

    } catch (error) {
        console.error(`[ERRO CRÍTICO] ${step}:`, error.message);
        res.status(500).json({ error: "Falha de processamento", step, details: error.message });
    }
});

app.get('/api/debug-bot', async (req, res) => {
    try {
        const rawToken = getHeadOfficeToken();
        const response = await axios.get(`${BASE_URL}/openai/question`, {
            params: { aiName: BOT_NAME, aiId: BOT_ID, question: "Olá" },
            headers: { 'Authorization': rawToken }
        });
        res.json({ text: response.data.text, full: response.data });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = app;

// --- FRONTEND PREMIUM (CYBERPUNK GLASS v3) ---
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
        
        /* Premium Card */
        .glass-card {
            background: rgba(15, 23, 42, 0.6);
            backdrop-filter: blur(12px);
            border: 1px solid rgba(255, 255, 255, 0.08);
            box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .glass-card:hover {
            border-color: rgba(99, 102, 241, 0.4);
            transform: translateY(-4px);
            box-shadow: 0 20px 40px -10px rgba(99, 102, 241, 0.15);
            background: rgba(30, 41, 59, 0.7);
        }

        /* Status Pills */
        .badge { padding: 4px 10px; border-radius: 99px; font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; border: 1px solid; box-shadow: 0 2px 5px rgba(0,0,0,0.2); }
        .st-Satisfeito, .st-EmDia { background: rgba(16, 185, 129, 0.15); color: #34d399; border-color: rgba(16, 185, 129, 0.3); }
        .st-Crítico, .st-Atrasado, .st-Risco { background: rgba(239, 68, 68, 0.15); color: #fca5a5; border-color: rgba(239, 68, 68, 0.3); }
        .st-Neutro, .st-EmAnálise { background: rgba(148, 163, 184, 0.15); color: #e2e8f0; border-color: rgba(148, 163, 184, 0.3); }

        /* Grid Background */
        .bg-grid {
            background-image: radial-gradient(rgba(255, 255, 255, 0.07) 1px, transparent 1px);
            background-size: 30px 30px;
        }
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
            
            <div class="flex items-center gap-3 w-full md:w-auto">
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

        <div id="grid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-6 pb-20">
            </div>
    </div>

    <script>
        lucide.createIcons();

        async function loadCompanies() {
            const grid = document.getElementById('grid');
            grid.innerHTML = '<div class="col-span-full flex flex-col items-center justify-center py-32 opacity-60"><i data-lucide="loader" class="animate-spin w-10 h-10 text-indigo-500 mb-4"></i><p class="text-sm font-mono text-indigo-300">ESTABLISHING UPLINK...</p></div>';
            lucide.createIcons();

            try {
                const res = await fetch(API_URL + '/api/empresas');
                const data = await res.json();
                grid.innerHTML = '';
                
                if(data.length === 0) { 
                    grid.innerHTML = '<div class="col-span-full text-center text-slate-600 py-32 font-mono">NO ACTIVE CLIENTS.</div>'; 
                    return; 
                }

                data.forEach(emp => {
                    const sCli = (emp.status_cliente || 'Neutro').replace(/\\s/g, '');
                    const sProj = (emp.status_projeto || 'EmAnálise').replace(/\\s/g, '');
                    
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
                                <span class="badge st-\${sCli}">\${emp.status_cliente || 'PENDENTE'}</span>
                                <span class="badge st-\${sProj}">\${emp.status_projeto || '...'}</span>
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
            btn.innerHTML = '<i data-lucide="loader-2" class="animate-spin w-3 h-3"></i> EXTRAINDO INTELIGÊNCIA...';
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
                    btn.innerHTML = 'FALHA NA EXTRAÇÃO';
                    btn.className = "w-full bg-red-900/20 text-red-400 border border-red-500/30 py-2.5 rounded-lg text-xs font-bold";
                }
            } catch (e) { 
                btn.innerHTML = 'ERRO DE CONEXÃO';
            } finally { 
                if(!btn.innerHTML.includes('FALHA') && !btn.innerHTML.includes('ERRO')) {
                    // Se deu certo, o loadCompanies vai sobrescrever o botão, então não precisamos resetar
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
`;