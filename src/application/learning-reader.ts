/**
 * Load committed Compound learnings so later planning/council can consume them.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface LearningNote {
  file: string;
  title: string;
  goal_id?: string;
  excerpt: string;
}

export async function listLearnings(repoRoot: string, limit = 12): Promise<LearningNote[]> {
  const dir = path.join(repoRoot, 'docs', 'solutions');
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.md')).sort().reverse();
  } catch {
    return [];
  }
  const notes: LearningNote[] = [];
  for (const name of names.slice(0, limit)) {
    try {
      const text = await readFile(path.join(dir, name), 'utf8');
      const title = /^title:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? name;
      const goalId = /^goal_id:\s*(.+)$/m.exec(text)?.[1]?.trim();
      notes.push({
        file: `docs/solutions/${name}`,
        title,
        goal_id: goalId,
        excerpt: text.split('\n').filter((line) => line && !line.startsWith('---') && !line.includes(': ')).slice(0, 3).join(' ').slice(0, 240),
      });
    } catch {
      // skip unreadable notes
    }
  }
  return notes;
}

export function renderLearningContext(notes: LearningNote[]): string {
  if (notes.length === 0) return '';
  return [
    '## Prior learnings (docs/solutions)',
    ...notes.map((note) => `- ${note.title} (${note.file})${note.excerpt ? `: ${note.excerpt}` : ''}`),
  ].join('\n');
}
