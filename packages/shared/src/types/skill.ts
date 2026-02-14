export type SkillStatus = 'enabled' | 'disabled';

export interface SkillConfig {
  requiredSecrets?: string[];
  pythonDependencies?: string[];
  oauth?: Record<string, import('./oauth.js').OAuthFlowConfig>;
}

export interface SkillMetadata {
  name: string;
  description: string;
  version: string;
  author: string;
  builtIn: boolean;
}

export interface Skill {
  dirName: string;
  metadata: SkillMetadata;
  status: SkillStatus;
  filePath: string;
  loadedAt: string;
  config?: SkillConfig;
  hasTools: boolean;
  hasPrompt: boolean;
  secretKeys?: string[];
}

export interface Connection {
  skillDirName: string;
  skillName: string;
  secretKey: string;
  provider: string;
  connected: boolean;
  scopes: string[];
}
