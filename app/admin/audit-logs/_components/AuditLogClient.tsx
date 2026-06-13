'use client';

import { useState } from 'react';

interface Actor {
  first_name: string;
  last_name: string;
  email: string;
}

interface AuditLog {
  id: string;
  event_type: string;
  user_id: string | null;
  actor_id: string | null;
  actor_role: string | null;
  description: string;
  metadata: any;
  previous_state: any;
  new_state: any;
  ip_address: string | null;
  user_agent: string | null;
  timestamp: string;
  actor?: Actor | null;
  user?: Actor | null;
}

interface AuditLogClientProps {
  initialLogs: AuditLog[];
}

export function AuditLogClient({ initialLogs }: AuditLogClientProps) {
  const [logs] = useState(initialLogs);
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState('');

  const filterCategories = [
    { id: 'all', label: 'All Events' },
    { id: 'investments', label: 'Token Purchases' },
    { id: 'project_update', label: 'Project Updates' },
    { id: 'payouts', label: 'Payouts & Distributions' },
    { id: 'secondary_market', label: 'Secondary Market' },
    { id: 'compliance', label: 'KYC & Compliance' },
    { id: 'security', label: 'Security & Auth' },
  ];

  const filteredLogs = logs.filter(log => {
    // Smart Categorization Logic
    let matchesCategory = true;
    if (filterCategory === 'investments') {
      matchesCategory = log.event_type.includes('investment') || log.description.toLowerCase().includes('token');
    } else if (filterCategory === 'project_update') {
      matchesCategory = 
        log.event_type === 'project_created' || 
        log.metadata?.action === 'create_project' || 
        log.metadata?.action === 'update_project' ||
        log.description.toLowerCase().includes('project') ||
        log.description.toLowerCase().includes('paused') ||
        log.description.toLowerCase().includes('resumed');
    } else if (filterCategory === 'payouts') {
      matchesCategory = log.event_type.includes('payout') || log.description.toLowerCase().includes('epoch');
    } else if (filterCategory === 'secondary_market') {
      matchesCategory = log.event_type.includes('secondary_');
    } else if (filterCategory === 'compliance') {
      matchesCategory = log.event_type.includes('kyc') || log.event_type.includes('eligibility');
    } else if (filterCategory === 'security') {
      matchesCategory = log.event_type.includes('account') || log.event_type.includes('wallet');
    } else if (filterCategory !== 'all') {
      matchesCategory = log.event_type === filterCategory;
    }

    const actorName = log.actor ? `${log.actor.first_name} ${log.actor.last_name}` : '';
    const matchesSearch = 
      log.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
      log.id.includes(searchTerm) ||
      actorName.toLowerCase().includes(searchTerm.toLowerCase());
    
    return matchesCategory && matchesSearch;
  });

  const getEventBadgeColor = (type: string) => {
    if (type.includes('approved')) return 'bg-green-500/20 text-green-400 border-green-500/30';
    if (type.includes('rejected') || type.includes('suspended')) return 'bg-red-500/20 text-red-400 border-red-500/30';
    if (type.includes('secondary_')) return 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30';
    if (type.includes('investment') || type.includes('wallet')) return 'bg-blue-500/20 text-blue-400 border-blue-500/30';
    if (type.includes('admin') || type.includes('project')) return 'bg-purple-500/20 text-purple-400 border-purple-500/30';
    if (type.includes('payout')) return 'bg-gold/20 text-gold border-gold/30';
    return 'bg-gray-500/20 text-gray-400 border-gray-500/30';
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString(undefined, { 
      month: 'short', 
      day: 'numeric', 
      hour: '2-digit', 
      minute: '2-digit' 
    });
  };

  const getDiff = (prev: any, next: any) => {
    if (!prev || !next) return null;
    const diffs: { field: string; prev: any; next: any }[] = [];
    
    // Fields to ignore in diff
    const ignore = ['updated_at', 'created_at', 'blockchain_signature'];
    
    const allKeys = Array.from(new Set([...Object.keys(prev), ...Object.keys(next)]));
    
    for (const key of allKeys) {
      if (ignore.includes(key)) continue;
      
      const pVal = prev[key];
      const nVal = next[key];
      
      if (JSON.stringify(pVal) !== JSON.stringify(nVal)) {
        diffs.push({ field: key, prev: pVal, next: nVal });
      }
    }
    
    return diffs;
  };

  return (
    <div className="grid lg:grid-cols-3 gap-8">
      {/* Table Section */}
      <div className="lg:col-span-2 space-y-6">
        {/* Controls */}
        <div className="flex flex-col md:flex-row gap-4">
          <div className="flex-1 relative">
            <input
              type="text"
              placeholder="Search by description, actor, or log ID..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-navy-dark/50 border border-gold/20 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-gold/50 placeholder:text-gray-600"
            />
          </div>
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className="bg-navy-dark/50 border border-gold/20 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-gold/50 cursor-pointer"
          >
            {filterCategories.map(cat => (
              <option key={cat.id} value={cat.id}>{cat.label}</option>
            ))}
          </select>

          <button
            onClick={async () => {
              if (confirm('Sync all missing on-chain investments into the audit log? This may take a moment.')) {
                try {
                  const res = await fetch('/api/admin/audit-logs/sync-onchain', { method: 'POST' });
                  const data = await res.json();
                  if (data.success) {
                    alert(`Sync successful! Added ${data.newLogs} new logs. Please refresh the page.`);
                    window.location.reload();
                  } else {
                    alert('Sync failed: ' + data.error);
                  }
                } catch (err) {
                  alert('Sync failed. See console for details.');
                }
              }
            }}
            className="flex items-center gap-2 bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 border border-blue-500/30 px-4 py-2 rounded-xl transition-all font-bold text-xs"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Sync On-Chain
          </button>
        </div>

        {/* Table */}
        <div className="glass rounded-2xl border border-gold/10 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gold/5 text-gold text-xs font-bold uppercase tracking-widest border-b border-gold/10">
                  <th className="px-6 py-4">Event</th>
                  <th className="px-6 py-4">Description</th>
                  <th className="px-6 py-4">Actor</th>
                  <th className="px-6 py-4">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gold/5">
                {filteredLogs.map((log) => (
                  <tr 
                    key={log.id} 
                    onClick={() => setSelectedLog(log)}
                    className={`hover:bg-gold/5 cursor-pointer transition-colors ${selectedLog?.id === log.id ? 'bg-gold/10' : ''}`}
                  >
                    <td className="px-6 py-4">
                      <span className={`px-2 py-1 rounded-md text-[10px] font-bold border ${getEventBadgeColor(log.event_type)} uppercase`}>
                        {log.event_type.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <p className="text-sm text-white font-medium line-clamp-1">{log.description}</p>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-xs">
                        <p className="text-gray-300">
                          {log.actor ? `${log.actor.first_name} ${log.actor.last_name}` : (log.actor_role || 'System')}
                        </p>
                        <p className="text-gray-500 font-mono text-[9px]">{log.actor?.email || log.actor_id?.slice(0, 8) || 'automated'}</p>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <p className="text-xs text-gray-400">
                        {formatDate(log.timestamp)}
                      </p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filteredLogs.length === 0 && (
            <div className="p-12 text-center text-gray-500">
              No audit logs found matching your criteria.
            </div>
          )}
        </div>
      </div>

      {/* Detail Sidebar */}
      <div className="lg:col-span-1">
        <div className="glass rounded-2xl border border-gold/10 p-6 sticky top-24 max-h-[85vh] overflow-y-auto">
          <h3 className="text-xl font-bold text-white mb-6 flex items-center gap-2">
            <svg className="w-5 h-5 text-gold" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Log Details
          </h3>

          {selectedLog ? (
            <div className="space-y-6 animate-fade-in">
              {/* Blockchain Link */}
              {(selectedLog.metadata?.txHash || selectedLog.metadata?.blockchainSignature || selectedLog.new_state?.blockchain_signature) && (
                <a 
                  href={`https://solscan.io/tx/${selectedLog.metadata?.txHash || selectedLog.metadata?.blockchainSignature || selectedLog.new_state?.blockchain_signature}?cluster=devnet`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-between p-3 bg-blue-500/10 border border-blue-500/30 rounded-xl group hover:bg-blue-500/20 transition-all"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-xl">🔗</span>
                    <div>
                      <p className="text-[10px] text-blue-400 font-bold uppercase tracking-widest">On-Chain Transaction</p>
                      <p className="text-[11px] text-blue-200 font-mono truncate w-40">
                        {selectedLog.metadata?.txHash || selectedLog.metadata?.blockchainSignature || selectedLog.new_state?.blockchain_signature}
                      </p>
                    </div>
                  </div>
                  <span className="text-blue-400 group-hover:translate-x-1 transition-transform">→</span>
                </a>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] text-gray-500 uppercase tracking-widest font-bold">Event Type</label>
                  <p className="text-gold font-bold">{selectedLog.event_type}</p>
                </div>
                <div>
                  <label className="text-[10px] text-gray-500 uppercase tracking-widest font-bold">Actor</label>
                  <p className="text-white text-xs">{selectedLog.actor ? `${selectedLog.actor.first_name} ${selectedLog.actor.last_name}` : 'System'}</p>
                </div>
              </div>

              <div>
                <label className="text-[10px] text-gray-500 uppercase tracking-widest font-bold">Summary</label>
                <p className="text-gray-200 text-sm leading-relaxed font-medium">{selectedLog.description}</p>
              </div>

              {/* Enhanced Diff View */}
              {selectedLog.previous_state && selectedLog.new_state && (
                <div className="space-y-3">
                  <label className="text-[10px] text-gray-500 uppercase tracking-widest font-bold">Detailed Changes</label>
                  <div className="space-y-2">
                    {getDiff(selectedLog.previous_state, selectedLog.new_state)?.map(change => (
                      <div key={change.field} className="bg-white/5 rounded-lg p-3 border border-white/10 text-[11px]">
                        <p className="text-gold font-bold uppercase text-[9px] mb-2">{change.field.replace(/_/g, ' ')}</p>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 line-through text-red-400/70 truncate">{String(change.prev)}</div>
                          <span className="text-gray-600">→</span>
                          <div className="flex-1 text-green-400 font-bold truncate">{String(change.next)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-4">
                <label className="text-[10px] text-gray-500 uppercase tracking-widest font-bold">Raw Metadata</label>
                <div className="bg-navy-dark/50 rounded-xl p-4 border border-gold/5 overflow-x-auto">
                  <pre className="text-[10px] text-blue-300 font-mono">
                    {JSON.stringify(selectedLog.metadata, null, 2)}
                  </pre>
                </div>
              </div>

              <div className="pt-6 border-t border-gold/10">
                <div className="flex flex-col gap-2 text-[9px] text-gray-500 font-mono">
                  <p>Log ID: {selectedLog.id}</p>
                  <p>IP: {selectedLog.ip_address || 'Unknown'}</p>
                  <p className="truncate opacity-50">UA: {selectedLog.user_agent}</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center py-20">
              <div className="w-12 h-12 bg-gold/5 rounded-full flex items-center justify-center mx-auto mb-4 border border-gold/10">
                <svg className="w-6 h-6 text-gold/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" />
                </svg>
              </div>
              <p className="text-gray-500 text-sm">Select a log entry to view detailed audit data</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
