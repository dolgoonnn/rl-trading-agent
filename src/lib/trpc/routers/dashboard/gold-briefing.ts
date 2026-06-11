import { z } from 'zod';
import { router, publicProcedure } from '../../init';
import { resolveGoldContext } from '@/lib/gold-workflow/briefing-resolver';
import { isGoldSymbol } from '@/lib/gold-workflow/types';

export const goldContextRouter = router({
  get: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(({ input }) => {
      if (!isGoldSymbol(input.symbol)) {
        return { applicable: false as const };
      }
      return { applicable: true as const, context: resolveGoldContext(input.symbol) };
    }),
});
