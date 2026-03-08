import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('teams skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: teams');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('botbuilder');
  });

  it('has all files declared in adds', () => {
    const channelFile = path.join(
      skillDir,
      'add',
      'src',
      'channels',
      'teams.ts',
    );
    expect(fs.existsSync(channelFile)).toBe(true);

    const content = fs.readFileSync(channelFile, 'utf-8');
    expect(content).toContain('class TeamsChannel');
    expect(content).toContain('implements Channel');
    expect(content).toContain("registerChannel('teams'");

    // Test file for the channel
    const testFile = path.join(
      skillDir,
      'add',
      'src',
      'channels',
      'teams.test.ts',
    );
    expect(fs.existsSync(testFile)).toBe(true);

    const testContent = fs.readFileSync(testFile, 'utf-8');
    expect(testContent).toContain("describe('TeamsChannel'");
  });

  it('has all files declared in modifies', () => {
    // Channel barrel file
    const indexFile = path.join(
      skillDir,
      'modify',
      'src',
      'channels',
      'index.ts',
    );
    expect(fs.existsSync(indexFile)).toBe(true);

    const indexContent = fs.readFileSync(indexFile, 'utf-8');
    expect(indexContent).toContain("import './teams.js'");
  });

  it('has intent files for modified files', () => {
    expect(
      fs.existsSync(
        path.join(skillDir, 'modify', 'src', 'channels', 'index.ts.intent.md'),
      ),
    ).toBe(true);
  });

  it('has setup documentation', () => {
    expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'TEAMS_SETUP.md'))).toBe(true);
  });

  it('teams.ts implements required Channel interface methods', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'add', 'src', 'channels', 'teams.ts'),
      'utf-8',
    );

    // Channel interface methods
    expect(content).toContain('async connect()');
    expect(content).toContain('async sendMessage(');
    expect(content).toContain('isConnected()');
    expect(content).toContain('ownsJid(');
    expect(content).toContain('async disconnect()');
    expect(content).toContain('async setTyping(');

    // Security pattern: reads tokens from .env, not process.env
    expect(content).toContain('readEnvFile');
    expect(content).not.toContain('process.env.TEAMS_APP_ID');
    expect(content).not.toContain('process.env.TEAMS_APP_PASSWORD');

    // SingleTenant auth with tenant ID
    expect(content).toContain('SingleTenant');
    expect(content).toContain('TEAMS_TENANT_ID');
    expect(content).toContain('MicrosoftAppTenantId');

    // Key behaviors
    expect(content).toContain('MAX_MESSAGE_LENGTH');
    expect(content).toContain('TRIGGER_PATTERN');
    expect(content).toContain('conversationRefs');
    expect(content).toContain('CloudAdapter');
    expect(content).toContain('TeamsActivityHandler');
  });
});
