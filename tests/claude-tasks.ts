// Tests of the Claude paths (with the stand-in claude CLI): every task that may run on Claude set
// to it, since documents, receipts, names and notes go to the local model by default.

import type { Settings } from '../src/shared/schema';

export const CLAUDE_TASKS: Settings['models'] = {
  tasks: {
    'read-document': { engine: 'claude-cli' },
    'check-reading': { engine: 'claude-cli' },
    'read-receipt': { engine: 'claude-cli' },
    'label-imports': { engine: 'claude-cli' },
    'interpret-note': { engine: 'claude-cli' },
  },
};
