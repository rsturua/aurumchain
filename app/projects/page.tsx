"use client";

import Image from "next/image";
import Link from "next/link";
import { useState, useEffect, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import EarthGlobe from "../components/EarthGlobe";
import { InvestmentModal } from "../_components/projects/InvestmentModal";

// ── Types ────────────────────────────────────────────────────────────────────

interface OnChainData {
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
  isActive: boolean;
  isPaused: boolean;
  mintAuthorityRevoked: boolean;
  creator: string;
  pda: string;
}

interface EnrichedProject {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  location: string;
  country: string;
  funding_goal: number;
  current_funding: number;
  min_investment: number;
  token_price: number;
  total_tokens: number;
  available_tokens: number;
  expected_return_percentage: number | null;
  project_duration_months: number | null;
  start_date: string | null;
  expected_completion_date: string | null;
  status: string;
  images: string[] | null;
  documents: string[] | null;
  video_url: string | null;
  blockchain_signature: string | null;
  blockchain_project_id: number | null;
  onChain: OnChainData | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const CADENCE_LABELS: Record<number, string> = {
  0: "Monthly",
  1: "Quarterly",
  2: "Bi-Annually",
  3: "Annually",
};

const DEFAULT_PUBKEY = "11111111111111111111111111111111";

function formatUSDC(amount: number): string {
  return `$${amount.toLocaleString()}`;
}

function formatDate(ts: number): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ── Skeleton Card ─────────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="glass rounded-2xl overflow-hidden border border-gold/10 animate-pulse">
      <div className="h-56 bg-navy-dark/60" />
      <div className="p-6 space-y-3">
        <div className="h-5 bg-navy-dark/60 rounded w-3/4" />
        <div className="h-3 bg-navy-dark/60 rounded w-1/2" />
        <div className="h-3 bg-navy-dark/60 rounded w-full" />
        <div className="h-3 bg-navy-dark/60 rounded w-full" />
        <div className="grid grid-cols-2 gap-3 mt-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-14 bg-navy-dark/60 rounded-lg" />
          ))}
        </div>
        <div className="h-12 bg-navy-dark/60 rounded-xl mt-4" />
      </div>
    </div>
  );
}

// ── Project Card ──────────────────────────────────────────────────────────────

function ProjectCard({
  project,
  index,
  highlighted,
  cardRef,
  onInvest,
}: {
  project: EnrichedProject;
  index: number;
  highlighted: boolean;
  cardRef: (el: HTMLDivElement | null) => void;
  onInvest: (project: EnrichedProject) => void;
}) {
  const chain = project.onChain;
  const isOnChain = !!chain;
  const hasMint = isOnChain && chain.mint !== DEFAULT_PUBKEY;

  // ── Derived values: prefer DB field, fall back to on-chain computation ──
  const progressNumerator   = isOnChain ? chain.tokensIssued : project.current_funding;
  const progressDenominator = isOnChain ? chain.supplyCap    : project.funding_goal;
  const progressPct =
    progressDenominator > 0
      ? Math.min(100, Math.round((progressNumerator / progressDenominator) * 100))
      : 0;

  // Token price: DB value → on-chain derived (maxInvestmentUsdc / supplyCap)
  const derivedTokenPrice: string | null = (() => {
    if (project.token_price && project.token_price > 0) return `$${project.token_price}`;
    if (isOnChain && chain.supplyCap > 0 && chain.maxInvestmentUsdc > 0) {
      const price = chain.maxInvestmentUsdc / chain.supplyCap;
      return price < 1 ? `$${price.toFixed(4)}` : `$${price.toFixed(2)}`;
    }
    return null;
  })();

  // Duration: DB months → on-chain subscription window in months
  const derivedDuration: string | null = (() => {
    if (project.project_duration_months && project.project_duration_months > 0)
      return `${project.project_duration_months} mo`;
    if (isOnChain && chain.subscriptionEnd > 0 && chain.subscriptionStart > 0) {
      const months = Math.round((chain.subscriptionEnd - chain.subscriptionStart) / (30 * 86400));
      if (months > 0) return `${months} mo`;
    }
    return null;
  })();

  // Expected return: DB only — show supply cap as useful substitute for on-chain projects
  const derivedReturn: string | null = (() => {
    if (project.expected_return_percentage && project.expected_return_percentage > 0)
      return `${project.expected_return_percentage}%`;
    if (isOnChain && chain.supplyCap > 0)
      return `${(chain.supplyCap / 1000).toFixed(0)}K tokens`;
    return null;
  })();

  const statusColor =
    project.status === "funding"
      ? "bg-gold/90 text-navy shadow-lg shadow-gold/30"
      : project.status === "active"
      ? "bg-green-500/90 text-white"
      : project.status === "completed"
      ? "bg-blue-500/90 text-white"
      : "bg-gray-700/90 text-gray-300";

  return (
    <div
      ref={cardRef}
      className={`group glass rounded-2xl overflow-hidden border transition-all duration-500 hover-lift flex flex-col h-full animate-fade-in-up ${
        highlighted
          ? "border-gold shadow-2xl shadow-gold/50 scale-105"
          : "border-gold/20 hover:border-gold/40"
      }`}
      style={{ animationDelay: `${index * 120}ms` }}
    >
      {/* Image / Header */}
      <Link href={`/projects/${project.slug}`} className="block relative h-56 bg-gradient-to-br from-gold/20 via-gold/10 to-gold-dark/20 flex items-center justify-center overflow-hidden">
        <div className="absolute inset-0 bg-navy/40 backdrop-blur-sm" />
        {project.images && project.images[0] ? (
          <img
            src={project.images[0]}
            alt={project.name}
            className="absolute inset-0 w-full h-full object-cover opacity-60 group-hover:scale-110 transition-transform duration-500"
          />
        ) : (
          <Image
            src="/logo.png"
            alt={project.name}
            width={100}
            height={100}
            className="relative z-10 opacity-40 group-hover:scale-110 transition-transform duration-500"
          />
        )}

        {/* Status badge */}
        <div className="absolute top-4 right-4 z-20 flex flex-col items-end gap-1">
          <span className={`px-4 py-1.5 rounded-full text-xs font-bold backdrop-blur-sm capitalize ${statusColor}`}>
            {project.status}
          </span>
          {isOnChain && (
            <span className="px-3 py-1 rounded-full text-xs font-semibold bg-navy/80 text-gold border border-gold/40 backdrop-blur-sm flex items-center gap-1">
              ⛓ On-Chain
            </span>
          )}
          {chain?.isPaused && (
            <span className="px-3 py-1 rounded-full text-xs font-bold bg-orange-500/80 text-white backdrop-blur-sm">
              ⚠ Paused
            </span>
          )}
        </div>

        {/* ID + Symbol */}
        <div className="absolute top-4 left-4 z-20 flex flex-col gap-1">
          <span className="px-3 py-1.5 rounded-full text-xs font-medium bg-navy/80 text-gold border border-gold/30 backdrop-blur-sm">
            #{project.blockchain_project_id !== null ? project.blockchain_project_id : "—"}
          </span>
          {chain?.symbol && (
            <span className="px-3 py-1 rounded-full text-xs font-bold bg-gold/90 text-navy backdrop-blur-sm">
              {chain.symbol}
            </span>
          )}
        </div>
      </Link>

      {/* Body */}
      <div className="p-6 flex flex-col flex-grow">
        <Link href={`/projects/${project.slug}`}>
          <h3 className="text-xl font-bold text-white mb-2 group-hover:text-gold transition-colors cursor-pointer hover:underline underline-offset-4">
            {project.name}
          </h3>
        </Link>
        <p className="text-gray-400 text-sm mb-1 flex items-center gap-2">
          <svg className="w-4 h-4 text-gold flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          {project.location}, {project.country}
        </p>
        <p className="text-gray-300 text-sm mb-5 line-clamp-3 leading-relaxed">{project.description}</p>

        {/* Funding / Token Progress */}
        {(project.status === "funding" || project.status === "active") && (
          <div className="mb-5">
            <div className="flex justify-between text-sm mb-2">
              <span className="text-gray-400 font-medium">
                {isOnChain ? "Tokens Issued" : "Progress"}
              </span>
              <span className="text-gold font-bold">
                {isOnChain
                  ? `${chain!.tokensIssued.toLocaleString()} / ${chain!.supplyCap.toLocaleString()}`
                  : `$${(project.current_funding / 1000).toFixed(0)}k / $${(project.funding_goal / 1000).toFixed(0)}k`}
              </span>
            </div>
            <div className="relative w-full bg-navy/60 rounded-full h-3 overflow-hidden border border-gold/20">
              <div
                className="absolute inset-0 bg-gradient-to-r from-gold to-gold-light rounded-full transition-all duration-1000 shimmer"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <div className="text-right text-xs text-gray-500 mt-1">{progressPct}% {isOnChain ? "issued" : "funded"}</div>
          </div>
        )}

        {/* Stats Grid */}
        <div className="grid grid-cols-2 gap-3 mb-5">
          <div className="glass rounded-lg p-3 border border-gold/10">
            <div className="text-gray-400 text-xs mb-1 uppercase tracking-wider">
              {project.expected_return_percentage ? "Expected Return" : isOnChain ? "Token Supply" : "Expected Return"}
            </div>
            <div className="text-gold font-bold text-sm">
              {derivedReturn ?? <span className="text-gray-600">—</span>}
            </div>
          </div>
          <div className="glass rounded-lg p-3 border border-gold/10">
            <div className="text-gray-400 text-xs mb-1 uppercase tracking-wider">Duration</div>
            <div className="text-white font-bold text-sm">
              {derivedDuration ?? <span className="text-gray-600">—</span>}
            </div>
          </div>
          {isOnChain ? (
            <>
              <div className="glass rounded-lg p-3 border border-gold/10">
                <div className="text-gray-400 text-xs mb-1 uppercase tracking-wider">Min Invest</div>
                <div className="text-white font-bold text-sm">{formatUSDC(chain!.minInvestmentUsdc)}</div>
              </div>
              <div className="glass rounded-lg p-3 border border-gold/10">
                <div className="text-gray-400 text-xs mb-1 uppercase tracking-wider">Token Price</div>
                <div className="text-white font-bold text-sm">{derivedTokenPrice ?? "—"}</div>
              </div>
            </>
          ) : (
            <>
              <div className="glass rounded-lg p-3 border border-gold/10">
                <div className="text-gray-400 text-xs mb-1 uppercase tracking-wider">Min Invest</div>
                <div className="text-white font-bold text-sm">
                  {project.min_investment ? `$${project.min_investment.toLocaleString()}` : "—"}
                </div>
              </div>
              <div className="glass rounded-lg p-3 border border-gold/10">
                <div className="text-gray-400 text-xs mb-1 uppercase tracking-wider">Token Price</div>
                <div className="text-white font-bold text-sm">
                  {derivedTokenPrice ?? "—"}
                </div>
              </div>
            </>
          )}
        </div>

        {/* On-chain extra details */}
        {isOnChain && (
          <div className="mb-5 space-y-2 text-xs text-gray-400 border-t border-gold/10 pt-4">
            <div className="flex justify-between">
              <span>Distribution</span>
              <span className="text-gold">{CADENCE_LABELS[chain!.distributionCadence] ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span>Sub. Window</span>
              <span className="text-white">{formatDate(chain!.subscriptionStart)} → {formatDate(chain!.subscriptionEnd)}</span>
            </div>
            {hasMint && (
              <div className="flex justify-between items-center">
                <span>Token Mint</span>
                <a
                  href={`https://solscan.io/token/${chain!.mint}?cluster=devnet`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gold underline underline-offset-2 hover:text-gold-light truncate max-w-[140px]"
                >
                  {chain!.mint.slice(0, 8)}…{chain!.mint.slice(-6)}
                </a>
              </div>
            )}
            {project.blockchain_signature && (
              <div className="flex justify-between items-center">
                <span>Tx Sig</span>
                <a
                  href={`https://solscan.io/tx/${project.blockchain_signature}?cluster=devnet`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gold underline underline-offset-2 hover:text-gold-light truncate max-w-[140px]"
                >
                  {project.blockchain_signature.slice(0, 8)}…
                </a>
              </div>
            )}
          </div>
        )}

        {/* CTA */}
        <button
          className={`w-full font-bold py-3.5 px-6 rounded-xl transition-all duration-300 mt-auto ${
            project.status === "funding" && (!chain || !chain.isPaused)
              ? "bg-gradient-to-r from-gold to-gold-light hover:from-gold-light hover:to-gold text-navy shadow-lg shadow-gold/20 hover:shadow-gold/40 hover:scale-[1.02]"
              : "bg-gray-700/50 text-gray-400 cursor-not-allowed"
          }`}
          disabled={project.status !== "funding" || (!!chain && chain.isPaused)}
          onClick={() => onInvest(project)}
        >
          {chain?.isPaused
            ? "Investments Paused"
            : project.status === "funding"
            ? <span className="flex items-center justify-center gap-2">
                Invest Now
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
              </span>
            : project.status === "completed"
            ? "Completed"
            : project.status === "active"
            ? "Active"
            : "Not Open Yet"}
        </button>
      </div>
    </div>
  );
}

// ── Main Page Content ─────────────────────────────────────────────────────────

function ProjectsContent() {
  const searchParams = useSearchParams();
  const [activeFilter, setActiveFilter] = useState("all");
  const [projects, setProjects] = useState<EnrichedProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [highlightedProject, setHighlightedProject] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<EnrichedProject | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const projectRefs = useRef<{ [key: string]: HTMLDivElement | null }>({});

  // ── Fetch hybrid data ──────────────────────────────────────────────────────
  const fetchProjects = async () => {
    try {
      const res = await fetch("/api/projects", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load projects");
      const data: EnrichedProject[] = await res.json();
      setProjects(data);
    } catch (err) {
      console.error("[ProjectsPage] fetchProjects error:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProjects();
  }, []);

  // ── Realtime subscription ──────────────────────────────────────────────────
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("public-projects-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "projects" },
        () => {
          // Re-fetch the full enriched list (includes on-chain merge)
          fetchProjects();
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  // ── URL highlight param ────────────────────────────────────────────────────
  useEffect(() => {
    const highlight = searchParams.get("highlight");
    if (highlight) {
      setHighlightedProject(highlight);
      setTimeout(() => {
        projectRefs.current[highlight]?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 500);
      setTimeout(() => setHighlightedProject(null), 3000);
    }
  }, [searchParams]);

  const handleLocationClick = (id: number) => {
    const strId = String(id);
    setHighlightedProject(strId);
    setTimeout(() => {
      projectRefs.current[strId]?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);
    setTimeout(() => setHighlightedProject(null), 3000);
  };

  // ── Filter ─────────────────────────────────────────────────────────────────
  const filters = ["All Projects", "Funding", "Active", "Completed"];

  const filteredProjects = projects.filter((p) => {
    if (activeFilter === "all" || activeFilter === "all-projects") return true;
    return p.status === activeFilter;
  });

  const handleInvest = (project: EnrichedProject) => {
    setSelectedProject(project);
    setIsModalOpen(true);
  };

  return (
    <div className="min-h-screen bg-navy pt-20">
      {/* Hero */}
      <section className="py-24 px-6 md:px-12 lg:px-24 bg-gradient-to-b from-navy-dark to-navy relative overflow-hidden">
        <div className="absolute inset-0">
          <div className="absolute top-20 right-20 w-64 h-64 bg-gold/5 rounded-full blur-3xl" />
          <div className="absolute bottom-20 left-20 w-80 h-80 bg-gold/10 rounded-full blur-3xl" />
        </div>
        <div className="max-w-6xl mx-auto text-center relative z-10">
          <div className="inline-flex items-center gap-2 bg-gold/10 border border-gold/30 rounded-full px-4 py-2 mb-6">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
            </span>
            <span className="text-gold text-sm font-medium">Live Investment Opportunities</span>
          </div>
          <h1 className="text-5xl md:text-6xl font-bold mb-6">
            <span className="text-white">Mining </span>
            <span className="gradient-text">Projects</span>
          </h1>
          <p className="text-xl text-gray-400 max-w-3xl mx-auto mb-12 leading-relaxed">
            Invest in vetted gold mining operations with transparent on-chain tracking and real returns backed by gold production
          </p>
          {/* Filters */}
          <div className="flex flex-wrap justify-center gap-3">
            {filters.map((filter) => {
              const key = filter.toLowerCase().replace(" ", "-");
              const isActive = activeFilter === key || (filter === "All Projects" && activeFilter === "all");
              return (
                <button
                  key={filter}
                  id={`filter-${key}`}
                  onClick={() => setActiveFilter(key)}
                  className={`px-6 py-3 rounded-xl font-medium transition-all duration-300 ${
                    isActive
                      ? "bg-gradient-to-r from-gold to-gold-light text-navy shadow-lg shadow-gold/30"
                      : "glass border border-gold/30 text-white hover:border-gold/60"
                  }`}
                >
                  {filter}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* Globe */}
      <section className="py-16 px-6 md:px-12 lg:px-24 bg-navy-dark">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-8">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              <span className="text-white">Global </span>
              <span className="gradient-text">Mining Network</span>
            </h2>
            <p className="text-gray-400 max-w-2xl mx-auto">Click on a location to view project details</p>
          </div>
          <div className="glass rounded-2xl p-8 border border-gold/20">
            <div className="w-full aspect-square">
              <EarthGlobe interactive={false} onLocationClick={handleLocationClick} />
            </div>
          </div>
        </div>
      </section>

      {/* Projects Grid */}
      <section className="py-20 px-6 md:px-12 lg:px-24">
        <div className="max-w-7xl mx-auto">
          {/* Stats bar */}
          {!loading && projects.length > 0 && (
            <div className="flex items-center gap-6 mb-8 text-sm text-gray-400">
              <span><span className="text-white font-bold">{filteredProjects.length}</span> projects shown</span>
              <span className="flex items-center gap-1.5 text-green-400">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                </span>
                Realtime
              </span>
              <span>
                <span className="text-gold font-bold">{projects.filter((p) => p.onChain).length}</span> on-chain verified
              </span>
            </div>
          )}

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
            {loading
              ? [0, 1, 2].map((i) => <SkeletonCard key={i} />)
              : filteredProjects.length === 0
              ? (
                <div className="col-span-3 glass rounded-xl p-12 border border-gold/20 text-center">
                  <p className="text-gray-400 text-lg">No projects found in this category.</p>
                </div>
              )
              : filteredProjects.map((project, index) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  index={index}
                  highlighted={highlightedProject === project.id}
                  cardRef={(el) => { projectRefs.current[project.id] = el; }}
                  onInvest={handleInvest}
                />
              ))}
          </div>

          {selectedProject && (
            <InvestmentModal
              isOpen={isModalOpen}
              onClose={() => setIsModalOpen(false)}
              project={selectedProject}
            />
          )}
        </div>
      </section>

      {/* How it Works */}
      <section className="py-20 px-6 md:px-12 lg:px-24 bg-navy-dark">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl font-bold mb-4">
              <span className="text-white">How </span>
              <span className="gradient-text">Investment</span>
              <span className="text-white"> Works</span>
            </h2>
            <p className="text-gray-400 max-w-2xl mx-auto">
              Every project undergoes rigorous vetting to ensure transparency and minimize risk
            </p>
          </div>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                icon: (
                  <svg className="w-12 h-12 text-gold" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                ),
                title: "Due Diligence",
                description: "Rigorous vetting including geological surveys, financial audits, and operational assessments",
              },
              {
                icon: (
                  <svg className="w-12 h-12 text-gold" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                  </svg>
                ),
                title: "Tokenized Ownership",
                description: "Your investment is tokenized on the blockchain, representing a share of the mine's future production",
              },
              {
                icon: (
                  <svg className="w-12 h-12 text-gold" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                  </svg>
                ),
                title: "Gold-Backed Returns",
                description: "Receive Golden Fleece Tokens pegged to real gold as the mine produces",
              },
            ].map((item, index) => (
              <div
                key={index}
                className="group glass rounded-2xl p-8 border border-gold/20 hover:border-gold/40 transition-all duration-500 hover-lift text-center"
              >
                <div className="w-16 h-16 mx-auto mb-6 bg-gradient-to-br from-gold/20 to-gold-light/20 rounded-2xl flex items-center justify-center group-hover:scale-110 transition-transform duration-300">
                  {item.icon}
                </div>
                <h3 className="text-xl font-bold gradient-text mb-4">{item.title}</h3>
                <p className="text-gray-400 leading-relaxed">{item.description}</p>
              </div>
            ))}
          </div>
          <div className="mt-16 text-center">
            <Link
              href="/account"
              className="inline-flex items-center gap-2 bg-gradient-to-r from-gold to-gold-light hover:from-gold-light hover:to-gold text-navy font-bold py-4 px-10 rounded-xl transition-all duration-300 shadow-xl shadow-gold/30 hover:shadow-gold/50 hover:scale-105"
            >
              Create Account to Invest
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

export default function ProjectsPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-navy flex items-center justify-center">
          <div className="text-gold text-xl">Loading...</div>
        </div>
      }
    >
      <ProjectsContent />
    </Suspense>
  );
}
