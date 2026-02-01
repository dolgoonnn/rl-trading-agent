#!/usr/bin/env npx tsx
/**
 * Train Classifier
 * Trains a simple neural network classifier on the exported ML dataset
 *
 * This is a supervised learning approach that:
 * 1. Predicts BUY/SELL/HOLD based on the 96-feature ICT state vector
 * 2. Uses future price movement as labels (from export-ml-dataset.ts)
 * 3. Is much more sample-efficient than deep RL
 *
 * Usage:
 *   npx tsx scripts/train-classifier.ts --epochs 100
 *   npx tsx scripts/train-classifier.ts --epochs 50 --batch-size 64
 */

import fs from 'fs';
import path from 'path';
import * as tf from '@tensorflow/tfjs-node';

interface DataPoint {
  features: number[];
  label: number;
  futureReturn: number;
  symbol: string;
  timestamp: number;
}

interface MLDataset {
  trainData: DataPoint[];
  valData: DataPoint[];
  metadata: {
    featureSize: number;
    trainSamples: number;
    valSamples: number;
    symbols: string[];
    labelDistribution: { hold: number; buy: number; sell: number };
    exportedAt: string;
  };
}

interface TrainingConfig {
  epochs: number;
  batchSize: number;
  learningRate: number;
  dropout: number;
  hiddenLayers: number[];
  classWeights: { [key: number]: number };
}

function loadDataset(datasetPath: string): MLDataset {
  if (!fs.existsSync(datasetPath)) {
    throw new Error(`Dataset not found: ${datasetPath}\nRun: npx tsx scripts/export-ml-dataset.ts --all`);
  }
  return JSON.parse(fs.readFileSync(datasetPath, 'utf-8')) as MLDataset;
}

function prepareData(data: DataPoint[]): { features: tf.Tensor2D; labels: tf.Tensor2D } {
  const featureArray = data.map(d => d.features);
  const labelArray = data.map(d => {
    // One-hot encode labels
    const oneHot = [0, 0, 0];
    oneHot[d.label] = 1;
    return oneHot;
  });

  return {
    features: tf.tensor2d(featureArray),
    labels: tf.tensor2d(labelArray),
  };
}

function createModel(
  inputSize: number,
  hiddenLayers: number[],
  dropout: number
): tf.LayersModel {
  const model = tf.sequential();

  // Input layer
  model.add(tf.layers.dense({
    units: hiddenLayers[0]!,
    activation: 'relu',
    inputShape: [inputSize],
    kernelRegularizer: tf.regularizers.l2({ l2: 0.01 }),
  }));
  model.add(tf.layers.batchNormalization());
  model.add(tf.layers.dropout({ rate: dropout }));

  // Hidden layers
  for (let i = 1; i < hiddenLayers.length; i++) {
    model.add(tf.layers.dense({
      units: hiddenLayers[i]!,
      activation: 'relu',
      kernelRegularizer: tf.regularizers.l2({ l2: 0.01 }),
    }));
    model.add(tf.layers.batchNormalization());
    model.add(tf.layers.dropout({ rate: dropout }));
  }

  // Output layer (3 classes: HOLD, BUY, SELL)
  model.add(tf.layers.dense({
    units: 3,
    activation: 'softmax',
  }));

  return model;
}

function calculateClassWeights(
  distribution: { hold: number; buy: number; sell: number }
): { [key: number]: number } {
  const total = distribution.hold + distribution.buy + distribution.sell;
  const numClasses = 3;

  // Inverse frequency weighting
  return {
    0: total / (numClasses * distribution.hold),
    1: total / (numClasses * distribution.buy),
    2: total / (numClasses * distribution.sell),
  };
}

async function evaluateModel(
  model: tf.LayersModel,
  valFeatures: tf.Tensor2D,
  valLabels: tf.Tensor2D,
  valData: DataPoint[]
): Promise<{
  accuracy: number;
  perClassAccuracy: { hold: number; buy: number; sell: number };
  confusionMatrix: number[][];
  winRateIfFollowed: number;
  avgReturnIfFollowed: number;
}> {
  // Get predictions
  const predictions = model.predict(valFeatures) as tf.Tensor2D;
  const predClasses = predictions.argMax(1).dataSync();
  const trueClasses = valLabels.argMax(1).dataSync();

  // Calculate confusion matrix
  const confusionMatrix = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let correct = 0;
  const classCorrect = [0, 0, 0];
  const classTotal = [0, 0, 0];

  for (let i = 0; i < predClasses.length; i++) {
    const pred = predClasses[i]!;
    const actual = trueClasses[i]!;
    confusionMatrix[actual]![pred]!++;
    classTotal[actual]!++;
    if (pred === actual) {
      correct++;
      classCorrect[actual]!++;
    }
  }

  // Calculate win rate if we followed the model's BUY/SELL signals
  let trades = 0;
  let wins = 0;
  let totalReturn = 0;

  for (let i = 0; i < predClasses.length; i++) {
    const pred = predClasses[i]!;
    if (pred === 1 || pred === 2) { // BUY or SELL
      trades++;
      const futureReturn = valData[i]!.futureReturn;
      // BUY is correct if return > 0, SELL is correct if return < 0
      const expectedDirection = pred === 1 ? 1 : -1;
      const actualDirection = futureReturn > 0 ? 1 : futureReturn < 0 ? -1 : 0;

      if (expectedDirection === actualDirection) {
        wins++;
      }
      totalReturn += expectedDirection * futureReturn;
    }
  }

  predictions.dispose();

  return {
    accuracy: correct / predClasses.length,
    perClassAccuracy: {
      hold: classTotal[0]! > 0 ? classCorrect[0]! / classTotal[0]! : 0,
      buy: classTotal[1]! > 0 ? classCorrect[1]! / classTotal[1]! : 0,
      sell: classTotal[2]! > 0 ? classCorrect[2]! / classTotal[2]! : 0,
    },
    confusionMatrix,
    winRateIfFollowed: trades > 0 ? wins / trades : 0,
    avgReturnIfFollowed: trades > 0 ? totalReturn / trades : 0,
  };
}

async function trainClassifier(
  config: TrainingConfig,
  datasetPath: string,
  outputPath: string
): Promise<void> {
  console.log(`\n${'='.repeat(60)}`);
  console.log('ICT Classifier Training');
  console.log(`${'='.repeat(60)}\n`);

  // Load dataset
  console.log('Loading dataset...');
  const dataset = loadDataset(datasetPath);
  console.log(`  Train samples: ${dataset.trainData.length}`);
  console.log(`  Validation samples: ${dataset.valData.length}`);
  console.log(`  Feature size: ${dataset.metadata.featureSize}`);
  console.log(`  Label distribution: HOLD=${dataset.metadata.labelDistribution.hold}, BUY=${dataset.metadata.labelDistribution.buy}, SELL=${dataset.metadata.labelDistribution.sell}`);

  // Prepare tensors
  console.log('\nPreparing tensors...');
  const { features: trainFeatures, labels: trainLabels } = prepareData(dataset.trainData);
  const { features: valFeatures, labels: valLabels } = prepareData(dataset.valData);

  // Create model
  console.log('\nCreating model...');
  const model = createModel(
    dataset.metadata.featureSize,
    config.hiddenLayers,
    config.dropout
  );

  model.compile({
    optimizer: tf.train.adam(config.learningRate),
    loss: 'categoricalCrossentropy',
    metrics: ['accuracy'],
  });

  model.summary();

  // Calculate class weights for imbalanced data
  const classWeights = calculateClassWeights(dataset.metadata.labelDistribution);
  console.log(`\nClass weights: HOLD=${(classWeights[0] ?? 1).toFixed(2)}, BUY=${(classWeights[1] ?? 1).toFixed(2)}, SELL=${(classWeights[2] ?? 1).toFixed(2)}`);

  // Training
  console.log('\nStarting training...\n');
  const startTime = Date.now();

  let bestValAccuracy = 0;
  let bestWinRate = 0;

  await model.fit(trainFeatures, trainLabels, {
    epochs: config.epochs,
    batchSize: config.batchSize,
    validationData: [valFeatures, valLabels],
    classWeight: classWeights,
    callbacks: {
      onEpochEnd: async (epoch, logs) => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

        // Evaluate on validation set
        const evalResult = await evaluateModel(model, valFeatures, valLabels, dataset.valData);

        if (evalResult.accuracy > bestValAccuracy) {
          bestValAccuracy = evalResult.accuracy;
        }
        if (evalResult.winRateIfFollowed > bestWinRate) {
          bestWinRate = evalResult.winRateIfFollowed;
        }

        const trainAcc = ((logs?.['acc'] ?? 0) * 100).toFixed(1);
        const valAcc = (evalResult.accuracy * 100).toFixed(1);
        const winRate = (evalResult.winRateIfFollowed * 100).toFixed(1);
        const avgReturn = (evalResult.avgReturnIfFollowed * 100).toFixed(3);

        console.log(
          `Epoch ${String(epoch + 1).padStart(3)} | ` +
          `TrainAcc: ${trainAcc}% | ` +
          `ValAcc: ${valAcc}% | ` +
          `WinRate: ${winRate}% | ` +
          `AvgRet: ${avgReturn}% | ` +
          `${elapsed}s`
        );
      },
    },
  });

  // Final evaluation
  console.log('\n' + '='.repeat(60));
  console.log('Final Evaluation');
  console.log('='.repeat(60));

  const finalEval = await evaluateModel(model, valFeatures, valLabels, dataset.valData);

  console.log(`\nOverall Accuracy: ${(finalEval.accuracy * 100).toFixed(1)}%`);
  console.log('\nPer-class Accuracy:');
  console.log(`  HOLD: ${(finalEval.perClassAccuracy.hold * 100).toFixed(1)}%`);
  console.log(`  BUY:  ${(finalEval.perClassAccuracy.buy * 100).toFixed(1)}%`);
  console.log(`  SELL: ${(finalEval.perClassAccuracy.sell * 100).toFixed(1)}%`);

  console.log('\nConfusion Matrix:');
  console.log('              Pred HOLD  Pred BUY  Pred SELL');
  const cm = finalEval.confusionMatrix;
  console.log(`  True HOLD   ${String(cm[0]?.[0] ?? 0).padStart(8)}  ${String(cm[0]?.[1] ?? 0).padStart(8)}  ${String(cm[0]?.[2] ?? 0).padStart(9)}`);
  console.log(`  True BUY    ${String(cm[1]?.[0] ?? 0).padStart(8)}  ${String(cm[1]?.[1] ?? 0).padStart(8)}  ${String(cm[1]?.[2] ?? 0).padStart(9)}`);
  console.log(`  True SELL   ${String(cm[2]?.[0] ?? 0).padStart(8)}  ${String(cm[2]?.[1] ?? 0).padStart(8)}  ${String(cm[2]?.[2] ?? 0).padStart(9)}`);

  console.log('\nTrading Simulation (following BUY/SELL signals):');
  console.log(`  Win Rate: ${(finalEval.winRateIfFollowed * 100).toFixed(1)}%`);
  console.log(`  Avg Return per Trade: ${(finalEval.avgReturnIfFollowed * 100).toFixed(3)}%`);

  // Success criteria check
  console.log('\n' + '-'.repeat(60));
  console.log('Success Criteria Check:');
  const checks = [
    { name: 'Validation Win Rate > 55%', pass: finalEval.winRateIfFollowed > 0.55, value: `${(finalEval.winRateIfFollowed * 100).toFixed(1)}%` },
    { name: 'Avg Return > 0.2%', pass: finalEval.avgReturnIfFollowed > 0.002, value: `${(finalEval.avgReturnIfFollowed * 100).toFixed(3)}%` },
    { name: 'Accuracy > 40%', pass: finalEval.accuracy > 0.40, value: `${(finalEval.accuracy * 100).toFixed(1)}%` },
  ];

  for (const check of checks) {
    console.log(`  ${check.pass ? '✓' : '✗'} ${check.name}: ${check.value}`);
  }

  const passedCount = checks.filter(c => c.pass).length;
  console.log(`\nPassed: ${passedCount}/${checks.length}`);

  // Save model
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  await model.save(`file://${outputPath}`);
  console.log(`\nModel saved to: ${outputPath}`);

  // Cleanup
  trainFeatures.dispose();
  trainLabels.dispose();
  valFeatures.dispose();
  valLabels.dispose();
  model.dispose();

  console.log('\nDone!');
}

// CLI
function parseArgs(): { epochs: number; batchSize: number; learningRate: number; dropout: number; dataset: string; output: string } {
  const args = process.argv.slice(2);
  const options: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg?.startsWith('--')) {
      const key = arg.replace(/^--/, '');
      const value = args[i + 1];
      if (value && !value.startsWith('--')) {
        options[key] = value;
        i++;
      }
    }
  }

  return {
    epochs: parseInt(options['epochs'] || '50', 10),
    batchSize: parseInt(options['batch-size'] || '128', 10),
    learningRate: parseFloat(options['learning-rate'] || '0.001'),
    dropout: parseFloat(options['dropout'] || '0.3'),
    dataset: options['dataset'] || './data/ml_dataset.json',
    output: options['output'] || './models/classifier',
  };
}

async function main() {
  const args = parseArgs();

  const config: TrainingConfig = {
    epochs: args.epochs,
    batchSize: args.batchSize,
    learningRate: args.learningRate,
    dropout: args.dropout,
    hiddenLayers: [256, 128, 64],
    classWeights: {}, // Will be calculated from data
  };

  console.log('Training configuration:');
  console.log(`  Epochs: ${config.epochs}`);
  console.log(`  Batch size: ${config.batchSize}`);
  console.log(`  Learning rate: ${config.learningRate}`);
  console.log(`  Dropout: ${config.dropout}`);
  console.log(`  Hidden layers: [${config.hiddenLayers.join(', ')}]`);

  try {
    await trainClassifier(config, args.dataset, args.output);
  } catch (error) {
    console.error('\nTraining error:', error);
    process.exit(1);
  }
}

main();
