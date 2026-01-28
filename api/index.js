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

app.get('/', (req, res) => {
    const currentUrl = `https://${req.headers.host}`;
    const htmlComUrl = DASHBOARD_HTML.replace('https://head-office-one.vercel.app', currentUrl);
    res.send(htmlComUrl);
});

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

// --- FUNÇÃO AUXILIAR: QUEBRAR TEXTO ---
function splitText(text, chunkSize) {
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize) {
        chunks.push(text.substring(i, i + chunkSize));
    }
    return chunks;
}

// --- FUNÇÃO AUXILIAR: EXTRAIR JSON (CIRÚRGICO) ---
function extractJSON(text) {
    if (!text) return null;
    // Tenta encontrar o primeiro '{' e o último '}'
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
        return text.substring(start, end + 1);
    }
    return text; // Retorna original se não achar estrutura
}

// --- ROTA DE RESUMO ---
app.post('/api/resumir-empresa', async (req, res) => {
    const { nome, id } = req.body;
    
    // --- AUTENTICAÇÃO ---
    const TOKEN_DE_EMERGENCIA = ""; 
    let rawToken = TOKEN_DE_EMERGENCIA || process.env.HEADOFFICE_API_KEY || process.env.HEADOFFICE_JWT || "";
    
    rawToken = rawToken.trim();
    if (rawToken.startsWith('"') && rawToken.endsWith('"')) rawToken = rawToken.slice(1, -1);
    
    const authHeader = rawToken;

    if (rawToken.length < 10) return res.status(500).json({ error: "API Key/Token inválido." });

    let step = "Início";
    let docUrl = null;

    try {
        // 1. Encontrar Link
        step = "Buscando Link no CSV";
        try {
            const csvResponse = await axios.get(SHEET_CSV_URL);
            const lines = csvResponse.data.split('\n');
            for (const line of lines) {
                if (line.toLowerCase().includes(nome.toLowerCase())) {
                    const match = line.match(/(https:\/\/docs\.google\.com\/document\/d\/[a-zA-Z0-9_-]+)/);
                    if (match) { docUrl = match[0]; break; }
                }
            }
        } catch (e) { console.warn("CSV falhou."); }

        if (!docUrl) {
            step = "Buscando Link via IA";
            const aiSearch = await axios.get(`${BASE_URL}/openai/question`, {
                params: {
                    aiName: 'Roger', 
                    context: `Planilha: ${SHEET_FULL_URL}`,
                    question: `Encontre a empresa "${nome}". Extraia a URL do Docs.`
                },
                headers: { 'Authorization': authHeader }
            });
            const answerAI = aiSearch.data.answer || "";
            const matchAI = answerAI.match(/(https:\/\/docs\.google\.com\/document\/d\/[a-zA-Z0-9_-]+)/);
            if (matchAI) docUrl = matchAI[0];
        }

        if (!docUrl) return res.json({ success: false, error: `Link não encontrado para ${nome}.` });

        // 2. Baixar Texto Completo
        step = `Baixando Texto`;
        const txtUrl = `${docUrl}/export?format=txt`;
        let fullText = "";
        try {
            const textResponse = await axios.get(txtUrl);
            fullText = typeof textResponse.data === 'string' ? textResponse.data : JSON.stringify(textResponse.data);
            
            if (!fullText || fullText.trim().length === 0) {
                 return res.json({ success: false, error: "O documento existe, mas está vazio (0 caracteres)." });
            }

            if (fullText.includes("<!DOCTYPE html>") || fullText.includes("Google Accounts")) {
                return res.json({ success: false, error: "Doc privado. Libere para 'Qualquer pessoa com o link'." });
            }
        } catch (downloadError) {
            return res.json({ success: false, error: "Falha ao baixar texto do Doc." });
        }

        // 3. ESTRATÉGIA CHAIN
        step = "Análise Contínua";
        
        // Pega últimos 15k chars
        const relevantText = fullText.slice(-15000); 
        const chunks = splitText(relevantText, 2000); // Aumentei um pouco o chunk para reduzir requisições
        console.log(`[CHAIN] ${chunks.length} partes.`);

        let currentMemory = ""; // Começa vazio para detectarmos se a IA falhou

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const isLast = i === chunks.length - 1;
            
            const safeMemory = currentMemory.length > 600 ? currentMemory.substring(0, 600) + "..." : currentMemory;

            const prompt = isLast 
                ? `PARTE FINAL. Gere o status definitivo baseado em tudo. JSON estrito: {"resumo": "...", "pontos_importantes": "...", "status_cliente": "Satisfeito/Crítico/Neutro", "status_projeto": "Em Dia/Atrasado"}`
                : `Resuma o que aconteceu neste trecho e atualize o contexto anterior.`;

            const response = await axios.get(`${BASE_URL}/openai/question`, {
                params: {
                    aiName: 'Roger',
                    context: `CONTEXTO ANTERIOR: ${safeMemory || "Início"}\n\nNOVO TEXTO:\n${chunk}`,
                    question: prompt
                },
                headers: { 'Authorization': authHeader }
            });
            
            // Se a IA responder vazio, mantém a memória antiga. Se responder algo, atualiza.
            if (response.data.answer) {
                currentMemory = response.data.answer;
            }
        }

        // 4. TRATAMENTO FINAL
        step = "Processando JSON";
        let result = {};
        
        // Se currentMemory estiver vazia, significa que a IA nunca respondeu nada útil
        if (!currentMemory) {
             return res.json({ success: false, error: "A IA não retornou nenhuma resposta válida (Resposta vazia)." });
        }

        // Tenta extrair apenas o JSON da resposta (ignora "Aqui está o JSON...")
        const jsonOnly = extractJSON(currentMemory);

        try {
            result = JSON.parse(jsonOnly);
        } catch (e) {
            console.error("[PARSE ERROR RAW]", currentMemory);
            
            // Fallback: Retorna o texto cru no campo resumo para você ver o erro
            result = { 
                resumo: currentMemory.substring(0, 500) + "...", // Mostra o que a IA falou
                status_cliente: "Erro Parse", 
                status_projeto: "Erro Parse" 
            };
        }

        const updatePayload = {
            doc_link: docUrl,
            resumo: result.resumo,
            pontos_importantes: result.pontos_importantes || "Ver resumo.",
            status_cliente: result.status_cliente || "Neutro",
            status_projeto: result.status_projeto || "Em Análise",
            last_updated: new Date()
        };

        await supabase.from('empresas').update(updatePayload).eq('id', id);
        res.json({ success: true, data: updatePayload });

    } catch (error) {
        console.error(`[ERRO] ${step}:`, error.message);
        const errorDetail = error.response ? JSON.stringify(error.response.data) : error.message;
        res.status(500).json({ error: "Falha técnica", step, details: errorDetail });
    }
});

module.exports = app;

// --- FRONTEND ---
const DASHBOARD_HTML = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>IAgente Monitor - Empresas</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/lucide@latest"></script>
    <style>
        body { font-family: 'Inter', sans-serif; background-color: #0B0C15; color: #E2E8F0; }
        .glass { background: rgba(30, 41, 59, 0.4); backdrop-filter: blur(12px); border: 1px solid rgba(148, 163, 184, 0.1); }
        .stars { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -1; pointer-events: none; }
        .star { position: absolute; background: white; border-radius: 50%; animation: twinkle infinite ease-in-out; }
        @keyframes twinkle { 0%, 100% { opacity: 0.2; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.2); } }
        .status-Satisfeito, .status-EmDia { color: #4ade80; background: rgba(74, 222, 128, 0.1); border-color: rgba(74, 222, 128, 0.2); }
        .status-Crítico, .status-Atrasado, .status-Bug { color: #f87171; background: rgba(248, 113, 113, 0.1); border-color: rgba(248, 113, 113, 0.2); }
        .status-Neutro, .status-Aguardando, .status-ErroParse { color: #94a3b8; background: rgba(148, 163, 184, 0.1); border-color: rgba(148, 163, 184, 0.2); }
    </style>
</head>
<body class="min-h-screen p-6 md:p-12">
    <script>const API_URL = 'https://head-office-one.vercel.app';</script>
    <div class="stars" id="starsContainer"></div>
    <div class="max-w-7xl mx-auto">
        <header class="flex flex-col md:flex-row justify-between items-center mb-8 gap-4">
            <div>
                <h1 class="text-3xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-pink-400">IAgente Empresas</h1>
                <p class="text-xs text-slate-500 mt-1">Gerenciamento Individual</p>
            </div>
            <div class="flex gap-2">
                <input type="text" id="newCompanyInput" placeholder="Nova empresa..." class="glass px-4 py-2 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500">
                <button onclick="addCompany()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-bold transition-all flex items-center gap-2">
                    <i data-lucide="plus-circle" class="w-4 h-4"></i>
                </button>
            </div>
        </header>
        <div id="grid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6"></div>
    </div>
    <script>
        lucide.createIcons();
        const starContainer = document.getElementById('starsContainer');
        for(let i=0; i<60; i++) {
            const s = document.createElement('div'); s.className='star';
            s.style.top=Math.random()*100+'%'; s.style.left=Math.random()*100+'%';
            s.style.width=Math.random()*2+'px'; s.style.height=s.style.width;
            s.style.animationDuration=(Math.random()*3+2)+'s'; starContainer.appendChild(s);
        }
        async function loadCompanies() {
            const grid = document.getElementById('grid');
            grid.innerHTML = '<div class="col-span-4 text-center text-slate-500 animate-pulse">Carregando...</div>';
            try {
                const res = await fetch(API_URL + '/api/empresas');
                const data = await res.json();
                grid.innerHTML = '';
                if(data.length === 0) { grid.innerHTML = '<div class="col-span-4 text-center text-slate-500">Vazio.</div>'; return; }
                data.forEach(emp => {
                    const sCli = (emp.status_cliente || '').replace(/\\s/g, '');
                    const sProj = (emp.status_projeto || '').replace(/\\s/g, '');
                    grid.innerHTML += \`
                    <div class="glass rounded-xl p-5 flex flex-col gap-3 group relative overflow-hidden hover:border-indigo-500/40" id="card-\${emp.id}">
                        <div class="flex justify-between items-start">
                            <h2 class="font-bold text-white truncate text-lg w-full" title="\${emp.nome}">\${emp.nome}</h2>
                            \${emp.doc_link ? \`<a href="\${emp.doc_link}" target="_blank" class="text-slate-500 hover:text-white"><i data-lucide="external-link" class="w-4 h-4"></i></a>\` : ''}
                        </div>
                        <div class="flex gap-2 text-[10px] font-bold uppercase">
                            <span class="px-2 py-1 rounded border status-\${sCli}">\${emp.status_cliente || 'PENDENTE'}</span>
                            <span class="px-2 py-1 rounded border status-\${sProj}">\${emp.status_projeto || '-'}</span>
                        </div>
                        <div class="bg-black/20 rounded-lg p-3 min-h-[80px] text-xs text-slate-300 leading-relaxed border border-white/5">
                            \${emp.resumo || '<span class="italic opacity-50">Sem resumo.</span>'}
                        </div>
                        <button onclick="summarize('\${emp.nome}', \${emp.id})" id="btn-\${emp.id}" class="mt-auto w-full bg-white/5 hover:bg-indigo-600/80 hover:text-white text-slate-300 py-2 rounded-lg text-xs font-bold transition-all flex justify-center items-center gap-2 border border-white/10">
                            <i data-lucide="sparkles" class="w-3 h-3"></i> \${emp.resumo ? 'Atualizar' : 'Gerar Resumo'}
                        </button>
                    </div>\`;
                });
                lucide.createIcons();
            } catch (e) { grid.innerHTML = '<div class="text-red-400">Erro.</div>'; }
        }
        async function summarize(nome, id) {
            const btn = document.getElementById('btn-' + id);
            const originalText = btn.innerHTML;
            btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-2" class="animate-spin w-3 h-3"></i> Lendo...';
            try {
                const res = await fetch(API_URL + '/api/resumir-empresa', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ nome, id })
                });
                const json = await res.json();
                if (json.success) { loadCompanies(); } 
                else { alert('Erro: ' + (json.details ? JSON.stringify(json.details) : json.error)); btn.innerHTML = 'Erro ⚠️'; }
            } catch (e) { alert('Erro conexão.'); btn.innerHTML = 'Falha'; } 
            finally { setTimeout(() => { btn.disabled = false; if(btn.innerHTML === 'Falha') btn.innerHTML = originalText; }, 2000); }
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