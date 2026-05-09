import { router } from '../../init';
import { statsRouter } from './stats';
import { decayRouter } from './decay';
import { candlesRouter } from './candles';
import { biasRouter } from './bias';
import { setupsRouter } from './setups';
import { overlaysRouter } from './overlays';

export const dashboardRouter = router({
  stats: statsRouter,
  decay: decayRouter,
  candles: candlesRouter,
  bias: biasRouter,
  setups: setupsRouter,
  overlays: overlaysRouter,
});
