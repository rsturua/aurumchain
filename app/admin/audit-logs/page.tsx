/**
 * Page: Admin Audit Logs
 * View immutable record of system activity
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { redirect } from 'next/navigation';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { AdminService } from '@/lib/domains/admin/service';
import { AuditLogClient } from './_components/AuditLogClient';
import { ChainHealthStats } from './_components/ChainHealthStats';

export default async function AdminAuditLogsPage() {
  const supabase = await createClient();
  const adminSupabase = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  // Check if user is an admin
  const isAdmin = await AdminService.isAdmin(user.id);

  if (!isAdmin) {
    redirect('/dashboard');
  }

  // Fetch audit logs (manual join for stability)
  const { data: rawLogs, error: fetchError } = await adminSupabase
    .from('audit_logs')
    .select('*')
    .order('timestamp', { ascending: false })
    .limit(200);

  // Fetch secondary listings and trades
  const { data: rawListings } = await adminSupabase
    .from('secondary_listings')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);

  const { data: rawTrades } = await adminSupabase
    .from('secondary_trades')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);

  let logs = rawLogs || [];
  
  if (rawListings) {
    logs = [
      ...logs,
      ...rawListings.map((l: any) => ({
        id: l.id,
        event_type: 'secondary_listing_created',
        user_id: l.investor_id,
        actor_id: l.investor_id,
        actor_role: 'Investor',
        description: `Listed ${l.token_amount} tokens at $${l.token_listing_price} each for project ${l.project_id}. Status: ${l.status}`,
        metadata: {
          project_id: l.project_id,
          token_amount: l.token_amount,
          token_listing_price: l.token_listing_price,
          status: l.status,
          blockchainSignature: l.creation_tx
        },
        previous_state: null,
        new_state: l,
        ip_address: null,
        user_agent: null,
        timestamp: l.created_at
      }))
    ];
  }

  if (rawTrades) {
    logs = [
      ...logs,
      ...rawTrades.map((t: any) => ({
        id: t.id,
        event_type: 'secondary_trade_executed',
        user_id: t.buyer_id,
        actor_id: t.buyer_id,
        actor_role: 'Investor',
        description: `Purchased ${t.tokens_purchased} tokens at $${t.price_per_token} each on secondary market.`,
        metadata: {
          project_id: t.project_id,
          tokens_purchased: t.tokens_purchased,
          price_per_token: t.price_per_token,
          total_cost: t.total_cost,
          listing_id: t.listing_id,
          blockchainSignature: t.tx_hash
        },
        previous_state: null,
        new_state: t,
        ip_address: null,
        user_agent: null,
        timestamp: t.created_at
      }))
    ];
  }
  
  // Sort combined logs
  logs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  let error = fetchError;

  if (!error && logs.length > 0) {
    try {
      // Collect unique IDs
      const actorIds = [...new Set(logs.map(l => l.actor_id).filter(Boolean))];
      const userIds = [...new Set(logs.map(l => l.user_id).filter(Boolean))];
      const allProfileIds = [...new Set([...actorIds, ...userIds])];

      if (allProfileIds.length > 0) {
        const { data: profiles } = await adminSupabase
          .from('profiles')
          .select('id, first_name, last_name, email')
          .in('id', allProfileIds);

        const profileMap = new Map(profiles?.map(p => [p.id, p]) || []);

        logs = logs.map(l => ({
          ...l,
          actor: l.actor_id ? profileMap.get(l.actor_id) : null,
          user: l.user_id ? profileMap.get(l.user_id) : null
        })) as any;
      }
    } catch (err) {
      console.warn('[AdminAuditLogs] Profile hydration failed:', err);
    }
  }

  if (error) {
    console.error('[AdminAuditLogs] FETCH ERROR:', error.message);
  } else {
    console.log('[AdminAuditLogs] Successfully fetched logs:', logs?.length || 0);
  }

  return (
    <div className="min-h-screen bg-navy pt-24 px-6 pb-20">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-12">
          <div>
            <a href="/admin" className="text-gold hover:text-gold-light mb-4 inline-block transition-colors">
              ← Back to Admin Dashboard
            </a>
            <h1 className="text-5xl font-black gradient-text mb-2 tracking-tight">Audit Logs</h1>
            <p className="text-gray-400 text-lg">Immutable record of platform activity and security events</p>
          </div>

          <div className="flex gap-4">
            <a 
              href="/admin/reconciliation" 
              className="px-6 py-3 bg-gold text-navy font-black uppercase tracking-widest text-xs rounded-xl hover:bg-white transition-all shadow-glow-gold flex items-center gap-2"
            >
              <span>🔍</span> Run Reconciliation
            </a>
          </div>
        </div>

        {/* Blockchain Health Section (Newly Added) */}
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-4">
             <div className="w-1.5 h-1.5 rounded-full bg-gold animate-pulse"></div>
             <h2 className="text-[10px] font-black text-gold uppercase tracking-[0.2em]">Chain Health Monitor</h2>
          </div>
          <ChainHealthStats />
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
           <div className="glass p-4 rounded-xl border border-gold/10">
              <p className="text-[10px] text-gray-500 uppercase font-bold mb-1">Total Records</p>
              <p className="text-2xl font-bold text-white">{logs?.length || 0}</p>
           </div>
           <div className="glass p-4 rounded-xl border border-gold/10">
              <p className="text-[10px] text-gray-500 uppercase font-bold mb-1">Critical Events</p>
              <p className="text-2xl font-bold text-red-400">
                {logs?.filter(l => l.event_type.includes('rejected') || l.event_type.includes('suspended')).length || 0}
              </p>
           </div>
           <div className="glass p-4 rounded-xl border border-gold/10">
              <p className="text-[10px] text-gray-500 uppercase font-bold mb-1">Token Purchases</p>
              <p className="text-2xl font-bold text-blue-400">
                {logs?.filter(l => l.event_type.includes('investment')).length || 0}
              </p>
           </div>
           <div className="glass p-4 rounded-xl border border-gold/10">
              <p className="text-[10px] text-gray-500 uppercase font-bold mb-1">Last Activity</p>
              <p className="text-sm font-bold text-gold">
                {logs?.[0] ? new Date(logs[0].timestamp).toLocaleTimeString() : 'N/A'}
              </p>
           </div>
        </div>

        {/* Interactive Log Viewer */}
        <AuditLogClient initialLogs={logs || []} />
      </div>
    </div>
  );
}
