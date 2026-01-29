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
    // Remove "Bearer" para evitar erro 403 da API
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

// --- 1. PARSER DE DATAS BR (ROBUSTO) ---
function parseDateFromTitle(title) {
    if (!title) return null;
    const lower = title.toLowerCase();

    // Mapa de meses (aceita abrev e full)
    const meses = { 
        "jan": 0, "fev": 1, "mar": 2, "abr": 3, "mai": 4, "jun": 5, "jul": 6, "ago": 7, "set": 8, "out": 9, "nov": 10, "dez": 11,
        "janeiro": 0, "fevereiro": 1, "março": 2, "abril": 3, "maio": 4, "junho": 5, "julho": 6, "agosto": 7, "setembro": 8, "outubro": 9, "novembro": 10, "dezembro": 11
    };

    // 1. Tenta formato extenso: "14 de jan" ou "14 jan" ou "14 de janeiro"
    // Regex captura dia e mês (primeiros 3 chars ou nome completo)
    const regexExt = /(\d{1,2})\s*(?:de)?\s*([a-zç]{3,})/;
    let match = lower.match(regexExt);

    if (match) {
        const day = parseInt(match[1]);
        let monthStr = match[2];
        // Normaliza "jan." para "jan"
        if (monthStr.length > 3) monthStr = monthStr.substring(0, 3);
        // Trata "março" -> "mar"
        if (monthStr === 'mar' || monthStr === 'març') monthStr = 'mar';
        
        const month = meses[monthStr];
        
        // Tenta achar ano na string (ex: 2026), senão usa atual
        const yearMatch = lower.match(/20\d{2}/);
        const year = yearMatch ? parseInt(yearMatch[0]) : new Date().getFullYear();

        if (month !== undefined) return new Date(year, month, day);
    }

    // 2. Tenta formato numérico: "14/01/26" ou "14-01-2026"
    const regexNum = /(\d{1,2})[\/\.\-](\d{1,2})(?:[\/\.\-](\d{2,4}))?/;
    match = lower.match(regexNum);
    
    if (match) {
        const day = parseInt(match[1]);
        const month = parseInt(match[2]) - 1;
        let year = match[3] ? parseInt(match[3]) : new Date().getFullYear();
        if (year < 100) year += 2000;
        return new Date(year, month, day);
    }

    return null; // Sem data identificável
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

// --- 3. CORTE INTELIGENTE ("SNIPER") ---
function optimizeTextForGet(text) {
    if (!text) return "";
    let clean = text;

    // A. Remove o Lixo (Rodapé e Transcrição Bruta)
    const lower = clean.toLowerCase();
    const endMarkers = ["revise as anotações do gemini", "00:00:00", "envie feedback sobre o uso", "transcrição\n00:"];
    
    let cutoff = clean.length;
    for (const m of endMarkers) {
        const idx = lower.indexOf(m);
        if (idx !== -1 && idx < cutoff) cutoff = idx;
    }
    clean = clean.substring(0, cutoff).trim();

    // B. Compressão de Espaços
    clean = clean.replace(/\n\s*\n/g, '\n').replace(/\s+/g, ' ');

    // C. Estratégia de Corte para URL (Max ~1800 chars)
    const MAX = 1800;
    if (clean.length <= MAX) return clean;

    // SE O TEXTO FOR GRANDE:
    // Prioridade 1: O Início (Resumo)
    // Prioridade 2: As "Próximas Etapas" (Geralmente no final ou buscáveis)
    
    // Tenta achar onde começam os "Próximos Passos"
    const stepsMarkers = ["próximas etapas", "próximos passos", "ações futuras", "encaminhamentos"];
    let stepsIdx = -1;
    
    for (const sm of stepsMarkers) {
        const idx = clean.toLowerCase().lastIndexOf(sm);
        if (idx !== -1) { stepsIdx = idx; break; }
    }

    if (stepsIdx !== -1) {
        // Se achou "Próximos Passos", garante que eles entrem!
        // Pega os primeiros 800 chars (Resumo) + Os 1000 chars a partir dos Próximos Passos
        const head = clean.substring(0, 800);
        const tail = clean.substring(stepsIdx, stepsIdx + 1000); // Pega 1000 chars a partir do marcador
        return `${head} ... [MEIO OMITIDO] ... ${tail}`;
    } else {
        // Se não achou marcador explícito, pega Início e Fim (Sanduíche Clássico)
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

    // Processa Abas
    if (doc.tabs && doc.tabs.length > 0) {
        doc.tabs.forEach(t => {
            const title = t.tabProperties.title || "Sem Título";
            const date = parseDateFromTitle(title);
            let content = "";
            if (t.documentTab && t.documentTab.body) {
                content = readStructuralElements(t.documentTab.body.content);
            }
            if (content.trim().length > 0) {
                tabsData.push({
                    title: title,
                    date: date,
                    timestamp: date ? date.getTime() : 0, 
                    content: content
                });
            }
        });
    } else {
        const content = readStructuralElements(doc.body.content);
        if (content.trim().length > 0) {
            tabsData.push({ title: "Principal", date: null, timestamp: 0, content: content });
        }
    }

    // ORDENAÇÃO CRÍTICA: Antiga -> Recente
    tabsData.sort((a, b) => a.timestamp - b.timestamp);
    
    // Debug de Datas no Log
    tabsData.forEach(t => console.log(`[TAB] ${t.title} -> ${t.date ? t.date.toLocaleDateString() : 'S/D'}`));

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
// LÓGICA DE INTELIGÊNCIA (DIRECTOR MODE + SNIPER)
// ======================================================

async function processCompanyIntelligence(id, nome) {
    const authHeader = getHeadOfficeToken();
    
    let docId = null;
    let docUrl = null;

    if (!authHeader) return { success: false, error: "Token HeadOffice inválido." };

    try {
        // 1. LINK NO CSV
        try {
            const csvResponse = await axios.get(SHEET_CSV_URL);
            const lines = csvResponse.data.split('\n');
            for (const line of lines) {
                if (line.toLowerCase().includes(nome.toLowerCase())) {
                    const match = line.match(/\/d\/([a-zA-Z0-9_-]+)/);
                    if (match) { 
                        docId = match[1];
                        docUrl = `https://docs.google.com/document/d/${docId}`;
                        break; 
                    }
                }
            }
        } catch (e) { console.warn(`CSV Error para ${nome}`); }

        if (!docId) return { success: false, error: `Link não encontrado para ${nome}.` };

        // 2. LER ABAS (GCP)
        let allTabs = [];
        try {
            allTabs = await getAllTabsSorted(docId);
            if (allTabs.length === 0) return { success: false, error: "Doc vazio." };
        } catch (apiError) {
            return { success: false, error: "Erro GCP: " + apiError.message };
        }

        // 3. ANÁLISE EM CADEIA
        let currentMemory = "Início da análise.";
        console.log(`[IA] Processando ${allTabs.length} abas em ordem cronológica.`);

        for (let i = 0; i < allTabs.length; i++) {
            const tab = allTabs[i];
            const isLast = i === allTabs.length - 1;
            
            // --- CORTE ESTRATÉGICO PARA GET ---
            const cleanContent = optimizeTextForGet(tab.content);
            console.log(`[IA] Aba ${i+1} (${tab.title}): ${cleanContent.length} chars enviados.`);

            let prompt = "";
            let contextForUrl = "";

            if (!isLast) {
                // ABAS PASSADAS: Acumula contexto
                prompt = `ATUE COMO CS MANAGER.
                REUNIÃO PASSADA: ${tab.title}.
                
                MEMÓRIA ATUAL: ${currentMemory}
                
                RESUMO DESTA REUNIÃO:
                ${cleanContent}
                
                INSTRUÇÃO:
                Atualize a memória com fatos importantes (sentimento, decisões).
                Seja conciso (max 1000 chars).`;
                
                contextForUrl = `MEMÓRIA: ${currentMemory.slice(0, 1000)}`; 

            } else {
                // ABA FINAL: O Diretor assume
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

            // CHAMADA GET (Safe)
            let respostaIA = "";
            for (let retry = 0; retry < 2; retry++) {
                try {
                    const response = await axios.get(`${BASE_URL}/openai/question`, {
                        params: {
                            aiName: BOT_NAME,
                            aiId: BOT_ID,
                            question: prompt,
                            context: isLast ? "Foco na última reunião." : contextForUrl // O prompt final já tem o texto embutido
                        },
                        headers: { 'Authorization': authHeader },
                        timeout: 40000
                    });
                    
                    const tResp = response.data.text || response.data.answer;
                    if (tResp && tResp.trim().length > 2) {
                        respostaIA = tResp;
                        break; 
                    }
                } catch (e) { 
                    console.error(`Erro IA Aba ${i}: ${e.message}`);
                    if (e.response && e.response.status === 414) {
                        try {
                            // Fallback: Reduz contexto para 500 chars se der erro de URL
                            const miniContext = contextForUrl.slice(0, 500);
                            const r2 = await axios.get(`${BASE_URL}/openai/question`, {
                                params: { aiName: BOT_NAME, aiId: BOT_ID, question: prompt, context: miniContext },
                                headers: { 'Authorization': authHeader }
                            });
                            respostaIA = r2.data.text || r2.data.answer;
                        } catch(e2) {}
                    }
                }
            }

            if (respostaIA) {
                currentMemory = respostaIA;
            }
        }

        // 4. FINALIZAR
        const jsonOnly = extractJSON(currentMemory);
        let data = {};

        try {
            data = JSON.parse(jsonOnly);
        } catch (e) {
            data = { resumo_executivo: "Erro ao processar JSON. Logs: " + currentMemory.substring(0, 300) };
        }

        const score = parseInt(data.sentimento_score, 10) || 5; // Default to Neutro
        let scoreColor, statusCliente;

        if (score >= 9) {
            statusCliente = "Extremamente Satisfeito";
            scoreColor = "text-cyan-400 border-cyan-500/30 bg-cyan-500/10";
        } else if (score >= 7) {
            statusCliente = "Satisfeito";
            scoreColor = "text-emerald-400 border-emerald-500/30 bg-emerald-500/10";
        } else if (score >= 5) {
            statusCliente = "Neutro";
            scoreColor = "text-yellow-400 border-yellow-500/30 bg-yellow-500/10";
        } else if (score >= 3) {
            statusCliente = "Insatisfeito";
            scoreColor = "text-orange-400 border-orange-500/30 bg-orange-500/10";
        } else {
            statusCliente = "Crítico";
            scoreColor = "text-red-400 border-red-500/30 bg-red-500/10";
        }

        const lastTabName = allTabs.length > 0 ? allTabs[allTabs.length-1].title : "Geral";

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
                    <div class="bg-[#0f172a] p-2.5 rounded border border-white/5 hover:border-indigo-500/30 transition-colors">
                        <div class="flex items-center gap-2 mb-1">
                            <i data-lucide="brain" class="w-3 h-3 text-purple-400"></i>
                            <span class="text-[10px] font-bold text-purple-200 uppercase tracking-wide">Perfil</span>
                        </div>
                        <p class="text-[10px] text-slate-400 leading-snug">${data.perfil_cliente || "-"}</p>
                    </div>
                    <div class="bg-[#0f172a] p-2.5 rounded border border-white/5 hover:border-emerald-500/30 transition-colors">
                        <div class="flex items-center gap-2 mb-1">
                            <i data-lucide="compass" class="w-3 h-3 text-emerald-400"></i>
                            <span class="text-[10px] font-bold text-emerald-200 uppercase tracking-wide">Ação</span>
                        </div>
                        <p class="text-[10px] text-slate-400 leading-snug italic">"${data.estrategia_relacionamento || "-"}"</p>
                    </div>
                </div>

                <div class="grid grid-cols-1 gap-2">
                    ${(data.checkpoints_feitos || []).length > 0 ? `
                    <div class="bg-white/[0.02] p-2 rounded border border-white/5">
                        <h4 class="text-[10px] font-bold text-slate-500 uppercase mb-2 flex items-center gap-1"><i data-lucide="check-circle-2" class="w-3 h-3"></i> Concluído (${lastTabName})</h4>
                        <ul class="space-y-1">
                            ${(data.checkpoints_feitos || []).map(i => `<li class="text-[10px] text-slate-400 flex items-start gap-2"><span class="w-1 h-1 bg-green-500/50 rounded-full mt-1.5"></span><span class="flex-1">${i}</span></li>`).join('')}
                        </ul>
                    </div>` : ''}
                    
                    ${(data.proximos_passos || []).length > 0 ? `
                    <div class="bg-indigo-500/[0.05] p-2 rounded border border-indigo-500/20">
                        <h4 class="text-[10px] font-bold text-indigo-400 uppercase mb-2 flex items-center gap-1"><i data-lucide="arrow-right-circle" class="w-3 h-3"></i> Próximos Passos</h4>
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
            status_cliente: statusCliente,
            last_updated: new Date()
        };

        await supabase.from('empresas').update(updatePayload).eq('id', id);
        return { success: true, data: updatePayload };

    } catch (error) {
        console.error(`[ERRO FATAL] para ${nome}:`, error.message);
        return { success: false, error: "Falha de processamento", details: error.message };
    }
}

app.post('/api/resumir-empresa', async (req, res) => {
    const { nome, id } = req.body;
    const result = await processCompanyIntelligence(id, nome);
    if (!result.success) {
        return res.status(500).json(result);
    }
    res.json(result);
});

// --- ROTA CRON (ATUALIZAÇÃO DIÁRIA) ---
// Configure no vercel.json: "crons": [{ "path": "/api/cron/daily-update", "schedule": "59 23 * * *" }]
app.get('/api/cron/daily-update', async (req, res) => {
    try {
        const { data: companies } = await supabase.from('empresas').select('*');
        if (!companies) return res.json({ message: "Nenhuma empresa." });

        const results = [];
        for (const company of companies) {
            const result = await processCompanyIntelligence(company.id, company.nome);
            results.push({ company: company.nome, success: result.success });
        }
        res.json({ status: "Ciclo diário concluído", details: results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- ROTA TESTE ---
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

// --- FRONTEND MANTIDO (IGUAL ANTERIOR) ---
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
        /* Status Cliente */
        .st-ExtremamenteSatisfeito { background: rgba(6, 182, 212, 0.1); color: #22d3ee; border-color: rgba(6, 182, 212, 0.3); }
        .st-Satisfeito { background: rgba(16, 185, 129, 0.15); color: #34d399; border-color: rgba(16, 185, 129, 0.3); }
        .st-Neutro { background: rgba(234, 179, 8, 0.1); color: #facc15; border-color: rgba(234, 179, 8, 0.3); }
        .st-Insatisfeito { background: rgba(249, 115, 22, 0.1); color: #fb923c; border-color: rgba(249, 115, 22, 0.3); }
        .st-Crítico { background: rgba(239, 68, 68, 0.15); color: #fca5a5; border-color: rgba(239, 68, 68, 0.3); }
        .card-unlinked { opacity: 0.6; transition: opacity 0.3s ease-in-out; }
        .card-unlinked:hover { opacity: 1; }
        /* Status Projeto (Exemplos) */
        .st-EmDia { background: rgba(16, 185, 129, 0.15); color: #34d399; border-color: rgba(16, 185, 129, 0.3); }
        .st-EmAnálise { background: rgba(148, 163, 184, 0.15); color: #e2e8f0; border-color: rgba(148, 163, 184, 0.3); }
        .st-Atrasado, .st-Risco { background: rgba(239, 68, 68, 0.15); color: #fca5a5; border-color: rgba(239, 68, 68, 0.3); }
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
                    <p class="text-slate-400 text-xs font-medium tracking-wide">REAL-TIME INTELLIGENCE FEED</p>
                </div>
            </div>
            <div class="flex items-center gap-3 w-full md:w-auto">
                <div class="relative">
                    <input type="text" id="searchBox" onkeyup="filterGrid()" placeholder="Buscar empresa..." 
                        class="w-48 bg-slate-900/80 border border-slate-700 text-white text-sm rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 block p-2.5 pl-10 transition-all">
                    <i data-lucide="search" class="absolute left-3 top-3 w-4 h-4 text-slate-500 pointer-events-none"></i>
                </div>
                <div class="relative">
                    <select id="statusFilter" onchange="filterGrid()" class="bg-slate-900/80 border border-slate-700 text-white text-sm rounded-lg focus:ring-2 focus:ring-indigo-500 block p-2.5 pr-8 appearance-none cursor-pointer">
                        <option value="all">Todos</option>
                        <option value="Extremamente Satisfeito">Extremamente Satisfeitos</option>
                        <option value="Satisfeito">Satisfeitos</option>
                        <option value="Neutro">Neutros</option>
                        <option value="Insatisfeito">Insatisfeitos</option>
                        <option value="Crítico">Críticos</option>
                    </select>
                    <i data-lucide="filter" class="absolute right-3 top-3 w-4 h-4 text-slate-500 pointer-events-none"></i>
                </div>
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
                    const sCli = (emp.status_cliente || 'Neutro').replace(/\s/g, '');
                    const hasDocLink = emp.doc_link && emp.doc_link.length > 5;
                    const cardStateClasses = !hasDocLink ? 'card-unlinked' : '';
                    const contentHtml = emp.resumo && emp.resumo.includes('<div') 
                        ? emp.resumo 
                        : \`<div class="flex flex-col items-center justify-center h-40 text-slate-500 gap-2"><i data-lucide="ghost" class="w-6 h-6 opacity-30"></i><p class="text-xs">Sem inteligência gerada.</p></div>\`;
                    grid.innerHTML += \`
                    <div class="glass-card rounded-2xl flex flex-col h-full relative group company-card \${cardStateClasses}" data-status="\${emp.status_cliente || 'Neutro'}">
                        <div class="p-5 pb-3 border-b border-white/5">
                            <div class="flex justify-between items-start mb-3">
                                <h2 class="font-bold text-white text-lg tracking-tight truncate w-10/12 group-hover:text-indigo-300 transition-colors" title="\${emp.nome}">\${emp.nome}</h2>
                                \${emp.doc_link ? \`<a href="\${emp.doc_link}" target="_blank" class="text-slate-600 hover:text-white transition-colors p-1 hover:bg-white/10 rounded"><i data-lucide="file-text" class="w-4 h-4"></i></a>\` : ''}
                            </div>
                            <div class="flex gap-2">
                                <span class="badge st-\${sCli}">\${emp.status_cliente || 'PENDENTE'}</span>
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
        function filterGrid() {
            const statusFilter = document.getElementById('statusFilter').value;
            const searchQuery = document.getElementById('searchBox').value.toLowerCase();
            const cards = document.querySelectorAll('.company-card');
            cards.forEach(card => {
                const cardStatus = card.getAttribute('data-status');
                const cardName = card.querySelector('h2').getAttribute('title').toLowerCase();

                const statusMatch = (statusFilter === 'all' || cardStatus === statusFilter);
                const searchMatch = cardName.includes(searchQuery);

                if (statusMatch && searchMatch) {
                    card.style.display = 'flex';
                } else {
                    card.style.display = 'none';
                }
            });
        }
        async function summarize(nome, id) {
            const btn = document.getElementById('btn-' + id);
            const card = btn.closest('.company-card');
            const originalHTML = btn.innerHTML;

            if (card) {
                const overlay = document.createElement('div');
                overlay.className = 'absolute inset-0 bg-slate-900/80 flex flex-col items-center justify-center rounded-2xl z-10';
                overlay.innerHTML = '<i data-lucide="loader-2" class="animate-spin w-10 h-10 text-indigo-400"></i><p class="mt-3 text-xs text-indigo-300 font-mono">REPROCESSANDO...</p>';
                card.appendChild(overlay);
                lucide.createIcons();
            }

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
                if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
                const json = await res.json();
                if (json.success) { 
                    loadCompanies(); 
                } else { 
                    alert('Erro: ' + (json.details || json.error)); 
                    if (card) card.querySelector('.absolute.inset-0')?.remove();
                    btn.innerHTML = 'FALHA NA EXTRAÇÃO';
                    btn.className = "w-full bg-red-900/20 text-red-400 border border-red-500/30 py-2.5 rounded-lg text-xs font-bold";
                    setTimeout(() => { btn.disabled = false; btn.innerHTML = originalHTML; btn.className = "w-full bg-slate-800 hover:bg-indigo-600 text-slate-300 hover:text-white py-2.5 rounded-lg text-xs font-bold tracking-wide transition-all flex justify-center items-center gap-2 border border-white/5"; lucide.createIcons(); }, 3000);
                }
            } catch (e) { 
                if (card) card.querySelector('.absolute.inset-0')?.remove();
                btn.innerHTML = 'ERRO DE CONEXÃO';
                alert('Falha na comunicação com a API: ' + e.message);
                setTimeout(() => { btn.disabled = false; btn.innerHTML = originalHTML; btn.className = "w-full bg-slate-800 hover:bg-indigo-600 text-slate-300 hover:text-white py-2.5 rounded-lg text-xs font-bold tracking-wide transition-all flex justify-center items-center gap-2 border border-white/5"; lucide.createIcons(); }, 3000);
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
`;          btn.innerHTML = '<i data-lucide="loader-2" class="animate-spin w-3 h-3"></i> EXTRAINDO INTELIGÊNCIA...';
            lucide.createIcons();

            try {
                const res = await fetch(API_URL + '/api/resumir-empresa', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ nome, id })
                });
                if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
                const json = await res.json();
                if (json.success) { 
                    loadCompanies(); 
                } else { 
                    alert('Erro: ' + (json.details || json.error)); 
                    if (card) card.querySelector('.absolute.inset-0')?.remove();
                    btn.innerHTML = 'FALHA NA EXTRAÇÃO';
                    btn.className = "w-full bg-red-900/20 text-red-400 border border-red-500/30 py-2.5 rounded-lg text-xs font-bold";
                    setTimeout(() => { btn.disabled = false; btn.innerHTML = originalHTML; btn.className = "w-full bg-slate-800 hover:bg-indigo-600 text-slate-300 hover:text-white py-2.5 rounded-lg text-xs font-bold tracking-wide transition-all flex justify-center items-center gap-2 border border-white/5"; lucide.createIcons(); }, 3000);
                }
            } catch (e) { 
                if (card) card.querySelector('.absolute.inset-0')?.remove();
                btn.innerHTML = 'ERRO DE CONEXÃO';
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
                alert('Falha na comunicação com a API: ' + e.message);
                setTimeout(() => { btn.disabled = false; btn.innerHTML = originalHTML; btn.className = "w-full bg-slate-800 hover:bg-indigo-600 text-slate-300 hover:text-white py-2.5 rounded-lg text-xs font-bold tracking-wide transition-all flex justify-center items-center gap-2 border border-white/5"; lucide.createIcons(); }, 3000);
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