/**
 * Flashcard Study Page with FSRS Scheduling
 */

'use client';

import { useState, useEffect } from 'react';
import { trpc } from '@/lib/trpc/client';

type Rating = '1' | '2' | '3' | '4';

interface FlashcardCard {
  id: number;
  front: string;
  back: string;
  type: 'basic' | 'cloze' | 'sequence';
  tags: string[];
  state: string;
}

export default function FlashcardsPage() {
  const [cards, setCards] = useState<FlashcardCard[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);
  const [sessionStats, setSessionStats] = useState({
    correct: 0,
    again: 0,
    hard: 0,
    easy: 0,
  });

  // Fetch due cards
  const dueCardsQuery = trpc.flashcards.getDueCards.useQuery(
    { limit: 20 },
    { staleTime: Infinity }
  );

  // Record review result
  const recordReviewMutation = trpc.flashcards.recordReview.useMutation();

  const currentCard = cards[currentIndex];
  const progress = currentIndex + 1;
  const total = cards.length;

  // Get statistics (for future use)
  // const statsQuery = trpc.flashcards.getConceptStats.useQuery({});

  const handleRate = async (rating: Rating) => {
    if (!currentCard) return;

    // Record in database
    await recordReviewMutation.mutateAsync({
      cardId: currentCard.id,
      rating,
    });

    // Update session stats
    const statKey = {
      '1': 'again',
      '2': 'hard',
      '3': 'correct',
      '4': 'easy',
    }[rating];

    setSessionStats((prev) => ({
      ...prev,
      [statKey]: prev[statKey as keyof typeof sessionStats] + 1,
    }));

    // Move to next card or finish
    if (currentIndex < cards.length - 1) {
      setCurrentIndex(currentIndex + 1);
      setShowAnswer(false);
    } else {
      // Session complete
      setShowAnswer(false);
    }
  };

  useEffect(() => {
    if (dueCardsQuery.data?.cards) {
      const typedCards = dueCardsQuery.data.cards.map((c) => ({
        ...c,
        type: c.type as 'basic' | 'cloze' | 'sequence',
      }));
      setCards(typedCards);
    }
  }, [dueCardsQuery.data]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if (!currentCard) return;

      if (!showAnswer) {
        if (e.code === 'Space' || e.key === ' ') {
          e.preventDefault();
          setShowAnswer(true);
        }
      } else {
        if (e.key === '1') handleRate('1');
        if (e.key === '2') handleRate('2');
        if (e.key === '3') handleRate('3');
        if (e.key === '4') handleRate('4');
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [currentCard, showAnswer, currentIndex, handleRate]);

  if (cards.length === 0 && dueCardsQuery.isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 to-blue-50 flex items-center justify-center p-4">
        <div className="text-center">
          <div className="text-6xl mb-4">📚</div>
          <p className="text-slate-600">Loading flashcards...</p>
        </div>
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 to-blue-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full text-center">
          <div className="text-6xl mb-4">✨</div>
          <h1 className="text-2xl font-bold text-slate-900 mb-2">No Cards Due</h1>
          <p className="text-slate-600 mb-6">
            You've caught up! Come back tomorrow for more reviews.
          </p>
          <a
            href="/kb-search"
            className="inline-block px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition"
          >
            Explore Knowledge Base
          </a>
        </div>
      </div>
    );
  }

  if (currentIndex >= cards.length) {
    const total = sessionStats.correct + sessionStats.again + sessionStats.hard + sessionStats.easy;
    const accuracy = total > 0 ? Math.round((sessionStats.correct + sessionStats.easy) / total * 100) : 0;

    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 to-blue-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8 text-center">
          <div className="text-6xl mb-4">🎉</div>
          <h1 className="text-3xl font-bold text-slate-900 mb-6">Session Complete!</h1>

          <div className="space-y-4 mb-8">
            <div className="bg-purple-50 rounded-lg p-4">
              <p className="text-sm text-slate-600 mb-1">Cards Reviewed</p>
              <p className="text-3xl font-bold text-purple-600">{total}</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="bg-green-50 rounded-lg p-4">
                <p className="text-xs text-slate-600 mb-1">Easy</p>
                <p className="text-2xl font-bold text-green-600">{sessionStats.easy}</p>
              </div>
              <div className="bg-blue-50 rounded-lg p-4">
                <p className="text-xs text-slate-600 mb-1">Good</p>
                <p className="text-2xl font-bold text-blue-600">{sessionStats.correct}</p>
              </div>
              <div className="bg-yellow-50 rounded-lg p-4">
                <p className="text-xs text-slate-600 mb-1">Hard</p>
                <p className="text-2xl font-bold text-yellow-600">{sessionStats.hard}</p>
              </div>
              <div className="bg-red-50 rounded-lg p-4">
                <p className="text-xs text-slate-600 mb-1">Again</p>
                <p className="text-2xl font-bold text-red-600">{sessionStats.again}</p>
              </div>
            </div>

            <div className="bg-slate-50 rounded-lg p-4">
              <p className="text-sm text-slate-600 mb-1">Accuracy</p>
              <p className="text-3xl font-bold text-slate-900">{accuracy}%</p>
            </div>
          </div>

          <button
            onClick={() => window.location.reload()}
            className="w-full px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition"
          >
            Review More Cards
          </button>
        </div>
      </div>
    );
  }

  const renderCardContent = (card: FlashcardCard | undefined) => {
    if (!card) return <div>No card</div>;
    if (card.type === 'cloze') {
      // Render cloze deletions
      const parts = card[showAnswer ? 'back' : 'front'].split(/{{c\d+::(.*?)}}/g);
      return (
        <div className="space-y-2">
          {parts.map((part, i) => {
            const isCloze = i % 2 === 1;
            return (
              <span key={i}>
                {isCloze && showAnswer ? (
                  <span className="bg-green-200 text-green-900 px-2 py-1 rounded font-semibold">{part}</span>
                ) : isCloze ? (
                  <span className="bg-slate-200 text-slate-200 px-2 py-1 rounded font-semibold">•••</span>
                ) : (
                  part
                )}
              </span>
            );
          })}
        </div>
      );
    }

    return <div>{showAnswer ? card.back : card.front}</div>;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-blue-50 p-4">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Study Session</h1>
            <p className="text-slate-600">
              Card {progress} of {total}
            </p>
          </div>
          <div className="text-right">
            <div className="text-3xl font-bold text-slate-900">{progress}/{total}</div>
            <div className="text-sm text-slate-600">
              {sessionStats.easy + sessionStats.correct}/{progress} correct
            </div>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="bg-white rounded-lg shadow p-4 mb-6">
          <div className="flex gap-1">
            {cards.map((_, i) => {
              let bgColor = 'bg-slate-200';
              if (i < currentIndex) {
                if (sessionStats.easy + sessionStats.correct > i - sessionStats.again - sessionStats.hard) {
                  bgColor = 'bg-green-500';
                } else {
                  bgColor = 'bg-red-500';
                }
              } else if (i === currentIndex) {
                bgColor = 'bg-blue-500';
              }
              return <div key={i} className={`flex-1 h-2 rounded ${bgColor}`} />;
            })}
          </div>
        </div>

        {/* Card */}
        <div className="bg-white rounded-lg shadow-lg p-8 mb-6 min-h-80 flex flex-col justify-between">
          {/* Front/Back Toggle */}
          <div className="mb-4">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
              {currentCard?.type} • {currentCard?.tags.join(', ')}
            </span>
          </div>

          {/* Card Content */}
          <div className="text-center mb-8">
            <p className="text-slate-600 text-sm mb-4 font-medium">
              {showAnswer ? 'Answer' : 'Question'}
            </p>
            <div className="text-2xl font-serif text-slate-900 leading-relaxed">
              {renderCardContent(currentCard)}
            </div>
          </div>

          {/* Reveal Button */}
          {!showAnswer ? (
            <button
              onClick={() => setShowAnswer(true)}
              className="w-full py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-medium transition"
            >
              Reveal Answer
            </button>
          ) : (
            <div className="space-y-3">
              {/* Rating Buttons */}
              <div className="grid grid-cols-4 gap-3">
                <button
                  onClick={() => handleRate('1')}
                  className="py-3 bg-red-100 hover:bg-red-200 text-red-700 font-semibold rounded-lg transition text-sm"
                  title="I got it wrong or couldn't remember"
                >
                  Again
                </button>
                <button
                  onClick={() => handleRate('2')}
                  className="py-3 bg-yellow-100 hover:bg-yellow-200 text-yellow-700 font-semibold rounded-lg transition text-sm"
                  title="Hard - but I got it right"
                >
                  Hard
                </button>
                <button
                  onClick={() => handleRate('3')}
                  className="py-3 bg-blue-100 hover:bg-blue-200 text-blue-700 font-semibold rounded-lg transition text-sm"
                  title="Good - I got it right with effort"
                >
                  Good
                </button>
                <button
                  onClick={() => handleRate('4')}
                  className="py-3 bg-green-100 hover:bg-green-200 text-green-700 font-semibold rounded-lg transition text-sm"
                  title="Easy - I got it right immediately"
                >
                  Easy
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Stats Summary */}
        {showAnswer && (
          <div className="grid grid-cols-4 gap-3 mb-6">
            <div className="bg-green-50 rounded-lg p-4 text-center">
              <p className="text-xs text-slate-600">Easy</p>
              <p className="text-2xl font-bold text-green-600">{sessionStats.easy}</p>
            </div>
            <div className="bg-blue-50 rounded-lg p-4 text-center">
              <p className="text-xs text-slate-600">Good</p>
              <p className="text-2xl font-bold text-blue-600">{sessionStats.correct}</p>
            </div>
            <div className="bg-yellow-50 rounded-lg p-4 text-center">
              <p className="text-xs text-slate-600">Hard</p>
              <p className="text-2xl font-bold text-yellow-600">{sessionStats.hard}</p>
            </div>
            <div className="bg-red-50 rounded-lg p-4 text-center">
              <p className="text-xs text-slate-600">Again</p>
              <p className="text-2xl font-bold text-red-600">{sessionStats.again}</p>
            </div>
          </div>
        )}

        {/* Keyboard Hints */}
        <div className="text-center text-sm text-slate-500">
          💡 Use keyboard: 1=Again, 2=Hard, 3=Good, 4=Easy
        </div>
      </div>
    </div>
  );
}
