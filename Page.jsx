import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { RefreshCw, FileText, CheckCircle, AlertCircle, Sparkles } from 'lucide-react';

// Função para gerar estrelas aleatórias no fundo
const CosmicBackground = () => {
  const stars = Array.from({ length: 50 }).map((_, i) => ({
    id: i,
    top: `${Math.random() * 100}%`,
    left: `${Math.random() * 100}%`,
    size: `${Math.random() * 3}px`,
    duration: `${Math.random() * 3 + 2}s`
  }));

  return (
    <div className="stars">
      {stars.map((star) => (
        <div
          key={star.id}
          className="star"
          style={{
            top: star.top,
            left: star.left,
            width: star.size,
            height: star.size,
            animationDuration: star.duration
          }}
        />
      ))}
    </div>
  );
};

export default function AgentDashboard() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);

  // Função para buscar dados do banco (rápido, sem custo de IA)
  const fetchData = async () => {
    const res = await fetch('https://headoffice.onrender.com/api/dashboard-data');
    const json = await res.json();
    setData(json);
  };

  // Função para forçar atualização da IA (Custo de Tokens)
  const handleSync = async () => {
    setLoading(true);
    await fetch('https://headoffice.onrender.com/api/sync-agent', { method: 'POST' });
    await fetchData();
    setLoading(false);
  };

  useEffect(() => {
    fetchData();
  }, []);

  return (
    <div className="min-h-screen text-white font-sans p-8 relative">
      <CosmicBackground />
      
      <header className="flex justify-between items-center mb-12">
        <div className="flex items-center gap-2">
          <Sparkles className="text-purple-400" />
          <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-purple-400 to-pink-600">
            HeadOffice.ai Agent Dashboard
          </h1>
        </div>
        <button
          onClick={handleSync}
          disabled={loading}
          className="glass-panel px-4 py-2 rounded-lg flex items-center gap-2 hover:bg-white/10 transition-all disabled:opacity-50"
        >
          <RefreshCw className={loading ? "animate-spin" : ""} size={18} />
          {loading ? "Processando Docs..." : "Sincronizar IA"}
        </button>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {data.map((item) => (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            key={item.id}
            className="glass-panel rounded-xl p-6 flex flex-col gap-4"
          >
            <div className="flex items-center gap-2 text-blue-300 mb-2 border-b border-white/10 pb-2">
              <FileText size={20} />
              <span className="text-sm truncate w-full" title={item.doc_link}>
                Documento ID: {item.id}
              </span>
            </div>

            <section>
              <h3 className="text-lg font-semibold text-purple-300 mb-1">Resumo da Sessão</h3>
              <p className="text-gray-300 text-sm leading-relaxed">{item.resumo_sessao}</p>
            </section>

            <section className="bg-white/5 rounded-lg p-3">
              <h3 className="text-sm font-semibold text-yellow-300 mb-1 flex items-center gap-2">
                <AlertCircle size={14} /> Pontos de Discussão
              </h3>
              <p className="text-xs text-gray-400">{item.pontos_discussao}</p>
            </section>

            <div className="grid grid-cols-2 gap-2 mt-auto">
              <div className="glass-panel bg-red-500/10 p-3 rounded-lg">
                <h4 className="text-xs font-bold text-red-300 mb-2">Cliente</h4>
                <ul className="text-xs text-gray-400 list-disc pl-3 space-y-1">
                   {/* Assumindo que o texto vem separado por quebras de linha */}
                   {item.tarefas_cliente?.split('\n').map((t, i) => <li key={i}>{t}</li>)}
                </ul>
              </div>
              <div className="glass-panel bg-green-500/10 p-3 rounded-lg">
                <h4 className="text-xs font-bold text-green-300 mb-2">HeadOffice</h4>
                <ul className="text-xs text-gray-400 list-disc pl-3 space-y-1">
                   {item.tarefas_headoffice?.split('\n').map((t, i) => <li key={i}>{t}</li>)}
                </ul>
              </div>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}