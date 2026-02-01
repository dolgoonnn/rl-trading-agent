/**
 * Markdown parsing and generation for ICT knowledge base.
 */

import type { ConceptContent, ConceptFrontmatter } from '../types';

/**
 * Parse YAML frontmatter from markdown content.
 */
export function parseFrontmatter(markdown: string): {
  frontmatter: Record<string, unknown>;
  content: string;
} {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
  const match = markdown.match(frontmatterRegex);

  if (!match) {
    return { frontmatter: {}, content: markdown };
  }

  const yamlContent = match[1] ?? '';
  const content = match[2] ?? '';

  // Simple YAML parser for our use case
  const frontmatter: Record<string, unknown> = {};
  const lines = yamlContent.split('\n');
  let currentKey = '';
  let currentIndent = 0;
  let inArray = false;
  let arrayValues: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const indent = line.search(/\S/);

    // Array item
    if (trimmed.startsWith('- ')) {
      arrayValues.push(trimmed.slice(2));
      continue;
    }

    // If we were collecting array, save it
    if (inArray && indent <= currentIndent) {
      frontmatter[currentKey] = arrayValues;
      arrayValues = [];
      inArray = false;
    }

    // Key-value pair
    const kvMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1] ?? '';
      const value = kvMatch[2] ?? '';
      if (value) {
        // Direct value
        frontmatter[key] = value.replace(/^["']|["']$/g, '');
      } else {
        // Possibly starting an array or object
        currentKey = key;
        currentIndent = indent;
        inArray = true;
      }
    }
  }

  // Final array
  if (inArray && arrayValues.length > 0) {
    frontmatter[currentKey] = arrayValues;
  }

  return { frontmatter, content };
}

/**
 * Generate markdown from structured concept content.
 */
export function generateConceptMarkdown(concept: ConceptContent): string {
  const { frontmatter, ...content } = concept;

  const lines: string[] = [];

  // Frontmatter
  lines.push('---');
  lines.push(`title: "${frontmatter.title}"`);
  lines.push(`slug: ${frontmatter.slug}`);
  lines.push(`category: ${frontmatter.category}`);

  if (frontmatter.source) {
    lines.push('source:');
    lines.push(`  type: ${frontmatter.source.type}`);
    if (frontmatter.source.url) lines.push(`  url: ${frontmatter.source.url}`);
    if (frontmatter.source.videoId)
      lines.push(`  videoId: ${frontmatter.source.videoId}`);
    if (frontmatter.source.timestamp)
      lines.push(`  timestamp: "${frontmatter.source.timestamp}"`);
    if (frontmatter.source.playlist)
      lines.push(`  playlist: "${frontmatter.source.playlist}"`);
  }

  lines.push('concepts:');
  for (const c of frontmatter.concepts) {
    lines.push(`  - ${c}`);
  }

  lines.push(`difficulty: ${frontmatter.difficulty}`);
  lines.push(`phase: ${frontmatter.phase}`);
  lines.push(`created: ${frontmatter.created}`);
  if (frontmatter.updated) {
    lines.push(`updated: ${frontmatter.updated}`);
  }
  lines.push('---');
  lines.push('');

  // Title
  lines.push(`# ${frontmatter.title}`);
  lines.push('');

  // Definition
  lines.push('## Definition');
  lines.push('');
  lines.push(content.definition);
  lines.push('');

  // Key Characteristics
  if (content.keyCharacteristics.length > 0) {
    lines.push('## Key Characteristics');
    lines.push('');
    for (const char of content.keyCharacteristics) {
      lines.push(`- ${char}`);
    }
    lines.push('');
  }

  // Visual Pattern
  if (content.visualPattern) {
    lines.push('## Visual Pattern');
    lines.push('');
    lines.push('```');
    lines.push(content.visualPattern);
    lines.push('```');
    lines.push('');
  }

  // Trading Application
  if (content.tradingApplication.length > 0) {
    lines.push('## Trading Application');
    lines.push('');
    for (let i = 0; i < content.tradingApplication.length; i++) {
      lines.push(`${i + 1}. ${content.tradingApplication[i]}`);
    }
    lines.push('');
  }

  // Rules
  if (content.rules && content.rules.length > 0) {
    lines.push('## Trading Rules');
    lines.push('');
    for (const rule of content.rules) {
      lines.push(`- ${rule}`);
    }
    lines.push('');
  }

  // Examples
  if (content.examples && content.examples.length > 0) {
    lines.push('## Examples');
    lines.push('');
    for (const example of content.examples) {
      lines.push(`- ${example}`);
    }
    lines.push('');
  }

  // Related Concepts
  if (content.relatedConcepts.length > 0) {
    lines.push('## Related Concepts');
    lines.push('');
    for (const related of content.relatedConcepts) {
      lines.push(`- [[${related}]]`);
    }
    lines.push('');
  }

  // Source Notes
  if (content.sourceNotes && content.sourceNotes.length > 0) {
    lines.push('## Source Notes');
    lines.push('');
    for (const note of content.sourceNotes) {
      lines.push(`> "${note.quote}"`);
      lines.push(`> — ${note.source}${note.timestamp ? ` @ ${note.timestamp}` : ''}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Extract sections from markdown content.
 * Returns array of { header, level, content } objects.
 */
export function extractSections(
  markdown: string
): Array<{ header: string; level: number; content: string }> {
  const { content } = parseFrontmatter(markdown);
  const sections: Array<{ header: string; level: number; content: string }> = [];

  const headerRegex = /^(#{1,6})\s+(.+)$/gm;
  const matches = [...content.matchAll(headerRegex)];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    if (!match) continue;
    const level = (match[1] ?? '').length;
    const header = match[2] ?? '';
    const startIndex = (match.index ?? 0) + match[0].length;
    const endIndex = matches[i + 1]?.index ?? content.length;
    const sectionContent = content.slice(startIndex, endIndex).trim();

    sections.push({ header, level, content: sectionContent });
  }

  return sections;
}

/**
 * Create a concept template with default values.
 */
export function createConceptTemplate(
  title: string,
  slug: string,
  category: ConceptFrontmatter['category']
): ConceptContent {
  return {
    frontmatter: {
      title,
      slug,
      category,
      concepts: [],
      difficulty: 'intermediate',
      phase: 2,
      created: new Date().toISOString().split('T')[0] ?? '',
    },
    definition: '',
    keyCharacteristics: [],
    tradingApplication: [],
    relatedConcepts: [],
  };
}
