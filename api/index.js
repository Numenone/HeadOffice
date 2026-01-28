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

// --- ROTA 1: ENTREGA O DASHBOARD (HTML) ---
app.get('/', (req, res) => {
    // Injeta a URL correta da API no HTML antes de enviar
    // O 'req.headers.host' pega a URL atual do site automaticamente
    const currentUrl = `https://${req.headers.host}`;
    const htmlComUrl = DASHBOARD_HTML.replace('https://head-office-2e6tmw369-numenones-projects.vercel.app', currentUrl);
    res.send(htmlComUrl);
});

// --- ROTA 2: LEITURA DE DADOS (JSON) ---
app.get('/api/dashboard-data', async (req, res) => {
    try {
        const { data, error } = await supabase.from('sessoes_resumos').select('*');
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- ROTA 3: SINCRONIZAR IAGENTE (ACÃO) ---
app.get('/api/sync-agent', async (req, res) => {
    try {
        const HEADOFFICE_API_KEY = process.env.HEADOFFICE_API_KEY;
        const linksDocs = ["https://docs.google.com/document/d/1X50-rBqj4HlT-JgXv6yEwQp0y-T0z"]; // Exemplo fixo ou buscar da planilha

        const results = [];
        const promptSystem = `Você é um assistente executivo. Leia o conteúdo, gere um JSON estrito: { "resumo": "...", "pontos_importantes": "...", "tarefas_cliente": "...", "tarefas_ho": "..." }`;

        for (const link of linksDocs) {
            const { data: existing } = await supabase.from('sessoes_resumos').select('*').eq('doc_link', link).single();
            if (existing) { results.push(existing); continue; }

            const aiResponse = await axios.post(
                `${HEADOFFICE_API_URL}/openai/question`,
                { context: `Link: ${link}`, question: promptSystem },
                { headers: { 'Authorization': `Bearer ${HEADOFFICE_API_KEY}` } }
            );

            let parsedData = {};
            try {
                const raw = aiResponse.data.answer.replace(/```json/g, '').replace(/```/g, '');
                parsedData = JSON.parse(raw);
            } catch (e) { parsedData = { resumo: aiResponse.data.answer }; }

            const { data: saved } = await supabase.from('sessoes_resumos').upsert({
                doc_link: link,
                resumo_sessao: parsedData.resumo || "",
                pontos_discussao: parsedData.pontos_importantes || "",
                tarefas_cliente: parsedData.tarefas_cliente || "",
                tarefas_headoffice: parsedData.tarefas_ho || ""
            }).select().single();
            
            if (saved) results.push(saved);
        }
        res.json({ success: true, data: results });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = app;

// --- O DASHBOARD FICA AQUI EMBAIXO ---
const DASHBOARD_HTML = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>IAgente Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/lucide@latest"></script>
    <style>
        body { font-family: sans-serif; background-color: #090A0F; color: white; }
        .stars { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -1; pointer-events: none; }
        .star { position: absolute; background: white; border-radius: 50%; animation: twinkle infinite ease-in-out; }
        @keyframes twinkle { 0%, 100% { opacity: 0.2; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.2); } }
        .glass { background: rgba(255, 255, 255, 0.03); backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.1); }
    </style>
</head>
<body class="min-h-screen p-8">
    <script>const API_URL = 'SUA_URL_DA_VERCEL_AQUI';</script>
    <div class="stars" id="starsContainer"></div>
    <div class="max-w-7xl mx-auto">
        <header class="flex justify-between items-center mb-12">
            <h1 class="text-3xl font-bold text-purple-400">HeadOffice Agent</h1>
            <button onclick="syncAgent()" id="btnSync" class="glass px-6 py-3 rounded-xl hover:bg-white/10 transition-all flex gap-2 items-center">
                <i data-lucide="refresh-cw" id="iconSync"></i> <span id="txtSync">Acordar IAgente</span>
            </button>
        </header>
        <div id="statusMsg" class="hidden mb-8 p-4 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-300 text-center"></div>
        <div id="cardsGrid" class="grid grid-cols-1 md:grid-cols-3 gap-6"></div>
    </div>
    <script>
        lucide.createIcons();
        const starContainer = document.getElementById('starsContainer');
        for(let i=0; i<50; i++) {
            const s = document.createElement('div'); s.className='star';
            s.style.top=Math.random()*100+'%'; s.style.left=Math.random()*100+'%';
            s.style.width=Math.random()*3+'px'; s.style.height=s.style.width;
            s.style.animationDuration=(Math.random()*3+2)+'s'; starContainer.appendChild(s);
        }
        function render(data) {
            const grid = document.getElementById('cardsGrid'); grid.innerHTML = '';
            if(!data.length) { grid.innerHTML = '<p class="text-gray-500">Nada encontrado.</p>'; return; }
            data.forEach(item => {
                grid.innerHTML += \`
                <div class="glass rounded-xl p-6 flex flex-col gap-4">
                    <div class="text-blue-300 border-b border-white/10 pb-2 text-xs truncate">\${item.doc_link}</div>
                    <div><h3 class="font-bold text-purple-300">Resumo</h3><p class="text-xs text-gray-400">\${item.resumo_sessao}</p></div>
                    <div class="bg-white/5 p-3 rounded"><h3 class="font-bold text-yellow-300 text-xs">Discussão</h3><p class="text-xs text-gray-400">\${item.pontos_discussao}</p></div>
                </div>\`;
            });
        }
        async function fetchD() { 
            try { const res = await fetch(API_URL+'/api/dashboard-data'); const json = await res.json(); render(json); } 
            catch(e) { console.log(e); } 
        }
        async function syncAgent() {
            const btn = document.getElementById('btnSync'); const msg = document.getElementById('statusMsg');
            btn.disabled=true; msg.innerText="Lendo..."; msg.classList.remove('hidden');
            try { await fetch(API_URL+'/api/sync-agent'); msg.innerText="Pronto!"; fetchD(); } catch(e) { msg.innerText="Erro"; }
            btn.disabled=false;
        }
        fetchD();
    </script>
</body>
</html>
`;