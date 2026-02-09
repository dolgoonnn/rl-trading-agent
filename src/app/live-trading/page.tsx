'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

interface Position {
  side: 'long' | 'short';
  entryPrice: number;
  size: number;
  unrealizedPnL: number;
  stopLoss: number;
  takeProfit: number;
  strategy: string;
  entryTime: string;
  barsHeld: number;
}

interface Trade {
  id: number;
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pnlPercent: number;
  strategy: string;
  exitTime: string;
  holdingPeriod: number;
}

interface RiskState {
  dailyPnL: number;
  drawdown: number;
  consecutiveLosses: number;
  tradingAllowed: boolean;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  warnings: string[];
}

interface Metrics {
  totalTrades: number;
  winRate: number;
  totalPnL: number;
  sharpe: number;
  avgRiskReward: number;
  maxDrawdown: number;
}

interface TradingState {
  connected: boolean;
  symbol: string;
  currentPrice: number;
  position: Position | null;
  recentTrades: Trade[];
  metrics: Metrics;
  riskState: RiskState;
  lastUpdate: string;
  modelLoaded: boolean;
  modelInfo: {
    path: string;
    symbols: string[];
    sharpe: number;
  } | null;
}

const initialState: TradingState = {
  connected: false,
  symbol: 'BTCUSDT',
  currentPrice: 0,
  position: null,
  recentTrades: [],
  metrics: {
    totalTrades: 0,
    winRate: 0,
    totalPnL: 0,
    sharpe: 0,
    avgRiskReward: 0,
    maxDrawdown: 0,
  },
  riskState: {
    dailyPnL: 0,
    drawdown: 0,
    consecutiveLosses: 0,
    tradingAllowed: true,
    riskLevel: 'low',
    warnings: [],
  },
  lastUpdate: '',
  modelLoaded: false,
  modelInfo: null,
};

export default function LiveTradingDashboard() {
  const [state, setState] = useState<TradingState>(initialState);
  const [isEmergencyStop, setIsEmergencyStop] = useState(false);
  const [selectedSymbol, setSelectedSymbol] = useState('BTCUSDT');
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Connect to WebSocket
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    // In production, this would connect to your paper trading backend
    // For now, we simulate with a local endpoint
    const wsUrl = `ws://localhost:3001/ws/trading?symbol=${selectedSymbol}`;

    try {
      wsRef.current = new WebSocket(wsUrl);

      wsRef.current.onopen = () => {
        setState((s) => ({ ...s, connected: true, symbol: selectedSymbol }));
        console.log('WebSocket connected');
      };

      wsRef.current.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as Partial<TradingState>;
          setState((s) => ({
            ...s,
            ...data,
            lastUpdate: new Date().toISOString(),
          }));
        } catch (e) {
          console.error('Failed to parse WS message:', e);
        }
      };

      wsRef.current.onclose = () => {
        setState((s) => ({ ...s, connected: false }));
        console.log('WebSocket disconnected');

        // Attempt reconnect after 5 seconds
        if (!isEmergencyStop) {
          reconnectTimeoutRef.current = setTimeout(connect, 5000);
        }
      };

      wsRef.current.onerror = (error) => {
        console.error('WebSocket error:', error);
      };
    } catch (error) {
      console.error('Failed to connect:', error);
    }
  }, [selectedSymbol, isEmergencyStop]);

  // Disconnect
  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  // Emergency stop
  const handleEmergencyStop = useCallback(() => {
    setIsEmergencyStop(true);
    disconnect();

    // Send stop command to backend
    fetch('/api/trading/emergency-stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: state.symbol }),
    }).catch(console.error);

    setState((s) => ({
      ...s,
      connected: false,
      riskState: {
        ...s.riskState,
        tradingAllowed: false,
        riskLevel: 'critical',
        warnings: ['Emergency stop activated'],
      },
    }));
  }, [disconnect, state.symbol]);

  // Resume trading
  const handleResume = useCallback(() => {
    setIsEmergencyStop(false);
    setState((s) => ({
      ...s,
      riskState: {
        ...s.riskState,
        tradingAllowed: true,
        riskLevel: 'low',
        warnings: [],
      },
    }));
    connect();
  }, [connect]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  // Simulated data for demo (remove in production)
  useEffect(() => {
    const interval = setInterval(() => {
      setState((s) => ({
        ...s,
        currentPrice: 42000 + Math.random() * 1000,
        lastUpdate: new Date().toISOString(),
        position: s.position
          ? {
              ...s.position,
              unrealizedPnL: (Math.random() - 0.5) * 100,
              barsHeld: s.position.barsHeld + 1,
            }
          : null,
      }));
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center md:justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold">Live Paper Trading</h1>
            <p className="text-gray-400">ICT Ensemble Strategy</p>
          </div>

          <div className="flex items-center gap-4 mt-4 md:mt-0">
            {/* Connection Status */}
            <div className="flex items-center gap-2">
              <div
                className={`w-3 h-3 rounded-full ${
                  state.connected ? 'bg-green-500 animate-pulse' : 'bg-red-500'
                }`}
              />
              <span className={state.connected ? 'text-green-400' : 'text-red-400'}>
                {state.connected ? 'Connected' : 'Disconnected'}
              </span>
            </div>

            {/* Symbol Selector */}
            <select
              value={selectedSymbol}
              onChange={(e) => setSelectedSymbol(e.target.value)}
              className="bg-gray-700 rounded px-3 py-2"
              disabled={state.connected}
            >
              <option value="BTCUSDT">BTC/USDT</option>
              <option value="ETHUSDT">ETH/USDT</option>
              <option value="SOLUSDT">SOL/USDT</option>
            </select>

            {/* Connect/Disconnect */}
            {!state.connected ? (
              <button
                onClick={connect}
                disabled={isEmergencyStop}
                className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 rounded font-semibold"
              >
                Connect
              </button>
            ) : (
              <button
                onClick={disconnect}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-700 rounded"
              >
                Disconnect
              </button>
            )}
          </div>
        </header>

        {/* Emergency Stop Banner */}
        {isEmergencyStop && (
          <div className="bg-red-900 border border-red-600 rounded-lg p-4 mb-6 flex items-center justify-between">
            <div>
              <h2 className="text-xl font-bold text-red-300">EMERGENCY STOP ACTIVE</h2>
              <p className="text-red-400">All trading has been halted. Review your positions.</p>
            </div>
            <button
              onClick={handleResume}
              className="px-4 py-2 bg-yellow-600 hover:bg-yellow-700 rounded font-semibold"
            >
              Resume Trading
            </button>
          </div>
        )}

        {/* Main Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column - Position & Price */}
          <div className="lg:col-span-2 space-y-6">
            {/* Current Price */}
            <div className="bg-gray-800 rounded-lg p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-gray-400">{state.symbol}</p>
                  <p className="text-4xl font-bold font-mono">
                    ${state.currentPrice.toFixed(2)}
                  </p>
                </div>
                <div className="text-right text-sm text-gray-400">
                  <p>Last Update</p>
                  <p>{state.lastUpdate ? new Date(state.lastUpdate).toLocaleTimeString() : '--'}</p>
                </div>
              </div>
            </div>

            {/* Current Position */}
            <div className="bg-gray-800 rounded-lg p-6">
              <h2 className="text-xl font-semibold mb-4">Current Position</h2>

              {state.position ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span
                      className={`px-3 py-1 rounded font-bold ${
                        state.position.side === 'long'
                          ? 'bg-green-600 text-green-100'
                          : 'bg-red-600 text-red-100'
                      }`}
                    >
                      {state.position.side.toUpperCase()}
                    </span>
                    <span className="text-gray-400">via {state.position.strategy}</span>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <MetricCard label="Entry Price" value={`$${state.position.entryPrice.toFixed(2)}`} />
                    <MetricCard label="Size" value={state.position.size.toFixed(4)} />
                    <MetricCard label="Stop Loss" value={`$${state.position.stopLoss.toFixed(2)}`} variant="danger" />
                    <MetricCard label="Take Profit" value={`$${state.position.takeProfit.toFixed(2)}`} variant="success" />
                  </div>

                  <div className="flex items-center justify-between bg-gray-700 rounded p-4">
                    <div>
                      <p className="text-gray-400 text-sm">Unrealized P&L</p>
                      <p
                        className={`text-2xl font-bold ${
                          state.position.unrealizedPnL >= 0 ? 'text-green-400' : 'text-red-400'
                        }`}
                      >
                        {state.position.unrealizedPnL >= 0 ? '+' : ''}
                        ${state.position.unrealizedPnL.toFixed(2)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-gray-400 text-sm">Bars Held</p>
                      <p className="text-2xl font-bold">{state.position.barsHeld}</p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-center py-8 text-gray-400">
                  <p className="text-lg">No open position</p>
                  <p className="text-sm">Waiting for signal...</p>
                </div>
              )}
            </div>

            {/* Recent Trades */}
            <div className="bg-gray-800 rounded-lg p-6">
              <h2 className="text-xl font-semibold mb-4">Recent Trades</h2>

              {state.recentTrades.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-700">
                      <tr>
                        <th className="px-4 py-2 text-left">Side</th>
                        <th className="px-4 py-2 text-left">Strategy</th>
                        <th className="px-4 py-2 text-right">Entry</th>
                        <th className="px-4 py-2 text-right">Exit</th>
                        <th className="px-4 py-2 text-right">P&L</th>
                        <th className="px-4 py-2 text-right">%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.recentTrades.slice(0, 10).map((trade) => (
                        <tr key={trade.id} className="border-t border-gray-700">
                          <td className="px-4 py-2">
                            <span
                              className={
                                trade.side === 'long' ? 'text-green-400' : 'text-red-400'
                              }
                            >
                              {trade.side.toUpperCase()}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-gray-400">{trade.strategy}</td>
                          <td className="px-4 py-2 text-right font-mono">
                            ${trade.entryPrice.toFixed(2)}
                          </td>
                          <td className="px-4 py-2 text-right font-mono">
                            ${trade.exitPrice.toFixed(2)}
                          </td>
                          <td
                            className={`px-4 py-2 text-right font-mono ${
                              trade.pnl >= 0 ? 'text-green-400' : 'text-red-400'
                            }`}
                          >
                            {trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}
                          </td>
                          <td
                            className={`px-4 py-2 text-right ${
                              trade.pnlPercent >= 0 ? 'text-green-400' : 'text-red-400'
                            }`}
                          >
                            {trade.pnlPercent >= 0 ? '+' : ''}
                            {(trade.pnlPercent * 100).toFixed(2)}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-center py-4 text-gray-400">No trades yet</p>
              )}
            </div>
          </div>

          {/* Right Column - Metrics & Risk */}
          <div className="space-y-6">
            {/* Emergency Stop Button */}
            <button
              onClick={handleEmergencyStop}
              disabled={isEmergencyStop || !state.connected}
              className="w-full py-4 bg-red-600 hover:bg-red-700 disabled:bg-gray-700 rounded-lg font-bold text-xl transition-colors"
            >
              🛑 EMERGENCY STOP
            </button>

            {/* Performance Metrics */}
            <div className="bg-gray-800 rounded-lg p-6">
              <h2 className="text-xl font-semibold mb-4">Performance</h2>

              <div className="space-y-4">
                <MetricRow
                  label="Total P&L"
                  value={`$${state.metrics.totalPnL.toFixed(2)}`}
                  variant={state.metrics.totalPnL >= 0 ? 'success' : 'danger'}
                />
                <MetricRow
                  label="Total Trades"
                  value={state.metrics.totalTrades.toString()}
                />
                <MetricRow
                  label="Win Rate"
                  value={`${state.metrics.winRate.toFixed(1)}%`}
                  variant={state.metrics.winRate >= 50 ? 'success' : 'warning'}
                />
                <MetricRow
                  label="Sharpe Ratio"
                  value={state.metrics.sharpe.toFixed(3)}
                  variant={state.metrics.sharpe >= 1 ? 'success' : 'default'}
                />
                <MetricRow
                  label="Avg R:R"
                  value={state.metrics.avgRiskReward.toFixed(2)}
                  variant={state.metrics.avgRiskReward >= 1 ? 'success' : 'warning'}
                />
                <MetricRow
                  label="Max Drawdown"
                  value={`${(state.metrics.maxDrawdown * 100).toFixed(1)}%`}
                  variant={state.metrics.maxDrawdown <= 0.05 ? 'success' : 'danger'}
                />
              </div>
            </div>

            {/* Risk Status */}
            <div className="bg-gray-800 rounded-lg p-6">
              <h2 className="text-xl font-semibold mb-4">Risk Status</h2>

              <div className="space-y-4">
                {/* Risk Level Indicator */}
                <div className="flex items-center justify-between">
                  <span className="text-gray-400">Risk Level</span>
                  <RiskBadge level={state.riskState.riskLevel} />
                </div>

                <MetricRow
                  label="Daily P&L"
                  value={`$${state.riskState.dailyPnL.toFixed(2)}`}
                  variant={state.riskState.dailyPnL >= 0 ? 'success' : 'danger'}
                />
                <MetricRow
                  label="Drawdown"
                  value={`${(state.riskState.drawdown * 100).toFixed(2)}%`}
                  variant={state.riskState.drawdown <= 0.03 ? 'success' : 'danger'}
                />
                <MetricRow
                  label="Consec. Losses"
                  value={state.riskState.consecutiveLosses.toString()}
                  variant={state.riskState.consecutiveLosses >= 3 ? 'danger' : 'default'}
                />

                {/* Trading Status */}
                <div className="pt-4 border-t border-gray-700">
                  <div className="flex items-center justify-between">
                    <span className="text-gray-400">Trading Status</span>
                    <span
                      className={`px-2 py-1 rounded text-sm font-semibold ${
                        state.riskState.tradingAllowed
                          ? 'bg-green-600 text-green-100'
                          : 'bg-red-600 text-red-100'
                      }`}
                    >
                      {state.riskState.tradingAllowed ? 'ACTIVE' : 'HALTED'}
                    </span>
                  </div>
                </div>

                {/* Warnings */}
                {state.riskState.warnings.length > 0 && (
                  <div className="mt-4 p-3 bg-yellow-900/50 border border-yellow-600 rounded">
                    <p className="text-yellow-400 font-semibold text-sm mb-2">Warnings:</p>
                    <ul className="text-yellow-300 text-sm space-y-1">
                      {state.riskState.warnings.map((w, i) => (
                        <li key={i}>• {w}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>

            {/* Model Info */}
            {state.modelInfo && (
              <div className="bg-gray-800 rounded-lg p-6">
                <h2 className="text-xl font-semibold mb-4">Model</h2>
                <div className="space-y-2 text-sm">
                  <p className="text-gray-400">
                    Path: <span className="text-white">{state.modelInfo.path}</span>
                  </p>
                  <p className="text-gray-400">
                    Symbols: <span className="text-white">{state.modelInfo.symbols.join(', ')}</span>
                  </p>
                  <p className="text-gray-400">
                    Val Sharpe: <span className="text-green-400">{state.modelInfo.sharpe.toFixed(3)}</span>
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <footer className="mt-8 text-center text-gray-500 text-sm">
          <p>Paper Trading Mode - No real money at risk</p>
          <p className="mt-1">
            Last Update: {state.lastUpdate ? new Date(state.lastUpdate).toLocaleString() : '--'}
          </p>
        </footer>
      </div>
    </div>
  );
}

// Helper Components
function MetricCard({
  label,
  value,
  variant = 'default',
}: {
  label: string;
  value: string;
  variant?: 'default' | 'success' | 'warning' | 'danger';
}) {
  const variants = {
    default: 'text-white',
    success: 'text-green-400',
    warning: 'text-yellow-400',
    danger: 'text-red-400',
  };

  return (
    <div className="bg-gray-700 rounded p-3">
      <p className="text-gray-400 text-xs">{label}</p>
      <p className={`text-lg font-bold font-mono ${variants[variant]}`}>{value}</p>
    </div>
  );
}

function MetricRow({
  label,
  value,
  variant = 'default',
}: {
  label: string;
  value: string;
  variant?: 'default' | 'success' | 'warning' | 'danger';
}) {
  const variants = {
    default: 'text-white',
    success: 'text-green-400',
    warning: 'text-yellow-400',
    danger: 'text-red-400',
  };

  return (
    <div className="flex items-center justify-between">
      <span className="text-gray-400">{label}</span>
      <span className={`font-mono font-semibold ${variants[variant]}`}>{value}</span>
    </div>
  );
}

function RiskBadge({ level }: { level: 'low' | 'medium' | 'high' | 'critical' }) {
  const styles = {
    low: 'bg-green-600 text-green-100',
    medium: 'bg-yellow-600 text-yellow-100',
    high: 'bg-orange-600 text-orange-100',
    critical: 'bg-red-600 text-red-100',
  };

  return (
    <span className={`px-2 py-1 rounded text-sm font-semibold ${styles[level]}`}>
      {level.toUpperCase()}
    </span>
  );
}
