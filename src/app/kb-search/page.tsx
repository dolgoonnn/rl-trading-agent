/**
 * Knowledge Base Search Demo Page
 */

'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc/client';

export default function KBSearchPage() {
  const [query, setQuery] = useState('');
  const [selectedConcept, setSelectedConcept] = useState<string>();
  const [topK, setTopK] = useState(10);

  // Use tRPC query for search
  const searchQuery = trpc.kb.search.useQuery(
    { query, concept: selectedConcept, topK },
    {
      enabled: query.length > 2, // Only search when query is at least 3 chars
      staleTime: Infinity,
      retry: false,
    }
  );

  const suggestionsQuery = trpc.kb.suggestions.useQuery({
    limit: 10,
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-12">
          <h1 className="text-4xl font-bold text-slate-900 mb-2">ICT Knowledge Base</h1>
          <p className="text-lg text-slate-600">Search 2,200+ chunks from 33 ICT concepts & 43 video transcripts</p>
        </div>

        {/* Search Box */}
        <div className="bg-white rounded-lg shadow-lg p-8 mb-8">
          <div className="space-y-4">
            {/* Query Input */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Search Query
              </label>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g., fair value gap, order blocks, kill zone..."
                className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
              />
            </div>

            {/* Filters */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Results Count
                </label>
                <input
                  type="number"
                  value={topK}
                  onChange={(e) => setTopK(Math.min(50, Math.max(1, parseInt(e.target.value) || 10)))}
                  min="1"
                  max="50"
                  className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Concept (Optional)
                </label>
                <input
                  type="text"
                  value={selectedConcept || ''}
                  onChange={(e) => setSelectedConcept(e.target.value || undefined)}
                  placeholder="Filter by concept slug"
                  className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                />
              </div>
            </div>

            {/* Suggestions */}
            {suggestionsQuery.data && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Popular Searches
                </label>
                <div className="flex flex-wrap gap-2">
                  {suggestionsQuery.data.suggestions.slice(0, 8).map((suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() => setQuery(suggestion)}
                      className="px-3 py-1 bg-blue-100 hover:bg-blue-200 text-blue-800 rounded-full text-sm transition"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Results */}
        <div>
          {searchQuery.isLoading && (
            <div className="text-center py-12">
              <div className="text-slate-600">Searching knowledge base...</div>
            </div>
          )}

          {searchQuery.error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-red-700">
              <p className="font-semibold">Search Error</p>
              <p className="text-sm mt-1">{searchQuery.error.message}</p>
            </div>
          )}

          {searchQuery.data && !searchQuery.data.success && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 text-yellow-800">
              <p className="font-semibold">Search Failed</p>
              <p className="text-sm mt-1">{searchQuery.data.error}</p>
            </div>
          )}

          {searchQuery.data?.success && (
            <div>
              <div className="mb-6">
                <h2 className="text-xl font-bold text-slate-900">
                  Results ({searchQuery.data.resultCount})
                </h2>
                <p className="text-sm text-slate-600 mt-1">
                  Showing {searchQuery.data.resultCount} of 2,221 total chunks
                </p>
              </div>

              {searchQuery.data.results.length === 0 ? (
                <div className="text-center py-12 bg-white rounded-lg border border-slate-200">
                  <p className="text-slate-600">No results found. Try a different search term.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {searchQuery.data.results.map((result) => (
                    <div key={result.id} className="bg-white rounded-lg shadow p-6 border-l-4 border-blue-500">
                      {/* Header */}
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          {result.section && (
                            <h3 className="font-semibold text-slate-900">{result.section}</h3>
                          )}
                          {result.concept && (
                            <p className="text-sm text-blue-600 font-medium">{result.concept}</p>
                          )}
                        </div>
                        {result.tokenCount && (
                          <span className="text-xs bg-slate-100 text-slate-600 px-2 py-1 rounded">
                            {result.tokenCount} tokens
                          </span>
                        )}
                      </div>

                      {/* Content Preview */}
                      <p className="text-slate-700 text-sm leading-relaxed line-clamp-3">
                        {result.content}
                      </p>

                      {/* Footer */}
                      <div className="flex items-center gap-4 mt-4 pt-4 border-t border-slate-100 text-xs text-slate-600">
                        <span className="bg-slate-50 px-2 py-1 rounded">
                          {result.sourceType}
                        </span>
                        {result.videoId && (
                          <a
                            href={`https://youtu.be/${result.videoId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:underline"
                          >
                            Video
                          </a>
                        )}
                        {result.filePath && (
                          <span className="text-slate-500">{result.filePath}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {!query && !searchQuery.data && (
            <div className="text-center py-12 bg-white rounded-lg border border-slate-200">
              <p className="text-slate-600">Enter a search term to get started</p>
            </div>
          )}
        </div>

        {/* Info Box */}
        <div className="mt-12 bg-blue-50 border border-blue-200 rounded-lg p-6">
          <h3 className="font-semibold text-blue-900 mb-2">About This Knowledge Base</h3>
          <ul className="text-sm text-blue-800 space-y-1">
            <li>✅ 33 ICT trading concepts from 2022 Mentorship (15 episodes)</li>
            <li>✅ 43 YouTube video transcripts (3 playlists)</li>
            <li>✅ 2,221 searchable chunks with 97.7% vector embeddings</li>
            <li>✅ Semantic search powered by Ollama nomic-embed-text</li>
            <li>⏳ Flashcard generation for spaced repetition learning</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
