'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { ICTRule } from '@/lib/rules/types';

// Mock data for now - will be replaced with database calls
const mockRules: ICTRule[] = [
  {
    id: '1',
    name: 'Silver Bullet FVG Entry',
    description: 'Enter on FVG during 10-11 AM EST window after liquidity sweep',
    source: '2022 Mentorship EP 15',
    sourceUrl: 'https://youtube.com/watch?v=example',
    sourceTimestamp: '24:30',
    conditions: [],
    entryLogic: {
      type: 'limit_at_fvg',
      params: { zoneEdge: 'mid' },
      description: 'Limit order at 50% of FVG',
    },
    exitLogic: {
      stopLoss: { type: 'swing_based', params: { swingOffset: 5 } },
      takeProfit: { type: 'rr_based', params: { riskReward: 3 } },
    },
    concepts: ['fvg', 'liquidity'],
    killZones: ['silver_bullet'],
    direction: 'both',
    isActive: true,
    confidence: 'testing',
    totalTriggers: 12,
    approvedTrades: 8,
    wins: 5,
    losses: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

export default function RulesPage() {
  const [rules] = useState<ICTRule[]>(mockRules);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-5xl px-6 py-8">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <Link
              href="/"
              className="mb-2 inline-block text-sm text-zinc-500 hover:text-zinc-300"
            >
              ← Back to Dashboard
            </Link>
            <h1 className="text-3xl font-bold">ICT Rules</h1>
            <p className="mt-1 text-zinc-400">
              Trading rules extracted from ICT video transcripts
            </p>
          </div>
          <Link
            href="/rules/new"
            className="rounded-lg bg-emerald-600 px-4 py-2 font-medium hover:bg-emerald-500"
          >
            + New Rule
          </Link>
        </div>

        {/* Stats */}
        <div className="mb-8 grid grid-cols-4 gap-4">
          <StatCard label="Total Rules" value={rules.length} />
          <StatCard
            label="Active"
            value={rules.filter((r) => r.isActive).length}
          />
          <StatCard
            label="Win Rate"
            value={`${calculateWinRate(rules)}%`}
          />
          <StatCard
            label="Total Trades"
            value={rules.reduce((acc, r) => acc + r.approvedTrades, 0)}
          />
        </div>

        {/* Rules List */}
        <div className="space-y-4">
          {rules.length === 0 ? (
            <EmptyState />
          ) : (
            rules.map((rule) => <RuleCard key={rule.id} rule={rule} />)
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-sm text-zinc-500">{label}</div>
    </div>
  );
}

function RuleCard({ rule }: { rule: ICTRule }) {
  const winRate =
    rule.wins + rule.losses > 0
      ? Math.round((rule.wins / (rule.wins + rule.losses)) * 100)
      : 0;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h3 className="text-lg font-semibold">{rule.name}</h3>
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${
                rule.isActive
                  ? 'bg-emerald-900 text-emerald-300'
                  : 'bg-zinc-800 text-zinc-400'
              }`}
            >
              {rule.isActive ? 'Active' : 'Inactive'}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${
                rule.confidence === 'proven'
                  ? 'bg-blue-900 text-blue-300'
                  : rule.confidence === 'testing'
                    ? 'bg-yellow-900 text-yellow-300'
                    : 'bg-zinc-800 text-zinc-400'
              }`}
            >
              {rule.confidence}
            </span>
          </div>

          {rule.description && (
            <p className="mt-2 text-sm text-zinc-400">{rule.description}</p>
          )}

          {/* Concepts */}
          <div className="mt-3 flex flex-wrap gap-2">
            {rule.concepts.map((concept) => (
              <span
                key={concept}
                className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300"
              >
                {concept.toUpperCase()}
              </span>
            ))}
            {rule.killZones.map((kz) => (
              <span
                key={kz}
                className="rounded bg-purple-900/50 px-2 py-0.5 text-xs text-purple-300"
              >
                {formatKillZone(kz)}
              </span>
            ))}
          </div>

          {/* Source */}
          {rule.source && (
            <div className="mt-3 text-xs text-zinc-500">
              Source: {rule.source}
              {rule.sourceTimestamp && ` @ ${rule.sourceTimestamp}`}
            </div>
          )}
        </div>

        {/* Stats */}
        <div className="ml-6 text-right">
          <div className="text-2xl font-bold">
            {winRate}%
            <span className="ml-1 text-sm font-normal text-zinc-500">win</span>
          </div>
          <div className="text-sm text-zinc-500">
            {rule.wins}W / {rule.losses}L
          </div>
          <div className="mt-2 text-xs text-zinc-600">
            {rule.totalTriggers} triggers
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="mt-4 flex gap-2 border-t border-zinc-800 pt-4">
        <Link
          href={`/rules/${rule.id}`}
          className="rounded bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700"
        >
          Edit
        </Link>
        <button className="rounded bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700">
          {rule.isActive ? 'Disable' : 'Enable'}
        </button>
        <button className="rounded bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700">
          Test
        </button>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-zinc-700 p-12 text-center">
      <div className="text-4xl">📚</div>
      <h3 className="mt-4 text-lg font-medium">No rules yet</h3>
      <p className="mt-2 text-sm text-zinc-500">
        Start by adding rules from ICT video transcripts
      </p>
      <Link
        href="/rules/new"
        className="mt-4 inline-block rounded-lg bg-emerald-600 px-4 py-2 font-medium hover:bg-emerald-500"
      >
        Create First Rule
      </Link>
    </div>
  );
}

function calculateWinRate(rules: ICTRule[]): number {
  const totalWins = rules.reduce((acc, r) => acc + r.wins, 0);
  const totalLosses = rules.reduce((acc, r) => acc + r.losses, 0);
  if (totalWins + totalLosses === 0) return 0;
  return Math.round((totalWins / (totalWins + totalLosses)) * 100);
}

function formatKillZone(kz: string): string {
  const map: Record<string, string> = {
    asian: 'Asian',
    london_open: 'London Open',
    london_close: 'London Close',
    ny_am: 'NY AM',
    ny_lunch: 'NY Lunch',
    ny_pm: 'NY PM',
    silver_bullet: 'Silver Bullet',
  };
  return map[kz] ?? kz;
}
