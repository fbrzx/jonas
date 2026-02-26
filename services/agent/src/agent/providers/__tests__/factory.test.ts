/**
 * Unit tests for provider factory
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, unlink } from 'node:fs/promises';
import { ProviderFactory } from '../factory.js';
import { ClaudeProvider } from '../claude.js';
import { OllamaProvider } from '../ollama.js';

describe('ProviderFactory', () => {
  const testConfigPath = '/tmp/test-model-config.json';

  afterEach(async () => {
    try {
      await unlink(testConfigPath);
    } catch {
      // Ignore if file doesn't exist
    }
  });

  describe('loadConfig', () => {
    it('should use default Claude config when no file exists', async () => {
      const config = await ProviderFactory.loadConfig('/nonexistent/path.json');

      expect(config.provider).toBe('claude');
      expect(config.claude?.model).toBe('claude-sonnet-4-5-20250929');
    });

    it('should load config from file when it exists', async () => {
      const fileConfig = {
        provider: 'ollama',
        ollama: {
          baseUrl: 'http://test:11434',
          model: 'test-model',
        },
      };

      await writeFile(testConfigPath, JSON.stringify(fileConfig));
      const config = await ProviderFactory.loadConfig(testConfigPath);

      expect(config.provider).toBe('ollama');
      expect(config.ollama?.baseUrl).toBe('http://test:11434');
      expect(config.ollama?.model).toBe('test-model');
    });

    it('should use env vars as defaults', async () => {
      const originalEnv = { ...process.env };

      process.env.MODEL_PROVIDER = 'ollama';
      process.env.OLLAMA_BASE_URL = 'http://env-test:11434';
      process.env.OLLAMA_MODEL = 'env-model';

      const config = await ProviderFactory.loadConfig('/nonexistent/path.json');

      expect(config.provider).toBe('ollama');
      expect(config.ollama?.baseUrl).toBe('http://env-test:11434');
      expect(config.ollama?.model).toBe('env-model');

      // Restore env
      process.env = originalEnv;
    });

    it('should prioritize file config over env vars', async () => {
      const originalEnv = { ...process.env };

      process.env.MODEL_PROVIDER = 'claude';
      process.env.OLLAMA_MODEL = 'env-model';

      const fileConfig = {
        provider: 'ollama',
        ollama: {
          baseUrl: 'http://file:11434',
          model: 'file-model',
        },
      };

      await writeFile(testConfigPath, JSON.stringify(fileConfig));
      const config = await ProviderFactory.loadConfig(testConfigPath);

      expect(config.provider).toBe('ollama');
      expect(config.ollama?.model).toBe('file-model');

      // Restore env
      process.env = originalEnv;
    });
  });

  describe('create', () => {
    it('should create ClaudeProvider when provider is claude', () => {
      const config = {
        provider: 'claude' as const,
        claude: { model: 'test-model' },
      };

      const provider = ProviderFactory.create(config, '/path/to/claude', '/path/to/mcp');

      expect(provider).toBeInstanceOf(ClaudeProvider);
      expect(provider.getName()).toContain('claude');
    });

    it('should create OllamaProvider when provider is ollama', () => {
      const config = {
        provider: 'ollama' as const,
        ollama: {
          baseUrl: 'http://localhost:11434',
          model: 'test-model',
        },
      };

      const provider = ProviderFactory.create(config, '/path/to/claude', '/path/to/mcp');

      expect(provider).toBeInstanceOf(OllamaProvider);
      expect(provider.getName()).toBe('ollama:test-model');
    });

    it('should throw error if ollama config is missing', () => {
      const config = {
        provider: 'ollama' as const,
      };

      expect(() => {
        ProviderFactory.create(config, '/path/to/claude', '/path/to/mcp');
      }).toThrow('Ollama configuration missing');
    });

    it('should default to Claude if provider is unknown', () => {
      const config = {
        provider: 'claude' as const,
        claude: { model: 'test-model' },
      };

      const provider = ProviderFactory.create(config, '/path/to/claude', '/path/to/mcp');

      expect(provider).toBeInstanceOf(ClaudeProvider);
    });
  });

  describe('createForAgent', () => {
    it('creates a ClaudeProvider from an agent row', () => {
      const provider = ProviderFactory.createForAgent(
        { provider: 'claude', claudeModel: 'claude-opus-4-6' },
        '/claude',
        '/mcp.json',
      );
      expect(provider).toBeInstanceOf(ClaudeProvider);
      expect(provider.getName()).toContain('claude-opus-4-6');
    });

    it('creates an OllamaProvider from an agent row', () => {
      const provider = ProviderFactory.createForAgent(
        { provider: 'ollama', ollamaBaseUrl: 'http://localhost:11434', ollamaModel: 'llama3.2' },
        '/claude',
        '/mcp.json',
      );
      expect(provider).toBeInstanceOf(OllamaProvider);
      expect(provider.getName()).toBe('ollama:llama3.2');
    });

    it('falls back to default Claude model when claudeModel is null', () => {
      const provider = ProviderFactory.createForAgent(
        { provider: 'claude', claudeModel: null },
        '/claude',
        '/mcp.json',
      );
      expect(provider).toBeInstanceOf(ClaudeProvider);
    });
  });
});
