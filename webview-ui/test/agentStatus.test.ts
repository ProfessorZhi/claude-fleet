import { describe, expect, it } from 'vitest';

import {
  formatAgentStatusLabel,
  formatToolActivity,
  getActivityText,
} from '../src/office/components/agentStatus.js';

describe('office agent status labels', () => {
  it('maps lifecycle statuses to readable scene labels', () => {
    expect(formatAgentStatusLabel('starting')).toBe('Starting');
    expect(formatAgentStatusLabel('working')).toBe('Working');
    expect(formatAgentStatusLabel('waiting')).toBe('Waiting');
  });

  it('uses the live lifecycle status when no tool activity is available', () => {
    expect(getActivityText(1, {}, false, null, false, 'starting')).toBe('Starting');
    expect(getActivityText(1, {}, false, null, false, 'working')).toBe('Working');
  });

  it('keeps an active tool description ahead of the lifecycle status', () => {
    expect(
      getActivityText(
        1,
        { 1: [{ toolId: 'read', status: 'Reading file', done: false }] },
        false,
        null,
        false,
        'working',
      ),
    ).toBe('Reading file');
  });

  it('classifies live tool activity without losing the provider status', () => {
    expect(formatToolActivity('Bash', 'Running: npm test')).toBe('命令行 · Running: npm test');
    expect(formatToolActivity('WebFetch', 'Fetching web content')).toBe(
      '查阅网页 · Fetching web content',
    );
    expect(formatToolActivity('mcp__server__query', 'Using query')).toBe('MCP · Using query');
    expect(formatToolActivity('Task', 'Subtask: inspect')).toBe('多 Agent · Subtask: inspect');
    expect(formatToolActivity('TaskCreate', 'Creating task')).toBe('任务管理 · Creating task');
    expect(formatToolActivity('Thinking', 'Reasoning')).toBe('推理中');
  });

  it('uses tool names to classify the office activity', () => {
    expect(
      getActivityText(
        1,
        { 1: [{ toolId: 'bash', toolName: 'Bash', status: 'Running: npm test', done: false }] },
        true,
        null,
        false,
        'working',
      ),
    ).toBe('命令行 · Running: npm test');
  });
});
