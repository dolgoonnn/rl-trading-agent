export default function Home() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <main className="mx-auto max-w-4xl px-6 py-16">
        <header className="mb-16">
          <h1 className="text-4xl font-bold tracking-tight">ICT Trading</h1>
          <p className="mt-2 text-lg text-zinc-400">
            Inner Circle Trader concepts, visualized and automated
          </p>
        </header>

        <section className="grid gap-6 md:grid-cols-2">
          <Card
            title="Market Structure"
            description="Swing highs/lows, BOS, CHoCH detection"
            status="ready"
          />
          <Card
            title="Order Blocks"
            description="Institutional supply and demand zones"
            status="ready"
          />
          <Card
            title="Fair Value Gaps"
            description="Price imbalances and fill tracking"
            status="ready"
          />
          <Card
            title="Liquidity"
            description="Equal highs/lows and sweep detection"
            status="planned"
          />
          <Card
            title="Kill Zones"
            description="Session timing and optimal entry windows"
            status="planned"
          />
          <Card
            title="Trading Journal"
            description="Track trades and analyze performance"
            status="planned"
          />
        </section>

        <section className="mt-16 rounded-lg border border-zinc-800 bg-zinc-900 p-6">
          <h2 className="text-xl font-semibold">Getting Started</h2>
          <div className="mt-4 space-y-3 text-sm text-zinc-400">
            <p>
              <code className="rounded bg-zinc-800 px-2 py-1 text-zinc-300">
                pnpm dev
              </code>{' '}
              - Start development server
            </p>
            <p>
              <code className="rounded bg-zinc-800 px-2 py-1 text-zinc-300">
                pnpm db:push
              </code>{' '}
              - Initialize database schema
            </p>
            <p>
              <code className="rounded bg-zinc-800 px-2 py-1 text-zinc-300">
                pnpm db:studio
              </code>{' '}
              - Open database GUI
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}

function Card({
  title,
  description,
  status,
}: {
  title: string;
  description: string;
  status: 'ready' | 'planned';
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{title}</h3>
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${
            status === 'ready'
              ? 'bg-emerald-900 text-emerald-300'
              : 'bg-zinc-800 text-zinc-400'
          }`}
        >
          {status}
        </span>
      </div>
      <p className="mt-2 text-sm text-zinc-400">{description}</p>
    </div>
  );
}
