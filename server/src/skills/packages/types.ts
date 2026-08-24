export interface SkillFrontmatter {
  name: string;
  description: string;
}

export interface SkillPackage {
  name: string;
  dir: string;
  frontmatter: SkillFrontmatter;
  body: string;
  references: string[];
  scripts: string[];
  assets: string[];
  source?: string;
  version?: string;
  enabled: boolean;
}
