'use client';

import { useState, useCallback } from 'react';
import { trpc } from '@/lib/trpc/client';
import type { Action } from '@/lib/rl/types';

export default function AgentDashboard() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string>('');
  const [backtestData, setBacktestData] = useState<File | null>(null);

  // Queries
  const statusQuery = trpc.agent.status.useQuery(undefined, {
    refetchInterval: 5000,
  });

  // Mutations
  const loadWeightsMutation = trpc.agent.loadWeights.useMutation({
    onSuccess: () => {
      setUploadStatus('Model loaded successfully!');
      statusQuery.refetch();
    },
    onError: (error) => {
      setUploadStatus(`Error: ${error.message}`);
    },
  });

  const clearMutation = trpc.agent.clear.useMutation({
    onSuccess: () => {
      statusQuery.refetch();
    },
  });

  const backtestMutation = trpc.agent.backtest.useMutation();

  // Handle model file upload
  const handleModelUpload = useCallback(async () => {
    if (!selectedFile) return;

    try {
      setUploadStatus('Loading model...');
      const content = await selectedFile.text();
      const weights = JSON.parse(content);
      loadWeightsMutation.mutate(weights);
    } catch (error) {
      setUploadStatus(`Error parsing file: ${error}`);
    }
  }, [selectedFile, loadWeightsMutation]);

  // Handle backtest
  const handleBacktest = useCallback(async () => {
    if (!backtestData) return;

    try {
      const content = await backtestData.text();
      const candles = JSON.parse(content);
      backtestMutation.mutate({ candles });
    } catch (error) {
      console.error('Backtest error:', error);
    }
  }, [backtestData, backtestMutation]);

  const status = statusQuery.data;
  const backtestResult = backtestMutation.data;

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold mb-8">RL Trading Agent Dashboard</h1>

        {/* Status Section */}
        <section className="bg-gray-800 rounded-lg p-6 mb-8">
          <h2 className="text-xl font-semibold mb-4">Agent Status</h2>

          {statusQuery.isLoading ? (
            <p className="text-gray-400">Loading...</p>
          ) : status?.loaded ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatusCard
                label="Episodes Trained"
                value={status.state?.episodeCount?.toString() ?? '0'}
              />
              <StatusCard
                label="Total Steps"
                value={status.state?.totalSteps?.toLocaleString() ?? '0'}
              />
              <StatusCard
                label="Epsilon"
                value={status.state?.epsilon?.toFixed(4) ?? '0'}
              />
              <StatusCard
                label="Avg Reward"
                value={status.state?.averageReward?.toFixed(4) ?? '0'}
              />
            </div>
          ) : (
            <p className="text-yellow-400">No agent loaded</p>
          )}

          <div className="mt-4 flex gap-4">
            {status?.loaded && (
              <button
                onClick={() => clearMutation.mutate()}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded"
              >
                Clear Agent
              </button>
            )}
          </div>
        </section>

        {/* Model Upload Section */}
        <section className="bg-gray-800 rounded-lg p-6 mb-8">
          <h2 className="text-xl font-semibold mb-4">Load Model</h2>

          <div className="flex items-center gap-4">
            <input
              type="file"
              accept=".json"
              onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
              className="flex-1 bg-gray-700 rounded p-2"
            />
            <button
              onClick={handleModelUpload}
              disabled={!selectedFile || loadWeightsMutation.isPending}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 rounded"
            >
              {loadWeightsMutation.isPending ? 'Loading...' : 'Load Model'}
            </button>
          </div>

          {uploadStatus && (
            <p className={`mt-2 ${uploadStatus.includes('Error') ? 'text-red-400' : 'text-green-400'}`}>
              {uploadStatus}
            </p>
          )}
        </section>

        {/* Backtest Section */}
        <section className="bg-gray-800 rounded-lg p-6 mb-8">
          <h2 className="text-xl font-semibold mb-4">Backtest</h2>

          <div className="flex items-center gap-4 mb-4">
            <input
              type="file"
              accept=".json"
              onChange={(e) => setBacktestData(e.target.files?.[0] ?? null)}
              className="flex-1 bg-gray-700 rounded p-2"
            />
            <button
              onClick={handleBacktest}
              disabled={!backtestData || !status?.loaded || backtestMutation.isPending}
              className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 rounded"
            >
              {backtestMutation.isPending ? 'Running...' : 'Run Backtest'}
            </button>
          </div>

          {backtestResult && (
            <div className="space-y-4">
              <h3 className="font-semibold">Results</h3>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatusCard
                  label="Total PnL"
                  value={`$${backtestResult.metrics.totalPnL.toFixed(2)}`}
                  variant={backtestResult.metrics.totalPnL >= 0 ? 'success' : 'danger'}
                />
                <StatusCard
                  label="Total Trades"
                  value={backtestResult.metrics.totalTrades.toString()}
                />
                <StatusCard
                  label="Win Rate"
                  value={`${backtestResult.metrics.winRate.toFixed(1)}%`}
                  variant={backtestResult.metrics.winRate >= 50 ? 'success' : 'warning'}
                />
                <StatusCard
                  label="Sharpe Ratio"
                  value={backtestResult.metrics.sharpeRatio.toFixed(3)}
                  variant={backtestResult.metrics.sharpeRatio >= 1 ? 'success' : 'warning'}
                />
                <StatusCard
                  label="Max Drawdown"
                  value={`${backtestResult.metrics.maxDrawdown.toFixed(1)}%`}
                  variant={backtestResult.metrics.maxDrawdown <= 10 ? 'success' : 'danger'}
                />
              </div>

              {/* Trade History */}
              {backtestResult.trades.length > 0 && (
                <div className="mt-4">
                  <h4 className="font-semibold mb-2">Recent Trades</h4>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-700">
                        <tr>
                          <th className="px-4 py-2 text-left">Side</th>
                          <th className="px-4 py-2 text-left">Entry</th>
                          <th className="px-4 py-2 text-left">Exit</th>
                          <th className="px-4 py-2 text-left">PnL</th>
                          <th className="px-4 py-2 text-left">Holding</th>
                        </tr>
                      </thead>
                      <tbody>
                        {backtestResult.trades.slice(-10).map((trade, i) => (
                          <tr key={i} className="border-t border-gray-700">
                            <td className="px-4 py-2">
                              <span className={trade.side === 'long' ? 'text-green-400' : 'text-red-400'}>
                                {trade.side.toUpperCase()}
                              </span>
                            </td>
                            <td className="px-4 py-2">{trade.entryPrice.toFixed(2)}</td>
                            <td className="px-4 py-2">{trade.exitPrice.toFixed(2)}</td>
                            <td className={`px-4 py-2 ${trade.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                              ${trade.pnl.toFixed(2)} ({trade.pnlPercent >= 0 ? '+' : ''}{(trade.pnlPercent * 100).toFixed(2)}%)
                            </td>
                            <td className="px-4 py-2">{trade.holdingPeriod} bars</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Equity Curve (simple text representation) */}
              {backtestResult.equityCurve.length > 0 && (
                <div className="mt-4">
                  <h4 className="font-semibold mb-2">Equity Summary</h4>
                  <div className="grid grid-cols-3 gap-4 text-sm">
                    <div>
                      <span className="text-gray-400">Start: </span>
                      ${backtestResult.equityCurve[0]?.toFixed(2)}
                    </div>
                    <div>
                      <span className="text-gray-400">End: </span>
                      ${backtestResult.equityCurve[backtestResult.equityCurve.length - 1]?.toFixed(2)}
                    </div>
                    <div>
                      <span className="text-gray-400">Peak: </span>
                      ${Math.max(...backtestResult.equityCurve).toFixed(2)}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Action Legend */}
        <section className="bg-gray-800 rounded-lg p-6">
          <h2 className="text-xl font-semibold mb-4">Action Reference</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <ActionBadge action={0} label="HOLD" description="Wait and observe" />
            <ActionBadge action={1} label="BUY" description="Enter long position" />
            <ActionBadge action={2} label="SELL" description="Enter short position" />
            <ActionBadge action={3} label="CLOSE" description="Close current position" />
          </div>
        </section>
      </div>
    </div>
  );
}

// Components
function StatusCard({
  label,
  value,
  variant = 'default',
}: {
  label: string;
  value: string;
  variant?: 'default' | 'success' | 'warning' | 'danger';
}) {
  const variantStyles = {
    default: 'text-white',
    success: 'text-green-400',
    warning: 'text-yellow-400',
    danger: 'text-red-400',
  };

  return (
    <div className="bg-gray-700 rounded p-4">
      <p className="text-gray-400 text-sm">{label}</p>
      <p className={`text-2xl font-bold ${variantStyles[variant]}`}>{value}</p>
    </div>
  );
}

function ActionBadge({
  action,
  label,
  description,
}: {
  action: Action;
  label: string;
  description: string;
}) {
  const colors = {
    0: 'bg-gray-600',
    1: 'bg-green-600',
    2: 'bg-red-600',
    3: 'bg-yellow-600',
  };

  return (
    <div className="flex items-center gap-2">
      <span className={`px-2 py-1 rounded text-xs font-bold ${colors[action]}`}>
        {label}
      </span>
      <span className="text-gray-400">{description}</span>
    </div>
  );
}
