// api/index.js
require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const app = express();

// Configuração CORS para permitir que seu frontend acesse
app.use(cors({
    origin: '*', // Em produção, troque '*' pela URL do seu frontend
    methods: ['GET', 'POST', 'OPTIONS']
}));

app.use(express.json());

// Validação básica para evitar crash se faltar variável
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error("Faltam variáveis de ambiente do Supabase");
}

const supabase = createClient(
    process.env.SUPABASE_URL || '', 
    process.env.SUPABASE_KEY || ''
);

const SHEET_ID = '1m6yZozLKIZ8KyT9YW62qikkSZE-CrQsjTNTX6V9Y0eM';
const HEADOFFICE_API_URL = 'https://api.headoffice.ai/v1';

// Rota de teste para ver se a API está viva
//app.get('/', (req, res) => {
//    res.send('IAgente Backend Online 🚀');
//});

app.get('/api/dashboard-data', async (req, res) => {
    try {
        const { data, error } = await supabase.from('sessoes_resumos').select('*');
        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sync-agent', async (req, res) => {
    try {
        const HEADOFFICE_API_KEY = process.env.HEADOFFICE_API_KEY;
        
        // 1. Simulação ou Busca real dos links (adaptar conforme retorno da API)
        // Se a API 'search-store' retornar o conteúdo, use-o aqui.
        // Se não, aqui está uma lista manual baseada no seu pedido anterior para teste:
        const linksDocs = ["https://docs.google.com/document/d/exemplo1"]; 

        const results = [];
        const promptSystem = `
            Você é um assistente executivo.
            Leia o conteúdo, gere um JSON estrito:
            { "resumo": "...", "pontos_importantes": "...", "tarefas_cliente": "...", "tarefas_ho": "..." }
        `;

        for (const link of linksDocs) {
            // Verifica cache
            const { data: existing } = await supabase
                .from('sessoes_resumos')
                .select('*')
                .eq('doc_link', link)
                .single();

            if (existing) {
                results.push(existing);
                continue;
            }

            // Chama IA
            const aiResponse = await axios.post(
                `${HEADOFFICE_API_URL}/openai/question`,
                {
                    context: `Resumo do link: ${link}`,
                    question: promptSystem
                },
                { headers: { 'Authorization': `Bearer ${HEADOFFICE_API_KEY}` } }
            );

            // Tratamento de erro no JSON parse
            let parsedData = {};
            try {
                // Tenta limpar markdown ```json se a IA enviar
                const rawAnswer = aiResponse.data.answer.replace(/```json/g, '').replace(/```/g, '');
                parsedData = JSON.parse(rawAnswer);
            } catch (e) {
                parsedData = { resumo: aiResponse.data.answer }; // Fallback
            }

            const { data: savedData } = await supabase
                .from('sessoes_resumos')
                .upsert({
                    doc_link: link,
                    resumo_sessao: parsedData.resumo || "",
                    pontos_discussao: parsedData.pontos_importantes || "",
                    tarefas_cliente: parsedData.tarefas_cliente || "",
                    tarefas_headoffice: parsedData.tarefas_ho || ""
                })
                .select()
                .single();
            
            if (savedData) results.push(savedData);
        }

        res.json({ success: true, data: results });

    } catch (error) {
        console.error("Erro no sync:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// Rota para servir o Dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
// IMPORTANTE: Não use app.listen aqui. Exporte o app.
module.exports = app;