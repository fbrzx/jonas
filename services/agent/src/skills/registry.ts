import { readFile, writeFile, readdir, mkdir, rm, access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import { createLogger, isoNow } from '@jonas/shared/utils';
import type { Skill, SkillConfig, SkillMetadata, SkillStatus, Connection } from '@jonas/shared/types';
import { loadSkillState, saveSkillState, type SkillStateMap } from './storage.js';
import type { SkillCryptoStore } from './crypto-store.js';
import type { ConnectionManager } from '../connections/manager.js';

const log = createLogger('skill-registry');
const execFileAsync = promisify(execFile);

const SKILLS_DIR = '/data/skills';
const STATE_PATH = '/data/skills.json';

interface McpServerEntry {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      meta[key] = val;
    }
  }
  return { meta, body: match[2].trim() };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export class SkillRegistry {
  private skills = new Map<string, Skill>();
  private bodies = new Map<string, string>();
  private state: SkillStateMap = {};
  private cryptoStore: SkillCryptoStore;
  private connectionManager?: ConnectionManager;

  constructor(cryptoStore: SkillCryptoStore, connectionManager?: ConnectionManager) {
    this.cryptoStore = cryptoStore;
    this.connectionManager = connectionManager;
  }

  async load(): Promise<void> {
    this.state = await loadSkillState(STATE_PATH);

    let entries: string[];
    try {
      const dirEntries = await readdir(SKILLS_DIR, { withFileTypes: true });
      entries = dirEntries
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        log.info('No skills directory found');
        return;
      }
      throw err;
    }

    for (const dirName of entries) {
      try {
        await this.loadSkill(dirName);
      } catch (err) {
        log.error({ skill: dirName, err }, 'Failed to load skill');
      }
    }

    // Clean state entries for skills that no longer exist on disk
    let stateChanged = false;
    for (const name of Object.keys(this.state)) {
      if (!this.skills.has(name)) {
        delete this.state[name];
        stateChanged = true;
      }
    }
    if (stateChanged) await saveSkillState(STATE_PATH, this.state);

    log.info({ count: this.skills.size }, 'Skills loaded');
  }

  private async loadSkill(dirName: string): Promise<void> {
    const skillDir = join(SKILLS_DIR, dirName);
    // Accept both Jonas format (skill.md) and Claude Code format (SKILL.md)
    const mdPathLower = join(skillDir, 'skill.md');
    const mdPathUpper = join(skillDir, 'SKILL.md');
    const mdPath = (await fileExists(mdPathLower))
      ? mdPathLower
      : (await fileExists(mdPathUpper))
        ? mdPathUpper
        : null;

    if (!mdPath) {
      log.warn({ dir: dirName }, 'Skipping directory without skill.md or SKILL.md');
      return;
    }

    const mdContent = await readFile(mdPath, 'utf-8');
    const { meta, body } = parseFrontmatter(mdContent);

    // Load optional config.json
    let config: SkillConfig | undefined;
    const configPath = join(skillDir, 'config.json');
    if (await fileExists(configPath)) {
      config = JSON.parse(await readFile(configPath, 'utf-8'));
    }

    const hasTools = await fileExists(join(skillDir, 'tools', 'server.py'));
    const hasPrompt = body.length > 0;

    // Install Python deps if needed
    const reqPath = join(skillDir, 'requirements.txt');
    if (hasTools && (await fileExists(reqPath))) {
      try {
        await execFileAsync('pip3', [
          'install', '--break-system-packages', '-q', '-r', reqPath,
        ]);
        log.info({ skill: dirName }, 'Python dependencies installed');
      } catch (err) {
        log.warn({ skill: dirName, err }, 'Failed to install Python dependencies');
      }
    }

    const cryptoKeys = await this.cryptoStore.getKeys(skillDir);
    const status: SkillStatus = this.state[dirName] ?? 'enabled';

    const metadata: SkillMetadata = {
      name: meta.name ?? dirName,
      description: meta.description ?? '',
      version: meta.version ?? '0.0.0',
      author: meta.author ?? 'unknown',
      builtIn: false,
    };

    const skill: Skill = {
      dirName,
      metadata,
      status,
      filePath: skillDir,
      loadedAt: isoNow(),
      config,
      hasTools,
      hasPrompt,
      secretKeys: cryptoKeys.length > 0 ? cryptoKeys : undefined,
    };

    this.skills.set(dirName, skill);
    this.bodies.set(dirName, body);

    // Persist status for new skills
    if (!(dirName in this.state)) {
      this.state[dirName] = status;
      await saveSkillState(STATE_PATH, this.state);
    }

    log.info({ skill: dirName, hasTools, hasPrompt, status }, 'Skill loaded');
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  async enable(name: string): Promise<boolean> {
    const skill = this.skills.get(name);
    if (!skill) return false;
    skill.status = 'enabled';
    this.state[name] = 'enabled';
    await saveSkillState(STATE_PATH, this.state);
    return true;
  }

  async disable(name: string): Promise<boolean> {
    const skill = this.skills.get(name);
    if (!skill) return false;
    skill.status = 'disabled';
    this.state[name] = 'disabled';
    await saveSkillState(STATE_PATH, this.state);
    return true;
  }

  /** Create a new skill on disk and load it into the registry. */
  async create(opts: {
    dirName: string;
    skillMd: string;
    config?: SkillConfig;
    toolServerPy?: string;
    requirementsTxt?: string;
  }): Promise<Skill> {
    const dirName = opts.dirName.replace(/[^a-z0-9_-]/g, '-');
    const skillDir = join(SKILLS_DIR, dirName);

    if (this.skills.has(dirName)) {
      throw new Error(`Skill "${dirName}" already exists`);
    }

    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'skill.md'), opts.skillMd, 'utf-8');

    if (opts.config) {
      await writeFile(join(skillDir, 'config.json'), JSON.stringify(opts.config, null, 2), 'utf-8');
    }

    if (opts.toolServerPy) {
      await mkdir(join(skillDir, 'tools'), { recursive: true });
      await writeFile(join(skillDir, 'tools', 'server.py'), opts.toolServerPy, 'utf-8');
    }

    if (opts.requirementsTxt) {
      await writeFile(join(skillDir, 'requirements.txt'), opts.requirementsTxt, 'utf-8');
    }

    await this.loadSkill(dirName);
    const skill = this.skills.get(dirName);
    if (!skill) throw new Error('Skill loaded but not found in registry');

    log.info({ skill: dirName }, 'Skill created');
    return skill;
  }

  async setSkillValue(name: string, key: string, value: string): Promise<boolean> {
    const skill = this.skills.get(name);
    if (!skill) return false;
    await this.cryptoStore.set(skill.filePath, key, value);
    skill.secretKeys = await this.cryptoStore.getKeys(skill.filePath);
    return true;
  }

  async removeSkillValue(name: string, key: string): Promise<boolean> {
    const skill = this.skills.get(name);
    if (!skill) return false;
    await this.cryptoStore.remove(skill.filePath, key);
    skill.secretKeys = await this.cryptoStore.getKeys(skill.filePath);
    return true;
  }

  getEnabledPrompts(): string[] {
    const prompts: string[] = [];
    for (const [name, skill] of this.skills) {
      if (skill.status === 'enabled' && skill.hasPrompt) {
        const body = this.bodies.get(name);
        if (body) prompts.push(body);
      }
    }
    return prompts;
  }

  async setOAuthCredentials(
    skillDirName: string,
    secretKey: string,
    clientId: string,
    clientSecret: string,
  ): Promise<boolean> {
    const skill = this.skills.get(skillDirName);
    if (!skill) return false;
    await this.cryptoStore.set(skill.filePath, `__oauth_${secretKey}_client_id`, clientId);
    await this.cryptoStore.set(skill.filePath, `__oauth_${secretKey}_client_secret`, clientSecret);
    skill.secretKeys = await this.cryptoStore.getKeys(skill.filePath);
    return true;
  }

  async getOAuthCredentials(
    skillDirName: string,
    secretKey: string,
  ): Promise<{ clientId: string; clientSecret: string } | null> {
    const skill = this.skills.get(skillDirName);
    if (!skill) return null;
    const all = await this.cryptoStore.getAll(skill.filePath);
    const clientId = all[`__oauth_${secretKey}_client_id`];
    const clientSecret = all[`__oauth_${secretKey}_client_secret`];
    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret };
  }

  getConnections(): Connection[] {
    const connections: Connection[] = [];
    for (const [, skill] of this.skills) {
      const oauth = skill.config?.oauth;
      if (!oauth) continue;
      for (const [secretKey, flow] of Object.entries(oauth)) {
        connections.push({
          skillDirName: skill.dirName,
          skillName: skill.metadata.name,
          secretKey,
          provider: flow.provider,
          connected: skill.secretKeys?.includes(secretKey) ?? false,
          scopes: flow.scopes,
        });
      }
    }
    return connections;
  }

  async getMcpServers(): Promise<Record<string, McpServerEntry>> {
    const servers: Record<string, McpServerEntry> = {};
    for (const [name, skill] of this.skills) {
      if (skill.status !== 'enabled' || !skill.hasTools) continue;
      const env = await this.cryptoStore.getEnv(skill.filePath);
      servers[`skill-${name}`] = {
        command: 'python3',
        args: [join(skill.filePath, 'tools', 'server.py')],
        cwd: skill.filePath,
        env,
      };
    }
    return servers;
  }

  /** Get skill config.json */
  getConfig(name: string): SkillConfig | null {
    const skill = this.skills.get(name);
    if (!skill) return null;
    return skill.config ?? null;
  }

  /**
   * Import a skill directly from a SKILL.md (or skill.md) string.
   * Used when importing a Claude Code skill uploaded as a plain markdown file.
   */
  async importFromMarkdown(content: string, overwrite = false): Promise<Skill> {
    const { meta, body } = parseFrontmatter(content);
    const dirName = (meta.name || 'imported-skill').toLowerCase().replace(/[^a-z0-9_-]/g, '-');

    if (this.skills.has(dirName) && !overwrite) {
      throw new Error(`Skill "${dirName}" already exists. Set overwrite=true to replace.`);
    }

    if (this.skills.has(dirName) && overwrite) {
      await this.delete(dirName);
    }

    return this.create({ dirName, skillMd: content });
  }

  /**
   * Export a skill as a Claude Code-compatible SKILL.md string.
   * Only exports the prompt body — tool servers are Jonas-specific and not portable.
   */
  exportAsClaudeSkillMd(name: string): string | null {
    const skill = this.skills.get(name);
    if (!skill) return null;
    const body = this.bodies.get(name) ?? '';
    const { name: skillName, description } = skill.metadata;
    const dirName = skillName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const frontmatter = `---\nname: ${dirName}\ndescription: ${description}\n---`;
    return body ? `${frontmatter}\n\n${body}` : frontmatter;
  }

  /**
   * Sync skills from a Claude Code skills directory (e.g. ~/.claude/skills or /claude-skills).
   * Each subdirectory containing a SKILL.md or skill.md is imported if not already present.
   * Returns { imported, skipped, errors }.
   */
  async syncFromClaudeSkillsDir(
    dir: string,
  ): Promise<{ imported: string[]; skipped: string[]; errors: string[] }> {
    const imported: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    let entries: string[];
    try {
      const dirEntries = await readdir(dir, { withFileTypes: true });
      entries = dirEntries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
      throw new Error(`Cannot read Claude skills directory: ${dir}`);
    }

    for (const entry of entries) {
      const entryDir = join(dir, entry);
      const mdPathUpper = join(entryDir, 'SKILL.md');
      const mdPathLower = join(entryDir, 'skill.md');
      const mdPath = (await fileExists(mdPathUpper))
        ? mdPathUpper
        : (await fileExists(mdPathLower))
          ? mdPathLower
          : null;

      if (!mdPath) {
        skipped.push(entry);
        continue;
      }

      const dirName = entry.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      if (this.skills.has(dirName)) {
        skipped.push(entry);
        continue;
      }

      try {
        const skillMd = await readFile(mdPath, 'utf-8');
        await this.create({ dirName, skillMd });
        imported.push(entry);
      } catch (err) {
        errors.push(entry);
        log.error({ entry, err }, 'Failed to import Claude skill');
      }
    }

    log.info({ dir, imported: imported.length, skipped: skipped.length, errors: errors.length }, 'Claude skills sync complete');
    return { imported, skipped, errors };
  }

  /** Update skill config.json */
  async updateConfig(name: string, config: SkillConfig): Promise<boolean> {
    const skill = this.skills.get(name);
    if (!skill) return false;
    const configPath = join(skill.filePath, 'config.json');
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
    skill.config = config;
    log.info({ skill: name }, 'Config updated');
    return true;
  }

  /** Delete a skill from disk and registry */
  async delete(name: string): Promise<boolean> {
    const skill = this.skills.get(name);
    if (!skill) return false;

    // Remove from disk
    await rm(skill.filePath, { recursive: true, force: true });

    // Remove from memory
    this.skills.delete(name);
    this.bodies.delete(name);
    delete this.state[name];
    await saveSkillState(STATE_PATH, this.state);

    log.info({ skill: name }, 'Skill deleted');
    return true;
  }

  /**
   * Update source files for a skill. Writes any provided files to disk
   * and reloads metadata (hot-reload).
   */
  async updateSource(
    name: string,
    opts: { skillMd?: string; toolServerPy?: string; requirementsTxt?: string },
  ): Promise<boolean> {
    const skill = this.skills.get(name);
    if (!skill) return false;

    if (opts.skillMd !== undefined) {
      await writeFile(join(skill.filePath, 'skill.md'), opts.skillMd, 'utf-8');
    }

    if (opts.toolServerPy !== undefined) {
      await mkdir(join(skill.filePath, 'tools'), { recursive: true });
      await writeFile(join(skill.filePath, 'tools', 'server.py'), opts.toolServerPy, 'utf-8');
    }

    if (opts.requirementsTxt !== undefined) {
      await writeFile(join(skill.filePath, 'requirements.txt'), opts.requirementsTxt, 'utf-8');
    }

    // Reload skill metadata
    await this.loadSkill(name);

    log.info({ skill: name, updatedFiles: Object.keys(opts).filter((k) => opts[k as keyof typeof opts] !== undefined) }, 'Skill source updated');
    return true;
  }

  /** Export a skill as a .zip file (returns Buffer) */
  async exportSkill(name: string): Promise<Buffer | null> {
    const skill = this.skills.get(name);
    if (!skill) return null;

    const zip = new AdmZip();
    const skillDir = skill.filePath;

    // Add skill.md (required)
    const mdPath = join(skillDir, 'skill.md');
    if (await fileExists(mdPath)) {
      const content = await readFile(mdPath);
      zip.addFile('skill.md', content);
    } else {
      log.warn({ skill: name }, 'skill.md not found during export');
      return null;
    }

    // Add config.json if exists
    const configPath = join(skillDir, 'config.json');
    if (await fileExists(configPath)) {
      const content = await readFile(configPath);
      zip.addFile('config.json', content);
    }

    // Add tools/server.py if exists
    const toolsPath = join(skillDir, 'tools', 'server.py');
    if (await fileExists(toolsPath)) {
      const content = await readFile(toolsPath);
      zip.addFile('tools/server.py', content);
    }

    // Add requirements.txt if exists
    const reqPath = join(skillDir, 'requirements.txt');
    if (await fileExists(reqPath)) {
      const content = await readFile(reqPath);
      zip.addFile('requirements.txt', content);
    }

    log.info({ skill: name }, 'Skill exported');
    return zip.toBuffer();
  }

  /** Import a skill from a .zip file buffer */
  async importSkill(zipBuffer: Buffer, overwrite = false): Promise<Skill> {
    const zip = new AdmZip(zipBuffer);
    const entries = zip.getEntries();

    // Detect if files are nested in a parent directory
    let baseDir = '';
    const skillMdEntry = entries.find(
      (e) =>
        !e.isDirectory &&
        (e.entryName.endsWith('skill.md') || e.entryName.endsWith('SKILL.md')),
    );

    if (!skillMdEntry) {
      throw new Error('Invalid skill package: missing skill.md');
    }

    // Extract base directory if present (e.g., "my-skill/" from "my-skill/skill.md")
    const entryPath = skillMdEntry.entryName;
    if (entryPath.includes('/')) {
      const parts = entryPath.split('/');
      if (parts.length > 1 && parts[parts.length - 1] === 'skill.md') {
        baseDir = parts.slice(0, -1).join('/') + '/';
      }
    }

    const skillMd = skillMdEntry.getData().toString('utf-8');
    const { meta } = parseFrontmatter(skillMd);
    const dirName = (meta.name || 'imported-skill').toLowerCase().replace(/[^a-z0-9_-]/g, '-');

    // Check if skill already exists
    if (this.skills.has(dirName) && !overwrite) {
      throw new Error(`Skill "${dirName}" already exists. Set overwrite=true to replace.`);
    }

    const skillDir = join(SKILLS_DIR, dirName);

    // Create skill directory
    await mkdir(skillDir, { recursive: true });

    // Extract all entries, stripping base directory if present
    for (const entry of entries) {
      if (entry.isDirectory) continue;

      // Skip files not in the base directory
      if (baseDir && !entry.entryName.startsWith(baseDir)) continue;

      // Get relative path by removing base directory
      const relativePath = baseDir ? entry.entryName.slice(baseDir.length) : entry.entryName;

      // Skip hidden files, macOS metadata, and vault files (preserve existing secrets)
      if (relativePath.startsWith('.') || relativePath.includes('/__MACOSX/')) continue;
      if (relativePath === 'vault.enc' || relativePath === 'vault.json') continue;

      const targetPath = join(skillDir, relativePath);

      // Block Zip Slip: ensure extracted path stays within skill directory
      if (!targetPath.startsWith(skillDir + '/') && targetPath !== skillDir) {
        throw new Error(`Zip Slip blocked: "${relativePath}" escapes the skill directory`);
      }

      const targetDir = join(targetPath, '..');

      // Ensure parent directory exists
      await mkdir(targetDir, { recursive: true });

      // Write file
      await writeFile(targetPath, entry.getData());
    }

    // Load the skill into registry
    await this.loadSkill(dirName);
    const skill = this.skills.get(dirName);
    if (!skill) throw new Error('Skill imported but not found in registry');

    log.info({ skill: dirName, baseDir }, 'Skill imported');
    return skill;
  }
}
