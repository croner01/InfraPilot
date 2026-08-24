import { createEmbedder, type Embedder } from "../registry/embedder.js";
import { InMemoryEmbeddingStore } from "../registry/store.js";
import { scanSkillPackages } from "./loader.js";
import type { SkillPackage } from "./types.js";
import { listSkillRows, upsertSkillRow, setSkillEnabledRow, deleteSkillRow } from "../../db/db.js";

export const ALWAYS_ON_SKILLS = ["sre-systematic-debugging"];
export const MAX_SKILLS_PER_TURN = 4;

function skillToText(s: SkillPackage): string {
  return [`Skill: ${s.name}`, `Description: ${s.frontmatter.description}`, s.body].join("\n");
}

class SkillStore {
  private embedder: Embedder = createEmbedder();
  private index = new InMemoryEmbeddingStore<SkillPackage>();
  private byName = new Map<string, SkillPackage>();
  private initialized = false;

  async init(embedder?: Embedder): Promise<void> {
    if (this.initialized) return;
    this.embedder = embedder ?? createEmbedder();
    this.index.clear();
    this.byName.clear();

    const packages = scanSkillPackages();
    const state = new Map<string, number>();
    for (const row of listSkillRows()) state.set(row.name, row.enabled);

    if ("fit" in this.embedder && typeof this.embedder.fit === "function") {
      this.embedder.fit(packages.map(skillToText));
    }

    for (const p of packages) {
      const enabled = (state.get(p.name) ?? 1) === 1;
      const withState: SkillPackage = { ...p, enabled };
      this.byName.set(withState.name, withState);
      if (enabled) {
        const vector = await this.embedder.embed(skillToText(withState));
        this.index.add(withState.name, withState, vector);
      }
      if (!state.has(p.name)) {
        upsertSkillRow({ name: p.name, dir: p.dir, enabled: 1 });
      }
    }
    this.initialized = true;
  }

  async recall(query: string, topK = 3): Promise<Array<SkillPackage & { score: number }>> {
    await this.init();
    const qv = await this.embedder.embed(query);
    return this.index.search(qv, topK, 0).map((r) => ({ ...r.item, score: r.score }));
  }

  get(name: string): SkillPackage | undefined {
    return this.byName.get(name);
  }

  list(): SkillPackage[] {
    return [...this.byName.values()];
  }

  async refresh(): Promise<void> {
    this.initialized = false;
    await this.init();
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const p = this.byName.get(name);
    upsertSkillRow({ name, dir: p?.dir ?? name, enabled: enabled ? 1 : 0 });
    setSkillEnabledRow(name, enabled);
    await this.refresh();
  }

  async remove(name: string): Promise<void> {
    deleteSkillRow(name);
    await this.refresh();
  }
}

export const skillStore = new SkillStore();

export async function refreshSkillStore(): Promise<void> {
  await skillStore.refresh();
}
