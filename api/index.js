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
const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/1m6yZozLKIZ8KyT9YW62qikkSZE-CrQsjTNTX6V9Y0eM/export?format=csv';

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

// --- ROTA DE RESUMO ---
app.post('/api/resumir-empresa', async (req, res) => {
    const { nome, id } = req.body;
    
    // ======================================================
    // 🚨 ÁREA DE EMERGÊNCIA 🚨
    // Se a variável de ambiente falhar, cole o token aqui entre as aspas
    const TOKEN_DE_EMERGENCIA = ""; 
    // ======================================================
    
    let rawToken = TOKEN_DE_EMERGENCIA || process.env.HEADOFFICE_JWT || "";
    
    // Limpeza básica (remove espaços e aspas extras)
    rawToken = rawToken.trim();
    if (rawToken.startsWith('"') && rawToken.endsWith('"')) rawToken = rawToken.slice(1, -1);
    
    // MUDANÇA: Removemos "Bearer ". O header será apenas o token.
    // Se o token já vier com Bearer colado, removemos para garantir.
    if (rawToken.toLowerCase().startsWith('bearer ')) {
        rawToken = rawToken.substring(7).trim(); // Remove "Bearer " do início
    }
    
    const authHeader = rawToken; // Envia SOMENTE O CÓDIGO

    // Debug
    console.log(`[DEBUG] Token sendo enviado (primeiros 10 chars): ${authHeader.substring(0, 10)}...`);

    if (rawToken.length < 10) {
        return res.status(500).json({ error: "Token inválido/vazio." });
    }

    let step = "Início";

    try {
        // PASSO 1: Buscar Link na Planilha via CSV
        step = "Baixando CSV";
        const csvResponse = await axios.get(SHEET_CSV_URL);
        const csvData = csvResponse.data;
        const lines = csvData.split('\n');
        let docUrl = null;

        for (const line of lines) {
            if (line.toLowerCase().includes(nome.toLowerCase())) {
                const match = line.match(/(https:\/\/docs\.google\.com\/document\/d\/[a-zA-Z0-9_-]+)/);
                if (match) {
                    docUrl = match[0];
                    break;
                }
            }
        }

        if (!docUrl) return res.json({ success: false, error: `Link não encontrado no CSV para: ${nome}` });

        // PASSO 2: Resumir (IA)
        step = "Chamando API HeadOffice";
        
        const summaryResponse = await axios.get(`${BASE_URL}/openai/question`, {
            params: {
                aiName: 'Roger',
                context: `Documento: ${docUrl}`,
                question: `Leia a ÚLTIMA sessão. JSON estrito: {"resumo": "...", "pontos_importantes": "...", "status_cliente": "Satisfeito/Crítico", "status_projeto": "Em Dia/Atrasado"}`
            },
            headers: { 'Authorization': authHeader } // Sem Bearer, apenas token
        });

        // Tratamento
        let result = {};
        const answerRaw = summaryResponse.data.answer || "";
        try {
            const cleanJson = answerRaw.replace(/```json/g, '').replace(/```/g, '').trim();
            result = JSON.parse(cleanJson);
        } catch (e) {
            result = { resumo: answerRaw.substring(0, 400), status_cliente: "Erro Leitura", status_projeto: "Erro Leitura" };
        }

        // Salvar
        const updatePayload = {
            doc_link: docUrl,
            resumo: result.resumo,
            pontos_importantes: result.pontos_importantes || "",
            status_cliente: result.status_cliente || "Neutro",
            status_projeto: result.status_projeto || "Em Análise",
            last_updated: new Date()
        };

        await supabase.from('empresas').update(updatePayload).eq('id', id);
        res.json({ success: true, data: updatePayload });

    } catch (error) {
        console.error(`[ERRO] Passo: ${step}`, error.message);
        if (error.response) {
            console.error(`[ERRO RESPOSTA]`, JSON.stringify(error.response.data));
            return res.status(500).json({ 
                error: "Erro API HeadOffice", 
                step, 
                details: error.response.data 
            });
        }
        res.status(500).json({ error: "Erro interno", step, details: error.message });
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
        .status-Neutro, .status-Aguardando { color: #94a3b8; background: rgba(148, 163, 184, 0.1); border-color: rgba(148, 163, 184, 0.2); }
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