// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Configuração Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Configuração HeadOffice & Google Sheet
const SHEET_ID = '1m6yZozLKIZ8KyT9YW62qikkSZE-CrQsjTNTX6V9Y0eM';
const HEADOFFICE_API_URL = 'https://api.headoffice.ai/v1';
const HEADOFFICE_API_KEY = process.env.HEADOFFICE_API_KEY; // Sua chave aqui

// Endpoint principal para atualizar/processar a planilha
app.post('/api/sync-agent', async (req, res) => {
  try {
    // 1. Indexar/Buscar dados da planilha via HeadOffice API
    // Assumindo que o endpoint search-store indexa ou lê a planilha
    const storeResponse = await axios.post(
      `${HEADOFFICE_API_URL}/google-sheets/search-store`,
      { spreadsheetId: SHEET_ID }, // Ajuste conforme documentação exata da HeadOffice
      { headers: { 'Authorization': `Bearer ${HEADOFFICE_API_KEY}` } }
    );

    // 2. Buscar especificamente os links da coluna "Links Docs"
    // Aqui simulamos a busca dos links. Se a API retornar o JSON da planilha, iteramos sobre ele.
    // Vamos supor que precisamos perguntar à IA quais são os links ou buscar via search.
    
    // Simulação: Vamos buscar as linhas da planilha (ou usar o output do passo anterior)
    // Para economizar tokens, vamos processar apenas o que não está no banco ou foi atualizado.
    
    // O prompt para a IA processar cada documento encontrado
    const promptSystem = `
      Você é um assistente executivo.
      Leia o conteúdo do documento fornecido.
      Saída esperada em JSON estrito:
      {
        "resumo": "Resumo do que foi feito na última sessão",
        "pontos_importantes": "Pontos para discussão",
        "tarefas_cliente": "Lista de tarefas do cliente",
        "tarefas_ho": "Lista de tarefas da headoffice.ai"
      }
    `;

    // Lógica Mockada de Iteração (Ajuste conforme o retorno real da API search-store)
    // Suponha que 'storeResponse.data' traga as linhas.
    const linksDocs = ["https://docs.google.com/document/d/exemplo1", "https://docs.google.com/document/d/exemplo2"]; 
    
    const results = [];

    for (const link of linksDocs) {
      // Verifica se já processamos esse link recentemente (Cache Strategy)
      const { data: existing } = await supabase
        .from('sessoes_resumos')
        .select('*')
        .eq('doc_link', link)
        .single();

      if (existing) {
        results.push(existing);
        continue; // Pula para economizar tokens se já existe
      }

      // Se não existe, processa com a IA
      // 1. Ler o conteudo do doc (via HeadOffice Search ou direto se suportado)
      // 2. Enviar para /v1/openai/question
      
      const aiResponse = await axios.post(
        `${HEADOFFICE_API_URL}/openai/question`,
        {
            context: `Conteúdo extraído do link: ${link}`, // A API teria que extrair isso
            question: promptSystem
        },
        { headers: { 'Authorization': `Bearer ${HEADOFFICE_API_KEY}` } }
      );
      
      // Parse da resposta da IA (Assumindo que ela retornou JSON string)
      // Nota: Em produção, adicione tratamento de erro de JSON parse
      const parsedData = JSON.parse(aiResponse.data.answer); 

      // Salva no Supabase
      const { data: savedData, error } = await supabase
        .from('sessoes_resumos')
        .upsert({
          doc_link: link,
          resumo_sessao: parsedData.resumo,
          pontos_discussao: parsedData.pontos_importantes,
          tarefas_cliente: parsedData.tarefas_cliente,
          tarefas_headoffice: parsedData.tarefas_ho
        })
        .select()
        .single();

      if (!error) results.push(savedData);
    }

    res.json({ success: true, data: results });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao processar agente' });
  }
});

// Endpoint para o Frontend ler os dados (Leitura barata, sem gastar tokens de IA)
app.get('/api/dashboard-data', async (req, res) => {
  const { data, error } = await supabase.from('sessoes_resumos').select('*');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));