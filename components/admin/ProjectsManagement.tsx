'use client';

import { useState, useEffect, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Database } from '@/lib/types/database.types';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { ProjectRegistryService } from '@/lib/web3/services/projectRegistryService';
import { PublicKey } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { TokenMath } from '@/lib/utils/tokenMath';

import { toChainStatus, toChainAssetType, fromChainStatus } from '@/lib/web3/utils/statusMappings';
type Project = Database['public']['Tables']['projects']['Row'];
type ProjectInsert = Database['public']['Tables']['projects']['Insert'];

export interface EnrichedProject extends Project {
  token_symbol?: string | null;
  metadata_uri?: string | null;
  lockup_end_date?: string | null;
  onChain?: {
    symbol: string;
    uri: string;
    supplyCap: number;
    tokensIssued: number;
    minInvestmentUsdc: number;
    maxInvestmentUsdc: number;
    acceptedStablecoin: string;
    treasuryWallet: string;
    mint: string;
    lockupEndTs: number;
    subscriptionStart: number;
    subscriptionEnd: number;
    createdAt: number;
    distributionCadence: number;
    distributionMode: number; // New Field
    tokenPriceUsdc: number;   // New Field
    isActive: boolean;
    status: any;
    isPaused: boolean;
    mintAuthorityRevoked: boolean;
    creator: string;
    assetType: string;
    roundLimitTokens: number;
    currentRoundIssued: number;
  } | null;
}

interface ProjectsManagementProps {
  initialProjects: EnrichedProject[];
  userId: string;
}

export default function ProjectsManagement({ initialProjects, userId }: ProjectsManagementProps) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const formRef = useRef<HTMLDivElement>(null);
  const [projects, setProjects] = useState<EnrichedProject[]>(initialProjects);
  const [showForm, setShowForm] = useState(false);
  const [editingProject, setEditingProject] = useState<EnrichedProject | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusChanging, setStatusChanging] = useState<string | null>(null); // tracks which project is being updated

  // Form state
  const [formData, setFormData] = useState<Partial<ProjectInsert> & {
    token_symbol?: string;
    metadata_uri?: string;
    accepted_stablecoin?: string;
    treasury_wallet?: string;
    lockup_end_date?: string;
    distribution_cadence?: number;
    token_decimals?: number;
    distribution_mode?: number;  // New Field
  }>({
    name: '',
    slug: '',
    description: '',
    location: '',
    country: '',
    funding_goal: 0,
    current_funding: 0,
    min_investment: 1000,
    token_price: 1,
    total_tokens: 0,
    available_tokens: 0,
    expected_return_percentage: 0,
    project_duration_months: 12,
    status: 'draft',
    images: [],
    documents: [],
    token_symbol: '',
    metadata_uri: '',
    accepted_stablecoin: process.env.NEXT_PUBLIC_USDC_MINT || 'AJujcxZiQ1jUvSixiFLQNWFCpUtMuVsbyPCQ8ByU3jvf',
    treasury_wallet: process.env.NEXT_PUBLIC_ADMIN_WALLET || '',
    lockup_end_date: '',
    distribution_cadence: 0,
    token_decimals: 9,
    asset_type: 'real_estate',
    distribution_mode: 0, // Default: Parallel
    round_limit_tokens: 0,
  });

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    const { name, value } = e.target;

    setFormData((prev) => {
      const updated = {
        ...prev,
        [name]:
          name === 'funding_goal' ||
          name === 'current_funding' ||
          name === 'min_investment' ||
          name === 'token_price' ||
          name === 'total_tokens' ||
          name === 'available_tokens' ||
          name === 'expected_return_percentage' ||
          name === 'project_duration_months' ||
          name === 'distribution_cadence' ||
          name === 'distribution_mode' ||
          name === 'token_decimals' ||
          name === 'round_limit_tokens'
            ? parseFloat(value) || 0
            : value,
      };

      // Auto-calculate tokens if Goal or Price changes (ONLY for new projects)
      if (!editingProject && (name === 'funding_goal' || name === 'token_price')) {
        const goal = name === 'funding_goal' ? parseFloat(value) || 0 : prev.funding_goal || 0;
        const price = name === 'token_price' ? parseFloat(value) || 0 : prev.token_price || 0;

        if (price > 0) {
          const totalTokens = Math.floor(goal / price);
          updated.total_tokens = totalTokens;
          updated.round_limit_tokens = totalTokens; // Keep round limit in sync with goal
          
          if (prev.available_tokens === prev.total_tokens || prev.total_tokens === 0) {
            updated.available_tokens = totalTokens;
          }
        }
      }

      // Force Round Limit = Total Tokens for Real Estate
      if (updated.asset_type === 'real_estate' || !updated.asset_type) {
        updated.round_limit_tokens = updated.total_tokens;
      }

      return updated;
    });

    // Auto-generate slug from name
    if (name === 'name') {
      const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      setFormData((prev) => ({ ...prev, slug }));
    }
  };

  const handleImageUrlsChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const urls = e.target.value.split('\n').filter(url => url.trim());
    setFormData((prev) => ({ ...prev, images: urls }));
  };

  const handleDocumentUrlsChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const urls = e.target.value.split('\n').filter(url => url.trim());
    setFormData((prev) => ({ ...prev, documents: urls }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return; // Prevent double-clicks causing concurrent Phantom popups
    setLoading(true);
    setError(null);
    
    // Note: Lock-up validation is handled on-chain

    try {
      if (!wallet.connected) {
        throw new Error("Admin wallet is not connected. Please connect your Phantom wallet to sign the transaction.");
      }

      // Step 1: Blockchain — create NEW project on-chain, or UPDATE params for existing chain-linked project
      const service = new ProjectRegistryService(connection, wallet);
      let submissionData = { ...formData }; // Use local copy to avoid state mutation race conditions

      if (!editingProject) {
        // ── CREATE ──
        submissionData.status = 'draft'; 
        try {
          const chainResult = await service.createProjectWithMint({
            name: submissionData.name || 'Unnamed Project',
            symbol: submissionData.token_symbol || 'TKN',
            uri: submissionData.metadata_uri || 'https://metadata.placeholder',
            supplyCap: submissionData.total_tokens || 1000000,
            minInvestmentUsdc: submissionData.min_investment || 100,
            maxInvestmentUsdc: submissionData.funding_goal || 1_000_000,
            acceptedStablecoin: new PublicKey(submissionData.accepted_stablecoin || process.env.NEXT_PUBLIC_USDC_MINT || 'AJujcxZiQ1jUvSixiFLQNWFCpUtMuVsbyPCQ8ByU3jvf'),
            treasuryWallet: new PublicKey(submissionData.treasury_wallet || wallet.publicKey!.toBase58()),
            lockupEndTs: Math.floor(new Date(submissionData.lockup_end_date || Date.now()).getTime() / 1000),
            subscriptionStart: Math.floor(new Date(submissionData.start_date || Date.now()).getTime() / 1000),
            subscriptionEnd: Math.floor(new Date(submissionData.expected_completion_date || Date.now() + 86400000).getTime() / 1000),
            distributionCadence: submissionData.distribution_cadence || 0,
            durationMonths: submissionData.project_duration_months || 0,
            tokenDecimals: submissionData.token_decimals || 9,
            tokenPriceUsdc: submissionData.token_price || 1,
            distributionMode: submissionData.distribution_mode || 0,
            assetType: toChainAssetType(submissionData.asset_type || 'real_estate'),
            roundLimitTokens: submissionData.round_limit_tokens || submissionData.total_tokens || 0,
          });
          
          submissionData.blockchain_signature = chainResult.signature;
          (submissionData as any).blockchain_project_id = chainResult.projectId;
          (submissionData as any).mint_address = chainResult.mintAddress;
        } catch (chainErr: any) {
          throw new Error('Blockchain Transaction Failed: ' + chainErr.message);
        }
      } else if (editingProject.blockchain_project_id !== null && editingProject.blockchain_project_id !== undefined) {
        // ── UPDATE on-chain params ──
        try {
          const chainUpdateParams: any = {
            minInvestmentUsdc: (formData.min_investment !== undefined && formData.min_investment !== null)
              ? new BN(Math.round((formData.min_investment || 0) * 1_000_000))
              : null,
            maxInvestmentUsdc: (formData.funding_goal !== undefined && formData.funding_goal !== null)
              ? new BN(Math.round((formData.funding_goal || 0) * 1_000_000))
              : null,
            subscriptionStart: (formData.start_date)
              ? new BN(Math.floor(new Date(formData.start_date).getTime() / 1000))
              : null,
            subscriptionEnd: (formData.expected_completion_date)
              ? new BN(Math.floor(new Date(formData.expected_completion_date).getTime() / 1000))
              : null,
            distributionCadence: (formData.distribution_cadence !== undefined && formData.distribution_cadence !== null)
              ? formData.distribution_cadence
              : null,
            durationMonths: (formData.project_duration_months !== undefined && formData.project_duration_months !== null)
              ? formData.project_duration_months
              : null,
            lockupEndTs: (formData.lockup_end_date)
              ? new BN(Math.floor(new Date(formData.lockup_end_date).getTime() / 1000))
              : null,
            roundLimitTokens: (formData.round_limit_tokens !== undefined && formData.round_limit_tokens !== null)
              ? new BN(formData.round_limit_tokens).mul(new BN(10).pow(new BN(formData.token_decimals || 9)))
              : null,
            assetType: formData.asset_type ? toChainAssetType(formData.asset_type) : null,
            name: formData.name || null,
            symbol: formData.token_symbol || null,
            uri: formData.metadata_uri || null,
            tokenPriceUsdc: (formData.token_price !== undefined) ? new BN(Math.round(formData.token_price * 1_000_000)) : null,
            distributionMode: (formData.distribution_mode !== undefined) ? formData.distribution_mode : null,
          };

          if (Object.keys(chainUpdateParams).some(k => chainUpdateParams[k] !== null)) {
            await service.updateProject(editingProject.blockchain_project_id, chainUpdateParams);
          }
        } catch (chainErr: any) {
          if (chainErr.message?.includes('102') || chainErr.message?.includes('0x66')) {
            throw new Error('On-Chain Update Failed: This project is in a "LEGACY" format and cannot be updated on the blockchain. Any projects created AFTER this update will be fully editable.');
          }
          throw new Error('On-Chain Update Failed: ' + chainErr.message);
        }
      }

      // Step 2: Save metadata to Supabase
      const url = editingProject
        ? `/api/admin/projects/${editingProject.id}`
        : '/api/admin/projects';

      const method = editingProject ? 'PUT' : 'POST';

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submissionData),
      });

      if (!response.ok) {
        const data = await response.json();
        const msg = data.error || 'Failed to save project to off-chain DB';
        
        if (!editingProject) {
           setError(`BLOCKCHAIN SUCCESS (ID: ${submissionData.blockchain_project_id}), but Database failed. IMPORTANT: Please REFRESH the page and use the "Sync" button to link this project manually. Error: ${msg}`);
        } else {
           throw new Error(msg);
        }
        return;
      }

      const savedProject = await response.json();

      if (editingProject) {
        setProjects(projects.map(p => p.id === savedProject.id ? savedProject : p));
      } else {
        setProjects([savedProject, ...projects]);
      }

      resetForm();
      setShowForm(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Realtime subscription: keep admin list in sync with Supabase changes ──
  useEffect(() => {
    const supabase = createClient();
    const service = new ProjectRegistryService(connection, wallet);

    const enrichAndSync = async (payload: any) => {
      const dbProject = payload.new as any;
      let enriched = { ...dbProject, onChain: null };

      // Proactively fetch enriched data from API
      if (dbProject.id) {
        try {
          const res = await fetch(`/api/admin/projects/${dbProject.id}`);
          if (res.ok) {
             const enrichedData = await res.json();
             setProjects(prev => prev.map(p => p.id === dbProject.id ? enrichedData : p));
          }
        } catch (e) {
          console.warn('[RealtimeSync] Enrichment failed:', e);
        }
      }

      setProjects((prev) => {
        if (payload.eventType === 'INSERT') {
          return [enriched, ...prev];
        } else {
          return prev.map((p) => (p.id === enriched.id ? enriched : p));
        }
      });
    };

    const channel = supabase
      .channel('admin-projects-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'projects' },
        (payload) => { enrichAndSync(payload); }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'projects' },
        (payload) => { enrichAndSync(payload); }
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'projects' },
        (payload) => {
          setProjects((prev) => prev.filter((p) => p.id !== (payload.old as any).id));
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [connection, wallet]);

  const refreshProject = async (projectId: string, blockchainId: number) => {
    try {
      const resp = await fetch(`/api/admin/projects/${projectId}`);
      if (!resp.ok) return;
      const enriched = await resp.json();
      
      setProjects(prev => prev.map(p => p.id === projectId ? enriched : p));
    } catch (e) {
      console.warn('[RefreshProject] Error:', e);
    }
  };

  const handleEdit = (project: EnrichedProject) => {
    setEditingProject(project);
    setFormData({
      name: project.name,
      slug: project.slug,
      description: project.description,
      location: project.location,
      country: project.country,
      funding_goal: project.funding_goal ?? 0,
      current_funding: project.current_funding ?? 0,
      min_investment: project.min_investment ?? 0,
      token_price: project.onChain?.tokenPriceUsdc ?? project.token_price ?? 1,
      total_tokens: project.onChain?.supplyCap ?? project.total_tokens ?? 0,
      available_tokens: project.onChain ? (project.onChain.supplyCap - project.onChain.tokensIssued) : (project.available_tokens ?? 0),
      expected_return_percentage: project.expected_return_percentage ?? 0,
      project_duration_months: project.project_duration_months ?? 12,
      status: project.status,
      images: project.images,
      documents: project.documents,
      video_url: project.video_url,
      latitude: project.latitude ?? 0,
      longitude: project.longitude ?? 0,
      start_date: project.start_date ? new Date(project.start_date).toLocaleString('sv').slice(0, 16).replace(' ', 'T') : '',
      expected_completion_date: project.expected_completion_date ? new Date(project.expected_completion_date).toLocaleString('sv').slice(0, 16).replace(' ', 'T') : '',
      token_symbol: project.onChain?.symbol || project.token_symbol || '',
      metadata_uri: project.onChain?.uri || project.metadata_uri || '',
      token_decimals: project.token_decimals || (project.onChain as any)?.decimals || 9,
      accepted_stablecoin: project.accepted_stablecoin || process.env.NEXT_PUBLIC_USDC_MINT || '',
      treasury_wallet: project.treasury_wallet || process.env.NEXT_PUBLIC_ADMIN_WALLET || '',
      lockup_end_date: project.onChain?.lockupEndTs 
        ? new Date(project.onChain.lockupEndTs * 1000).toLocaleString('sv').slice(0, 16).replace(' ', 'T')
        : project.lockup_end_date ? new Date(project.lockup_end_date).toLocaleString('sv').slice(0, 16).replace(' ', 'T') : '',
      distribution_cadence: project.distribution_cadence || 0,
      distribution_mode: (project.onChain as any)?.distributionMode ?? project.distribution_mode ?? 0,
      asset_type: project.asset_type || 'real_estate',
      round_limit_tokens: (project.onChain as any)?.roundLimitTokens ?? project.round_limit_tokens ?? 0,
    });
    setShowForm(true);
    setTimeout(() => {
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  };

  const handleDelete = async (projectId: string) => {
    if (!confirm('Are you sure you want to delete this project? This action cannot be undone.')) {
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`/api/admin/projects/${projectId}`, {
        method: 'DELETE',
      });

      if (!response.ok && response.status !== 404) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to delete project');
      }

      // If success OR already deleted (404), remove from local state
      setProjects(projects.filter(p => p.id !== projectId));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setFormData({
      name: '',
      slug: '',
      description: '',
      location: '',
      country: '',
      funding_goal: 0,
      current_funding: 0,
      min_investment: 1000,
      token_price: 1,
      total_tokens: 0,
      available_tokens: 0,
      expected_return_percentage: 0,
      project_duration_months: 12,
      status: 'draft',
      images: [],
      documents: [],
      token_symbol: '',
      metadata_uri: '',
      accepted_stablecoin: process.env.NEXT_PUBLIC_USDC_MINT || 'AJujcxZiQ1jUvSixiFLQNWFCpUtMuVsbyPCQ8ByU3jvf',
      treasury_wallet: process.env.NEXT_PUBLIC_ADMIN_WALLET || '',
      lockup_end_date: '',
      distribution_cadence: 0,
      distribution_mode: 0,
      token_decimals: 9,
      asset_type: 'real_estate',
      round_limit_tokens: 0,
    });
    setEditingProject(null);
    setError(null);
  };

  // ── Unified status change (Syncs DB and Blockchain) ──────────────────────
  const handleUpdatePhase = async (project: EnrichedProject, newStatus: Project['status']) => {
    if (project.blockchain_project_id === null || project.blockchain_project_id === undefined) {
       // If not on chain yet (Draft), just update Supabase
       await handleStatusChangeOnly(project.id, newStatus);
       return;
    }

    if (!wallet.connected) { setError('Connect your Phantom wallet to update on-chain status.'); return; }
    
    // Guard: Prevent moving back to Draft if already on-chain
    if (newStatus === 'draft') {
      setError('Cannot move an on-chain project back to Draft status. Projects must move forward in their lifecycle.');
      return;
    }

    setStatusChanging(project.id);
    try {
      const service = new ProjectRegistryService(connection, wallet);
      const chainStatus = toChainStatus(newStatus);
      
      // Perform on-chain update
      const signature = await service.updateProjectStatus(
        project.blockchain_project_id,
        chainStatus,
        project.is_paused || false
      );

      console.log(`[PhaseUpdate] TX: ${signature}`);

      // Sync Supabase
      const response = await fetch(`/api/admin/projects/${project.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });

      if (!response.ok) throw new Error("On-chain success, but DB sync failed.");

      setProjects((prev) =>
        prev.map((p) => (p.id === project.id ? { ...p, status: newStatus } : p))
      );
      alert(`Phase updated to ${newStatus.toUpperCase()}`);
    } catch (err: any) {
      if (err.message?.includes('3003') || err.message?.includes('AccountNotInitialized')) {
        setError('On-Chain Update Failed: This project is in a "LEGACY" format and cannot be updated on the blockchain. Any projects created AFTER this update will be fully editable.');
      } else if (err.message?.includes('6012')) {
        setError('INVALID_TRANSITION: This project is in a terminal state (Completed/Canceled) and cannot be modified further on-chain.');
      } else {
        setError(err.message);
      }
    } finally {
      setStatusChanging(null);
    }
  };

  const handleSyncFromChain = async (project: EnrichedProject) => {
    if (project.blockchain_project_id === null || project.blockchain_project_id === undefined) return;
    
    setStatusChanging(project.id);
    try {
      const service = new ProjectRegistryService(connection, wallet);
      const freshChainData = await service.fetchProject(project.blockchain_project_id);
      
      if (!freshChainData) throw new Error("Could not find project on-chain to sync.");
      
      const chainStatusStr = fromChainStatus(freshChainData.status);
      const decimals = project.token_decimals || freshChainData.tokenDecimals || 9;
      
      const body = { 
        status: chainStatusStr,
        available_tokens: TokenMath.fromRaw(new BN(freshChainData.supplyCap).sub(new BN(freshChainData.tokensIssued)), decimals),
        current_round_issued: TokenMath.fromRaw(freshChainData.currentRoundIssued, decimals),
        on_chain_id: project.blockchain_project_id,
        blockchain_project_id: project.blockchain_project_id,
        token_decimals: decimals,
        mint_address: freshChainData.mint?.toString(),
        is_paused: freshChainData.isPaused,
        token_price: TokenMath.fromRaw(freshChainData.tokenPriceUsdc, 6),
      };
      
      console.log(`[Sync] Sending FRESH update for project ${project.id}:`, body);

      const response = await fetch(`/api/admin/projects/${project.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) throw new Error("DB sync failed.");

      setProjects((prev) =>
        prev.map((p) => (p.id === project.id ? { ...p, status: chainStatusStr as any } : p))
      );
      alert(`Database successfully synced with Blockchain: ${chainStatusStr.toUpperCase()}`);
    } catch (err: any) {
      setError(`Sync failed: ${err.message}`);
    } finally {
      setStatusChanging(null);
    }
  };

  const handleStatusChangeOnly = async (projectId: string, newStatus: Project['status']) => {
    setStatusChanging(projectId);
    try {
      const response = await fetch(`/api/admin/projects/${projectId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!response.ok) throw new Error('Failed to update status');
      setProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, status: newStatus } : p)));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setStatusChanging(null);
    }
  };

  // ── On-chain boolean toggles (pause/resume/activate) ─────────────────────
  const handleChainAction = async (
    project: EnrichedProject,
    action: 'togglePause' | 'revokeMintAuthority' | 'issueTokens' | 'resetRound'
  ) => {
    if (project.blockchain_project_id === null || project.blockchain_project_id === undefined) {
      setError('This project has no on-chain record.'); return;
    }
    if ((project.onChain as any)?.isLegacy) {
      setError('This project is in a LEGACY format and its on-chain state cannot be modified.');
      return;
    }
    if (!wallet.connected) { setError('Connect your Phantom wallet first.'); return; }
    if (statusChanging) return;
    
    setStatusChanging(project.id);
    try {
      const service = new ProjectRegistryService(connection, wallet);
      
      if (action === 'togglePause') {
        const newIsPaused = !project.is_paused;
        const currentChainStatus = toChainStatus(project.status);
        
        const signature = await service.updateProjectStatus(
          project.blockchain_project_id,
          currentChainStatus,
          newIsPaused
        );
        
        await fetch(`/api/admin/projects/${project.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_paused: newIsPaused }),
        });

        setProjects((prev) => prev.map((p) => (p.id === project.id ? { ...p, is_paused: newIsPaused } : p)));
        console.log(`[PauseToggle] TX: ${signature}`);
      } 
      else if (action === 'revokeMintAuthority') {
        if (!confirm('WARNING: Revoking mint authority is irreversible. PROCEED?')) {
          setStatusChanging(null);
          return;
        }
        const signature = await service.revokeMintAuthority(project.blockchain_project_id);
        await fetch(`/api/admin/projects/${project.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mint_authority_revoked: true, status: 'active' }),
        });
        setProjects((prev) => prev.map((p) => (p.id === project.id ? { ...p, mint_authority_revoked: true, status: 'active' } : p)));
        alert(`Success! TX: ${signature}`);
      }
      else if (action === 'issueTokens') {
        const recipientStr = prompt('Enter the Recipient Wallet Address:');
        if (!recipientStr) { setStatusChanging(null); return; }
        
        let recipientWallet: PublicKey;
        try {
          recipientWallet = new PublicKey(recipientStr);
        } catch (e) {
          alert('Invalid Solana wallet address');
          setStatusChanging(null);
          return;
        }

        const amountStr = prompt('How many tokens do you want to issue? (e.g. 1000)');
        if (!amountStr) { setStatusChanging(null); return; }
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) { alert('Invalid amount'); setStatusChanging(null); return; }
        
        const signature = await service.issueTokens(project.blockchain_project_id, recipientWallet, amount);
        alert(`Tokens issued successfully!\nTX: ${signature}`);
        
        // SYNC SUPABASE: Update available_tokens and current_round_issued after on-chain change
        try {
          const freshChainData = await service.fetchProject(project.blockchain_project_id);
          const decimals = project.token_decimals || 9;
          const divisor = 10 ** decimals;
          
          if (freshChainData) {
            const issuedCount = Number(freshChainData.tokensIssued) / divisor;
            const roundIssued = Number(freshChainData.currentRoundIssued) / divisor;
            const totalCap = Number(freshChainData.supplyCap) / divisor;

            await fetch(`/api/admin/projects/${project.id}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                available_tokens: totalCap - issuedCount,
                current_round_issued: roundIssued
              })
            });
          }
        } catch (syncErr) {
          console.warn('[Sync] Supabase update failed:', syncErr);
        }

        await refreshProject(project.id, project.blockchain_project_id);
      }
      else if (action === 'resetRound') {
        const newLimit = prompt('Optional: Enter new round limit (leave empty to keep current total cap):');
        const limitVal = newLimit ? parseFloat(newLimit) : undefined;
        
        const signature = await service.resetRound(project.blockchain_project_id, limitVal);
        alert(`Round reset successfully!\nTX: ${signature}`);
        
        // SYNC SUPABASE: Update current_round_issued after round reset
        try {
          const freshChainData = await service.fetchProject(project.blockchain_project_id);
          const decimals = project.token_decimals || 9;
          const divisor = 10 ** decimals;
          
          if (freshChainData) {
            const roundIssued = Number(freshChainData.currentRoundIssued) / divisor;
            const roundLimit = Number(freshChainData.roundLimitTokens) / divisor;

            await fetch(`/api/admin/projects/${project.id}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                current_round_issued: roundIssued,
                round_limit_tokens: roundLimit
              })
            });
          }
        } catch (syncErr) {
          console.warn('[Sync] Round reset Supabase update failed:', syncErr);
        }

        await refreshProject(project.id, project.blockchain_project_id);
      }
    } catch (err: any) {
      if (err.message?.includes('3003') || err.message?.includes('AccountNotInitialized')) {
        setError('This action failed because the project is in a LEGACY format and its on-chain state cannot be modified.');
      } else {
        setError(err.message);
      }
    } finally {
      setStatusChanging(null);
    }
  };

  const handleSetMint = async (project: EnrichedProject) => {
    const mintAddress = prompt('Enter the SPL Token Mint Address for this project:');
    if (!mintAddress || (project.blockchain_project_id === null || project.blockchain_project_id === undefined)) return;

    try {
      new PublicKey(mintAddress); // Validate pubkey format
    } catch (e) {
      alert('Invalid Solana address format.');
      return;
    }

    if ((project.onChain as any)?.isLegacy) {
      setError('This project is in a LEGACY format and its on-chain state cannot be modified.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const service = new ProjectRegistryService(connection, wallet);
      const signature = await service.setProjectMint(
        project.blockchain_project_id,
        new PublicKey(mintAddress)
      );

      // Sync with Supabase
      const response = await fetch(`/api/admin/projects/${project.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mint_address: mintAddress }),
      });

      if (!response.ok) throw new Error('On-chain success, but failed to update Supabase.');

      alert(`Success! Project mint set to: ${mintAddress}\nTX: ${signature}`);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      {/* Action Bar */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4 text-gray-300">
          <span><span className="font-medium">{projects.length}</span> projects total</span>
          <span className="flex items-center gap-1.5 text-xs text-green-400 font-medium">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
            </span>
            Live
          </span>
        </div>
        <button
          onClick={() => {
            resetForm();
            const nextShow = !showForm;
            setShowForm(nextShow);
            if (nextShow) {
              setTimeout(() => {
                formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }, 100);
            }
          }}
          className="bg-gradient-to-r from-gold to-gold-light text-navy font-bold py-2 px-6 rounded-lg transition-all duration-300 hover:scale-105"
        >
          {showForm ? 'Cancel' : '+ Add New Project'}
        </button>
      </div>

      {/* Error Message */}
      {error && (
        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-lg">
          <p className="text-red-400">{error}</p>
        </div>
      )}

      {/* Project Form */}
      {showForm && (
        <div ref={formRef} className="mb-8 glass rounded-xl p-6 border border-gold/20">
          <h2 className="text-2xl font-bold text-white mb-6">
            {editingProject ? 'Edit Project' : 'Add New Project'}
          </h2>
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Basic Information */}
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Project Name *
                </label>
                <input
                  type="text"
                  name="name"
                  value={formData.name}
                  onChange={handleInputChange}
                  required
                  className="w-full px-4 py-2 bg-navy/50 border border-gold/20 rounded-lg text-white focus:outline-none focus:border-gold"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Slug (auto-generated)
                </label>
                <input
                  type="text"
                  name="slug"
                  value={formData.slug}
                  onChange={handleInputChange}
                  required
                  className="w-full px-4 py-2 bg-navy/50 border border-gold/20 rounded-lg text-white focus:outline-none focus:border-gold"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Description
              </label>
              <textarea
                name="description"
                value={formData.description || ''}
                onChange={handleInputChange}
                rows={4}
                className="w-full px-4 py-2 bg-navy/50 border border-gold/20 rounded-lg text-white focus:outline-none focus:border-gold"
              />
            </div>

            {/* Location */}
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Location *
                </label>
                <input
                  type="text"
                  name="location"
                  value={formData.location}
                  onChange={handleInputChange}
                  required
                  placeholder="e.g., Ashanti Region"
                  className="w-full px-4 py-2 bg-navy/50 border border-gold/20 rounded-lg text-white focus:outline-none focus:border-gold"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Country *
                </label>
                <input
                  type="text"
                  name="country"
                  value={formData.country}
                  onChange={handleInputChange}
                  required
                  placeholder="e.g., Ghana"
                  className="w-full px-4 py-2 bg-navy/50 border border-gold/20 rounded-lg text-white focus:outline-none focus:border-gold"
                />
              </div>
            </div>

            {/* Financial Details */}
            <div className="grid md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Funding Goal ($) *
                </label>
                <input
                  type="number"
                  name="funding_goal"
                  value={formData.funding_goal}
                  onChange={handleInputChange}
                  required
                  min="0"
                  step="1000"
                  className="w-full px-4 py-2 bg-navy/50 border border-gold/20 rounded-lg text-white focus:outline-none focus:border-gold"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Current Funding ($)
                </label>
                <input
                  type="number"
                  name="current_funding"
                  value={formData.current_funding}
                  onChange={handleInputChange}
                  min="0"
                  step="1000"
                  className="w-full px-4 py-2 bg-navy/50 border border-gold/20 rounded-lg text-white focus:outline-none focus:border-gold"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Min Investment ($) *
                </label>
                <input
                  type="number"
                  name="min_investment"
                  value={formData.min_investment}
                  onChange={handleInputChange}
                  required
                  min="0"
                  step="100"
                  className="w-full px-4 py-2 bg-navy/50 border border-gold/20 rounded-lg text-white focus:outline-none focus:border-gold"
                />
              </div>
            </div>

            {/* Token Details */}
            <div className="grid md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Token Price ($) *
                </label>
                <input
                  type="number"
                  name="token_price"
                  value={formData.token_price}
                  onChange={handleInputChange}
                  required
                  min="0"
                  step="0.01"
                  className="w-full px-4 py-2 bg-navy/50 border border-gold/20 rounded-lg text-white focus:outline-none focus:border-gold"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Total Tokens *
                </label>
                <input
                  type="number"
                  name="total_tokens"
                  value={formData.total_tokens}
                  onChange={handleInputChange}
                  readOnly={editingProject?.blockchain_project_id !== null && editingProject?.blockchain_project_id !== undefined}
                  required
                  min="0"
                  step="1"
                  className={`w-full px-4 py-2 bg-navy/50 border border-gold/20 rounded-lg text-white focus:outline-none focus:border-gold ${
                    (editingProject?.blockchain_project_id !== null && editingProject?.blockchain_project_id !== undefined) ? 'opacity-60 cursor-not-allowed' : ''
                  }`}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Available Tokens *
                </label>
                <input
                  type="number"
                  name="available_tokens"
                  value={formData.available_tokens}
                  onChange={handleInputChange}
                  readOnly={editingProject?.blockchain_project_id !== null && editingProject?.blockchain_project_id !== undefined}
                  required
                  min="0"
                  step="1"
                  className={`w-full px-4 py-2 bg-navy/50 border border-gold/20 rounded-lg text-white focus:outline-none focus:border-gold ${
                    (editingProject?.blockchain_project_id !== null && editingProject?.blockchain_project_id !== undefined) ? 'opacity-60 cursor-not-allowed' : ''
                  }`}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Token Symbol (Max 10) *
                </label>
                <input
                  type="text"
                  name="token_symbol"
                  value={formData.token_symbol || ''}
                  onChange={handleInputChange}
                  maxLength={10}
                  required
                  placeholder="e.g. TPA"
                  className="w-full px-4 py-2 bg-navy/50 border border-gold/20 rounded-lg text-white focus:outline-none focus:border-gold"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Asset Type *
                </label>
                <select
                  name="asset_type"
                  value={formData.asset_type || 'real_estate'}
                  onChange={handleInputChange}
                  className="w-full px-4 py-2 bg-navy/50 border border-gold/20 rounded-lg text-white focus:outline-none focus:border-gold"
                >
                  <option value="real_estate">Real Estate</option>
                  <option value="mining">Mining / Industrial</option>
                  <option value="other">Other Assets</option>
                </select>
              </div>
              <div className={formData.asset_type === 'real_estate' ? 'hidden' : ''}>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Round Token Limit *
                </label>
                <input
                  type="number"
                  name="round_limit_tokens"
                  value={formData.round_limit_tokens ?? 0}
                  onChange={handleInputChange}
                  required
                  min="0"
                  step="1"
                  placeholder="Initial round limit"
                  className="w-full px-4 py-2 bg-navy/50 border border-gold/20 rounded-lg text-white focus:outline-none focus:border-gold"
                />
              </div>
            </div>

            {/* Program Requirements */}
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Accepted Stablecoin (Mint Address) *
                </label>
                <input
                  type="text"
                  name="accepted_stablecoin"
                  value={formData.accepted_stablecoin || ''}
                  onChange={handleInputChange}
                  required
                  className="w-full px-4 py-2 bg-navy/50 border border-gold/20 rounded-lg text-white focus:outline-none focus:border-gold font-mono text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Treasury Wallet Address *
                </label>
                <input
                  type="text"
                  name="treasury_wallet"
                  value={formData.treasury_wallet || ''}
                  onChange={handleInputChange}
                  required
                  className="w-full px-4 py-2 bg-navy/50 border border-gold/20 rounded-lg text-white focus:outline-none focus:border-gold font-mono text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Token Decimals (e.g. 9) *
                </label>
                <input
                  type="number"
                  name="token_decimals"
                  value={formData.token_decimals}
                  onChange={handleInputChange}
                  readOnly={editingProject?.blockchain_project_id !== null && editingProject?.blockchain_project_id !== undefined}
                  required
                  min="0"
                  max="14"
                  className={`w-full px-4 py-2 bg-navy/50 border border-gold/20 rounded-lg text-white focus:outline-none focus:border-gold ${
                    (editingProject?.blockchain_project_id !== null && editingProject?.blockchain_project_id !== undefined) ? 'opacity-60 cursor-not-allowed' : ''
                  }`}
                />
              </div>
            </div>

            <div className="grid md:grid-cols-4 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2 text-[10px] uppercase">
                  Metadata URL (Arweave/Pinata)
                </label>
                <input
                  type="url"
                  name="metadata_uri"
                  value={formData.metadata_uri || ''}
                  onChange={handleInputChange}
                  placeholder="https://..."
                  className="w-full px-4 py-2 bg-navy/50 border border-gold/20 rounded-lg text-white focus:outline-none focus:border-gold text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2 text-[10px] uppercase">
                  Lock-up End Date
                </label>
                <input
                  type="datetime-local"
                  name="lockup_end_date"
                  value={formData.lockup_end_date || ''}
                  onChange={handleInputChange}
                  className="w-full px-4 py-2 bg-navy/50 border border-gold/20 rounded-lg text-white focus:outline-none focus:border-gold"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2 text-[10px] uppercase">
                  Distribution Cadence
                </label>
                <select
                  name="distribution_cadence"
                  value={formData.distribution_cadence ?? 0}
                  onChange={handleInputChange}
                  className="w-full px-4 py-2 bg-navy/50 border border-gold/20 rounded-lg text-white focus:outline-none focus:border-gold"
                >
                  <option value={0}>Monthly</option>
                  <option value={1}>Quarterly</option>
                  <option value={2}>Bi-Annually</option>
                  <option value={3}>Annually</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2 text-[10px] uppercase">
                  Payout Model
                </label>
                <select
                  name="distribution_mode"
                  value={formData.distribution_mode ?? 0}
                  onChange={handleInputChange}
                  className="w-full px-4 py-2 bg-navy/50 border border-gold/20 rounded-lg text-white focus:outline-none focus:border-gold"
                >
                  <option value={0}>Parallel</option>
                  <option value={1}>Sequential</option>
                </select>
              </div>
            </div>

            {/* Project Details */}
            <div className="grid md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Expected Return (%)
                </label>
                <input
                  type="number"
                  name="expected_return_percentage"
                  value={formData.expected_return_percentage || ''}
                  onChange={handleInputChange}
                  min="0"
                  step="0.1"
                  className="w-full px-4 py-2 bg-navy/50 border border-gold/20 rounded-lg text-white focus:outline-none focus:border-gold"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Duration (months)
                </label>
                <input
                  type="number"
                  name="project_duration_months"
                  value={formData.project_duration_months || ''}
                  onChange={handleInputChange}
                  min="0"
                  step="1"
                  className="w-full px-4 py-2 bg-navy/50 border border-gold/20 rounded-lg text-white focus:outline-none focus:border-gold"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Status *
                </label>
                <select
                  name="status"
                  value={formData.status}
                  onChange={handleInputChange}
                  required
                  className="w-full px-4 py-2 bg-navy/50 border border-gold/20 rounded-lg text-white focus:outline-none focus:border-gold"
                >
                  {editingProject ? (
                    <>
                      <option value="draft" disabled={editingProject.blockchain_project_id !== null}>Draft</option>
                      <option value="funding">Funding</option>
                      <option value="funded">Funded</option>
                      <option value="active">Active</option>
                      <option value="completed">Completed</option>
                      <option value="cancelled">Cancelled</option>
                    </>
                  ) : (
                    <option value="draft">Draft (Mandatory Initial State)</option>
                  )}
                </select>
              </div>
            </div>

            {/* Images */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Image URLs (one per line)
              </label>
              <textarea
                value={formData.images?.join('\n') || ''}
                onChange={handleImageUrlsChange}
                rows={3}
                placeholder="https://example.com/image1.jpg&#10;https://example.com/image2.jpg"
                className="w-full px-4 py-2 bg-navy/50 border border-gold/20 rounded-lg text-white focus:outline-none focus:border-gold font-mono text-sm"
              />
              <p className="text-xs text-gray-500 mt-1">Enter full URLs to project images</p>
            </div>

            {/* Documents */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Document URLs (one per line)
              </label>
              <textarea
                value={formData.documents?.join('\n') || ''}
                onChange={handleDocumentUrlsChange}
                rows={3}
                placeholder="https://example.com/document1.pdf&#10;https://example.com/document2.pdf"
                className="w-full px-4 py-2 bg-navy/50 border border-gold/20 rounded-lg text-white focus:outline-none focus:border-gold font-mono text-sm"
              />
              <p className="text-xs text-gray-500 mt-1">Enter full URLs to project documents (PDFs, etc.)</p>
            </div>

            {/* Video URL */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Video URL (YouTube, Vimeo, etc.)
              </label>
              <input
                type="url"
                name="video_url"
                value={formData.video_url || ''}
                onChange={handleInputChange}
                placeholder="https://youtube.com/watch?v=..."
                className="w-full px-4 py-2 bg-navy/50 border border-gold/20 rounded-lg text-white focus:outline-none focus:border-gold"
              />
            </div>

            {/* Form Actions */}
            <div className="flex gap-4">
              <button
                type="submit"
                disabled={loading}
                className="bg-gradient-to-r from-gold to-gold-light text-navy font-bold py-3 px-8 rounded-lg transition-all duration-300 hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Saving...' : editingProject ? 'Update Project' : 'Create Project'}
              </button>
              <button
                type="button"
                onClick={() => {
                  resetForm();
                  setShowForm(false);
                }}
                className="px-6 py-3 glass rounded-lg border border-gold/20 text-gray-300 hover:text-gold transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Projects List */}
      <div className="space-y-4">
        {projects.map((project) => (
          <div
            key={project.id}
            className="glass rounded-xl p-6 border border-gold/20"
          >
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-2">
                  <h3 className="text-xl font-bold text-white">{project.name}</h3>
                  {(() => {
                    const status = (project.onChain?.status ? fromChainStatus(project.onChain.status) : project.status) as Project['status'];
                    const isSynced = !project.onChain || status === project.status;

                    return (
                      <div className="flex items-center gap-2">
                        <span
                          className={`px-3 py-1 rounded-full text-[10px] font-bold tracking-wider ${
                            status === 'funding'
                              ? 'bg-gold/20 text-gold'
                              : status === 'active'
                              ? 'bg-green-500/20 text-green-400'
                              : status === 'completed'
                              ? 'bg-blue-500/20 text-blue-400'
                              : 'bg-gray-500/20 text-gray-400'
                          }`}
                        >
                          {status.toUpperCase()}
                        </span>
                        {!isSynced && (
                          <span className="text-[10px] text-orange-400 font-medium animate-pulse" title="Database and Blockchain are out of sync. Use the dropdown to resync.">
                             ⚠ SYNC REQ
                          </span>
                        )}
                      </div>
                    );
                  })()}
                  <span className="px-3 py-1 rounded-full text-xs font-bold bg-navy-light text-gray-300 border border-gold/10">
                    {String(project.onChain?.assetType || project.asset_type || 'real_estate').replace('_', ' ').toUpperCase()}
                  </span>
                  {project.is_paused && (
                    <span className="px-3 py-1 rounded-full text-xs font-bold bg-red-500/20 text-red-500 border border-red-500/30 animate-pulse">
                      PAUSED
                    </span>
                  )}
                </div>
                <p className="text-gray-400 text-sm mb-3">{project.location}, {project.country}</p>
                <p className="text-gray-300 text-sm mb-4 line-clamp-2">{project.description}</p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <span className="text-gray-500">Funding:</span>
                    <span className="text-white font-medium ml-2">
                      ${((project.current_funding ?? 0) / 1000).toFixed(0)}k / ${((project.funding_goal ?? 0) / 1000).toFixed(0)}k
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500">Minted / Issued:</span>
                    <span className="text-white font-medium ml-2">
                      {(() => {
                        const total = project.onChain?.supplyCap ?? (project.total_tokens || 0);
                        const issued = project.onChain?.tokensIssued ?? 0;
                        const available = project.onChain ? (total - issued) : (project.available_tokens || 0);
                        
                        return (
                          <>
                            {issued.toLocaleString(undefined, { maximumFractionDigits: (project as any).token_decimals ?? 9 })} / {total.toLocaleString(undefined, { maximumFractionDigits: (project as any).token_decimals ?? 9 })}
                          </>
                        );
                      })()}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500">Return:</span>
                    <span className="text-white font-medium ml-2">
                      {project.expected_return_percentage ?? '—'}%
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500">Duration:</span>
                    <span className="text-white font-medium ml-2">
                      {project.project_duration_months ?? '—'} months
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500">Payout:</span>
                    <span className="text-white font-medium ml-2">
                      {(project.onChain as any)?.distributionMode === 1 || project.distribution_mode === 1 ? 'Sequential' : 'Parallel'}
                    </span>
                  </div>
                </div>

                {/* Round Progress Bar */}
                {project.asset_type !== 'real_estate' && (
                  <div className="mt-4 p-3 bg-navy/30 rounded-lg border border-gold/10">
                     <div className="flex justify-between text-[10px] uppercase tracking-wider mb-1">
                        <span className="text-gray-400">Current Round Issuance</span>
                        <span className="text-gold font-bold">
                          {(() => {
                            const issued = project.onChain?.currentRoundIssued ?? (project as any).current_round_issued ?? 0;
                            const limit = project.onChain?.roundLimitTokens ?? (project as any).round_limit_tokens ?? 0;
                            return `${issued.toLocaleString()} / ${limit.toLocaleString()}`;
                          })()}
                        </span>
                     </div>
                     <div className="w-full h-1.5 bg-navy/50 rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-gradient-to-r from-gold to-gold-light transition-all duration-500"
                          style={{ 
                            width: `${Math.min(100, (
                              (() => {
                                const issued = project.onChain?.currentRoundIssued ?? (project as any).current_round_issued ?? 0;
                                const limit = project.onChain?.roundLimitTokens ?? (project as any).round_limit_tokens ?? 0;
                                return (issued / (limit || 1)) * 100;
                              })()
                            ))}%` 
                          }}
                        />
                     </div>
                  </div>
                )}
                {/* Blockchain badge */}
                {project.blockchain_signature && (
                  <div className="mt-3 flex items-center gap-2">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-gold/10 text-gold border border-gold/30">⛓ On-Chain</span>
                    <a
                      href={`https://solscan.io/tx/${project.blockchain_signature}?cluster=devnet`}
                      target="_blank" rel="noopener noreferrer"
                      className="text-xs text-gray-500 hover:text-gold underline underline-offset-2"
                    >
                      Tx: {project.blockchain_signature.slice(0, 12)}…
                    </a>

                    {/* Mint Address Link */}
                    {(project as any).mint_address && (
                      <a
                        href={`https://solscan.io/token/${(project as any).mint_address}?cluster=devnet`}
                        target="_blank" rel="noopener noreferrer"
                        className="text-xs text-gray-400 hover:text-gold flex items-center gap-1 group transition-colors"
                      >
                        <span className="text-gold opacity-60 group-hover:opacity-100">💎</span>
                        <span className="underline underline-offset-2">Mint: {(project as any).mint_address.slice(0, 8)}…</span>
                      </a>
                    )}
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-2 ml-4 items-end">
                {/* Quick status changer */}
                <div className="flex gap-2 w-full md:w-32">
                  <select
                    id={`status-${project.id}`}
                    value={project.status}
                    disabled={statusChanging === project.id || project.status === 'completed' || project.status === 'canceled'}
                    onChange={(e) => handleUpdatePhase(project, e.target.value as Project['status'])}
                    className="px-3 py-1.5 bg-navy/80 border border-gold/20 rounded-lg text-xs text-white focus:outline-none focus:border-gold transition-colors disabled:opacity-50 cursor-pointer flex-1"
                    title={project.status === 'completed' || project.status === 'canceled' ? "Terminal state reached. Cannot update phase." : "Update On-Chain Project Phase"}
                  >
                    <option value="draft" disabled={project.blockchain_project_id !== null && project.blockchain_project_id !== undefined}>Draft</option>
                    <option value="funding">Funding</option>
                    <option value="active">Active</option>
                    <option value="completed">Completed</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                  
                  {/* Quick Sync Button if out of sync */}
                  {project.onChain && fromChainStatus(project.onChain.status) !== project.status && (
                    <button
                      onClick={() => handleSyncFromChain(project)}
                      disabled={statusChanging === project.id}
                      title={`Blockchain is ${fromChainStatus(project.onChain.status).toUpperCase()}. Click to sync Database.`}
                      className="p-1 px-2 bg-orange-500/20 text-orange-400 border border-orange-500/40 rounded hover:bg-orange-500/30 transition-all animate-pulse"
                    >
                      🔄
                    </button>
                  )}
                </div>

                {/* On-chain Action Buttons */}
                {project.blockchain_project_id !== null && project.blockchain_project_id !== undefined && (
                  <div className="flex gap-2 flex-wrap justify-end">
                      <button
                        title={project.is_paused ? "Resume investments" : "Pause investments"}
                        disabled={statusChanging === project.id}
                        onClick={() => handleChainAction(project, 'togglePause')}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all disabled:opacity-40 border ${
                          project.is_paused 
                            ? 'bg-green-500/20 text-green-400 border-green-500/30' 
                            : 'bg-orange-500/20 text-orange-400 border-orange-500/30'
                        }`}
                      >
                        {project.is_paused ? '▶ Resume' : '⏸ Pause'}
                      </button>

                      {/* Issue Tokens Button */}
                      <button
                        title="Manually issue tokens to an investor"
                        disabled={statusChanging === project.id}
                        onClick={() => handleChainAction(project, 'issueTokens')}
                        className="px-3 py-1.5 rounded-lg text-xs font-bold bg-blue-500/20 text-blue-400 border border-blue-500/30 hover:bg-blue-500/30"
                      >
                        💎 Issue Tokens
                      </button>

                      {/* Reset Round Button (Hide for Real Estate) */}
                      {project.asset_type !== 'real_estate' && (
                         <button
                           title="Reset the current round counter"
                           disabled={statusChanging === project.id}
                           onClick={() => handleChainAction(project, 'resetRound')}
                           className="px-3 py-1.5 rounded-lg text-xs font-bold bg-purple-500/20 text-purple-400 border border-purple-500/30 hover:bg-purple-500/30"
                         >
                           🔄 Reset Round
                         </button>
                      )}

                    {/* Set Mint Button */}
                    {!project.mint_address && (
                      <button
                        title="Link an SPL Token Mint"
                        disabled={loading || statusChanging === project.id}
                        onClick={() => handleSetMint(project)}
                        className="px-3 py-1.5 rounded-lg text-xs font-bold bg-gold text-navy hover:bg-gold-light transition-all disabled:opacity-50"
                      >
                        ✨ Set Mint
                      </button>
                    )}

                    {/* Revoke Mint Authority (Danger Zone) */}
                    {project.mint_address && !project.mint_authority_revoked && (
                      <button
                        title="IRREVERSIBLE: Stop all future issuance"
                        disabled={statusChanging === project.id}
                        onClick={() => handleChainAction(project, 'revokeMintAuthority')}
                        className="px-3 py-1.5 rounded-lg text-xs font-bold bg-red-500/20 text-red-500 hover:bg-red-500/30 border border-red-500/30 transition-colors disabled:opacity-40"
                      >
                        🚫 Revoke Auth
                      </button>
                    )}

                    {/* Revoked Status Indicator */}
                    {project.mint_authority_revoked && (
                      <span className="px-3 py-1.5 rounded-lg text-[10px] font-bold bg-white/5 text-gray-500 border border-white/10 uppercase tracking-tighter">
                        Mint Locked
                      </span>
                    )}
                  </div>
                )}

                <div className="flex gap-2">
                  <button
                    onClick={() => handleEdit(project)}
                    className="px-4 py-2 bg-gold/20 text-gold rounded-lg hover:bg-gold/30 transition-colors text-sm"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(project.id)}
                    disabled={loading || project.status !== 'draft'}
                    className={`px-4 py-2 rounded-lg transition-colors text-sm ${
                      project.status === 'draft' 
                        ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30' 
                        : 'bg-gray-500/10 text-gray-500 cursor-not-allowed'
                    }`}
                    title={project.status !== 'draft' ? "Only projects in 'Draft' status can be deleted." : ""}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          </div>
        ))}

        {projects.length === 0 && (
          <div className="glass rounded-xl p-12 border border-gold/20 text-center">
            <p className="text-gray-400">No projects yet. Create your first project above.</p>
          </div>
        )}
      </div>
    </div>
  );
}
