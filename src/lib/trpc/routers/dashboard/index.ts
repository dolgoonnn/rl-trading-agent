import { router } from '../../init';
import { statsRouter } from './stats';
import { decayRouter } from './decay';
import { candlesRouter } from './candles';
import { biasRouter } from './bias';
import { setupsRouter } from './setups';
import { overlaysRouter } from './overlays';
import { goldContextRouter } from './gold-briefing';
import { liveStatsRouter } from './live-stats';
import { queueRouter } from './queue';

export const dashboardRouter = router({
  stats: statsRouter,
  decay: decayRouter,
  candles: candlesRouter,
  bias: biasRouter,
  setups: setupsRouter,
  overlays: overlaysRouter,
  goldContext: goldContextRouter,
  liveStats: liveStatsRouter,
  queue: queueRouter,
});
