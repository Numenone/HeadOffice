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

// Ajuste: Garantir que não tenha barra no final para evitar //v1
const BASE_URL = 'https://api.headoffice.ai/v1';
const SHEET_ID = '1m6yZozLKIZ8KyT9YW62qikkSZE-CrQsjTNTX6V9Y0eM';

// --- ROTA 1: DASHBOARD ---
app.get('/', (req, res) => {
    const currentUrl = `https://${req.headers.host}`;
    const htmlComUrl = DASHBOARD_HTML.replace('https://head-office-one.vercel.app', currentUrl);
    res.send(htmlComUrl);
});

// --- ROTA 2: DADOS ---
app.get('/api/dashboard-data', async (req, res) => {
    try {
        const { data, error } = await supabase.from('sessoes_resumos').select('*').order('last_updated', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- ROTA 3: SYNC AGENT (CORRIGIDA) ---
app.get('/api/sync-agent', async (req, res) => {
    let step = "Início";
    try {
        const HEADOFFICE_API_KEY = process.env.HEADOFFICE_API_KEY;
        if (!HEADOFFICE_API_KEY) throw new Error("Falta a HEADOFFICE_API_KEY no .env do Vercel");

        // PASSO 1: Consultar a Planilha (Search Store)
        step = "Consultando Planilha (/google-sheets/search-store)";
        
        // Nota: Se search-store for GET, mudaremos aqui. Mantendo POST conforme padrão de APIs de 'store'.
        // Trocando para axios.post com tratamento de erro específico
        try {
            await axios.post(
                `${BASE_URL}/google-sheets/search-store`,
                { spreadsheetId: SHEET_ID },
                { headers: { 'Authorization': `Bearer ${HEADOFFICE_API_KEY}` } }
            );
        } catch (e) {
            // Se der 404 aqui, tentamos o endpoint /search como fallback ou reportamos erro de rota
            if (e.response && e.response.status === 404) {
                 throw new Error(`Erro 404 na rota: ${BASE_URL}/google-sheets/search-store. Verifique se a rota existe na documentação.`);
            }
            throw e;
        }

        // PASSO 2: Pegar Links (Usando a rota Question)
        step = "Identificando Links (/openai/question)";
        
        const linksQuery = await axios.post(
            `${BASE_URL}/openai/question`,
            { 
                context: `Estou analisando a planilha ID: ${SHEET_ID}.`,
                question: `Liste APENAS as URLs encontradas na coluna "Links Docs" ou "Link Docs". Retorne somente um JSON Array de strings. Exemplo: ["https://...", "https://..."].`
            },
            { headers: { 'Authorization': `Bearer ${HEADOFFICE_API_KEY}` } }
        );

        let linksDocs = [];
        const answerText = linksQuery.data.answer || "";
        
        // Tentativa robusta de extrair JSON ou Links
        try {
            // Limpa markdown de código se existir
            const cleanJson = answerText.replace(/```json/g, '').replace(/```/g, '').trim();
            linksDocs = JSON.parse(cleanJson);
        } catch (e) {
            // Fallback: Regex para extrair links se a IA falar demais
            const urlRegex = /(https?:\/\/[^\s,\]"]+)/g;
            linksDocs = answerText.match(urlRegex) || [];
        }

        if (!Array.isArray(linksDocs) || linksDocs.length === 0) {
            return res.json({ success: false, message: "A IA não encontrou links na coluna especificada.", debug_ia: answerText });
        }

        // PASSO 3: Ler Conteúdo dos Links
        step = "Lendo Documentos";
        const results = [];

        for (const link of linksDocs) {
            // Verifica duplicidade para não gastar tokens
            const { data: existing } = await supabase.from('sessoes_resumos').select('id').eq('doc_link', link).single();
            if (existing) continue;

            // Prompt de Análise Profunda
            const promptAnalise = `
                Aja como um Gerente de Projetos.
                Analise o conteúdo do link: ${link}
                (Se você não conseguir navegar no link, deduza pelo contexto disponível ou avise no status).
                
                Retorne um JSON estrito:
                {
                    "nome_cliente": "Nome do Cliente",
                    "resumo_ultima_sessao": "Resumo da última interação (data mais recente)",
                    "pontos_importantes": "Top 3 pontos de atenção",
                    "status_cliente": "Satisfeito / Crítico / Neutro",
                    "status_projeto": "Em Andamento / Atrasado / Concluído"
                }
            `;

            const docResponse = await axios.post(
                `${BASE_URL}/openai/question`,
                {
                    context: `Link do Documento: ${link}`,
                    question: promptAnalise
                },
                { headers: { 'Authorization': `Bearer ${HEADOFFICE_API_KEY}` } }
            );

            // Parse seguro
            let parsed = {};
            try {
                const raw = docResponse.data.answer.replace(/```json/g, '').replace(/```/g, '');
                parsed = JSON.parse(raw);
            } catch (e) {
                parsed = { 
                    resumo_ultima_sessao: docResponse.data.answer.substring(0, 200) + "...", 
                    status_cliente: "Erro leitura", 
                    status_projeto: "Erro leitura" 
                };
            }

            // Salva no banco
            const { data: saved } = await supabase.from('sessoes_resumos').upsert({
                doc_link: link,
                nome_cliente: parsed.nome_cliente || "Desconhecido",
                resumo_ultima_sessao: parsed.resumo_ultima_sessao,
                pontos_discussao: parsed.pontos_importantes || "",
                status_cliente: parsed.status_cliente || "Neutro",
                status_projeto: parsed.status_projeto || "Em análise",
                last_updated: new Date()
            }).select().single();

            if (saved) results.push(saved);
        }

        res.json({ success: true, count: results.length, data: results });

    } catch (error) {
        console.error(`Erro no passo [${step}]:`, error.message);
        
        // Retorna o erro detalhado para o frontend ver
        const errorMsg = error.response 
            ? `Erro API (${error.response.status}): ${JSON.stringify(error.response.data)}` 
            : error.message;

        res.status(500).json({ 
            error: errorMsg, 
            step_failed: step,
            details: "Verifique se a HEADOFFICE_API_KEY está correta e se a rota existe." 
        });
    }
});

module.exports = app;

// --- MANTENHA O HTML ABAIXO IGUAL ---
const DASHBOARD_HTML = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>IAgente Monitor</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/lucide@latest"></script>
    <style>
        body { font-family: 'Inter', sans-serif; background-color: #0B0C15; color: #E2E8F0; }
        .stars { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -1; pointer-events: none; }
        .star { position: absolute; background: white; border-radius: 50%; animation: twinkle infinite ease-in-out; }
        @keyframes twinkle { 0%, 100% { opacity: 0.2; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.2); } }
        .glass { background: rgba(30, 41, 59, 0.4); backdrop-filter: blur(12px); border: 1px solid rgba(148, 163, 184, 0.1); }
    </style>
</head>
<body class="min-h-screen p-6 md:p-12">
    <script>const API_URL = 'https://head-office-one.vercel.app';</script>
    <div class="stars" id="starsContainer"></div>
    <div class="max-w-7xl mx-auto">
        <header class="flex justify-between items-center mb-12">
            <h1 class="text-3xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-pink-400">IAgente Monitor</h1>
            <button onclick="syncAgent()" id="btnSync" class="glass px-6 py-3 rounded-xl flex items-center gap-2 hover:bg-white/5 transition-all text-sm font-bold">
                <i data-lucide="zap" id="iconSync"></i> <span id="txtSync">Analisar Planilha</span>
            </button>
        </header>
        <div id="statusMsg" class="hidden mb-8 p-4 rounded-xl text-center text-sm font-mono break-all"></div>
        <div id="cardsGrid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"></div>
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

        function render(data) {
            const grid = document.getElementById('cardsGrid'); grid.innerHTML = '';
            if(!data || !data.length) { grid.innerHTML = '<div class="col-span-3 text-center py-20 glass rounded-2xl text-slate-400">Sem dados. Clique em Analisar.</div>'; return; }
            data.forEach(item => {
                grid.innerHTML += \`
                <div class="glass rounded-2xl p-6 flex flex-col gap-4">
                    <div class="flex justify-between">
                        <h2 class="font-bold text-white">\${item.nome_cliente}</h2>
                        <a href="\${item.doc_link}" target="_blank" class="text-xs text-purple-400 hover:underline">Ver Doc</a>
                    </div>
                    <div class="grid grid-cols-2 gap-2 text-center">
                        <span class="bg-indigo-500/20 text-indigo-300 text-[10px] px-2 py-1 rounded border border-indigo-500/30 uppercase">\${item.status_cliente}</span>
                        <span class="bg-pink-500/20 text-pink-300 text-[10px] px-2 py-1 rounded border border-pink-500/30 uppercase">\${item.status_projeto}</span>
                    </div>
                    <div><h3 class="text-xs font-bold text-slate-400">Última Sessão</h3><p class="text-xs text-slate-300">\${item.resumo_ultima_sessao}</p></div>
                    <div class="bg-black/20 p-3 rounded border border-white/5"><h3 class="text-xs font-bold text-yellow-500">Atenção</h3><p class="text-[10px] text-slate-400">\${item.pontos_discussao}</p></div>
                </div>\`;
            });
            lucide.createIcons();
        }

        async function fetchD() { try { const res = await fetch(API_URL+'/api/dashboard-data'); const json = await res.json(); render(json); } catch(e){} }

        async function syncAgent() {
            const btn = document.getElementById('btnSync'); const msg = document.getElementById('statusMsg');
            btn.disabled=true; msg.innerHTML = "Iniciando análise... (Aguarde)"; msg.className="mb-8 p-4 rounded-xl bg-blue-500/10 text-blue-300 block";
            try { 
                const res = await fetch(API_URL+'/api/sync-agent'); 
                const json = await res.json();
                if(json.success) { 
                    msg.innerHTML = "Sucesso! " + json.count + " analisados."; 
                    msg.className="mb-8 p-4 rounded-xl bg-green-500/10 text-green-300 block";
                    fetchD(); 
                } else { 
                    // Mostra o erro exato na tela
                    msg.innerHTML = "Erro: " + (json.error || json.message) + (json.step_failed ? "<br>Falha em: " + json.step_failed : ""); 
                    msg.className="mb-8 p-4 rounded-xl bg-red-500/10 text-red-300 block";
                }
            } catch(e) { msg.innerHTML = "Erro Fatal: " + e.message; msg.className="mb-8 p-4 rounded-xl bg-red-500/10 text-red-300 block"; }
            btn.disabled=false;
        }
        fetchD();
    </script>
</body>
</html>
`;