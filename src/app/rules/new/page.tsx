'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  createEmptyRule,
  createCondition,
  type ICTRule,
  type RuleCondition,
  type ConditionType,
  type ICTConcept,
  type KillZone,
} from '@/lib/rules/types';

const CONDITION_TYPES: { value: ConditionType; label: string }[] = [
  { value: 'htf_bias', label: 'HTF Bias' },
  { value: 'price_in_zone', label: 'Price in Zone' },
  { value: 'concept_present', label: 'ICT Concept Present' },
  { value: 'liquidity_swept', label: 'Liquidity Swept' },
  { value: 'structure_break', label: 'Structure Break' },
  { value: 'time_in_killzone', label: 'In Kill Zone' },
  { value: 'candle_pattern', label: 'Candle Pattern' },
  { value: 'custom', label: 'Custom' },
];

const ICT_CONCEPTS: { value: ICTConcept; label: string }[] = [
  { value: 'fvg', label: 'Fair Value Gap' },
  { value: 'order_block', label: 'Order Block' },
  { value: 'liquidity', label: 'Liquidity' },
  { value: 'bos', label: 'Break of Structure' },
  { value: 'choch', label: 'Change of Character' },
  { value: 'ote', label: 'Optimal Trade Entry' },
  { value: 'premium_discount', label: 'Premium/Discount' },
  { value: 'breaker', label: 'Breaker Block' },
  { value: 'mitigation', label: 'Mitigation' },
];

const KILL_ZONES: { value: KillZone; label: string }[] = [
  { value: 'asian', label: 'Asian Session' },
  { value: 'london_open', label: 'London Open' },
  { value: 'london_close', label: 'London Close' },
  { value: 'ny_am', label: 'NY AM Session' },
  { value: 'ny_lunch', label: 'NY Lunch' },
  { value: 'ny_pm', label: 'NY PM Session' },
  { value: 'silver_bullet', label: 'Silver Bullet (10-11 AM)' },
];

type RuleForm = Omit<ICTRule, 'id' | 'createdAt' | 'updatedAt'>;

export default function NewRulePage() {
  const [rule, setRule] = useState<RuleForm>(createEmptyRule());
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    setIsSaving(true);
    // TODO: Save via tRPC
    console.log('Saving rule:', rule);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    setIsSaving(false);
    // TODO: Navigate to rules list
  };

  const addCondition = (type: ConditionType) => {
    const newCondition = createCondition(type);
    setRule((prev) => ({
      ...prev,
      conditions: [...prev.conditions, newCondition],
    }));
  };

  const removeCondition = (id: string) => {
    setRule((prev) => ({
      ...prev,
      conditions: prev.conditions.filter((c) => c.id !== id),
    }));
  };

  const updateConditionDescription = (id: string, description: string) => {
    setRule((prev) => ({
      ...prev,
      conditions: prev.conditions.map((c) =>
        c.id === id ? { ...c, description } : c
      ),
    }));
  };

  const toggleConcept = (concept: ICTConcept) => {
    setRule((prev) => ({
      ...prev,
      concepts: prev.concepts.includes(concept)
        ? prev.concepts.filter((c) => c !== concept)
        : [...prev.concepts, concept],
    }));
  };

  const toggleKillZone = (kz: KillZone) => {
    setRule((prev) => ({
      ...prev,
      killZones: prev.killZones.includes(kz)
        ? prev.killZones.filter((k) => k !== kz)
        : [...prev.killZones, kz],
    }));
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-3xl px-6 py-8">
        {/* Header */}
        <div className="mb-8">
          <Link
            href="/rules"
            className="mb-2 inline-block text-sm text-zinc-500 hover:text-zinc-300"
          >
            ← Back to Rules
          </Link>
          <h1 className="text-3xl font-bold">New ICT Rule</h1>
          <p className="mt-1 text-zinc-400">
            Define a trading rule from ICT video content
          </p>
        </div>

        <div className="space-y-8">
          {/* Basic Info */}
          <Section title="Basic Information">
            <div className="space-y-4">
              <Field label="Rule Name" required>
                <input
                  type="text"
                  value={rule.name}
                  onChange={(e) =>
                    setRule((prev) => ({ ...prev, name: e.target.value }))
                  }
                  placeholder="e.g., Silver Bullet FVG Entry"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 focus:border-emerald-500 focus:outline-none"
                />
              </Field>

              <Field label="Description">
                <textarea
                  value={rule.description ?? ''}
                  onChange={(e) =>
                    setRule((prev) => ({ ...prev, description: e.target.value }))
                  }
                  placeholder="Describe this rule in your own words..."
                  rows={3}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 focus:border-emerald-500 focus:outline-none"
                />
              </Field>

              <Field label="Direction">
                <div className="flex gap-2">
                  {(['long', 'short', 'both'] as const).map((dir) => (
                    <button
                      key={dir}
                      onClick={() => setRule((prev) => ({ ...prev, direction: dir }))}
                      className={`rounded-lg px-4 py-2 capitalize ${
                        rule.direction === dir
                          ? 'bg-emerald-600 text-white'
                          : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                      }`}
                    >
                      {dir}
                    </button>
                  ))}
                </div>
              </Field>
            </div>
          </Section>

          {/* Source */}
          <Section title="Video Source" description="Track where this rule came from">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Video/Episode">
                <input
                  type="text"
                  value={rule.source ?? ''}
                  onChange={(e) =>
                    setRule((prev) => ({ ...prev, source: e.target.value }))
                  }
                  placeholder="e.g., 2022 Mentorship EP 15"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 focus:border-emerald-500 focus:outline-none"
                />
              </Field>

              <Field label="Timestamp">
                <input
                  type="text"
                  value={rule.sourceTimestamp ?? ''}
                  onChange={(e) =>
                    setRule((prev) => ({ ...prev, sourceTimestamp: e.target.value }))
                  }
                  placeholder="e.g., 24:30"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 focus:border-emerald-500 focus:outline-none"
                />
              </Field>
            </div>

            <Field label="YouTube URL" className="mt-4">
              <input
                type="url"
                value={rule.sourceUrl ?? ''}
                onChange={(e) =>
                  setRule((prev) => ({ ...prev, sourceUrl: e.target.value }))
                }
                placeholder="https://youtube.com/watch?v=..."
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 focus:border-emerald-500 focus:outline-none"
              />
            </Field>
          </Section>

          {/* ICT Concepts */}
          <Section title="ICT Concepts" description="Which concepts does this rule use?">
            <div className="flex flex-wrap gap-2">
              {ICT_CONCEPTS.map((concept) => (
                <button
                  key={concept.value}
                  onClick={() => toggleConcept(concept.value)}
                  className={`rounded-lg px-3 py-1.5 text-sm ${
                    rule.concepts.includes(concept.value)
                      ? 'bg-emerald-600 text-white'
                      : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                  }`}
                >
                  {concept.label}
                </button>
              ))}
            </div>
          </Section>

          {/* Kill Zones */}
          <Section title="Kill Zones" description="When should this rule be active?">
            <div className="flex flex-wrap gap-2">
              {KILL_ZONES.map((kz) => (
                <button
                  key={kz.value}
                  onClick={() => toggleKillZone(kz.value)}
                  className={`rounded-lg px-3 py-1.5 text-sm ${
                    rule.killZones.includes(kz.value)
                      ? 'bg-purple-600 text-white'
                      : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                  }`}
                >
                  {kz.label}
                </button>
              ))}
            </div>
          </Section>

          {/* Conditions */}
          <Section
            title="Conditions"
            description="All conditions must be met for this rule to trigger"
          >
            <div className="space-y-3">
              {rule.conditions.map((condition) => (
                <ConditionCard
                  key={condition.id}
                  condition={condition}
                  onRemove={() => removeCondition(condition.id)}
                  onUpdateDescription={(desc) =>
                    updateConditionDescription(condition.id, desc)
                  }
                />
              ))}

              {rule.conditions.length === 0 && (
                <div className="rounded-lg border border-dashed border-zinc-700 p-6 text-center text-sm text-zinc-500">
                  No conditions yet. Add conditions below.
                </div>
              )}
            </div>

            <div className="mt-4">
              <label className="mb-2 block text-sm text-zinc-400">
                Add Condition:
              </label>
              <div className="flex flex-wrap gap-2">
                {CONDITION_TYPES.map((type) => (
                  <button
                    key={type.value}
                    onClick={() => addCondition(type.value)}
                    className="rounded bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700"
                  >
                    + {type.label}
                  </button>
                ))}
              </div>
            </div>
          </Section>

          {/* Entry Logic */}
          <Section title="Entry Logic" description="How to enter the trade">
            <Field label="Entry Type">
              <select
                value={rule.entryLogic.type}
                onChange={(e) =>
                  setRule((prev) => ({
                    ...prev,
                    entryLogic: {
                      ...prev.entryLogic,
                      type: e.target.value as ICTRule['entryLogic']['type'],
                    },
                  }))
                }
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 focus:border-emerald-500 focus:outline-none"
              >
                <option value="market">Market Order</option>
                <option value="limit_at_fvg">Limit at FVG</option>
                <option value="limit_at_ob">Limit at Order Block</option>
                <option value="limit_at_fib">Limit at Fib Level</option>
                <option value="custom">Custom</option>
              </select>
            </Field>

            <Field label="Entry Description" className="mt-4">
              <textarea
                value={rule.entryLogic.description}
                onChange={(e) =>
                  setRule((prev) => ({
                    ...prev,
                    entryLogic: { ...prev.entryLogic, description: e.target.value },
                  }))
                }
                placeholder="Describe entry in your words from the video..."
                rows={2}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 focus:border-emerald-500 focus:outline-none"
              />
            </Field>
          </Section>

          {/* Exit Logic */}
          <Section title="Exit Logic" description="Stop loss and take profit">
            <div className="grid grid-cols-2 gap-6">
              <div>
                <h4 className="mb-3 font-medium text-zinc-300">Stop Loss</h4>
                <Field label="Type">
                  <select
                    value={rule.exitLogic.stopLoss.type}
                    onChange={(e) =>
                      setRule((prev) => ({
                        ...prev,
                        exitLogic: {
                          ...prev.exitLogic,
                          stopLoss: {
                            ...prev.exitLogic.stopLoss,
                            type: e.target.value as ICTRule['exitLogic']['stopLoss']['type'],
                          },
                        },
                      }))
                    }
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 focus:border-emerald-500 focus:outline-none"
                  >
                    <option value="swing_based">Below/Above Swing</option>
                    <option value="ob_based">Beyond Order Block</option>
                    <option value="fixed_pips">Fixed Pips</option>
                    <option value="atr_based">ATR Based</option>
                    <option value="custom">Custom</option>
                  </select>
                </Field>
              </div>

              <div>
                <h4 className="mb-3 font-medium text-zinc-300">Take Profit</h4>
                <Field label="Type">
                  <select
                    value={rule.exitLogic.takeProfit.type}
                    onChange={(e) =>
                      setRule((prev) => ({
                        ...prev,
                        exitLogic: {
                          ...prev.exitLogic,
                          takeProfit: {
                            ...prev.exitLogic.takeProfit,
                            type: e.target.value as ICTRule['exitLogic']['takeProfit']['type'],
                          },
                        },
                      }))
                    }
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 focus:border-emerald-500 focus:outline-none"
                  >
                    <option value="rr_based">Risk:Reward Ratio</option>
                    <option value="liquidity_target">Liquidity Target</option>
                    <option value="swing_target">Swing Target</option>
                    <option value="fixed_pips">Fixed Pips</option>
                    <option value="custom">Custom</option>
                  </select>
                </Field>

                {rule.exitLogic.takeProfit.type === 'rr_based' && (
                  <Field label="R:R Ratio" className="mt-3">
                    <input
                      type="number"
                      step="0.5"
                      min="1"
                      value={rule.exitLogic.takeProfit.params.riskReward ?? 2}
                      onChange={(e) =>
                        setRule((prev) => ({
                          ...prev,
                          exitLogic: {
                            ...prev.exitLogic,
                            takeProfit: {
                              ...prev.exitLogic.takeProfit,
                              params: {
                                ...prev.exitLogic.takeProfit.params,
                                riskReward: parseFloat(e.target.value),
                              },
                            },
                          },
                        }))
                      }
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 focus:border-emerald-500 focus:outline-none"
                    />
                  </Field>
                )}
              </div>
            </div>
          </Section>

          {/* Notes */}
          <Section title="Notes" description="Additional notes from the video">
            <textarea
              value={rule.notes ?? ''}
              onChange={(e) =>
                setRule((prev) => ({ ...prev, notes: e.target.value }))
              }
              placeholder="Any additional notes, quotes from ICT, or context..."
              rows={4}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 focus:border-emerald-500 focus:outline-none"
            />
          </Section>

          {/* Actions */}
          <div className="flex gap-4 border-t border-zinc-800 pt-6">
            <button
              onClick={handleSave}
              disabled={!rule.name || isSaving}
              className="rounded-lg bg-emerald-600 px-6 py-2 font-medium hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSaving ? 'Saving...' : 'Save Rule'}
            </button>
            <Link
              href="/rules"
              className="rounded-lg bg-zinc-800 px-6 py-2 font-medium hover:bg-zinc-700"
            >
              Cancel
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      {description && (
        <p className="mb-4 text-sm text-zinc-500">{description}</p>
      )}
      {!description && <div className="mb-4" />}
      {children}
    </section>
  );
}

function Field({
  label,
  required,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <label className="mb-1.5 block text-sm text-zinc-400">
        {label}
        {required && <span className="ml-1 text-red-500">*</span>}
      </label>
      {children}
    </div>
  );
}

function ConditionCard({
  condition,
  onRemove,
  onUpdateDescription,
}: {
  condition: RuleCondition;
  onRemove: () => void;
  onUpdateDescription: (desc: string) => void;
}) {
  const typeLabel =
    CONDITION_TYPES.find((t) => t.value === condition.type)?.label ??
    condition.type;

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-800 p-4">
      <div className="flex items-center justify-between">
        <span className="rounded bg-zinc-700 px-2 py-0.5 text-xs">
          {typeLabel}
        </span>
        <button
          onClick={onRemove}
          className="text-zinc-500 hover:text-red-400"
        >
          ✕
        </button>
      </div>
      <input
        type="text"
        value={condition.description}
        onChange={(e) => onUpdateDescription(e.target.value)}
        placeholder="Describe this condition in your words..."
        className="mt-3 w-full rounded border border-zinc-600 bg-zinc-900 px-3 py-1.5 text-sm focus:border-emerald-500 focus:outline-none"
      />
    </div>
  );
}
