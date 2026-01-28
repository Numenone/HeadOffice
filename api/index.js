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

const HEADOFFICE_API_URL = 'https://api.headoffice.ai/v1';
const SHEET_ID = '1m6yZozLKIZ8KyT9YW62qikkSZE-CrQsjTNTX6V9Y0eM';

// --- ROTA 1: ENTREGA O DASHBOARD (HTML) ---
app.get('/', (req, res) => {
    const currentUrl = `https://${req.headers.host}`;
    const htmlComUrl = DASHBOARD_HTML.replace('https://head-office-one.vercel.app', currentUrl);
    res.send(htmlComUrl);
});

// --- ROTA 2: LEITURA DE DADOS (JSON) ---
app.get('/api/dashboard-data', async (req, res) => {
    try {
        const { data, error } = await supabase.from('sessoes_resumos').select('*').order('last_updated', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- ROTA 3: SINCRONIZAR IAGENTE (LÓGICA PROFUNDA) ---
app.get('/api/sync-agent', async (req, res) => {
    try {
        const HEADOFFICE_API_KEY = process.env.HEADOFFICE_API_KEY;
        if (!HEADOFFICE_API_KEY) throw new Error("API Key não configurada.");

        // 1. Indexar a Planilha "Mãe"
        await axios.post(
            `${HEADOFFICE_API_URL}/google-sheets/search-store`,
            { spreadsheetId: SHEET_ID }, 
            { headers: { 'Authorization': `Bearer ${HEADOFFICE_API_KEY}` } }
        );

        // 2. Extrair Links da Coluna "Links Docs"
        const linksQuery = await axios.post(
            `${HEADOFFICE_API_URL}/openai/question`,
            { 
                context: `Contexto: Planilha ID ${SHEET_ID}.`,
                question: `Vá na coluna chamada "Links Docs". Extraia TODAS as URLs de documentos google docs listadas ali. Retorne APENAS um JSON Array puro. Exemplo: ["https://docs...", "https://docs..."].`
            },
            { headers: { 'Authorization': `Bearer ${HEADOFFICE_API_KEY}` } }
        );

        let linksDocs = [];
        try {
            const raw = linksQuery.data.answer.replace(/```json/g, '').replace(/```/g, '').trim();
            linksDocs = JSON.parse(raw);
        } catch (e) {
            const urlRegex = /(https?:\/\/[^\s,\]"]+)/g;
            linksDocs = linksQuery.data.answer.match(urlRegex) || [];
        }

        if (!linksDocs || linksDocs.length === 0) return res.json({ success: false, message: "Nenhum link encontrado." });

        // 3. Processar Cada Documento (Conversa)
        const results = [];
        
        // PROMPT ESPECIALIZADO EM ANÁLISE DE SESSÃO
        const promptAnalise = `
            Você é um Analista de Projetos Sênior da HeadOffice.
            Acesse e LEIA O CONTEÚDO COMPLETO deste link. O documento contém transcrições de conversas separadas por datas.
            
            SUA MISSÃO:
            1. Identifique a ÚLTIMA data/sessão registrada no texto (ignore as antigas).
            2. Identifique o NOME do Cliente.
            3. Resuma o que foi discutido e decidido APENAS nessa última sessão.
            4. Avalie o "Estado do Cliente": Ele está Feliz? Ansioso? Irritado? Pedindo muitas mudanças?
            5. Avalie o "Estado do Projeto (IAgente)": Está rodando? Tem bugs? Precisa de ajustes?
            
            Retorne APENAS um JSON estrito:
            {
                "nome_cliente": "Nome identificado",
                "resumo_ultima_sessao": "Resumo focado na última conversa",
                "pontos_importantes": "Top 3 pontos técnicos ou de negócio decididos",
                "status_cliente": "Uma frase curta sobre o sentimento do cliente (Ex: Satisfeito, Preocupado com prazo)",
                "status_projeto": "Uma frase curta sobre a saúde técnica (Ex: Em testes, Bug no login, Finalizado)"
            }
        `;

        for (const link of linksDocs) {
            // Check de Cache para evitar timeout na Vercel (se já leu hoje, não lê de novo)
            // Para forçar re-leitura, limpe o banco ou remova esse IF
            const { data: existing } = await supabase.from('sessoes_resumos').select('*').eq('doc_link', link).single();
            if (existing) { results.push(existing); continue; }

            const aiResponse = await axios.post(
                `${HEADOFFICE_API_URL}/openai/question`,
                {
                    context: `Analise este documento Google Docs: ${link}`,
                    question: promptAnalise
                },
                { headers: { 'Authorization': `Bearer ${HEADOFFICE_API_KEY}` } }
            );

            let parsed = {};
            try {
                const rawAnswer = aiResponse.data.answer.replace(/```json/g, '').replace(/```/g, '');
                parsed = JSON.parse(rawAnswer);
            } catch (e) {
                parsed = { resumo_ultima_sessao: aiResponse.data.answer, nome_cliente: "Não identificado" };
            }

            const { data: saved } = await supabase.from('sessoes_resumos').upsert({
                doc_link: link,
                nome_cliente: parsed.nome_cliente || "Cliente",
                resumo_ultima_sessao: parsed.resumo_ultima_sessao || "Sem resumo",
                pontos_discussao: parsed.pontos_importantes || "",
                status_cliente: parsed.status_cliente || "Neutro",
                status_projeto: parsed.status_projeto || "Em andamento",
                last_updated: new Date()
            }).select().single();
            
            if (saved) results.push(saved);
        }

        res.json({ success: true, count: results.length, data: results });

    } catch (error) {
        console.error("Erro Sync:", error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = app;

// --- DASHBOARD (FRONTEND) ---
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
        body { font-family: 'Inter', sans-serif; background-color: #0B0C15; color: #E2E8F0; overflow-x: hidden; }
        .stars { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -1; pointer-events: none; }
        .star { position: absolute; background: white; border-radius: 50%; animation: twinkle infinite ease-in-out; }
        @keyframes twinkle { 0%, 100% { opacity: 0.2; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.2); } }
        
        .glass { 
            background: rgba(30, 41, 59, 0.4); 
            backdrop-filter: blur(12px); 
            border: 1px solid rgba(148, 163, 184, 0.1); 
            box-shadow: 0 4px 30px rgba(0, 0, 0, 0.3);
        }
        .glass:hover { border-color: rgba(139, 92, 246, 0.4); transition: 0.3s; }
        
        .badge { font-size: 0.7rem; padding: 2px 8px; border-radius: 99px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
        .badge-purple { background: rgba(139, 92, 246, 0.2); color: #C4B5FD; border: 1px solid rgba(139, 92, 246, 0.3); }
        .badge-blue { background: rgba(59, 130, 246, 0.2); color: #93C5FD; border: 1px solid rgba(59, 130, 246, 0.3); }
    </style>
</head>
<body class="min-h-screen p-6 md:p-12">
    <script>const API_URL = 'https://head-office-one.vercel.app';</script>
    <div class="stars" id="starsContainer"></div>
    
    <div class="max-w-7xl mx-auto">
        <header class="flex flex-col md:flex-row justify-between items-center mb-12 gap-6">
            <div>
                <h1 class="text-4xl font-extrabold bg-clip-text text-transparent bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400">
                    IAgente Monitor
                </h1>
                <p class="text-slate-400 mt-2 text-sm">Dashboard de Acompanhamento de Sessões & Projetos</p>
            </div>
            
            <button onclick="syncAgent()" id="btnSync" class="glass px-6 py-3 rounded-xl flex items-center gap-3 text-sm font-semibold hover:bg-white/5 transition-all group">
                <i data-lucide="zap" class="text-yellow-400 group-hover:text-yellow-300 transition-colors" id="iconSync"></i>
                <span id="txtSync">Analisar Planilha & Docs</span>
            </button>
        </header>

        <div id="statusMsg" class="hidden mb-8 p-4 rounded-xl text-center text-sm font-medium animate-pulse"></div>

        <div id="cardsGrid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            </div>
    </div>

    <script>
        lucide.createIcons();
        
        // Background Estrelado
        const starContainer = document.getElementById('starsContainer');
        for(let i=0; i<70; i++) {
            const s = document.createElement('div'); s.className='star';
            s.style.top=Math.random()*100+'%'; s.style.left=Math.random()*100+'%';
            s.style.width=Math.random()*2+'px'; s.style.height=s.style.width;
            s.style.animationDuration=(Math.random()*3+2)+'s'; starContainer.appendChild(s);
        }

        function render(data) {
            const grid = document.getElementById('cardsGrid'); 
            grid.innerHTML = '';
            
            if(!data || !data.length) { 
                grid.innerHTML = '<div class="col-span-3 text-center py-20 glass rounded-2xl"><p class="text-slate-400">Nenhuma sessão analisada ainda.</p><p class="text-xs text-slate-500 mt-2">Clique em "Analisar" para iniciar a leitura.</p></div>'; 
                return; 
            }

            data.forEach(item => {
                grid.innerHTML += \`
                <div class="glass rounded-2xl p-6 flex flex-col gap-5 relative overflow-hidden group">
                    <div class="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-purple-500 to-pink-500 opacity-50"></div>
                    
                    <div class="flex justify-between items-start">
                        <div>
                            <h2 class="text-xl font-bold text-white mb-1">\${item.nome_cliente || 'Cliente Desconhecido'}</h2>
                            <a href="\${item.doc_link}" target="_blank" class="text-xs text-slate-400 hover:text-purple-400 flex items-center gap-1 transition-colors">
                                <i data-lucide="link" class="w-3 h-3"></i> Ver Documento Original
                            </a>
                        </div>
                        <span class="text-[10px] text-slate-500 bg-black/20 px-2 py-1 rounded">\${new Date(item.last_updated).toLocaleDateString()}</span>
                    </div>

                    <div class="grid grid-cols-2 gap-3">
                        <div class="bg-indigo-500/10 border border-indigo-500/20 p-3 rounded-xl">
                            <h3 class="text-[10px] uppercase text-indigo-300 font-bold mb-1">Estado do Cliente</h3>
                            <p class="text-xs text-indigo-100">\${item.status_cliente}</p>
                        </div>
                        <div class="bg-pink-500/10 border border-pink-500/20 p-3 rounded-xl">
                            <h3 class="text-[10px] uppercase text-pink-300 font-bold mb-1">Estado do Projeto</h3>
                            <p class="text-xs text-pink-100">\${item.status_projeto}</p>
                        </div>
                    </div>

                    <div>
                        <h3 class="text-sm font-semibold text-purple-300 mb-2 flex items-center gap-2">
                            <i data-lucide="history" class="w-4 h-4"></i> Última Sessão
                        </h3>
                        <p class="text-sm text-slate-300 leading-relaxed font-light">\${item.resumo_ultima_sessao}</p>
                    </div>

                    <div class="bg-black/20 p-4 rounded-xl border border-white/5 mt-auto">
                        <h3 class="text-xs font-bold text-yellow-500 mb-2 flex items-center gap-2">
                            <i data-lucide="alert-triangle" class="w-3 h-3"></i> Pontos de Atenção
                        </h3>
                        <p class="text-xs text-slate-400">\${item.pontos_discussao}</p>
                    </div>
                </div>\`;
            });
            lucide.createIcons();
        }

        async function fetchD() { 
            try { 
                const res = await fetch(API_URL+'/api/dashboard-data'); 
                const json = await res.json(); 
                render(json); 
            } catch(e) { console.error(e); } 
        }

        async function syncAgent() {
            const btn = document.getElementById('btnSync'); 
            const msg = document.getElementById('statusMsg');
            const icon = document.getElementById('iconSync');
            
            btn.disabled=true; 
            btn.classList.add('opacity-50', 'cursor-not-allowed');
            icon.classList.add('animate-spin'); // Ícone girando
            
            msg.innerHTML = "📡 <strong>Fase 1:</strong> Lendo a Planilha e buscando links...<br><span class='text-xs opacity-75'>Isso pode levar alguns segundos.</span>"; 
            msg.className = "mb-8 p-4 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-300 text-center text-sm block";
            
            try { 
                const res = await fetch(API_URL+'/api/sync-agent'); 
                const json = await res.json();
                
                if(json.success) { 
                    msg.innerHTML = \`✅ <strong>Análise Completa!</strong> \${json.count} clientes atualizados.\`; 
                    msg.className = "mb-8 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-center text-sm block";
                    fetchD(); 
                } else { 
                    throw new Error(json.message || "Erro desconhecido");
                }
            } catch(e) { 
                msg.innerHTML = "❌ <strong>Erro:</strong> " + e.message; 
                msg.className = "mb-8 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-center text-sm block";
            } finally {
                btn.disabled=false;
                btn.classList.remove('opacity-50', 'cursor-not-allowed');
                icon.classList.remove('animate-spin');
            }
        }

        fetchD();
    </script>
</body>
</html>
`;