import { readFile, writeFile, readdir, mkdir, access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger, isoNow } from '@jonas/shared/utils';
import type { Skill, SkillConfig, SkillMetadata, SkillStatus, Connection } from '@jonas/shared/types';
import { loadSkillState, saveSkillState, type SkillStateMap } from './storage.js';
import type { SkillCryptoStore } from './crypto-store.js';

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

  constructor(cryptoStore: SkillCryptoStore) {
    this.cryptoStore = cryptoStore;
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
    const mdPath = join(skillDir, 'skill.md');

    if (!(await fileExists(mdPath))) {
      log.warn({ dir: dirName }, 'Skipping directory without skill.md');
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
}
