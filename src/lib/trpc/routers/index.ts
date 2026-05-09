import { router } from '../init';
import { kbRouter } from './kb';
import { flashcardsRouter } from './flashcards';
import { agentRouter } from './agent';
import { dashboardRouter } from './dashboard';

export const appRouter = router({
  kb: kbRouter,
  flashcards: flashcardsRouter,
  agent: agentRouter,
  dashboard: dashboardRouter,
});

// Export type for client
export type AppRouter = typeof appRouter;
