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

// --- ROTA DASHBOARD (FRONTEND PREMIUM) ---
app.get('/', (req, res) => {
    const currentUrl = `https://${req.headers.host}`;
    const htmlComUrl = DASHBOARD_HTML.replace('https://head-office-one.vercel.app', currentUrl);
    res.send(htmlComUrl);
});

// --- HELPER AUTH ---
function getAuthToken() {
    const TOKEN_DE_EMERGENCIA = ""; 
    let rawToken = TOKEN_DE_EMERGENCIA || process.env.HEADOFFICE_API_KEY || process.env.HEADOFFICE_JWT || "";
    rawToken = rawToken.trim();
    if (rawToken.startsWith('"') && rawToken.endsWith('"')) rawToken = rawToken.slice(1, -1);
    return rawToken.length > 10 ? rawToken : null;
}

// --- HELPER QUEBRA DE TEXTO ---
function splitText(text, chunkSize) {
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize) {
        chunks.push(text.substring(i, i + chunkSize));
    }
    return chunks;
}

// --- HELPER EXTRAIR JSON ---
function extractJSON(text) {
    if (!text) return null;
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
        return text.substring(start, end + 1);
    }
    return text;
}

// --- ROTA LISTAR EMPRESAS ---
app.get('/api/empresas', async (req, res) => {
    const { data, error } = await supabase.from('empresas').select('*').order('nome', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// --- ROTA CRIAR EMPRESA ---
app.post('/api/empresas', async (req, res) => {
    const { nome } = req.body;
    if (!nome) return res.status(400).json({ error: "Nome obrigatório" });
    const { data, error } = await supabase.from('empresas').insert([{ nome }]).select();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, data });
});

// ======================================================
// LÓGICA DE INTELIGÊNCIA ARTIFICIAL (CS INTELLIGENCE)
// ======================================================

app.post('/api/resumir-empresa', async (req, res) => {
    const { nome, id } = req.body;
    const authHeader = getAuthToken();

    if (!authHeader) return res.status(500).json({ error: "Token inválido." });

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
                    aiName: BOT_NAME,
                    aiId: BOT_ID,
                    context: `Planilha: ${SHEET_FULL_URL}`,
                    question: `Encontre a empresa "${nome}". Extraia a URL do Docs.`
                },
                headers: { 'Authorization': authHeader }
            });
            const answerAI = aiSearch.data.text || aiSearch.data.answer || "";
            const matchAI = answerAI.match(/(https:\/\/docs\.google\.com\/document\/d\/[a-zA-Z0-9_-]+)/);
            if (matchAI) docUrl = matchAI[0];
        }

        if (!docUrl) return res.json({ success: false, error: `Link não encontrado para ${nome}.` });

        // 2. Baixar Texto
        step = `Baixando Texto`;
        const txtUrl = `${docUrl}/export?format=txt`;
        let fullText = "";
        try {
            const textResponse = await axios.get(txtUrl);
            fullText = typeof textResponse.data === 'string' ? textResponse.data : JSON.stringify(textResponse.data);
            
            if (!fullText || fullText.length < 50) return res.json({ success: false, error: "Doc vazio ou muito curto." });
            if (fullText.includes("<!DOCTYPE html>") || fullText.includes("Google Accounts")) {
                return res.json({ success: false, error: "Doc privado. Libere o acesso." });
            }
        } catch (downloadError) {
            return res.json({ success: false, error: "Falha ao baixar Doc (404/403)." });
        }

        // 3. ANÁLISE EM CADEIA (CHAIN)
        step = "Análise Contínua";
        const relevantText = fullText.slice(-15000); 
        const chunks = splitText(relevantText, 2500); 
        console.log(`[CHAIN] ${chunks.length} partes.`);

        let currentMemory = "";

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const isLast = i === chunks.length - 1;
            const safeMemory = currentMemory.length > 1200 ? currentMemory.substring(0, 1200) + "..." : currentMemory;

            // --- O PROMPT DE OURO ---
            // Esse prompt força a IA a agir como um estrategista de CS.
            const prompt = isLast 
                ? `VOCÊ É UM DIRETOR DE CUSTOMER SUCCESS SÊNIOR.
                   Com base em todo o histórico, gere um relatório final de inteligência.
                   Seja crítico, analítico e extremamente detalhado. NÃO use frases genéricas.
                   
                   Analise:
                   1. **Raio-X do Cliente:** Como ele fala? É técnico ou leigo? Ansioso ou calmo? Como devemos falar com ele?
                   2. **Status Real:** Onde estamos no cronograma? O que está travado?
                   3. **Checkpoints:** O que já foi entregue e o que falta (com datas se houver).
                   
                   Gere este JSON estrito (sem markdown):
                   {
                      "resumo_executivo": "Resumo de alto nível do estado do projeto e da saúde da conta.",
                      "perfil_cliente": "Análise psicológica: Estilo de comunicação, nível de exigência, o que irrita ele, o que deixa ele feliz.",
                      "dica_cs": "Dica prática para o time: Ex: 'Seja direto, não dê desculpas' ou 'Elogie a visão dele'.",
                      "checkpoints_feitos": ["Item 1", "Item 2"],
                      "proximos_passos": ["Ação imediata 1", "Ação 2"],
                      "pontos_atencao": "Riscos, bloqueios ou reclamações recentes.",
                      "status_geral": "Satisfeito/Crítico/Neutro",
                      "status_cronograma": "Em Dia/Atrasado/Risco"
                   }`
                : `Leia este trecho. Identifique: Novas entregas, novas reclamações, mudanças de tom. Atualize seu entendimento do projeto.`;

            let respostaIA = "";
            for (let retry = 0; retry < 2; retry++) {
                try {
                    const response = await axios.get(`${BASE_URL}/openai/question`, {
                        params: {
                            aiName: BOT_NAME,
                            aiId: BOT_ID,
                            context: `MEMÓRIA ESTRATÉGICA: ${safeMemory || "Nenhuma"}\n\nNOVA INTERAÇÃO:\n${chunk}`,
                            question: prompt
                        },
                        headers: { 'Authorization': authHeader }
                    });
                    
                    const textoResposta = response.data.text || response.data.answer;
                    if (textoResposta && textoResposta.trim().length > 0) {
                        respostaIA = textoResposta;
                        break; 
                    }
                } catch (e) { console.error("Erro na chamada IA:", e.message); }
            }

            if (respostaIA) {
                currentMemory = respostaIA;
            }
        }

        // 4. PROCESSAMENTO E FORMATAÇÃO VISUAL (HTML-IN-DB STRATEGY)
        step = "Formatando Relatório";
        if (!currentMemory) return res.json({ success: false, error: `IA muda.` });

        const jsonOnly = extractJSON(currentMemory);
        let data = {};

        try {
            data = JSON.parse(jsonOnly);
        } catch (e) {
            data = { resumo_executivo: currentMemory.substring(0, 500) }; // Fallback
        }

        // --- CONSTRUÇÃO DO HTML RICO PARA SALVAR NO BANCO ---
        // Salvamos HTML direto no campo 'resumo' para o frontend apenas renderizar.
        // Isso permite layouts complexos sem mudar o banco de dados.
        
        const htmlResumo = `
            <div class="space-y-3">
                <p class="text-sm text-slate-300 leading-relaxed">${data.resumo_executivo || "Sem resumo."}</p>
                
                <div class="grid grid-cols-2 gap-2 mt-2">
                    <div class="bg-indigo-500/10 p-2 rounded border border-indigo-500/20">
                        <h4 class="text-[10px] uppercase font-bold text-indigo-400 mb-1">Perfil & Tom</h4>
                        <p class="text-[11px] text-slate-300">${data.perfil_cliente || "N/A"}</p>
                    </div>
                    <div class="bg-emerald-500/10 p-2 rounded border border-emerald-500/20">
                        <h4 class="text-[10px] uppercase font-bold text-emerald-400 mb-1">Dica de Ouro CS</h4>
                        <p class="text-[11px] text-slate-300 italic">"${data.dica_cs || "Sem dicas"}"</p>
                    </div>
                </div>

                ${data.pontos_atencao ? `
                <div class="bg-red-500/10 p-2 rounded border border-red-500/20 flex items-start gap-2">
                    <span class="text-red-400">⚠️</span>
                    <div>
                        <h4 class="text-[10px] uppercase font-bold text-red-400">Atenção Crítica</h4>
                        <p class="text-[11px] text-slate-300">${data.pontos_atencao}</p>
                    </div>
                </div>` : ''}

                <div class="mt-2">
                    <h4 class="text-[10px] uppercase font-bold text-slate-500 mb-1 flex items-center gap-1">
                        ✅ Checkpoints
                    </h4>
                    <ul class="text-[11px] text-slate-400 space-y-1 pl-1">
                        ${(data.checkpoints_feitos || []).map(i => `<li class="flex items-center gap-2"><span class="w-1 h-1 bg-green-500 rounded-full"></span> ${i}</li>`).join('')}
                        ${(data.proximos_passos || []).map(i => `<li class="flex items-center gap-2"><span class="w-1 h-1 bg-slate-500 rounded-full"></span> ${i}</li>`).join('')}
                    </ul>
                </div>
            </div>
        `;

        // Salva no banco
        const updatePayload = {
            doc_link: docUrl,
            resumo: htmlResumo, // Salvamos o HTML pronto aqui!
            pontos_importantes: "Visualizar no card", // Campo legado
            status_cliente: data.status_geral || "Neutro",
            status_projeto: data.status_cronograma || "Em Análise",
            last_updated: new Date()
        };

        await supabase.from('empresas').update(updatePayload).eq('id', id);
        res.json({ success: true, data: updatePayload });

    } catch (error) {
        console.error(`[ERRO FATAL] ${step}:`, error.message);
        res.status(500).json({ error: "Erro Interno", step, details: error.message });
    }
});

app.get('/api/debug-bot', async (req, res) => {
    try {
        const rawToken = getAuthToken();
        const response = await axios.get(`${BASE_URL}/openai/question`, {
            params: { aiName: BOT_NAME, aiId: BOT_ID, question: "Olá" },
            headers: { 'Authorization': rawToken }
        });
        res.json({ text: response.data.text, full: response.data });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = app;

// --- FRONTEND PREMIUM (CYBERPUNK GLASS) ---
const DASHBOARD_HTML = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CS Intelligence Hub</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/lucide@latest"></script>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Inter:wght@300;400;600;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; background-color: #030712; color: #E2E8F0; overflow-x: hidden; }
        .mono { font-family: 'JetBrains Mono', monospace; }
        
        /* Glassmorphism Premium */
        .glass-panel { 
            background: rgba(17, 24, 39, 0.6); 
            backdrop-filter: blur(20px); 
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(255, 255, 255, 0.08);
            box-shadow: 0 4px 30px rgba(0, 0, 0, 0.5);
        }
        
        .glass-card {
            background: linear-gradient(145deg, rgba(30, 41, 59, 0.4) 0%, rgba(15, 23, 42, 0.6) 100%);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.05);
            transition: all 0.3s ease;
        }
        .glass-card:hover {
            border-color: rgba(99, 102, 241, 0.5);
            transform: translateY(-2px);
            box-shadow: 0 10px 40px -10px rgba(99, 102, 241, 0.2);
        }

        /* Status Badges */
        .badge { padding: 4px 8px; border-radius: 4px; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; border: 1px solid; }
        .st-Satisfeito, .st-EmDia { background: rgba(16, 185, 129, 0.1); color: #34d399; border-color: rgba(16, 185, 129, 0.2); }
        .st-Crítico, .st-Atrasado, .st-Risco { background: rgba(239, 68, 68, 0.1); color: #f87171; border-color: rgba(239, 68, 68, 0.2); }
        .st-Neutro, .st-EmAnálise { background: rgba(148, 163, 184, 0.1); color: #cbd5e1; border-color: rgba(148, 163, 184, 0.2); }

        /* Animations */
        @keyframes pulse-glow { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }
        .animate-glow { animation: pulse-glow 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
        
        /* Background Grid */
        .bg-grid {
            background-size: 40px 40px;
            background-image: linear-gradient(to right, rgba(255, 255, 255, 0.03) 1px, transparent 1px),
                              linear-gradient(to bottom, rgba(255, 255, 255, 0.03) 1px, transparent 1px);
        }
    </style>
</head>
<body class="min-h-screen bg-grid">
    <script>const API_URL = 'https://head-office-one.vercel.app';</script>
    
    <div class="fixed top-0 left-0 w-full h-1 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 z-50"></div>

    <div class="max-w-[1600px] mx-auto p-6 md:p-12">
        <header class="flex flex-col md:flex-row justify-between items-end mb-12 gap-6 relative">
            <div>
                <div class="flex items-center gap-3 mb-2">
                    <div class="w-2 h-8 bg-indigo-500 rounded-sm"></div>
                    <h1 class="text-4xl font-extrabold text-white tracking-tight">CS INTELLIGENCE HUB</h1>
                </div>
                <p class="text-slate-400 font-mono text-sm pl-5">Monitoring & Semantic Analysis System v2.0</p>
            </div>
            
            <div class="flex items-center gap-3 w-full md:w-auto">
                <div class="relative group w-full md:w-64">
                    <input type="text" id="newCompanyInput" placeholder="Adicionar cliente..." 
                        class="w-full bg-slate-900/50 border border-slate-700 text-slate-200 text-sm rounded-lg focus:ring-indigo-500 focus:border-indigo-500 block w-full p-2.5 pl-10 placeholder-slate-600 transition-all focus:bg-slate-900">
                    <i data-lucide="search" class="absolute left-3 top-3 w-4 h-4 text-slate-500"></i>
                </div>
                <button onclick="addCompany()" class="bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2.5 rounded-lg text-sm font-bold transition-all flex items-center gap-2 shadow-lg shadow-indigo-500/20">
                    <i data-lucide="plus" class="w-4 h-4"></i> <span class="hidden md:inline">NOVO</span>
                </button>
            </div>
        </header>

        <div id="grid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-6">
            </div>
    </div>

    <script>
        lucide.createIcons();

        async function loadCompanies() {
            const grid = document.getElementById('grid');
            grid.innerHTML = '<div class="col-span-full flex flex-col items-center justify-center py-20 opacity-50"><i data-lucide="loader" class="animate-spin w-8 h-8 text-indigo-500 mb-4"></i><p class="font-mono text-sm">Synchronizing Intelligence...</p></div>';
            lucide.createIcons();

            try {
                const res = await fetch(API_URL + '/api/empresas');
                const data = await res.json();
                grid.innerHTML = '';
                
                if(data.length === 0) { 
                    grid.innerHTML = '<div class="col-span-full text-center text-slate-600 font-mono py-20">No active signals found.</div>'; 
                    return; 
                }

                data.forEach(emp => {
                    const sCli = (emp.status_cliente || 'Neutro').replace(/\\s/g, '');
                    const sProj = (emp.status_projeto || 'EmAnálise').replace(/\\s/g, '');
                    
                    // Renderiza o HTML rico que veio do backend ou um placeholder
                    const contentHtml = emp.resumo && emp.resumo.includes('<div') 
                        ? emp.resumo 
                        : \`<p class="text-sm text-slate-400 italic py-4 text-center">Aguardando primeira análise de inteligência...</p>\`;

                    grid.innerHTML += \`
                    <div class="glass-card rounded-xl p-0 flex flex-col h-full group relative overflow-hidden">
                        <div class="p-5 border-b border-white/5 bg-white/[0.02]">
                            <div class="flex justify-between items-start mb-3">
                                <h2 class="font-bold text-white text-xl tracking-tight truncate w-10/12" title="\${emp.nome}">\${emp.nome}</h2>
                                \${emp.doc_link ? \`<a href="\${emp.doc_link}" target="_blank" class="text-slate-500 hover:text-indigo-400 transition-colors"><i data-lucide="file-text" class="w-4 h-4"></i></a>\` : ''}
                            </div>
                            <div class="flex flex-wrap gap-2">
                                <span class="badge st-\${sCli}">\${emp.status_cliente || 'PENDENTE'}</span>
                                <span class="badge st-\${sProj}">\${emp.status_projeto || '...'}</span>
                            </div>
                        </div>

                        <div class="p-5 flex-grow">
                            \${contentHtml}
                        </div>

                        <div class="p-4 mt-auto border-t border-white/5 bg-black/20">
                            <button onclick="summarize('\${emp.nome}', \${emp.id})" id="btn-\${emp.id}" 
                                class="w-full group-hover:bg-indigo-600 bg-slate-800 hover:bg-indigo-500 text-slate-300 group-hover:text-white py-3 rounded-lg text-xs font-bold font-mono transition-all flex justify-center items-center gap-2 border border-white/5 group-hover:border-indigo-500/50 group-hover:shadow-[0_0_20px_rgba(99,102,241,0.3)]">
                                <i data-lucide="refresh-cw" class="w-3 h-3"></i> \${emp.resumo ? 'ATUALIZAR INTELIGÊNCIA' : 'GERAR ANÁLISE'}
                            </button>
                            <div class="text-[9px] text-center text-slate-600 mt-2 font-mono">
                                Última att: \${emp.last_updated ? new Date(emp.last_updated).toLocaleDateString() + ' ' + new Date(emp.last_updated).toLocaleTimeString().slice(0,5) : 'Nunca'}
                            </div>
                        </div>
                    </div>\`;
                });
                lucide.createIcons();
            } catch (e) { 
                console.error(e);
                grid.innerHTML = '<div class="col-span-full text-center text-red-400 font-mono">System Malfunction: Unable to fetch data.</div>'; 
            }
        }

        async function summarize(nome, id) {
            const btn = document.getElementById('btn-' + id);
            const originalHTML = btn.innerHTML;
            
            btn.disabled = true; 
            btn.className = "w-full bg-indigo-900/50 text-indigo-300 py-3 rounded-lg text-xs font-bold font-mono flex justify-center items-center gap-2 cursor-wait border border-indigo-500/20";
            btn.innerHTML = '<i data-lucide="loader-2" class="animate-spin w-3 h-3"></i> PROCESSANDO DADOS...';
            lucide.createIcons();

            try {
                const res = await fetch(API_URL + '/api/resumir-empresa', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ nome, id })
                });
                const json = await res.json();
                
                if (json.success) { 
                    loadCompanies(); // Recarrega para mostrar o novo HTML
                } else { 
                    alert('Erro: ' + (json.details || json.error)); 
                    btn.innerHTML = 'ERRO NA ANÁLISE';
                    btn.className += " bg-red-900/50 text-red-200 border-red-500/50";
                }
            } catch (e) { 
                alert('Erro de conexão.'); 
                btn.innerHTML = 'FALHA DE REDE';
            } finally { 
                if(!btn.innerHTML.includes('ERRO')) {
                    setTimeout(() => { 
                        btn.disabled = false; 
                        btn.innerHTML = originalHTML; 
                        btn.className = "w-full group-hover:bg-indigo-600 bg-slate-800 hover:bg-indigo-500 text-slate-300 group-hover:text-white py-3 rounded-lg text-xs font-bold font-mono transition-all flex justify-center items-center gap-2 border border-white/5 group-hover:border-indigo-500/50 group-hover:shadow-[0_0_20px_rgba(99,102,241,0.3)]";
                        lucide.createIcons();
                    }, 2000); 
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

        // Auto load
        loadCompanies();
    </script>
</body>
</html>
`;