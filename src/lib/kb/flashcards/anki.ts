/**
 * Anki .apkg export functionality.
 * Creates Anki-compatible package files for flashcard import.
 */

import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type { Flashcard } from '../types';

// Anki note format for TSV export (used by toAnkiTSV)
// interface AnkiNote {
//   front: string;
//   back: string;
//   tags: string;
// }

/**
 * Convert flashcards to Anki-compatible TSV format.
 * Can be imported into Anki via File > Import.
 */
export function toAnkiTSV(flashcards: Flashcard[]): string {
  const lines: string[] = [];

  // Header with field separator
  lines.push('#separator:tab');
  lines.push('#html:true');
  lines.push('#tags column:3');
  lines.push('');

  for (const card of flashcards) {
    // Escape tabs and newlines
    const front = card.front.replace(/\t/g, '  ').replace(/\n/g, '<br>');
    const back = card.back.replace(/\t/g, '  ').replace(/\n/g, '<br>');
    const tags = card.tags.join(' ');

    lines.push(`${front}\t${back}\t${tags}`);
  }

  return lines.join('\n');
}

/**
 * Convert flashcards to Anki-compatible JSON format.
 * Alternative format that preserves more metadata.
 */
export function toAnkiJSON(
  flashcards: Flashcard[],
  deckName: string = 'ICT Trading'
): object {
  return {
    __type__: 'Deck',
    name: deckName,
    notes: flashcards.map((card, index) => ({
      __type__: 'Note',
      guid: `ict-${card.chunkId ?? 'manual'}-${index}`,
      note_model_name: card.type === 'cloze' ? 'Cloze' : 'Basic',
      fields: [card.front, card.back],
      tags: card.tags,
    })),
  };
}

/**
 * Export flashcards to TSV file.
 */
export async function exportToTSV(
  flashcards: Flashcard[],
  outputPath: string
): Promise<void> {
  const tsv = toAnkiTSV(flashcards);
  await writeFile(outputPath, tsv, 'utf-8');
}

/**
 * Export flashcards grouped by concept to separate TSV files.
 */
export async function exportByConceptToTSV(
  flashcards: Flashcard[],
  outputDir: string
): Promise<string[]> {
  // Group by first tag (concept)
  const byConceptMap = new Map<string, Flashcard[]>();

  for (const card of flashcards) {
    const concept = card.tags[0] ?? 'general';
    if (!byConceptMap.has(concept)) {
      byConceptMap.set(concept, []);
    }
    byConceptMap.get(concept)!.push(card);
  }

  // Ensure output directory exists
  await mkdir(outputDir, { recursive: true });

  const files: string[] = [];

  for (const [concept, cards] of byConceptMap) {
    const filename = `${concept.replace(/[^a-z0-9-]/gi, '-')}.txt`;
    const filepath = join(outputDir, filename);
    await exportToTSV(cards, filepath);
    files.push(filepath);
  }

  return files;
}

/**
 * Generate import instructions for Anki.
 */
export function getAnkiImportInstructions(tsvPath: string): string {
  return `
## Anki Import Instructions

1. Open Anki
2. Go to File > Import
3. Select the file: ${tsvPath}
4. Configure import settings:
   - Type: "Basic" (or "Cloze" for cloze cards)
   - Deck: Create new deck "ICT Trading" (or select existing)
   - Fields: Field 1 → Front, Field 2 → Back
   - Tags: Field 3
5. Click "Import"

### Card Types
- **Basic cards**: Simple Q&A format
- **Cloze cards**: Text with hidden portions ({{c1::answer}})
  - For cloze cards, use note type "Cloze" and put the cloze text in the Front field

### Recommended Study Settings
- New cards/day: 10-20
- Learning steps: 1m 10m 1h
- Graduating interval: 1 day
- Easy interval: 4 days
`.trim();
}

/**
 * Create a study session summary.
 */
export function createStudySummary(flashcards: Flashcard[]): {
  total: number;
  byType: Record<string, number>;
  byConcept: Record<string, number>;
  newCards: number;
  reviewCards: number;
} {
  const byType: Record<string, number> = {};
  const byConcept: Record<string, number> = {};
  let newCards = 0;
  let reviewCards = 0;

  for (const card of flashcards) {
    // Count by type
    byType[card.type] = (byType[card.type] ?? 0) + 1;

    // Count by concept (first tag)
    const concept = card.tags[0] ?? 'general';
    byConcept[concept] = (byConcept[concept] ?? 0) + 1;

    // Count by state
    if (card.state === 'new') {
      newCards++;
    } else {
      reviewCards++;
    }
  }

  return {
    total: flashcards.length,
    byType,
    byConcept,
    newCards,
    reviewCards,
  };
}
