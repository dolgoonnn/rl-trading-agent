#!/usr/bin/env npx tsx
/**
 * Quick diagnostic: show PPO model's deterministic actions per regime
 */
import { ContinuousPPOAgent } from '../src/lib/rl/agent/continuous-ppo-agent';
import { STATE_SIZE, COMPACT_ACTION_SIZE, WEIGHT_NAMES } from '../src/lib/rl/environment/weight-optimizer-env';
import fs from 'fs';

const modelPath = process.argv[2] || 'models/weight_optimizer_best.json';

async function main(): Promise<void> {
  const agent = new ContinuousPPOAgent({
    inputSize: STATE_SIZE,
    actionSize: COMPACT_ACTION_SIZE,
    hiddenLayers: [32, 16],
  });

  const model = JSON.parse(fs.readFileSync(modelPath, 'utf-8'));
  await agent.loadWeights(model);

  const regimes = [
    { name: 'uptrend+high',    features: [1, 1, 0.8, 0.7, 0.8, 1, 0, 0, 0, 0, 0, 0, 0, 0] },
    { name: 'uptrend+normal',  features: [1, 0.5, 0.5, 0.5, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { name: 'uptrend+low',     features: [1, 0, 0.3, 0.3, 0.2, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { name: 'downtrend+high',  features: [-1, 1, 0.8, 0.3, 0.8, 1, 0, 0, 0, 0, 0, 0, 0, 0] },
    { name: 'downtrend+normal',features: [-1, 0.5, 0.5, 0.3, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { name: 'ranging+normal',  features: [0, 0.5, 0.2, 0.3, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { name: 'ranging+high',    features: [0, 1, 0.2, 0.1, 0.8, 1, 0, 0, 0, 0, 0, 0, 0, 0] },
    { name: 'neutral',         features: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  ];

  const scale = 0.7;
  const STRUCT = ['structureAlignment', 'recentBOS', 'killZoneActive'];
  const PROX = ['obProximity', 'fvgAtCE', 'oteZone', 'breakerConfluence', 'obFvgConfluence'];

  console.log(`Model: ${modelPath}`);
  console.log(`Params: ${agent.getParamCount().total}`);
  console.log('');
  console.log('Regime'.padEnd(22) + '| global  struct  prox   | Per-weight multipliers');
  console.log('-'.repeat(100));

  for (const r of regimes) {
    const action = agent.selectAction(r.features, false);
    const gM = Math.exp(action[0]! * scale);
    const sM = Math.exp(action[1]! * scale * 0.5);
    const pM = Math.exp(action[2]! * scale * 0.5);

    const weightMults: string[] = [];
    for (const name of WEIGHT_NAMES) {
      let mult = gM;
      if (STRUCT.includes(name)) mult *= sM;
      else if (PROX.includes(name)) mult *= pM;
      weightMults.push(`${name.slice(0, 8)}=${mult.toFixed(2)}`);
    }

    console.log(
      `${r.name.padEnd(22)}| ${gM.toFixed(3).padStart(6)} ${sM.toFixed(3).padStart(6)} ${pM.toFixed(3).padStart(6)} | ${weightMults.join(' ')}`
    );
  }

  agent.dispose();
}

main().catch(console.error);
