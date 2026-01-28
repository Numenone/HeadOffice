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

// URL Base (Sem barra no final)
const BASE_URL = 'https://api.headoffice.ai/v1';

// Dados da Planilha Alvo
const SHEET_ID = '1m6yZozLKIZ8KyT9YW62qikkSZE-CrQsjTNTX6V9Y0eM';
const SHEET_FULL_URL = 'https://docs.google.com/spreadsheets/d/1m6yZozLKIZ8KyT9YW62qikkSZE-CrQsjTNTX6V9Y0eM/edit?gid=0#gid=0';

// --- ROTA 1: DASHBOARD ---
app.get('/', (req, res) => {
    const currentUrl = `https://${req.headers.host}`;
    const htmlComUrl = DASHBOARD_HTML.replace('https://head-office-one.vercel.app', currentUrl);
    res.send(htmlComUrl);
});

// --- ROTA 2: DADOS DO BANCO ---
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
        if (!HEADOFFICE_API_KEY) throw new Error("Falta a HEADOFFICE_API_KEY no .env");

        // PASSO 1: Buscar na Store (Opcional/Verificação)
        // Corrigido para GET conforme seus parâmetros (search, page, pageSize)
        step = "Consultando Planilha (/google-sheets/search-store)";
        try {
            await axios.get(`${BASE_URL}/google-sheets/search-store`, {
                params: {
                    search: SHEET_ID, // Tentamos achar pelo ID
                    page: 1,
                    pageSize: 10
                },
                headers: { 'Authorization': `Bearer ${HEADOFFICE_API_KEY}` }
            });
            // Não precisamos fazer nada com o retorno aqui, apenas garantimos que a API sabe que estamos buscando
        } catch (e) {
            console.warn("Aviso: Falha na busca search-store (pode não ser crítico se tivermos a URL direta).", e.message);
            // Não damos throw aqui, continuamos para usar a URL direta no passo 2
        }

        // PASSO 2: Pegar Links da Planilha (Usando URL Direta no Contexto)
        step = "Extraindo Links (/openai/question)";
        
        // Estratégia: Passamos a URL da planilha no contexto. A IA deve acessar e ler.
        const linksQuery = await axios.post(
            `${BASE_URL}/openai/question`,
            { 
                context: `Aja como um leitor de dados. Acesse esta planilha Google Sheets: ${SHEET_FULL_URL}`,
                question: `Vá na coluna "Links Docs" (ou Link Docs). Extraia TODAS as URLs de documentos google docs listadas nela. Retorne APENAS um JSON Array de strings puro. Exemplo: ["https://docs...", "https://docs..."]. Não escreva nada além do JSON.`
            },
            { headers: { 'Authorization': `Bearer ${HEADOFFICE_API_KEY}` } }
        );

        let linksDocs = [];
        const answerText = linksQuery.data.answer || "";
        
        try {
            // Limpa qualquer formatação markdown (```json ... ```)
            const cleanJson = answerText.replace(/```json/g, '').replace(/```/g, '').trim();
            linksDocs = JSON.parse(cleanJson);
        } catch (e) {
            // Fallback: Tenta achar URLs via Regex se o JSON falhar
            const urlRegex = /(https?:\/\/[^\s,\]"]+)/g;
            linksDocs = answerText.match(urlRegex) || [];
        }

        if (!Array.isArray(linksDocs) || linksDocs.length === 0) {
            return res.json({ 
                success: false, 
                message: "A IA acessou a planilha mas não conseguiu extrair links válidos.", 
                debug_ia: answerText 
            });
        }

        // PASSO 3: Ler Conteúdo de Cada Link Encontrado
        step = "Lendo Documentos Individuais";
        const results = [];

        for (const link of linksDocs) {
            // Verifica se já existe no banco (Cache)
            const { data: existing } = await supabase.from('sessoes_resumos').select('id').eq('doc_link', link).single();
            if (existing) continue;

            const promptAnalise = `
                Aja como um Gerente de Projetos Sênior da HeadOffice.
                Acesse e leia o conteúdo completo deste documento: ${link}
                (O documento contém histórico de conversas separado por datas).

                TAREFA:
                1. Identifique a ÚLTIMA data registrada (a conversa mais recente).
                2. Baseado APENAS nessa última conversa, preencha os dados abaixo.
                
                Retorne um JSON estrito:
                {
                    "nome_cliente": "Nome do Cliente identificado",
                    "resumo_ultima_sessao": "Resumo executivo do que foi tratado na última data",
                    "pontos_importantes": "Top 3 pontos de atenção ou decisões tomadas",
                    "status_cliente": "Uma palavra ou frase curta (Ex: Satisfeito, Ansioso, Irritado)",
                    "status_projeto": "Uma palavra ou frase curta (Ex: Em Dia, Atrasado, Bug Crítico)"
                }
            `;

            const docResponse = await axios.post(
                `${BASE_URL}/openai/question`,
                {
                    context: `Documento alvo: ${link}`,
                    question: promptAnalise
                },
                { headers: { 'Authorization': `Bearer ${HEADOFFICE_API_KEY}` } }
            );

            // Parse seguro da resposta
            let parsed = {};
            try {
                const raw = docResponse.data.answer.replace(/```json/g, '').replace(/```/g, '');
                parsed = JSON.parse(raw);
            } catch (e) {
                parsed = { 
                    resumo_ultima_sessao: docResponse.data.answer.substring(0, 300) + "...", 
                    status_cliente: "Erro Leitura", 
                    status_projeto: "Indefinido",
                    nome_cliente: "Cliente"
                };
            }

            // Salva no Supabase
            const { data: saved } = await supabase.from('sessoes_resumos').upsert({
                doc_link: link,
                nome_cliente: parsed.nome_cliente || "Cliente",
                resumo_ultima_sessao: parsed.resumo_ultima_sessao,
                pontos_discussao: parsed.pontos_importantes || "",
                status_cliente: parsed.status_cliente || "Neutro",
                status_projeto: parsed.status_projeto || "Em Análise",
                last_updated: new Date()
            }).select().single();

            if (saved) results.push(saved);
        }

        res.json({ success: true, count: results.length, data: results });

    } catch (error) {
        console.error(`Erro no passo [${step}]:`, error.message);
        
        const errorDetail = error.response 
            ? `Status ${error.response.status}: ${JSON.stringify(error.response.data)}` 
            : error.message;

        res.status(500).json({ 
            error: "Falha no processo do Agente.", 
            step_failed: step,
            details: errorDetail
        });
    }
});

module.exports = app;

// --- DASHBOARD HTML (Visualização) ---
const DASHBOARD_HTML = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>IAgente Monitor - HeadOffice</title>
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
            <button onclick="syncAgent()" id="btnSync" class="glass px-6 py-3 rounded-xl flex items-center gap-2 hover:bg-white/5 transition-all text-sm font-bold cursor-pointer">
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
            if(!data || !data.length) { grid.innerHTML = '<div class="col-span-3 text-center py-20 glass rounded-2xl text-slate-400">Nenhuma análise encontrada. Clique em Analisar Planilha.</div>'; return; }
            data.forEach(item => {
                grid.innerHTML += \`
                <div class="glass rounded-2xl p-6 flex flex-col gap-4 relative overflow-hidden group hover:border-indigo-500/30 transition-all">
                    <div class="flex justify-between items-start">
                        <div>
                            <h2 class="font-bold text-white text-lg">\${item.nome_cliente || 'Cliente'}</h2>
                            <a href="\${item.doc_link}" target="_blank" class="text-xs text-purple-400 hover:text-white flex items-center gap-1 mt-1"><i data-lucide="external-link" class="w-3 h-3"></i> Link Doc</a>
                        </div>
                        <span class="text-[10px] bg-white/5 px-2 py-1 rounded text-slate-500">\${new Date(item.last_updated).toLocaleDateString()}</span>
                    </div>
                    
                    <div class="grid grid-cols-2 gap-3">
                        <div class="bg-indigo-500/10 border border-indigo-500/20 p-2 rounded text-center">
                            <span class="text-[10px] text-indigo-300 uppercase font-bold block mb-1">Cliente</span>
                            <span class="text-xs text-white">\${item.status_cliente}</span>
                        </div>
                        <div class="bg-pink-500/10 border border-pink-500/20 p-2 rounded text-center">
                            <span class="text-[10px] text-pink-300 uppercase font-bold block mb-1">Projeto</span>
                            <span class="text-xs text-white">\${item.status_projeto}</span>
                        </div>
                    </div>

                    <div>
                        <h3 class="text-xs font-bold text-slate-400 mb-1 uppercase tracking-wide">Resumo Última Sessão</h3>
                        <p class="text-sm text-slate-300 leading-relaxed font-light bg-black/20 p-3 rounded-lg border border-white/5">\${item.resumo_ultima_sessao}</p>
                    </div>

                    <div class="mt-auto">
                        <h3 class="text-xs font-bold text-yellow-500 mb-1 flex items-center gap-1"><i data-lucide="alert-triangle" class="w-3 h-3"></i> Pontos de Atenção</h3>
                        <p class="text-xs text-slate-400">\${item.pontos_discussao}</p>
                    </div>
                </div>\`;
            });
            lucide.createIcons();
        }

        async function fetchD() { try { const res = await fetch(API_URL+'/api/dashboard-data'); const json = await res.json(); render(json); } catch(e){} }

        async function syncAgent() {
            const btn = document.getElementById('btnSync'); const msg = document.getElementById('statusMsg');
            const icon = document.getElementById('iconSync');
            
            btn.disabled=true; btn.classList.add('opacity-50'); icon.classList.add('animate-spin');
            msg.innerHTML = "📡 Conectando ao Google Sheets e analisando documentos...<br>Isso pode levar até 1 minuto."; 
            msg.className="mb-8 p-4 rounded-xl bg-blue-500/10 text-blue-300 block";
            
            try { 
                const res = await fetch(API_URL+'/api/sync-agent'); 
                const json = await res.json();
                
                if(json.success) { 
                    msg.innerHTML = \`✅ Sucesso! \${json.count} sessões analisadas.\`; 
                    msg.className="mb-8 p-4 rounded-xl bg-emerald-500/10 text-emerald-300 block";
                    fetchD(); 
                } else { 
                    msg.innerHTML = "⚠️ " + (json.message || json.error) + (json.details ? "<br><span class='text-xs opacity-70'>" + json.details + "</span>" : ""); 
                    msg.className="mb-8 p-4 rounded-xl bg-red-500/10 text-red-300 block";
                }
            } catch(e) { 
                msg.innerHTML = "❌ Erro Fatal: " + e.message; 
                msg.className="mb-8 p-4 rounded-xl bg-red-500/10 text-red-300 block"; 
            }
            
            btn.disabled=false; btn.classList.remove('opacity-50'); icon.classList.remove('animate-spin');
        }
        fetchD();
    </script>
</body>
</html>
`;