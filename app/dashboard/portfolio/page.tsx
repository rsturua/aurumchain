"use client";

import { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import { useDashboardData } from "@/hooks/useDashboardData";
import { createClient } from "@/lib/supabase/client";
import { ListTokenModal } from "@/app/_components/portfolio/ListTokenModal";

export default function PortfolioPage() {
  const { stats, investments: dbInvestments, projects, loading, refresh } = useDashboardData();
  const [timeframe, setTimeframe] = useState<"1D" | "1W" | "1M" | "3M" | "1Y" | "ALL">("1M");

  const [positions, setPositions] = useState<any[]>([]);
  const [loadingPositions, setLoadingPositions] = useState(true);
  const [selectedPosition, setSelectedPosition] = useState<any | null>(null);
  const [isListModalOpen, setIsListModalOpen] = useState(false);

  const fetchPositions = async () => {
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data, error } = await supabase
        .from('portfolio_positions')
        .select(`
          *,
          projects:project_id (
            id,
            name,
            slug,
            location,
            country,
            status,
            token_symbol,
            token_decimals,
            blockchain_project_id,
            mint_address,
            images,
            lockup_end_date
          )
        `)
        .eq('user_id', user.id)
        .eq('is_active', true)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setPositions(data || []);
    } catch (err) {
      console.error("Error fetching positions:", err);
    } finally {
      setLoadingPositions(false);
    }
  };

  useEffect(() => {
    fetchPositions();
  }, []);

  const portfolioStats = useMemo(() => ({
    totalValue: stats.portfolioValue,
    totalInvested: stats.totalInvested,
    totalReturns: stats.totalReturns,
    returnPercentage: stats.totalInvested > 0 ? (stats.totalReturns / stats.totalInvested) * 100 : 0,
    goldTokens: stats.goldTokens,
    activeProjects: stats.activeProjectsCount,
    completedProjects: projects.filter(p => p.status === 'completed').length,
  }), [stats, projects]);

  const projectBreakdown = useMemo(() => {
    return positions.map((pos: any, index: number) => {
      const project = pos.projects;
      const allocation = portfolioStats.totalValue > 0 
        ? (Number(pos.total_invested) / portfolioStats.totalValue) * 100 
        : 0;

      return {
        id: pos.id,
        projectId: pos.project_id,
        name: project?.name || "Unknown Project",
        location: project?.location || "Global",
        allocation: Number(allocation.toFixed(1)),
        value: Number(pos.total_invested),
        returns: Number(pos.total_dividends_received || 0),
        returnPercentage: pos.total_invested > 0 ? ((Number(pos.total_dividends_received || 0) / Number(pos.total_invested)) * 100).toFixed(1) : "0.0",
        status: project?.status || "active",
        total_tokens: Number(pos.total_tokens),
        projects: project,
      };
    }).sort((a: any, b: any) => b.value - a.value);
  }, [positions, portfolioStats.totalValue]);

  const performanceMetrics = [
    {
      label: "Top Holding",
      value: projectBreakdown[0]?.name || "None",
      metric: projectBreakdown[0] ? `${projectBreakdown[0].allocation}% of portfolio` : "N/A",
      color: "text-green-400",
    },
    {
      label: "Total Projects",
      value: `${projectBreakdown.length}`,
      metric: "Active investments",
      color: "text-gold",
    },
    {
      label: "Average Return Rate",
      value: `${portfolioStats.returnPercentage.toFixed(1)}%`,
      metric: "Total ROI",
      color: "text-blue-400",
    },
    {
      label: "Gold Balance",
      value: `${portfolioStats.goldTokens.toFixed(2)} oz`,
      metric: "Physical backing",
      color: "text-purple-400",
    },
  ];

  const getStatusColor = (status: string) => {
    switch (status) {
      case "active":
        return "text-green-400 bg-green-400/10";
      case "funded":
        return "text-blue-400 bg-blue-400/10";
      case "completed":
        return "text-gold bg-gold/10";
      default:
        return "text-gray-400 bg-gray-400/10";
    }
  };

  if (loading || loadingPositions) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-white text-xl">Loading portfolio analytics...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-3xl font-bold text-white mb-2">Portfolio Analytics</h1>
        <p className="text-gray-400">Track your portfolio performance and allocation</p>
      </div>

      {/* Main Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="glass rounded-xl p-6 border border-gold/20">
          <div className="flex items-center justify-between mb-2">
            <span className="text-gray-400 text-sm">Portfolio Value</span>
            <svg className="w-5 h-5 text-gold" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div className="text-2xl font-bold text-white mb-1">${portfolioStats.totalValue.toLocaleString()}</div>
          <div className="text-sm text-green-400">+${portfolioStats.totalReturns.toLocaleString()} ({portfolioStats.returnPercentage.toFixed(1)}%)</div>
        </div>

        <div className="glass rounded-xl p-6 border border-gold/20">
          <div className="flex items-center justify-between mb-2">
            <span className="text-gray-400 text-sm">Total Invested</span>
            <svg className="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 11l5-5m0 0l5 5m-5-5v12" />
            </svg>
          </div>
          <div className="text-2xl font-bold text-white">${portfolioStats.totalInvested.toLocaleString()}</div>
        </div>

        <div className="glass rounded-xl p-6 border border-gold/20">
          <div className="flex items-center justify-between mb-2">
            <span className="text-gray-400 text-sm">Gold Tokens</span>
            <svg className="w-5 h-5 text-gold" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div className="text-2xl font-bold gradient-text">{portfolioStats.goldTokens.toFixed(2)} oz</div>
        </div>

        <div className="glass rounded-xl p-6 border border-gold/20">
          <div className="flex items-center justify-between mb-2">
            <span className="text-gray-400 text-sm">Active Projects</span>
            <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
            </svg>
          </div>
          <div className="text-2xl font-bold text-white">{portfolioStats.activeProjects}</div>
        </div>
      </div>

      {/* Portfolio Performance Chart */}
      <div className="glass rounded-xl p-6 border border-gold/20">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6">
          <div>
            <h2 className="text-xl font-bold text-white mb-1">Portfolio Performance</h2>
            <p className="text-sm text-gray-400">Track your portfolio value over time</p>
          </div>
          <div className="flex gap-2 mt-4 md:mt-0">
            {(["1D", "1W", "1M", "3M", "1Y", "ALL"] as const).map((tf) => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  timeframe === tf
                    ? "bg-gold text-navy"
                    : "bg-navy-dark text-gray-400 hover:text-white border border-gold/20"
                }`}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>

        {/* Chart Placeholder */}
        <div className="bg-navy-dark rounded-lg p-8 border border-gold/10">
          <div className="flex items-center justify-center h-64">
            <div className="text-center">
              <svg className="w-16 h-16 text-gold/20 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2m0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
              <h3 className="text-lg font-bold text-white mb-2">Portfolio Chart</h3>
              <p className="text-sm text-gray-400">Interactive chart showing portfolio growth over {timeframe}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Performance Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {performanceMetrics.map((metric, index) => (
          <div key={index} className="glass rounded-xl p-6 border border-gold/20">
            <div className="text-xs text-gray-400 uppercase tracking-wider mb-2">{metric.label}</div>
            <div className={`text-2xl font-bold ${metric.color} mb-1 truncate`}>{metric.value}</div>
            <div className="text-sm text-gray-400">{metric.metric}</div>
          </div>
        ))}
      </div>

      {/* Project Allocation */}
      <div className="glass rounded-xl p-6 border border-gold/20">
        <div className="mb-6">
          <h2 className="text-xl font-bold text-white mb-1">Project Allocation</h2>
          <p className="text-sm text-gray-400">Breakdown of your investments by project</p>
        </div>

        {/* Allocation Bar */}
        <div className="mb-6">
          <div className="flex h-12 rounded-lg overflow-hidden">
            {projectBreakdown.map((project: any, index: number) => (
              <div
                key={project.id}
                className="relative group cursor-pointer transition-all hover:opacity-80"
                style={{
                  width: `${project.allocation}%`,
                  backgroundColor: [
                    "#FFD700",
                    "#FFA500",
                    "#FF8C00",
                    "#FF6B35",
                    "#C44569",
                  ][index % 5],
                }}
              >
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-xs font-bold text-navy opacity-0 group-hover:opacity-100 transition-opacity">
                    {project.allocation}%
                  </span>
                </div>
              </div>
            ))}
            {projectBreakdown.length === 0 && (
              <div className="w-full bg-navy-dark flex items-center justify-center text-gray-500 text-sm italic">
                No active investments
              </div>
            )}
          </div>
        </div>

        {/* Project List */}
        <div className="space-y-4">
          {projectBreakdown.map((project: any, index: number) => (
            <div
              key={project.id}
              className="flex flex-col md:flex-row md:items-center justify-between p-4 bg-navy-dark rounded-lg border border-gold/10 hover:border-gold/30 transition-all gap-4"
            >
              <div className="flex items-center gap-4">
                <div
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{
                    backgroundColor: [
                      "#FFD700",
                      "#FFA500",
                      "#FF8C00",
                      "#FF6B35",
                      "#C44569",
                    ][index % 5],
                  }}
                ></div>
                <div>
                  <div className="text-sm font-bold text-white">{project.name}</div>
                  <div className="text-xs text-gray-400 flex items-center gap-2 mt-1">
                    <span className="text-gold font-semibold">{project.total_tokens.toLocaleString()} {project.projects?.token_symbol || 'Tokens'}</span>
                    <span>•</span>
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    {project.location}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-4 md:gap-6">
                <div className="text-right">
                  <div className="text-sm font-bold text-white">${project.value.toLocaleString()}</div>
                  <div className="text-xs text-gray-400">{project.allocation}% allocation</div>
                </div>

                <div className="text-right">
                  <div className={`text-sm font-bold ${Number(project.returns) > 0 ? 'text-green-400' : 'text-gray-400'}`}>
                    {Number(project.returns) > 0 ? '+' : ''}{project.returnPercentage}%
                  </div>
                  <div className="text-xs text-gray-400">
                    {Number(project.returns) > 0 ? `+$${Number(project.returns).toLocaleString()}` : '$0'}
                  </div>
                </div>

                <div>
                  <span className={`inline-flex px-3 py-1 rounded-full text-xs font-medium uppercase tracking-wider ${getStatusColor(project.status)}`}>
                    {project.status}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  {project.total_tokens > 0 && project.status === 'active' && project.projects?.lockup_end_date && new Date(project.projects.lockup_end_date).getTime() < Date.now() && (
                    <button
                      onClick={() => {
                        setSelectedPosition({
                          total_tokens: project.total_tokens,
                          project_id: project.projectId,
                          projects: project.projects
                        });
                        setIsListModalOpen(true);
                      }}
                      className="px-3 py-1.5 bg-gold/10 border border-gold/30 hover:bg-gold hover:text-navy text-gold text-xs font-semibold rounded-lg transition-all"
                    >
                      List for Sale
                    </button>
                  )}

                  <Link
                    href={`/projects/${project.projects?.slug || ''}`}
                    className="text-gold hover:text-gold-light p-1.5 rounded hover:bg-gold/10 transition-colors"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </Link>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Risk Assessment */}
      <div className="glass rounded-xl p-6 border border-gold/20">
        <div className="mb-6">
          <h2 className="text-xl font-bold text-white mb-1">Risk Assessment</h2>
          <p className="text-sm text-gray-400">Portfolio risk analysis and diversification score</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-navy-dark rounded-lg p-6 border border-gold/10">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm text-gray-400">Risk Level</span>
              <svg className="w-5 h-5 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <div className="text-2xl font-bold text-yellow-400 mb-2">{projectBreakdown.length > 2 ? "Moderate" : "High"}</div>
            <div className="w-full bg-navy rounded-full h-2">
              <div className="bg-yellow-400 h-2 rounded-full" style={{ width: projectBreakdown.length > 2 ? "60%" : "85%" }}></div>
            </div>
          </div>

          <div className="bg-navy-dark rounded-lg p-6 border border-gold/10">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm text-gray-400">Diversification</span>
              <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div className="text-2xl font-bold text-green-400 mb-2">{projectBreakdown.length > 4 ? "Excellent" : projectBreakdown.length > 2 ? "Good" : "Low"}</div>
            <div className="w-full bg-navy rounded-full h-2">
              <div className="bg-green-400 h-2 rounded-full" style={{ width: `${Math.min(100, projectBreakdown.length * 20)}%` }}></div>
            </div>
          </div>

          <div className="bg-navy-dark rounded-lg p-6 border border-gold/10">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm text-gray-400">Stability Score</span>
              <svg className="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div className="text-2xl font-bold text-blue-400 mb-2">{(Math.min(10, 5 + projectBreakdown.length)).toFixed(1)}/10</div>
            <div className="w-full bg-navy rounded-full h-2">
              <div className="bg-blue-400 h-2 rounded-full" style={{ width: `${Math.min(100, 50 + projectBreakdown.length * 10)}%` }}></div>
            </div>
          </div>
        </div>
      </div>

      <ListTokenModal
        isOpen={isListModalOpen}
        onClose={() => setIsListModalOpen(false)}
        position={selectedPosition}
        onSuccess={() => {
          fetchPositions();
          refresh();
        }}
      />
    </div>
  );
}
