import { BiasGrid } from '@/components/dashboard/BiasGrid';

export default function DashboardPage() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-6 py-4">
        <h1 className="text-xl font-semibold">ICT Decision Support</h1>
        <p className="text-xs text-zinc-500">click a symbol to drill into setups</p>
      </header>
      <main>
        <BiasGrid />
      </main>
    </div>
  );
}
